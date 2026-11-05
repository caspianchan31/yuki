#!/usr/bin/env python3
"""The members' computer's files helper (files.py): a fixed JSON filesystem API inside /workspace.
It never follows a symlink, never leaves the workspace, keeps text files to 256 KB and PDFs to
10 MB, and replaces a file whole or not at all. The tests run the helper as the container does
(a subprocess reading the request on stdin); YUKI_FILES_ROOT stands in for /workspace."""
import base64
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.join(HERE, "files.py")


def read_text(path):
    with open(path) as source:
        return source.read()


def write_text(path, text):
    with open(path, "w") as target:
        target.write(text)


class FilesHelper(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = os.path.realpath(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def run_helper(self, request):
        process = subprocess.run(
            [sys.executable, "-I", "-B", HELPER],
            input=json.dumps(request).encode(),
            capture_output=True,
            env={"PATH": "/usr/bin:/bin", "YUKI_FILES_ROOT": self.root},
            timeout=20,
        )
        return process

    def ok(self, request):
        process = self.run_helper(request)
        self.assertEqual(process.returncode, 0, process.stderr.decode())
        return json.loads(process.stdout)

    def refused(self, request):
        process = self.run_helper(request)
        self.assertNotEqual(process.returncode, 0, "the helper should have refused")
        return process.stderr.decode()

    def test_write_read_list_mkdir(self):
        self.ok({"operation": "mkdir", "path": "/workspace/notes/2026"})
        self.assertTrue(os.path.isdir(os.path.join(self.root, "notes", "2026")))
        wrote = self.ok({"operation": "write", "path": "/workspace/notes/a.txt", "text": "héllo"})
        self.assertEqual(wrote["path"], "/workspace/notes/a.txt")
        read = self.ok({"operation": "read", "path": "/workspace/notes/a.txt"})
        self.assertEqual(read["text"], "héllo")
        listing = self.ok({"operation": "list", "path": "/workspace/notes"})
        # Directories first, then files by name.
        self.assertEqual([e["name"] for e in listing["entries"]], ["2026", "a.txt"])
        self.assertEqual(listing["entries"][0]["type"], "directory")
        self.assertEqual(listing["entries"][1]["size"], len("héllo".encode()))

    def test_write_replaces_whole_and_leaves_no_temporary_file(self):
        self.ok({"operation": "write", "path": "/workspace/a.txt", "text": "one"})
        self.ok({"operation": "write", "path": "/workspace/a.txt", "text": "two"})
        self.assertEqual(read_text(os.path.join(self.root, "a.txt")), "two")
        self.assertEqual(os.listdir(self.root), ["a.txt"])

    def test_paths_outside_the_workspace_are_refused(self):
        for path in ("/etc/passwd", "/workspace/../etc/passwd", "workspace/a", "/workspace/a/../../b", "/workspacex/a"):
            with self.subTest(path=path):
                self.refused({"operation": "read", "path": path})
        self.refused({"operation": "read", "path": "/workspace/a\x00b"})

    def test_symlinks_are_never_followed(self):
        outside = tempfile.TemporaryDirectory()
        self.addCleanup(outside.cleanup)
        secret = os.path.join(outside.name, "secret.txt")
        write_text(secret, "do not read")
        os.symlink(secret, os.path.join(self.root, "link.txt"))
        os.symlink(outside.name, os.path.join(self.root, "dir-link"))
        self.refused({"operation": "read", "path": "/workspace/link.txt"})
        self.refused({"operation": "read", "path": "/workspace/dir-link/secret.txt"})
        self.refused({"operation": "list", "path": "/workspace/dir-link"})
        self.refused({"operation": "write", "path": "/workspace/dir-link/new.txt", "text": "x"})
        self.refused({"operation": "mkdir", "path": "/workspace/dir-link/sub"})
        # A symlink in place of the file is not replaced, and what it points at is not written.
        self.refused({"operation": "write", "path": "/workspace/link.txt", "text": "x"})
        self.assertEqual(read_text(secret), "do not read")
        listing = self.ok({"operation": "list", "path": "/workspace"})
        self.assertEqual({e["type"] for e in listing["entries"]}, {"symlink"})

    def test_size_limits(self):
        big = "x" * (256 * 1024 + 1)
        self.refused({"operation": "write", "path": "/workspace/big.txt", "text": big})
        self.ok({"operation": "write", "path": "/workspace/max.txt", "text": "x" * (256 * 1024)})
        write_text(os.path.join(self.root, "grown.txt"), big)
        self.refused({"operation": "read", "path": "/workspace/grown.txt"})

    def test_pdf_round_trip_and_checks(self):
        pdf = b"%PDF-1.4\n%fake\n"
        body = base64.b64encode(pdf).decode()
        self.ok({"operation": "write_pdf", "path": "/workspace/doc.pdf", "base64": body})
        read = self.ok({"operation": "read_pdf", "path": "/workspace/doc.pdf"})
        self.assertEqual(base64.b64decode(read["base64"]), pdf)
        self.refused({"operation": "write_pdf", "path": "/workspace/no.pdf", "base64": base64.b64encode(b"not a pdf").decode()})
        self.ok({"operation": "write", "path": "/workspace/text.txt", "text": "plain"})
        self.refused({"operation": "read_pdf", "path": "/workspace/text.txt"})

    def test_special_files_and_odd_requests(self):
        os.mkfifo(os.path.join(self.root, "pipe"))
        self.refused({"operation": "read", "path": "/workspace/pipe"})
        self.refused({"operation": "write", "path": "/workspace/pipe", "text": "x"})
        self.refused({"operation": "read", "path": "/workspace"})
        self.refused({"operation": "delete", "path": "/workspace/a"})
        self.refused({"path": "/workspace/a"})
        self.assertTrue(self.run_helper({"operation": "read", "path": 5}).returncode != 0)

    def test_directory_of_too_many_entries_is_refused(self):
        for index in range(1001):
            write_text(os.path.join(self.root, f"f{index}"), "")
        self.refused({"operation": "list", "path": "/workspace"})


if __name__ == "__main__":
    unittest.main()
