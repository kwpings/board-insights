"""Rewrite the recorded fixtures into a neutral demo dataset.

The fixtures were recorded off a real install, so every title, body, comment, board name and
assignee in them is somebody's work. This script keeps the SHAPE of each payload (counts,
dates, statuses, ids relationship) and replaces the free text with generic engineering copy,
so the repo, the screenshots and the harness carry no client data. Run it once before
committing, and re-run it after re-recording.

    python verify/sanitize.py
"""

from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIXTURES = HERE / "fixtures"

TITLES = [
    "Add a retry budget to the queue worker",
    "Write the runbook for the nightly export",
    "Split the settings page into two panels",
    "Fix the flaky cache invalidation test",
    "Document the webhook signing scheme",
    "Reduce the cold start of the index job",
    "Cache the profile lookup per request",
    "Add a filter box to the card list",
    "Move the chart legend under the plot",
    "Ship the empty state for a fresh install",
    "Measure p95 latency on the search path",
    "Backfill the missing created_at values",
    "Review the migration plan before friday",
    "Cut the release branch and tag it",
    "Add an index on the events table",
    "Deduplicate the notification emails",
    "Tighten the validation on the import",
    "Replace the polling loop with a websocket",
    "Log the slowest query per request",
    "Expose a health endpoint on the worker",
    "Tidy the error messages in the CLI",
    "Retire the old config flags",
    "Pin the dependency floor and ceiling",
    "Add a smoke test for the auth flow",
]

SUMMARIES = [
    "Landed with a test that fails without the change.",
    "Done: the behaviour is covered by the new fixture.",
    "Shipped behind the existing flag, no config change needed.",
    "Verified against the acceptance criteria on the card.",
    "Refactored, then re-ran the suite twice to rule out flake.",
]

COMMENTS = [
    "Checked the edge case where the list is empty; behaves as expected.",
    "Left a note in the PR about the follow-up this unblocks.",
    "Reproduced the failure first, then fixed it.",
    "Numbers in the ticket were stale; used the fresh run instead.",
]

BODIES = [
    "Scope agreed on the card. Do the narrow fix first, then the cleanup if it fits.",
    "Reproduce, fix, then prove it with a test that fails on the old code.",
    "One card, one repo. Stop at the acceptance criteria.",
]

ASSIGNEES = {
    "producer": "builder",
    "designer": "designer",
    "ceo": "manager",
    "advisor": "reviewer",
    "ops-lead": "ops",
    "mkt-lead": "marketer",
    "auto-lead": "automation",
    "assistant": "assistant",
    "accountant": "finance",
    "unassigned": "unassigned",
}

DEPARTMENTS = {
    "Org": "Platform",
    "Critique": "Review",
    "Automation": "Automation",
    "Marketing": "Marketing",
    "Design": "Design",
    "Build": "Build",
    "Research": "Research",
    "Product": "Product",
}

BOARDS = {
    "org-work": ("core", "Core queue", "The main delivery queue for this install."),
    "agents": ("agents", "Agents", "Building and maintaining the agents themselves."),
    "linkedin": ("growth", "Growth", "Content, outreach and audience work."),
    "cdm-raas": ("delivery", "Delivery", "Client delivery: workflows, spreadsheets, mail ops."),
    "personal": ("personal", "Personal", "Home, finance, learning, life admin."),
}

_ids: dict[str, str] = {}
_title_order = [0]
_comment_order = [0]


def sid(value: str) -> str:
    if value not in _ids:
        _ids[value] = "t_" + format(len(_ids) + 1, "04d")
    return _ids[value]


def title(value: str) -> str:
    out = TITLES[_title_order[0] % len(TITLES)]
    _title_order[0] += 1
    return out


def one(values: list[str], index: int) -> str:
    return values[index % len(values)]


SCRUB = [
    (r"org-work", "core"),
    (r"cdm-raas", "delivery"),
    (r"\bCDM Direct\b", "the client"),
    (r"\bcdm\b", "delivery"),
    (r"\bCDM\b", "Delivery"),
    (r"\bpetasos\b", "queue"),
    (r"\bPetasos\b", "Queue"),
    (r"\bLance's\b", "the owner's"),
    (r"\bLance\b", "the owner"),
    (r"\blance\b", "the owner"),
    (r"\benriq\b", "demo"),
    (r"\bNicola\b", "a colleague"),
    (r"\bKris\b", "a colleague"),
    (r"\bTKW\b", "Demo Co"),
    (r"\bproducer\b", "builder"),
    (r"\badvisor\b", "reviewer"),
    (r"\bceo\b", "manager"),
]


def scrub(text: str) -> str:
    import re

    for pattern, replacement in SCRUB:
        text = re.sub(pattern, replacement, text)
    return text


def walk(node, key: str | None, index: int = 0):
    if isinstance(node, dict):
        return {k: walk(v, k, index) for k, v in node.items()}
    if isinstance(node, list):
        return [walk(v, key, i) for i, v in enumerate(node)]
    if isinstance(node, str):
        if key in ("id", "ids", "done_ids", "open_ids", "blocked_ids", "card_ids"):
            return sid(node) if node.startswith("t_") else node
        if key == "title":
            return title(node)
        if key == "summary":
            return one(SUMMARIES, index)
        if key == "comment":
            return one(COMMENTS, index)
        if key == "body":
            return one(BODIES, index)
        if key == "assignee" or key == "comment_author":
            return ASSIGNEES.get(node, node)
        if key == "assignees":
            return ASSIGNEES.get(node, node)
        if key == "department":
            return DEPARTMENTS.get(node, node)
        if key in ("slug", "board"):
            return BOARDS.get(node, (node,))[0]
        if key == "board_name":
            slug = node
            for original, (new_slug, name, _) in BOARDS.items():
                if original in slug:
                    return name
            return "Core queue"
        if key == "name":
            for original, (_, name, _) in BOARDS.items():
                if original.lower().split("-")[0] in node.lower():
                    return name
            return node
        if key == "description":
            for original, (_, _, description) in BOARDS.items():
                if original.split("-")[0] in node.lower():
                    return description
            return node
        return scrub(node)
    return node


def main() -> int:
    for path in sorted(FIXTURES.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        cleaned = walk(data, None)
        path.write_text(json.dumps(cleaned, indent=1), encoding="utf-8")
        print("sanitized", path.name)

    # Nothing that identifies a person, a client or a machine may survive this pass.
    import re

    banned = re.compile(r"Lance|CDM|petasos|enriq|Nicola|Kris|TKW|org-work|cdm-raas|producer|advisor", re.I)
    leaks = []
    for path in sorted(FIXTURES.glob("*.json")):
        text = path.read_text(encoding="utf-8")
        for match in set(banned.findall(text)):
            leaks.append((path.name, match))
    if leaks:
        print("LEAKS STILL PRESENT:", leaks)
        return 1
    print("clean: no names, clients, or machine paths in the fixtures")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
