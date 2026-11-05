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
  POST /screenshot        the whole screen as a PNG, base64 in {"png": ...}

Nothing here starts a browser session that is not on the desktop the person can watch.
"""

import hmac
import json
import os
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
DEVTOOLS = 9222
VIEW_VNC, CONTROL_VNC = 5900, 5901
NOVNC = os.environ.get("DESKTOP_NOVNC", "/usr/share/novnc")
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


def session_env() -> dict:
    env = {
        "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "HOME": WORKSPACE,
        "LANG": os.environ.get("LANG", "C.UTF-8"),
        "USER": os.environ.get("USER", "yuki"),
        "DISPLAY": DISPLAY,
        "TZ": os.environ.get("TZ", "UTC"),
        # The desktop's menu and panel come first; the window manager's defaults after.
        "XDG_CONFIG_DIRS": f"{HERE}/xdg:/etc/xdg",
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


def take_screenshot() -> str:
    """The whole screen (window panel included), base64 PNG."""
    import base64

    os.makedirs(RUN_DIR, exist_ok=True)
    path = os.path.join(RUN_DIR, "screen.png")
    process = subprocess.run(
        ["scrot", "--overwrite", path],
        env=session_env(),
        capture_output=True,
        timeout=15,
    )
    if process.returncode != 0:
        raise RuntimeError("The screen could not be captured")
    with open(path, "rb") as source:
        return base64.b64encode(source.read()).decode("ascii")


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

    def start(self) -> dict:
        with self.lock:
            if self.running():
                return {"desktop": "running"}
            self._stop_locked()
            if not SESSION:
                raise RuntimeError("This computer runs without a desktop session")
            os.makedirs(RUN_DIR, exist_ok=True)
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
            self.spawn(browser_argv(["about:blank"]), "browser")
        if not wait_for(devtools_ready, 30):
            raise RuntimeError("The browser did not start")

    def _stop_locked(self) -> None:
        for process in reversed(self.processes):
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
        deadline = time.time() + 5
        for process in self.processes:
            try:
                process.wait(timeout=max(0.1, deadline - time.time()))
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        self.processes = []
        self.tokens = None
        self.started_at = None

    def stop(self) -> dict:
        with self.lock:
            # A browser left running in the session (a person's terminal may have started more
            # processes) ends with it: everything in the session's groups, then the browser.
            self._stop_locked()
            subprocess.run(["pkill", "-u", str(os.getuid()), "-f", browser_binary()], check=False)
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


def browser_argv(urls: list) -> list:
    width, height = SIZE.split("x")
    return [
        browser_binary(),
        f"--user-data-dir={WORKSPACE}/.config/yuki-browser",
        f"--remote-debugging-port={DEVTOOLS}",
        "--remote-debugging-address=127.0.0.1",
        "--no-first-run",
        "--no-default-browser-check",
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
                SESSION_STATE.start()
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
                return self.reply(200, {"png": take_screenshot()})
            if self.path == "/browser":
                with BROWSER_LOCK:
                    SESSION_STATE.ensure_browser()
                    return self.reply(200, {"page": browser_action(body)})
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
