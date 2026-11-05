import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { TestContext } from "node:test";

/** `arguments` as a string is sent as it is (a model's malformed JSON). */
type ModelCall = { name: string; arguments: object | string };
const argumentsOf = (call: ModelCall) =>
  typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments);
/** A reply of text alone, no tool call (fork: the email check answers in text). */
type ModelText = { text: string };
type Reply = ModelCall | ModelText | undefined;
const isText = (reply: Reply): reply is ModelText => !!reply && "text" in reply;

/** Whether the request forces route_request (the hall's first turn). */
function forcesRoute(body: string) {
  try {
    const choice = (
      JSON.parse(body) as { tool_choice?: { name?: string; function?: { name?: string } } }
    ).tool_choice;
    return choice?.name === "route_request" || choice?.function?.name === "route_request";
  } catch {
    return false;
  }
}
/** The replies a test plays, with the hall's forced first turn
 * answered "for no project" by itself unless the test's next reply routes it. The test's replies
 * keep their own numbering (an automatic routing takes no index). */
let autoRoutes = 0;
function routedReplies(reply: (index: number) => Reply | Promise<Reply>) {
  let held: { value: Reply } | null = null;
  return async (body: string, index: number): Promise<{ answer: Reply; automatic: boolean }> => {
    const answer = held ? held.value : await reply(index);
    held = null;
    const routes = !!answer && !isText(answer) && answer.name === "route_request";
    if (forcesRoute(body) && !routes) {
      held = { value: answer };
      return {
        answer: {
          name: "route_request",
          arguments: { project: null, why: "fixture: for no project" },
        },
        automatic: true,
      };
    }
    return { answer, automatic: false };
  };
}

// Serve the provider protocol, leaving tool execution and AG-UI event emission to the real SDK.
export async function modelFixture(
  t: TestContext,
  reply: (index: number) => Reply | Promise<Reply>,
  options: {
    errorStatus?: (index: number) => number | undefined;
    /** The JSON `error` an `errorStatus` answer carries (default: a server_error). */
    errorBody?: (index: number) => object | undefined;
    dropAfterStart?: (index: number) => boolean;
    dropAfterText?: (index: number) => boolean;
    errorPart?: (index: number) => boolean;
  } = {},
) {
  const { errorStatus, errorBody, dropAfterStart, dropAfterText, errorPart } = options;
  const next = routedReplies(reply);
  const requests: { path: string; body: string }[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const index = requests.length;
    requests.push({ path: request.url ?? "", body });
    const status = errorStatus?.(index);
    if (status !== undefined) {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: errorBody?.(index) ?? {
            message: "Fixture provider failure",
            type: "server_error",
          },
        }),
      );
      return;
    }
    if (dropAfterStart?.(index)) {
      // Deliver a valid stream start, then fail the connection before any
      // assistant output reaches the client.
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({
          type: "response.created",
          response: {
            id: `drop-${index}`,
            created_at: 1000,
            model: "fixture",
            status: "in_progress",
          },
        })}\n\n`,
      );
      setTimeout(() => response.socket?.destroy(), 120);
      return;
    }
    if (dropAfterText?.(index)) {
      // Deliver real assistant output, then fail the connection. A retry
      // must not replay output the client already received.
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({
          type: "response.created",
          response: {
            id: `drop-text-${index}`,
            created_at: 1000,
            model: "fixture",
            status: "in_progress",
          },
        })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({
          type: "response.output_item.added",
          output_index: 0,
          item: {
            id: `msg-${index}`,
            type: "message",
            role: "assistant",
            status: "in_progress",
            content: [],
          },
        })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({
          type: "response.output_text.delta",
          item_id: `msg-${index}`,
          output_index: 0,
          delta: "Hello partial ",
        })}\n\n`,
      );
      setTimeout(() => response.socket?.destroy(), 120);
      return;
    }
    if (errorPart?.(index)) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({
          type: "response.failed",
          sequence_number: 1,
          response: {
            error: { code: "server_error", message: "Provider reported response.failed" },
          },
        })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
      return;
    }
    const routed = await next(body, index);
    const answer = routed.answer;
    // An automatic routing turn is not one of the test's requests.
    if (routed.automatic) requests.pop();
    const tag = routed.automatic ? `auto-${++autoRoutes}` : String(index);
    const call = isText(answer) ? undefined : answer;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const emit = (type: string, value: object) =>
      response.write(`data: ${JSON.stringify({ type, ...value })}\n\n`);
    const base = { id: `response-${tag}`, created_at: 1000, model: "fixture" };
    emit("response.created", { response: { ...base, status: "in_progress" } });
    const message = isText(answer) && {
      id: `msg-${tag}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: answer.text, annotations: [] }],
    };
    if (message && isText(answer)) {
      emit("response.output_item.added", {
        output_index: 0,
        item: { ...message, status: "in_progress", content: [] },
      });
      emit("response.output_text.delta", {
        item_id: message.id,
        output_index: 0,
        content_index: 0,
        delta: answer.text,
      });
      emit("response.output_text.done", {
        item_id: message.id,
        output_index: 0,
        content_index: 0,
        text: answer.text,
      });
      emit("response.output_item.done", { output_index: 0, item: message });
    }
    const item = call && {
      id: `item-${tag}`,
      type: "function_call",
      call_id: `call-${tag}`,
      name: call.name,
      arguments: argumentsOf(call),
    };
    if (item) {
      emit("response.output_item.added", { output_index: 0, item: { ...item, arguments: "" } });
      emit("response.function_call_arguments.delta", {
        item_id: item.id,
        output_index: 0,
        delta: item.arguments,
      });
      emit("response.output_item.done", {
        output_index: 0,
        item: { ...item, status: "completed" },
      });
    }
    emit("response.completed", {
      response: {
        ...base,
        status: "completed",
        output: item ? [{ ...item, status: "completed" }] : message ? [message] : [],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    });
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const previousBase = process.env.OPENAI_BASE_URL;
  const previousKey = process.env.OPENAI_API_KEY;
  const previousChatCompletions = process.env.OPENAI_CHAT_COMPLETIONS;
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  process.env.OPENAI_API_KEY = "local-test-fixture";
  // This fixture serves the Responses protocol; a developer .env flag must
  // not switch the adapter under test to the Chat Completions wire format.
  delete process.env.OPENAI_CHAT_COMPLETIONS;
  t.after(async () => {
    if (previousBase === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousBase;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousChatCompletions === undefined) delete process.env.OPENAI_CHAT_COMPLETIONS;
    else process.env.OPENAI_CHAT_COMPLETIONS = previousChatCompletions;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { requests };
}

// The same fixture protocol served in the OpenAI Chat Completions wire format
// (`/v1/chat/completions` SSE), for the optional gateway adapter path.
export async function chatCompletionsFixture(
  t: TestContext,
  reply: (index: number) => Reply | Promise<Reply>,
) {
  const requests: { path: string; body: string }[] = [];
  const next = routedReplies(reply);
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const index = requests.length;
    requests.push({ path: request.url ?? "", body });
    const routed = await next(body, index);
    const answer = routed.answer;
    // An automatic routing turn is not one of the test's requests.
    if (routed.automatic) requests.pop();
    const tag = routed.automatic ? `auto-${++autoRoutes}` : String(index);
    const call = isText(answer) ? undefined : answer;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta: object, finish: string | null) =>
      response.write(
        `data: ${JSON.stringify({
          id: `chatcmpl-${tag}`,
          object: "chat.completion.chunk",
          created: 1000,
          model: "fixture",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`,
      );
    chunk({ role: "assistant" }, null);
    if (isText(answer)) chunk({ content: answer.text }, null);
    else if (call) {
      chunk({ content: "I'll check first." }, null);
      chunk(
        {
          tool_calls: [
            {
              index: 0,
              id: `call-${tag}`,
              type: "function",
              function: { name: call.name, arguments: argumentsOf(call) },
            },
          ],
        },
        "tool_calls",
      );
    } else {
      chunk({ content: "Current state: empty." }, null);
    }
    chunk({}, "stop");
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const previousBase = process.env.OPENAI_BASE_URL;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  process.env.OPENAI_API_KEY = "local-test-fixture";
  t.after(async () => {
    if (previousBase === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousBase;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { requests };
}
