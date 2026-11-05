// Every screen the person reaches speaks Chinese. Fixed English
// from the server or the browser is mapped (serverText); the chat's old tool cards and the
// sign-in screens read their words from shell/strings.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { displayJevUserMessage } from "../../../packages/client/src/jev-actions.ts";
import { editorError } from "../../../packages/client/src/shell/accounts/accounts-core.ts";
import {
  actionWord,
  failureText,
  fileSourceText,
  phaseWords,
  refusalText,
  reportLabel,
  reportWords,
  serverText,
  t,
} from "../../../packages/client/src/shell/strings.ts";
import {
  actionReportLabel,
  attentionReportLabels,
  overPaceSuffix,
  pacingReportLabels,
  pacingWaitLabel,
  planReportLabel,
  runStoppedLabel,
  topicReportLabels,
} from "../../../packages/domain/src/agent.ts";
import { runEndedWithoutCompletionQuestion } from "../../../packages/domain/src/task-phase.ts";

test("known server and browser messages read in Chinese, line by line", () => {
  assert.equal(serverText("Changed by you"), "你改的");
  assert.equal(serverText("Task paused"), "任务已暂停");
  assert.equal(serverText("Repeats every 120 min"), "改成每 120 分钟重复");
  assert.equal(serverText("Understand the outcome"), "弄清要的结果");
  assert.equal(serverText("Username or password is incorrect"), "用户名或密码不对。");
  assert.equal(serverText("Password must be at least 8 characters"), "密码至少 8 位。");
  assert.equal(serverText("TypeError: Failed to fetch"), "连不上服务器，检查网络后再试。");
  assert.equal(serverText("Request failed (503)"), "请求没成功（503），稍后再试。");
  assert.equal(
    serverText(`${t.common.errorPrefix}Failed to fetch`),
    `${t.common.errorPrefix}连不上服务器，检查网络后再试。`,
  );
  // A wait's detail: the task's own note stays, the fixed last line is mapped.
  assert.equal(serverText("已评论 1/3\nResumes at 15:00"), "已评论 1/3\n15:00 继续");
  // The next run's time is a clock, never the server's ISO timestamp (fork, report line).
  const next = new Date();
  next.setHours(18, 5, 0, 0);
  assert.equal(
    serverText(`Run 2 finished; next run ${next.toISOString()}`),
    "第 2 轮完成，下一轮 18:05",
  );
  // Run events of the other task kinds read in Chinese too (fixer round 3).
  for (const title of [
    "Found the document",
    "Saved a filled copy",
    "Analyzing the imported transactions",
    "Reply completed",
    "Task interrupted",
  ])
    assert.doesNotMatch(serverText(title), /[A-Za-z]/, title);
  // A tool's failure never names the tool (fork, report line).
  assert.equal(serverText("browse_web failed"), "有一步没成功");
  // The account pacing PATCH answers with its bounds (several joined by "; ").
  assert.equal(
    serverText("minGapMinutes must be a whole number; a cap must not be negative"),
    "间隔分钟要填整数; 每天上限不能是负数",
  );
  assert.equal(
    serverText(`${t.common.errorPrefix}activeHours start must be before its end`),
    `${t.common.errorPrefix}活动时段的起点要早于终点`,
  );
});

test("a review sent without a decision, and its waiting notice, read in Chinese", () => {
  // Service.ts executeOnce writes the way a decided review went out as
  // the status event's title; publishOutcome writes the body of the review notice.
  assert.equal(serverText("Sent: nobody declined"), "6 小时内没人拒绝，已发出");
  assert.equal(serverText("Sent by your rule"), "按你定的规则，已发出");
  assert.equal(
    serverText(
      "A prepared action is waiting for your review. Open the task to approve or decline it.",
    ),
    "有一个准备好的动作在等你审阅，打开任务就能同意或拒绝。",
  );
});

test("an account task's run stopped by the infrastructure reads in Chinese in its timeline", () => {
  // The event of service.ts runStopped; its detail's last line is the
  // resume time.
  assert.equal(serverText(runStoppedLabel), "这轮被模型服务、网络或桌面打断，稍后自己接着做");
  assert.equal(serverText("Resumes at 08:00"), "08:00 继续");
  // The server writes the time as an ISO timestamp; the timeline shows a
  // clock, and the plan card's event reads in Chinese.
  const resume = new Date();
  resume.setHours(16, 50, 0, 0);
  assert.equal(serverText(`Resumes at ${resume.toISOString()}`), "16:50 继续");
  assert.equal(serverText("Plan v1"), "计划第 1 版");
  // The fixed question a task stopped on before the report line, as a past card shows it: no
  // count and no limit (there is none any more).
  assert.doesNotMatch(serverText(runEndedWithoutCompletionQuestion), /[A-Za-z]|续跑|用完/);
});

test("a provider's refusal of a request reads in Chinese by its error type, never as its JSON", () => {
  // A 400 invalid_request_error (a tool schema the provider refused)
  // showed its raw JSON on the report card and the live panel.
  const kinds = t.server.providerError;
  const cases: [string, string][] = [
    [
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"tools.12.custom.input_schema: JSON schema is invalid"},"request_id":"req_1"}',
      kinds.request,
    ],
    // A gateway relaying its upstream's failure is the provider's side, not our request
    // (sub2api's "400 Upstream request failed" read as 「这要改程序」).
    ["400 Upstream request failed", kinds.server],
    // A relay that answered with nothing showed its bare code on the card.
    ["empty_stream", kinds.empty],
    [
      '{"error":{"code":400,"message":"Upstream request failed","param":null,"type":"upstream_error"}}',
      kinds.server,
    ],
    [
      "400 Invalid schema for function 'x': In context=(), array schema missing items.",
      kinds.request,
    ],
    [
      '{"error":{"code":400,"message":"Invalid JSON payload","status":"INVALID_ARGUMENT"}}',
      kinds.request,
    ],
    [
      '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      kinds.auth,
    ],
    ["403 Project does not have access to model y", kinds.permission],
    [
      '404 {"error":{"message":"The model `z` does not exist","type":"invalid_request_error","code":"model_not_found"}}',
      kinds.notFound,
    ],
    ["404 model: z", kinds.notFound],
    [
      '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      kinds.server,
    ],
    ["429 Rate limit reached for requests", kinds.rateLimit],
  ];
  for (const [error, expected] of cases) {
    assert.equal(failureText(error), expected, error);
    // The report card of a failed task (出问题) and the live panel read the same.
    assert.equal(reportWords("Needs attention")(error), expected, error);
  }
  for (const text of Object.values(kinds).filter((v): v is string => typeof v === "string"))
    assert.doesNotMatch(text, /[A-Za-z{}"]/, text);
  assert.doesNotMatch(kinds.other("418"), /[A-Za-z{}"]/);
  assert.equal(failureText("418 I'm a teapot"), kinds.other("418"));
  // The quota answer keeps its own reason; a line that is not a provider's stays as it was.
  assert.equal(failureText("429 insufficient_quota"), t.server.providerQuota);
  assert.equal(failureText("Model run timed out"), serverText("Model run timed out"));
  // Only for a failure: a report that quotes such a line stays as written.
  assert.equal(serverText("400 Invalid schema"), "400 Invalid schema");
});

test("a provider's balance, quota or billing answer reads as the owner's plain reason", () => {
  // Fixer round 2: only where the text is a failure; anything else that mentions billing (a
  // report, a step) stays as written.
  assert.equal(serverText("429 insufficient_quota"), "429 insufficient_quota");
  // Round 4, blocking 1: it fails the task into 需要你; this is what the person reads there.
  for (const error of [
    "429 You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.",
    '{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details.","status":"RESOURCE_EXHAUSTED"}}',
    "429 insufficient_quota",
    "400 Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
  ])
    assert.equal(failureText(error), t.server.providerQuota, error);
  assert.doesNotMatch(t.server.providerQuota, /[A-Za-z]/);
  assert.match(t.server.providerQuota, /模型服务/);
  // The failure line of the shared table maps it too (rail row, need card).
  assert.equal(
    phaseWords.failed("429 You exceeded your current quota, please check your plan.", 1),
    t.server.providerQuota,
  );
  // An infrastructure incident in the task's line.
  assert.equal(
    phaseWords.incident?.("desktop", "13:02", "14:00"),
    "桌面没响应（13:02 起） · 14:00 再试",
  );
  assert.equal(
    phaseWords.incident?.("model", "13:02", ""),
    "模型服务连不上（13:02 起） · 自己会再试",
  );
});

test("what the model or a person wrote is never rewritten", () => {
  for (const text of [
    "Posted a reply in r/IPhoneApps",
    "Task 5 of the plan",
    "Changed by you and then reverted",
    "用 Oak_Example_2 推广 AcmeGame",
    "",
  ])
    assert.equal(serverText(text), text);
});

test("a choice reads as the person's own message in Chinese", () => {
  assert.equal(displayJevUserMessage("hello", []), "hello");
  assert.equal(t.choices.selected("方案 A"), "已选：方案 A");
});

test("the chat's old tool cards and the sign-in screens carry no English sentences", () => {
  const _english = [
    "Searching the web",
    'count === 1 ? "source" : "sources"',
    "No sources found",
    "Reading the page",
    "Couldn’t read the page",
    "Take control",
    "Checking your inbox",
    "Reading the email",
    "Open email",
    "Preparing choices",
    "Retry choice",
    "Welcome to OpenMuse",
    "A little room",
    "Create the admin account",
    "Repeat password",
    "Setup code",
    "Create account",
    ">\n        Sign in\n",
  ];
});

test("the old sheets the shell still opens (email, event, file, browser, mail) carry no English", () => {
  // Reachable from 等你审阅 → 改一下再说, the chat's file card, the default desktop and 接管.
  const english = [
    "Write a reply",
    "A new message",
    'label="To"',
    'label="Cc"',
    'label="Bcc"',
    'label="Subject"',
    'label="Message"',
    "Review email",
    "Save draft",
    "Draft saved in OpenMuse",
    "You’ll review the exact recipients",
    "Event title",
    'label="Starts"',
    'label="Ends"',
    "Time zone",
    "All-day event",
    "Location or meeting link",
    "This time overlaps",
    "Review deletion",
    "Review {e ?",
    "Open / download",
    "Save or share",
    "Attach to email",
    "Fill this form",
    "Save filled copy",
    "this field type is not supported",
    "Website address",
    '"Reopen"',
    '"Reconnect"',
    '"Go"',
    "Retry connection",
    "Connecting to your browser",
    "Open browser in a window",
    "Refresh connection",
    "Import PDF downloads",
    "Close session",
    "This session is closed",
    "Preview is not available",
    "in this conversation",
    "Loading the conversation",
    "Reload conversation",
    "Recipients",
    "is required",
    "add at least one",
    "is not valid",
    " date`",
    " time`",
    "Choose a valid time zone",
    "Previous",
    "Zoom out",
    "Zoom in",
    "PDF document reader",
    "Use the reader toolbar",
    "Remote browser session console",
    "Reply saved in your local Sent mail",
  ];
  for (const file of ["legacy/details.tsx", "legacy/bits.tsx", "legacy/desktop.tsx"]) {
    const source = readFileSync(
      decodeURIComponent(new URL(`../../web/src/${file}`, import.meta.url).pathname),
      "utf8",
    );
    for (const phrase of english)
      assert.equal(source.includes(phrase), false, `${file} still says "${phrase}"`);
  }
});

test("where a file came from reads in Chinese; a mail subject stays as it is", () => {
  assert.equal(fileSourceText("Uploaded by you"), "你上传的");
  assert.equal(fileSourceText("Filled from form.pdf"), "由 form.pdf 填写生成");
  assert.equal(fileSourceText("Browser · b-12"), "浏览器下载 · b-12");
  assert.equal(
    fileSourceText("Computer (default): /workspace/a.pdf"),
    "默认桌面：/workspace/a.pdf",
  );
  assert.equal(
    fileSourceText("Computer (Oak_Example_2): /workspace/a.pdf"),
    "Oak_Example_2 的桌面：/workspace/a.pdf",
  );
  assert.equal(fileSourceText("Gmail · Field trip"), "Gmail · Field trip");
});

test("every fixed report label the server can send reads in Chinese", () => {
  for (const label of [
    ...pacingReportLabels,
    ...attentionReportLabels,
    actionReportLabel,
    ...Object.values(topicReportLabels),
  ]) {
    const shown = reportLabel(label);
    assert.notEqual(shown, label, `${label} is not mapped`);
    assert.doesNotMatch(shown, /[A-Za-z]{3}/, `${label} → ${shown}`);
  }
  assert.equal(reportLabel(planReportLabel(2)), "计划第 2 版");
  assert.equal(reportLabel(`${actionReportLabel}${overPaceSuffix}`), "动作 · 超出节奏");
  // An action report reads as its action in Chinese (a common word) and its site; any other
  // word the AI used stays as it is.
  const action = { site: "example.com", action: "comment" };
  assert.equal(reportLabel(actionReportLabel, action), "评论 · example.com");
  assert.equal(
    reportLabel(`${actionReportLabel}${overPaceSuffix}`, action),
    "评论 · example.com · 超出节奏",
  );
  for (const [word, shown] of [
    ["post", "发帖"],
    ["Comment", "评论"],
    ["reply", "回复"],
    ["delete", "删除"],
    ["like", "点赞"],
    ["upvote", "点赞"],
    ["follow", "关注"],
    ["message", "私信"],
    ["DM", "私信"],
    ["edit", "修改"],
    ["crosspost", "crosspost"],
    ["toString", "toString"],
  ])
    assert.equal(actionWord(word), shown, word);
  assert.equal(
    reportLabel(actionReportLabel, { site: "example.com", action: "crosspost" }),
    "crosspost · example.com",
  );
  assert.equal(
    reportLabel(actionReportLabel, { site: "example.com", action: "" }),
    "动作 · example.com",
  );
  // A wait is never a card (fork, report line): its labels are not report labels any more and
  // read only as the task timeline's run events, with the redirect lines.
  assert.equal(reportLabel(pacingWaitLabel(20)), pacingWaitLabel(20));
  assert.equal(serverText(pacingWaitLabel(20)), "等待 20 分钟 · 节奏");
  assert.equal(serverText(pacingWaitLabel(1)), "等待 1 分钟 · 节奏");
  assert.equal(serverText("Waiting 5 minutes"), "等待 5 分钟");
  assert.equal(serverText("Redirected"), "收到新指示");
  assert.equal(
    serverText("note\nResumes at 15:00\nRuns again now: the person sent a new instruction"),
    "note\n15:00 继续\n收到新指示，马上再跑",
  );
});

test("no owner-facing string assumes a site or a goal (Reddit, subreddit, promotion)", () => {
  const found: string[] = [];
  const pattern = /reddit|\br\/[a-z]|\bu\/[a-z]|karma|推广|AcmeGame|App Store/i;
  const walk = (value: unknown, path: string, depth: number) => {
    if (depth > 6) return;
    if (typeof value === "string") {
      if (pattern.test(value)) found.push(`${path}: ${value}`);
    } else if (typeof value === "function") {
      for (const args of [
        ["x", "y", "z", "w"],
        [2, 3, 1, 0],
      ]) {
        try {
          walk((value as (...a: unknown[]) => unknown)(...args), `${path}()`, depth + 1);
        } catch {
          // A helper that needs other arguments: its fixed parts are covered by other tests.
        }
      }
    } else if (value && typeof value === "object")
      for (const [key, item] of Object.entries(value)) walk(item, `${path}.${key}`, depth + 1);
  };
  walk(t, "t", 0);
  // A store's manager is defined by the owner as doing 选品审核、定价、推广投放, so
  // the 店铺 page names promotion as its job (the store page only, never a site or a product).
  const storeJob = (line: string) => line.startsWith("t.store.") && !/reddit|karma/i.test(line);
  // (v0.9 官网) the landing page's 适用场景 describe what customers use it for, which
  // includes promotion (the landing page's scenarios only, never a site).
  const landingScene = (line: string) =>
    line.includes(".landing.cases") && !/reddit|karma/i.test(line);
  assert.deepEqual(
    found.filter((line) => !storeJob(line) && !landingScene(line)),
    [],
  );
});

test("every refusal of the review and approval routes reads in Chinese", () => {
  // Harvested from the server's source (apps/server/src/actions.ts), ternary branches included,
  // so a new refusal there without words here fails.
  const source = readFileSync("apps/server/src/actions.ts", "utf8");
  const messages = new Set<string>();
  for (const match of source.matchAll(/new AppError\(\s*([\s\S]*?),\s*\d{3}\s*\)/g))
    for (const literal of match[1].matchAll(/"((?:[^"\\]|\\.)*)"/g))
      if (/\s/.test(literal[1])) messages.add(literal[1]); // a sentence, not a status or kind
  assert.ok(messages.size >= 8, `harvested ${messages.size}`);
  const english = [...messages].filter((message) => !/[\u3000-\u9fff]/.test(serverText(message)));
  assert.deepEqual(english, []);
  assert.equal(
    serverText("This review expired. Create a fresh proposal."),
    t.server.lines["This review expired. Create a fresh proposal."],
  );
});

test("every refusal of the credential and account routes reads in Chinese", () => {
  // Harvested from the server's source, so a new refusal there without words here fails.
  const files = [
    "credentials/validate.ts",
    "credentials/store.ts",
    "credentials/service.ts",
    "environments.ts",
  ];
  const messages = new Set<string>();
  for (const file of files) {
    const source = readFileSync(`apps/server/src/${file}`, "utf8");
    for (const match of source.matchAll(
      /new AppError\(\s*(?:"((?:[^"\\]|\\.)*)"|`([^`]*)`|'([^']*)')\s*(?:,\s*(\d+))?/g,
    )) {
      if (match[4] === "500" || match[4] === "503") continue; // a server fault, not a refusal
      // A template's parts: a ternary reads as its first choice, a limit as a number, a site,
      // name or host as a plain name.
      const text = (match[1] ?? match[2] ?? match[3] ?? "").replace(/\$\{[^}]*\}/g, (part) => {
        const choice = /\?\s*"([^"]*)"/.exec(part);
        if (choice) return choice[1];
        if (/Max|max/.test(part)) return "5";
        return /type|kind/.test(part) ? "account" : "example.com";
      });
      if (text) messages.add(text);
    }
  }
  assert.ok(messages.size > 25, `harvested ${messages.size}`);
  // The path the forms take (accountErrorText): editorError's words, then serverText's; the
  // unmapped fallback of refusalText is not counted here.
  const english = [...messages].filter(
    (message) => !/[\u3000-\u9fff]/.test(serverText(editorError(message))),
  );
  assert.deepEqual(english, []);

  assert.equal(
    serverText("cookies holds no cookie of x.com or its subdomains"),
    "贴的 Cookie 里没有 x.com 或它子域名的 Cookie。",
  );
  assert.equal(
    serverText("There is already a x.com login for this account; replace it instead"),
    "这个账号已经有 x.com 的登录了；要改请用「更换」。",
  );
  assert.equal(
    serverText("Each site can have one login per account"),
    "同一个网站在一个账号下只能有一份登录（子域名算同一个网站）。",
  );
  assert.equal(
    serverText("Invalid input: expected string, received number"),
    t.server.invalidInput,
  );
  // An English refusal nobody mapped yet still reads in Chinese; Chinese text is kept.
  assert.equal(refusalText("Something new went wrong here"), t.server.unmapped);
  assert.equal(refusalText("这个账号已经不在了。"), "这个账号已经不在了。");
  assert.equal(
    refusalText(
      "totpSeed must be the two-factor secret key, not a code from the authenticator app",
    ),
    "两步验证这里要填密钥本身，不是验证器 App 里显示的验证码。",
  );
});
