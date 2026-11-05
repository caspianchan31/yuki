/**
 * Phase C (docs/web.md): the old detail sheets the shell still opens as they are (a mail
 * thread, writing an email, a calendar event, 等你审阅, a PDF, a browser session), from
 * details.tsx. The state is the phone's (details-state.ts); this file draws it.
 */
import { browserSite } from "@m/browser-address";
import {
  arrayText,
  attachmentName,
  browserGoLabel,
  fieldLabel,
  replyDraft,
  reviewExpiry,
  useBrowserSession,
  useEmailEditor,
  useEventEditor,
  useFileForm,
  useMailThread,
  useReview,
} from "@m/details-state";
import { appCallLines } from "@m/shell/apps";
import { fileSourceText, t } from "@m/shell/strings";
import { useWorkspace } from "@m/workspace";
import type {
  ActionProposal,
  Artifact,
  BrowserSession,
  CalendarEvent,
  EmailDraft,
  EventDraft,
  Mail,
} from "@openmuse/domain";
import {
  Check,
  Download,
  Edit3,
  ExternalLink,
  FileText,
  Globe2,
  Reply,
  RotateCw,
  Save,
  Send,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { Btn, ErrorLine, Field, Pill, Sheet, Skeleton, TextArea } from "../ui/primitives";
import { BrowserConsole, Callout, CheckRow, EmptyNote, LinkRow, PdfReader, Subtitle } from "./bits";
import { DateTimeInput } from "./DateTimeInput";
import { openWindow } from "./desktop";

type Close = { onClose: () => void };

function dateLabel(value: string, options?: Intl.DateTimeFormatOptions) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(t.app.lang, options || { month: "short", day: "numeric" });
}
function timeLabel(value: string, timeZone?: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleTimeString(t.app.lang, { hour: "numeric", minute: "2-digit", timeZone });
}
/** The sample workspace's 「Saved to sample sent mail」 in the person's words (ui.tsx). */
function resultSummary(value: string) {
  return /^Saved to (?:sample|local) sent mail(?: · .+)?$/.test(value)
    ? t.review.savedLocally
    : value;
}

/** A result's web address as a link (a sent Slack message's). */
function linked(value: string) {
  return value.split(/(https?:\/\/\S+)/).map((part, index) =>
    /^https?:\/\//.test(part) ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: static split of one string
      <a key={index} href={part} target="_blank" rel="noreferrer">
        {part}
      </a>
    ) : (
      part
    ),
  );
}

export function MailDetail({ mail: m, onClose }: { mail: Mail } & Close) {
  const { workspace: w, open } = useWorkspace();
  const { thread, loading, error, importing, importAttachment, reload } = useMailThread(m);
  return (
    <Sheet title={m.subject} onClose={onClose}>
      <Subtitle>{t.mailSheet.count(thread.length)}</Subtitle>
      {loading ? (
        <div className="lg-msg" role="status" aria-label={t.mailSheet.loading}>
          <Skeleton lines={3} />
        </div>
      ) : null}
      {thread.map((message) => (
        <article key={message.id} className="lg-msg">
          <div
            className="row"
            style={{ justifyContent: "space-between", alignItems: "flex-start" }}
          >
            <div className="grow lg-min">
              <div className="lg-strong">{message.sender}</div>
              <div className="hint">{message.from}</div>
              <div className="hint">{t.mailSheet.to(message.to.join(", "))}</div>
            </div>
            <span className="hint">
              {dateLabel(message.date)} · {timeLabel(message.date)}
            </span>
          </div>
          <div className="lg-body">{message.body}</div>
          {message.attachments.map((id) => {
            const file = w.files.find((f) => f.id === id);
            return file ? (
              <LinkRow
                key={id}
                title={file.name}
                detail={t.mailSheet.attachment(file.pageCount)}
                icon={FileText}
                onClick={() => open({ type: "file", file })}
              />
            ) : (
              <div key={id} className="row">
                <Btn
                  busy={importing === id}
                  icon={FileText}
                  onClick={() => void importAttachment(id)}
                >
                  {attachmentName(id) || t.mailSheet.openAttachment}
                </Btn>
              </div>
            );
          })}
        </article>
      ))}
      <ErrorLine error={error} />
      <div className="row lg-actions">
        {error ? <Btn onClick={reload}>{t.mailSheet.reload}</Btn> : null}
        <Btn
          variant="pri"
          icon={Reply}
          onClick={() => open({ type: "email", draft: replyDraft(m) })}
        >
          {t.mailSheet.reply}
        </Btn>
      </div>
    </Sheet>
  );
}

export function EmailEditor({
  draft,
  onClose,
}: { draft?: Partial<EmailDraft> & { id?: string } } & Close) {
  const { workspace: w } = useWorkspace();
  const e = t.emailSheet;
  const {
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
  } = useEmailEditor(draft);
  return (
    <Sheet title={draft?.threadId ? e.replyTitle : e.newTitle} onClose={onClose}>
      <Subtitle>{w.profile.email ? e.from(w.profile.email) : e.savedPrivately}</Subtitle>
      <form
        className="lg-stack"
        onSubmit={(ev) => {
          ev.preventDefault();
          if (!busy) void save(true);
        }}
      >
        <Field
          label={e.to}
          value={to}
          onChange={(ev) => setTo(ev.target.value)}
          placeholder="person@example.com"
          autoCapitalize="none"
          inputMode="email"
        />
        <div className="lg-pair">
          <Field
            label={e.cc}
            value={cc}
            onChange={(ev) => setCc(ev.target.value)}
            placeholder={e.optional}
            autoCapitalize="none"
          />
          <Field
            label={e.bcc}
            value={bcc}
            onChange={(ev) => setBcc(ev.target.value)}
            placeholder={e.optional}
            autoCapitalize="none"
          />
        </div>
        <Field
          label={e.subject}
          value={subject}
          onChange={(ev) => setSubject(ev.target.value)}
          placeholder={e.subjectPlaceholder}
        />
        <TextArea
          label={e.body}
          value={body}
          onChange={(ev) => setBody(ev.target.value)}
          placeholder={e.bodyPlaceholder}
          rows={9}
        />
        {w.files.length > 0 ? (
          <fieldset className="lg-fieldset">
            <legend>{e.attachments}</legend>
            {w.files.map((f) => (
              <CheckRow
                key={f.id}
                checked={attachments.includes(f.id)}
                label={e.attachment(f.name, Math.max(1, Math.round(f.size / 1024)))}
                onChange={() => toggleAttachment(f.id)}
              />
            ))}
          </fieldset>
        ) : null}
        <ErrorLine error={error} />
        <div className="row">
          <Btn
            type="submit"
            variant="pri"
            icon={ShieldCheck}
            busy={busy === "review"}
            disabled={!!busy}
          >
            {e.review}
          </Btn>
          <Btn
            icon={Save}
            busy={busy === "draft"}
            disabled={!!busy}
            onClick={() => void save(false)}
          >
            {e.saveDraft}
          </Btn>
        </div>
        <p className="hint">{e.reviewHint}</p>
      </form>
    </Sheet>
  );
}

export function EventEditor({
  event: ev,
  draft,
  neighbors,
  onClose,
}: { event?: CalendarEvent; draft?: EventDraft; neighbors?: CalendarEvent[] } & Close) {
  const e = t.eventSheet;
  const {
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
  } = useEventEditor({ event: ev, draft, neighbors });
  return (
    <Sheet title={ev ? e.editTitle : e.newTitle} onClose={onClose}>
      <Subtitle>{ev ? e.editHint : e.newHint}</Subtitle>
      <form
        className="lg-stack"
        onSubmit={(fe) => {
          fe.preventDefault();
          if (!busy) void propose();
        }}
      >
        <Field
          label={e.title}
          value={title}
          onChange={(fe) => setTitle(fe.target.value)}
          placeholder={e.titlePlaceholder}
        />
        <CheckRow label={e.allDay} checked={allDay} onChange={toggleAllDay} />
        <DateTimeInput
          label={e.starts}
          value={start}
          onChange={setStart}
          timeZone={zone}
          allDay={allDay}
        />
        <DateTimeInput
          label={e.ends}
          value={end}
          onChange={setEnd}
          timeZone={zone}
          allDay={allDay}
        />
        {allDay ? <p className="hint">{e.allDayEndHint}</p> : null}
        <Field
          label={e.timeZone}
          value={zone}
          onChange={(fe) => setZone(fe.target.value)}
          placeholder="America/Los_Angeles"
          autoCapitalize="none"
        />
        <Field
          label={e.location}
          value={location}
          onChange={(fe) => setLocation(fe.target.value)}
          placeholder={e.optional}
        />
        <Field
          label={e.attendees}
          value={attendees}
          onChange={(fe) => setAttendees(fe.target.value)}
          placeholder={e.attendeesPlaceholder}
          autoCapitalize="none"
        />
        <TextArea
          label={e.notes}
          value={description}
          onChange={(fe) => setDescription(fe.target.value)}
          placeholder={e.notesPlaceholder}
        />
        {conflicts.length ? (
          <Callout tone="amber" title={e.overlaps}>
            {conflicts.map((c) => (
              <div key={c.id} className="muted">
                {c.title} · {timeLabel(c.start, c.timeZone)}–{timeLabel(c.end, c.timeZone)}
              </div>
            ))}
          </Callout>
        ) : null}
        <ErrorLine error={error} />
        <div className="row">
          <Btn type="submit" variant="pri" icon={ShieldCheck} busy={busy}>
            {ev ? e.reviewChanges : e.reviewEvent}
          </Btn>
          {ev ? (
            <Btn icon={Trash2} disabled={busy} variant="danger" onClick={() => void propose(true)}>
              {e.reviewDeletion}
            </Btn>
          ) : null}
        </div>
      </form>
    </Sheet>
  );
}

function ReviewLine({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="k">{label}</span>
      <span className="lg-select lg-wrap">{value}</span>
    </>
  );
}

/** What the server's check found in the email's statements about the person: the
 * ones no source supports, or that the check did not work. Nothing when it passed. */
function ClaimCheckNotice({ check }: { check: ActionProposal["claimCheck"] }) {
  const r = t.review;
  if (!check || (check.status === "checked" && !check.unsupported.length)) return null;
  return (
    <Callout
      tone="amber"
      title={check.status === "checked" ? r.unsupportedTitle : r.uncheckedTitle}
    >
      <p className="muted" style={{ margin: 0 }}>
        {check.status === "checked" ? r.unsupportedHint : r.uncheckedHint}
      </p>
      {check.status === "checked"
        ? check.unsupported.map((claim) => (
            <div key={claim} className="lg-select">
              · {claim}
            </div>
          ))
        : null}
    </Callout>
  );
}

/** 等你审阅 in Chinese (shell/strings.ts `review`). */
export function ReviewDetail({ initial, onClose }: { initial: ActionProposal } & Close) {
  const r = t.review;
  const { workspace: w } = useWorkspace();
  const {
    action,
    pending,
    expired,
    status,
    email,
    app,
    busy,
    error,
    decide,
    dismissExpired,
    edit,
    setRule,
    ruleNote,
    card,
  } = useReview(initial);
  const d = action.data;
  const when = (value: unknown) => {
    const zone = String(d.timeZone || "UTC");
    const text = String(value || "");
    return `${dateLabel(text, { year: "numeric", month: "short", day: "numeric", timeZone: zone })} · ${timeLabel(text, zone)}`;
  };
  let lines: ReactNode;
  if (email)
    lines = (
      <>
        <div className="kv">
          <ReviewLine label={r.account} value={action.account || w.profile.email} />
          <ReviewLine label={r.to} value={arrayText(d.to)} />
          <ReviewLine label={r.cc} value={arrayText(d.cc) || r.none} />
          <ReviewLine label={r.bcc} value={arrayText(d.bcc) || r.none} />
          <ReviewLine label={r.subject} value={String(d.subject || "")} />
        </div>
        <div className="lg-body">{String(d.body || "")}</div>
        <div className="kv">
          <span className="k">{r.attachments}</span>
          <span>
            {Array.isArray(d.attachmentIds) && d.attachmentIds.length ? (
              d.attachmentIds.map((id) => {
                const file = w.files.find((f) => f.id === id);
                return (
                  <div key={String(id)}>
                    {r.attachmentVersion(file?.name || String(id), String(id).slice(-8))}
                  </div>
                );
              })
            ) : (
              <span className="muted">{r.noAttachments}</span>
            )}
          </span>
        </div>
      </>
    );
  else if (action.kind === "slack.send")
    lines = (
      <>
        <div className="kv">
          <ReviewLine label={r.account} value={action.account || w.profile.email} />
          <ReviewLine
            label={r.slackChannel}
            value={d.channelName ? `#${String(d.channelName)}` : String(d.channel || "")}
          />
          {d.threadTs ? (
            <ReviewLine
              label={r.slackThread}
              value={String(d.threadPreview || `${r.slackThreadOf} ${String(d.threadTs)}`)}
            />
          ) : null}
        </div>
        <div className="lg-body">{String(d.text || "")}</div>
      </>
    );
  else if (app) {
    const argumentLines = appCallLines(d);
    lines = (
      <>
        <div className="kv">
          <ReviewLine label={r.appName} value={String(d.appName || d.app || "")} />
          <ReviewLine label={r.appTool} value={String(d.tool || "")} />
        </div>
        <p className="hint">{r.appArguments}</p>
        <div className="kv">
          {argumentLines.length ? (
            argumentLines.map((line) => (
              <ReviewLine key={line.label} label={line.label} value={line.value} />
            ))
          ) : (
            <ReviewLine label={r.appArguments} value={r.none} />
          )}
        </div>
      </>
    );
  } else
    lines = (
      <>
        <div className="kv">
          <ReviewLine label={r.account} value={action.account || w.profile.email} />
          <ReviewLine label={r.event} value={String(d.title || "")} />
          {action.kind !== "calendar.delete" ? (
            <>
              <ReviewLine
                label={r.starts}
                value={d.allDay ? String(d.start || "") : when(d.start)}
              />
              <ReviewLine
                label={r.ends}
                value={d.allDay ? r.endsExclusive(String(d.end || "")) : when(d.end)}
              />
              <ReviewLine label={r.timeZone} value={String(d.timeZone || "")} />
              <ReviewLine label={r.allDay} value={d.allDay ? r.yes : r.no} />
              <ReviewLine label={r.location} value={String(d.location || r.none)} />
              <ReviewLine label={r.attendees} value={arrayText(d.attendees) || r.justYou} />
              <ReviewLine label={r.notes} value={String(d.description || r.none)} />
            </>
          ) : null}
          <ReviewLine label={r.calendar} value={String(d.calendarId || "primary")} />
        </div>
        <p className="hint">
          {action.kind === "calendar.delete" ? r.deleteWarning : r.inviteWarning}
        </p>
      </>
    );
  return (
    <Sheet
      title={pending ? r.pendingTitle : action.title}
      onClose={onClose}
      footer={
        pending ? (
          <>
            <Btn icon={X} disabled={busy} onClick={() => void decide("deny")}>
              {card.deny}
            </Btn>
            {card.always ? (
              <Btn disabled={busy} onClick={() => void setRule("always")}>
                {card.always}
              </Btn>
            ) : null}
            {action.kind !== "calendar.delete" && !app ? (
              <Btn icon={Edit3} disabled={busy} onClick={() => void edit()}>
                {r.edit}
              </Btn>
            ) : null}
            <Btn variant="pri" icon={Check} busy={busy} onClick={() => void decide("approve")}>
              {card.approve}
            </Btn>
          </>
        ) : expired && action.status === "awaiting_review" ? (
          <>
            {card.always ? (
              <Btn disabled={busy} onClick={() => void setRule("always")}>
                {card.always}
              </Btn>
            ) : null}
            <Btn busy={busy} onClick={() => void dismissExpired()}>
              {r.dismissExpired}
            </Btn>
          </>
        ) : (
          <Btn onClick={onClose}>{r.done}</Btn>
        )
      }
    >
      <Subtitle>{w.mode === "sample" ? r.sampleHint : r.liveHint}</Subtitle>
      <div className="lg-status lg-head">
        <ShieldCheck size={20} className="lg-ico" />
        <div className="grow">
          <div className="lg-strong">{action.title}</div>
          <div className="hint">{r.kinds[action.kind] ?? action.kind}</div>
        </div>
        <Pill tone={pending ? "a" : expired ? "" : "g"}>
          {pending && card.tag ? card.tag : (r.statuses[status] ?? status)}
        </Pill>
      </div>
      <div className="lg-stack">{lines}</div>
      {email ? <ClaimCheckNotice check={action.claimCheck} /> : null}
      <ErrorLine error={error || action.error} />
      {action.result ? (
        <Callout tone="green">
          <span className="lg-select">{linked(resultSummary(action.result))}</span>
        </Callout>
      ) : null}
      {pending && !action.noExpiry ? (
        <p className="hint lg-expiry">{reviewExpiry(action.expiresAt)}</p>
      ) : null}
      {action.reviewReason ? (
        <p className="hint">
          {action.autoApproved === "review"
            ? r.autoByReview(action.reviewReason)
            : r.askedBy(action.reviewReason)}
        </p>
      ) : null}
      {ruleNote ? <p className="hint">{ruleNote}</p> : null}
      {expired ? (
        <Callout tone="amber">
          {card.expiredLine}。{card.always ? r.expiredAlwaysHint : r.expiredHint}
        </Callout>
      ) : null}
    </Sheet>
  );
}

export function FileDetail({ file: f, onClose }: { file: Artifact } & Close) {
  const { api, open } = useWorkspace();
  const { values, setValues, error, setError, busy, fill } = useFileForm(f);
  const url = api.url(f.url || `/api/files/${f.id}/content`);
  return (
    <Sheet title={f.name} onClose={onClose} wide>
      <Subtitle>
        {t.fileSheet.meta(
          f.pageCount,
          Math.max(1, Math.round(f.size / 1024)),
          fileSourceText(f.source),
        )}
      </Subtitle>
      <PdfReader url={url} pageCount={f.pageCount} />
      <div className="row lg-actions">
        <Btn
          icon={Download}
          onClick={() => {
            setError("");
            try {
              openWindow(url);
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          {t.fileSheet.openDownload}
        </Btn>
        <Btn icon={Send} onClick={() => open({ type: "email", draft: { attachmentIds: [f.id] } })}>
          {t.fileSheet.attach}
        </Btn>
      </div>
      {f.fields && f.fields.length > 0 ? (
        <form
          className="lg-box lg-stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) void fill();
          }}
        >
          <div>
            <div className="lg-strong">{t.fileSheet.fillTitle}</div>
            <p className="hint">{t.fileSheet.fillHint}</p>
          </div>
          {f.fields.map((field) =>
            field.type === "unsupported" ? (
              <p key={field.name} className="muted">
                {t.fileSheet.unsupported(field.name)}
              </p>
            ) : field.type === "checkbox" ? (
              <CheckRow
                key={field.name}
                checked={!!values[field.name]}
                label={fieldLabel(field.name)}
                onChange={() => setValues({ ...values, [field.name]: !values[field.name] })}
              />
            ) : (
              <Field
                key={field.name}
                label={fieldLabel(field.name)}
                value={String(values[field.name] || "")}
                onChange={(e) => setValues({ ...values, [field.name]: e.target.value })}
              />
            ),
          )}
          <div className="row">
            <Btn type="submit" variant="pri" icon={Save} busy={busy}>
              {t.fileSheet.saveFilled}
            </Btn>
          </div>
        </form>
      ) : null}
      <ErrorLine error={error} />
      <p className="hint">
        {[t.fileSheet.added(dateLabel(f.createdAt)), f.parentId ? t.fileSheet.filledCopy : ""]
          .filter(Boolean)
          .join(t.common.sep)}
      </p>
    </Sheet>
  );
}

export function BrowserDetail({ initial, onClose }: { initial: BrowserSession } & Close) {
  const { api } = useWorkspace();
  const b = t.browserSheet;
  const { browser, url, setUrl, busy, error, loading, reconnect, importDownloads, mutate } =
    useBrowserSession(initial);
  return (
    <Sheet title={browserSite(browser.url)} onClose={onClose} wide>
      <Subtitle>
        {b.subtitle(b.statuses[browser.status] ?? browser.status, timeLabel(browser.updatedAt))}
      </Subtitle>
      <form
        className="lg-inline"
        onSubmit={(e) => {
          e.preventDefault();
          void mutate();
        }}
      >
        <Field
          label={b.address}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
        />
        <Btn type="submit" variant="pri" busy={busy} disabled={loading || !url.trim()}>
          {browserGoLabel(browser.status)}
        </Btn>
      </form>
      <ErrorLine error={error} />
      {loading ? (
        error ? (
          <div className="row lg-actions">
            <Btn onClick={reconnect}>{b.retryConnection}</Btn>
          </div>
        ) : (
          <div role="status" aria-label={b.connecting} className="lg-actions">
            <div className="sk lg-frame-sk" />
          </div>
        )
      ) : browser.status === "active" && browser.consoleUrl ? (
        <BrowserConsole url={api.url(browser.consoleUrl)} title={b.console} />
      ) : browser.status === "active" && browser.previewUrl ? (
        <img className="lg-shotfull" alt={b.console} src={api.url(browser.previewUrl)} />
      ) : (
        <EmptyNote
          icon={Globe2}
          title={browser.status === "closed" ? b.closedTitle : b.noPreviewTitle}
          detail={browser.status === "closed" ? b.closedDetail : b.noPreviewDetail}
        />
      )}
      {!loading ? (
        <div className="row lg-actions">
          {browser.status === "active" && browser.consoleUrl ? (
            <Btn icon={ExternalLink} onClick={() => openWindow(api.url(browser.consoleUrl || ""))}>
              {b.openWindow}
            </Btn>
          ) : null}
          <Btn icon={RotateCw} disabled={busy} onClick={reconnect}>
            {b.refreshConnection}
          </Btn>
          {browser.status !== "closed" ? (
            <Btn icon={Download} busy={busy} onClick={() => void importDownloads()}>
              {b.importPdfs}
            </Btn>
          ) : null}
          {browser.status !== "closed" ? (
            <Btn icon={X} variant="danger" busy={busy} onClick={() => void mutate(true)}>
              {b.closeSession}
            </Btn>
          ) : null}
        </div>
      ) : null}
    </Sheet>
  );
}
