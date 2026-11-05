/**
 * v1.2: the dialog behind the roster's +. A new member is a name, a shape and a color (the
 * avatar shows as you pick), and, if you like, a template to start from. No proxy, time zone,
 * language or site login is asked here: her time zone is the browser's, and the rest is set up
 * in her own conversation. On save the dialog closes and her conversation opens.
 */

import { settingsError } from "@m/computer-settings";
import { useProjects } from "@m/projects-state";
import { accountsDirectory } from "@m/shell/accounts/directory";
import { useAccountOps } from "@m/shell/accounts/hooks";
import { normalizeAccountViews, useShellData } from "@m/shell/data";
import {
  applyMemberTemplate,
  browserTimezone,
  newMemberBody,
  newMemberError,
  newMemberNameProblem,
} from "@m/shell/members/new-member";
import { useShellNav } from "@m/shell/nav";
import { t } from "@m/shell/strings";
import { useWorkspace } from "@m/workspace";
import { useRef, useState } from "react";
import {
  type FaceColor,
  type MemberFaceShape,
  memberFaceShapes,
} from "../../../../packages/domain/src/member-face";
import {
  memberTemplateById,
  memberTemplates,
} from "../../../../packages/domain/src/member-templates";
import { templateRoutineLine } from "../../../../packages/domain/src/template-setup";
import { MemberFace } from "../ui/MemberFace";
import { faceColors, pickFace } from "../ui/member-face";
import { Btn, ErrorLine, Field, Sheet } from "../ui/primitives";
import "./new-member.css";
import { peekAccount, setFrame } from "./state";

const n = t.newMember;

function close() {
  setFrame({ newMember: false });
}

export function NewMember() {
  const nav = useShellNav();
  const data = useShellData();
  const ops = useAccountOps();
  const { current, select } = useProjects();
  const { notify } = useWorkspace();
  const [name, setName] = useState("");
  // Until she picks, the preview shows what her name would pick.
  const [shape, setShape] = useState<MemberFaceShape | null>(null);
  const [color, setColor] = useState<FaceColor | null>(null);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // A retry after the template failed to save does not make a second member.
  const createdId = useRef<string | null>(null);
  const template = templateId ? memberTemplateById(templateId) : undefined;
  const zone = browserTimezone();
  const seeded = pickFace(name.trim() || "Yuki");
  const face = {
    shape: shape ?? (seeded.shape === "flake" ? "circle" : seeded.shape),
    color: color ?? seeded.color,
  } satisfies { shape: MemberFaceShape; color: FaceColor };

  function pickTemplate(id: string) {
    if (templateId === id) return setTemplateId(null);
    setTemplateId(id);
    const next = memberTemplateById(id);
    if (next) setName((typed) => (typed.trim() ? typed : next.name));
  }

  async function save() {
    if (busy) return;
    const problem = createdId.current ? null : newMemberNameProblem(name);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError("");
    try {
      // No project header: a new member lands in 未分配, as accounts always have.
      const api = data.apiFor(null);
      if (!createdId.current) {
        const [view] = normalizeAccountViews([
          await api.request<unknown>(
            "/api/environments",
            newMemberBody({ name, face, timezone: zone }),
          ),
        ]);
        if (view) {
          accountsDirectory.put(view);
          createdId.current = view.id;
        }
      }
      const id = createdId.current;
      if (template && id) {
        try {
          await applyMemberTemplate(api, template, id, zone);
        } catch (e) {
          setError(`${n.setupFailed} ${newMemberError(settingsError(e))}`);
          return;
        }
      }
      notify(n.created(name.trim()));
      await ops.afterChange();
      close();
      if (id) {
        setFrame({ drawer: false, platform: null });
        nav.setView("work");
        if (current !== null) select(null);
        peekAccount(id);
      }
    } catch (e) {
      setError(newMemberError(settingsError(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      title={n.title}
      onClose={close}
      footer={
        <>
          <Btn disabled={busy} onClick={close}>
            {t.common.cancel}
          </Btn>
          <Btn variant="pri" busy={busy} onClick={() => void save()}>
            {n.create}
          </Btn>
        </>
      }
    >
      <form
        className="nm-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="nm-preview">
          <MemberFace {...face} size={56} label={n.preview} />
          <span className="nm-preview-name">{name.trim() || n.namePlaceholder}</span>
        </div>
        <Field
          label={n.name}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError("");
          }}
          placeholder={n.namePlaceholder}
          disabled={busy || !!createdId.current}
          autoFocus
          autoComplete="off"
          autoCorrect="off"
        />
        <div className="nm-section">
          <span className="nm-label">{n.shape}</span>
          <div className="nm-shapes">
            {memberFaceShapes.map((item) => (
              <button
                key={item}
                type="button"
                className="nm-shape"
                title={n.shapes[item]}
                aria-label={n.shapes[item]}
                aria-pressed={face.shape === item}
                disabled={busy || !!createdId.current}
                onClick={() => setShape(item)}
              >
                <MemberFace shape={item} color={face.color} size={30} />
              </button>
            ))}
          </div>
        </div>
        <div className="nm-section">
          <span className="nm-label">{n.color}</span>
          <div className="nm-colors">
            {faceColors.map((item, index) => (
              <button
                key={item}
                type="button"
                className="nm-color"
                style={{ background: item }}
                aria-label={n.colorLabel(index + 1)}
                aria-pressed={face.color === item}
                disabled={busy || !!createdId.current}
                onClick={() => setColor(item)}
              />
            ))}
          </div>
        </div>
        <div className="nm-section">
          <span className="nm-label">{n.template}</span>
          <div className="nm-templates">
            {memberTemplates.map((item) => (
              <button
                key={item.id}
                type="button"
                className="nm-template"
                aria-pressed={templateId === item.id}
                disabled={busy}
                onClick={() => pickTemplate(item.id)}
              >
                {item.name}
              </button>
            ))}
          </div>
          {template ? (
            <div className="nm-note">
              <p>{template.role}</p>
              <p>
                {n.templateRoutines}
                {template.routines.map((routine) => templateRoutineLine(routine, zone)).join("、")}
              </p>
              {template.apps.length ? (
                <p>
                  {n.templateApps}
                  {template.apps.join("、")}
                </p>
              ) : null}
            </div>
          ) : (
            <p className="nm-note">{n.templateBlank}</p>
          )}
        </div>
        <ErrorLine error={error} />
      </form>
    </Sheet>
  );
}
