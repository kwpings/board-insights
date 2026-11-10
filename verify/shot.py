"""Screenshot the plugin page from the REAL DOM dumped by the vitest harness.

Nothing here re-draws the UI: verify/shots.json holds the actual innerHTML the plugin
produced under vitest, and this only wraps it in the app's own compiled stylesheet, in the
app's dark theme, and asks headless Chrome for a PNG.

    python verify/shot.py [list|dashboard]

Writes verify/<view>.html and verify/<view>.png.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
APP = Path("C:/Users/enriq/AppData/Local/hermes/hermes-agent/apps/desktop")
NODE_PATH = Path("C:/Users/enriq/AppData/Local/hermes/hermes-agent/node_modules")

WIDTH = 1410
HEIGHT = 1180

HEAD = """<!doctype html>
<html class="dark" lang="en">
<head>
<meta charset="utf-8">
<title>board-insights {view}</title>
<link rel="stylesheet" href="{css}">
<style>
  html, body {{ margin: 0; padding: 0; height: 100%; }}
  body {{ background: var(--ui-bg-editor, var(--theme-card-seed, #0d0d10)); color: var(--theme-foreground, #e7e7ea); font-family: 'Segoe UI', system-ui, sans-serif; }}
  #host {{ background: var(--ui-bg-editor, var(--theme-card-seed, #0d0d10)); }}
  #host {{ width: {width}px; height: {height}px; display: flex; flex-direction: column; box-sizing: border-box; }}
  #host > * {{ flex: 1 1 auto; min-height: 0; }}
</style>
</head>
<body>
<div id="host">
"""

TAIL = """
</div>
</body>
</html>
"""


def css_href() -> str:
    sheets = sorted((APP / "dist" / "assets").glob("main-*.css"), key=lambda p: p.stat().st_mtime)
    if not sheets:
        raise SystemExit("no main-*.css in the app dist")
    return "file:///" + sheets[-1].as_posix()


def main() -> int:
    view = sys.argv[1] if len(sys.argv) > 1 else "list"
    shots = json.loads((HERE / "shots.json").read_text(encoding="utf-8"))
    if view not in shots:
        raise SystemExit(f"{view} not in shots.json (have {sorted(shots)})")

    head = HEAD.format(view=view, css=css_href(), width=WIDTH, height=HEIGHT)
    if shots.get("themeCss"):
        head = head.replace("</head>", "<style>" + shots["themeCss"] + "</style>\n</head>")
    html = head + shots[view] + TAIL
    out_html = HERE / f"{view}.html"
    out_html.write_text(html, encoding="utf-8")

    out_png = HERE / f"{view}.png"
    env = dict(os.environ)
    env["NODE_PATH"] = str(NODE_PATH)
    result = subprocess.run(
        ["node", str(HERE / "shot.cjs"), str(out_html), str(out_png), str(WIDTH), str(HEIGHT)],
        capture_output=True,
        text=True,
        env=env,
        cwd=str(HERE),
    )
    print(result.stdout[-2500:])
    if result.returncode != 0:
        print(result.stderr[-2500:], file=sys.stderr)
    print("wrote", out_png)
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
