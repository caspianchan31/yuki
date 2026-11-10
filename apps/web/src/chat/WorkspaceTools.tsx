/**
 * Phase C (docs/web.md): the frontend tools the chat registers with CopilotKit and the card
 * each draws in the timeline, from chat.tsx's WorkspaceTools. The names and descriptions are
 * chat-state.tsx's `workspaceTools` (the phone registers the same); the model's view of the
 * project is useWorkspaceModelContext. Mounted once, inside ChatArea.
 */
import { useRenderTool } from "@copilotkit/react-native/headless";
import {
  displayParameters,
  useWorkspaceModelContext,
  type WorkspaceToolName,
  workspaceTool,
  workspaceTools,
} from "@m/chat-state";
import type { ReactElement } from "react";
import {
  DelegatedTaskCard,
  ProjectToolCard,
  RedirectCard,
  RouteLine,
  ServerToolCard,
} from "./ChatCards";
import {
  BrowserToolCard,
  CommandStepCard,
  ComputerShotCard,
  ComputerStepLine,
  DesktopStepCard,
  JevToolCard,
  MailToolCard,
  SearchToolCard,
} from "./ToolCards";

type RenderProps = {
  toolCallId: string;
  args: Record<string, unknown>;
  result: unknown;
  status: string;
};

/** A step on the members' computer: one line, what the member did. */
const step =
  (name: string) =>
  ({ args, result, status }: RenderProps) => (
    <ComputerStepLine name={name} args={args} result={result} loading={status !== "complete"} />
  );

const renderers: Record<WorkspaceToolName, (props: RenderProps) => ReactElement | null> = {
  search_mail: ({ result, status }) => (
    <MailToolCard search result={result} loading={status !== "complete"} />
  ),
  read_mail_thread: ({ result, status }) => (
    <MailToolCard result={result} loading={status !== "complete"} />
  ),
  search_web: ({ result, status }) => (
    <SearchToolCard result={result} loading={status !== "complete"} />
  ),
  browse_web: ({ args, result, status }) => (
    <BrowserToolCard url={args.url} result={result} loading={status !== "complete"} />
  ),
  // A desktop step draws its run's one block
  // (at the run's last step), never a card of its own; a command that opens the desktop browser
  // is a step of the same run.
  use_desktop: ({ toolCallId }) => <DesktopStepCard toolCallId={toolCallId} />,
  // The open build's computer: a screenshot a member took is shown to the person.
  computer_screenshot: ({ result, status }) => (
    <ComputerShotCard result={result} loading={status !== "complete"} />
  ),
  run_computer_command: ({ toolCallId, args, result, status }) => (
    <CommandStepCard
      toolCallId={toolCallId}
      args={args}
      result={result}
      loading={status !== "complete"}
    />
  ),
  // v1.5.1: the members' computer's steps, one line each in the reply's folded 过程.
  computer_status: step("computer_status"),
  start_computer: step("start_computer"),
  stop_computer: step("stop_computer"),
  list_computer_files: step("list_computer_files"),
  read_computer_file: step("read_computer_file"),
  write_computer_file: step("write_computer_file"),
  mkdir_computer: step("mkdir_computer"),
  import_computer_pdf: step("import_computer_pdf"),
  export_computer_pdf: step("export_computer_pdf"),
  computer_browser: step("computer_browser"),
  computer_desktop: step("computer_desktop"),
  computer_mouse: step("computer_mouse"),
  present_choices: ({ result, status }) => (
    <JevToolCard result={result} loading={status !== "complete"} />
  ),
  request_credential: () => null,
  // The task card, once, at the moment of delegation, with a live state.
  delegate_task: ({ result, status }) => (
    <DelegatedTaskCard result={result} loading={status !== "complete"} />
  ),
  // The project the 营销总群 made for a request, and the way to it.
  create_project: ({ result, status }) => (
    <ProjectToolCard result={result} loading={status !== "complete"} />
  ),
  // Whose a hall request is: one line, nothing for no project.
  route_request: ({ args, result, status }) => (
    <RouteLine args={args} result={result} loading={status !== "complete"} />
  ),
  // The redirected task by its title and state word, never its id.
  redirect_task: ({ args, result, status }) => (
    <RedirectCard args={args} result={result} loading={status !== "complete"} />
  ),
  // The task the person paused or resumed in the chat, the same card.
  pause_task: ({ args, result, status }) => (
    <RedirectCard kind="pause" args={args} result={result} loading={status !== "complete"} />
  ),
  resume_task: ({ args, result, status }) => (
    <RedirectCard kind="resume" args={args} result={result} loading={status !== "complete"} />
  ),
  agent_status: ({ result, status }) => (
    <ServerToolCard name="agent_status" result={result} loading={status !== "complete"} />
  ),
  task_events: ({ result, status }) => (
    <ServerToolCard name="task_events" result={result} loading={status !== "complete"} />
  ),
  create_goal: ({ result, status }) => (
    <ServerToolCard name="create_goal" result={result} loading={status !== "complete"} />
  ),
  watch_page: ({ result, status }) => (
    <ServerToolCard name="watch_page" result={result} loading={status !== "complete"} />
  ),
  remember_fact: ({ result, status }) => (
    <ServerToolCard name="remember_fact" result={result} loading={status !== "complete"} />
  ),
};

/** One tool registered with its card (a component per tool, so each registers once). */
function Tool({ name }: { name: WorkspaceToolName }) {
  const render = renderers[name];
  useRenderTool({
    ...workspaceTool(name),
    parameters: displayParameters,
    render: (props: RenderProps) => render(props),
  } as Parameters<typeof useRenderTool>[0]);
  return null;
}

const names: WorkspaceToolName[] = workspaceTools.map((tool) => tool.name);

export function WorkspaceTools() {
  // The model sees the current project, its accounts and a short
  // task summary.
  useWorkspaceModelContext();
  return (
    <>
      {names.map((name) => (
        <Tool key={name} name={name} />
      ))}
    </>
  );
}
