/**
 * v1.4 (docs/routines.md「Yuki's own routines」): Yuki's own card, the pane of her chat (the hall).
 * A routine asked for in her chat is hers: it runs in the space's own scope and reports there. The
 * card lists those routines with the same controls as a member's (RoutineCards).
 */

import { useShellData } from "@m/shell/data";
import { yukiRoutines } from "@m/shell/members/member-detail";
import { yukiMemberId } from "@m/shell/members/member-files";
import { t } from "@m/shell/strings";
import { X } from "lucide-react";
import { MemberFace } from "../ui/MemberFace";
import { IconBtn } from "../ui/primitives";
import { FilePreview, NotesList, useMemberFiles } from "./MemberFiles";
import { RoutineCards } from "./RoutineCards";
import "./new-member.css";

export function YukiDetail({ onClose }: { onClose: () => void }) {
  const data = useShellData();
  const routines = yukiRoutines(data.tasks);
  const ids = new Set(routines.map((routine) => routine.id));
  const files = useMemberFiles(yukiMemberId, null, t.app.name);
  return (
    <div className="member-detail">
      <div className="member-detail-h">
        <MemberFace shape="flake" color="var(--fg)" size={36} label={t.app.name} />
        <div className="roster-text">
          <span className="lbl">{t.app.name}</span>
          <span className="roster-line">{t.web.yukiRole}</span>
        </div>
        <IconBtn icon={X} label={t.common.close} onClick={onClose} />
      </div>
      <section>
        <h3>{t.memberFiles.duties}</h3>
        <FilePreview files={files} path="AGENTS.md" />
      </section>
      <section>
        <h3>例行</h3>
        {routines.length === 0 ? <p className="muted">没有例行</p> : null}
        <RoutineCards
          routines={routines}
          entries={data.entries.filter((entry) => ids.has(entry.task.id))}
          projectId={null}
        />
      </section>
      <section>
        <h3>{t.memberFiles.memory}</h3>
        <FilePreview files={files} path="MEMORY.md" />
      </section>
      <section>
        <h3>{t.memberFiles.notes}</h3>
        <NotesList files={files} />
      </section>
      <p className="roster-line">要加或改例行，直接在对话里跟 {t.app.name} 说。</p>
      {files.editor}
    </div>
  );
}
