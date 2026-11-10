"""Board insights - read-only aggregation over every Kanban board in this install.

Serves the desktop page `board-insights` (`desktop/plugin.js`) through
`/api/plugins/board-insights/...`. It answers the three questions the board itself does
not: what is piling up right now (overview), is throughput rising or dipping (trends), and
every unfinished card across boards in one list (pending).

Read-only by construction: every connection opens with `mode=ro`, no statement here
writes. Failures come back to the page as text rather than being swallowed, so a broken
path shows a reason instead of an empty dashboard.

Schema tolerance: columns are discovered per table before they are selected, so a future
`hermes update` that adds or drops a column degrades a single figure instead of the page.

Self-test (no server needed):  python plugin_api.py --selftest
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Query

router = APIRouter()

# Columns the board paints, in the order a person should read them: work in flight, then
# what needs a human, then the queue, then the parked columns.
STATUS_ORDER = ("running", "blocked", "review", "ready", "todo", "scheduled", "triage", "done")

# statuses that mean "not finished" - the pending list and every "in flight" count.
OPEN_STATUSES = ("triage", "todo", "scheduled", "ready", "running", "blocked", "review")

# What a human owes an answer on, cheapest-first for a dashboard tile.
NEEDS_HUMAN = ("blocked", "review")

RUN_FAILURE_OUTCOMES = ("crashed", "timed_out", "failed", "spawn_failed", "gave_up")

DAY = 86400

# The board's own column order (see plugins/kanban/types.ts COLUMN_META), left to right
# as a person reads the board: the untouched queue, then the claimed columns, then done.
BOARD_COLUMNS = ("triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done")

# Assignee profile -> department, taken from the org's own routing table (the ceo profile's
# "Departments you may assign"). A card is grouped by the department of the assignee it
# actually carries, so the chart reads the assignee, not the `dept:` field in a card body
# (which can say "automation" for a smoke test actually carried by "architect"). Assignees
# without a defined department fall through to their own name, and an unassigned card is
# its own "unassigned" bucket — neither is ever dropped.
PROFILE_DEPARTMENT = {
    "mkt-lead": "Marketing",
    "auto-lead": "Automation",
    "ops-lead": "Operations",
    "producer": "Build",
    "designer": "Design",
    "advisor": "Critique",
    "architect": "Org",
}


# --------------------------------------------------------------------------------------
# Discovery
# --------------------------------------------------------------------------------------


def kanban_roots() -> list[Path]:
    """Every plausible kanban home, most specific first."""
    out: list[Path] = []
    for var in ("HERMES_KANBAN_HOME", "HERMES_KANBAN_DIR"):
        value = os.environ.get(var)
        if value:
            out.append(Path(value))
    home = os.environ.get("HERMES_HOME")
    if home:
        out.append(Path(home) / "kanban")
    local = os.environ.get("LOCALAPPDATA") or os.environ.get("XDG_DATA_HOME")
    if local:
        out.append(Path(local) / "hermes" / "kanban")
    out.append(Path.home() / ".hermes" / "kanban")
    return out


def kanban_root() -> Optional[Path]:
    """The first candidate that actually holds a boards/ directory."""
    for candidate in kanban_roots():
        try:
            if (candidate / "boards").is_dir():
                return candidate
        except OSError:
            continue
    return None


def known_boards() -> list[str]:
    """Board slugs on disk, `_archived` and friends excluded, newest name order kept stable."""
    root = kanban_root()
    if root is None:
        return []
    slugs = []
    for entry in sorted((root / "boards").iterdir()):
        if entry.is_dir() and not entry.name.startswith("_") and (entry / "kanban.db").is_file():
            slugs.append(entry.name)
    return slugs


def board_meta(slug: str) -> dict:
    root = kanban_root()
    meta: dict[str, Any] = {"slug": slug, "name": slug, "icon": "", "description": ""}
    if root is None:
        return meta
    path = root / "boards" / slug / "board.json"
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return meta
    if isinstance(raw, dict):
        for key in ("name", "icon", "description", "color", "archived"):
            if raw.get(key) is not None:
                meta[key] = raw[key]
    return meta


def resolve_boards(boards: Optional[str]) -> tuple[list[str], list[str]]:
    """(slugs to read, errors). An empty/absent filter means every board."""
    available = known_boards()
    if not available:
        return [], ["no kanban boards found on this machine"]
    if not boards or not boards.strip():
        return available, []
    wanted = [part.strip() for part in boards.split(",") if part.strip()]
    unknown = [slug for slug in wanted if slug not in available]
    keep = [slug for slug in wanted if slug in available]
    return (keep or available), [f"unknown board: {slug}" for slug in unknown]


# --------------------------------------------------------------------------------------
# Reading
# --------------------------------------------------------------------------------------


def connect(db: Path) -> sqlite3.Connection:
    """Read-only handle. `mode=ro` is the guarantee, not a convention."""
    conn = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True, timeout=5.0)
    conn.row_factory = sqlite3.Row
    return conn


def columns_of(conn: sqlite3.Connection, table: str) -> set:
    try:
        rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    except sqlite3.Error:
        return set()
    return {row["name"] for row in rows}


def _pick(available: set, wanted: tuple) -> list:
    return [name for name in wanted if name in available]


def read_board(slug: str) -> tuple[dict, Optional[str]]:
    """One board's raw rows, projected down to what the three views need."""
    root = kanban_root()
    if root is None:
        return {}, "no kanban home"
    db = root / "boards" / slug / "kanban.db"
    if not db.is_file():
        return {}, f"{slug}: no kanban.db"
    try:
        conn = connect(db)
    except sqlite3.Error as exc:
        return {}, f"{slug}: {exc}"
    try:
        task_cols = columns_of(conn, "tasks")
        if not task_cols:
            return {}, f"{slug}: no tasks table"
        fields = _pick(
            task_cols,
            ("id", "title", "body", "assignee", "status", "priority", "created_at",
             "started_at", "completed_at", "workspace_kind", "branch_name", "block_kind"),
        )
        tasks = [dict(row) for row in conn.execute(f"SELECT {', '.join(fields)} FROM tasks")]

        runs: list[dict] = []
        if columns_of(conn, "task_runs"):
            run_fields = _pick(
                columns_of(conn, "task_runs"),
                ("task_id", "profile", "status", "outcome", "started_at", "ended_at",
                 "last_heartbeat_at", "summary", "error"),
            )
            runs = [
                dict(row)
                for row in conn.execute(
                    f"SELECT {', '.join(run_fields)} FROM task_runs ORDER BY started_at DESC LIMIT 400"
                )
            ]

        last_event: dict[str, int] = {}
        if columns_of(conn, "task_events"):
            for row in conn.execute("SELECT task_id, MAX(created_at) AS at FROM task_events GROUP BY task_id"):
                if row["at"] is not None:
                    last_event[row["task_id"]] = int(row["at"])

        comments: dict[str, int] = {}
        latest_comments: dict[str, dict] = {}
        comment_cols = columns_of(conn, "task_comments")
        if comment_cols:
            for row in conn.execute("SELECT task_id, COUNT(*) AS n FROM task_comments GROUP BY task_id"):
                comments[row["task_id"]] = int(row["n"])
            # Latest handoff comment per task (id is monotonic), quoted verbatim downstream.
            comment_fields = _pick(comment_cols, ("task_id", "body", "author", "created_at"))
            for row in conn.execute(f"SELECT {', '.join(comment_fields)} FROM task_comments ORDER BY id DESC"):
                if row["task_id"] not in latest_comments:
                    latest_comments[row["task_id"]] = {key: row[key] for key in comment_fields}
    except sqlite3.Error as exc:
        return {}, f"{slug}: {exc}"
    finally:
        conn.close()

    return {
        "slug": slug,
        "meta": board_meta(slug),
        "tasks": tasks,
        "runs": runs,
        "last_event": last_event,
        "comments": comments,
        "latest_comments": latest_comments,
    }, None


def load(slugs: list[str]) -> tuple[list[dict], list[str]]:
    boards, errors = [], []
    for slug in slugs:
        data, error = read_board(slug)
        if error:
            errors.append(error)
        if data:
            boards.append(data)
    return boards, errors


# --------------------------------------------------------------------------------------
# Shaping
# --------------------------------------------------------------------------------------


def is_open(task: dict) -> bool:
    status = (task.get("status") or "").lower()
    return status in OPEN_STATUSES


def hours_since(now: float, stamp: Any) -> Optional[float]:
    try:
        value = float(stamp)
    except (TypeError, ValueError):
        return None
    if value <= 0:
        return None
    return round((now - value) / 3600.0, 1)


def day_key(stamp: Any) -> Optional[str]:
    try:
        value = float(stamp)
    except (TypeError, ValueError):
        return None
    if value <= 0:
        return None
    return datetime.fromtimestamp(value).strftime("%Y-%m-%d")


def day_series(boards: list[dict], now: float, days: int) -> dict:
    """Created vs completed per local day, plus the dip days between first and last activity."""
    buckets: dict[str, dict] = {}
    today = datetime.fromtimestamp(now).date()
    for offset in range(days - 1, -1, -1):
        label = datetime.fromtimestamp(now - offset * DAY).strftime("%Y-%m-%d")
        buckets[label] = {"day": label, "label": datetime.strptime(label, "%Y-%m-%d").strftime("%b %d"), "created": 0, "completed": 0}

    cutoff = now - days * DAY
    for board in boards:
        for task in board["tasks"]:
            created = task.get("created_at")
            key = day_key(created)
            if key in buckets and float(created or 0) >= cutoff:
                buckets[key]["created"] += 1
            key = day_key(task.get("completed_at"))
            if key in buckets:
                buckets[key]["completed"] += 1

    series = [buckets[label] for label in sorted(buckets)]
    completed = [row["completed"] for row in series]
    live = [value for value in completed if value > 0]
    typical = sorted(live)[len(live) // 2] if live else 0
    # A day of zero completions is only a dip once the board has actually been used.
    # The days between "board created" and "first card" are not a throughput drop.
    active = [row["day"] for row in series if row["created"] or row["completed"]]
    first_active = active[0] if active else None
    # Today is not a dip: it is not over yet, so a zero so far is not a throughput drop.
    today = datetime.fromtimestamp(now).strftime("%Y-%m-%d")
    dips = [
        {"day": row["day"], "label": row["label"], "completed": row["completed"]}
        for row in series
        if row["completed"] == 0
        and typical > 0
        and row["day"] != today
        and (first_active is None or row["day"] >= first_active)
    ]
    return {"days": series, "dips": dips, "typical_completed": typical, "first_active": first_active}


def cycle_time(boards: list[dict], now: float, days: int) -> dict:
    """Started->completed and created->completed, in hours, over the window."""
    cutoff = now - days * DAY
    durations: list[float] = []
    lead: list[float] = []
    for board in boards:
        for task in board["tasks"]:
            completed = task.get("completed_at")
            if not completed or float(completed) < cutoff:
                continue
            started = task.get("started_at")
            created = task.get("created_at")
            if started and float(completed) >= float(started):
                durations.append((float(completed) - float(started)) / 3600.0)
            if created and float(completed) >= float(created):
                lead.append((float(completed) - float(created)) / 3600.0)

    def stat(values: list[float]) -> dict:
        if not values:
            return {"median_h": None, "p90_h": None, "n": 0}
        values = sorted(values)
        return {
            "median_h": round(values[len(values) // 2], 1),
            "p90_h": round(values[min(len(values) - 1, int(len(values) * 0.9))], 1),
            "n": len(values),
        }

    return {"run": stat(durations), "lead": stat(lead)}


def load_by_assignee(boards: list[dict], now: float, days: int) -> list[dict]:
    cutoff = now - days * DAY
    people: dict[str, dict] = {}

    def row(name: Any) -> dict:
        key = (name or "unassigned") or "unassigned"
        if key not in people:
            people[key] = {"assignee": key, "running": 0, "blocked": 0, "review": 0, "ready": 0,
                           "open": 0, "completed": 0, "failed": 0}
        return people[key]

    for board in boards:
        for task in board["tasks"]:
            entry = row(task.get("assignee"))
            status = (task.get("status") or "").lower()
            if status in OPEN_STATUSES:
                entry["open"] += 1
            if status in entry:
                entry[status] += 1
            completed = task.get("completed_at")
            if completed and float(completed) >= cutoff:
                entry["completed"] += 1
        for run in board["runs"]:
            if (run.get("outcome") or "") in RUN_FAILURE_OUTCOMES or (run.get("status") or "") in ("crashed", "timed_out", "failed"):
                started = run.get("started_at")
                if started and float(started) >= cutoff:
                    row(run.get("profile") or "unassigned")["failed"] += 1

    return sorted(people.values(), key=lambda entry: (-entry["open"], -entry["completed"], entry["assignee"]))


def runs_summary(boards: list[dict], now: float, days: int) -> dict:
    """What the Run rows actually say, bucketed by what they mean to a person.

    A run is one dispatcher claim on a card (kanban_db.task_runs). `status` is the
    lifecycle (running | done | blocked | ready | review | crashed | timed_out | failed |
    released) and `outcome` the verdict (completed | review_requested | changes_requested |
    blocked | reclaimed | crashed | timed_out | spawn_failed | gave_up). The buckets are
    the ones a person acts on: ok, sent back for changes, waiting on a reviewer, blocked,
    reclaimed, failed, and STALE - a claim marked running with no heartbeat in ten
    minutes, i.e. a worker that died without closing its row. `total` is exactly the sum
    of the buckets, so nothing hides in a remainder.
    """
    cutoff = now - days * DAY
    stale_after = 600
    buckets = {"ok": 0, "changes": 0, "review": 0, "blocked": 0, "reclaimed": 0,
               "failed": 0, "active": 0, "stale": 0, "other": 0}
    durations: list[float] = []
    for board in boards:
        for run in board["runs"]:
            started = run.get("started_at")
            if not started or float(started) < cutoff:
                continue
            status = (run.get("status") or "") or ""
            outcome = (run.get("outcome") or "") or ""
            if status in ("", "running") and outcome != "completed":
                heartbeat = run.get("last_heartbeat_at")
                buckets["active" if heartbeat and (now - float(heartbeat)) <= stale_after else "stale"] += 1
            elif outcome == "completed" or status == "done":
                buckets["ok"] += 1
            elif outcome in RUN_FAILURE_OUTCOMES or status in ("crashed", "timed_out", "failed"):
                buckets["failed"] += 1
            elif outcome == "changes_requested" or status == "ready":
                buckets["changes"] += 1
            elif outcome == "review_requested" or status == "review":
                buckets["review"] += 1
            elif outcome == "blocked" or status == "blocked":
                buckets["blocked"] += 1
            elif outcome == "reclaimed" or status == "reclaimed":
                buckets["reclaimed"] += 1
            else:
                buckets["other"] += 1
            ended = run.get("ended_at")
            if ended and float(ended) >= float(started):
                durations.append((float(ended) - float(started)) / 3600.0)
    total = sum(buckets.values())
    average = round(sum(durations) / len(durations), 1) if durations else None
    return {"total": total, "avg_hours": average, **buckets}


def department_of(assignee: Any) -> str:
    """The department a card belongs to, read from the assignee it actually carries.

    Unassigned is its own bucket (never dropped); a known org profile maps to its
    department; anything else falls back to its own name so nothing is miscounted as
    someone else's department.
    """
    if not assignee:
        return "unassigned"
    name = str(assignee).strip()
    if not name:
        return "unassigned"
    return PROFILE_DEPARTMENT.get(name, name)


def completion_series(boards: list[dict], now: float, days: int) -> dict:
    """Completed cards bucketed by completion timestamp, per day for short ranges and per
    week for longer ones, with a trailing moving average over the bucket counts.

    Buckets are timestamp windows that tile the range [now - days*DAY, now]; the newest
    bucket ends at ``now``. A completion only counts when it falls inside the range, so
    the sum of the bucket counts always equals the overview's ``completed_<days>d`` tile.
    """
    granularity = "day" if days <= 30 else "week"
    width = 1 if granularity == "day" else 7
    count = -(-days // width)  # ceil(days / width)
    buckets: list[dict] = []
    end = now
    for _ in range(count):
        start = end - width * DAY
        label = datetime.fromtimestamp(start).strftime("%b %d")
        buckets.append({"label": label, "start": start, "end": end, "count": 0, "ids": []})
        end = start
    buckets.reverse()  # oldest first

    cutoff = now - days * DAY
    for board in boards:
        for task in board["tasks"]:
            completed = task.get("completed_at")
            if not completed:
                continue
            try:
                stamp = float(completed)
            except (TypeError, ValueError):
                continue
            if stamp < cutoff or stamp > now:
                continue
            for bucket in buckets:
                if bucket["start"] <= stamp < bucket["end"]:
                    bucket["count"] += 1
                    bucket["ids"].append(task.get("id"))
                    break

    window = 7 if granularity == "day" else 4
    moving = trailing_average([b["count"] for b in buckets], window)
    for index, bucket in enumerate(buckets):
        bucket["ma"] = moving[index]

    total = sum(b["count"] for b in buckets)
    return {
        "granularity": granularity,
        "days": days,
        "buckets": buckets,
        "total": total,
    }


def trailing_average(values: list[int], window: int) -> list[Optional[float]]:
    """Trailing mean over ``window`` buckets; the first buckets use the partial window so a
    short range still gets a line. Rounded to two decimals for a stable, honest label."""
    window = max(1, window)
    out: list[Optional[float]] = []
    acc = 0
    for index, value in enumerate(values):
        acc += value
        if index >= window:
            acc -= values[index - window]
        out.append(round(acc / min(index + 1, window), 2))
    return out


def by_department(boards: list[dict], now: float, days: int) -> dict:
    """Done vs open per department, sorted by volume (done + open). ``open`` is the live
    snapshot of unfinished cards; ``done`` is completed within the range window, matching
    the overview's windowed completed count."""
    cutoff = now - days * DAY
    groups: dict[str, dict] = {}

    def row(assignee: Any) -> dict:
        department = department_of(assignee)
        if department not in groups:
            groups[department] = {
                "department": department,
                "open": 0,
                "done": 0,
                "open_ids": [],
                "done_ids": [],
                "assignees": set(),
            }
        if assignee:
            groups[department]["assignees"].add(str(assignee))
        return groups[department]

    for board in boards:
        for task in board["tasks"]:
            entry = row(task.get("assignee"))
            status = (task.get("status") or "").lower()
            if is_open(task):
                entry["open"] += 1
                entry["open_ids"].append(task.get("id"))
            completed = task.get("completed_at")
            if completed and float(completed) >= cutoff:
                entry["done"] += 1
                entry["done_ids"].append(task.get("id"))

    rows = []
    for group in groups.values():
        group["assignees"] = sorted(group["assignees"])
        group["total"] = group["open"] + group["done"]
        rows.append(group)
    rows.sort(key=lambda entry: (-entry["total"], entry["department"]))
    return {
        "rows": rows,
        "total": sum(entry["total"] for entry in rows),
        "open": sum(entry["open"] for entry in rows),
        "done": sum(entry["done"] for entry in rows),
    }


def workload_by_status(boards: list[dict]) -> dict:
    """Every card's current status column, in the board's own order. The status keys are
    read from the board's data (not a hard-coded enum), ordered by the board's column
    order, with any status the board knows but this list does not appended after ``done``
    so a column added later still appears. ``archived`` is excluded, matching the board
    counts elsewhere on the page."""
    columns: dict[str, dict] = {}
    for board in boards:
        for task in board["tasks"]:
            status = (task.get("status") or "unknown").lower()
            if status == "archived":
                continue
            if status not in columns:
                columns[status] = {"status": status, "count": 0, "ids": []}
            columns[status]["count"] += 1
            columns[status]["ids"].append(task.get("id"))

    known = [name for name in BOARD_COLUMNS if name in columns]
    extra = sorted(name for name in columns if name not in BOARD_COLUMNS)
    rows = [columns[name] for name in known + extra]
    return {
        "rows": rows,
        "total": sum(row["count"] for row in rows),
    }


def standups(boards: list[dict], now: float, days: int) -> dict:
    """One standup card per department, read from the assignees actually on the board.

    Three lists per department, every line quoted verbatim from the card's own fields
    (never paraphrased, no model calls):
      finished  completed within the window, carrying the card's latest run summary
                (task_runs.summary) and latest handoff comment (task_comments.body);
      running   live cards a worker has claimed right now;
      blocked   live blocked cards plus needs_input (waiting on a person) - a snapshot.
    Departments come from the assignee ids present on the board, so a department added
    or retired is picked up automatically. A department with cards but nothing in range
    still appears (the page says so) instead of vanishing.
    """
    cutoff = now - days * DAY

    # Latest run summary per task. read_board returns runs newest-first, so the first
    # non-empty summary a task carries is its most recent handoff.
    summaries: dict[str, str] = {}
    for board in boards:
        for run in board["runs"]:
            task_id = run.get("task_id")
            summary = run.get("summary")
            if task_id and summary and task_id not in summaries:
                summaries[task_id] = summary

    groups: dict[str, dict] = {}

    def entry(assignee: Any) -> dict:
        department = department_of(assignee)
        if department not in groups:
            groups[department] = {"department": department, "finished": [], "running": [], "blocked": []}
        return groups[department]

    for board in boards:
        comments = board.get("latest_comments") or {}
        for task in board["tasks"]:
            status = (task.get("status") or "").lower()
            if status == "archived":
                continue
            task_id = task.get("id")
            title = task.get("title") or "(untitled)"
            board_name = board["meta"].get("name") or board["slug"]
            g = entry(task.get("assignee"))
            completed = task.get("completed_at")
            if completed and float(completed) >= cutoff:
                comment = comments.get(task_id) or {}
                g["finished"].append({
                    "id": task_id,
                    "board": board["slug"],
                    "board_name": board_name,
                    "title": title,
                    "assignee": task.get("assignee"),
                    "summary": summaries.get(task_id),
                    "comment": comment.get("body"),
                    "comment_author": comment.get("author"),
                    "status": status,
                    "completed_at": completed,
                    "last_event": board["last_event"].get(task_id),
                    "last_event_h": hours_since(now, board["last_event"].get(task_id)),
                })
            elif status == "running":
                g["running"].append({
                    "id": task_id,
                    "board": board["slug"],
                    "board_name": board_name,
                    "title": title,
                    "assignee": task.get("assignee"),
                    "status": status,
                    "started_at": task.get("started_at"),
                    "running_h": hours_since(now, task.get("started_at")),
                    "summary": summaries.get(task_id),
                })
            elif status == "blocked" or task.get("block_kind") == "needs_input":
                g["blocked"].append({
                    "id": task_id,
                    "board": board["slug"],
                    "board_name": board_name,
                    "title": title,
                    "assignee": task.get("assignee"),
                    "status": status,
                    "block_kind": task.get("block_kind"),
                    "last_event": board["last_event"].get(task_id),
                    "last_event_h": hours_since(now, board["last_event"].get(task_id)),
                })

    rows = []
    for group in groups.values():
        group["activity"] = len(group["finished"]) + len(group["running"]) + len(group["blocked"])
        group["finished"].sort(key=lambda item: -(float(item["completed_at"]) or 0))
        group["blocked"].sort(key=lambda item: -(item["last_event"] or 0))
        rows.append(group)
    rows.sort(key=lambda item: (-item["activity"], item["department"]))

    return {
        "rows": rows,
        "departments": len(rows),
        "finished": sum(len(r["finished"]) for r in rows),
        "running": sum(len(r["running"]) for r in rows),
        "blocked": sum(len(r["blocked"]) for r in rows),
    }


def net_flow(boards: list[dict], now: float, days: int) -> dict:
    """Created vs completed per bucket over the window, plus the signed net.

    Same bucketing as completion_series (day for short ranges, week for long), so the
    sign of each bucket is readable at a glance rather than subtracted in the head. The
    sum of the per-bucket nets equals the overview's net_<days>d tile.
    """
    granularity = "day" if days <= 30 else "week"
    width = 1 if granularity == "day" else 7
    count = -(-days // width)
    buckets: list[dict] = []
    end = now
    for _ in range(count):
        start = end - width * DAY
        buckets.append({
            "label": datetime.fromtimestamp(start).strftime("%b %d"),
            "start": start, "end": end, "created": 0, "completed": 0,
        })
        end = start
    buckets.reverse()

    cutoff = now - days * DAY
    for board in boards:
        for task in board["tasks"]:
            if (task.get("status") or "").lower() == "archived":
                continue
            for key, stamp in (("created", task.get("created_at")), ("completed", task.get("completed_at"))):
                if not stamp:
                    continue
                try:
                    value = float(stamp)
                except (TypeError, ValueError):
                    continue
                if value < cutoff or value > now:
                    continue
                for bucket in buckets:
                    if bucket["start"] <= value < bucket["end"]:
                        bucket[key] += 1
                        break

    total_created = sum(b["created"] for b in buckets)
    total_completed = sum(b["completed"] for b in buckets)
    for bucket in buckets:
        bucket["net"] = bucket["created"] - bucket["completed"]
    return {
        "granularity": granularity,
        "buckets": buckets,
        "total_created": total_created,
        "total_completed": total_completed,
        "net": total_created - total_completed,
    }


def pending_rows(boards: list[dict], now: float, limit: int) -> list[dict]:
    rows: list[dict] = []
    for board in boards:
        for task in board["tasks"]:
            if not is_open(task):
                continue
            status = (task.get("status") or "").lower()
            started = task.get("started_at")
            rows.append(
                {
                    "id": task.get("id"),
                    "board": board["slug"],
                    "board_name": board["meta"].get("name") or board["slug"],
                    "title": task.get("title") or "(untitled)",
                    "body": (task.get("body") or "").strip(),
                    "status": status,
                    "assignee": task.get("assignee"),
                    "priority": task.get("priority"),
                    "age_h": hours_since(now, task.get("created_at")),
                    "running_h": hours_since(now, started) if status == "running" else None,
                    "waiting_h": hours_since(now, max(int(started or 0), int(task.get("created_at") or 0)) or None)
                    if status in NEEDS_HUMAN
                    else None,
                    "last_event_h": hours_since(now, board["last_event"].get(task.get("id"))),
                    "comments": board["comments"].get(task.get("id"), 0),
                }
            )
    rows.sort(key=lambda item: (STATUS_ORDER.index(item["status"]) if item["status"] in STATUS_ORDER else 99,
                                -(item["age_h"] or 0)))
    return rows[:limit]


def build() -> dict:
    """Everything the page renders, in one pass over the boards it was asked for."""
    return {}


# --------------------------------------------------------------------------------------
# Endpoints
# --------------------------------------------------------------------------------------


@router.get("/health")
def health() -> dict:
    root = kanban_root()
    started = time.time()
    boards = known_boards()
    return {
        "ok": root is not None,
        "kanban_root": str(root) if root else None,
        "boards": boards,
        "elapsed_ms": round((time.time() - started) * 1000, 1),
    }


@router.get("/boards")
def boards_endpoint() -> dict:
    now = time.time()
    data, errors = load(known_boards())
    out = []
    for board in data:
        counts: dict[str, int] = {}
        for task in board["tasks"]:
            key = (task.get("status") or "unknown").lower()
            if key != "archived":
                counts[key] = counts.get(key, 0) + 1
        out.append(
            {
                **{key: value for key, value in board["meta"].items() if key != "archived"},
                "counts": counts,
                "open": sum(counts.get(status, 0) for status in OPEN_STATUSES),
                "done": counts.get("done", 0),
            }
        )
    return {"boards": out, "errors": errors, "now": now}


@router.get("/overview")
def overview_endpoint(boards: Optional[str] = Query(None), days: int = Query(7, ge=1, le=90)) -> dict:
    now = time.time()
    slugs, errors = resolve_boards(boards)
    data, read_errors = load(slugs)
    cutoff = now - days * DAY
    previous = now - 2 * days * DAY

    columns: dict[str, int] = {}
    backlog_columns: dict[str, int] = {}
    blockers: list[dict] = []
    running: list[dict] = []
    ready_oldest: list[dict] = []
    created_now = completed_now = completed_prev = 0

    for board in data:
        for task in board["tasks"]:
            status = (task.get("status") or "unknown").lower()
            if status == "archived":
                continue
            columns[status] = columns.get(status, 0) + 1
            if status != "done":
                backlog_columns[status] = backlog_columns.get(status, 0) + 1
            row = {
                "id": task.get("id"),
                "board": board["slug"],
                "board_name": board["meta"].get("name") or board["slug"],
                "title": task.get("title") or "(untitled)",
                "status": status,
                "assignee": task.get("assignee"),
                "age_h": hours_since(now, task.get("created_at")),
                "running_h": hours_since(now, task.get("started_at")),
                "waiting_h": hours_since(now, max(int(task.get("started_at") or 0), int(task.get("created_at") or 0)) or None),
            }
            if status == "blocked":
                blockers.append(row)
            elif status == "running":
                running.append(row)
            elif status == "ready":
                ready_oldest.append(row)
            created = task.get("created_at")
            if created and float(created) >= cutoff:
                created_now += 1
            completed = task.get("completed_at")
            if completed:
                value = float(completed)
                if value >= cutoff:
                    completed_now += 1
                elif value >= previous:
                    completed_prev += 1

    blockers.sort(key=lambda item: -(item["waiting_h"] or item["age_h"] or 0))
    running.sort(key=lambda item: -(item["running_h"] or 0))
    ready_oldest.sort(key=lambda item: -(item["age_h"] or 0))

    return {
        "now": now,
        "days": days,
        "boards": [board["slug"] for board in data],
        "columns": columns,
        "backlog_columns": backlog_columns,
        "tiles": {
            "in_flight": columns.get("running", 0) + columns.get("review", 0) + columns.get("blocked", 0),
            "running": columns.get("running", 0),
            "blocked": columns.get("blocked", 0),
            "review": columns.get("review", 0),
            "ready": columns.get("ready", 0),
            "queue": sum(columns.get(status, 0) for status in ("triage", "todo", "scheduled", "ready")),
            f"created_{days}d": created_now,
            f"completed_{days}d": completed_now,
            f"completed_prev_{days}d": completed_prev,
            f"net_{days}d": created_now - completed_now,
        },
        "blockers": blockers[:6],
        "running_top": running[:6],
        "oldest_ready": ready_oldest[:5],
        "cycle": cycle_time(data, now, days),
        "errors": errors + read_errors,
    }


@router.get("/trends")
def trends_endpoint(boards: Optional[str] = Query(None), days: int = Query(14, ge=3, le=90)) -> dict:
    now = time.time()
    slugs, errors = resolve_boards(boards)
    data, read_errors = load(slugs)
    series = day_series(data, now, days)
    return {
        "now": now,
        "days": days,
        "boards": [board["slug"] for board in data],
        "series": series,
        "cycle": cycle_time(data, now, days),
        "by_assignee": load_by_assignee(data, now, min(days, 7)),
        "runs": runs_summary(data, now, min(days, 7)),
        "errors": errors + read_errors,
    }


@router.get("/pending")
def pending_endpoint(
    boards: Optional[str] = Query(None),
    limit: int = Query(200, ge=1, le=1000),
    status: Optional[str] = Query(None),
) -> dict:
    now = time.time()
    slugs, errors = resolve_boards(boards)
    data, read_errors = load(slugs)
    rows = pending_rows(data, now, limit * 4)
    if status:
        wanted = {part.strip().lower() for part in status.split(",") if part.strip()}
        rows = [row for row in rows if row["status"] in wanted]
    counts: dict[str, int] = {}
    for row in rows:
        counts[row["status"]] = counts.get(row["status"], 0) + 1
    return {"now": now, "total": len(rows), "counts": counts, "tasks": rows[:limit], "errors": errors + read_errors}


@router.get("/charts")
def charts_endpoint(boards: Optional[str] = Query(None), days: int = Query(7, ge=1, le=90)) -> dict:
    """The three core charts in one pass, all driven by the same date range so the page
    re-queries them together: completed-over-time (day/week + moving average), tasks by
    department (done vs open, sorted by volume), and workload by status (the board's own
    column order). Read-only, like every endpoint here."""
    now = time.time()
    slugs, errors = resolve_boards(boards)
    data, read_errors = load(slugs)
    completed = completion_series(data, now, days)
    departments = by_department(data, now, days)
    statuses = workload_by_status(data)
    standup = standups(data, now, days)
    flow = net_flow(data, now, days)
    return {
        "now": now,
        "days": days,
        "boards": [board["slug"] for board in data],
        "completed_over_time": completed,
        "by_department": departments,
        "workload_by_status": statuses,
        "standups": standup,
        "net_flow": flow,
        "errors": errors + read_errors,
    }


# --------------------------------------------------------------------------------------
# Self-test
# --------------------------------------------------------------------------------------


def _selftest() -> int:
    root = kanban_root()
    print(f"kanban_root: {root}")
    print(f"boards: {known_boards()}")
    started = time.time()
    overview = overview_endpoint(None, 7)
    trends = trends_endpoint(None, 14)
    pending = pending_endpoint(None, 200, None)
    charts = charts_endpoint(None, 7)
    print(f"elapsed_ms: {round((time.time() - started) * 1000, 1)}")
    print("--- overview.tiles ---")
    print(json.dumps(overview["tiles"], indent=1))
    print("--- overview.columns ---")
    print(json.dumps(overview["columns"], indent=1))
    print("--- overview.blockers(3) ---")
    print(json.dumps(overview["blockers"][:3], indent=1))
    print("--- overview.cycle ---")
    print(json.dumps(overview["cycle"], indent=1))
    print("--- trends.series ---")
    print(json.dumps(trends["series"], indent=1))
    print("--- trends.runs ---")
    print(json.dumps(trends["runs"], indent=1))
    print("--- trends.by_assignee ---")
    print(json.dumps(trends["by_assignee"], indent=1))
    print(f"--- pending.total = {pending['total']} counts={pending['counts']} ---")
    print(json.dumps(pending["tasks"][:2], indent=1))
    print("--- charts.completed_over_time ---")
    print(json.dumps(charts["completed_over_time"], indent=1))
    print("--- charts.by_department ---")
    print(json.dumps(charts["by_department"], indent=1))
    print("--- charts.workload_by_status ---")
    print(json.dumps(charts["workload_by_status"], indent=1))
    print("--- charts.standups ---")
    print(json.dumps(charts["standups"], indent=1))
    print("--- charts.net_flow ---")
    print(json.dumps(charts["net_flow"], indent=1))
    errors = overview["errors"] + trends["errors"] + pending["errors"] + charts["errors"]
    if errors:
        print(f"--- ERRORS ---\n" + "\n".join(errors))
    return 1 if errors else 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        raise SystemExit(_selftest())
    print(__doc__)
