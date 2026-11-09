/**
 * v1.6.1 打开对话停在最新一条: whether a scroll event means the person left the end of the chat.
 *
 * The chat follows the newest block by setting `scrollTop = scrollHeight` whenever the content
 * grows. That scroll fires a scroll event too, after the content may have grown again, so read
 * naively it looks like the person stopped 100px short of the end and the following switched
 * itself off halfway through a long history replay (the chat opened near the top). A scroll that
 * lands exactly where the follower put it is the follower's own and says nothing about the
 * person; any other position is theirs: near the end keeps following, away from it stops.
 */
export type ScrollBox = { scrollTop: number; scrollHeight: number; clientHeight: number };

export const nearEndPx = 100;

export function scrollIntent(
  box: ScrollBox,
  programmaticTop: number | null,
): "ours" | "near" | "away" {
  if (programmaticTop !== null && Math.abs(box.scrollTop - programmaticTop) < 2) return "ours";
  return box.scrollHeight - box.scrollTop - box.clientHeight < nearEndPx ? "near" : "away";
}
