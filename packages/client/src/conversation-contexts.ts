/**
 * Phase C (docs/web.md): the contexts the conversation hands its tool cards, from
 * browser-tool-card.tsx, jev-tool-card.tsx and shell/chat/ChatCards.tsx, free of React Native so
 * the web app's cards read the same ones. The RN files re-export them unchanged.
 *   BrowserRunContext      whether a reply is running, and whether it is the turn of this card
 *   JevInteractionContext  how a present_choices card (and a guide card) speaks in the chat
 *   DesktopFoldContext     the conversation's desktop steps folded into runs, one block each
 */
import { createContext } from "react";
import type { DesktopFold } from "./shell/chat/core";
import { t } from "./shell/strings";

export const BrowserRunContext = createContext({ running: false, active: false });

export type JevInteraction = {
  threadId: string | null;
  busy: boolean;
  latestPanelId: string | null;
  latestUserText: string | null;
  send: (text: string) => Promise<void>;
  retry: (text: string) => Promise<void>;
  canRetry: boolean;
  confirmedSelection: (panelId: string) => string | null;
};

export const JevInteractionContext = createContext<JevInteraction>({
  threadId: null,
  busy: true,
  latestPanelId: null,
  latestUserText: null,
  canRetry: false,
  confirmedSelection: () => null,
  send: async () => {
    throw new Error(t.choices.noConversation);
  },
  retry: async () => {
    throw new Error(t.choices.noConversationRetry);
  },
});

/** The conversation's desktop steps folded
 * into runs (shell/chat/core.ts `desktopFold`), and whether a reply is running now (set by
 * ChatScreen); a desktop step's renderer draws its run's one block, or nothing. */
export const DesktopFoldContext = createContext<{ fold: DesktopFold; replying: boolean }>({
  fold: new Map(),
  replying: false,
});
