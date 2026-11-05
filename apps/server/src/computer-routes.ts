// The computer API with no computer: what is there to see (nothing connected). Every other
// computer route is absent (404).
import { Hono } from "hono";
import type { EnvironmentRef } from "../../../packages/domain/src/environments.ts";
import type { ComputerService } from "./computer.ts";
import type { Files } from "./files.ts";

/** `owner` keys the computer; when mounted under an environment it is the derived owner,
 * `filesOwner` the real one (Files are shared) and `environmentRef` the environment. */
export type ComputerRouteVariables = {
  owner: string;
  filesOwner?: string;
  environmentRef?: EnvironmentRef;
};

export function computerRoutes(computer: ComputerService, _files: Files) {
  const app = new Hono<{ Variables: ComputerRouteVariables }>();
  app.get("/", async (c) => c.json(await computer.snapshot(c.get("owner"))));
  return app;
}
