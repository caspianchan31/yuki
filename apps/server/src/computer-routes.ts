// The computer API of the open core. With no computer container configured it is what there is to
// see (nothing connected) and every other route answers 503 or is absent; with one configured
// (docs/computer-container.md) it starts and pauses the members' computer, hands the live view and
// the controls to the person (接手 / 交还), runs commands and reads and writes files.
import { Hono } from "hono";
import type { EnvironmentRef } from "../../../packages/domain/src/environments.ts";
import type { ComputerService } from "./computer.ts";
import {
  desktopCommandSchema,
  desktopOf,
  desktopPathSchema,
  desktopWriteSchema,
} from "./desktop-computer.ts";
import { AppError } from "./errors.ts";
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
  const desktop = () => {
    const found = desktopOf(computer);
    if (!found) throw new AppError("No computer is connected (未接电脑).", 503);
    return found;
  };
  app.get("/", async (c) => c.json(await computer.snapshot(c.get("owner"))));
  if (!desktopOf(computer)) return app;
  app.post("/start", async (c) => c.json(await computer.start(c.get("owner"))));
  app.post("/stop", async (c) => c.json(await computer.stop(c.get("owner"))));
  // The live view's address (a ticket in its path) and who drives; 409 while the computer is paused.
  app.get("/desktop", async (c) => c.json(await desktop().liveView(c.get("owner"))));
  // 接手 ({"by": "person"}) and 交还 ({"by": "member"}).
  app.post("/control", async (c) =>
    c.json(await desktop().setControl(c.get("owner"), await c.req.json())),
  );
  app.post("/commands", async (c) =>
    c.json(
      await computer.execute(c.get("owner"), desktopCommandSchema.parse(await c.req.json()), {
        signal: c.req.raw.signal,
      }),
    ),
  );
  app.get("/files", async (c) => c.json(await desktop().list(c.req.query("path"))));
  app.post("/files/read", async (c) => {
    const { path } = desktopPathSchema.parse(await c.req.json());
    return c.json(await desktop().read(path));
  });
  app.post("/files/write", async (c) => {
    const { path, text } = desktopWriteSchema.parse(await c.req.json());
    return c.json(await desktop().write(path, text));
  });
  app.post("/files/mkdir", async (c) => {
    const { path } = desktopPathSchema.parse(await c.req.json());
    return c.json(await desktop().mkdir(path));
  });
  return app;
}
