// A small reader of ZIP archives (what Word, Excel and PowerPoint files are), enough to take
// the XML parts out of an Office document: the central directory is walked, each entry is
// stored or deflated (the only methods Office writes). Nothing is written, nothing executes.
import { inflateRawSync } from "node:zlib";

const centralDirectoryEnd = 0x06054b50;
const centralDirectoryEntry = 0x02014b50;
const localFileHeader = 0x04034b50;

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  /** Where the entry's local header starts. */
  offset: number;
}

/** Each entry of the archive's central directory (names as written, `/`-separated). */
export function zipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end record is in the last 64 KB (its comment may follow it).
  const start = Math.max(0, bytes.length - 65_557);
  let end = -1;
  for (let at = bytes.length - 22; at >= start; at--) {
    if (view.getUint32(at, true) === centralDirectoryEnd) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error("Not a ZIP archive");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const entries: ZipEntry[] = [];
  const decoder = new TextDecoder();
  for (let index = 0; index < count; index++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== centralDirectoryEntry)
      throw new Error("The ZIP archive's directory is damaged");
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    entries.push({ name, method, compressedSize, size, offset });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** One entry's bytes; null when the archive has no entry of that name. `maxBytes` bounds what
 * a small file may claim to expand to (a bomb is refused). */
export function zipRead(
  bytes: Uint8Array,
  name: string,
  entries = zipEntries(bytes),
  maxBytes = 64 * 1024 * 1024,
): Uint8Array | null {
  const entry = entries.find((candidate) => candidate.name === name);
  if (!entry) return null;
  if (entry.size > maxBytes) throw new Error(`${name} is too large to read`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = entry.offset;
  if (at + 30 > bytes.length || view.getUint32(at, true) !== localFileHeader)
    throw new Error("The ZIP archive's entry is damaged");
  const nameLength = view.getUint16(at + 26, true);
  const extraLength = view.getUint16(at + 28, true);
  const dataAt = at + 30 + nameLength + extraLength;
  const data = bytes.subarray(dataAt, dataAt + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) {
    const out = inflateRawSync(data, { maxOutputLength: maxBytes });
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  }
  throw new Error(`${name} uses a compression this reader does not know`);
}

/** One entry's text (UTF-8); null when missing. */
export function zipText(bytes: Uint8Array, name: string, entries?: ZipEntry[]): string | null {
  const data = zipRead(bytes, name, entries);
  return data ? new TextDecoder().decode(data) : null;
}
