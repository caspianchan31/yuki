#!/usr/bin/env python3
"""The desktop apps helper of the members' computer (Yuki, open core).

desktopd runs it once per request, in the desktop session's environment (its session bus and the
accessibility bus behind it), with the request as JSON on stdin and the answer as JSON on stdout,
{"result": ...} for a done request, {"error": "..."} for one the member can correct:

  {"op": "apps"}                                 the apps on the screen and their windows
  {"op": "look", "app": "mousepad"}              the app's buttons, fields, menus and the like, numbered
  {"op": "click", "app", "n", "expect"}          presses element n of the app's look, then looks again
  {"op": "type" | "set", "app", "n", "expect", "text"}
                                                 types at the caret of field n / replaces its text
  {"op": "press", "key": "ctrl+s", "app": ...}   a key or a combination, to the app's window

Numbers follow one walk of the app's accessibility tree: an element is found again by the same walk
and must still have the role and name its look gave (otherwise the member looks again). A fresh
process each time: the desktop's buses are new after every pause, and no stale connection is kept.
"""

import json
import re
import subprocess
import sys
import time

# Roles a member can act on; the others (labels, panels, fillers) only give context.
INTERACTIVE = frozenset(
    {
        "push button", "toggle button", "check box", "radio button", "menu", "menu item",
        "check menu item", "radio menu item", "entry", "text", "password text", "combo box",
        "link", "page tab", "spin button", "slider", "list item", "tree item", "table cell", "icon",
    }
)
TEXT_ROLES = frozenset({"entry", "text", "password text", "combo box", "spin button"})
WINDOW_ROLES = frozenset({"frame", "dialog", "alert", "file chooser", "window"})
CONTEXT_ROLES = frozenset({"label", "heading", "status bar", "notification", "static"})
MAX_NODES = 5000
MAX_DEPTH = 80
MAX_ELEMENTS = 150
MAX_NAME = 120
MAX_TEXT = 2000
OPS = ("apps", "look", "click", "type", "set", "press")
# The action that presses an element, when it has several (a button's "press", a menu's "click").
PREFERRED_ACTIONS = ("click", "press", "activate", "toggle", "jump", "open")

KEYS = {
    "enter": "Return", "return": "Return", "escape": "Escape", "esc": "Escape", "tab": "Tab",
    "backspace": "BackSpace", "delete": "Delete", "up": "Up", "down": "Down", "left": "Left",
    "right": "Right", "home": "Home", "end": "End", "pageup": "Prior", "pagedown": "Next",
    "space": "space",
}
MODIFIERS = {"ctrl": "ctrl", "control": "ctrl", "shift": "shift", "alt": "alt", "super": "super"}


def parse_key(key) -> str:
    """A key or combination a member names ("Enter", "ctrl+s", "ctrl+shift+t") as xdotool reads it."""
    if not isinstance(key, str) or not key.strip() or len(key) > 40:
        raise ValueError("press needs a key, such as Enter, Escape, Tab or ctrl+s")
    parts = [part.strip() for part in key.strip().split("+")]
    if len(parts) > 4 or any(not part for part in parts):
        raise ValueError(f"Not a key: {key}")
    *modifiers, last = parts
    names = []
    for modifier in modifiers:
        if modifier.lower() not in MODIFIERS:
            raise ValueError(f"Unknown modifier {modifier}: use ctrl, shift, alt or super")
        names.append(MODIFIERS[modifier.lower()])
    lower = last.lower()
    if lower in KEYS:
        names.append(KEYS[lower])
    elif re.fullmatch(r"f([1-9]|1[0-2])", lower):
        names.append(lower.upper())
    elif len(last) == 1 and last.isascii() and last.isalnum():
        names.append(lower if modifiers else last)
    else:
        raise ValueError(f"Unknown key {last}: use Enter, Escape, Tab, a letter or a digit, F1 to F12")
    return "+".join(names)


def pick_action(names) -> int:
    """The index of the action that presses an element; the first one when none is named so."""
    lowered = [str(name).lower() for name in names]
    for preferred in PREFERRED_ACTIONS:
        if preferred in lowered:
            return lowered.index(preferred)
    return 0


def same(element: dict, expect: dict) -> bool:
    """Whether an element found again is the one the look numbered: the same role and name."""
    return (
        bool(expect)
        and element.get("role") == expect.get("role")
        and element.get("name") == expect.get("name")
    )


# ───────────────────────────── the accessibility tree ─────────────────────────────


def connect():
    import pyatspi  # python3-pyatspi, in the computer's image

    return pyatspi


def role_of(node) -> str:
    try:
        return node.getRoleName()
    except Exception:  # noqa: BLE001 - an app that went away mid-walk
        return ""


def name_of(node) -> str:
    try:
        return (node.name or "").strip()
    except Exception:  # noqa: BLE001
        return ""


def children(node) -> list:
    try:
        count = node.childCount
    except Exception:  # noqa: BLE001
        return []
    found = []
    for index in range(min(count, 2000)):
        try:
            child = node.getChildAtIndex(index)
        except Exception:  # noqa: BLE001
            child = None
        if child is not None:
            found.append(child)
    return found


def walk(node, out: list, depth: int = 0) -> None:
    if len(out) >= MAX_NODES or depth > MAX_DEPTH:
        return
    out.append(node)
    for child in children(node):
        walk(child, out, depth + 1)


def showing(pa, node) -> bool:
    try:
        return node.getState().contains(pa.STATE_SHOWING)
    except Exception:  # noqa: BLE001
        return False


def text_of(node):
    try:
        text = node.queryText()
        content = text.getText(0, min(text.characterCount, MAX_TEXT + 1))
    except Exception:  # noqa: BLE001 - not a text element
        return None
    return content if len(content) <= MAX_TEXT else content[:MAX_TEXT] + "…"


def describe(pa, node, n: int) -> dict:
    info = {"n": n, "role": role_of(node), "name": name_of(node)[:MAX_NAME]}
    flags = []
    try:
        states = node.getState()
        for state, word in (
            (pa.STATE_FOCUSED, "focused"),
            (pa.STATE_CHECKED, "checked"),
            (pa.STATE_SELECTED, "selected"),
            (pa.STATE_EXPANDED, "expanded"),
        ):
            if states.contains(state):
                flags.append(word)
        if not states.contains(pa.STATE_SENSITIVE):
            flags.append("disabled")
    except Exception:  # noqa: BLE001
        pass
    if flags:
        info["state"] = flags
    if info["role"] in TEXT_ROLES:
        text = text_of(node)
        if text:
            info["text"] = text
    return info


def all_apps(pa) -> list:
    return [app for app in children(pa.Registry.getDesktop(0)) if name_of(app)]


def find_app(pa, wanted):
    wanted = str(wanted or "").strip().lower()
    if not wanted:
        raise ValueError("Name the app, as apps lists it")
    candidates = all_apps(pa)
    for match in (lambda name: name == wanted, lambda name: wanted in name):
        found = [app for app in candidates if match(name_of(app).lower())]
        if found:
            return found[-1]
    names = ", ".join(sorted({name_of(app) for app in candidates})) or "none"
    raise ValueError(f"{wanted} is not open (open: {names})")


def numbered(pa, app):
    nodes: list = []
    walk(app, nodes)
    return nodes, [node for node in nodes if role_of(node) in INTERACTIVE and showing(pa, node)]


def apps_view(pa) -> dict:
    found = []
    for app in all_apps(pa):
        windows = [name_of(w) for w in children(app) if role_of(w) in WINDOW_ROLES and showing(pa, w)]
        found.append({"name": name_of(app), "windows": [w for w in windows if w][:10]})
    return {"apps": found}


def look(pa, wanted) -> dict:
    app = find_app(pa, wanted)
    nodes, elements = numbered(pa, app)
    windows = []
    texts = []
    for node in nodes:
        role = role_of(node)
        if role in WINDOW_ROLES and showing(pa, node) and name_of(node):
            windows.append(name_of(node)[:MAX_NAME])
        elif role in CONTEXT_ROLES and len(texts) < 30 and showing(pa, node):
            name = name_of(node)[:200]
            if name and name not in texts:
                texts.append(name)
    shown = elements[:MAX_ELEMENTS]
    view = {
        "app": name_of(app),
        "windows": windows[:10],
        "elements": [describe(pa, node, index + 1) for index, node in enumerate(shown)],
    }
    if texts:
        view["texts"] = texts
    if len(elements) > MAX_ELEMENTS:
        view["more"] = len(elements) - MAX_ELEMENTS
    return view


def element(pa, request):
    app = find_app(pa, request.get("app"))
    _, elements = numbered(pa, app)
    n = request.get("n")
    if not isinstance(n, int) or isinstance(n, bool) or not 1 <= n <= min(len(elements), MAX_ELEMENTS):
        raise ValueError("The app changed since the last look: look again")
    node = elements[n - 1]
    if not same(describe(pa, node, n), request.get("expect") or {}):
        raise ValueError("The app changed since the last look: look again")
    return app, node


# ───────────────────────────── acting: the interface first, then keys and the mouse ─────────────


def xdotool(*args: str) -> str:
    run = subprocess.run(["xdotool", *args], capture_output=True, text=True, timeout=30)
    if run.returncode != 0:
        raise RuntimeError(run.stderr.strip()[:300] or "The desktop did not take that input")
    return run.stdout


def focus_window(app) -> None:
    """Keys and clicks go to the window with the focus: the app's own, brought to the front."""
    try:
        pid = app.get_process_id()
    except Exception:  # noqa: BLE001
        pid = None
    for args in ((["--pid", str(pid)] if pid else None), ["--classname", name_of(app)]):
        if not args:
            continue
        found = subprocess.run(
            ["xdotool", "search", "--onlyvisible", *args], capture_output=True, text=True, timeout=10
        ).stdout.split()
        if found:
            subprocess.run(["xdotool", "windowactivate", "--sync", found[-1]], capture_output=True, timeout=10)
            return


def click(pa, app, node) -> None:
    try:
        action = node.queryAction()
        names = [action.getName(index) for index in range(action.nActions)]
    except Exception:  # noqa: BLE001 - no action interface
        names = []
    if names:
        node.queryAction().doAction(pick_action(names))
        return
    extents = node.queryComponent().getExtents(pa.DESKTOP_COORDS)
    focus_window(app)
    x, y = extents.x + extents.width // 2, extents.y + extents.height // 2
    xdotool("mousemove", "--sync", str(x), str(y), "click", "1")


def write(pa, app, node, text: str, replace: bool) -> None:
    before = text_of(node)
    try:
        editable = node.queryEditableText()
        if replace:
            editable.setTextContents(text)
        else:
            current = node.queryText()
            caret = current.caretOffset
            editable.insertText(caret if caret >= 0 else current.characterCount, text, len(text.encode("utf-8")))
        time.sleep(0.2)
        after = text_of(node)
        if (after == text[:MAX_TEXT]) if replace else (after != before):
            return
    except Exception:  # noqa: BLE001 - no editing interface: keys instead
        pass
    # A field that takes no edit through the interface (a web page's) takes keys: focus, then type.
    try:
        node.queryComponent().grabFocus()
    except Exception:  # noqa: BLE001
        pass
    focus_window(app)
    if replace:
        xdotool("key", "--clearmodifiers", "ctrl+a")
    if text:
        xdotool("type", "--delay", "12", "--", text)


def look_after(pa, wanted) -> dict:
    time.sleep(0.6)
    try:
        return look(pa, wanted)
    except ValueError:
        return {"app": wanted, "note": "The app is no longer open."}


def handle(request: dict) -> dict:
    op = request.get("op")
    if op not in OPS:
        raise ValueError("Unknown desktop action")
    combo = parse_key(request.get("key")) if op == "press" else None
    pa = connect()
    if op == "apps":
        return apps_view(pa)
    if op == "look":
        return look(pa, request.get("app"))
    if op == "press":
        if not request.get("app"):
            xdotool("key", "--clearmodifiers", combo)
            return {"pressed": combo}
        focus_window(find_app(pa, request["app"]))
        xdotool("key", "--clearmodifiers", combo)
        return look_after(pa, request["app"])
    app, node = element(pa, request)
    if op == "click":
        click(pa, app, node)
    else:
        text = request.get("text")
        if not isinstance(text, str):
            raise ValueError(f"{op} needs text")
        write(pa, app, node, text, replace=op == "set")
    return look_after(pa, request.get("app"))


def main() -> int:
    try:
        request = json.loads(sys.stdin.read() or "{}")
        if not isinstance(request, dict):
            raise ValueError("Unknown desktop action")
        result = handle(request)
    except ValueError as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        return 0
    except Exception as error:  # noqa: BLE001 - the agent turns this into a 500
        print(json.dumps({"failure": f"{type(error).__name__}: {error}"[:500]}, ensure_ascii=False))
        return 1
    print(json.dumps({"result": result}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
