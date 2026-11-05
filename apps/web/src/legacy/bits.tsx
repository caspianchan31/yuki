/**
 * Phase C (docs/web.md): the small pieces the legacy sheets share, from the old primitives
 * they used on the phone (ui.tsx LinkRow, CheckRow, Empty, the sheet subtitle) and the web
 * branches of BrowserConsole.web.tsx and PdfReader.web.tsx, drawn with app.css.
 */
import { t } from "@m/shell/strings";
import type { LucideIcon } from "lucide-react";
import { ChevronLeft, ChevronRight, Minus, Plus } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Btn, cx } from "../ui/primitives";

/** The one line under a sheet's title (the phone's Sheet subtitle). */
export function Subtitle({ children }: { children: ReactNode }) {
  return <p className="hint lg-sub">{children}</p>;
}

/** A row that opens something (a file, a folder, a session). */
export function LinkRow({
  icon: Icon,
  title,
  detail,
  onClick,
  disabled,
}: {
  icon: LucideIcon;
  title: string;
  detail?: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button type="button" className="list-row" onClick={onClick} disabled={disabled}>
      <Icon size={16} className="lg-ico" />
      <span className="grow">
        <span className="t" style={{ display: "block" }}>
          {title}
        </span>
        {detail ? (
          <span className="d" style={{ display: "block" }}>
            {detail}
          </span>
        ) : null}
      </span>
      <ChevronRight size={14} className="lg-ico" />
    </button>
  );
}

/** A checkbox with its label. */
export function CheckRow({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
}) {
  return (
    <label className="lg-check">
      <input type="checkbox" checked={checked} onChange={onChange} disabled={disabled} />
      <span>{label}</span>
    </label>
  );
}

/** A tinted note: amber for something to look at, green for a result. */
export function Callout({
  tone,
  title,
  children,
}: {
  tone: "amber" | "green" | "grey";
  title?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={cx("lg-callout", tone)}>
      {title ? <div className="lg-callout-t">{title}</div> : null}
      {children}
    </div>
  );
}

/** An empty state with its icon, title and one line. */
export function EmptyNote({
  icon: Icon,
  title,
  detail,
}: {
  icon: LucideIcon;
  title: string;
  detail?: string;
}) {
  return (
    <div className="empty-state lg-empty">
      <Icon size={22} />
      <div className="lg-empty-t">{title}</div>
      {detail ? <div className="hint">{detail}</div> : null}
    </div>
  );
}

/** A multi-line monospace field (terminal command, file contents). */
export function CodeArea({
  label,
  value,
  onChange,
  placeholder,
  rows = 4,
  maxLength,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  maxLength?: number;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <label className="field" htmlFor={id}>
      <span>{label}</span>
      <textarea
        id={id}
        className="input lg-mono"
        value={value}
        rows={rows}
        maxLength={maxLength}
        placeholder={placeholder}
        disabled={disabled}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/** A page in a frame of its own: a browser session's console or the live desktop. Sandboxed
 * (the desktop): scripts and pointer lock only, and no referrer. */
export function BrowserConsole({
  url,
  title = t.browserSheet.console,
  sandboxed = false,
}: {
  url: string;
  title?: string;
  sandboxed?: boolean;
}) {
  return (
    <iframe
      title={title}
      src={url}
      className="lg-frame"
      sandbox={sandboxed ? "allow-scripts allow-same-origin allow-pointer-lock" : undefined}
      referrerPolicy={sandboxed ? "no-referrer" : undefined}
    />
  );
}

/** A PDF in the browser's own reader, with page and zoom buttons (PdfReader.web.tsx). */
export function PdfReader({ url, pageCount }: { url: string; pageCount: number }) {
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(100);
  return (
    <div className="lg-stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="row">
          <Btn icon={ChevronLeft} disabled={page <= 1} onClick={() => setPage(page - 1)}>
            {t.pdf.previous}
          </Btn>
          <span className="hint">
            {page} / {pageCount}
          </span>
          <Btn icon={ChevronRight} disabled={page >= pageCount} onClick={() => setPage(page + 1)}>
            {t.pdf.next}
          </Btn>
        </div>
        <div className="row">
          <Btn icon={Minus} disabled={zoom <= 50} onClick={() => setZoom(zoom - 25)}>
            {t.pdf.zoomOut}
          </Btn>
          <span className="hint">{zoom}%</span>
          <Btn icon={Plus} disabled={zoom >= 200} onClick={() => setZoom(zoom + 25)}>
            {t.pdf.zoomIn}
          </Btn>
        </div>
      </div>
      <iframe
        key={`${page}:${zoom}`}
        title={t.pdf.frame}
        src={`${url}#page=${page}&zoom=${zoom}`}
        className="lg-frame pdf"
      />
      <p className="hint">{t.pdf.toolbarHint}</p>
    </div>
  );
}
