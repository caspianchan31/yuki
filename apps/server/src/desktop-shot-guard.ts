// v1.5 (open core): a reply that says it took or shows a screenshot of the computer, but in which no
// computer_screenshot ran, gets one. The app takes the picture and adds it to the reply as that
// tool's card, so the person sees what the words promise, whatever the model and however long the
// conversation (a model copying older replies once answered 「这是当前电脑屏幕截图」 with no picture).
// The card is an ordinary computer_screenshot call and result, stored with the reply.
import { randomUUID } from "node:crypto";
import { type BaseEvent, EventType } from "@ag-ui/core";
import { Observable } from "rxjs";
import type { DesktopComputer } from "./desktop-computer.ts";

/** Words of a reply that promise a picture of the screen. */
export const promisesScreenshot = /截图|截屏|screen ?shot/i;

export type Shooter = Pick<DesktopComputer, "screenshot" | "keepShot" | "drivenBy">;

/** The reply's events, with a screenshot added before RUN_FINISHED when its words promised one
 * and it took none. A failed screenshot is logged and the reply ends as it was. */
export function screenshotPromiseGuard(desktop: Shooter) {
  return (events: Observable<BaseEvent>) =>
    new Observable<BaseEvent>((subscriber) => {
      let text = "";
      let took = false;
      let parentMessageId: string | undefined;
      let adding = false;
      let sourceDone = false;
      const add = async (finished: BaseEvent) => {
        try {
          const shotId = desktop.keepShot(await desktop.screenshot());
          const toolCallId = randomUUID();
          subscriber.next({
            type: EventType.TOOL_CALL_START,
            toolCallId,
            toolCallName: "computer_screenshot",
            parentMessageId,
          } as BaseEvent);
          subscriber.next({ type: EventType.TOOL_CALL_ARGS, toolCallId, delta: "{}" } as BaseEvent);
          subscriber.next({ type: EventType.TOOL_CALL_END, toolCallId } as BaseEvent);
          subscriber.next({
            type: EventType.TOOL_CALL_RESULT,
            toolCallId,
            messageId: randomUUID(),
            role: "tool",
            content: JSON.stringify({
              screenshot: "taken by the app: the reply said it shows the screen",
              shotId,
              control: desktop.drivenBy,
            }),
          } as BaseEvent);
        } catch (error) {
          console.error(
            `[screenshot promise] ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        adding = false;
        subscriber.next(finished);
        if (sourceDone) subscriber.complete();
      };
      const subscription = events.subscribe({
        next: (event) => {
          const loose = event as { messageId?: string; delta?: unknown; toolCallName?: string };
          if (event.type === EventType.TEXT_MESSAGE_START) {
            parentMessageId = loose.messageId ?? parentMessageId;
          } else if (
            event.type === EventType.TEXT_MESSAGE_CONTENT ||
            event.type === EventType.TEXT_MESSAGE_CHUNK
          ) {
            parentMessageId = loose.messageId ?? parentMessageId;
            text += typeof loose.delta === "string" ? loose.delta : "";
          } else if (
            event.type === EventType.TOOL_CALL_START &&
            loose.toolCallName === "computer_screenshot"
          ) {
            took = true;
          } else if (
            event.type === EventType.RUN_FINISHED &&
            !took &&
            promisesScreenshot.test(text)
          ) {
            adding = true;
            void add(event);
            return;
          }
          subscriber.next(event);
        },
        error: (error) => subscriber.error(error),
        complete: () => {
          sourceDone = true;
          if (!adding) subscriber.complete();
        },
      });
      return () => subscription.unsubscribe();
    });
}
