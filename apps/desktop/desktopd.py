"""The control agent of the members' computer (Yuki, open core).

Runs as the computer's own non-root user inside its container and answers the Yuki service over
the compose network. Every request but /health carries `Authorization: Bearer <token>`; the token
is read from DESKTOP_TOKEN_FILE (made on first start when missing, mode 0600) and never logged.

  GET  /health            {"ok": true}
  GET  /state             the desktop session: running or stopped, its live-view tokens
  POST /start             starts the desktop session (virtual screen, window manager, panel, browser,
                          two VNC servers: one view-only, one that takes input, and the websocket
                          bridge with the noVNC page); idempotent
  POST /stop              ends the session (the computer pauses); /workspace stays
  POST /exec              {"command", "cwd", "timeout"}: bash in /workspace, output capped
  POST /files             the files helper's request (files.py), passed through
  POST /browser           {"action": "open"|"read"|"click"|"type"|"press"|"back", ...}
  POST /screenshot        the whole screen as a JPEG, base64 in {"image": ..., "mimeType": "image/jpeg"}
  POST /pointer           {"action": "click"|"double_click"|"right_click"|"move"|"scroll", "x", "y",
                          "direction", "amount"}: the pointer at a point of the 0..1000 grid over the
                          screenshot, then a fresh screenshot as /screenshot gives it
  POST /desktop           {"action": "apps"|"open"|"look"|"click"|"type"|"set"|"press", ...}: the
                          desktop's apps through the accessibility bus (apps.py), numbered by a look

Nothing here starts a browser session that is not on the desktop the person can watch.
"""

import hmac
import json
import os
import re
import secrets
import signal
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
WORKSPACE = os.environ.get("DESKTOP_WORKSPACE", "/workspace")
RUN_DIR = os.environ.get("DESKTOP_RUN_DIR", "/tmp/yuki-desktop")
PORT = int(os.environ.get("DESKTOP_PORT", "7070"))
LIVE_PORT = int(os.environ.get("DESKTOP_LIVE_PORT", "6080"))
DISPLAY = os.environ.get("DESKTOP_DISPLAY", ":1")
SIZE = os.environ.get("DESKTOP_SIZE", "1280x800")
# v1.7.5: screenshots are JPEG at this quality (a third of the PNG): every picture a member looks at
# travels to the model service, and the way there can be slow.
SHOT_QUALITY = max(30, min(95, int(os.environ.get("DESKTOP_SHOT_QUALITY", "60"))))
# Points a member reads off a screenshot are on this grid: 0,0 the top left corner, GRID,GRID the
# bottom right, whatever the picture's size in pixels (the way vision models give positions).
GRID = 1000
DEVTOOLS = 9222
VIEW_VNC, CONTROL_VNC = 5900, 5901
NOVNC = os.environ.get("DESKTOP_NOVNC", "/usr/share/novnc")
# The desktop session's own D-Bus: the accessibility bus is found through it (/desktop, apps.py).
BUS = os.path.join(RUN_DIR, "session-bus")
OUTPUT_LIMIT = 64 * 1024
MAX_TIMEOUT = 120
# Session processes are started only when this is not "off" (the tests run the agent without
# a screen: exec, files and the token).
SESSION = os.environ.get("DESKTOP_SESSION", "on") != "off"


def log(message: str) -> None:
    print(f"[desktopd] {message}", file=sys.stderr, flush=True)


def load_token() -> str:
    value = os.environ.get("DESKTOP_TOKEN", "").strip()
    if value:
        return value
    path = os.environ.get("DESKTOP_TOKEN_FILE", "/secrets/token")
    try:
        with open(path, encoding="utf-8") as source:
            value = source.read().strip()
    except FileNotFoundError:
        value = ""
    if len(value) < 32:
        value = secrets.token_urlsafe(32)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as target:
            target.write(value + "\n")
        log(f"made a new token in {path}")
    return value


def inside_workspace(path: str) -> str:
    if not isinstance(path, str) or "\x00" in path:
        raise ValueError("Invalid working folder")
    # The service names folders as /workspace/...; the tests keep the workspace elsewhere.
    if path == "/workspace" or path.startswith("/workspace/"):
        path = path[len("/workspace/") :]
    full = os.path.normpath(os.path.join(WORKSPACE, path))
    if full != WORKSPACE and not full.startswith(WORKSPACE + os.sep):
        raise ValueError("The working folder must be inside /workspace")
    if not os.path.isdir(full):
        raise ValueError("The working folder does not exist")
    return full


def clip(data: bytes) -> tuple[str, bool]:
    truncated = len(data) > OUTPUT_LIMIT
    return data[:OUTPUT_LIMIT].decode("utf-8", errors="replace"), truncated


# The desktop session's time zone: the account's, sent by the service with /start (v1.5.1: the
# clock said UTC whatever 设置 said). It applies from the next start; a running desktop keeps its own.
ZONEINFO = os.environ.get("DESKTOP_ZONEINFO", "/usr/share/zoneinfo")
ZONE_NAME = re.compile(r"^[A-Za-z]+(?:/[A-Za-z0-9_+-]+){0,2}$")
SESSION_ZONE = ""


def valid_zone(value) -> str:
    """An IANA zone name the system knows (its zoneinfo file exists), else ""."""
    if not isinstance(value, str) or not ZONE_NAME.match(value):
        return ""
    return value if os.path.isfile(os.path.join(ZONEINFO, value)) else ""


def start_zone(raw: bytes) -> str:
    """The zone a /start names, or "" (an empty or unreadable body names none)."""
    try:
        body = json.loads(raw or b"{}")
    except ValueError:
        return ""
    return valid_zone(body.get("timezone")) if isinstance(body, dict) else ""


def session_env() -> dict:
    env = {
        "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "HOME": WORKSPACE,
        "LANG": os.environ.get("LANG", "C.UTF-8"),
        "USER": os.environ.get("USER", "yuki"),
        "DISPLAY": DISPLAY,
        "TZ": SESSION_ZONE or os.environ.get("TZ", "UTC"),
        # The desktop's menu and panel come first; the window manager's defaults after.
        "XDG_CONFIG_DIRS": f"{HERE}/xdg:/etc/xdg",
        # Every app of the session (a member's command's too) joins the session's bus, through which
        # the accessibility bus is found: its buttons and fields can be read and used (/desktop).
        "DBUS_SESSION_BUS_ADDRESS": f"unix:path={BUS}",
        "QT_ACCESSIBILITY": "1",
    }
    return env


def run_command(command: str, cwd: str, timeout: float) -> dict:
    """bash in its own process group; the whole group is killed at the timeout."""
    process = subprocess.Popen(
        ["/bin/bash", "--noprofile", "--norc", "-c", command],
        cwd=cwd,
        env=session_env(),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    timed_out = False
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        stdout, stderr = process.communicate()
    out, out_cut = clip(stdout)
    err, err_cut = clip(stderr)
    return {
        "stdout": out,
        "stderr": err,
        "exitCode": None if timed_out else process.returncode,
        "timedOut": timed_out,
        "truncated": out_cut or err_cut,
    }


def take_screenshot() -> dict:
    """The whole screen (window panel included): {"image": base64 JPEG, "mimeType"}."""
    import base64

    os.makedirs(RUN_DIR, exist_ok=True)
    path = os.path.join(RUN_DIR, "screen.jpg")
    process = subprocess.run(
        ["scrot", "--overwrite", "--quality", str(SHOT_QUALITY), path],
        env=session_env(),
        capture_output=True,
        timeout=15,
    )
    if process.returncode != 0:
        raise RuntimeError("The screen could not be captured")
    with open(path, "rb") as source:
        picture = base64.b64encode(source.read()).decode("ascii")
    # "png" for one release: a server of 1.7.4 or older (a rollback leaves it beside this agent)
    # reads only that field; it then sends the JPEG as a PNG, which works.
    return {"image": picture, "mimeType": "image/jpeg", "png": picture}


def screen_size() -> tuple:
    width, height = SIZE.lower().split("x")
    return int(width), int(height)


def grid_point(x, y, size=None) -> tuple:
    """A point of the 0..GRID grid over the screenshot, in screen pixels, kept on the screen."""
    width, height = size or screen_size()
    for value in (x, y):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= value <= GRID:
            raise ValueError(f"x and y are points of the 0 to {GRID} grid over the screenshot")
    return (
        min(width - 1, max(0, int(x * width / GRID + 0.5))),
        min(height - 1, max(0, int(y * height / GRID + 0.5))),
    )


POINTER_BUTTONS = {
    "click": ["click", "1"],
    "double_click": ["click", "--repeat", "2", "--delay", "120", "1"],
    "right_click": ["click", "3"],
    "move": [],
}
# What the screen is given to answer a click (a menu opening, a page starting to load) before the
# picture is taken.
POINTER_SETTLE = float(os.environ.get("DESKTOP_POINTER_SETTLE", "0.8"))
# How long a pointer action waits for another desktop step to end. Below the server's 30 s for
# /pointer: a click must never land after the server has told the model it failed.
POINTER_LOCK_WAIT = 20


def pointer_argv(body: dict) -> tuple:
    """The xdotool words for a pointer action, and the point in pixels; checked before anything moves."""
    action = body.get("action")
    if action not in (*POINTER_BUTTONS, "scroll"):
        raise ValueError("action is click, double_click, right_click, move or scroll")
    x, y = grid_point(body.get("x"), body.get("y"))
    argv = ["xdotool", "mousemove", str(x), str(y)]
    if action == "scroll":
        direction = body.get("direction")
        if direction not in ("up", "down"):
            raise ValueError("scroll needs direction: up or down")
        amount = body.get("amount", 3)
        if isinstance(amount, bool) or not isinstance(amount, int) or not 1 <= amount <= 15:
            raise ValueError("amount is a whole number from 1 to 15")
        argv += ["click", "--repeat", str(amount), "--delay", "60", "4" if direction == "up" else "5"]
    else:
        argv += POINTER_BUTTONS[action]
    return argv, (x, y)


def pointer_action(body: dict) -> dict:
    """The pointer at a grid point (click, double click, right click, move or scroll), then the screen."""
    argv, (x, y) = pointer_argv(body)
    process = subprocess.run(argv, env=session_env(), capture_output=True, timeout=15)
    if process.returncode != 0:
        raise RuntimeError("The pointer could not be moved")
    time.sleep(POINTER_SETTLE)
    return {"at": [x, y], "screen": list(screen_size()), **take_screenshot()}


def ensure_workspace_folders() -> None:
    """v1.6: the two folders the person's file page and the members agree on (收到: what the
    person hands over; 成品: what members deliver), made once the workspace is writable."""
    for folder in ("收到", "成品"):
        try:
            os.makedirs(os.path.join(WORKSPACE, folder), mode=0o700, exist_ok=True)
        except OSError as error:
            log(f"could not make /workspace/{folder}: {error}")


def run_files(body: bytes) -> dict:
    env = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}
    if WORKSPACE != "/workspace":
        env["YUKI_FILES_ROOT"] = WORKSPACE  # the tests keep the workspace elsewhere
    process = subprocess.run(
        [sys.executable, "-I", os.path.join(HERE, "files.py")],
        input=body,
        capture_output=True,
        timeout=10,
        env=env,
    )
    if process.returncode != 0:
        return {"error": process.stderr.decode("utf-8", errors="replace").strip()[:500] or "File operation failed"}
    return {"result": json.loads(process.stdout.decode("utf-8"))}


# ───────────────────────────── the desktop session ─────────────────────────────


class Session:
    """The desktop's processes, started together and stopped together."""

    def __init__(self):
        self.lock = threading.Lock()
        self.processes: list[subprocess.Popen] = []
        # Processes of the session whose end does not end it: the accessibility bus, the apps opened.
        self.helpers: list[subprocess.Popen] = []
        self.started_at: float | None = None
        self.tokens: dict | None = None

    def running(self) -> bool:
        return bool(self.processes) and all(p.poll() is None for p in self.processes)

    def state(self) -> dict:
        # No lock: a start takes up to 40 seconds with the lock held, and the service asks the state
        # while it waits (the fields it reads are each set in one step).
        running = self.running()
        tokens = self.tokens
        return {
            "desktop": "running" if running and tokens else "stopped",
            "startedAt": self.started_at if running else None,
            "live": tokens if running else None,
            "size": SIZE,
        }

    def spawn(self, argv: list, name: str) -> subprocess.Popen:
        os.makedirs(RUN_DIR, exist_ok=True)
        log_file = open(os.path.join(RUN_DIR, f"{name}.log"), "ab")
        process = subprocess.Popen(
            argv,
            env=session_env(),
            cwd=WORKSPACE,
            stdin=subprocess.DEVNULL,
            stdout=log_file,
            stderr=log_file,
            start_new_session=True,
        )
        log_file.close()
        self.processes.append(process)
        return process

    def helper(self, argv: list, name: str) -> subprocess.Popen:
        """A process of the session whose end does not end it; stopped with the session."""
        os.makedirs(RUN_DIR, exist_ok=True)
        log_file = open(os.path.join(RUN_DIR, f"{name}.log"), "ab")
        process = subprocess.Popen(
            argv,
            env=session_env(),
            cwd=WORKSPACE,
            stdin=subprocess.DEVNULL,
            stdout=log_file,
            stderr=log_file,
            start_new_session=True,
        )
        log_file.close()
        self.helpers = [p for p in self.helpers if p.poll() is None] + [process]
        return process

    def reap(self) -> None:
        """Collects the apps that ended (a member or the person closed them), so none lingers in the
        process table; skipped while a start or a stop holds the lock."""
        if self.lock.acquire(blocking=False):
            try:
                self.helpers = [p for p in self.helpers if p.poll() is None]
            finally:
                self.lock.release()

    def launch(self, argv: list, name: str) -> None:
        """An app a member opens (/desktop open): on the running desktop, closed with it."""
        with self.lock:
            if not self.running():
                raise RuntimeError("The desktop is not running")
            self.helper(argv, name)

    def start_accessibility(self) -> None:
        """The accessibility bus. Without it the desktop still works; /desktop then says the apps
        cannot be read."""
        launcher = a11y_launcher()
        if not launcher:
            log("no accessibility bus launcher: the desktop's apps cannot be read")
            return
        self.helper([launcher, "--launch-immediately"], "a11y")
        if wait_for(a11y_ready, 10):
            enable_a11y()
        else:
            log("the accessibility bus did not start: the desktop's apps cannot be read")

    def start(self, zone: str = "") -> dict:
        global SESSION_ZONE
        with self.lock:
            if self.running():
                return {"desktop": "running"}
            if zone:
                SESSION_ZONE = zone
            self._stop_locked()
            if not SESSION:
                raise RuntimeError("This computer runs without a desktop session")
            os.makedirs(RUN_DIR, exist_ok=True)
            ensure_workspace_folders()
            width, height = SIZE.split("x")
            number = DISPLAY.lstrip(":")
            for stale in (f"/tmp/.X{number}-lock", f"/tmp/.X11-unix/X{number}"):
                try:
                    os.unlink(stale)
                except FileNotFoundError:
                    pass
            self.spawn(["Xvfb", DISPLAY, "-screen", "0", f"{width}x{height}x24", "-nolisten", "tcp", "-ac"], "xvfb")
            if not wait_for(lambda: os.path.exists(f"/tmp/.X11-unix/X{number}"), 10):
                self._stop_locked()
                raise RuntimeError("The virtual screen did not start")
            subprocess.run(["xsetroot", "-solid", "#2b3a4a"], env=session_env(), check=False)
            # The session's bus first, then the accessibility bus behind it: every app started from
            # here on (and by a member's command) can be read and used through /desktop.
            try:
                os.unlink(BUS)
            except FileNotFoundError:
                pass
            self.spawn(["dbus-daemon", "--session", "--nofork", "--nopidfile", f"--address=unix:path={BUS}"], "bus")
            if not wait_for(lambda: os.path.exists(BUS), 10):
                self._stop_locked()
                raise RuntimeError("The desktop's session bus did not start")
            self.start_accessibility()
            self.spawn(["openbox"], "openbox")
            self.spawn(["tint2", "-c", os.path.join(HERE, "xdg/tint2/tint2rc")], "panel")
            view, control = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
            tokens_path = os.path.join(RUN_DIR, "vnc-tokens")
            fd = os.open(tokens_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as target:
                target.write(f"{view}: 127.0.0.1:{VIEW_VNC}\n{control}: 127.0.0.1:{CONTROL_VNC}\n")
            common = ["x11vnc", "-display", DISPLAY, "-localhost", "-shared", "-forever", "-nopw", "-quiet", "-noxdamage"]
            self.spawn(common + ["-rfbport", str(VIEW_VNC), "-viewonly"], "vnc-view")
            self.spawn(common + ["-rfbport", str(CONTROL_VNC)], "vnc-control")
            self.spawn(
                ["websockify", "--web", NOVNC, "--token-plugin", "TokenFile", "--token-source", tokens_path, f"0.0.0.0:{LIVE_PORT}"],
                "live",
            )
            clear_browser_locks()
            mark_browser_closed_cleanly()
            self.spawn(browser_argv(["about:blank"]), "browser")
            if not wait_for(devtools_ready, 30):
                self._stop_locked()
                raise RuntimeError("The browser did not start")
            self.tokens = {"view": view, "control": control, "port": LIVE_PORT}
            self.started_at = time.time()
            log("desktop started")
            return {"desktop": "running"}

    def browser_alive(self) -> bool:
        return self.running() and devtools_ready()

    def ensure_browser(self) -> None:
        """A browser the person closed comes back with the next member action."""
        with self.lock:
            if not self.running():
                raise RuntimeError("The desktop is not running")
            if devtools_ready():
                return
            self.processes = [p for p in self.processes if p.args[0] != browser_binary() or p.poll() is None]
            mark_browser_closed_cleanly()
            self.spawn(browser_argv(["about:blank"]), "browser")
        if not wait_for(devtools_ready, 30):
            raise RuntimeError("The browser did not start")

    def _stop_locked(self) -> None:
        # The apps and the accessibility bus first, then the session's own processes.
        everything = self.processes + self.helpers
        for process in reversed(everything):
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
        deadline = time.time() + 5
        for process in everything:
            try:
                process.wait(timeout=max(0.1, deadline - time.time()))
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        self.processes = []
        self.helpers = []
        self.tokens = None
        self.started_at = None

    def stop(self) -> dict:
        with self.lock:
            # A browser left running in the session (a person's terminal may have started more
            # processes) ends with it: everything in the session's groups, then the browser.
            self._stop_locked()
            subprocess.run(["pkill", "-u", str(os.getuid()), "-f", browser_binary()], check=False)
            # An app that handed its window to an earlier instance of itself ends here too.
            for name in APP_PROCESSES:
                subprocess.run(["pkill", "-u", str(os.getuid()), "-x", name], check=False)
            log("desktop stopped")
            return {"desktop": "stopped"}


def wait_for(check, seconds: float) -> bool:
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            if check():
                return True
        except Exception:  # noqa: BLE001 - a check that fails is "not yet"
            pass
        time.sleep(0.25)
    return False


def browser_binary() -> str:
    return os.environ.get("DESKTOP_BROWSER", "/usr/bin/chromium")


def mark_browser_closed_cleanly() -> None:
    """The browser is ended with the desktop (an idle pause, a stop), so its profile says it crashed
    and the next start shows 「Restore pages?」 over the page, in every screenshot (v1.5.1). Its
    profile is told it closed cleanly before it starts; an unreadable profile is left alone."""
    path = os.path.join(WORKSPACE, ".config", "yuki-browser", "Default", "Preferences")
    try:
        with open(path, encoding="utf-8") as source:
            prefs = json.load(source)
    except (OSError, ValueError):
        return
    profile = prefs.get("profile") if isinstance(prefs, dict) else None
    if not isinstance(profile, dict):
        return
    if profile.get("exit_type") == "Normal" and profile.get("exited_cleanly") is True:
        return
    profile["exit_type"] = "Normal"
    profile["exited_cleanly"] = True
    try:
        with open(path, "w", encoding="utf-8") as target:
            json.dump(prefs, target)
    except OSError:
        pass


def clear_browser_locks() -> None:
    """The browser's profile lives in /workspace, which outlives this container; the browser does
    not. When the container is replaced (an update, a restart) with the browser running, the
    profile keeps its singleton lock, named after the old container and process, and the next
    browser refuses the profile as "in use on another computer" and never starts (v1.6.1). Only a
    browser this daemon spawned uses the profile, and none is running when the desktop starts, so
    the locks left in it are stale and go. A profile that is not there yet is fine."""
    folder = os.path.join(WORKSPACE, ".config", "yuki-browser")
    for name in ("SingletonLock", "SingletonSocket", "SingletonCookie"):
        try:
            os.unlink(os.path.join(folder, name))
        except FileNotFoundError:
            pass
        except OSError as error:
            log(f"could not remove the browser's stale {name}: {error}")


def browser_argv(urls: list) -> list:
    width, height = SIZE.split("x")
    return [
        browser_binary(),
        f"--user-data-dir={WORKSPACE}/.config/yuki-browser",
        f"--remote-debugging-port={DEVTOOLS}",
        "--remote-debugging-address=127.0.0.1",
        "--no-first-run",
        "--no-default-browser-check",
        # It is ended with the desktop (a pause, a stop): no 「Restore pages?」 over the next page.
        "--hide-crash-restore-bubble",
        "--disable-dev-shm-usage",
        "--password-store=basic",
        "--disable-features=Translate",
        # The container is the sandbox: it runs as a non-root user with every capability dropped,
        # where the browser's own namespace sandbox cannot start (docs/computer-container.md).
        "--no-sandbox",
        "--test-type",
        f"--window-size={width},{int(height) - 40}",
        "--window-position=0,0",
        "--start-maximized",
        *urls,
    ]


def devtools_ready() -> bool:
    with urllib.request.urlopen(f"http://127.0.0.1:{DEVTOOLS}/json/version", timeout=1) as reply:
        return reply.status == 200


# ───────────────────────────── the desktop's apps (apps.py) ─────────────────────────────

# The apps a member opens by name, and what each opens: a file (its folder must exist) or a folder.
APPS = {
    "editor": {"argv": ["mousepad"], "name": "mousepad", "path": "file"},
    "files": {"argv": ["thunar"], "name": "thunar", "path": "folder"},
}
APP_PROCESSES = ("mousepad", "thunar")
# The numbers of the latest looks: their app and each element's role and name, never the app's
# objects (apps.py runs fresh each time and finds an element again by walking the same way).
SNAPSHOTS: dict = {}
KEPT_SNAPSHOTS = 20


def a11y_launcher() -> str | None:
    for path in ("/usr/libexec/at-spi-bus-launcher", "/usr/lib/at-spi2-core/at-spi-bus-launcher"):
        if os.access(path, os.X_OK):
            return path
    return None


def dbus_send(*args: str) -> bool:
    run = subprocess.run(["dbus-send", "--session", "--print-reply", *args], env=session_env(), capture_output=True, timeout=5)
    return run.returncode == 0


def a11y_ready() -> bool:
    return dbus_send("--dest=org.a11y.Bus", "/org/a11y/bus", "org.a11y.Bus.GetAddress")


def enable_a11y() -> None:
    """What a screen reader does when it starts: tells the apps someone reads them."""
    dbus_send(
        "--dest=org.a11y.Bus",
        "/org/a11y/bus",
        "org.freedesktop.DBus.Properties.Set",
        "string:org.a11y.Status",
        "string:IsEnabled",
        "variant:boolean:true",
    )


def run_apps(request: dict, timeout: float = 45) -> dict:
    """One request of apps.py, in the desktop session's environment."""
    process = subprocess.run(
        [sys.executable, "-I", os.path.join(HERE, "apps.py")],
        input=json.dumps(request).encode("utf-8"),
        capture_output=True,
        timeout=timeout,
        env=session_env(),
    )
    try:
        reply = json.loads(process.stdout.decode("utf-8") or "{}")
    except json.JSONDecodeError:
        reply = {}
    if isinstance(reply.get("error"), str):
        raise ValueError(reply["error"])
    if "result" not in reply:
        detail = reply.get("failure") or process.stderr.decode("utf-8", errors="replace").strip()[-300:]
        raise RuntimeError(detail or "The desktop's apps could not be read")
    return reply["result"]


def remember(view: dict) -> dict:
    """Names a look so the next action can refer to its numbers; the newest KEPT_SNAPSHOTS stay."""
    elements = view.get("elements")
    if not isinstance(elements, list):
        return view
    key = secrets.token_urlsafe(6)
    SNAPSHOTS[key] = {
        "app": view.get("app"),
        "elements": [{"role": e.get("role"), "name": e.get("name")} for e in elements],
    }
    while len(SNAPSHOTS) > KEPT_SNAPSHOTS:
        SNAPSHOTS.pop(next(iter(SNAPSHOTS)))
    view["snapshot"] = key
    return view


def workspace_item(path, kind: str) -> str:
    """A file (its folder must exist) or a folder inside /workspace, for an app to open."""
    if not isinstance(path, str) or not path.strip():
        raise ValueError("Give a path inside /workspace")
    path = path.strip()
    if kind == "folder":
        return inside_workspace(path)
    folder, name = os.path.split(path)
    if not name or name in (".", ".."):
        raise ValueError("Give a file inside /workspace")
    return os.path.join(inside_workspace(folder or WORKSPACE), name)


def desktop_action(body: dict) -> dict:
    """A member's step with the desktop's apps; every action but apps answers with a fresh look."""
    SESSION_STATE.reap()
    action = body.get("action")
    if action == "apps":
        return run_apps({"op": "apps"})
    if action == "open":
        spec = APPS.get(body.get("app"))
        if not spec:
            raise ValueError("app must be editor (a text editor) or files (a file manager)")
        argv = list(spec["argv"])
        if body.get("path"):
            argv.append(workspace_item(body["path"], spec["path"]))
        SESSION_STATE.launch(argv, spec["name"])
        deadline = time.time() + 20
        while True:
            try:
                return remember(run_apps({"op": "look", "app": spec["name"]}))
            except ValueError:
                if time.time() > deadline:
                    raise
                time.sleep(0.5)
    if action == "look":
        app = body.get("app")
        if not isinstance(app, str) or not app.strip():
            raise ValueError("look needs app, a name from apps")
        return remember(run_apps({"op": "look", "app": app.strip()[:80]}))
    if action in ("click", "type", "set"):
        snapshot = SNAPSHOTS.get(str(body.get("snapshot") or ""))
        if not snapshot:
            raise ValueError("That look is gone: look at the app again")
        n = body.get("n")
        count = len(snapshot["elements"])
        if not isinstance(n, int) or isinstance(n, bool) or not 1 <= n <= count:
            raise ValueError(f"n must be a number from that look, 1 to {count}")
        request = {"op": action, "app": snapshot["app"], "n": n, "expect": snapshot["elements"][n - 1]}
        if action != "click":
            text = body.get("text")
            if not isinstance(text, str):
                raise ValueError(f"{action} needs text")
            request["text"] = text[:5000]
        return remember(run_apps(request))
    if action == "press":
        key = body.get("key")
        if not isinstance(key, str) or not key.strip():
            raise ValueError("press needs key, such as Enter or ctrl+s")
        request = {"op": "press", "key": key.strip()[:40]}
        if isinstance(body.get("app"), str) and body["app"].strip():
            request["app"] = body["app"].strip()[:80]
        return remember(run_apps(request))
    raise ValueError("Unknown desktop action")


# ───────────────────────────── the browser, over DevTools ─────────────────────────────


def page_target() -> dict:
    with urllib.request.urlopen(f"http://127.0.0.1:{DEVTOOLS}/json/list", timeout=3) as reply:
        targets = json.loads(reply.read())
    pages = [t for t in targets if t.get("type") == "page" and t.get("webSocketDebuggerUrl")]
    if not pages:
        request = urllib.request.Request(f"http://127.0.0.1:{DEVTOOLS}/json/new?about:blank", method="PUT")
        with urllib.request.urlopen(request, timeout=3) as reply:
            return json.loads(reply.read())
    return pages[0]


class Page:
    """One DevTools connection to the browser's front tab."""

    def __init__(self):
        import websocket  # python3-websocket, in the image

        target = page_target()
        self.target_id = target["id"]
        # No Origin header: the browser refuses DevTools sockets from an origin it was not told of.
        self.socket = websocket.create_connection(target["webSocketDebuggerUrl"], timeout=20, suppress_origin=True)
        self.next_id = 0

    def call(self, method: str, params: dict | None = None, timeout: float = 20) -> dict:
        self.next_id += 1
        mine = self.next_id
        self.socket.send(json.dumps({"id": mine, "method": method, "params": params or {}}))
        deadline = time.time() + timeout
        while time.time() < deadline:
            self.socket.settimeout(max(0.1, deadline - time.time()))
            message = json.loads(self.socket.recv())
            if message.get("id") == mine:
                if "error" in message:
                    raise RuntimeError(message["error"].get("message", "Browser error"))
                return message.get("result", {})
        raise TimeoutError(f"{method} timed out")

    def evaluate(self, expression: str):
        result = self.call("Runtime.evaluate", {"expression": expression, "returnByValue": True, "awaitPromise": True})
        if result.get("exceptionDetails"):
            raise RuntimeError("The page refused that step")
        return result.get("result", {}).get("value")

    def settle(self, seconds: float = 15) -> None:
        wait_for(lambda: self.evaluate("document.readyState") == "complete", seconds)
        time.sleep(0.5)

    def close(self) -> None:
        try:
            self.socket.close()
        except Exception:  # noqa: BLE001
            pass


READ_PAGE = """(() => {
  const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n');
  return { url: location.href, title: document.title, text: text.slice(0, %d) };
})()"""

CLICK = """((wanted) => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
  const target = norm(wanted);
  const items = [...document.querySelectorAll('a, button, input[type=submit], input[type=button], [role=button], [role=link], summary, label')];
  const shown = items.filter((e) => e.offsetParent !== null || e.getClientRects().length);
  const exact = shown.find((e) => norm(e.innerText || e.value || e.getAttribute('aria-label')) === target);
  const found = exact || shown.find((e) => norm(e.innerText || e.value || e.getAttribute('aria-label')).includes(target));
  if (!found) return null;
  found.scrollIntoView({ block: 'center' });
  found.click();
  return norm(found.innerText || found.value || found.getAttribute('aria-label')).slice(0, 200);
})(%s)"""

TYPE = """((field, text) => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
  let el = null;
  if (field) {
    try { el = document.querySelector(field); } catch (e) { el = null; }
    if (!el) {
      const want = norm(field);
      const inputs = [...document.querySelectorAll('input, textarea, [contenteditable=true]')];
      el = inputs.find((e) => [e.getAttribute('aria-label'), e.placeholder, e.name, e.id,
        e.labels && e.labels[0] && e.labels[0].innerText].some((v) => norm(v) === want || norm(v).includes(want)));
    }
  } else el = document.activeElement;
  if (!el || el === document.body) return false;
  el.focus();
  if (el.isContentEditable) { el.textContent = text; }
  else {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})(%s, %s)"""

KEYS = {
    "Enter": ("Enter", 13, "\r"),
    "Tab": ("Tab", 9, ""),
    "Escape": ("Escape", 27, ""),
    "PageDown": ("PageDown", 34, ""),
    "PageUp": ("PageUp", 33, ""),
    "ArrowDown": ("ArrowDown", 40, ""),
    "ArrowUp": ("ArrowUp", 38, ""),
}


def browser_action(body: dict) -> dict:
    action = body.get("action")
    limit = max(500, min(int(body.get("maxText", 6000)), 20000))
    page = Page()
    try:
        if action == "open":
            url = body.get("url")
            if not isinstance(url, str) or not url.startswith(("http://", "https://")):
                raise ValueError("Give a web address starting with http:// or https://")
            page.call("Page.enable")
            page.call("Page.bringToFront")
            page.call("Page.navigate", {"url": url})
            page.settle()
        elif action == "read":
            pass
        elif action == "click":
            clicked = page.evaluate(CLICK % json.dumps(str(body.get("text", ""))[:200]))
            if clicked is None:
                raise ValueError("Nothing on the page has that text")
            page.settle(10)
        elif action == "type":
            done = page.evaluate(TYPE % (json.dumps(body.get("field") or ""), json.dumps(str(body.get("text", ""))[:5000])))
            if not done:
                raise ValueError("No field to type into was found")
        elif action == "press":
            key = KEYS.get(str(body.get("key")))
            if not key:
                raise ValueError(f"Key must be one of {', '.join(KEYS)}")
            name, code, text = key
            for kind in ("keyDown", "keyUp"):
                params = {"type": kind, "key": name, "code": name, "windowsVirtualKeyCode": code}
                if text and kind == "keyDown":
                    params["text"] = text
                page.call("Input.dispatchKeyEvent", params)
            page.settle(10)
        elif action == "back":
            page.evaluate("history.back()")
            page.settle(10)
        else:
            raise ValueError("Unknown browser action")
        return page.evaluate(READ_PAGE % limit)
    finally:
        page.close()


# ───────────────────────────── HTTP ─────────────────────────────

SESSION_STATE = Session()
TOKEN = ""
EXEC_LOCK = threading.Semaphore(4)
BROWSER_LOCK = threading.Lock()
DESKTOP_LOCK = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    server_version = "yuki-desktop"
    sys_version = ""

    def log_message(self, format, *args):  # noqa: A002 - the base class's name
        return

    def reply(self, status: int, value: dict) -> None:
        data = json.dumps(value).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def authorized(self) -> bool:
        given = self.headers.get("Authorization", "")
        expected = f"Bearer {TOKEN}"
        if not hmac.compare_digest(given.encode(), expected.encode()):
            self.reply(401, {"error": "Not authorized"})
            return False
        # A page in the computer's own browser may reach this port; it never sends JSON with the
        # token, and a request carrying an Origin is not the Yuki service.
        if self.headers.get("Origin"):
            self.reply(403, {"error": "Not for browsers"})
            return False
        return True

    def body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        if length > 15 * 1024 * 1024:
            raise ValueError("Request is too large")
        return self.rfile.read(length) if length else b""

    def do_GET(self):  # noqa: N802 - http.server's name
        if self.path == "/health":
            return self.reply(200, {"ok": True})
        if not self.authorized():
            return None
        if self.path == "/state":
            return self.reply(200, SESSION_STATE.state())
        return self.reply(404, {"error": "Not found"})

    def do_POST(self):  # noqa: N802
        if not self.authorized():
            return None
        try:
            raw = self.body()
            if self.path == "/start":
                SESSION_STATE.start(start_zone(raw))
                return self.reply(200, SESSION_STATE.state())
            if self.path == "/stop":
                SESSION_STATE.stop()
                return self.reply(200, SESSION_STATE.state())
            if self.path == "/files":
                return self.reply(200, run_files(raw))
            body = json.loads(raw or b"{}")
            if self.path == "/exec":
                command = body.get("command")
                if not isinstance(command, str) or not command.strip() or len(command) > 16000:
                    raise ValueError("Give a command")
                cwd = inside_workspace(body.get("cwd") or WORKSPACE)
                timeout = max(1, min(float(body.get("timeout") or 30), MAX_TIMEOUT))
                with EXEC_LOCK:
                    return self.reply(200, run_command(command, cwd, timeout))
            if self.path == "/screenshot":
                if not SESSION_STATE.running():
                    raise ValueError("The desktop is not running")
                return self.reply(200, take_screenshot())
            if self.path == "/pointer":
                pointer_argv(body)
                if not DESKTOP_LOCK.acquire(timeout=POINTER_LOCK_WAIT):
                    raise ValueError("The desktop is busy with another step; nothing was clicked")
                try:
                    if not SESSION_STATE.running():
                        raise ValueError("The desktop is not running")
                    return self.reply(200, pointer_action(body))
                finally:
                    DESKTOP_LOCK.release()
            if self.path == "/browser":
                with BROWSER_LOCK:
                    SESSION_STATE.ensure_browser()
                    return self.reply(200, {"page": browser_action(body)})
            if self.path == "/desktop":
                with DESKTOP_LOCK:
                    if not SESSION_STATE.running():
                        raise ValueError("The desktop is not running")
                    return self.reply(200, {"view": desktop_action(body)})
            return self.reply(404, {"error": "Not found"})
        except (ValueError, json.JSONDecodeError) as error:
            return self.reply(400, {"error": str(error)})
        except Exception as error:  # noqa: BLE001 - every failure answers, none crashes the agent
            log(f"{self.path}: {type(error).__name__}: {error}")
            return self.reply(500, {"error": str(error) or type(error).__name__})


def main() -> None:
    global TOKEN
    TOKEN = load_token()
    os.makedirs(RUN_DIR, exist_ok=True)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True

    def shutdown(*_):
        SESSION_STATE.stop()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    if os.environ.get("DESKTOP_START") == "1" and SESSION:
        threading.Thread(target=SESSION_STATE.start, daemon=True).start()
    log(f"listening on :{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
