// The config tests build on, with no computer connected (未接电脑).
import type { Config } from "../../apps/server/src/config.ts";

export const config: Config = {
  mode: "sample",
  port: 8787,
  host: "127.0.0.1",
  publicUrl: "http://localhost:8787",
  dataDir: "/unused",
  agentBackend: "sample",
  googleRedirectUri: "http://localhost/callback",
  allowedOrigins: [],
};
