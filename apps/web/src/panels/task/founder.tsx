/**
 * Phase C (docs/web.md): the space's founder, from shell/founder/* (FounderPanel,
 * FounderSection, FounderRow, SpeakerLine).
 *   FounderPanel   opened from the 创始人 row: opens the founder's own card (its account detail,
 *                  where the priorities and each project's state live); without a founder it says
 *                  what a founder is and how to set one.
 *   FounderSection the section of the founder's card (accounts/FounderSection.tsx, re-exported):
 *                  her 经营, 项目优先级 and 各项目.
 *   FounderRow     创始人 and the founder's name (「未设定」 without one), above the projects.
 *   SpeakerLine    the account that speaks on a chat report card (nothing inside the group chat).
 * Exported for the account detail and the chat, which draw them in their own surfaces.
 */

import { InGroupChat } from "@m/shell/chat/group-context";
import { founderCard, type Speaker } from "@m/shell/founder/founder-core";
import { useFounder } from "@m/shell/founder/useFounder";
import { useShellNav } from "@m/shell/nav";
import { t } from "@m/shell/strings";
import { Crown } from "lucide-react";
import { useContext, useEffect } from "react";
import { Avatar, Sheet, Skeleton } from "../../ui/primitives";
import type { PanelProps } from "../types";

export function FounderPanel({ onClose }: PanelProps<"founder">) {
  const nav = useShellNav();
  const data = useFounder();
  const f = t.founder;
  const card = founderCard(data?.founder);
  useEffect(() => {
    if (card) nav.openPanel(card);
  }, [card?.environmentId, nav.openPanel]);
  return (
    <Sheet title={f.title} onClose={onClose}>
      {data === undefined || card ? (
        <div role="status" aria-label={f.loading}>
          <Skeleton lines={3} />
        </div>
      ) : (
        <div className="tp" style={{ gap: 6 }}>
          <p className="tp-strong">{f.empty}</p>
          <p className="muted">{f.emptyWhy}</p>
          <p className="tp-small">{f.emptyHint}</p>
        </div>
      )}
    </Sheet>
  );
}

/** The founder's section of its own account detail: one component, the account detail's
 * (accounts/FounderSection.tsx), so the web never shows two versions of it. */
export { FounderSection } from "../../accounts/FounderSection";

/** 创始人 · <name> above the projects; opens the founder panel. */
export function FounderRow() {
  const nav = useShellNav();
  const data = useFounder();
  const f = t.founder;
  // Until the first read answers, the name stays empty rather than saying 未设定.
  const name = data === undefined ? "" : (data?.founder?.name ?? null);
  return (
    <button
      type="button"
      className="tp-founder-row"
      aria-label={f.rowLabel(name || null)}
      onClick={() => nav.openPanel({ kind: "founder" })}
    >
      <Crown size={16} style={{ color: "var(--amber)" }} />
      <span className="tp-strong">{f.entry}</span>
      <span className="nm" style={name ? undefined : { color: "var(--fg3)" }}>
        {name === null ? f.unsetName : name}
      </span>
    </button>
  );
}

/** The account that speaks on a chat report card: its initial, its name, 创始人 for the founder. */
export function SpeakerLine({ speaker }: { speaker: Speaker | null }) {
  // The group's turn already names who speaks.
  const inGroup = useContext(InGroupChat);
  if (!speaker || inGroup) return null;
  return (
    <div className="tp-speaker">
      <Avatar initial={speaker.initial} founder={speaker.founder} size={22} />
      <span className="nm">{speaker.name}</span>
      {speaker.founder ? <span className="pill">{t.founder.badge}</span> : null}
    </div>
  );
}
