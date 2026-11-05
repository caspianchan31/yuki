// The project's own mailbox as the channel email goes through.
// A mailbox is a credential (its password sealed in the store, shown only as saved, leaving it
// only through `use` into the SMTP or IMAP client); an email prepared in a project with a
// mailbox is approved and sent through it with the project's address; a project with none and
// no Google connection cannot prepare one, and a task that tried has asked the owner for one.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ActionService } from "../apps/server/src/actions.ts";
import { Auth } from "../apps/server/src/auth.ts";
import type { Config } from "../apps/server/src/config.ts";
import { randomCredentialKey } from "../apps/server/src/credentials/crypto.ts";
import { CredentialStore } from "../apps/server/src/credentials/store.ts";
import { connectionOf, createStore, type Store } from "../apps/server/src/db.ts";
import { Files } from "../apps/server/src/files.ts";
import { GoogleAuth } from "../apps/server/src/google-auth.ts";
import { MailChannels, mailScopeOf } from "../apps/server/src/mail/channels.ts";
import type { OutgoingMail, SmtpSettings } from "../apps/server/src/mail/smtp.ts";
import { WorkspaceService } from "../apps/server/src/workspace.ts";
import type { MailboxParts } from "../packages/domain/src/credentials.ts";
import type { Mail } from "../packages/domain/src/index.ts";
import { projectOwner } from "../packages/domain/src/projects.ts";
import { config as base } from "./helpers/computer.ts";

const password = "Sentinel-Mailbox-Pass-9c1e!";
const owner = { type: "owner" } as const;
const projectId = randomUUID();
const scope = projectOwner("local-user", projectId);

let db: Store;
let store: CredentialStore;
before(async () => {
  db = await createStore();
  store = new CredentialStore(db, randomCredentialKey());
  await store.open();
});
after(async () => {
  await db.close();
});

test("a mailbox is a credential: servers shown, password sealed, used only through use", async () => {
  const view = await store.create(
    scope,
    {
      kind: "mailbox",
      address: "Sales@Example.COM",
      password,
      smtpHost: "smtp.example.com",
      smtpPort: 465,
      imapHost: "imap.example.com",
      usedBy: [{ type: "project" }],
    },
    owner,
  );
  assert.equal(view.kind, "mailbox");
  assert.equal(view.username, "Sales@example.com", "the domain part is lower-cased");
  assert.deepEqual(view.parts, {
    address: "Sales@example.com",
    smtpHost: "smtp.example.com",
    smtpPort: 465,
    smtpSecure: true,
    imapHost: "imap.example.com",
    imapPort: 993,
    password: true,
  } satisfies MailboxParts);
  // Nothing in the tables holds the password.
  const { query } = connectionOf(db);
  for (const table of ["credential_entries", "credential_audit", "credential_requests"]) {
    const rows = await query(`SELECT to_jsonb(t)::text AS row FROM ${table} t`);
    for (const row of rows.rows as unknown as { row: string }[])
      assert.ok(!row.row.includes(password), `${table} holds the password`);
  }
  // The one door out: `use`, recorded as such.
  let seen = "";
  await store.use(
    scope,
    { id: view.id, part: "mailbox_password" },
    "mail_send",
    owner,
    async (v) => {
      seen = v;
    },
  );
  assert.equal(seen, password);
  const history = await store.history(scope, { entry: view.id });
  const used = history.rows.find((row) => row.event === "used");
  assert.equal(used?.purpose, "mail_send");
  assert.equal(used?.part, "mailbox_password");
  assert.equal(JSON.stringify(history).includes(password), false);
  // Command output on a desktop would mask it.
  assert.equal(await store.scrub(scope, { type: "project" }, `pass=${password} ok`), "pass=*** ok");
  // The servers change without the password; the password alone changes too.
  const { view: moved } = await store.replace(
    scope,
    view.id,
    { smtpHost: "mail.example.com", smtpPort: 587, imapHost: null },
    owner,
  );
  assert.equal((moved.parts as MailboxParts).smtpHost, "mail.example.com");
  assert.equal((moved.parts as MailboxParts).smtpSecure, false, "587 is STARTTLS");
  assert.equal((moved.parts as MailboxParts).imapHost, null);
  await store.use(
    scope,
    { id: view.id, part: "mailbox_password" },
    "mail_send",
    owner,
    async (v) => {
      seen = v;
    },
  );
  assert.equal(seen, password, "the password stayed");
  await store.replace(scope, view.id, { password: "Another-Pass-1" }, owner);
  await store.use(
    scope,
    { id: view.id, part: "mailbox_password" },
    "mail_send",
    owner,
    async (v) => {
      seen = v;
    },
  );
  assert.equal(seen, "Another-Pass-1");
  // What is refused.
  await assert.rejects(
    store.create(
      scope,
      { kind: "mailbox", address: "not-an-address", password, smtpHost: "x" },
      owner,
    ),
    /address must be an email address/,
  );
  await assert.rejects(
    store.create(scope, { kind: "mailbox", address: "a@b.co", smtpHost: "smtp.b.co" }, owner),
    /password is required/,
  );
  await assert.rejects(
    store.create(scope, { kind: "mailbox", address: "a@b.co", password }, owner),
    /smtpHost is required/,
  );
  await store.remove(scope, view.id, owner);
});

test("an email in a project with a mailbox is prepared and sent through it", async () => {
  const config: Config = { ...base, mode: "live" };
  const auth = new Auth(db, config, "sample-signing-key");
  const files = new Files(db, config, auth);
  const sent: { settings: SmtpSettings; password: string; mail: OutgoingMail }[] = [];
  const mail = new MailChannels(store, {
    smtp: async (settings, pass, message) => {
      sent.push({ settings, password: pass, mail: message });
      return { messageId: "abc123@mail.example.com" };
    },
  });
  const workspace = new WorkspaceService(db, config, files, new GoogleAuth(db, config), mail);
  const actions = new ActionService(db, {
    execute: (o, input, connectionId, targetVersion) =>
      workspace.execute(o, input, connectionId, targetVersion),
    prepare: (o, input, connectionId) => workspace.prepare(o, input, connectionId),
    connected: (o) => workspace.connected(o),
    connection: (o, kind) => workspace.connectionFor(o, kind),
  });
  const project = scope;
  const draft = {
    kind: "email.send" as const,
    data: {
      to: ["buyer@importer.example"],
      cc: [],
      bcc: [],
      subject: "Flat-pack bed frames, OEM",
      body: "Hello,\n\nWe make bed frames to EU sizes.",
      attachmentIds: [],
    },
  };
  // Without a mailbox (and no Google) nothing can be prepared.
  await assert.rejects(actions.propose(project, draft), /Add a mailbox to the project/);
  assert.equal(await workspace.mailConnection(project), null);

  const entry = await store.create(
    scope,
    {
      kind: "mailbox",
      address: "sales@factory.example",
      password,
      smtpHost: "smtp.factory.example",
      smtpPort: 587,
      usedBy: [{ type: "project" }],
    },
    owner,
  );
  assert.equal(mailScopeOf(`${project}#env:0000`), scope, "an account's owner is its project's");
  const connection = await workspace.mailConnection(project);
  assert.deepEqual(connection, { id: `mailbox:${entry.id}`, account: "sales@factory.example" });
  const snapshotConnections = (await workspace.snapshot(project)).connections;
  assert.ok(
    snapshotConnections.some((c) => c.name === "Mailbox" && c.account === "sales@factory.example"),
  );

  const proposal = await actions.propose(project, draft);
  assert.equal(proposal.status, "awaiting_review");
  assert.equal(proposal.connectionId, `mailbox:${entry.id}`);
  assert.equal(proposal.account, "sales@factory.example");
  const done = await actions.decide(project, proposal.id, proposal.hash, "approve");
  assert.equal(done.status, "succeeded");
  assert.match(done.result ?? "", /^Sent from sales@factory\.example · abc123@mail\.example\.com$/);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]?.settings, {
    address: "sales@factory.example",
    host: "smtp.factory.example",
    port: 587,
    secure: false,
  });
  assert.equal(sent[0]?.password, password);
  assert.deepEqual(sent[0]?.mail.to, ["buyer@importer.example"]);
  assert.equal(sent[0]?.mail.subject, "Flat-pack bed frames, OEM");
  // The sent message is kept with the workspace's mail, and the use is in the history.
  const kept = (await db.list<Mail>(project, "mail")).find(
    (m) => m.id === "abc123@mail.example.com",
  );
  assert.equal(kept?.label, "Sent · sales@factory.example");
  assert.equal(kept?.from, "sales@factory.example");
  const history = await store.history(scope, { entry: entry.id });
  assert.ok(history.rows.some((row) => row.event === "used" && row.purpose === "mail_send"));

  // A mailbox replaced after the proposal: the approval is refused, nothing goes out.
  const second = await actions.propose(project, {
    ...draft,
    data: { ...draft.data, subject: "Second" },
  });
  await store.remove(scope, entry.id, owner);
  await store.create(
    scope,
    {
      kind: "mailbox",
      address: "other@factory.example",
      password,
      smtpHost: "smtp.factory.example",
    },
    owner,
  );
  await assert.rejects(
    actions.decide(project, second.id, second.hash, "approve"),
    /mailbox changed/i,
  );
  assert.equal(sent.length, 1);
});
