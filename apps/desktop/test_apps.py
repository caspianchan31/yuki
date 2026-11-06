#!/usr/bin/env python3
"""The desktop apps helper (apps.py): the keys and combinations a member may name, the action that
presses an element, the check that an element found again is the one a look numbered, and its JSON
door. No desktop is needed: reading apps needs the accessibility bus of a running desktop, which the
computer container test (workflows/computer-container/smoke-155.sh) exercises."""
import json
import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import apps  # noqa: E402


class Keys(unittest.TestCase):
    def test_names_and_combinations_as_xdotool_reads_them(self):
        self.assertEqual(apps.parse_key("Enter"), "Return")
        self.assertEqual(apps.parse_key("esc"), "Escape")
        self.assertEqual(apps.parse_key("ctrl+s"), "ctrl+s")
        self.assertEqual(apps.parse_key("Ctrl+Shift+T"), "ctrl+shift+t")
        self.assertEqual(apps.parse_key("control+PageDown"), "ctrl+Next")
        self.assertEqual(apps.parse_key("F5"), "F5")
        self.assertEqual(apps.parse_key("A"), "A")

    def test_anything_else_is_refused(self):
        for bad in ("", "  ", "ctrl+", "hyper+s", "ctrl+/", "a+b+c+d+e", "Enterr", "x" * 41, None, 3):
            with self.assertRaises(ValueError, msg=repr(bad)):
                apps.parse_key(bad)


class Elements(unittest.TestCase):
    def test_the_action_that_presses_comes_first(self):
        self.assertEqual(apps.pick_action(["showContextMenu", "press"]), 1)
        self.assertEqual(apps.pick_action(["Click"]), 0)
        self.assertEqual(apps.pick_action(["expand or contract", "activate"]), 1)
        self.assertEqual(apps.pick_action(["something"]), 0)

    def test_an_element_is_found_again_only_with_the_same_role_and_name(self):
        save = {"role": "push button", "name": "Save"}
        self.assertTrue(apps.same({"n": 3, **save}, save))
        self.assertFalse(apps.same({"role": "push button", "name": "Save As"}, save))
        self.assertFalse(apps.same({"role": "menu item", "name": "Save"}, save))
        self.assertFalse(apps.same(save, {}))


class Door(unittest.TestCase):
    def ask(self, request):
        run = subprocess.run(
            [sys.executable, "-I", "-B", os.path.join(HERE, "apps.py")],
            input=json.dumps(request).encode(),
            capture_output=True,
            timeout=30,
        )
        return run.returncode, json.loads(run.stdout.decode() or "{}")

    def test_a_wrong_request_is_answered_before_the_desktop_is_touched(self):
        # Neither needs the accessibility bus: an unknown action, and a key that is not one.
        self.assertEqual(self.ask({"op": "nope"}), (0, {"error": "Unknown desktop action"}))
        code, reply = self.ask({"op": "press", "key": "hyper+s"})
        self.assertEqual(code, 0)
        self.assertIn("Unknown modifier", reply["error"])


if __name__ == "__main__":
    unittest.main()
