// The words of an Office document, read from its XML without any Office library: a Word file's
// paragraphs, a spreadsheet's cells as tab-separated rows per sheet, a slide deck's text per
// slide. Formatting, pictures and formulas are not kept; what a member needs is what it says.
import { zipEntries, zipText } from "./zip.ts";

/** XML character references and entities back to text. */
export function decodeXml(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** The text of every `<tag>…</tag>` in order (tags are namespaced, e.g. `w:t`). */
function textsOf(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>|<${tag}(?:\\s[^>]*)?/>`, "g");
  const out: string[] = [];
  for (const match of xml.matchAll(pattern)) out.push(decodeXml(match[1] ?? ""));
  return out;
}

/** A Word document (.docx): one line per paragraph, tabs kept, tables row by row. */
export function docxText(bytes: Uint8Array): string {
  const entries = zipEntries(bytes);
  const xml = zipText(bytes, "word/document.xml", entries);
  if (xml === null) throw new Error("Not a Word document");
  const lines: string[] = [];
  // Within a paragraph: each run's text, a tab, a line break, in the order written.
  const tokens = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:t(?:\s[^>]*)?\/>|<w:tab\/>|<w:br\/>|<w:cr\/>/g;
  for (const paragraph of xml.split(/<\/w:p>/)) {
    let words = "";
    for (const match of paragraph.matchAll(tokens)) {
      if (match[0] === "<w:tab/>") words += "\t";
      else if (match[0] === "<w:br/>" || match[0] === "<w:cr/>") words += "\n";
      else words += decodeXml(match[1] ?? "");
    }
    if (words.trim() || lines.length) lines.push(words);
  }
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A spreadsheet (.xlsx): each sheet under its name, rows as tab-separated cells. Shared
 * strings and inline strings are read; numbers and dates come as the stored value. */
export function xlsxText(bytes: Uint8Array): string {
  const entries = zipEntries(bytes);
  const workbook = zipText(bytes, "xl/workbook.xml", entries);
  if (workbook === null) throw new Error("Not an Excel workbook");
  const shared: string[] = [];
  const sharedXml = zipText(bytes, "xl/sharedStrings.xml", entries);
  if (sharedXml)
    for (const item of sharedXml.split(/<\/si>/).slice(0, -1))
      shared.push(textsOf(item, "t").join(""));
  // Sheet names in order, each with its relationship id; the relationship names the part.
  const rels = zipText(bytes, "xl/_rels/workbook.xml.rels", entries) ?? "";
  const targets = new Map<string, string>();
  for (const match of rels.matchAll(/<Relationship\s[^>]*>/g)) {
    const id = /\sId="([^"]+)"/.exec(match[0])?.[1];
    const target = /\sTarget="([^"]+)"/.exec(match[0])?.[1];
    if (id && target) targets.set(id, target.replace(/^\/?(xl\/)?/, "xl/"));
  }
  const sheets: { name: string; part: string }[] = [];
  for (const match of workbook.matchAll(/<sheet\s[^>]*>/g)) {
    const name = decodeXml(/\sname="([^"]*)"/.exec(match[0])?.[1] ?? "Sheet");
    const rid = /\sr:id="([^"]+)"/.exec(match[0])?.[1] ?? "";
    const part = targets.get(rid);
    if (part) sheets.push({ name, part });
  }
  const out: string[] = [];
  for (const sheet of sheets) {
    const xml = zipText(bytes, sheet.part, entries);
    if (xml === null) continue;
    out.push(`## ${sheet.name}`);
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const cell of row[1].matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attributes = cell[1] ?? "";
        const inner = cell[2] ?? "";
        const column = /\sr="([A-Z]+)\d+"/.exec(attributes)?.[1];
        const type = /\st="([^"]+)"/.exec(attributes)?.[1];
        let value = "";
        if (type === "s") {
          const index = Number(/<v>([^<]*)<\/v>/.exec(inner)?.[1] ?? "-1");
          value = shared[index] ?? "";
        } else if (type === "inlineStr") value = textsOf(inner, "t").join("");
        else value = decodeXml(/<v>([^<]*)<\/v>/.exec(inner)?.[1] ?? "");
        // Empty columns between values keep their place.
        if (column) {
          const at = columnIndex(column);
          while (cells.length < at) cells.push("");
        }
        cells.push(value);
      }
      if (cells.some((cell) => cell !== "")) out.push(cells.join("\t"));
    }
    out.push("");
  }
  return out.join("\n").trim();
}

function columnIndex(letters: string): number {
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

/** A slide deck (.pptx): each slide's text under its number. */
export function pptxText(bytes: Uint8Array): string {
  const entries = zipEntries(bytes);
  const slides = entries
    .map((entry) => entry.name)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(/\d+/.exec(a.slice(11))?.[0]) - Number(/\d+/.exec(b.slice(11))?.[0]));
  if (!slides.length) throw new Error("Not a PowerPoint deck");
  const out: string[] = [];
  slides.forEach((name, index) => {
    const xml = zipText(bytes, name, entries) ?? "";
    out.push(`## Slide ${index + 1}`);
    for (const paragraph of xml.split(/<\/a:p>/)) {
      const words = textsOf(paragraph, "a:t").join("");
      if (words.trim()) out.push(words);
    }
    out.push("");
  });
  return out.join("\n").trim();
}
