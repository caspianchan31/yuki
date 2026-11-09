// The members' computer's Python (apps/desktop): the files helper keeps every path inside
// /workspace and follows no symlink, and the control agent answers only with the token, runs
// commands in /workspace within their limit, and refuses a request that carries an Origin.
// Needs only python3 (no X server, browser or VNC). OPENMUSE_TEST_PYTHON names the Python to use.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function runPython(t: { skip(reason: string): void }, file: string, count: number) {
  const named = process.env.OPENMUSE_TEST_PYTHON;
  const python = named || "python3";
  // -B: no __pycache__ left in the worktree.
  const run = spawnSync(python, ["-I", "-B", `${root}apps/desktop/${file}`, "-v"], {
    encoding: "utf8",
    timeout: 120_000,
  });
  if (run.error) {
    assert.ok(!named, `OPENMUSE_TEST_PYTHON (${named}) could not be run`);
    t.skip(`${python} is not available here`);
    return;
  }
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, new RegExp(`Ran ${count} tests`));
  assert.match(run.stderr, /\nOK\n/);
}

test("the computer's files helper stays inside /workspace and follows no symlink", (t) => {
  runPython(t, "test_files.py", 13);
});

test("the computer's control agent needs the token, refuses an Origin and bounds commands", (t) => {
  runPython(t, "test_desktopd.py", 28);
});

test("the computer's desktop apps helper names keys, finds an element again and answers in JSON", (t) => {
  runPython(t, "test_apps.py", 5);
});
