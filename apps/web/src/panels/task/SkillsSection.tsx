/**
 * v1.4 (docs/skills.md): 设置 › 技能: the space's skills, shared by every member. Each row opens
 * into a form (name, 用途, 步骤) with 保存 and 删除.
 */

import { serverText, t } from "@m/shell/strings";
import { useWorkspace } from "@m/workspace";
import { useState } from "react";
import {
  type Skill,
  skillLimits,
  skillNeedsDescription,
} from "../../../../../packages/domain/src/skills";
import { useSkills } from "../../shell/useSkills";
import { Btn, ErrorLine, Field, TextArea } from "../../ui/primitives";
import { errorText, KV } from "./parts";

export function SkillsSection() {
  const { api } = useWorkspace();
  const { skills, reload } = useSkills();
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: "", description: "", steps: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const s = t.settings.skills;

  function edit(skill: Skill) {
    setOpen(skill.id);
    setDraft({ name: skill.name, description: skill.description, steps: skill.steps });
    setError("");
  }
  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await work();
      setOpen(null);
      await reload();
    } catch (e) {
      setError(s.failed(serverText(errorText(e))));
    } finally {
      setBusy(false);
    }
  }
  const save = (id: string) => run(() => api.request(`/api/skills/${id}`, draft, "PATCH"));
  const remove = (skill: Skill) => {
    if (window.confirm(s.confirmRemove(skill.name)))
      void run(() => api.request(`/api/skills/${skill.id}`, undefined, "DELETE"));
  };

  return (
    <div>
      <KV k={s.title}>{skills.length ? s.count(skills.length) : s.none}</KV>
      {skills.map((skill) => (
        <div key={skill.id}>
          <KV
            k={skill.name}
            right={
              open === skill.id ? null : (
                <Btn className="sm" onClick={() => edit(skill)}>
                  {s.open}
                </Btn>
              )
            }
          >
            <span className="tp-small">
              {skillNeedsDescription(skill) ? s.missingPurpose : skill.description}
            </span>
          </KV>
          {open === skill.id ? (
            <form
              className="tp-box"
              onSubmit={(e) => {
                e.preventDefault();
                void save(skill.id);
              }}
            >
              <Field
                label={s.name}
                value={draft.name}
                maxLength={skillLimits.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
              <Field
                label={s.description}
                hint={s.descriptionHint}
                required
                value={draft.description}
                maxLength={skillLimits.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
              <TextArea
                label={s.steps}
                rows={8}
                value={draft.steps}
                maxLength={skillLimits.steps}
                onChange={(e) => setDraft({ ...draft, steps: e.target.value })}
              />
              <ErrorLine error={error} />
              <div className="row">
                <Btn type="submit" variant="pri" className="sm" busy={busy}>
                  {s.save}
                </Btn>
                <Btn className="sm ghost" disabled={busy} onClick={() => remove(skill)}>
                  {s.remove}
                </Btn>
                <Btn className="sm ghost" disabled={busy} onClick={() => setOpen(null)}>
                  {t.common.cancel}
                </Btn>
              </div>
            </form>
          ) : null}
        </div>
      ))}
    </div>
  );
}
