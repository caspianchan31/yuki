/**
 * Phase C (docs/web.md): one 需要你 item as a row of the prototype's inbox (.inbox .it: an
 * icon, the title, one line, the primary action), from shell/components/NeedCard.tsx at parity.
 * The row unfolds inline for what does not fit one line: the answer box of a question (one
 * input per requested field, else free text; 发送回答, and 立即继续 when the task only waits to be
 * told to go on), the steps to do on a desktop, 「当时的画面」, and every other button the card has.
 * Kinds (decision 4 only):
 *   task / input      the question → POST …/input
 *   task / approval   等你审阅 (upstream email / calendar draft) → the review sheet
 *   task / fail       the full error and 重试 → POST …/control retry; an account's standing
 *                     loop that stopped (failed or paused): 经营停了 / 经营暂停了 with 重试 or 恢复
 *                     (model.ts stopNeed), for as long as it is stopped
 *   review            an upstream proposal awaiting review → the review sheet
 *   account           desktop error / logins → the account's desktop, the login editor,
 *                     the credentials page, 看账号; not operating
 *                     (no goal, no job) → 定长期目标 (its detail), 在聊天里派活… (the chat)
 *   project           the project's own logins → the login editor or its default desktop
 * After acting the row collapses to a one-line receipt (nav.receipts), here and in the chat at
 * once. Never offers an approval for a site action. The state (what each item offers, the flows
 * its buttons open) is shared with the phone: shell/components/need-card-state.ts.
 */

import { incidentShotPath } from "@m/incidents-core";
import { useTaskActions } from "@m/shell/actions";
import {
  answerPayload,
  missingFieldsOf,
  receiptForNeed,
  receiptLine,
  reviewLine,
} from "@m/shell/chat/core";
import { needGuideKeys } from "@m/shell/chat/guide-core";
import {
  accountNeedModel,
  type NeedVariant,
  projectNeedModel,
  useNeedFlows,
  useOpenReview,
} from "@m/shell/components/need-card-state";
import { useShellData } from "@m/shell/data";
import {
  type AccountModel,
  accountNeedLine,
  type NeedItem,
  needShots,
  projectNeedLine,
  stopNeed,
} from "@m/shell/model";
import { useShellNav } from "@m/shell/nav";
import { phaseWords, t } from "@m/shell/strings";
import {
  ChevronDown,
  ChevronUp,
  CircleAlert,
  FileText,
  KeyRound,
  MessageCircleQuestion,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { AgentTask } from "../../../../packages/domain/src/agent";
import { clockLabel, durationLabel } from "../../../../packages/domain/src/task-phase";
import { peekAccount } from "../shell/state";
import { Btn, ErrorLine, IconBtn } from "../ui/primitives";
import { IncidentShot, Receipt, StatusPill } from "./parts";

export interface NeedRowProps {
  item: NeedItem;
  /** rail: 需要你 (the page, the pane): what a chat card already asks for reads one line. */
  variant?: NeedVariant;
  /** When the need was raised (the report's time in chat). */
  at?: string;
}

export function NeedRow({ item, variant = "rail", at }: NeedRowProps) {
  const nav = useShellNav();
  const { now } = useShellData();
  const receipt = receiptForNeed(item, nav.receipts);
  if (receipt)
    return (
      <div className="it">
        <span />
        <div style={{ minWidth: 0, gridColumn: "2 / 4" }}>
          <Receipt text={receiptLine(receipt, now)} />
        </div>
      </div>
    );
  switch (item.kind) {
    case "task":
      return <TaskNeed item={item} at={at} />;
    case "review":
      return <ReviewNeed item={item} />;
    case "account":
      return <AccountNeed item={item} variant={variant} />;
    case "project":
      return <ProjectNeed item={item} variant={variant} />;
  }
}

/** The row frame: icon, the title block (meta, title, one line, then the unfolded body), the
 * primary action and, when there is more, the fold toggle. */
function Row({
  red,
  icon,
  label,
  meta,
  title,
  desc,
  primary,
  open,
  onToggle,
  after,
  children,
}: {
  red: boolean;
  icon: ReactNode;
  label: string;
  meta?: ReactNode;
  title: ReactNode;
  desc?: ReactNode;
  primary?: ReactNode;
  open?: boolean;
  onToggle?: () => void;
  /** Always shown under the line (an error). */
  after?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <article className="it" aria-label={label}>
      <span className={`ic ${red ? "r" : "a"}`} aria-hidden="true">
        {icon}
      </span>
      <div style={{ minWidth: 0 }}>
        {meta ? <div className="meta">{meta}</div> : null}
        <div className="t">{title}</div>
        {desc ? <div className="d">{desc}</div> : null}
        {after}
        {open && children ? <div className="body">{children}</div> : null}
      </div>
      <div className="b row" style={{ gap: 4, flexWrap: "nowrap" }}>
        {primary}
        {onToggle ? (
          <IconBtn
            icon={open ? ChevronUp : ChevronDown}
            label={open ? t.needs.collapse : t.needs.expand}
            aria-expanded={open}
            onClick={onToggle}
          />
        ) : null}
      </div>
    </article>
  );
}

/** The account of a task: its chip (opens the account), 「跑在默认桌面」 when unbound, or
 * 「账号已不在本项目」 when it names an account this project no longer has. */
function TaskAccount({
  environmentId,
  account,
  loading,
}: {
  environmentId: string | null;
  account: AccountModel | null;
  loading: boolean;
}) {
  if (account)
    return (
      <button type="button" className="chip" onClick={() => peekAccount(account.id)}>
        <span className="t">{account.name}</span>
      </button>
    );
  if (!environmentId) return null;
  if (loading) return null;
  return <span className="pill">{t.needs.accountGone}</span>;
}

function TaskNeed({ item, at }: { item: Extract<NeedItem, { kind: "task" }>; at?: string }) {
  const { now, accounts } = useShellData();
  const actions = useTaskActions();
  const review = useOpenReview();
  const { entry, account } = item;
  const { task, phase } = entry;
  const [open, setOpen] = useState(false);
  const when = clockLabel(at ?? phase.at ?? task.updatedAt, now, phaseWords);
  const busy = actions.busy?.taskId === task.id;
  const error = actions.error?.taskId === task.id ? actions.error.message : "";
  const meta = (
    <>
      <StatusPill phase={phase} />
      {when ? <span>{when}</span> : null}
      <TaskAccount
        environmentId={entry.environmentId}
        account={account}
        loading={accounts.loading}
      />
    </>
  );
  const title = <span>{task.title}</span>;
  const label = `${phase.label}${t.common.sep}${task.title}`;
  if (phase.key === "input") {
    const question = phase.reason === "question" ? task.question?.trim() || phase.sub : phase.sub;
    return (
      <Row
        red={false}
        icon={<MessageCircleQuestion size={14} />}
        label={label}
        meta={meta}
        title={title}
        desc={question}
        open={open}
        primary={
          open ? null : (
            <Btn variant="pri" onClick={() => setOpen(true)}>
              {t.needs.answer}
            </Btn>
          )
        }
        onToggle={open ? () => setOpen(false) : undefined}
      >
        <AnswerBox task={task} continueNow={phase.reason !== "question"} />
      </Row>
    );
  }
  if (phase.key === "approval") {
    const action = review.known(task.actionId);
    return (
      <Row
        red={false}
        icon={<FileText size={14} />}
        label={label}
        meta={meta}
        title={title}
        desc={
          action
            ? reviewLine(action, now, (ms) => durationLabel(ms, phaseWords), task.title)
            : task.question?.trim() || phaseWords.approval
        }
        after={<ErrorLine error={review.error} />}
        primary={
          <Btn variant="pri" busy={review.busy} onClick={() => void review.open(task.actionId)}>
            {t.needs.review}
          </Btn>
        }
      />
    );
  }
  // A failure, or an account's standing loop that stopped (failed or paused).
  const stop = stopNeed(entry);
  return (
    <Row
      red={phase.key === "fail"}
      icon={<CircleAlert size={14} />}
      label={label}
      meta={meta}
      title={title}
      desc={stop.text}
      after={<ErrorLine error={error} />}
      primary={
        <Btn busy={busy} onClick={() => void actions.control(task.id, stop.op)}>
          {stop.label}
        </Btn>
      }
    />
  );
}

function ReviewNeed({ item }: { item: Extract<NeedItem, { kind: "review" }> }) {
  const { now } = useShellData();
  const review = useOpenReview();
  const { action, entry } = item;
  return (
    <Row
      red={false}
      icon={<FileText size={14} />}
      label={`${phaseWords.labels.approval}${t.common.sep}${action.title}`}
      meta={
        <>
          <StatusPill phase={{ label: phaseWords.labels.approval, tone: "amber" }} />
          <span>{clockLabel(action.createdAt, now, phaseWords)}</span>
        </>
      }
      title={entry?.task.title ?? action.title}
      desc={reviewLine(
        action,
        now,
        (ms) => durationLabel(ms, phaseWords),
        entry?.task.title ?? action.title,
      )}
      after={<ErrorLine error={review.error} />}
      primary={
        <Btn variant="pri" busy={review.busy} onClick={() => void review.open(action.id)}>
          {t.needs.review}
        </Btn>
      }
    />
  );
}

/** 「当时的画面」 of each flagged site whose latest incident kept the desktop's picture. */
function NeedShots({ item }: { item: NeedItem }) {
  const shots = needShots(item);
  return shots.length ? (
    <div className="row" style={{ gap: 10 }}>
      {shots.map((shot) => (
        <IncidentShot key={shot.id} path={incidentShotPath(shot.id)} site={shot.site} />
      ))}
    </div>
  ) : null;
}

/** 「在聊天里填」, the chat's card for this need. */
function useGuideButton(item: NeedItem): ReactNode {
  const nav = useShellNav();
  const [key] = needGuideKeys(item);
  return key ? (
    <Btn key="guide" onClick={() => nav.showGuide(key)}>
      {t.guide.inChat}
    </Btn>
  ) : null;
}

/** One button with a key, so the first can move to the primary slot. */
type Action = { key: string; node: ReactNode };

function AccountNeed({
  item,
  variant,
}: {
  item: Extract<NeedItem, { kind: "account" }>;
  variant: NeedVariant;
}) {
  const nav = useShellNav();
  const flows = useNeedFlows();
  const guide = useGuideButton(item);
  const [open, setOpen] = useState(false);
  const { account, flags } = item;
  const m = accountNeedModel(item, variant);
  const _toCredentials = () => nav.setView("credentials");
  // In the card's order; the most direct one (the desktop) leads.
  const actions: Action[] = [];
  if (m.desktop)
    actions.push({
      key: "desktop",
      node: (
        <Btn variant="pri" onClick={() => flows.accountDesktop(account, flags, m.need)}>
          {t.needs.openDesktop}
        </Btn>
      ),
    });
  if (m.login) {
    const site = m.login.site;
    actions.push({
      key: "login",
      node: (
        <Btn onClick={() => flows.loginEditor(site, account)}>
          {m.wrongPassword ? t.needs.replaceLogin : t.needs.addLogin}
        </Btn>
      ),
    });
  }
  if (guide) actions.push({ key: "guide", node: guide });
  actions.push({
    key: "account",
    node: <Btn onClick={() => peekAccount(account.id)}>{t.needs.openAccount}</Btn>,
  });
  const [first, ...rest] = actions;
  const more = rest.length > 0 || m.steps.length > 0 || needShots(item).length > 0;
  return (
    <Row
      red
      icon={account.name.trim().charAt(0).toUpperCase()}
      label={account.name}
      title={
        <button type="button" onClick={() => peekAccount(account.id)}>
          {account.name}
        </button>
      }
      desc={accountNeedLine(item, m)}
      primary={first?.node}
      open={open}
      onToggle={more ? () => setOpen((v) => !v) : undefined}
    >
      <Steps steps={m.steps} />
      <NeedShots item={item} />
      {rest.length ? (
        <div className="row" style={{ gap: 6 }}>
          {rest.map((action) => (
            <span key={action.key}>{action.node}</span>
          ))}
        </div>
      ) : null}
    </Row>
  );
}

function ProjectNeed({
  item,
  variant,
}: {
  item: Extract<NeedItem, { kind: "project" }>;
  variant: NeedVariant;
}) {
  const nav = useShellNav();
  const flows = useNeedFlows();
  const guide = useGuideButton(item);
  const [open, setOpen] = useState(false);
  const m = projectNeedModel(item, variant);
  const toCredentials = () => nav.setView("credentials");
  const actions: Action[] = [];
  if (m.desktop)
    actions.push({
      key: "desktop",
      node: (
        <Btn variant="pri" onClick={() => flows.projectDesktop(item.flags, m.need)}>
          {t.needs.openDefaultDesktop}
        </Btn>
      ),
    });
  for (const login of m.logins)
    actions.push({
      key: `login:${login.site}`,
      node: login.replace ? (
        <Btn onClick={toCredentials}>{t.needs.replaceLogin}</Btn>
      ) : (
        <Btn onClick={() => flows.loginEditor(login.site, null)}>
          {m.logins.length > 1 ? t.needs.addLoginFor(login.site) : t.needs.addLogin}
        </Btn>
      ),
    });
  if (guide) actions.push({ key: "guide", node: guide });
  const [first, ...rest] = actions;
  const more = rest.length > 0 || m.steps.length > 0 || needShots(item).length > 0;
  return (
    <Row
      red
      icon={<KeyRound size={14} />}
      label={t.needs.projectTitle}
      title={t.needs.projectTitle}
      desc={projectNeedLine(item, m)}
      primary={first?.node}
      open={open}
      onToggle={more ? () => setOpen((v) => !v) : undefined}
    >
      <Steps steps={m.steps} />
      <NeedShots item={item} />
      {rest.length ? (
        <div className="row" style={{ gap: 6 }}>
          {rest.map((action) => (
            <span key={action.key}>{action.node}</span>
          ))}
        </div>
      ) : null}
    </Row>
  );
}

/** One line per reason of what to do on the desktop. */
function Steps({ steps }: { steps: string[] }) {
  return (
    <>
      {steps.map((step) => (
        <div key={step} className="step">
          {step}
        </div>
      ))}
    </>
  );
}

/** The answer box: one input per requested field (state.missingFields), else free text (Enter
 * sends, Shift+Enter is a new line); 发送回答, and 立即继续 when the task only waits to go on. */
function AnswerBox({ task, continueNow }: { task: AgentTask; continueNow: boolean }) {
  const actions = useTaskActions();
  const fields = useMemo(() => missingFieldsOf(task), [task]);
  const [text, setText] = useState("");
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const payload = answerPayload(text, values, fields);
  const busy = actions.busy?.taskId === task.id;
  // The box opens on 回答: the first input takes the keyboard.
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => form.current?.querySelector<HTMLElement>("input, textarea")?.focus(), []);
  const send = async () => {
    if (!payload || busy) return;
    if (await actions.answer(task.id, payload.answer, payload.fields)) {
      setText("");
      setValues({});
    }
  };
  return (
    <form
      ref={form}
      style={{ display: "flex", flexDirection: "column", gap: 8 }}
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      {fields.map((field) =>
        field.checkbox ? (
          <label key={field.name} className="need-check">
            <input
              type="checkbox"
              checked={values[field.name] === true}
              onChange={() =>
                setValues((current) => ({
                  ...current,
                  [field.name]: current[field.name] !== true,
                }))
              }
            />
            {field.label}
          </label>
        ) : (
          <label key={field.name} className="field">
            <span>{field.label}</span>
            <input
              className="input"
              value={typeof values[field.name] === "string" ? String(values[field.name]) : ""}
              onChange={(e) => {
                const value = e.target.value;
                setValues((current) => ({ ...current, [field.name]: value }));
              }}
            />
          </label>
        ),
      )}
      {!fields.length ? (
        <textarea
          className="input"
          aria-label={t.needs.answer}
          placeholder={t.needs.answerPlaceholder}
          value={text}
          rows={3}
          style={{ minHeight: 64 }}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
      ) : null}
      <div className="row" style={{ gap: 6 }}>
        <Btn
          type="submit"
          variant="pri"
          busy={busy && actions.busy?.action === "input"}
          disabled={!payload || busy}
        >
          {t.needs.send}
        </Btn>
        {continueNow ? (
          <Btn disabled={busy} onClick={() => void actions.answer(task.id, t.needs.continueAnswer)}>
            {t.needs.continueNow}
          </Btn>
        ) : null}
      </div>
      <ErrorLine error={actions.error?.taskId === task.id ? actions.error.message : ""} />
    </form>
  );
}
