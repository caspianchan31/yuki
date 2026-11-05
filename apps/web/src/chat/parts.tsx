/**
 * Phase C (docs/web.md): the conversation's building blocks in the prototype's block timeline
 * (.blk: avatar, head line who / tag / time, body, .chips, hover .acts), from shell/chat/Speaker.tsx,
 * Group.tsx and pieces.tsx (the receipt, the account chip, the flag, the card header), plus the
 * status pill (components/StatusPill.tsx) and an incident's picture (components/IncidentShot.tsx),
 * which the RN chat draws from shared component files.
 */
// v1.2: the capybara is gone: Yuki, the main member, is the black flake with the gold
// star (ui/MemberFace), a project's 运营专员 the face its name picks.

import type { GroupSpeaker, GroupTurn } from "@m/shell/chat/group-core";
import { useOpsName } from "@m/shell/chat/group-state";
import { useShellData } from "@m/shell/data";
import type { AccountModel } from "@m/shell/model";
import { t } from "@m/shell/strings";
import type { Light } from "@m/shell/theme";
import { useWorkspace } from "@m/workspace";
import { Check, X } from "lucide-react";
import { type ReactNode, useContext, useEffect, useState } from "react";
import type { TaskPhase } from "../../../../packages/domain/src/task-phase";
import { peekAccount } from "../shell/state";
import { MemberFace } from "../ui/MemberFace";
import { faceOf } from "../ui/member-face";
import { cx, Pill, type Tone } from "../ui/primitives";
import { InGroup } from "./context";

/** A block's face: Yuki (the black flake with the gold star), a project's 运营专员
 * (a face picked from its name), an account's member face (the founder's starred), or none. */
export function SpeakerAvatar({ speaker }: { speaker: GroupSpeaker }) {
  const { accounts } = useShellData();
  const named = speaker.kind === "ops" ? speaker.name : null;
  const member = named ? accounts.value.find((account) => account.name === named) : undefined;
  // v1.2: an ops speaker with no name is Yuki, the main member; a named one is a
  // project's 运营专员 (the design's 负责人), a face picked from its name like any member.
  if (speaker.kind === "ops")
    return (
      <span className="bav face" aria-hidden="true">
        {speaker.name && speaker.name !== t.app.name ? (
          <MemberFace {...faceOf({ name: speaker.name, face: member?.view.face })} size={24} />
        ) : (
          <MemberFace shape="flake" color="var(--fg)" size={24} star />
        )}
      </span>
    );
  // v1.2: the face she was made with when this project has her (by id, else by name, which is
  // unique); otherwise the one her name picks.
  if (speaker.kind === "account") {
    const known = accounts.value.find((account) =>
      speaker.environmentId ? account.id === speaker.environmentId : account.name === speaker.name,
    );
    return (
      <span className="bav face" aria-hidden="true">
        <MemberFace
          {...faceOf({ name: speaker.name, face: known?.view.face })}
          size={24}
          star={speaker.founder}
        />
      </span>
    );
  }
  return <span aria-hidden="true" />;
}

/**
 * One block of the timeline. The avatar and the head line show on the first item of a speaker's
 * run (`turn.head`); the hover actions (.acts) sit at its top right (always shown on a phone).
 */
export function Block({
  turn,
  time,
  tag,
  tone,
  open,
  acts,
  label,
  who,
  children,
}: {
  turn: GroupTurn;
  time?: string;
  tag?: ReactNode;
  tone?: "need" | "fail" | "sys";
  /** The 原文 quote is shown (.blk.open .quote). */
  open?: boolean;
  acts?: ReactNode;
  label?: string;
  /** What leads the head line instead of the speaker's name (a stop report: the task's title). */
  who?: ReactNode;
  children: ReactNode;
}) {
  const { speaker, head } = turn;
  // An assistant item without a name is this conversation's assistant
  // (Yuki, or the project's 运营专员).
  const ops = useOpsName();
  const inGroup = useContext(InGroup);
  const name =
    speaker.kind === "ops" ? speaker.name || ops : speaker.kind === "account" ? speaker.name : "";
  const memberId = speaker.kind === "account" ? speaker.environmentId : undefined;
  const jump = inGroup && head && memberId && name ? memberId : null;
  if (head && who)
    return (
      <article className={cx("blk", open && "open")} aria-label={label}>
        <SpeakerAvatar speaker={speaker} />
        <div style={{ minWidth: 0 }}>
          <div className="head">
            {who}
            {tag}
            {time ? <span className="tm">{time}</span> : null}
          </div>
          {children}
          {jump ? (
            <button type="button" className="member-jump" onClick={() => peekAccount(jump)}>
              {t.chat.openMember(name)}
            </button>
          ) : null}
        </div>
        {acts ? <div className="acts">{acts}</div> : null}
      </article>
    );
  return (
    <article
      className={cx(
        "blk",
        tone === "need" && "need",
        tone === "fail" && "need fail",
        tone === "sys" && "sys",
        open && "open",
      )}
      aria-label={label}
    >
      {head ? <SpeakerAvatar speaker={speaker} /> : <span aria-hidden="true" />}
      <div style={{ minWidth: 0 }}>
        {head && name ? (
          <div className="head">
            <span className="who">{name}</span>
            {speaker.kind === "account" && speaker.founder ? (
              <span className="tag f">{t.group.founderTag}</span>
            ) : null}
            {tag}
            {time ? <span className="tm">{time}</span> : null}
          </div>
        ) : time || tag ? (
          <div className="head">
            {tag}
            {time ? <span className="tm">{time}</span> : null}
          </div>
        ) : null}
        {children}
        {jump ? (
          <button type="button" className="member-jump" onClick={() => peekAccount(jump)}>
            {t.chat.openMember(name)}
          </button>
        ) : null}
      </div>
      {acts ? <div className="acts">{acts}</div> : null}
    </article>
  );
}

/** 「✓ 你点了重试，任务重新运行 · 14:48」 centred in the transcript. */
export function ReceiptLine({ text }: { text: string }) {
  return (
    <div className="receipt" role="status">
      <Check size={14} />
      <span>{text}</span>
    </div>
  );
}

/** An account's light (design §4.4). */
export function AccountLight({ light }: { light: Light }) {
  return <span className={cx("light", light)} aria-hidden="true" />;
}

/** The account chip (.achip): light + name. It opens her conversation. */
export function AccountChip({ account }: { account: AccountModel }) {
  return (
    <button type="button" className="achip" onClick={() => peekAccount(account.id)}>
      <AccountLight light={account.light} />
      <span className="t">{account.name}</span>
    </button>
  );
}

/** A small tag (.flag): 「跑在默认桌面」, 「账号已不在本项目」. */
export function Flag({ text }: { text: string }) {
  return <span className="flag">{text}</span>;
}

/** The account of a task wherever it is shown: the chip, 「跑在默认桌面」 when unbound, or
 * 「账号已不在本项目」 when it names an account this project no longer has. */
export function TaskAccount({
  environmentId,
  account,
  accountsLoading,
}: {
  environmentId: string | null;
  account: AccountModel | null;
  accountsLoading?: boolean;
}) {
  if (account) return <AccountChip account={account} />;
  if (!environmentId) return null;
  if (accountsLoading) return null;
  return <Flag text={t.needs.accountGone} />;
}

/** The status pill: the phase label in its tone (only red and amber are coloured). */
export function StatusPill({ phase }: { phase: Pick<TaskPhase, "label" | "tone"> }) {
  const tone: Tone = phase.tone === "red" ? "r" : phase.tone === "amber" ? "a" : "";
  return <Pill tone={tone}>{phase.label}</Pill>;
}

/** A quiet text button (查看任务 ›, 详情 ›). */
export function LinkBtn({
  onClick,
  children,
  label,
}: {
  onClick: () => void;
  children: ReactNode;
  label?: string;
}) {
  return (
    <button type="button" className="linkbtn" onClick={onClick} aria-label={label}>
      {children}
    </button>
  );
}

/** A picture the API serves to the signed-in person only, read with the session as a blob. */
export function useAuthedImage(path: string | null): {
  state: "loading" | "image" | "none";
  src?: string;
  fail: () => void;
} {
  const { api } = useWorkspace();
  const [picture, setPicture] = useState<{ state: "loading" | "image" | "none"; src?: string }>({
    state: path ? "loading" : "none",
  });
  useEffect(() => {
    if (!path) {
      setPicture({ state: "none" });
      return;
    }
    let active = true;
    let objectUrl: string | null = null;
    setPicture({ state: "loading" });
    fetch(api.url(path), { headers: api.headers(), cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const blob = await response.blob();
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setPicture({ state: "image", src: objectUrl });
      })
      .catch(() => {
        if (active) setPicture({ state: "none" });
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [api, path]);
  return { ...picture, fail: () => setPicture({ state: "none" }) };
}

/** 「当时的画面」: a thumbnail of the incident's picture at `path`; click → full size. */
export function IncidentShot({ path, site }: { path: string; site?: string | null }) {
  const picture = useAuthedImage(path);
  const [open, setOpen] = useState(false);
  const s = t.incidentShots;
  const label = site ? s.thumbAlt(site) : s.thumb;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  if (picture.state === "none") return <span className="hint">{s.missing}</span>;
  return (
    <>
      <button
        type="button"
        className="incident"
        aria-label={`${label}${t.common.colon}${s.open}`}
        disabled={picture.state !== "image"}
        onClick={() => setOpen(true)}
      >
        {picture.state === "image" ? (
          <img src={picture.src} alt={label} onError={picture.fail} />
        ) : (
          <span className="ph-img" role="status" aria-label={s.loading}>
            <span className="spin" />
          </span>
        )}
        <span>{site ? `${s.thumb} · ${site}` : s.thumb}</span>
      </button>
      {open && picture.state === "image" ? (
        <div
          className="shot-ovl"
          role="dialog"
          aria-modal="true"
          aria-label={label}
          onMouseDown={() => setOpen(false)}
        >
          <button
            type="button"
            className="row"
            style={{ color: "inherit" }}
            onClick={() => setOpen(false)}
            aria-label={t.common.close}
          >
            {label}
            <X size={18} />
          </button>
          <img src={picture.src} alt={label} />
        </div>
      ) : null}
    </>
  );
}
