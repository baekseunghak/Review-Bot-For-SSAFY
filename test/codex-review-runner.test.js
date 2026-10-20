import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { CodexReviewRunner } from "../src/codex-review-runner.js";
import { UserError } from "../src/core.js";
import { REVIEW_RESULT_SCHEMA, REVIEW_SYSTEM_PROMPT } from "../src/review-runner.js";

const context = {
  status: "fresh", headSha: "a".repeat(40), contextVersion: "b".repeat(64),
  author: { memberId: "fixture-member" }, teamMemberIds: ["fixture-member"],
  relatedIssues: [{ key: "TEST-1" }],
  perspectives: [{ memberId: "fixture-member", areas: ["입력 검증"], changedPaths: ["src/input.js"] }],
};

function review() {
  return {
    verdict: "approve",
    body: "## 리뷰 결과: 승인\n\n### 확인한 범위\n제공된 현재 SHA 코드만 확인했으며 테스트는 실행하지 않았습니다.\n\n### 작업 맥락\nTEST-1과 `src/input.js:10`의 입력 처리를 대조했습니다.",
    memory: {
      implementation: [{ summary: "빈 입력을 명시 오류로 처리한다.", basis: "observed", evidence: [{ kind: "code", ref: "src/input.js:10" }] }],
      decisions: [], validations: [{ check: "단위 테스트 실행", result: "not_run", basis: "unknown", evidence: [] }], remainingWork: [],
    },
  };
}

const message = (value = review()) => ({ type: "item.completed", item: { id: "fixture-final", type: "agent_message", text: JSON.stringify(value) } });
const completed = { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } };
const disabledCodeModeNotice = { type: "item.completed", item: { id: "startup-code-mode", type: "error",
  message: "Code Mode is unavailable because code-mode host is disabled. Falling back to direct tools; enable `features.code_mode_host` and install `codex-code-mode-host`." } };

function fakeRunner({ events = [message(), completed], raw, code = 0, stderr, hang = false, error, onInput } = {}) {
  const calls = [];
  const spawnImpl = (file, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (signal) => { child.killed = signal; queueMicrotask(() => child.emit("close", null)); return true; };
    const call = { file, args, options, child, input: "" };
    calls.push(call);
    const schemaFile = args[args.indexOf("--output-schema") + 1];
    assert.equal(dirname(schemaFile), options.cwd);
    assert.deepEqual(JSON.parse(readFileSync(schemaFile, "utf8")), REVIEW_RESULT_SCHEMA);
    child.stdin.on("data", (chunk) => { call.input += chunk.toString(); });
    child.stdin.on("finish", () => {
      onInput?.(call);
      if (error) return child.emit("error", new Error(error));
      if (hang || child.killed) return;
      if (stderr) child.stderr.write(stderr);
      child.stdout.write(raw ?? events.map((event) => JSON.stringify(event)).join("\n") + "\n");
      child.emit("close", code);
    });
    return child;
  };
  return { calls, spawnImpl };
}

test("Codex는 기존 로그인만 전달하고 순수 JSON stdin·읽기 전용 임시 작업 공간·도구 차단을 사용한다", async () => {
  const fake = fakeRunner({ events: [
    { type: "thread.started", thread_id: "fixture-thread" }, disabledCodeModeNotice, { type: "turn.started" },
    { type: "item.started", item: { id: "fixture-reason", type: "reasoning", text: "" } },
    { type: "item.updated", item: { id: "fixture-reason", type: "reasoning", text: "fixture" } },
    { type: "item.completed", item: { id: "fixture-reason", type: "reasoning", text: "fixture" } },
    { type: "item.completed", item: { id: "fixture-progress", type: "agent_message", text: "제공된 변경 내용을 확인합니다." } },
    message(), completed,
  ] });
  const input = { context, changes: { files: [] } };
  const runner = new CodexReviewRunner({ spawnImpl: fake.spawnImpl, env: {
    PATH: "fixture-path", CODEX_HOME: "fixture-auth", USERPROFILE: "fixture-home", HTTPS_PROXY: "https://proxy.example.test",
    OPENAI_API_KEY: "fixture-api-key", CODEX_API_KEY: "fixture-codex-key", CLAUDE_CODE_OAUTH_TOKEN: "fixture-claude-key",
    REVIEWBOT_JIRA_API_TOKEN: "fixture-jira-key", GITLAB_TOKEN: "fixture-gitlab-key", MATTERMOST_MCP_DATA_DIR: "fixture-private-data",
    NODE_OPTIONS: "--import malicious.js", CODEX_CONFIG: "fixture-config",
  } });
  assert.deepEqual(await runner.review(input), review());
  assert.equal(fake.calls.length, 1);
  const call = fake.calls[0];
  assert.equal(call.file, "codex");
  assert.equal(call.args[0], "exec");
  assert.equal(call.args.at(-1), "-");
  assert.equal(call.input, JSON.stringify(input));
  assert.equal(call.options.shell, false);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.args.includes(call.input), false);
  assert.equal(call.args.includes("--model"), false, "Model selection keeps the CLI default unless explicitly configured.");
  for (const flag of ["--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check", "--json"]) assert.ok(call.args.includes(flag), flag);
  assert.equal(call.args[call.args.indexOf("--sandbox") + 1], "read-only");
  for (const feature of ["shell_tool", "apps", "hooks", "plugins", "multi_agent", "browser_use", "computer_use", "image_generation", "workspace_dependencies", "view_image", "code_mode", "code_mode_host",
    "skill_search", "remote_plugin", "shell_snapshot", "sleep_tool"]) {
    assert.ok(call.args.includes(`features.${feature}=false`), feature);
  }
  for (const value of ['approval_policy="never"', "project_doc_max_bytes=0", 'web_search="disabled"',
    "suppress_unstable_features_warning=true",
    "skills.include_instructions=false", "skills.bundled.enabled=false", "features.skip_host_skill_discovery=true",
    `developer_instructions=${JSON.stringify(REVIEW_SYSTEM_PROMPT)}`]) assert.ok(call.args.includes(value), value);
  assert.equal(call.args.includes("code_mode.enabled=false"), false);
  assert.equal(call.args.includes("code_mode_host.enabled=false"), false);
  assert.deepEqual(call.options.env, { PATH: "fixture-path", CODEX_HOME: "fixture-auth", USERPROFILE: "fixture-home", HTTPS_PROXY: "https://proxy.example.test" });
  assert.equal(existsSync(call.options.cwd), false);
});

test("명시한 CLI 경로와 모델은 쉘 해석 없이 개별 인수로 전달한다", async () => {
  const fake = fakeRunner();
  await new CodexReviewRunner({ command: "C:/fixture path/codex.exe", model: "fixture-model", spawnImpl: fake.spawnImpl }).review({ context });
  assert.equal(fake.calls[0].file, "C:/fixture path/codex.exe");
  assert.equal(fake.calls[0].args[fake.calls[0].args.indexOf("--model") + 1], "fixture-model");
  for (const value of ["", " ", "x".repeat(129), "fixture\nmodel", "fixture model", "--flag", false, 1]) {
    assert.throws(() => new CodexReviewRunner({ model: value }), UserError);
  }
});

test("도구 실행 이벤트와 미완료·실패·잘못된 JSONL은 결과가 있어도 게시하지 않는다", async () => {
  const disallowed = ["command_execution", "mcp_tool_call", "file_change", "web_search", "collab_tool_call", "node_repl", "unknown_tool"];
  const cases = [
    ...disallowed.map((type) => ({ events: [{ type: "item.completed", item: { id: "tool", type, output: "fixture-private-token" } }, message(), completed] })),
    { events: [{ type: "item.completed", item: { id: "warning", type: "error", message: "fixture-private-token" } }, message(), completed] },
    { events: [{ type: "turn.started" }, disabledCodeModeNotice, message(), completed] },
    { events: [disabledCodeModeNotice, disabledCodeModeNotice, message(), completed] },
    { events: [message(), disabledCodeModeNotice, completed] },
    { events: [{ ...disabledCodeModeNotice, item: { ...disabledCodeModeNotice.item, message: disabledCodeModeNotice.item.message + " More." } }, message(), completed] },
    { events: [{ type: "error", message: disabledCodeModeNotice.item.message }, message(), completed] },
    { events: [message()] }, { events: [completed, message()] }, { events: [message(), completed, message()] },
    { events: [{ type: "turn.failed", error: { message: "fixture-private-token" } }] },
    { events: [{ type: "error", message: "fixture-private-token" }] },
    { events: [message(), { type: "turn.started" }, { type: "turn.started" }, completed] },
    { events: [{ type: "item.completed", item: { type: "agent_message", text: "fixture-private-token" } }, completed] },
    { events: [{ type: "item.completed", item: { type: "agent_message", text: "" } }, completed] },
    { events: [{ type: "result", structured_output: review() }] },
    { raw: "fixture-private-token" }, { raw: '{"type":"turn.completed"' },
    { error: "fixture-private-token" }, { code: 1, stderr: "fixture-private-token" },
    { hang: true, onInput: (call) => call.child.stdout.emit("error", new Error("fixture-private-token")) },
    { hang: true, onInput: (call) => call.child.stderr.emit("error", new Error("fixture-private-token")) },
  ];
  for (const options of cases) {
    const fake = fakeRunner(options);
    await assert.rejects(new CodexReviewRunner({ spawnImpl: fake.spawnImpl }).review({ context }),
      (error) => error instanceof UserError && !error.message.includes("fixture-private-token"));
    assert.equal(fake.calls.length, 1, "No fallback execution or provider switch is allowed.");
    assert.equal(existsSync(fake.calls[0].options.cwd), false);
  }
});

test("Codex 결과도 동일한 맥락·공개 본문·검증 사실 검사를 통과해야 한다", async () => {
  for (const mutate of [
    (value) => { value.body = value.body.replace("TEST-1과 `src/input.js:10`", "다른 작업"); },
    (value) => { value.body += "\n/merge"; },
    (value) => { value.memory.validations = [{ check: "테스트 실행", result: "passed", basis: "observed", evidence: [{ kind: "test", ref: "fixture" }] }]; },
  ]) {
    const value = review(); mutate(value);
    const fake = fakeRunner({ events: [message(value), completed] });
    await assert.rejects(new CodexReviewRunner({ spawnImpl: fake.spawnImpl }).review({ context }), /invalid review/);
  }
});

test("입력 크기·stdout·stderr·시간 제한과 취소를 적용하며 임시 스키마를 삭제한다", async () => {
  const unused = fakeRunner();
  await assert.rejects(new CodexReviewRunner({ spawnImpl: unused.spawnImpl, maxInputBytes: 10 }).review({ value: "too much input" }), /input exceeds/);
  assert.equal(unused.calls.length, 0);
  const before = new AbortController(); before.abort();
  await assert.rejects(new CodexReviewRunner({ spawnImpl: unused.spawnImpl }).review({}, { signal: before.signal }), /cancelled/);
  assert.equal(unused.calls.length, 0);
  for (const options of [{ raw: "x".repeat(101) }, { stderr: "x".repeat(101) }, { hang: true }]) {
    const fake = fakeRunner(options);
    await assert.rejects(new CodexReviewRunner({ spawnImpl: fake.spawnImpl, maxOutputBytes: 100, timeoutMs: 20 }).review({}), /limit|timed out/);
    assert.equal(fake.calls[0].child.killed, "SIGKILL");
    assert.equal(existsSync(fake.calls[0].options.cwd), false);
  }
  const during = new AbortController();
  const fake = fakeRunner({ hang: true, onInput: () => during.abort() });
  await assert.rejects(new CodexReviewRunner({ spawnImpl: fake.spawnImpl }).review({}, { signal: during.signal }), /cancelled/);
  assert.equal(fake.calls[0].child.killed, "SIGKILL");
  assert.equal(existsSync(fake.calls[0].options.cwd), false);
});
