import { createApp } from "./app.ts";
import { readConfig } from "./config.ts";
import { readCredentialKey } from "./credentials/crypto.ts";
import { createStore } from "./db.ts";

const config = readConfig();
// Read once here and handed only to the credential store.
const credentialKey = await readCredentialKey({
  mode: config.mode,
  file: process.env.CREDENTIAL_KEY_FILE,
  tokenKey: config.encryptionKey,
});
if (!config.databaseUrl)
  throw new Error(
    "A separate task worker requires DATABASE_URL. Embedded PGlite runs inside the API process.",
  );
const db = await createStore({ databaseUrl: config.databaseUrl });
// The old settings' secrets are in the credential store before this worker
// starts any desktop (the API may be moving them right now; the worker waits for it).
const { agent, chat } = await createApp(db, config, {
  credentialKey,
});
agent.start();
console.log("OpenMuse task worker running");
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await agent.stop();
  await chat.close(); // stop the chat runner's timers before the database.
  await db.close();
  process.exit(0);
};
process.on("SIGINT", () => {
  void stop().catch(() => process.exit(1));
});
process.on("SIGTERM", () => {
  void stop().catch(() => process.exit(1));
});
