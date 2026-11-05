import { createContext } from "react";

/** Inside the group chat a card does not name its speaker again (the
 * group's turn already does) and a plain report drops its label. */
export const InGroupChat = createContext(false);
