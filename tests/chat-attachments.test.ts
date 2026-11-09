// v1.6 聊天里发文件: the files the person sends in the chat. The message names them as parts
// (the shared helpers read a plain string or the parts alike); the store keeps bytes, record and
// words apart from the process and lets a conversation's go; a document's words come out of a
// PDF, a Word file, a spreadsheet or slides without an Office library; the model gets pictures
// as images (the newest few) and documents as their words, and read_attachment gives the rest;
// the routes upload, describe and serve a file as what its name says.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import type { Message } from "@ag-ui/client";
import { Hono } from "hono";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { z } from "zod";
import { attachmentRoutes } from "../apps/server/src/chat/attachment-routes.ts";
import { AttachmentStore, attachmentIdsOf } from "../apps/server/src/chat/attachment-store.ts";
import { attachmentText } from "../apps/server/src/chat/attachment-text.ts";
import {
  attachmentTools,
  messagesForModel,
} from "../apps/server/src/chat/attachments-for-model.ts";
import { AppError } from "../apps/server/src/errors.ts";
import {
  attachmentKind,
  attachmentMediaType,
  attachmentsOf,
  cleanAttachmentName,
  deliveredPaths,
  hasContent,
  messageText,
  userContent,
} from "../packages/domain/src/chat-attachments.ts";
import { docxText, pptxText, xlsxText } from "../packages/integrations/src/office-text.ts";
import { zipEntries, zipText } from "../packages/integrations/src/zip.ts";

/** A ZIP archive of text entries, stored or deflated in turn (both ways Office writes). */
function zipOf(entries: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  let index = 0;
  for (const [name, text] of Object.entries(entries)) {
    const nameBytes = encoder.encode(name);
    const raw = encoder.encode(text);
    const method = index++ % 2 === 0 ? 0 : 8;
    const data = method === 8 ? new Uint8Array(deflateRawSync(raw)) : raw;
    const local = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(8, method, true);
    view.setUint32(18, data.length, true);
    view.setUint32(22, raw.length, true);
    view.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    parts.push(local, data);
    const entry = new Uint8Array(46 + nameBytes.length);
    const entryView = new DataView(entry.buffer);
    entryView.setUint32(0, 0x02014b50, true);
    entryView.setUint16(10, method, true);
    entryView.setUint32(20, data.length, true);
    entryView.setUint32(24, raw.length, true);
    entryView.setUint16(28, nameBytes.length, true);
    entryView.setUint32(42, offset, true);
    entry.set(nameBytes, 46);
    central.push(entry);
    offset += local.length + data.length;
  }
  const centralSize = central.reduce((sum, entry) => sum + entry.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, central.length, true);
  endView.setUint16(10, central.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  const total = offset + centralSize + 22;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of [...parts, ...central, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const docx = () =>
  zipOf({
    "[Content_Types].xml": "<Types/>",
    "word/document.xml":
      '<w:document><w:body><w:p><w:r><w:t>第一段：</w:t></w:r><w:r><w:t xml:space="preserve">合同金额 &amp; 期限</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t><w:tab/><w:t>带制表符</w:t></w:r></w:p><w:p/></w:body></w:document>',
  });
const xlsx = () =>
  zipOf({
    "xl/workbook.xml":
      '<workbook><sheets><sheet name="收入" sheetId="1" r:id="rId1"/><sheet name="成本" sheetId="2" r:id="rId2"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels":
      '<Relationships><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="x" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
    "xl/sharedStrings.xml":
      "<sst><si><t>项目</t></si><si><r><t>一</t></r><r><t>月</t></r></si></sst>",
    "xl/worksheets/sheet1.xml":
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>广告</t></is></c><c r="C2"><v>1200.5</v></c></row></sheetData></worksheet>',
    "xl/worksheets/sheet2.xml":
      '<worksheet><sheetData><row r="1"><c r="A1"><v>7</v></c></row></sheetData></worksheet>',
  });
const pptx = () =>
  zipOf({
    "ppt/slides/slide2.xml": "<p:sld><a:p><a:r><a:t>第二页</a:t></a:r></a:p></p:sld>",
    "ppt/slides/slide1.xml":
      "<p:sld><a:p><a:r><a:t>标题</a:t></a:r></a:p><a:p><a:r><a:t>要点 </a:t></a:r><a:r><a:t>一</a:t></a:r></a:p></p:sld>",
    "ppt/slides/slide10.xml": "<p:sld><a:p><a:r><a:t>第十页</a:t></a:r></a:p></p:sld>",
  });

async function pdfOf(lines: string[]): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([400, 300]);
  for (const [index, line] of lines.entries())
    page.drawText(line, { x: 30, y: 250 - index * 24, font, size: 12 });
  return document.save();
}

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

function storeIn(): AttachmentStore {
  return new AttachmentStore(mkdtempSync(join(tmpdir(), "yuki-attachments-")), {
    pruneEveryMs: null,
  });
}

test("a message names its files as parts; the helpers read a string or the parts alike", () => {
  assert.equal(messageText("hi"), "hi");
  assert.equal(messageText(userContent("hi", [])), "hi");
  const content = userContent("看看这个", [
    { id: "a".repeat(22), name: "报告.pdf", mimeType: "application/pdf" },
    { id: "b".repeat(22), name: "图.png", mimeType: "image/png" },
  ]);
  assert.ok(Array.isArray(content));
  assert.equal(messageText(content), "看看这个");
  assert.deepEqual(
    attachmentsOf(content).map((file) => file.name),
    ["报告.pdf", "图.png"],
  );
  assert.deepEqual(attachmentsOf("plain"), []);
  // A part whose id is not the store's is not an attachment (nothing from it reaches the store).
  assert.deepEqual(attachmentsOf([{ type: "binary", id: "../x", mimeType: "x" }]), []);
  assert.equal(
    hasContent(userContent("", [{ id: "a".repeat(22), name: "a", mimeType: "x" }])),
    true,
  );
  assert.equal(hasContent(userContent("  ", [])), false);
  assert.equal(attachmentKind("a.PDF"), "document");
  assert.equal(attachmentKind("a.docx"), "document");
  assert.equal(attachmentKind("shot", "image/png"), "image");
  assert.equal(attachmentKind("notes.md"), "markdown");
  assert.equal(attachmentKind("x.zip"), "other");
  assert.equal(cleanAttachmentName("../..\\..\\.hidden"), "hidden");
  assert.equal(cleanAttachmentName("  "), "file");
  assert.equal(cleanAttachmentName("报告 v2.pdf"), "报告 v2.pdf");
  assert.equal(
    attachmentMediaType("a.docx", "application/octet-stream").startsWith("application/vnd"),
    true,
  );
  assert.equal(attachmentMediaType("a.png", "image/png; charset=binary"), "image/png");
  assert.equal(attachmentMediaType("script.py"), "text/plain");
  assert.equal(attachmentMediaType("a.bin"), "application/octet-stream");
  const results: Record<string, string> = {
    c1: '{"path":"/workspace/成品/a.md"}',
    c2: '{"error":"no"}',
  };
  assert.deepEqual(
    deliveredPaths(
      [
        { id: "c1", function: { name: "write_computer_file", arguments: '{"path":"成品/a.md"}' } },
        {
          id: "c2",
          function: { name: "write_computer_file", arguments: '{"path":"/workspace/成品/b.md"}' },
        },
        {
          id: "c3",
          function: { name: "write_computer_file", arguments: '{"path":"/workspace/x.md"}' },
        },
        {
          id: "c4",
          function: { name: "read_computer_file", arguments: '{"path":"/workspace/成品/a.md"}' },
        },
        { id: "c5", function: { name: "write_computer_file", arguments: "not json" } },
        { id: "c6", function: { name: "write_computer_file", arguments: '{"path":"成品/a.md"}' } },
      ],
      (id) => results[id],
    ),
    ["/workspace/成品/a.md"],
  );
});

test("Word, Excel and PowerPoint files give their words from their XML (stored and deflated)", () => {
  const archive = docx();
  assert.deepEqual(
    zipEntries(archive).map((entry) => [entry.name, entry.method]),
    [
      ["[Content_Types].xml", 0],
      ["word/document.xml", 8],
    ],
  );
  assert.equal(zipText(archive, "missing"), null);
  assert.equal(docxText(archive), "第一段：合同金额 & 期限\n第二段\t带制表符");
  assert.equal(xlsxText(xlsx()), "## 收入\n项目\t一月\n广告\t\t1200.5\n\n## 成本\n7");
  assert.equal(
    pptxText(pptx()),
    "## Slide 1\n标题\n要点 一\n\n## Slide 2\n第二页\n\n## Slide 3\n第十页",
  );
  assert.throws(() => docxText(zipOf({ "a.txt": "x" })), /Not a Word document/);
  assert.throws(() => docxText(new Uint8Array([1, 2, 3])), /Not a ZIP/);
});

test("a PDF's words come out page by page; text is decoded; a picture has none", async () => {
  const text = await attachmentText(
    "q.pdf",
    "application/pdf",
    await pdfOf(["Quarterly revenue rose 12 percent.", "Costs fell."]),
  );
  assert.match(text, /--- page 1 of 1 ---/);
  assert.match(text, /Quarterly revenue rose 12 percent/);
  assert.match(text, /Costs fell/);
  assert.equal(
    await attachmentText("a.md", "text/markdown", new TextEncoder().encode("﻿# 标题")),
    "# 标题",
  );
  assert.equal(await attachmentText("a.png", "image/png", png), "");
  assert.equal(await attachmentText("a.zip", "application/zip", new Uint8Array([1])), "");
});

test("the store keeps a file for its space, its words once read, and lets a conversation's go", async () => {
  const store = storeIn();
  const meta = await store.save({
    owner: "alice",
    name: "表.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    bytes: xlsx(),
  });
  assert.match(meta.id, /^[A-Za-z0-9_-]{16,32}$/);
  assert.equal(meta.space, "alice");
  assert.equal(meta.workspacePath, null);
  await store.placed(meta.id, "/workspace/收到/表.xlsx");
  assert.equal((await store.meta("alice", meta.id))?.workspacePath, "/workspace/收到/表.xlsx");
  // A project of the same space reads it; another space does not.
  assert.ok(await store.meta("alice/proj:0f7a1c2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b", meta.id));
  assert.equal(await store.meta("bob", meta.id), null);
  assert.equal(await store.read("bob", meta.id), null);
  assert.equal(await store.text("bob", meta.id), null);
  const words = await store.text("alice", meta.id);
  assert.match(words?.text ?? "", /## 收入/);
  assert.ok((await readdir(store.dir)).includes(`${meta.id}.txt`), "the words are cached");
  assert.equal((await store.read("alice", meta.id))?.bytes.length, xlsx().length);
  await assert.rejects(
    () =>
      store.save({
        owner: "alice",
        name: "big",
        mimeType: "x",
        bytes: new Uint8Array(10 * 1024 * 1024 + 1),
      }),
    (error: AppError) => error.status === 413,
  );
  assert.equal(await store.remove([meta.id, "../etc", "zzz"]), 1);
  assert.equal(await store.meta("alice", meta.id), null);
  assert.deepEqual(await readdir(store.dir), []);
  // Pruning: past the retention, then past the cap (oldest first).
  const clock = { now: 1_000_000_000_000 };
  const small = new AttachmentStore(mkdtempSync(join(tmpdir(), "yuki-attachments-")), {
    pruneEveryMs: null,
    now: () => clock.now,
    maxBytes: 3,
  });
  const a = await small.save({ owner: "o", name: "a", mimeType: "x", bytes: new Uint8Array(2) });
  clock.now += 1000;
  const b = await small.save({ owner: "o", name: "b", mimeType: "x", bytes: new Uint8Array(2) });
  assert.equal(await small.prune(), 1, "two bytes over a cap of three: the oldest goes");
  assert.equal(await small.meta("o", a.id), null);
  assert.ok(await small.meta("o", b.id));
  clock.now += 91 * 24 * 60 * 60_000;
  assert.equal(await small.prune(), 1, "past 90 days the rest goes");
  // The ids a conversation's events name.
  assert.deepEqual(
    attachmentIdsOf([
      {
        type: "RUN_STARTED",
        input: {
          messages: [
            {
              role: "user",
              content: userContent("x", [{ id: "c".repeat(22), name: "c", mimeType: "x" }]),
            },
          ],
        },
      },
      { type: "TEXT_MESSAGE_CHUNK", delta: "hi" },
      { type: "RUN_STARTED", input: { messages: [{ role: "user", content: "plain" }] } },
    ]),
    ["c".repeat(22)],
  );
});

test("the model gets the newest pictures as images, a document's words, and read_attachment for the rest", async () => {
  const store = storeIn();
  const pictures: string[] = [];
  for (let index = 0; index < 3; index++)
    pictures.push(
      (await store.save({ owner: "o", name: `p${index}.png`, mimeType: "image/png", bytes: png }))
        .id,
    );
  const doc = await store.save({
    owner: "o",
    name: "合同.docx",
    mimeType: "application/x",
    bytes: docx(),
  });
  const zip = await store.save({
    owner: "o",
    name: "包.zip",
    mimeType: "application/zip",
    bytes: new Uint8Array([1]),
  });
  await store.placed(doc.id, "/workspace/收到/合同.docx");
  const file = (id: string, name: string, mimeType: string) => ({ id, name, mimeType });
  const messages = [
    {
      id: "u1",
      role: "user",
      content: userContent("第一张", [file(pictures[0], "p0.png", "image/png")]),
    },
    { id: "a1", role: "assistant", content: "看到了" },
    {
      id: "u2",
      role: "user",
      content: userContent("再看", [
        file(pictures[1], "p1.png", "image/png"),
        file(pictures[2], "p2.png", "image/png"),
        file(doc.id, "合同.docx", "application/x"),
        file(zip.id, "包.zip", "application/zip"),
        file("d".repeat(22), "gone.pdf", "application/pdf"),
      ]),
    },
    { id: "u3", role: "user", content: "plain" },
  ] as Message[];
  const out = await messagesForModel(messages, store, "o", { keepImages: 2, excerptChars: 8 });
  assert.equal(out[1], messages[1], "other messages pass through");
  assert.equal(out[3], messages[3]);
  // The oldest picture is past the two kept: named, not attached.
  const first = out[0] as { content: unknown };
  assert.equal(typeof first.content, "string");
  assert.match(
    first.content as string,
    /^第一张\n\n\[Attachment 1: p0\.png \(picture, 70 B, id [A-Za-z0-9_-]+\): not attached now/,
  );
  const second = (out[2] as { content: { type: string; data?: string; text?: string }[] }).content;
  assert.equal(second.length, 3, "a text part and the two kept pictures");
  assert.equal(second[0].type, "text");
  const text = second[0].text ?? "";
  assert.match(
    text,
    /^再看\n\n\[Attachment 1: p1\.png \(picture, 70 B, id [A-Za-z0-9_-]+\): attached as an image\]/,
  );
  assert.match(
    text,
    /\[Attachment 3: 合同\.docx \(Word document, \d+ B, id [A-Za-z0-9_-]+, on the computer at \/workspace\/收到\/合同\.docx\): the first 8 of \d+ characters follow; read_attachment gives the rest\]\n第一段：合同金额\n\[end of 合同\.docx\]/,
  );
  assert.match(
    text,
    /\[Attachment 4: 包\.zip \(file, 1 B, id [A-Za-z0-9_-]+\): this kind of file has no words/,
  );
  assert.match(text, /\[Attachment 5: gone\.pdf \(PDF, id d+\): no longer available\]/);
  assert.equal(second[1].type, "binary");
  assert.equal(second[1].data, png.toString("base64"));
  assert.equal(second[2].type, "binary");
  // Without a store every file is named as unavailable, and messages stay strings.
  const bare = await messagesForModel(messages, undefined, "o");
  assert.equal(typeof (bare[2] as { content: unknown }).content, "string");
  // read_attachment: a document in pieces, a picture as an image, a missing one as an error.
  const [tool] = attachmentTools(store, "o");
  assert.equal(tool?.name, "read_attachment");
  const execute = tool?.execute as (args: unknown) => Promise<unknown>;
  const read = (await execute({ id: doc.id })) as {
    text: string;
    truncated: boolean;
    length: number;
  };
  assert.equal(read.truncated, false);
  assert.equal(read.text, "第一段：合同金额 & 期限\n第二段\t带制表符");
  const piece = (await execute({ id: doc.id, offset: read.length - 3 })) as {
    text: string;
    truncated: boolean;
  };
  assert.deepEqual([piece.text, piece.truncated], ["制表符", false]);
  const picture = (await execute({ id: pictures[0] })) as { type: string }[];
  assert.deepEqual(
    picture.map((part) => part.type),
    ["text", "image"],
  );
  assert.deepEqual(await execute({ id: "e".repeat(22) }), {
    error: "No such attachment (it may have been removed)",
  });
  assert.deepEqual(await execute({ id: zip.id }), {
    name: "包.zip",
    size: 1,
    text: "",
    note: "This file has no words to read",
  });
  assert.ok(
    "error" in ((await execute({ id: "../x" })) as object),
    "a bad id is refused, not thrown",
  );
  assert.deepEqual(attachmentTools(undefined, "o"), []);
});

test("the routes: an upload (copied to the computer when there is one), the record, a download as what its name says", async () => {
  const store = storeIn();
  const received: string[] = [];
  const app = new Hono<{ Variables: { owner: string } }>();
  app.use("*", async (c, next) => {
    c.set("owner", c.req.header("x-owner") ?? "alice");
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof z.ZodError) return c.json({ error: "Invalid request" }, 400);
    if (error instanceof AppError) return c.json({ error: error.message }, error.status as 400);
    return c.json({ error: String(error) }, 500);
  });
  app.route(
    "/",
    attachmentRoutes(store, {
      receive: async (owner, name) => {
        received.push(`${owner}:${name}`);
        return name === "nowhere.txt" ? null : `/workspace/收到/${name}`;
      },
    }),
  );
  const upload = (name: string, body: string | Uint8Array, headers: Record<string, string> = {}) =>
    app.request(`/?name=${encodeURIComponent(name)}`, {
      method: "POST",
      // A fresh copy: a Blob part wants an ArrayBuffer-backed view in every type configuration.
      body: typeof body === "string" ? body : new Blob([new Uint8Array(body)]),
      headers,
    });
  const svg = await upload("../图.svg", "<svg>x</svg>", { "content-type": "image/svg+xml" });
  assert.equal(svg.status, 201);
  const record = (await svg.json()) as {
    id: string;
    name: string;
    mimeType: string;
    size: number;
    workspacePath: string | null;
  };
  assert.equal(record.name, "图.svg");
  assert.equal(record.mimeType, "image/svg+xml");
  assert.equal(record.size, 12);
  assert.equal(record.workspacePath, "/workspace/收到/图.svg");
  assert.deepEqual(received, ["alice:图.svg"]);
  // The record, and the stored copy's path kept in it.
  const meta = await app.request(`/${record.id}/meta`);
  assert.equal(meta.status, 200);
  assert.equal(
    ((await meta.json()) as { workspacePath: string }).workspacePath,
    "/workspace/收到/图.svg",
  );
  // SVG (and HTML) come back as plain text, never a page in the app's origin.
  const inline = await app.request(`/${record.id}?inline=1`);
  assert.equal(inline.status, 200);
  assert.equal(inline.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(inline.headers.get("x-content-type-options"), "nosniff");
  assert.match(
    inline.headers.get("content-disposition") ?? "",
    /^inline; filename="_.svg"; filename\*=UTF-8''%E5%9B%BE\.svg$/,
  );
  assert.equal(await inline.text(), "<svg>x</svg>");
  const attached = await app.request(`/${record.id}`);
  assert.match(attached.headers.get("content-disposition") ?? "", /^attachment;/);
  // No computer to copy to: the file still goes, the record says so.
  const nowhere = await upload("nowhere.txt", "hello", { "content-type": "text/plain" });
  assert.equal(((await nowhere.json()) as { workspacePath: string | null }).workspacePath, null);
  // A type the browser did not know is taken from the name.
  const docxUpload = await upload("合同.docx", docx(), {
    "content-type": "application/octet-stream",
  });
  assert.equal(
    ((await docxUpload.json()) as { mimeType: string }).mimeType,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  // Refused: empty, too large (by its declared length), another space's, unknown.
  assert.equal((await upload("empty.txt", new Uint8Array())).status, 400);
  assert.equal(
    (await upload("big.bin", new Uint8Array([1]), { "content-length": String(11 * 1024 * 1024) }))
      .status,
    413,
  );
  assert.equal((await app.request(`/${record.id}`, { headers: { "x-owner": "bob" } })).status, 404);
  assert.equal(
    (await app.request(`/${record.id}/meta`, { headers: { "x-owner": "bob" } })).status,
    404,
  );
  assert.equal((await app.request("/nope")).status, 404);
  assert.equal((await app.request("/../../etc/passwd")).status, 404);
});
