// v1.2: making a member needs only a name, a shape and a color (and, optionally, a template).
// The body, the checks and the template setup live here so they run under node:test.
import {
  canonicalTimezone,
  environmentNameMax,
  isReservedEnvironmentName,
} from "../../../../../packages/domain/src/environments.ts";
import type { MemberFace } from "../../../../../packages/domain/src/member-face.ts";
import type { MemberTemplate } from "../../../../../packages/domain/src/member-templates.ts";
import {
  templateAgents,
  templateSetup,
} from "../../../../../packages/domain/src/template-setup.ts";
import { refusalText, t } from "../strings.ts";

const n = t.newMember;

/** The browser's time zone in the spelling the server accepts; "" when it is not one of them. */
export function browserTimezone(
  read: () => string | undefined = () => Intl.DateTimeFormat().resolvedOptions().timeZone,
): string {
  try {
    const zone = read();
    return zone ? (canonicalTimezone(zone) ?? "") : "";
  } catch {
    return "";
  }
}

/** What is wrong with the typed name before it is sent; null when nothing is. */
export function newMemberNameProblem(name: string): string | null {
  const text = name.trim();
  if (!text) return n.nameRequired;
  if ([...text].length > environmentNameMax) return n.nameTooLong(environmentNameMax);
  if (isReservedEnvironmentName(text)) return n.nameReserved(text);
  return null;
}

/** POST /api/environments for a new member: the name, her face, and the browser's time zone so
 * a template's clock routines wake at the person's hours. */
export function newMemberBody(input: { name: string; face: MemberFace; timezone: string }) {
  return {
    name: input.name.trim(),
    face: { shape: input.face.shape, color: input.face.color },
    ...(input.timezone ? { timezone: input.timezone } : {}),
  };
}

/** A refusal of the create request, in Chinese and in the words of a member (never 账号). */
export function newMemberError(message: string): string {
  let match = /^An environment named "(.*)" already exists$/.exec(message);
  if (match) return n.exists(match[1]);
  match = /^Environments are limited to (\d+)$/.exec(message);
  if (match) return n.limit(Number(match[1]));
  if (message === "Name is required") return n.nameRequired;
  match = /^Name must be (?:at most )?(\d+) characters(?: or fewer)?$/.exec(message);
  if (match) return n.nameTooLong(Number(match[1]));
  match = /^Name "(.*)" is reserved/.exec(message);
  if (match) return n.nameReserved(match[1]);
  if (/^Face (shape|color) is not one of the listed/.test(message)) return n.faceInvalid;
  return refusalText(message);
}

interface TemplateApi {
  request<T>(path: string, body?: unknown, method?: string): Promise<T>;
}

/** Saves a template on a member: her persona, her goal, and one repeating task per routine that
 * has an interval, then her AGENTS.md. The first three calls are what the account editor made. */
export async function applyMemberTemplate(
  api: TemplateApi,
  template: MemberTemplate,
  environmentId: string,
  timeZone: string,
  name = template.name,
): Promise<void> {
  const setup = templateSetup(template, environmentId, timeZone);
  const path = `/api/agent/accounts/${encodeURIComponent(environmentId)}`;
  await api.request(`${path}/persona`, { fields: setup.persona }, "PUT");
  await api.request(`${path}/goal`, { text: setup.goal }, "PUT");
  for (const task of setup.tasks) await api.request("/api/agent/tasks", task);
  // Her duties and routines, written into her AGENTS.md (it replaces the first fill).
  await api.request(
    `/api/members/${encodeURIComponent(environmentId)}/files/AGENTS.md`,
    { content: templateAgents(template, name) },
    "PUT",
  );
}
