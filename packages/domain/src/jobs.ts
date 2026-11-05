// A job (「活」) is a piece of work on the project, in
// the owner's words, given to one, several or all of the project's accounts. Each account takes it
// inside its own operating loop, by its persona, or declines it with its reason; a job every
// account it went to has finished (or declined, or left) is done and archived. 「专号专用」 is a
// job given to everyone, which accounts that join the project later take too. Only types and size
// bounds live here: the server judges no content.
import { z } from "zod";

export const jobTitleMax = 160;
export const jobBriefMax = 4000;
export const jobNoteMax = 1000;
export const jobReasonMax = 600;
export const jobDueTextMax = 200;

/** Where one account stands on a job: given it, took it, declined it (with its reason), finished
 * it, or no longer has it (`dropped`, see `JobAssignee.dropped`). */
export const jobAssigneeStatuses = ["assigned", "taken", "declined", "done", "dropped"] as const;
export type JobAssigneeStatus = (typeof jobAssigneeStatuses)[number];
/** Statuses of an account still working on the job (they keep its loop running). */
export const jobActiveStatuses: readonly JobAssigneeStatus[] = ["assigned", "taken"];
/** Why an account no longer has a job: the owner took it off the job (`owner`) or stopped the
 * account's operating (`stopped`), the account left the project (`moved`) or was deleted. */
export type JobDropReason = "owner" | "stopped" | "moved" | "removed";

export interface JobAssignee {
  envId: string;
  /** The account's name when it was last written (the live name wins in views). */
  name: string;
  status: JobAssigneeStatus;
  /** A decline's reason, in the account's own words. */
  reason: string | null;
  /** The account's latest note on it (taken, progress, done). */
  note: string | null;
  /** The owner gave the job again after the account declined it. */
  ownerInsisted: boolean;
  dropped?: JobDropReason;
  at: string;
}
/** The owner's deadline in his words, and the time it names when that could be told. */
export interface JobDue {
  text: string;
  at: string | null;
}
/** `project-job/<id>` under the project's owner: removed with the project. */
export interface ProjectJob {
  id: string;
  title: string;
  /** The owner's words. */
  brief: string;
  due: JobDue | null;
  /** Given to every account of the project, those that join later included. */
  everyone: boolean;
  assignees: JobAssignee[];
  status: "open" | "done";
  /** The conversation it was made in (its cards go there) and who asked; null for one made by
   * the system (the v0.6 migration). */
  origin: { threadId: string | null; userId: string | null } | null;
  /** The task that asked the founder for it (request_founder); absent on
   * every other job. */
  requestedBy?: string;
  createdAt: string;
  updatedAt: string;
  doneAt: string | null;
  archivedAt: string | null;
  /** Why the owner ended it (close_job), when he did. */
  closedReason: string | null;
  /** Bumped on every write (compare-and-swap). */
  version: number;
}
/** A job as the owner's screens read it: each account by its current name (null: deleted). */
export interface JobView extends Omit<ProjectJob, "assignees"> {
  assignees: (JobAssignee & { live: boolean })[];
}
/** An action an account reported for the job (its ledger rows with this `jobId`). */
export interface JobAction {
  account: string;
  environmentId: string;
  site: string | null;
  action: string;
  permalink: string | null;
  target: string | null;
  at: string;
}

const accountName = z.string().trim().min(1).max(200);
export const jobIdSchema = z.string().trim().min(1).max(200).describe("The job's id");
/** A deadline: the person's words, and the time they name when that can be told. */
export const jobDueSchema = z.object({
  text: z.string().trim().min(1).max(jobDueTextMax),
  at: z.iso.datetime({ offset: true }).nullable().optional(),
});
const titleSchema = z.string().trim().min(1).max(jobTitleMax);
const briefSchema = z.string().trim().min(1).max(jobBriefMax);
/** The chat's create_job (and the v0.6 migration task's). */
export const createJobSchema = z.object({
  title: titleSchema.describe("A short name for the job"),
  brief: briefSchema.describe("What the person wants done, in their words"),
  due: jobDueSchema
    .nullable()
    .optional()
    .describe("The deadline in the person's words, and the time it names (at) when you can tell"),
  assignees: z
    .union([z.array(accountName).min(1).max(100), z.literal("everyone")])
    .describe(
      "The accounts of this project it goes to (names, labels or saved user names), or everyone: every account, those added later too",
    ),
  reason: z
    .string()
    .trim()
    .max(jobReasonMax)
    .optional()
    .describe("For the person: why these accounts"),
  /** Only in the space's hall, the project the job is for. */
  project: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .optional()
    .describe(
      "Only in the 营销总群 (the space's own conversation): the project this job is for, by name; the job is kept in that project. Leave it out in a project's own conversation",
    ),
});
/** Request_founder, in a project's account loop or a task on its
 * default desktop: the project asks the space's founder for a piece of its work, which becomes a
 * job given to the founder in this project (asked for in the 营销总群). */
export const requestFounderSchema = z.object({
  title: titleSchema.describe("A short name for the work"),
  brief: briefSchema.describe(
    "What the founder should do for this project and why it needs the founder for it",
  ),
  due: jobDueSchema
    .nullable()
    .optional()
    .describe("When it is needed, and the time it names (at) when you can tell"),
});
/** Request_project, in the founder's loop: the founder hands a
 * piece of its work to a project to carry on, the reverse of request_founder. */
export const requestProjectSchema = z.object({
  project: z.string().trim().min(1).max(80).describe("The project that carries it on, by name"),
  title: titleSchema.describe("A short name for the work"),
  brief: briefSchema.describe(
    "What the project should carry on, what you did before it and why it is the project's",
  ),
  due: jobDueSchema
    .nullable()
    .optional()
    .describe("When it is needed, and the time it names (at) when you can tell"),
});
/** The run event of request_project (its detail: the work's title). */
export const projectRequestedLabel = "Asked a project";
/** The run event of request_founder (its detail: the job's title). */
export const founderRequestedLabel = "Asked the founder";
/** The chat's assign_job: accounts added (one that declined it is given it again: the person
 * insists) or taken off. */
export const assignJobSchema = z
  .object({
    jobId: jobIdSchema,
    add: z.array(accountName).max(100).optional(),
    remove: z.array(accountName).max(100).optional(),
  })
  .refine((value) => !!(value.add?.length || value.remove?.length), "add or remove an account");
/** The chat's update_job; `reopen` opens a finished job again. */
export const updateJobSchema = z.object({
  jobId: jobIdSchema,
  title: titleSchema.optional(),
  brief: briefSchema.optional(),
  due: jobDueSchema.nullable().optional().describe("null removes the deadline"),
  reopen: z.boolean().optional().describe("Open a finished job again"),
});
export const closeJobSchema = z.object({
  jobId: jobIdSchema,
  reason: z.string().trim().min(1).max(jobReasonMax).describe("Why it ends, in the person's words"),
});
export const listJobsSchema = z.object({
  archived: z.boolean().optional().describe("Also the finished, archived jobs"),
});
/** respond_to_job, in an account's own loop. */
export const respondToJobSchema = z
  .object({
    jobId: jobIdSchema,
    decision: z
      .enum(["take", "decline", "done", "progress"])
      .describe(
        "take: you do it; decline: it does not fit the persona (say why in note); done: your part is finished; progress: a note on how it goes",
      ),
    note: z
      .string()
      .trim()
      .max(jobNoteMax)
      .optional()
      .describe("For the person: your reason, or what was done"),
  })
  .refine(
    (value) => value.decision !== "decline" || !!value.note?.trim(),
    "a decline needs its reason in note",
  );
/** The owner's own edits from the job panel. */
export const ownerJobPatchSchema = z.object({
  title: titleSchema.optional(),
  brief: briefSchema.optional(),
  due: z.string().trim().max(jobDueTextMax).nullable().optional(),
  reopen: z.boolean().optional(),
});
export const ownerJobAssignSchema = z
  .object({
    add: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
    remove: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  })
  .refine((value) => !!(value.add?.length || value.remove?.length), "add or remove an account");
export const ownerJobCloseSchema = z.object({
  reason: z.string().trim().max(jobReasonMax).optional(),
});

/** Set_project_priorities: the projects by name, first comes first. */
export const setProjectPrioritiesSchema = z.object({
  projects: z
    .array(z.string().trim().min(1).max(200))
    .min(1)
    .max(100)
    .describe("The projects' names in the order the founder serves them, first comes first"),
});
