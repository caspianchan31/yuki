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
  JobToolCard,
  ProjectToolCard,
  RedirectCard,
  RouteLine,
  ServerToolCard,
} from "./ChatCards";
import {
  BrowserToolCard,
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
  run_computer_command: ({ toolCallId }) => <DesktopStepCard toolCallId={toolCallId} />,
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
  // The project's jobs, in the capybara's words (查看 opens the job).
  create_job: ({ result, status }) => (
    <JobToolCard name="create_job" result={result} loading={status !== "complete"} />
  ),
  assign_job: ({ result, status }) => (
    <JobToolCard name="assign_job" result={result} loading={status !== "complete"} />
  ),
  update_job: ({ result, status }) => (
    <JobToolCard name="update_job" result={result} loading={status !== "complete"} />
  ),
  close_job: ({ result, status }) => (
    <JobToolCard name="close_job" result={result} loading={status !== "complete"} />
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
