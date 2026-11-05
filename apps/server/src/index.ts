import type { Server } from "node:http";
import { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { startCloudMigration } from "./chat/cloud-migration.ts";
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
const db = await createStore({
  dataDir: `${config.dataDir}/postgres`,
  databaseUrl: config.databaseUrl,
});
await db.recoverInterruptedActions();
const { app, agent, chat, attachServer } = await createApp(db, config, { credentialKey });
if (config.taskWorkerEnabled) agent.start();
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, () =>
  console.log(`OpenMuse ${config.mode} API ready at ${config.publicUrl}`),
);
attachServer(server as Server);
// The conversations still in CopilotKit's cloud are
// copied here once, in the background, while the chat already works. Only this API process does
// it (a separate worker never does); once complete, the key is never used again.
await startCloudMigration(
  db,
  chat.store,
  config.intelligenceApiKey,
  (apiKey) => new CopilotKitIntelligence({ apiKey }),
);
const shutdown = () => {
  // End chat streams first, saving replies in progress, so server.close can finish.
  void Promise.resolve(chat.close())
    .catch(() => console.error("[OpenMuse] Chat did not close cleanly"))
    .then(() =>
      server.close(() => {
        void agent
          .stop()
          .then(() => db.close())
          .then(() => process.exit(0));
      }),
    );
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
