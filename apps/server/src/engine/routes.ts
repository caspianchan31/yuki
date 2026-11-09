import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type {
  AgentIdentity,
  AgentMemory,
  AgentNotification,
} from "../../../../packages/domain/src/agent.ts";
import { createTaskSchema } from "../../../../packages/domain/src/agent.ts";
import { firstRunPlan } from "../../../../packages/domain/src/template-setup.ts";
import { AppError } from "../errors.ts";
import { accountUsageOn, pricePerMillion, usageCostUsd } from "./model-usage.ts";
import type { AgentService } from "./service.ts";

const text = z.string().trim().min(1).max(4000);
const memorySchema = z.object({ text, source: z.string().trim().min(1).max(200).optional() });
const goalPatchSchema = z.object({
  status: z.enum(["active", "paused", "completed"]).optional(),
  milestones: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        title: z.string().trim().min(1).max(200),
        done: z.boolean(),
      }),
    )
    .max(100)
    .optional(),
});

export function agentRoutes(service: AgentService): Hono<{ Variables: { owner: string } }> {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.get("/", async (c) => c.json(await service.snapshot(c.get("owner"))));
  // v1.7 启动链瘦身: what the roster needs of another project's tasks (their routine bucket),
  // instead of that project's whole snapshot.
  app.get("/routines", async (c) => c.json({ tasks: await service.routineRows(c.get("owner")) }));
  // v1.7 模型兜底 / 出错时页面直说: which model answers now, and whether the backup is in force.
  app.get("/model", (c) => c.json(service.modelState()));
  app.post("/tasks", async (c) => {
    // `typed` says the person typed the prompt (the new-task form); it is
    // not part of createTaskSchema, so the chat's delegate_task can never claim it.
    const { requestId, typed, nextRunAt, ...input } = createTaskSchema
      .extend({
        requestId: z.string().min(1).max(200).optional(),
        typed: z.boolean().optional(),
        // The new-member form's written clock. Not on createTaskSchema, so a chat tool cannot set it.
        nextRunAt: z.string().min(1).max(40).optional(),
      })
      .parse(await c.req.json());
    return c.json(
      await service.createTask(c.get("owner"), input, requestId, false, {
        typedByOwner: typed,
        firstRunAt: firstRunPlan(nextRunAt)?.nextRunAt,
      }),
      201,
    );
  });
  // Make a routine, change one (name, instruction, trigger).
  app.post("/routines", async (c) =>
    c.json(await service.routines.create(c.get("owner"), await c.req.json()), 201),
  );
  app.patch("/routines/:id", async (c) =>
    c.json(await service.routines.update(c.get("owner"), c.req.param("id"), await c.req.json())),
  );
  app.get("/tasks/:id", async (c) =>
    c.json(await service.detail(c.get("owner"), c.req.param("id"))),
  );
  app.post("/tasks/:id/control", async (c) => {
    const { action } = z
      .object({ action: z.enum(["pause", "resume", "cancel", "retry", "run"]) })
      .parse(await c.req.json());
    return c.json(await service.control(c.get("owner"), c.req.param("id"), action));
  });
  // Fork: change how often a task repeats (null stops it).
  app.patch("/tasks/:id", async (c) =>
    c.json(await service.updateTask(c.get("owner"), c.req.param("id"), await c.req.json())),
  );
  app.post("/tasks/:id/input", async (c) => {
    const body = z
      .object({
        answer: z.string().trim().min(1).max(12000),
        fields: z
          .record(z.string().min(1).max(300), z.union([z.string().max(12000), z.boolean()]))
          .optional(),
      })
      .parse(await c.req.json());
    return c.json(
      await service.answer(c.get("owner"), c.req.param("id"), body.answer, body.fields),
    );
  });
  // A new instruction for a started task.
  app.post("/tasks/:id/redirect", async (c) =>
    c.json(
      await service.redirect(c.get("owner"), c.req.param("id"), await c.req.json(), {
        retryFailed: true,
      }),
    ),
  );
  app.post("/goals", async (c) =>
    c.json(await service.createGoal(c.get("owner"), await c.req.json()), 201),
  );
  app.post("/goals/:id", async (c) => {
    const body = goalPatchSchema.parse(await c.req.json());
    return c.json(await service.updateGoal(c.get("owner"), c.req.param("id"), body));
  });
  app.post("/goals/:id/milestones/:milestoneId", async (c) => {
    const { done } = z.object({ done: z.boolean() }).parse(await c.req.json());
    return c.json(
      await service.setMilestoneDone(
        c.get("owner"),
        c.req.param("id"),
        c.req.param("milestoneId"),
        done,
      ),
    );
  });
  app.post("/monitors", async (c) =>
    c.json(await service.createMonitor(c.get("owner"), await c.req.json()), 201),
  );
  app.post("/monitors/:id/control", async (c) => {
    const { action } = z
      .object({ action: z.enum(["pause", "resume", "stop", "check"]) })
      .parse(await c.req.json());
    return c.json(await service.controlMonitor(c.get("owner"), c.req.param("id"), action));
  });
  app.post("/ideas/refresh", async (c) => c.json(await service.refreshIdeas(c.get("owner"))));
  app.post("/ideas/:id", async (c) => {
    const body = z
      .object({
        action: z.enum(["accept", "dismiss"]),
        prompt: z.string().trim().min(1).max(12000).optional(),
      })
      .parse(await c.req.json());
    return c.json(
      await service.decideIdea(c.get("owner"), c.req.param("id"), body.action, body.prompt),
    );
  });
  app.post("/memories", async (c) => {
    const body = memorySchema.parse(await c.req.json());
    const memory: AgentMemory = {
      id: randomUUID(),
      text: body.text,
      source: body.source ?? "You",
      createdAt: new Date().toISOString(),
    };
    return c.json(await service.db.put(c.get("owner"), "memories", memory), 201);
  });
  app.post("/memories/:id", async (c) => {
    const body = memorySchema.parse(await c.req.json());
    const memory = await service.db.compareAndSwap<AgentMemory>(
      c.get("owner"),
      "memories",
      c.req.param("id"),
      {},
      body,
    );
    if (!memory) throw new AppError("Memory not found", 404);
    return c.json(memory);
  });
  app.post("/memories/:id/forget", async (c) => {
    if (!(await service.db.take(c.get("owner"), "memories", c.req.param("id"))))
      throw new AppError("Memory not found", 404);
    return c.json({ ok: true });
  });
  // An account's persona, long-term goal and plan, with
  // their histories; the owner edits the persona and the goal (saved at once, no confirmation).
  app.get("/accounts/:id", async (c) =>
    c.json(await service.accounts.view(c.get("owner"), c.req.param("id"))),
  );
  app.get("/accounts/:id/usage", async (c) => {
    const day = new Date().toISOString().slice(0, 10);
    const row = await accountUsageOn(service.db, c.get("owner"), c.req.param("id"), day);
    const input = row?.input ?? 0;
    const output = row?.output ?? 0;
    return c.json({
      day,
      input,
      output,
      turns: row?.turns ?? 0,
      costUsd: usageCostUsd(
        input,
        output,
        pricePerMillion(process.env.MODEL_USD_PER_MILLION_INPUT),
        pricePerMillion(process.env.MODEL_USD_PER_MILLION_OUTPUT),
      ),
    });
  });
  app.put("/accounts/:id/persona", async (c) =>
    c.json(
      await service.accounts.putPersona(c.get("owner"), c.req.param("id"), await c.req.json()),
    ),
  );
  app.post("/accounts/:id/persona/versions/:version/use", async (c) =>
    c.json(
      await service.accounts.usePersonaVersion(
        c.get("owner"),
        c.req.param("id"),
        z.coerce.number().int().min(1).parse(c.req.param("version")),
      ),
    ),
  );
  app.put("/accounts/:id/goal", async (c) =>
    c.json(await service.accounts.putGoal(c.get("owner"), c.req.param("id"), await c.req.json())),
  );
  // The project's brief, read by its tasks (`projectBrief`).
  app.get("/brief", async (c) => c.json(await service.projectBrief(c.get("owner"))));
  app.put("/brief", async (c) =>
    c.json(await service.setProjectBrief(c.get("owner"), await c.req.json())),
  );
  app.post("/identity", async (c) => {
    const body = z
      .object({
        name: z.string().trim().min(1).max(80),
        tone: z.enum(["warm", "concise", "thoughtful"]),
        avatar: z.enum(["sky", "sand", "lilac"]).optional(),
        showChatUpdates: z.boolean().optional(),
      })
      .parse(await c.req.json());
    const owner = c.get("owner");
    await service.ensure(owner);
    const identity = await service.db.compareAndSwap<AgentIdentity>(
      owner,
      "agent-settings",
      "identity",
      {},
      body,
    );
    if (!identity) throw new AppError("Agent identity changed; refresh and try again", 409);
    return c.json(identity);
  });
  app.get("/notifications", async (c) =>
    c.json(await service.db.list<AgentNotification>(c.get("owner"), "notifications")),
  );
  app.post("/notifications/:id/read", async (c) => {
    const notification = await service.db.compareAndSwap<AgentNotification>(
      c.get("owner"),
      "notifications",
      c.req.param("id"),
      {},
      { read: true },
    );
    if (!notification) throw new AppError("Notification not found", 404);
    return c.json(notification);
  });
  app.post("/sample-page", async (c) => {
    if (service.config.mode !== "sample") throw new AppError("Not found", 404);
    const body = z.object({ text: z.string().max(100000) }).parse(await c.req.json());
    await service.db.put(c.get("owner"), "sample-pages", { id: "availability", text: body.text });
    return c.json({ ok: true });
  });
  return app;
}
