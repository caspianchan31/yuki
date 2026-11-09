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

    # ── v1.6: the person's file page ──

    def test_bytes_round_trip_any_kind_within_10mb(self):
        png = b"\x89PNG\r\n\x1a\n" + bytes(range(256))
        self.ok({"operation": "write_bytes", "path": "/workspace/pic.png", "base64": base64.b64encode(png).decode()})
        read = self.ok({"operation": "read_bytes", "path": "/workspace/pic.png"})
        self.assertEqual(base64.b64decode(read["base64"]), png)
        self.assertEqual(read["size"], len(png))
        # A text file written by a member reads as bytes too; a 256 KB+ one reads only as bytes.
        write_text(os.path.join(self.root, "big.txt"), "x" * (256 * 1024 + 1))
        self.refused({"operation": "read", "path": "/workspace/big.txt"})
        self.assertEqual(self.ok({"operation": "read_bytes", "path": "/workspace/big.txt"})["size"], 256 * 1024 + 1)
        too_big = base64.b64encode(b"\0" * (10 * 1024 * 1024 + 1)).decode()
        self.refused({"operation": "write_bytes", "path": "/workspace/huge.bin", "base64": too_big})
        self.refused({"operation": "write_bytes", "path": "/workspace/bad.bin", "base64": "not base64!"})

    def test_rename_moves_within_the_workspace_and_never_over_something(self):
        self.ok({"operation": "mkdir", "path": "/workspace/成品"})
        self.ok({"operation": "write", "path": "/workspace/a.txt", "text": "a"})
        self.ok({"operation": "write", "path": "/workspace/b.txt", "text": "b"})
        moved = self.ok({"operation": "rename", "path": "/workspace/a.txt", "to": "/workspace/成品/报告.txt"})
        self.assertEqual(moved["path"], "/workspace/成品/报告.txt")
        self.assertEqual(read_text(os.path.join(self.root, "成品", "报告.txt")), "a")
        self.assertFalse(os.path.exists(os.path.join(self.root, "a.txt")))
        # Not over an existing file, not out of the workspace, not a missing source, not a folder
        # into itself, not into the recycle bin.
        self.refused({"operation": "rename", "path": "/workspace/成品/报告.txt", "to": "/workspace/b.txt"})
        self.refused({"operation": "rename", "path": "/workspace/b.txt", "to": "/tmp/b.txt"})
        self.refused({"operation": "rename", "path": "/workspace/none.txt", "to": "/workspace/c.txt"})
        self.refused({"operation": "rename", "path": "/workspace/成品", "to": "/workspace/成品/inner"})
        self.refused({"operation": "rename", "path": "/workspace/b.txt", "to": "/workspace/.trash/b.txt"})
        self.assertEqual(read_text(os.path.join(self.root, "b.txt")), "b")
        # A folder renames with its contents.
        self.ok({"operation": "rename", "path": "/workspace/成品", "to": "/workspace/done"})
        self.assertEqual(read_text(os.path.join(self.root, "done", "报告.txt")), "a")

    def test_delete_goes_to_the_recycle_bin_and_comes_back(self):
        self.ok({"operation": "mkdir", "path": "/workspace/收到/深"})
        self.ok({"operation": "write", "path": "/workspace/收到/深/x.txt", "text": "keep me"})
        self.ok({"operation": "write", "path": "/workspace/收到/y.txt", "text": "y"})
        gone = self.ok({"operation": "delete", "path": "/workspace/收到/深"})
        self.assertRegex(gone["id"], r"^[0-9]{14}-[0-9a-f]{8}$")
        self.assertFalse(os.path.exists(os.path.join(self.root, "收到", "深")))
        # The bin is hidden from a listing, is no folder to work in, and lists what it holds.
        self.assertEqual([e["name"] for e in self.ok({"operation": "list", "path": "/workspace"})["entries"]], ["收到"])
        self.refused({"operation": "list", "path": "/workspace/.trash"})
        self.refused({"operation": "read", "path": "/workspace/.trash/" + gone["id"] + "/meta.json"})
        self.refused({"operation": "delete", "path": "/workspace/.trash"})
        self.refused({"operation": "delete", "path": "/workspace"})
        listing = self.ok({"operation": "trash_list", "path": ""})
        self.assertEqual(listing["days"], 30)
        self.assertEqual([(e["id"], e["path"], e["type"]) for e in listing["entries"]], [(gone["id"], "/workspace/收到/深", "directory")])
        # Restored where it was, with everything inside; the entry is gone from the bin.
        back = self.ok({"operation": "restore", "id": gone["id"]})
        self.assertEqual(back["path"], "/workspace/收到/深")
        self.assertEqual(read_text(os.path.join(self.root, "收到", "深", "x.txt")), "keep me")
        self.assertEqual(self.ok({"operation": "trash_list"})["entries"], [])
        self.refused({"operation": "restore", "id": gone["id"]})
        # A file deleted, its folder deleted too, then restored: the folder is made again. Restored
        # beside a newer file of the same name, it gets a numbered name.
        first = self.ok({"operation": "delete", "path": "/workspace/收到/y.txt"})["id"]
        self.ok({"operation": "write", "path": "/workspace/收到/y.txt", "text": "newer"})
        self.assertEqual(self.ok({"operation": "restore", "id": first})["path"], "/workspace/收到/y (2).txt")
        self.assertEqual(read_text(os.path.join(self.root, "收到", "y.txt")), "newer")
        second = self.ok({"operation": "delete", "path": "/workspace/收到/y (2).txt"})["id"]
        self.ok({"operation": "delete", "path": "/workspace/收到"})
        self.assertEqual(self.ok({"operation": "restore", "id": second})["path"], "/workspace/收到/y (2).txt")
        self.assertEqual(os.listdir(os.path.join(self.root, "收到")), ["y (2).txt"])
        # Deleted for good, and bad ids name nothing.
        entry = self.ok({"operation": "trash_list"})["entries"][0]
        self.ok({"operation": "trash_delete", "id": entry["id"]})
        self.assertEqual(self.ok({"operation": "trash_list"})["entries"], [])
        for bad in ("../../etc", "x", "20260101000000-zzzzzzzz", 5):
            self.refused({"operation": "trash_delete", "id": bad})
            self.refused({"operation": "restore", "id": bad})

    def test_the_recycle_bin_clears_itself_after_thirty_days(self):
        self.ok({"operation": "write", "path": "/workspace/old.txt", "text": "old"})
        self.ok({"operation": "write", "path": "/workspace/new.txt", "text": "new"})
        old = self.ok({"operation": "delete", "path": "/workspace/old.txt"})["id"]
        new = self.ok({"operation": "delete", "path": "/workspace/new.txt"})["id"]
        meta_path = os.path.join(self.root, ".trash", old, "meta.json")
        meta = json.loads(read_text(meta_path))
        meta["deletedAtSeconds"] -= 31 * 24 * 3600
        write_text(meta_path, json.dumps(meta))
        self.assertEqual([e["id"] for e in self.ok({"operation": "trash_list"})["entries"]], [new])
        self.assertFalse(os.path.exists(os.path.join(self.root, ".trash", old)))
        # A deleted symlink is moved as a link and never followed.
        outside = tempfile.TemporaryDirectory()
        self.addCleanup(outside.cleanup)
        write_text(os.path.join(outside.name, "secret.txt"), "safe")
        os.symlink(outside.name, os.path.join(self.root, "link"))
        self.ok({"operation": "delete", "path": "/workspace/link"})
        self.assertEqual(read_text(os.path.join(outside.name, "secret.txt")), "safe")
        entry = self.ok({"operation": "trash_list"})["entries"][0]
        self.assertEqual(entry["type"], "symlink")
        self.ok({"operation": "trash_delete", "id": entry["id"]})
        self.assertEqual(read_text(os.path.join(outside.name, "secret.txt")), "safe")

    def test_tree_lists_everything_but_the_bin_and_links(self):
        self.ok({"operation": "mkdir", "path": "/workspace/成品/子"})
        self.ok({"operation": "write", "path": "/workspace/成品/子/深.md", "text": "#"})
        self.ok({"operation": "write", "path": "/workspace/收.txt", "text": "r"})
        self.ok({"operation": "write", "path": "/workspace/gone.txt", "text": "g"})
        self.ok({"operation": "delete", "path": "/workspace/gone.txt"})
        os.symlink("/etc", os.path.join(self.root, "etc-link"))
        found = self.ok({"operation": "tree"})
        self.assertFalse(found["truncated"])
        self.assertEqual([e["path"] for e in found["entries"]], ["/workspace/成品", "/workspace/成品/子", "/workspace/成品/子/深.md", "/workspace/收.txt"])
        self.assertEqual(found["entries"][2]["type"], "file")
        self.assertIn("modified", found["entries"][2])


if __name__ == "__main__":
    unittest.main()
