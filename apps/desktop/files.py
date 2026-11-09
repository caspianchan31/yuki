"""The files helper of the members' computer: a fixed stdin JSON filesystem API inside /workspace;
every opened component rejects symlinks.

Operations (request = {"operation", "path", ...}; the reply is one JSON line on stdout):
  list, read, write, mkdir, read_pdf, write_pdf        since v1.5 (the members' file tools)
  read_bytes, write_bytes                               v1.6: any file up to 10 MB, base64 (the
                                                        person's downloads and uploads)
  rename {path, to}                                     v1.6: a file or folder moved or renamed
  delete {path} -> {id}                                 v1.6: into the recycle bin (/workspace/.trash)
  trash_list, restore {id}, trash_delete {id}           v1.6: the recycle bin; entries older than
                                                        TRASH_DAYS are cleared when it is read
  tree                                                  v1.6: every file and folder, for a search
The recycle bin itself is never a path to work in: no operation accepts /workspace/.trash."""
import base64
import json
import os
import re
import shutil
import stat
import sys
import time
import uuid

LIMIT = 256 * 1024
BYTES_LIMIT = 10 * 1024 * 1024
TREE_LIMIT = 5000
TRASH = ".trash"
TRASH_DAYS = 30
TRASH_ID = re.compile(r"^[0-9]{14}-[0-9a-f]{8}$")
# The workspace; only the tests keep it elsewhere (paths in requests still start with /workspace).
ROOT = os.environ.get("YUKI_FILES_ROOT", "/workspace")
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK


def parse_path(path):
    """The components of a /workspace path, checked; [] is the workspace itself."""
    if not isinstance(path, str) or "\x00" in path or ".." in path.split("/"):
        raise ValueError("Invalid workspace path")
    parts = path.split("/")
    if parts[:2] != ["", "workspace"]:
        raise ValueError("Path must be inside /workspace")
    parts = [part for part in parts[2:] if part and part != "."]
    if parts[:1] == [TRASH]:
        raise ValueError("The recycle bin is not a folder to work in")
    return parts


def joined(parts):
    return "/workspace" + ("/" + "/".join(parts) if parts else "")


def open_dir(parts, make=False):
    """A descriptor of the directory `parts` names, walked one component at a time without ever
    following a symlink; `make` creates the missing ones (0700)."""
    directory = os.open(ROOT, DIRECTORY_FLAGS)
    try:
        for part in parts:
            if make:
                try:
                    os.mkdir(part, mode=0o700, dir_fd=directory)
                except FileExistsError:
                    pass
            child = os.open(part, DIRECTORY_FLAGS, dir_fd=directory)
            os.close(directory)
            directory = child
        return directory
    except BaseException:
        os.close(directory)
        raise


def iso(seconds):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(seconds))


def kind_of(info):
    if stat.S_ISLNK(info.st_mode):
        return "symlink"
    return "directory" if stat.S_ISDIR(info.st_mode) else "file"


def entry_of(path, name, info):
    return {"name": name, "path": path, "type": kind_of(info), "size": info.st_size, "modified": iso(info.st_mtime)}


def exists(name, dir_fd):
    try:
        os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
        return True
    except FileNotFoundError:
        return False


def write_whole(directory, name, content):
    """Replaces `name` in `directory` whole or not at all; never a symlink or a special file."""
    try:
        info = os.stat(name, dir_fd=directory, follow_symlinks=False)
        if not stat.S_ISREG(info.st_mode):
            raise ValueError("Only regular files can be replaced")
    except FileNotFoundError:
        pass
    temporary = ".yuki-" + uuid.uuid4().hex
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
    try:
        with os.fdopen(fd, "wb") as target:
            target.write(content)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
    finally:
        try:
            os.unlink(temporary, dir_fd=directory)
        except FileNotFoundError:
            pass


def read_whole(directory, name, limit):
    fd = os.open(name, FILE_FLAGS, dir_fd=directory)
    with os.fdopen(fd, "rb") as source:
        if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
            raise ValueError("Only regular files can be read")
        content = source.read(limit + 1)
        if len(content) > limit:
            raise ValueError("File exceeds size limit")
    return content


def list_dir(parts):
    directory = open_dir(parts)
    try:
        here = joined(parts)
        entries = []
        with os.scandir(directory) as iterator:
            for entry in iterator:
                # The recycle bin and a write in progress are not the person's files.
                if (not parts and entry.name == TRASH) or entry.name.startswith(".yuki-"):
                    continue
                if len(entries) >= 1000:
                    raise ValueError("Directory exceeds 1000 entries")
                entries.append(entry_of(here + "/" + entry.name, entry.name, entry.stat(follow_symlinks=False)))
        entries.sort(key=lambda entry: (entry["type"] != "directory", entry["name"]))
        return {"path": here, "entries": entries}
    finally:
        os.close(directory)


def tree():
    """Every folder and file under the workspace (the recycle bin and symlinks left out), each
    folder's contents right after it, at most TREE_LIMIT entries."""
    out = []
    truncated = False

    def walk(directory, here):
        nonlocal truncated
        with os.scandir(directory) as iterator:
            found = sorted(iterator, key=lambda entry: entry.name)
        for entry in found:
            if (here == "/workspace" and entry.name == TRASH) or entry.name.startswith(".yuki-"):
                continue
            if len(out) >= TREE_LIMIT:
                truncated = True
                return
            info = entry.stat(follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                out.append(entry_of(here + "/" + entry.name, entry.name, info))
                child = os.open(entry.name, DIRECTORY_FLAGS, dir_fd=directory)
                try:
                    walk(child, here + "/" + entry.name)
                finally:
                    os.close(child)
            elif stat.S_ISREG(info.st_mode):
                out.append(entry_of(here + "/" + entry.name, entry.name, info))

    root = open_dir([])
    try:
        walk(root, "/workspace")
    except RecursionError:
        truncated = True
    finally:
        os.close(root)
    return {"entries": out, "truncated": truncated}


# ───────────────────────────── the recycle bin ─────────────────────────────
# /workspace/.trash/<id>/meta.json (where it came from, when) and /workspace/.trash/<id>/item (the
# file or folder itself, moved there as it was). Reading the bin clears entries older than
# TRASH_DAYS. The ids are the helper's own, so a bad id never names anything else.


def trash_path(entry_id=None):
    if entry_id is not None and not TRASH_ID.match(entry_id):
        raise ValueError("Unknown recycle bin entry")
    return os.path.join(ROOT, TRASH, *([entry_id] if entry_id else []))


def read_meta(entry_id):
    try:
        fd = os.open(os.path.join(trash_path(entry_id), "meta.json"), FILE_FLAGS)
    except FileNotFoundError:
        return None
    with os.fdopen(fd, "rb") as source:
        try:
            meta = json.loads(source.read(64 * 1024))
        except ValueError:
            return None
    return meta if isinstance(meta, dict) and isinstance(meta.get("path"), str) else None


def trash_entries():
    """The bin's entries, newest first, after clearing the old ones."""
    try:
        trash = open_dir([TRASH])
    except FileNotFoundError:
        return []
    entries = []
    cutoff = time.time() - TRASH_DAYS * 24 * 3600
    try:
        with os.scandir(trash) as iterator:
            names = sorted((entry.name for entry in iterator if entry.is_dir(follow_symlinks=False)), reverse=True)
    finally:
        os.close(trash)
    for name in names:
        if not TRASH_ID.match(name):
            continue
        meta = read_meta(name)
        if meta is None or meta.get("deletedAtSeconds", 0) < cutoff:
            shutil.rmtree(trash_path(name), ignore_errors=True)
            continue
        entries.append({"id": name, "path": meta["path"], "name": meta["name"], "type": meta["type"], "size": meta["size"], "deletedAt": meta["deletedAt"], "_at": meta.get("deletedAtSeconds", 0)})
    # Newest first by the moment of deletion (several in one second sort by it, not by the id).
    entries.sort(key=lambda entry: entry.pop("_at"), reverse=True)
    return entries


def delete(parts):
    if not parts:
        raise ValueError("Choose a file or folder")
    directory = open_dir(parts[:-1])
    try:
        name = parts[-1]
        info = os.stat(name, dir_fd=directory, follow_symlinks=False)
        now = time.time()
        entry_id = time.strftime("%Y%m%d%H%M%S", time.gmtime(now)) + "-" + uuid.uuid4().hex[:8]
        entry = open_dir([TRASH, entry_id], make=True)
        try:
            meta = {"path": joined(parts), "name": name, "type": kind_of(info), "size": info.st_size, "deletedAt": iso(now), "deletedAtSeconds": now}
            write_whole(entry, "meta.json", json.dumps(meta).encode("utf-8"))
            os.rename(name, "item", src_dir_fd=directory, dst_dir_fd=entry)
        finally:
            os.close(entry)
    finally:
        os.close(directory)
    trash_entries()
    return {"id": entry_id, "path": joined(parts), "deletedAt": meta["deletedAt"]}


def restore(entry_id):
    meta = read_meta(entry_id)
    if meta is None:
        raise ValueError("Unknown recycle bin entry")
    parts = parse_path(meta["path"])
    entry = open_dir([TRASH, entry_id])
    try:
        if not exists("item", entry):
            raise ValueError("Unknown recycle bin entry")
        directory = open_dir(parts[:-1], make=True)
        try:
            name = parts[-1]
            if exists(name, directory):
                # Something took the place meanwhile: the restored one gets a numbered name.
                stem, extension = os.path.splitext(name)
                number = 2
                while exists(f"{stem} ({number}){extension}", directory):
                    number += 1
                name = f"{stem} ({number}){extension}"
            os.rename("item", name, src_dir_fd=entry, dst_dir_fd=directory)
        finally:
            os.close(directory)
    finally:
        os.close(entry)
    shutil.rmtree(trash_path(entry_id), ignore_errors=True)
    return {"path": joined(parts[:-1] + [name])}


def trash_delete(entry_id):
    if read_meta(entry_id) is None:
        raise ValueError("Unknown recycle bin entry")
    shutil.rmtree(trash_path(entry_id))
    return {"id": entry_id}


# ───────────────────────────── the request ─────────────────────────────


def main():
    request = json.loads(sys.stdin.buffer.read(15 * 1024 * 1024))
    operation = request["operation"]
    if operation == "trash_list":
        return {"entries": trash_entries(), "days": TRASH_DAYS}
    if operation == "restore":
        return restore(request["id"])
    if operation == "trash_delete":
        return trash_delete(request["id"])
    if operation == "tree":
        return tree()
    parts = parse_path(request["path"])
    if operation == "list":
        return list_dir(parts)
    if operation == "mkdir":
        os.close(open_dir(parts, make=True))
        return {"path": joined(parts)}
    if operation == "delete":
        return delete(parts)
    if not parts:
        raise ValueError("Choose a file")
    name = parts[-1]
    directory = open_dir(parts[:-1])
    try:
        result = {"path": joined(parts)}
        if operation in ("read", "read_pdf", "read_bytes"):
            content = read_whole(directory, name, LIMIT if operation == "read" else BYTES_LIMIT)
            if operation == "read_pdf":
                if not content.startswith(b"%PDF-"):
                    raise ValueError("Choose a PDF file")
                result["base64"] = base64.b64encode(content).decode("ascii")
            elif operation == "read_bytes":
                result["base64"] = base64.b64encode(content).decode("ascii")
                result["size"] = len(content)
            else:
                result["text"] = content.decode("utf-8", errors="strict")
        elif operation in ("write", "write_pdf", "write_bytes"):
            if operation == "write":
                content = request["text"].encode("utf-8")
                limit = LIMIT
            else:
                content = base64.b64decode(request["base64"], validate=True)
                limit = BYTES_LIMIT
            if operation == "write_pdf" and not content.startswith(b"%PDF-"):
                raise ValueError("Choose a PDF file")
            if len(content) > limit:
                raise ValueError("File exceeds size limit")
            write_whole(directory, name, content)
        elif operation == "rename":
            to_parts = parse_path(request["to"])
            if not to_parts:
                raise ValueError("Choose a new name")
            os.stat(name, dir_fd=directory, follow_symlinks=False)
            target = open_dir(to_parts[:-1])
            try:
                if exists(to_parts[-1], target):
                    raise ValueError("A file with that name already exists")
                os.rename(name, to_parts[-1], src_dir_fd=directory, dst_dir_fd=target)
            finally:
                os.close(target)
            result["path"] = joined(to_parts)
        else:
            raise ValueError("Unsupported file operation")
        return result
    finally:
        os.close(directory)


try:
    print(json.dumps(main()))
except (OSError, ValueError, KeyError, TypeError) as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
