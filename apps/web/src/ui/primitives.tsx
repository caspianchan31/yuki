/**
 * Phase C (docs/web.md): the web app's building blocks, one per class of app.css (.btn,
 * .field, .sheet, .avatar, .pill, .sk…). Plain DOM: hover, focus and keyboard come from the
 * browser. Every surface of apps/web builds on these instead of styling on its own.
 */

import { serverText, t } from "@m/shell/strings";
import type { LucideIcon } from "lucide-react";
import { X } from "lucide-react";
import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type TextareaHTMLAttributes,
  useEffect,
  useId,
  useRef,
} from "react";

const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");

export { cx };

export function Btn({
  variant,
  icon: Icon,
  busy,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "pri" | "danger" | "block";
  icon?: LucideIcon;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || busy}
      className={cx("btn", variant, className)}
    >
      {busy ? <span className="spin" /> : Icon ? <Icon size={14} /> : null}
      {children}
    </button>
  );
}

/** A quiet icon button of the top bar and the panes (.tb-btn). */
export function IconBtn({
  icon: Icon,
  label,
  on,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string; on?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...rest}
      className={cx("tb-btn", on && "on", className)}
    >
      <Icon size={15} />
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: ReactNode;
  /** The input itself (React 19 passes it through `rest`), for a field focused on demand. */
  ref?: Ref<HTMLInputElement>;
}) {
  const id = useId();
  return (
    <label className="field" htmlFor={id}>
      <span>{label}</span>
      <input id={id} className="input" {...rest} />
      {hint ? <small className="hint">{hint}</small> : null}
    </label>
  );
}

export function TextArea({
  label,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string }) {
  const id = useId();
  return (
    <label className="field" htmlFor={id}>
      <span>{label}</span>
      <textarea id={id} className="input" {...rest} />
    </label>
  );
}

/** A server or network error, in the person's words (serverText). */
export function ErrorLine({ error }: { error?: string | null }) {
  if (!error) return null;
  return (
    <p className="err" role="alert">
      {serverText(error)}
    </p>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="row muted" role="status">
      <span className="spin" />
      {label}
    </span>
  );
}

/** Skeleton lines in place of a loading text (design: structure first, never 「正在加载…」). */
export function Skeleton({ lines = 4 }: { lines?: number }) {
  const widths = ["w40", "w85", "w60", "w85", "w40", "w60"];
  return (
    <div aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder lines
        <div key={i} className={cx("sk", widths[i % widths.length])} />
      ))}
    </div>
  );
}

// v1.2: 「状态标签」 — the tones of the design's four pills (完成, 等你, 出错, 在用电脑).
export type Tone = "g" | "r" | "a" | "k" | "";
export function Pill({
  tone = "",
  dot,
  children,
}: {
  tone?: Tone;
  /** A dot of the pill's colour before its word (.pdot). */
  dot?: boolean;
  children: ReactNode;
}) {
  return (
    <span className={cx("pill", tone)}>
      {dot ? <span className="pdot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

/** A round face with an optional state dot (.avatar .st). */
export function Avatar({
  initial,
  state,
  size = 20,
}: {
  initial: string;
  state?: "run" | "wait" | "need" | "block" | "idle";
  size?: number;
}) {
  return (
    <span
      className="avatar"
      style={
        size === 20 ? undefined : { width: size, height: size, fontSize: Math.round(size * 0.42) }
      }
    >
      {initial}
      {state ? <span className={cx("st", state)} /> : null}
    </span>
  );
}

/**
 * One panel at a time, sliding in from the right over the app (task, account, settings…).
 * Escape and the scrim close it; focus moves into it and back to where it was.
 */
export function Sheet({
  title,
  onClose,
  wide,
  actions,
  footer,
  children,
}: {
  title: ReactNode;
  onClose: () => void;
  wide?: boolean;
  actions?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      before?.focus?.();
    };
  }, [onClose]);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the scrim; Escape closes it from the keyboard
    <div
      className="sheet-ovl"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={cx("sheet", wide && "wide")}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        ref={ref}
      >
        <div className="sheet-h">
          <h2>{title}</h2>
          {actions}
          <IconBtn icon={X} label={t.common.close} onClick={onClose} />
        </div>
        <div className="sheet-b">{children}</div>
        {footer ? <div className="sheet-f">{footer}</div> : null}
      </div>
    </div>
  );
}

/** A section; without a title when the page's tab already names it. */
export function Section({ title, children }: { title?: ReactNode; children: ReactNode }) {
  return (
    <section className="sec">
      {title ? <h4>{title}</h4> : null}
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty-state">{children}</div>;
}
