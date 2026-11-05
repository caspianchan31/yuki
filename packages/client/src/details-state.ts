/**
 * Phase C (docs/web.md): the state of the old detail sheets (a mail thread, the email and
 * event editors, 等你审阅, a file's form, a browser session), from details.tsx, free of React
 * Native so the web app's sheets act by the same rules. details.tsx draws them on the phone.
 */
import { useEffect, useState } from "react";
import {
  type ActionProposal,
  type Artifact,
  type BrowserSession,
  type CalendarEvent,
  type EmailDraft,
  type EventDraft,
  emailDraftSchema,
  eventDraftSchema,
  type Mail,
  type ProposalInput,
} from "../../../packages/domain/src";
import { ApiError } from "./api-response";
import { browserAddress } from "./browser-address";
import { localDateTime, zonedInstant } from "./date-time";
import { reviewCardView, reviewIsExpired } from "./shell/chat/core";
import { t } from "./shell/strings";
import { type Detail, useWorkspace } from "./workspace";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Fork: validation issues read as sentences, not validator output ("to: Too small: …"); the words
// live in shell/strings.ts (UI redesign, decision 1).
export function issueList(issues: { path: PropertyKey[]; message: string }[]) {
  const words = t.formIssues;
  return issues
    .map((issue) => {
      const key = String(issue.path[0] ?? "");
      const field = Object.hasOwn(words.fields, key) ? words.fields[key] : key || words.form;
      const text = /^Too small/.test(issue.message)
        ? /array/.test(issue.message)
          ? words.addOne
          : words.required
        : /^Too big/.test(issue.message)
          ? words.tooLong
          : /^Invalid/.test(issue.message)
            ? words.invalid
            : issue.message;
      return words.line(field, text);
    })
    .join("\n");
}

export function arrayText(value: unknown) {
  return Array.isArray(value) ? value.map(String).join(", ") : "";
}

/** Addresses typed with commas, semicolons or one per line. */
export function addressList(value: string) {
  return value
    .split(/[,;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** A PDF form field's name as a label: 「first_name」 → 「First name」. */
export function fieldLabel(name: string) {
  return name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** The reply a mail's 回复 opens. */
export function replyDraft(m: Mail): Partial<EmailDraft> {
  return {
    to: [m.from],
    subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`,
    body: "",
    cc: [],
    bcc: [],
    attachmentIds: [],
    threadId: m.threadId,
    replyToMessageId: m.id,
  };
}

/** The name of a mail attachment that is not imported yet (its reference's file part). */
export function attachmentName(reference: string): string {
  return decodeURIComponent(reference.split(":").slice(2).join(":"));
}

/** A mail's whole thread, oldest first, and importing an attachment into the files. */
export function useMailThread(m: Mail) {
  const { api, refresh, open } = useWorkspace();
  const [error, setError] = useState("");
  const [importing, setImporting] = useState("");
  async function importAttachment(reference: string) {
    setError("");
    setImporting(reference);
    try {
      const file = await api.request<Artifact>("/api/mail/import-attachment", { reference });
      await refresh();
      open({ type: "file", file });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setImporting("");
    }
  }
  const [thread, setThread] = useState<Mail[]>([m]);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void api
      .request<Mail[]>(`/api/mail/threads/${encodeURIComponent(m.threadId)}`)
      .then((items) => {
        if (active) setThread(items.sort((a, b) => a.date.localeCompare(b.date)));
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, m.threadId, retry]);
  return {
    thread,
    loading,
    error,
    importing,
    importAttachment,
    reload: () => setRetry((value) => value + 1),
  };
}

/** The email editor: its fields, saving a draft or sending it to 等你审阅. */
export function useEmailEditor(draft?: Partial<EmailDraft> & { id?: string }) {
  const { api, refresh, open, close, notify } = useWorkspace();
  const [to, setTo] = useState(draft?.to?.join(", ") || "");
  const [cc, setCc] = useState(draft?.cc?.join(", ") || "");
  const [bcc, setBcc] = useState(draft?.bcc?.join(", ") || "");
  const [subject, setSubject] = useState(draft?.subject || "");
  const [body, setBody] = useState(draft?.body || "");
  const [attachments, setAttachments] = useState(draft?.attachmentIds || []);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  async function save(review: boolean) {
    setBusy(review ? "review" : "draft");
    setError("");
    try {
      const parsed = emailDraftSchema.safeParse({
        to: addressList(to),
        cc: addressList(cc),
        bcc: addressList(bcc),
        subject,
        body,
        attachmentIds: attachments,
        threadId: draft?.threadId,
        replyToMessageId: draft?.replyToMessageId,
      });
      if (!parsed.success) throw new Error(issueList(parsed.error.issues));
      if (review) {
        const action = await api.request<ActionProposal>("/api/actions", {
          kind: "email.send",
          data: parsed.data,
        });
        await refresh();
        open({ type: "review", action });
      } else {
        await api.request("/api/drafts", {
          ...parsed.data,
          ...(draft?.id ? { id: draft.id } : {}),
        });
        await refresh();
        notify(t.emailSheet.draftSaved);
        close();
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  }
  const toggleAttachment = (id: string) =>
    setAttachments(
      attachments.includes(id) ? attachments.filter((item) => item !== id) : [...attachments, id],
    );
  return {
    to,
    setTo,
    cc,
    setCc,
    bcc,
    setBcc,
    subject,
    setSubject,
    body,
    setBody,
    attachments,
    toggleAttachment,
    busy,
    error,
    save,
  };
}

/** The event editor: its fields, the events it overlaps, and sending it to 等你审阅. */
export function useEventEditor({
  event: e,
  draft,
  neighbors,
}: {
  event?: CalendarEvent;
  draft?: EventDraft;
  neighbors?: CalendarEvent[];
}) {
  const seed = e || draft;
  const { workspace: w, api, open, refresh } = useWorkspace();
  const [initialStart] = useState(() => {
    const value = new Date();
    value.setMinutes(0, 0, 0);
    value.setHours(value.getHours() + 1);
    return value;
  });
  const [title, setTitle] = useState(seed?.title || "");
  const [start, setStart] = useState(seed?.start || initialStart.toISOString());
  const [end, setEnd] = useState(
    seed?.end || new Date(initialStart.getTime() + 3600000).toISOString(),
  );
  const [allDay, setAllDay] = useState(seed?.allDay || false);
  const [zone, setZone] = useState(
    seed?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [location, setLocation] = useState(seed?.location || "");
  const [description, setDescription] = useState(seed?.description || "");
  const [attendees, setAttendees] = useState(seed?.attendees.join(", ") || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const conflicts = (neighbors || w.events).filter(
    (item) =>
      item.id !== e?.id &&
      Date.parse(start) < Date.parse(item.end) &&
      Date.parse(end) > Date.parse(item.start),
  );
  function toggleAllDay() {
    try {
      if (!allDay) {
        const local = localDateTime(start, zone);
        const endDay = new Date(`${local.date}T12:00:00Z`);
        endDay.setUTCDate(endDay.getUTCDate() + 1);
        setStart(local.date);
        setEnd(endDay.toISOString().slice(0, 10));
      } else {
        setStart(zonedInstant(start, "09:00", zone));
        setEnd(zonedInstant(start, "10:00", zone));
      }
      setAllDay(!allDay);
      setError("");
    } catch (cause) {
      setError(errorText(cause));
    }
  }
  async function propose(remove = false) {
    setBusy(true);
    setError("");
    try {
      let data: ProposalInput;
      if (remove && e) {
        data = {
          kind: "calendar.delete",
          data: { eventId: e.id, calendarId: e.calendarId, title: e.title },
        };
      } else {
        const parsed = eventDraftSchema.safeParse({
          calendarId: e?.calendarId || draft?.calendarId || "primary",
          title,
          start,
          end,
          allDay,
          timeZone: zone,
          location,
          description,
          attendees: addressList(attendees),
        });
        if (!parsed.success) throw new Error(issueList(parsed.error.issues));
        data = e
          ? { kind: "calendar.update", data: { ...parsed.data, eventId: e.id } }
          : { kind: "calendar.create", data: parsed.data };
      }
      const action = await api.request<ActionProposal>("/api/actions", data);
      await refresh();
      open({ type: "review", action });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  return {
    title,
    setTitle,
    start,
    setStart,
    end,
    setEnd,
    allDay,
    toggleAllDay,
    zone,
    setZone,
    location,
    setLocation,
    description,
    setDescription,
    attendees,
    setAttendees,
    conflicts,
    busy,
    error,
    propose,
  };
}

/** 等你审阅: the proposal as the server has it now, approving, declining, or editing it (which
 * declines it and opens its editor). */
export function useReview(initial: ActionProposal) {
  const r = t.review;
  const { workspace: w, api, refresh, open } = useWorkspace();
  const [local, setLocal] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const action =
    local.status !== initial.status ? local : w.actions.find((a) => a.id === initial.id) || local;
  async function decide(decision: "approve" | "deny") {
    setBusy(true);
    setError("");
    try {
      const result = await api.request<ActionProposal>(`/api/actions/${action.id}/decide`, {
        decision,
        hash: action.hash,
      });
      setLocal(result);
      await refresh();
    } catch (e) {
      setError(errorText(e));
      // A refusal can change the proposal on the server (one past its expiry is marked expired
      // there): read it again, so 需要你 here agrees with the other projects' counts.
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  /** An expired review out of 需要你: the server marks it expired on any decision (and answers
   * with its expiry refusal, which is the expected answer here, not an error). */
  async function dismissExpired() {
    setBusy(true);
    setError("");
    try {
      setLocal(
        await api.request<ActionProposal>(`/api/actions/${action.id}/decide`, {
          decision: "deny",
          hash: action.hash,
        }),
      );
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 409)) setError(errorText(e));
    } finally {
      await refresh().catch(() => {});
      setBusy(false);
    }
  }
  /** 「以后总是允许」 / 「以后都先问我」 for this kind. */
  const [ruleNote, setRuleNote] = useState("");
  async function setRule(mode: "always" | "ask") {
    setBusy(true);
    setError("");
    try {
      const result = await api.request<{
        action: ActionProposal;
        scope: "account" | "project";
      }>(`/api/actions/${action.id}/rule`, { mode });
      setLocal(result.action);
      setRuleNote(r.ruleSaved(mode, result.scope));
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function edit() {
    setBusy(true);
    setError("");
    try {
      let next: Detail;
      if (action.kind === "email.send")
        next = { type: "email", draft: emailDraftSchema.parse(action.data) };
      else {
        const draft = eventDraftSchema.parse(action.data);
        if (action.kind === "calendar.update") {
          const eventId = action.data.eventId;
          if (typeof eventId !== "string" || !eventId) throw new Error(r.missingEvent);
          next = { type: "event", event: { ...draft, id: eventId } };
        } else next = { type: "event", draft };
      }
      await api.request(`/api/actions/${action.id}/decide`, {
        decision: "deny",
        hash: action.hash,
      });
      await refresh();
      open(next);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  // Past its expiry it can no longer be decided (the server refuses), even before the sweep marks
  // it expired: the sheet shows 已过期 instead of the approve buttons.
  const expired = reviewIsExpired(action);
  return {
    action,
    pending: action.status === "awaiting_review" && !expired,
    expired,
    /** The status the sheet's pill shows (an overdue review reads 已过期). */
    status: expired ? "expired" : action.status,
    /** The card's buttons (允许一次 · 总是允许 · 拒绝; a draft 发送 · 不发). */
    card: reviewCardView(action),
    email: action.kind === "email.send",
    /** A call of a connected app or a Slack message; no form to edit it in. */
    app: action.kind === "app.call" || action.kind === "slack.send",
    busy,
    error,
    decide,
    dismissExpired,
    edit,
    setRule,
    ruleNote,
  };
}

/** When a proposal's window ends, as the person reads a time. */
export function reviewWhen(expiresAt: string): string {
  return new Date(expiresAt).toLocaleString(t.app.lang, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}
/** When a proposal expires, in the person's words. */
export function reviewExpiry(expiresAt: string, noExpiry?: boolean): string {
  if (noExpiry) return "";
  return t.review.expires(reviewWhen(expiresAt));
}

/** A file's PDF form: the typed values and saving a filled copy. */
export function useFileForm(f: Artifact) {
  const { api, refresh, open } = useWorkspace();
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(
      (f.fields || [])
        .filter((field) => field.type !== "unsupported")
        .map((field) => [
          field.name,
          field.type === "checkbox" ? field.value === "true" || field.value === "Yes" : field.value,
        ]),
    ),
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function fill() {
    setBusy(true);
    setError("");
    try {
      const file = await api.request<Artifact>(`/api/files/${f.id}/fill`, { fields: values });
      await refresh();
      open({ type: "file", file });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return { values, setValues, error, setError, busy, fill };
}

/** A browser session: its live state, navigating, reopening, closing, importing its PDFs. */
export function useBrowserSession(initial: BrowserSession) {
  const { workspace: w, api, refresh, close, notify } = useWorkspace();
  const [local, setLocal] = useState(initial);
  const [url, setUrl] = useState(initial.url);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const latest = w.browsers.find((b) => b.id === initial.id);
  const browser = {
    ...(latest && latest.updatedAt > local.updatedAt ? latest : local),
    consoleUrl: local.consoleUrl,
    previewUrl: local.previewUrl,
  };
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void api
      .request<BrowserSession>(`/api/browsers/${initial.id}`)
      .then((session) => {
        if (active) {
          setLocal(session);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      });
    return () => {
      active = false;
    };
  }, [api, initial.id, retry]);
  async function importDownloads() {
    setBusy(true);
    setError("");
    try {
      const result = await api.request<{
        files: Artifact[];
        failures: { name: string; message: string }[];
      }>(`/api/browsers/${browser.id}/import-downloads`, {});
      await refresh();
      if (result.failures.length)
        setError(
          result.failures.map((failure) => `${failure.name}: ${failure.message}`).join("\n"),
        );
      const files = result.files;
      notify(files.length ? t.browserSheet.imported(files.length) : t.browserSheet.noneImported);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function mutate(end = false) {
    if (busy || loading) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.request<BrowserSession>(
        `/api/browsers/${browser.id}/${end ? "close" : browser.status === "closed" ? "reopen" : "navigate"}`,
        end ? {} : { url: browserAddress(url) },
      );
      setLocal(result);
      setUrl(result.url);
      await refresh();
      if (end) close();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return {
    browser,
    url,
    setUrl,
    busy,
    error,
    loading,
    reconnect: () => setRetry((value) => value + 1),
    importDownloads,
    mutate,
  };
}

/** The address bar's button: 打开 again for a closed session, 重新连接 after an error, else 前往. */
export function browserGoLabel(status: BrowserSession["status"]): string {
  const b = t.browserSheet;
  return status === "closed" ? b.reopen : status === "error" ? b.reconnect : b.go;
}
