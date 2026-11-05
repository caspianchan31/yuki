/**
 * Phase C (docs/web.md): the conversation area the shell mounts in `.chat-host`, from
 * shell/Shell.tsx's ChatArea. The chat's tools are registered once here (WorkspaceTools). Every
 * visited conversation stays mounted (hidden), so switching back is instant and a reply keeps
 * streaming (under a page too: only what is drawn records its reports as seen, `inView`); the main thread's load error says so with 重新加载; without rich threads there is the
 * one local conversation.
 */
import "./chat.css";
import { useShellNav } from "@m/shell/nav";
import { t } from "@m/shell/strings";
import { useMuseThread } from "@m/threads-state";
import { Btn, ErrorLine, Skeleton } from "../ui/primitives";
import { ChatScreen } from "./ChatScreen";
import { WorkspaceTools } from "./WorkspaceTools";

export function ChatArea({
  prompt,
  inView,
}: {
  prompt?: { id: number; text: string };
  /** The chat is drawn: false while a page (平台管理, 账号…) covers it, and at
   * the phone layout's width while the member pane or a panel does (Shell). Its reports are
   * recorded as seen only then (useChatSession's `inView`). */
  inView: boolean;
}) {
  const nav = useShellNav();
  const { selection, visited, loading, error, retry, enabled } = useMuseThread();
  return (
    <>
      <WorkspaceTools />
      {enabled ? (
        <>
          {error ? (
            <div className="chat-error row">
              <ErrorLine error={`${t.common.errorPrefix}${error}`} />
              <Btn className="sm" onClick={retry}>
                {t.threads.retryMain}
              </Btn>
            </div>
          ) : null}
          {loading && !error ? (
            <div className="chat-error" aria-hidden="true">
              <Skeleton lines={3} />
            </div>
          ) : null}
          {visited.map((thread) => (
            <div
              key={thread.id}
              className="chat-screen"
              style={{ display: selection.id === thread.id ? "flex" : "none" }}
            >
              <ChatScreen
                thread={thread}
                active={nav.view === "work" && selection.id === thread.id}
                inView={inView}
                prompt={selection.id === thread.id ? prompt : undefined}
              />
            </div>
          ))}
        </>
      ) : (
        <ChatScreen prompt={prompt} active={nav.view === "work"} inView={inView} />
      )}
    </>
  );
}
