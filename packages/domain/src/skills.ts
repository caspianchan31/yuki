// v1.4 (docs/skills.md): a skill is a named way of doing something, shared by every member of
// the space. Its content is data the people saved, never authority over a run.
export interface Skill {
  id: string;
  name: string;
  description: string;
  steps: string;
  /** `sentence`: the person said it in one line; `demo`: written from what was done in a chat. */
  source: "sentence" | "demo";
  createdAt: string;
  updatedAt: string;
}

/** Bounds on what a skill keeps. */
export const skillLimits = { name: 60, description: 300, steps: 8000 } as const;

/** The names and descriptions a run is told; the steps are read with use_skill. */
export const skillListing = (skills: readonly Pick<Skill, "name" | "description">[]) =>
  skills.map(({ name, description }) => ({ name, description }));

/** A skill saved before a description was required still loads; 设置 lists it as 缺用途说明 until
 * it has one. */
export const skillNeedsDescription = (skill: Pick<Skill, "description">) =>
  !skill.description.trim();

/** The skills a text names with `@name` (case does not matter; a name with spaces counts whole,
 * and `@name` followed by more letters or digits is another name). In the order of the text. */
export function skillsMentioned<T extends Pick<Skill, "name">>(
  text: string,
  skills: readonly T[],
): T[] {
  const lower = text.toLowerCase();
  const found: { at: number; skill: T }[] = [];
  for (const skill of skills) {
    const mark = `@${skill.name.toLowerCase()}`;
    for (let at = lower.indexOf(mark); at >= 0; at = lower.indexOf(mark, at + 1)) {
      const next = lower[at + mark.length];
      if (next === undefined || !/[a-z0-9_]/.test(next)) {
        found.push({ at, skill });
        break;
      }
    }
  }
  // `@Some skill` also reads as `@Some`: the longer name at the same place wins.
  return found
    .filter((a) => !found.some((b) => b.at === a.at && b.skill.name.length > a.skill.name.length))
    .sort((a, b) => a.at - b.at)
    .map((item) => item.skill);
}
