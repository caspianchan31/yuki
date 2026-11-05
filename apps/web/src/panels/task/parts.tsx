/**
 * Phase C (docs/web.md): small pieces the work panels share — a key/value row with a
 * trailing control, a folded block, an on/off switch, a status flag, the green receipt line, the
 * phase pill and the account light — from shell/task/parts.tsx, shell/components/StatusPill.tsx
 * and shell/components/AccountLight.tsx. Text comes from callers.
 */

import { t } from "@m/shell/strings";
import type { Light } from "@m/shell/theme";
import { Check } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { TaskPhase } from "../../../../../packages/domain/src/task-phase";
import { cx } from "../../ui/primitives";

/** 账号 · <value> · [buttons] (the RN KV with its `right`). */
export function KV({ k, right, children }: { k: string; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="tp-kv">
      <span className="k">{k}</span>
      <div className="v">{children}</div>
      {right ? <div className="r">{right}</div> : null}
    </div>
  );
}

/** A block whose body shows after a click on its label (default closed). */
export function Fold({
  label,
  children,
  initiallyOpen = false,
}: {
  label: string;
  children: ReactNode;
  initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <div className="tp-fold">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        {`${label} ${open ? t.fold.open : t.fold.closed}`}
      </button>
      {open ? children : null}
    </div>
  );
}

/** A small marker on a row; grey for a plain fact (「跑在默认桌面」). */
export function Flag({ text, tone = "amber" }: { text: string; tone?: "amber" | "red" | "grey" }) {
  return <span className={cx("tp-flag", tone !== "amber" && tone)}>{text}</span>;
}

/** ✓ <what you did> · 14:47 */
export function ReceiptLine({ text }: { text: string }) {
  return (
    <span className="tp-receipt">
      <Check size={14} />
      {text}
    </span>
  );
}

/** The phase pill: a dot and the label in the phase tone (amber / red; everything else grey). */
export function StatusPill({ phase }: { phase: Pick<TaskPhase, "label" | "tone"> }) {
  const tone = phase.tone === "amber" ? "a" : phase.tone === "red" ? "r" : "";
  return <span className={cx("pill", "tp-dot-pill", tone)}>{phase.label}</span>;
}

/** One light per account (red / amber need the owner; running and idle are greys). */
export function AccountLight({ light }: { light: Light }) {
  const cls = light === "blue" || light === "teal" ? "" : light;
  return (
    <span
      className={cx("tp-light", cls)}
      role="img"
      aria-label={t.lights[light]}
      title={t.lights[light]}
    />
  );
}

/** A choice row in a panel (prototype .opt), from shell/frame/OptionRow.tsx. */
export function OptionRow({
  title,
  detail,
  selected,
  onClick,
  label,
  leading,
}: {
  title: string;
  detail?: string;
  selected?: boolean;
  onClick: () => void;
  label?: string;
  leading?: ReactNode;
}) {
  return (
    <button
      type="button"
      className={cx("tp-opt", selected && "sel")}
      aria-label={label ?? title}
      aria-current={selected || undefined}
      onClick={onClick}
    >
      {leading}
      <span className="grow">
        <span className="t" style={{ display: "block" }}>
          {title}
        </span>
        {detail ? <span className="d">{detail}</span> : null}
      </span>
      {selected ? <Check size={16} /> : null}
    </button>
  );
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
