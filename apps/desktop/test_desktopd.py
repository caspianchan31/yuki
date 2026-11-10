#!/usr/bin/env python3
"""The members' computer's control agent (desktopd.py): its token, its working folder, its commands
and its HTTP door. Every request but /health needs the shared token; a request that carries an
Origin (a page in the computer's own browser) is refused even with it; commands run in /workspace
only, are cut at their time limit and cap their output; a session that cannot start says so.
No X server, browser or VNC is needed: the agent runs with DESKTOP_SESSION=off, the way it runs
in the container's tests, and the screen processes are not started."""
import atexit
import json
import os
import shutil
import stat
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SANDBOX = os.path.realpath(tempfile.mkdtemp(prefix="yuki-desktopd-"))
atexit.register(shutil.rmtree, SANDBOX, True)
WORKSPACE = os.path.join(SANDBOX, "workspace")
os.makedirs(WORKSPACE)
# desktopd reads its settings when it is imported.
os.environ.update(
    DESKTOP_WORKSPACE=WORKSPACE,
    DESKTOP_RUN_DIR=os.path.join(SANDBOX, "run"),
    DESKTOP_SESSION="off",
    # Stopping kills this program by name; a name nothing on the machine has.
    DESKTOP_BROWSER="/nonexistent/yuki-test-browser",
    DESKTOP_TOKEN_FILE=os.path.join(SANDBOX, "secrets", "token"),
)
os.environ.pop("DESKTOP_TOKEN", None)
sys.path.insert(0, HERE)
import desktopd  # noqa: E402


def call(base, token, method, path, body=None, headers=None):
    request = urllib.request.Request(base + path, method=method, data=None if body is None else json.dumps(body).encode())
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    request.add_header("Content-Type", "application/json")
    for name, value in (headers or {}).items():
        request.add_header(name, value)
    try:
        with urllib.request.urlopen(request, timeout=20) as reply:
            return reply.status, json.loads(reply.read())
    except urllib.error.HTTPError as error:
        with error:
            return error.code, json.loads(error.read() or b"{}")


class Token(unittest.TestCase):
    def test_made_on_first_start_private_and_reused(self):
        path = os.path.join(SANDBOX, "secrets", "token")
        if os.path.exists(path):
            os.unlink(path)
        first = desktopd.load_token()
        self.assertGreaterEqual(len(first), 32)
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        self.assertEqual(desktopd.load_token(), first)

    def test_a_short_token_file_is_replaced(self):
        path = os.path.join(SANDBOX, "secrets", "token")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as target:
            target.write("short\n")
        self.assertGreaterEqual(len(desktopd.load_token()), 32)

    def test_the_environment_wins_and_is_never_written(self):
        os.environ["DESKTOP_TOKEN"] = "t" * 40
        try:
            self.assertEqual(desktopd.load_token(), "t" * 40)
        finally:
            del os.environ["DESKTOP_TOKEN"]


class BrowserLocks(unittest.TestCase):
    """v1.6.1: the stale singleton locks a replaced container leaves in the profile are removed
    before the browser starts, and nothing else in the profile is touched."""

    def setUp(self):
        self.profile = os.path.join(WORKSPACE, ".config", "yuki-browser")
        shutil.rmtree(self.profile, ignore_errors=True)

    def test_stale_locks_go_and_the_rest_stays(self):
        os.makedirs(os.path.join(self.profile, "Default"))
        os.symlink("5e1b04a38932-59878", os.path.join(self.profile, "SingletonLock"))
        os.symlink("/tmp/org.chromium.Chromium.x/SingletonSocket", os.path.join(self.profile, "SingletonSocket"))
        os.symlink("17913942725093670622", os.path.join(self.profile, "SingletonCookie"))
        with open(os.path.join(self.profile, "Default", "Preferences"), "w") as target:
            target.write("{}")
        desktopd.clear_browser_locks()
        for name in ("SingletonLock", "SingletonSocket", "SingletonCookie"):
            self.assertFalse(os.path.lexists(os.path.join(self.profile, name)), name)
        self.assertTrue(os.path.exists(os.path.join(self.profile, "Default", "Preferences")))

    def test_no_profile_yet_is_fine(self):
        desktopd.clear_browser_locks()
        self.assertFalse(os.path.exists(self.profile))

    def test_start_clears_them_right_before_the_browser(self):
        # With the session off start() refuses before it gets there, so the order is read off the
        # source: the locks go, the profile is marked closed cleanly, then the browser is spawned.
        with open(os.path.join(HERE, "desktopd.py"), encoding="utf-8") as source:
            text = source.read()
        a = text.index("clear_browser_locks()\n", text.index("def start("))
        b = text.index("mark_browser_closed_cleanly()", a)
        c = text.index('self.spawn(browser_argv(["about:blank"]), "browser")', b)
        self.assertLess(a, b)
        self.assertLess(b, c)


class Commands(unittest.TestCase):
    def test_inside_workspace_only(self):
        os.makedirs(os.path.join(WORKSPACE, "sub"), exist_ok=True)
        self.assertEqual(desktopd.inside_workspace("sub"), os.path.join(WORKSPACE, "sub"))
        self.assertEqual(desktopd.inside_workspace(WORKSPACE), WORKSPACE)
        # The service's name for the workspace is /workspace, wherever it is kept.
        self.assertEqual(desktopd.inside_workspace("/workspace"), WORKSPACE)
        self.assertEqual(desktopd.inside_workspace("/workspace/sub"), os.path.join(WORKSPACE, "sub"))
        for bad in ("../outside", "/etc", "sub/../../x", "missing", "a\x00b", "/workspace/../x", "/workspacex"):
            with self.subTest(path=bad):
                with self.assertRaises(ValueError):
                    desktopd.inside_workspace(bad)

    def test_exit_codes_and_output(self):
        done = desktopd.run_command("echo ok; echo err >&2; exit 3", WORKSPACE, 10)
        self.assertEqual((done["stdout"], done["stderr"], done["exitCode"]), ("ok\n", "err\n", 3))
        self.assertFalse(done["timedOut"])
        self.assertEqual(desktopd.run_command("pwd", WORKSPACE, 10)["stdout"].strip(), WORKSPACE)

    def test_a_command_past_its_limit_is_killed_with_its_children(self):
        started = time.time()
        done = desktopd.run_command("sleep 30 & sleep 30", WORKSPACE, 1)
        self.assertTrue(done["timedOut"])
        self.assertIsNone(done["exitCode"])
        self.assertLess(time.time() - started, 10)

    def test_output_is_capped_and_says_so(self):
        done = desktopd.run_command("head -c 200000 /dev/zero | tr '\\0' x", WORKSPACE, 10)
        self.assertEqual(len(done["stdout"]), desktopd.OUTPUT_LIMIT)
        self.assertTrue(done["truncated"])

    def test_no_stdin_and_a_clean_environment(self):
        self.assertEqual(desktopd.run_command("cat; echo done", WORKSPACE, 10)["stdout"], "done\n")
        env = desktopd.run_command("env", WORKSPACE, 10)["stdout"]
        self.assertIn(f"HOME={WORKSPACE}", env)
        self.assertNotIn("DESKTOP_TOKEN", env)


class Door(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        desktopd.TOKEN = "k" * 48
        cls.server = desktopd.ThreadingHTTPServer(("127.0.0.1", 0), desktopd.Handler)
        cls.server.daemon_threads = True
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def test_health_needs_no_token_everything_else_does(self):
        self.assertEqual(call(self.base, None, "GET", "/health"), (200, {"ok": True}))
        self.assertEqual(call(self.base, None, "GET", "/state")[0], 401)
        self.assertEqual(call(self.base, "wrong" * 10, "GET", "/state")[0], 401)
        self.assertEqual(call(self.base, None, "POST", "/exec", {"command": "echo hi"})[0], 401)
        self.assertEqual(call(self.base, "k" * 48, "GET", "/state")[0], 200)

    def test_a_request_with_an_origin_is_refused_even_with_the_token(self):
        status, body = call(self.base, "k" * 48, "POST", "/exec", {"command": "echo hi"}, {"Origin": "http://evil.example"})
        self.assertEqual(status, 403)
        self.assertNotIn("stdout", body)

    def test_state_of_a_stopped_desktop(self):
        status, state = call(self.base, "k" * 48, "GET", "/state")
        self.assertEqual(status, 200)
        self.assertEqual(state["desktop"], "stopped")
        self.assertIsNone(state["live"])

    def test_exec(self):
        status, done = call(self.base, "k" * 48, "POST", "/exec", {"command": "echo $((6*7))", "cwd": "/workspace", "timeout": 5})
        self.assertEqual((status, done["stdout"].strip(), done["exitCode"]), (200, "42", 0))

    def test_exec_refuses_bad_requests(self):
        token = "k" * 48
        for body in ({}, {"command": "  "}, {"command": 5}, {"command": "x" * 16001}, {"command": "ls", "cwd": "/etc"}, {"command": "ls", "cwd": "../.."}):
            with self.subTest(body=str(body)[:40]):
                self.assertEqual(call(self.base, token, "POST", "/exec", body)[0], 400)
        request = urllib.request.Request(self.base + "/exec", method="POST", data=b"{not json")
        request.add_header("Authorization", f"Bearer {token}")
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(request, timeout=10)
        with caught.exception:
            self.assertEqual(caught.exception.code, 400)

    def test_timeout_is_capped(self):
        started = time.time()
        status, done = call(self.base, "k" * 48, "POST", "/exec", {"command": "sleep 20", "timeout": 1})
        self.assertEqual(status, 200)
        self.assertTrue(done["timedOut"])
        self.assertLess(time.time() - started, 10)

    def test_files_go_through_the_helper(self):
        token = "k" * 48
        status, wrote = call(self.base, token, "POST", "/files", {"operation": "write", "path": "/workspace/hello.txt", "text": "hi"})
        self.assertEqual(status, 200, wrote)
        status, read = call(self.base, token, "POST", "/files", {"operation": "read", "path": "/workspace/hello.txt"})
        self.assertEqual(read["result"]["text"], "hi")
        with open(os.path.join(WORKSPACE, "hello.txt")) as source:
            self.assertEqual(source.read(), "hi")
        status, refused = call(self.base, token, "POST", "/files", {"operation": "read", "path": "/etc/passwd"})
        self.assertEqual(status, 200)
        self.assertIn("error", refused)

    def test_a_desktop_that_cannot_start_says_so_and_the_browser_needs_one(self):
        token = "k" * 48
        status, body = call(self.base, token, "POST", "/start", {})
        self.assertEqual(status, 500)
        self.assertIn("without a desktop", body["error"])
        status, body = call(self.base, token, "POST", "/browser", {"action": "read"})
        self.assertEqual(status, 500)
        self.assertIn("not running", body["error"])
        status, body = call(self.base, token, "POST", "/screenshot", {})
        self.assertEqual(status, 400)
        self.assertEqual(call(self.base, token, "POST", "/nothing", {})[0], 404)

    def test_stop_with_nothing_running_is_fine(self):
        status, state = call(self.base, "k" * 48, "POST", "/stop", {})
        self.assertEqual((status, state["desktop"]), (200, "stopped"))

    def test_desktop_apps_need_a_running_desktop(self):
        status, body = call(self.base, "k" * 48, "POST", "/desktop", {"action": "apps"})
        self.assertEqual(status, 400)
        self.assertIn("not running", body["error"])

    def test_the_pointer_clicks_nothing_when_another_desktop_step_holds_the_screen(self):
        token = "k" * 48
        wait = desktopd.POINTER_LOCK_WAIT
        desktopd.POINTER_LOCK_WAIT = 0.2
        desktopd.DESKTOP_LOCK.acquire()
        try:
            status, body = call(self.base, token, "POST", "/pointer", {"action": "click", "x": 20, "y": 1})
            self.assertEqual(status, 400)
            self.assertIn("nothing was clicked", body["error"])
        finally:
            desktopd.DESKTOP_LOCK.release()
            desktopd.POINTER_LOCK_WAIT = wait

    def test_the_pointer_refuses_a_point_off_the_grid_and_needs_a_running_desktop(self):
        token = "k" * 48
        status, body = call(self.base, token, "POST", "/pointer", {"action": "click", "x": 2000, "y": 1})
        self.assertEqual(status, 400)
        self.assertIn("grid", body["error"])
        status, body = call(self.base, token, "POST", "/pointer", {"action": "click", "x": 20, "y": 1})
        self.assertEqual(status, 400)
        self.assertIn("not running", body["error"])


class Browser(unittest.TestCase):
    def test_the_browser_is_started_for_the_container_and_pointed_at_one_profile(self):
        argv = desktopd.browser_argv(["about:blank"])
        self.assertIn("--remote-debugging-address=127.0.0.1", argv)
        self.assertIn(f"--user-data-dir={WORKSPACE}/.config/yuki-browser", argv)
        self.assertIn("--no-sandbox", argv)
        self.assertEqual(argv[-1], "about:blank")

    def test_actions_are_checked_before_a_page_is_touched(self):
        # An address that is not http(s) or an unknown action fails before any DevTools call.
        class Stop(Exception):
            pass

        class FakePage:
            def __init__(self):
                self.calls = []

            def call(self, method, params=None, timeout=20):
                self.calls.append(method)
                return {}

            def evaluate(self, expression):
                self.calls.append("evaluate")
                return {"url": "u", "title": "t", "text": "x"}

            def settle(self, seconds=15):
                pass

            def close(self):
                pass

        original = desktopd.Page
        pages = []
        desktopd.Page = lambda: pages.append(FakePage()) or pages[-1]
        try:
            for body in ({"action": "open", "url": "file:///etc/passwd"}, {"action": "open", "url": "javascript:1"}, {"action": "nope"}, {"action": "press", "key": "F12"}):
                with self.subTest(body=body):
                    with self.assertRaises(ValueError):
                        desktopd.browser_action(body)
            self.assertTrue(all(page.calls == [] for page in pages))
            page = desktopd.browser_action({"action": "open", "url": "https://example.com"})
            self.assertEqual(page["title"], "t")
            self.assertIn("Page.navigate", pages[-1].calls)
        finally:
            desktopd.Page = original


class PointerOnTheGrid(unittest.TestCase):
    """v1.7.5 (/pointer): a member gives a point of the 0..1000 grid over the screenshot (the way
    vision models give positions); the pointer goes to that point in screen pixels."""

    def test_grid_points_land_where_they_are_on_the_picture(self):
        size = (1280, 800)
        self.assertEqual(desktopd.grid_point(0, 0, size), (0, 0))
        self.assertEqual(desktopd.grid_point(500, 500, size), (640, 400))
        # What a model said for a button drawn at 1180,90 on a 1280x800 picture.
        self.assertEqual(desktopd.grid_point(922, 112, size), (1180, 90))
        self.assertEqual(desktopd.grid_point(166.4, 200, size), (213, 160))
        # The far edge stays on the screen.
        self.assertEqual(desktopd.grid_point(1000, 1000, size), (1279, 799))

    def test_points_off_the_grid_or_not_numbers_are_refused(self):
        for x, y in ((-1, 10), (10, 1001), ("5", 5), (None, 5), (True, 5), (float("nan"), 5)):
            with self.assertRaises(ValueError, msg=(x, y)):
                desktopd.grid_point(x, y, (1280, 800))

    def test_actions_are_checked_before_the_pointer_moves(self):
        for body in (
            {"action": "drag", "x": 1, "y": 1},
            {"action": "click"},
            {"action": "scroll", "x": 5, "y": 5},
            {"action": "scroll", "x": 5, "y": 5, "direction": "left"},
            {"action": "scroll", "x": 5, "y": 5, "direction": "down", "amount": 0},
            {"action": "scroll", "x": 5, "y": 5, "direction": "down", "amount": 2.5},
        ):
            with self.assertRaises(ValueError, msg=body):
                desktopd.pointer_argv(body)

    def test_the_xdotool_words_for_each_action(self):
        at = {"x": 500, "y": 500}
        self.assertEqual(
            desktopd.pointer_argv({"action": "click", **at})[0],
            ["xdotool", "mousemove", "640", "400", "click", "1"],
        )
        self.assertEqual(
            desktopd.pointer_argv({"action": "right_click", **at})[0][-2:], ["click", "3"]
        )
        self.assertIn("--repeat", desktopd.pointer_argv({"action": "double_click", **at})[0])
        self.assertEqual(
            desktopd.pointer_argv({"action": "scroll", "direction": "down", "amount": 4, **at})[0][-6:],
            ["click", "--repeat", "4", "--delay", "60", "5"],
        )
        self.assertEqual(desktopd.pointer_argv({"action": "move", **at})[0], ["xdotool", "mousemove", "640", "400"])


class DesktopApps(unittest.TestCase):
    """The desktop's apps (/desktop): checked here, read and used by apps.py on a running desktop."""

    def setUp(self):
        self.requests = []
        self.original = desktopd.run_apps

        def fake(request, timeout=45):
            self.requests.append(request)
            return {
                "app": "mousepad",
                "elements": [{"n": 1, "role": "menu", "name": "File"}, {"n": 2, "role": "text", "name": ""}],
            }

        desktopd.run_apps = fake

    def tearDown(self):
        desktopd.run_apps = self.original

    def test_actions_are_checked_before_any_app_is_touched(self):
        for body in (
            {"action": "nope"},
            {"action": "look"},
            {"action": "look", "app": "  "},
            {"action": "open", "app": "chromium"},
            {"action": "click", "snapshot": "gone", "n": 1},
            {"action": "press"},
        ):
            with self.assertRaises(ValueError, msg=body):
                desktopd.desktop_action(body)
        self.assertEqual(self.requests, [])

    def test_a_look_is_remembered_and_its_numbers_checked(self):
        key = desktopd.desktop_action({"action": "look", "app": "mousepad"})["snapshot"]
        for body in (
            {"action": "click", "snapshot": key, "n": 3},
            {"action": "click", "snapshot": key, "n": True},
            {"action": "type", "snapshot": key, "n": 2},
        ):
            with self.assertRaises(ValueError, msg=body):
                desktopd.desktop_action(body)
        desktopd.desktop_action({"action": "type", "snapshot": key, "n": 2, "text": "hi"})
        self.assertEqual(
            self.requests[-1],
            {"op": "type", "app": "mousepad", "n": 2, "expect": {"role": "text", "name": ""}, "text": "hi"},
        )
        # Only the newest looks keep their numbers.
        for _ in range(desktopd.KEPT_SNAPSHOTS):
            desktopd.desktop_action({"action": "look", "app": "mousepad"})
        with self.assertRaises(ValueError):
            desktopd.desktop_action({"action": "click", "snapshot": key, "n": 1})

    def test_apps_that_ended_are_collected_and_running_ones_kept(self):
        session = desktopd.Session()
        ended = session.helper(["true"], "test-ended")
        running = session.helper(["sleep", "30"], "test-running")
        try:
            deadline = time.time() + 5
            while ended.poll() is None and time.time() < deadline:
                time.sleep(0.05)
            session.reap()
            self.assertEqual(session.helpers, [running])
        finally:
            running.kill()
            running.wait()

    def test_a_file_or_folder_to_open_stays_inside_the_workspace(self):
        os.makedirs(os.path.join(WORKSPACE, "notes"), exist_ok=True)
        self.assertEqual(
            desktopd.workspace_item("/workspace/notes/a.txt", "file"), os.path.join(WORKSPACE, "notes", "a.txt")
        )
        self.assertEqual(desktopd.workspace_item("notes", "folder"), os.path.join(WORKSPACE, "notes"))
        for path, kind in (
            ("/etc/passwd", "file"),
            ("../x.txt", "file"),
            ("/workspace/missing/a.txt", "file"),
            ("/workspace/notes/..", "file"),
            ("/tmp", "folder"),
            ("", "file"),
        ):
            with self.assertRaises(ValueError, msg=path):
                desktopd.workspace_item(path, kind)


class ZoneAndRestore(unittest.TestCase):
    """v1.5.1: the desktop's clock follows the account's zone; a paused browser comes back clean."""

    def setUp(self):
        self.zones = tempfile.mkdtemp()
        for name in ("Asia/Shanghai", "UTC"):
            os.makedirs(os.path.dirname(os.path.join(self.zones, name)), exist_ok=True)
            open(os.path.join(self.zones, name), "w").close()
        self.saved = (desktopd.ZONEINFO, desktopd.SESSION_ZONE)
        desktopd.ZONEINFO = self.zones

    def tearDown(self):
        desktopd.ZONEINFO, desktopd.SESSION_ZONE = self.saved
        shutil.rmtree(self.zones, ignore_errors=True)

    def test_a_zone_the_system_knows_is_taken_others_are_not(self):
        self.assertEqual(desktopd.valid_zone("Asia/Shanghai"), "Asia/Shanghai")
        self.assertEqual(desktopd.valid_zone("UTC"), "UTC")
        for bad in ("Asia/Nowhere", "../etc/passwd", "/etc/passwd", "Asia/../UTC", "", 8, None):
            self.assertEqual(desktopd.valid_zone(bad), "", bad)

    def test_start_reads_the_zone_from_its_body(self):
        self.assertEqual(desktopd.start_zone(b'{"timezone": "Asia/Shanghai"}'), "Asia/Shanghai")
        for raw in (b"", b"{}", b"not json", b'["Asia/Shanghai"]', b'{"timezone": "Mars/Base"}'):
            self.assertEqual(desktopd.start_zone(raw), "", raw)

    def test_the_session_runs_in_the_zone(self):
        desktopd.SESSION_ZONE = "Asia/Shanghai"
        self.assertEqual(desktopd.session_env()["TZ"], "Asia/Shanghai")
        desktopd.SESSION_ZONE = ""
        self.assertEqual(desktopd.session_env()["TZ"], os.environ.get("TZ", "UTC"))

    def test_a_browser_ended_with_the_desktop_starts_without_restore_pages(self):
        self.assertIn("--hide-crash-restore-bubble", desktopd.browser_argv(["about:blank"]))
        folder = os.path.join(WORKSPACE, ".config", "yuki-browser", "Default")
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, "Preferences")
        with open(path, "w") as target:
            json.dump({"profile": {"exit_type": "Crashed", "exited_cleanly": False}, "kept": 1}, target)
        desktopd.mark_browser_closed_cleanly()
        with open(path) as source:
            prefs = json.load(source)
        self.assertEqual(prefs["profile"], {"exit_type": "Normal", "exited_cleanly": True})
        self.assertEqual(prefs["kept"], 1)
        # A profile it cannot read is left as it is; no profile at all is fine.
        with open(path, "w") as target:
            target.write("{not json")
        desktopd.mark_browser_closed_cleanly()
        with open(path) as source:
            self.assertEqual(source.read(), "{not json")
        os.remove(path)
        desktopd.mark_browser_closed_cleanly()


if __name__ == "__main__":
    unittest.main()
