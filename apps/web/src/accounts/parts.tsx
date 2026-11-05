/**
 * Phase C (docs/web.md): the small pieces only the 账号与代理 area draws, from
 * shell/accounts/parts.tsx and shell/components/AccountLight.tsx (the prototype's .info, .ptag,
 * .opt, .confirm, the account light), plus the account's face, a key/value row and a block, in
 * the DOM. Shared building blocks stay in ui/primitives.tsx.
 */

import type { PersonRow } from "@m/shell/accounts/people-core";
import type { MemberState } from "@m/shell/members/members-core";
import { t } from "@m/shell/strings";
import type { Light } from "@m/shell/theme";
import { ChevronRight, Info } from "lucide-react";
import type { ReactNode } from "react";
import type { TaskPhase } from "../../../../packages/domain/src/task-phase";
import { dotOf } from "../shell/faces";
import { Avatar, cx, Pill, type Tone } from "../ui/primitives";
import "./accounts.css";

/** One light per account (design §4.4): red, amber, a still grey, a paler grey, hollow. */
export function AccountLight({ light }: { light: Light }) {
  return <span className={cx("acc-light", light)} role="img" aria-label={t.lights[light]} />;
}

/** The prototype's .info note. */
export function InfoNote({ children }: { children: ReactNode }) {
  return (
    <div className="acc-info">
      <Info size={14} aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}

/** The prototype's .ptag: a small grey label (默认, 创始人). */
export function Tag({ children }: { children: ReactNode }) {
  return <span className="acc-tag">{children}</span>;
}

/** The prototype's .confirm / warning box: a tinted block with a message and buttons. */
export function ConfirmBox({
  text,
  tone = "red",
  children,
}: {
  text: string;
  tone?: "red" | "amber";
  children?: ReactNode;
}) {
  return (
    <div className={cx("acc-confirm", tone === "amber" && "amber")} role="alert">
      <p>{text}</p>
      {children ? <div className="row">{children}</div> : null}
    </div>
  );
}

/** The prototype's .opt: a full-width choice (target project). */
export function OptionRow({
  title,
  subtitle,
  onClick,
  disabled,
  busy,
}: {
  title: string;
  subtitle?: string;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      className="acc-opt"
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      onClick={onClick}
    >
      <span className="grow">
        <span className="t" style={{ display: "block" }}>
          {title}
        </span>
        {subtitle ? <span className="acc-small">{subtitle}</span> : null}
      </span>
      {busy ? <span className="spin" /> : <ChevronRight size={16} aria-hidden="true" />}
    </button>
  );
}

/** A row of the account detail: the key, the value (any lines) and buttons on the right. */
export function KV({ k, right, children }: { k: string; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="acc-kv">
      <span className="k">{k}</span>
      <div className="v">{children}</div>
      {right ? <div className="r">{right}</div> : <span />}
    </div>
  );
}

/** A titled block of the detail (人设, 长期目标, 这个号上的任务…). */
export function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="acc-block">
      <h4>{title}</h4>
      {children}
    </section>
  );
}

/** Quick picks under a text field (time zones, languages). */
export function Chips({
  values,
  onPick,
  label,
}: {
  values: readonly string[];
  onPick: (value: string) => void;
  label?: string;
}) {
  if (!values.length) return null;
  return (
    <div className="acc-picks">
      {label ? <span className="acc-small">{label}</span> : null}
      {values.map((value) => (
        <button key={value} type="button" className="chip" onClick={() => onPick(value)}>
          {value}
        </button>
      ))}
    </div>
  );
}

const phaseTone = (tone: TaskPhase["tone"]): Tone =>
  tone === "red" ? "r" : tone === "amber" ? "a" : "";

/** A task's phase as the prototype's .pill (amber and red only; the rest is grey). */
export function PhasePill({ phase }: { phase: Pick<TaskPhase, "label" | "tone"> }) {
  return <Pill tone={phaseTone(phase.tone)}>{phase.label}</Pill>;
}

/** The colour class of a member line (red for 要你, amber for 卡住, else the text colour). */
export const lineClass = (state: MemberState) =>
  state === "needs" ? "acc-redtext" : state === "blocked" ? "acc-ambertext" : "";

/** The account's face at the top of its detail: the avatar with its state dot, what it is doing
 * and its 经营循环. */
export function Face({ person }: { person: PersonRow }) {
  return (
    <div className="acc-face">
      <Avatar
        initial={person.initial}
        founder={person.founder}
        state={dotOf[person.state]}
        size={56}
      />
      <div className="acc-stack tight">
        <span className={cx("line", lineClass(person.state))}>{person.line}</span>
        {person.routine ? <span className="acc-faint">{person.routine}</span> : null}
        {person.label ? <span className="acc-small">{person.label}</span> : null}
      </div>
    </div>
  );
}
