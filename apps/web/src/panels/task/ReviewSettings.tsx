/**
 * 动作审查 on the settings sheet: the on/off switch and the
 * space's two lists of plain sentences (先问我, 自动放行), at most 20 each. Every change is saved
 * at once (PUT /api/review-settings).
 */

import { createLatestSaver } from "@m/shell/serial-save";
import { serverText, t } from "@m/shell/strings";
import { useWorkspace } from "@m/workspace";
import { useEffect, useMemo, useRef, useState } from "react";
import { reviewRuleListMax } from "../../../../../packages/domain/src/index";
import { Btn, ErrorLine } from "../../ui/primitives";
import { errorText } from "./parts";

interface Settings {
  actionReview: boolean;
  askFirst: string[];
  autoAllow: string[];
}
type ListName = "askFirst" | "autoAllow";

export function ReviewSettingsSection() {
  const { api } = useWorkspace();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    api
      .request<Settings>("/api/review-settings")
      .then((value) => mounted.current && setSettings(value))
      .catch((e) => mounted.current && setError(t.settings.reviewSettingsFailed(errorText(e))));
    return () => {
      mounted.current = false;
    };
  }, [api]);
  // Every edit saves at once; edits made before an answer is back must not be overwritten by it.
  const saver = useMemo(
    () =>
      createLatestSaver<Settings>({
        put: (value) => api.request<Settings>("/api/review-settings", value, "PUT"),
        onSaved: (saved) => mounted.current && setSettings(saved),
        onError: async (e) => {
          if (!mounted.current) return;
          setError(t.settings.reviewSettingsFailed(serverText(errorText(e))));
          // what the server really holds
          const held = await api.request<Settings>("/api/review-settings").catch(() => null);
          if (held && mounted.current) setSettings(held);
        },
      }),
    [api],
  );
  function save(next: Settings) {
    setSettings(next);
    setError("");
    void saver(next);
  }
  if (!settings) return error ? <ErrorLine error={error} /> : null;
  return (
    <div className="tp-box" data-testid="review-settings">
      <label className="row" style={{ gap: 8 }}>
        <input
          type="checkbox"
          checked={settings.actionReview}
          onChange={() => save({ ...settings, actionReview: !settings.actionReview })}
        />
        <span className="tp-strong">{t.settings.actionReview}</span>
      </label>
      <p className="muted">{t.settings.actionReviewHint}</p>
      <RuleList
        title={t.settings.askFirstTitle}
        items={settings.askFirst}
        onChange={(items) => save({ ...settings, askFirst: items })}
      />
      <RuleList
        title={t.settings.autoAllowTitle}
        items={settings.autoAllow}
        onChange={(items) => save({ ...settings, autoAllow: items })}
      />
      <ErrorLine error={error} />
    </div>
  );
}

function RuleList({
  title,
  items,
  onChange,
}: {
  title: string;
  items: string[];
  onChange: (items: string[]) => void;
}) {
  // `editing`: the index being edited, -1 a new sentence, null none.
  const [editing, setEditing] = useState<number | null>(null);
  const [text, setText] = useState("");
  const full = items.length >= reviewRuleListMax;
  const commit = () => {
    const value = text.trim();
    if (value) {
      const next = [...items];
      if (editing === -1) next.push(value);
      else if (editing !== null) next[editing] = value;
      onChange(next);
    }
    setEditing(null);
    setText("");
  };
  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="tp-strong">
          {title} · {t.settings.ruleListCount(items.length, reviewRuleListMax)}
        </span>
        <Btn
          className="sm"
          disabled={full || editing !== null}
          onClick={() => {
            setEditing(-1);
            setText("");
          }}
        >
          {full ? t.settings.ruleListFull(reviewRuleListMax) : t.settings.ruleAdd}
        </Btn>
      </div>
      {!items.length && editing === null ? (
        <p className="muted">{t.settings.ruleListEmpty}</p>
      ) : null}
      {items.map((item, index) =>
        editing === index ? null : (
          // biome-ignore lint/suspicious/noArrayIndexKey: sentences are edited in place by position
          <div key={index} className="row" style={{ justifyContent: "space-between" }}>
            <span style={{ minWidth: 0 }}>{item}</span>
            <span className="row" style={{ gap: 6 }}>
              <Btn
                className="sm ghost"
                disabled={editing !== null}
                onClick={() => {
                  setEditing(index);
                  setText(item);
                }}
              >
                {t.settings.ruleEdit}
              </Btn>
              <Btn
                className="sm ghost"
                disabled={editing !== null}
                onClick={() => onChange(items.filter((_, i) => i !== index))}
              >
                {t.settings.ruleDelete}
              </Btn>
            </span>
          </div>
        ),
      )}
      {editing !== null ? (
        <div className="row" style={{ gap: 6 }}>
          <input
            className="input"
            value={text}
            maxLength={500}
            placeholder={t.settings.rulePlaceholder}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) commit();
            }}
          />
          <Btn className="sm" variant="pri" disabled={!text.trim()} onClick={commit}>
            {t.settings.ruleSave}
          </Btn>
          <Btn
            className="sm ghost"
            onClick={() => {
              setEditing(null);
              setText("");
            }}
          >
            {t.settings.ruleCancel}
          </Btn>
        </div>
      ) : null}
    </div>
  );
}
