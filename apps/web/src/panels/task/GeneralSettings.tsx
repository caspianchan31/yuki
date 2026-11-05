/**
 * 设置 → 通用, the two blocks that are new in v1.5 (R9): 外观 (system / light / dark, kept in this
 * browser) and 时区 (the account's zone for routines' clock times, kept on the server).
 */

import { serverText, t } from "@m/shell/strings";
import {
  type Appearance,
  appearanceChoices,
  readAppearance,
  themeAttribute,
  writeAppearance,
} from "@m/shell/task/settings-core";
import { useWorkspace } from "@m/workspace";
import { useState } from "react";
import { setAccountZone, useAccountZone } from "../../account-zone";
import { Btn, ErrorLine } from "../../ui/primitives";
import { errorText, KV } from "./parts";

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function AppearanceSection() {
  const [choice, setChoice] = useState<Appearance>(() => readAppearance(storage()));
  function pick(next: Appearance) {
    setChoice(next);
    writeAppearance(storage(), next);
    const theme = themeAttribute(next);
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }
  return (
    <KV
      k={t.settings.appearance}
      right={
        <div className="row" role="radiogroup" aria-label={t.settings.appearance}>
          {appearanceChoices.map((value) => (
            <Btn
              key={value}
              className={value === choice ? "sm" : "sm ghost"}
              role="radio"
              aria-checked={value === choice}
              data-testid={`appearance-${value}`}
              onClick={() => pick(value)}
            >
              {t.settings.appearanceChoice[value]}
            </Btn>
          ))}
        </div>
      }
    >
      <span className="tp-small">{t.settings.appearanceHint}</span>
    </KV>
  );
}

export function TimeZoneSection() {
  const { api, notify } = useWorkspace();
  const { stored, zone, loaded } = useAccountZone();
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const shown = draft ?? zone ?? "";
  async function save() {
    setBusy(true);
    setError("");
    try {
      const saved = await api.request<{ timezone: string }>(
        "/api/account-settings",
        { timezone: shown.trim() },
        "PUT",
      );
      setAccountZone(saved.timezone);
      setDraft(null);
      notify(t.settings.timeZoneSaved);
    } catch (e) {
      const status = (e as { status?: unknown })?.status;
      setError(
        status === 400
          ? t.settings.timeZoneBad
          : t.settings.timeZoneFailed(serverText(errorText(e))),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div data-testid="timezone-settings">
      <KV
        k={t.settings.timeZone}
        right={
          <Btn
            className="sm"
            busy={busy}
            disabled={draft === null || !shown.trim()}
            onClick={() => void save()}
          >
            {t.settings.timeZoneSave}
          </Btn>
        }
      >
        {/* The row already says 时区 on the left: the input carries it as its accessible name only. */}
        <div className="field">
          <input
            className="input"
            aria-label={t.settings.timeZone}
            value={loaded ? shown : t.settings.timeZoneLoading}
            disabled={!loaded}
            placeholder="Asia/Shanghai"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
          />
          <small className="hint">
            {stored || !loaded || !zone ? t.settings.timeZoneHint : t.settings.timeZoneUnset(zone)}
          </small>
        </div>
      </KV>
      <ErrorLine error={error} />
    </div>
  );
}
