/**
 * Phase C (docs/web.md): the contexts the conversation hands its blocks and tool cards, the
 * same objects the phone's chat uses (shell/chat/group-context.ts, conversation-contexts.ts).
 */

export {
  BrowserRunContext,
  DesktopFoldContext,
  JevInteractionContext,
} from "@m/conversation-contexts";
export { InGroupChat as InGroup } from "@m/shell/chat/group-context";
