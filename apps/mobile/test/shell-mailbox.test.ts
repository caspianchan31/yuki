// The mailbox on the credentials page: its row line, its group
// first, the 待补 line a task's request makes (opening the mailbox form), and what the form sends.
import assert from "node:assert/strict";
import test from "node:test";
import {
  credentialSections,
  emptyMailbox,
  entryWhat,
  mailboxBody,
  normalizeEntry,
  requestLine,
  requestPreset,
  usedByLine,
} from "../../../packages/client/src/shell/credentials/credentials-core.ts";
import type {
  CredentialRequestView,
  CredentialView,
} from "../../../packages/domain/src/credentials.ts";

const raw = {
  id: "m1",
  kind: "mailbox",
  label: null,
  site: null,
  username: "sales@factory.example",
  parts: {
    address: "sales@factory.example",
    smtpHost: "smtp.factory.example",
    smtpPort: 465,
    smtpSecure: true,
    imapHost: "imap.factory.example",
    imapPort: 993,
    password: true,
  },
  usedBy: [{ type: "project" }],
  createdAt: "2026-10-17T00:00:00.000Z",
};

test("a mailbox entry is read, named and listed first", () => {
  const entry = normalizeEntry(raw) as CredentialView;
  assert.equal(entry.kind, "mailbox");
  assert.equal(entryWhat(entry), "sales@factory.example · 发信和收信");
  assert.equal(usedByLine(entry), "用在：本群");
  const sendOnly = normalizeEntry({ ...raw, parts: { ...raw.parts, imapHost: null } });
  assert.equal(entryWhat(sendOnly as CredentialView), "sales@factory.example · 只发信");
  const sections = credentialSections({ entries: [entry], requests: [] });
  assert.equal(sections[0]?.key, "mailbox");
  assert.equal(sections[0]?.title, "发信邮箱");
  assert.equal(sections[0]?.entries.length, 1);
});

test("a task's request for a mailbox reads as such and opens the mailbox form", () => {
  const request: CredentialRequestView = {
    id: "r1",
    site: "mailbox",
    for: { type: "project" },
    by: { taskId: "t1", title: "床具出海" },
    at: "2026-10-17T00:00:00.000Z",
    status: "open",
  };
  assert.equal(requestLine(request), "本群要一个发信邮箱（任务要发邮件）");
  assert.deepEqual(requestPreset(request), { kind: "mailbox" });
  const login = {
    ...request,
    site: "x.com",
    for: { type: "account", environmentId: "e1" },
  } as const;
  assert.deepEqual(requestPreset(login), {
    kind: "site_login",
    site: "x.com",
    environmentId: "e1",
  });
});

test("the mailbox form sends the servers, ports as numbers, and the password only when typed", () => {
  assert.deepEqual(mailboxBody({ ...emptyMailbox }, "create"), { error: "要填邮箱地址。" });
  assert.deepEqual(mailboxBody({ ...emptyMailbox, address: "a@b.co" }, "create"), {
    error: "要填发信服务器（SMTP）。",
  });
  assert.deepEqual(
    mailboxBody({ ...emptyMailbox, address: "a@b.co", smtpHost: "smtp.b.co" }, "create"),
    { error: "要填密码或授权码。" },
  );
  assert.deepEqual(
    mailboxBody(
      { ...emptyMailbox, address: " a@b.co ", smtpHost: "smtp.b.co", password: "pw" },
      "create",
    ),
    {
      address: "a@b.co",
      smtpHost: "smtp.b.co",
      smtpPort: 465,
      imapHost: null,
      imapPort: null,
      password: "pw",
    },
  );
  assert.deepEqual(
    mailboxBody(
      {
        ...emptyMailbox,
        address: "a@b.co",
        smtpHost: "smtp.b.co",
        smtpPort: "587",
        imapHost: "imap.b.co",
      },
      "replace",
    ),
    {
      address: "a@b.co",
      smtpHost: "smtp.b.co",
      smtpPort: 587,
      imapHost: "imap.b.co",
      imapPort: 993,
    },
  );
});
