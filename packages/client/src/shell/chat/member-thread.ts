/** v1.2 member conversations. The id rule lives in the domain package so the server stores
 * reports on the same thread the client opens. */
export {
  isMemberConversationId,
  memberAccountId,
  memberConversationId,
  memberPersonaLine,
  memberRoutineLine,
  reportThread,
  speakAsMember,
} from "../../../../domain/src/member-thread.ts";
