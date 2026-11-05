/**
 * Phase C (docs/web.md): the composer pinned under the timeline (prototype .composer .box with
 * send), from chat.tsx's input area and shell/chat/Composer.tsx:
 *   the save error and 重新保存对话, the outbox (下一条 / 暂缓发送, each removable, 发送暂缓的消息)
 *   the box         the text (Enter sends, Shift+Enter a new line, never while composing with
 *                   an input method), send — 停止回复 while a reply runs
 */
import type { ChatSession } from "@m/chat-state";
import { isComposingKey } from "@m/ime";
import {
  applyMention,
  filterMentions,
  type MentionOption,
  mentionTrigger,
  moveMentionIndex,
} from "@m/shell/chat/mention";
import { t } from "@m/shell/strings";
import { ArrowUp, Square, X } from "lucide-react";
import {
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Btn, cx, ErrorLine } from "../ui/primitives";
import { MentionMenu, useMentionOptions } from "./MentionMenu";

export function Composer({
  chat,
  draft,
  setDraft,
  onSent,
  input,
  address,
  hold,
}: {
  chat: ChatSession;
  draft: string;
  setDraft: (text: string) => void;
  /** v1.2: a member's conversation is addressed to them. */
  address?: string | null;
  /** v1.2: her desktop is not selected yet, so a send would run on the wrong computer. */
  hold?: boolean;
  /** After a message went into the outbox (the input is cleared). */
  onSent?: () => void;
  input: RefObject<HTMLTextAreaElement | null>;
}) {
  // v1.2: the box is a pill only while the text is one line; past that it squares off.
  const [tall, setTall] = useState(false);
  const {
    outbox,
    saveError,
    busy,
    replying,
    canSend: chatCanSend,
    isReady,
    loaded,
    historyError,
  } = chat;
  const canSend = chatCanSend && !hold;
  // The @ list. It stays shut while an input method is composing, and after a name was chosen or
  // Esc pressed until the words after that @ change.
  const mentionId = useId();
  const [caret, setCaret] = useState(0);
  const [composing, setComposing] = useState(false);
  const [active, setActive] = useState(0);
  const [shut, setShut] = useState<{ start: number; words: string } | null>(null);
  const afterCaret = useRef<number | null>(null);
  const trigger = composing ? null : mentionTrigger(draft, caret);
  // Read fresh each time an @ is started: a skill saved in this chat is not a focus event away.
  const options = useMentionOptions(!!trigger);
  const isShut =
    !!trigger &&
    !!shut &&
    shut.start === trigger.start &&
    draft.slice(trigger.start, caret) === shut.words;
  const mentions: MentionOption[] =
    trigger && !isShut ? filterMentions(options, trigger.query) : [];
  const listOpen = mentions.length > 0;
  const query = trigger?.query;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new query starts at the first row
  useEffect(() => setActive(0), [query]);
  useLayoutEffect(() => {
    const at = afterCaret.current;
    if (at === null || !input.current) return;
    afterCaret.current = null;
    input.current.focus();
    input.current.setSelectionRange(at, at);
  }, [draft, input]);
  const pickMention = (option: MentionOption) => {
    if (!trigger) return;
    const next = applyMention(draft, trigger, caret, option.name);
    afterCaret.current = next.caret;
    setDraft(next.text);
    setCaret(next.caret);
    setShut({ start: trigger.start, words: next.text.slice(trigger.start, next.caret) });
  };
  // The text box grows with what is typed, up to its max height (chat.css).
  useLayoutEffect(() => {
    const box = input.current;
    if (!box) return;
    box.style.height = "auto";
    const grown = box.scrollHeight;
    box.style.height = `${grown}px`;
    // v1.2: one line is the line height plus the text area's own padding; anything
    // over it (or a typed newline) is several lines.
    const style = getComputedStyle(box);
    const oneLine =
      (parseFloat(style.lineHeight) || 24) +
      (parseFloat(style.paddingTop) || 0) +
      (parseFloat(style.paddingBottom) || 0);
    setTall(draft.includes("\n") || grown > oneLine + 0.5);
  }, [draft, input]);
  const send = () => {
    if (hold) return;
    if (!chat.submit(draft)) return;
    onSent?.();
    setDraft("");
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (listOpen && trigger && !composing && !isComposingKey(e.nativeEvent)) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((index) =>
          moveMentionIndex(index, mentions.length, e.key === "ArrowDown" ? 1 : -1),
        );
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        e.preventDefault();
        pickMention(mentions[Math.min(active, mentions.length - 1)]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setShut({ start: trigger.start, words: draft.slice(trigger.start, caret) });
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !isComposingKey(e.nativeEvent)) {
      e.preventDefault();
      send();
    }
  };
  const go = replying || (!!draft.trim() && canSend);
  return (
    <div className="composer">
      {saveError ? (
        <div className="lines">
          <ErrorLine error={saveError} />
          <div>
            <Btn className="sm" disabled={busy} onClick={chat.retrySave}>
              {t.chat.retrySave}
            </Btn>
          </div>
        </div>
      ) : null}
      {outbox.pending.length ? (
        <div className="lines">
          <span className="hint">
            {`${outbox.paused ? t.chat.onHold : t.chat.queued}${t.common.sep}${t.chat.keepOpen}`}
          </span>
          {outbox.pending.map((message) => {
            const text = chat.queuedText(message.text);
            return (
              <div key={message.id} className="q">
                <span className="t">{text}</span>
                <button
                  type="button"
                  className="tb-btn"
                  aria-label={t.chat.removeQueued(text)}
                  title={t.chat.removeQueued(text)}
                  onClick={() => chat.removeQueued(message.id)}
                >
                  <X size={14} />
                </button>
              </div>
            );
          })}
          {outbox.paused ? (
            <div>
              <Btn className="sm" disabled={busy || !!saveError} onClick={chat.sendQueued}>
                {t.chat.sendQueued}
              </Btn>
            </div>
          ) : null}
        </div>
      ) : null}
      {listOpen ? (
        <MentionMenu
          id={mentionId}
          items={mentions}
          active={active}
          onPick={pickMention}
          onHover={setActive}
        />
      ) : null}
      <div className={cx("box", tall && "tall")}>
        <textarea
          ref={input}
          rows={1}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={listOpen}
          aria-controls={listOpen ? mentionId : undefined}
          aria-activedescendant={listOpen ? `${mentionId}-${active}` : undefined}
          aria-label={address ? t.chat.toMember(address) : t.chat.groupPlaceholder}
          title={t.composer.newLine}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setCaret(e.target.selectionStart);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={(e) => {
            setComposing(false);
            setCaret(e.currentTarget.selectionStart);
          }}
          onKeyDown={onKey}
          placeholder={
            !isReady
              ? t.chat.connecting
              : !loaded
                ? historyError
                  ? t.chat.conversationUnavailable
                  : t.chat.loadingConversation
                : hold
                  ? t.chat.pinningDesktop
                  : replying
                    ? t.chat.interruptHint
                    : address
                      ? t.chat.toMember(address)
                      : t.chat.groupPlaceholder
          }
        />
        <button
          type="button"
          className={cx("send", go && "go")}
          aria-label={replying ? t.chat.stop : t.chat.send}
          title={replying ? t.chat.stop : t.chat.send}
          disabled={!replying && (!draft.trim() || !canSend)}
          onClick={replying ? () => void chat.stop() : send}
        >
          {replying ? (
            <Square size={13} fill="currentColor" strokeWidth={0} />
          ) : (
            <ArrowUp size={18} />
          )}
        </button>
      </div>
    </div>
  );
}
