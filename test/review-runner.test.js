import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { PassThrough } from "node:stream";
import test from "node:test";
import { UserError } from "../src/core.js";
import { ClaudeReviewRunner, normalizeReviewResult, REVIEW_RESULT_SCHEMA, REVIEW_SYSTEM_PROMPT } from "../src/review-runner.js";

const context = {
  status: "fresh", headSha: "a".repeat(40), contextVersion: "b".repeat(64),
  author: { memberId: "fixture-member" }, teamMemberIds: ["fixture-member"],
  relatedIssues: [{ key: "TEST-1" }],
  perspectives: [{ memberId: "fixture-member", areas: ["입력 검증"], changedPaths: ["src/input.js"] }],
};

function review() {
  return {
    verdict: "approve",
    body: "## 리뷰 결과: 승인\n\n### 확인한 범위\n제공된 현재 SHA의 변경 코드를 확인했으며 테스트는 실행하지 않았습니다.\n\n### 작업 맥락\nTEST-1 입력 검증 요구와 `src/input.js:10`의 실패 처리를 대조했습니다.",
    memory: {
      implementation: [{ summary: "빈 입력을 명시 오류로 처리한다.", basis: "observed", evidence: [{ kind: "code", ref: "src/input.js:10" }] }],
      decisions: [{ decision: "실패를 명시 오류로 반환한다.", reason: null, basis: "observed", evidence: [{ kind: "code", ref: "src/input.js:10" }] }],
      validations: [{ check: "단위 테스트 실행", result: "not_run", basis: "unknown", evidence: [] }],
      remainingWork: [],
    },
  };
}

function holdReview() {
  const result = review();
  result.verdict = "hold";
  result.body = "## 리뷰 결과: 보류\n\n### 왜 보류인가\n잘못된 입력이 저장됩니다.\n\n### 수정이 필요한 부분\n- [높음] [정확성] `src/input.js:10`에서 빈 입력을 거부하지 않아 잘못된 레코드가 저장됩니다.\n\n### 확인한 범위\n제공된 코드만 정적으로 확인했으며 테스트는 실행하지 않았습니다.\n\n### 작업 맥락\nTEST-1의 입력 거부 조건을 대조했습니다.";
  return result;
}

test("위험·주의·미미 등급과 판정은 구분하고 이전 저장 리뷰도 재개할 수 있다", () => {
  assert.equal(normalizeReviewResult(holdReview(), { context }).verdict, "hold", "이전 높음 기록 유지");
  for (const severity of ["위험", "주의"]) {
    const result = holdReview();
    result.body = result.body.replace("[높음]", `[${severity}]`);
    assert.equal(normalizeReviewResult(result, { context }).verdict, "hold");
  }
  const minorHold = holdReview();
  minorHold.body = minorHold.body.replace("[높음]", "[미미]");
  assert.throws(() => normalizeReviewResult(minorHold, { context }), { code: "review_sections_invalid" });
  for (const severity of ["위험", "주의", "미미"]) {
    const result = review();
    result.body += `\n\n### 비차단 결함\n- [${severity}] [정확성] \`src/input.js:10\`에서 확인한 문제`;
    if (severity === "위험") {
      assert.throws(() => normalizeReviewResult(result, { context }), { code: "review_sections_invalid" });
    } else {
      assert.equal(normalizeReviewResult(result, { context }).verdict, "approve");
    }
  }
  const unknown = review();
  unknown.body = unknown.body.replace("## 리뷰 결과: 승인", "## 리뷰 결과: 승인 (미확인 1건)");
  unknown.body += "\n### 확인할 사항\n- [확인 필요] 호출 경로가 제공되지 않아 영향은 확인하지 못했습니다.";
  assert.equal(normalizeReviewResult(unknown, { context }).verdict, "approve");
  const conflicting = holdReview();
  conflicting.body = conflicting.body.replace("[높음]", "[위험] [미미]");
  assert.throws(() => normalizeReviewResult(conflicting, { context }), { code: "review_sections_invalid" });
});

function fakeRunner({ value = review(), raw, code = 0, stderr, hang = false, error, onInput } = {}) {
  const calls = [];
  const spawnImpl = (file, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = (signal) => {
      child.killed = signal;
      queueMicrotask(() => child.emit("close", null));
      return true;
    };
    const call = { file, args, options, child, input: "" };
    calls.push(call);
    assert.equal(existsSync(options.cwd), true);
    child.stdin.on("data", (chunk) => { call.input += chunk.toString(); });
    child.stdin.on("finish", () => {
      onInput?.(call);
      if (error) return child.emit("error", new Error(error));
      if (hang || child.killed) return;
      if (stderr) child.stderr.write(stderr);
      child.stdout.write(raw ?? JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: value }));
      child.emit("close", code);
    });
    return child;
  };
  return { calls, spawnImpl };
}

test("비대화 CLI는 stdin 자료와 비공개 임시 cwd만 받고 도구·MCP·일반 설정을 차단한다", async () => {
  const fake = fakeRunner();
  const input = { context, changes: [{ path: "src/input.js", source: "throw new Error('empty');" }] };
  const runner = new ClaudeReviewRunner({ spawnImpl: fake.spawnImpl,
    env: { PATH: "fixture-path", USERPROFILE: "fixture-home", CLAUDE_CONFIG_DIR: "fixture-auth",
      CLAUDE_CODE_OAUTH_TOKEN: "fixture-cli-auth", HTTPS_PROXY: "https://proxy.example.test",
      REVIEWBOT_JIRA_API_TOKEN: "fixture-jira-secret", GITLAB_TOKEN: "fixture-gitlab-secret",
      MATTERMOST_MCP_DATA_DIR: "fixture-private-data", NODE_OPTIONS: "--import malicious.js" } });
  assert.deepEqual(await runner.review(input), review());
  assert.equal(fake.calls.length, 1);
  const call = fake.calls[0];
  assert.equal(call.file, "claude");
  assert.equal(call.input, JSON.stringify(input));
  assert.equal(call.options.shell, false);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.args.includes(JSON.stringify(input)), false);
  for (const flag of ["--safe-mode", "--restricted", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", "--no-chrome"]) {
    assert.ok(call.args.includes(flag), flag);
  }
  for (const [flag, expected] of [["--tools", ""], ["--disallowedTools", "mcp__*"], ["--setting-sources", ""], ["--permission-prompts", "none"],
    ["--mcp-config", '{"mcpServers":{}}'], ["--settings", '{"disableAllHooks":true}'], ["--output-format", "json"]]) {
    assert.equal(call.args[call.args.indexOf(flag) + 1], expected);
  }
  assert.deepEqual(JSON.parse(call.args[call.args.indexOf("--json-schema") + 1]), REVIEW_RESULT_SCHEMA);
  assert.deepEqual(call.options.env, { PATH: "fixture-path", USERPROFILE: "fixture-home", CLAUDE_CONFIG_DIR: "fixture-auth",
    CLAUDE_CODE_OAUTH_TOKEN: "fixture-cli-auth", HTTPS_PROXY: "https://proxy.example.test" });
  assert.equal(existsSync(call.options.cwd), false, "Fresh temporary directory is cleaned after completion.");
  assert.match(call.args[call.args.indexOf("--system-prompt") + 1], /테스트를 실행하지 않습니다/);
});

test("Claude의 모델은 명시했을 때만 전달하고 잘못된 모델 인수를 거부한다", async () => {
  const fake = fakeRunner();
  await new ClaudeReviewRunner({ model: "fixture-model", spawnImpl: fake.spawnImpl }).review({ context });
  assert.equal(fake.calls[0].args[fake.calls[0].args.indexOf("--model") + 1], "fixture-model");
  for (const model of ["", "fixture model", "--flag", "x".repeat(129), false]) {
    assert.throws(() => new ClaudeReviewRunner({ model }), UserError);
  }
  const defaultFake = fakeRunner();
  await new ClaudeReviewRunner({ spawnImpl: defaultFake.spawnImpl }).review({ context });
  assert.equal(defaultFake.calls[0].args.includes("--model"), false);
});

test("본문은 기존 판정 조건과 실제 팀 맥락 인용을 지키며 보류는 코드 근거를 요구한다", () => {
  const hold = holdReview();
  assert.deepEqual(normalizeReviewResult(hold, { context }), hold);
  for (const mutate of [
    (value) => { value.body = value.body.replace("[정확성]", "[취향]"); },
    (value) => { value.body = value.body.replace("`src/input.js:10`", "위치 미확인"); },
    (value) => { value.body = value.body.replace("TEST-1의 입력 거부 조건", "관계없는 조건"); },
    (value) => { value.body = value.body.replace("### 작업 맥락", "### 기타"); },
    (value) => { value.body = value.body.replace("[높음]", "[확인 필요]"); },
  ]) {
    const invalid = structuredClone(hold);
    mutate(invalid);
    assert.throws(() => normalizeReviewResult(invalid, { context }), UserError);
  }
  const invalid = review();
  invalid.body += "\n- [높음] [정확성] `src/input.js:10`에서 확인된 문제";
  assert.throws(() => normalizeReviewResult(invalid), UserError);
});

test("실행하지 않은 테스트 성공·추측한 결정 이유·비밀값이나 전체 멘션을 거부한다", () => {
  assert.ok(REVIEW_SYSTEM_PROMPT.includes(REVIEW_RESULT_SCHEMA.properties.memory.properties.validations.description));
  assert.match(REVIEW_RESULT_SCHEMA.properties.memory.properties.validations.description, /정적 코드 대조.*implementation.*remainingWork.*passed\/failed.*observed.*금지/);
  for (const mutate of [
    (value) => { value.memory.validations = [{ check: "테스트 성공", result: "passed", basis: "observed", evidence: [{ kind: "test", ref: "fixture-test" }] }]; },
    (value) => { value.memory.decisions[0].reason = "추측한 이유"; },
    (value) => { value.body += "\n토큰 glpat-fixture-secret-1234567890"; },
    (value) => { value.body += "\n@channel"; },
    (value) => { value.body += "\n/approve"; },
    (value) => { value.body += "\n /merge when_pipeline_succeeds"; },
    (value) => { value.body += "\n-----BEGIN RSA PRIVATE KEY-----"; },
    (value) => { value.body += "\u001b[31m"; },
    (value) => { value.extra = "unexpected"; },
  ]) {
    const invalid = review();
    mutate(invalid);
    assert.throws(() => normalizeReviewResult(invalid), (error) => error instanceof UserError && !error.message.includes("fixture-secret"));
  }
  const reported = review();
  reported.memory.validations = [{ check: "작성자 보고 CI", result: "passed", basis: "reported", evidence: [{ kind: "mr_comment", ref: "https://gitlab.example.test/project/-/merge_requests/1#note_1" }] }];
  assert.deepEqual(normalizeReviewResult(reported), reported);
});

test("명세 근거는 현재 리뷰에 전달된 파일·시트·셀만 인용한다", () => {
  const specification = { source: { name: "requirements.xlsx" },
    sheets: [{ name: "Contract", rows: [{ row: 20, cells: [{ address: "D20", value: "Reject empty input." }] }] }] };
  const result = review();
  result.memory.implementation[0].evidence.push({ kind: "specification", ref: "requirements.xlsx#Contract!D20" });
  assert.deepEqual(normalizeReviewResult(result, { context: { ...context, projectSpecification: specification } }), result);
  assert.throws(() => normalizeReviewResult(result, { context }), { code: "review_memory_invalid" });
  result.memory.implementation[0].evidence[1].ref = "requirements.xlsx#Contract!D21";
  assert.throws(() => normalizeReviewResult(result, { context: { ...context, projectSpecification: specification } }), UserError);
  const hold = holdReview();
  const changes = { files: [{ oldPath: "src/input.js", newPath: "src/input.js", baseContent: "\n".repeat(10), headContent: "\n".repeat(10) }] };
  hold.body = hold.body.replace("[정확성]", "[정확성] `requirements.xlsx#Contract!D20`과 달리");
  const prepared = { ...context, projectSpecification: specification };
  assert.deepEqual(normalizeReviewResult(hold, { context: prepared, changes }), hold);
  hold.body = hold.body.replace("`src/input.js:10`", "해당 화면");
  assert.throws(() => normalizeReviewResult(hold, { context: prepared, changes }), UserError, "명세만으로는 실제 코드 위치를 대신할 수 없다.");
});

test("리뷰 거부 이유는 구조·본문·섹션·맥락·위치·메모리·실행 주장별로 구분한다", () => {
  const changes = { files: [{ oldPath: "src/input.js", newPath: "src/input.js", baseContent: "\n".repeat(10), headContent: "\n".repeat(10) }] };
  const cases = [
    [review(), (value) => { value.extra = "fixture-private-token"; }, "review_result_invalid"],
    [review(), (value) => { value.body += "\n/merge fixture-private-token"; }, "review_body_invalid"],
    [review(), (value) => { value.body = value.body.replace("### 확인한 범위", "### 기타"); }, "review_sections_invalid"],
    [review(), (value) => { value.body = value.body.replace("TEST-1 입력 검증 요구와 `src/input.js:10`", "fixture-private-token"); }, "review_context_invalid"],
    [holdReview(), (value) => { value.body = value.body.replace("src/input.js:10", "src/missing.js:10"); }, "review_locations_invalid"],
    [review(), (value) => { value.memory.implementation[0].evidence = []; }, "review_memory_invalid"],
    ...["passed", "failed"].map((result) => [review(), (value) => {
      value.memory.validations = [{ check: "fixture-private-token", result, basis: "observed", evidence: [{ kind: "test", ref: "fixture" }] }];
    }, "review_test_claim_invalid"]),
  ];
  for (const [value, mutate, code] of cases) {
    mutate(value);
    assert.throws(() => normalizeReviewResult(value, { context, changes }), (error) => error instanceof UserError
      && error.code === code && error.message === "The review runner returned an invalid review. No review was published.");
  }
});

test("확인된 보류 지적은 실제 수집 파일과 해당 base/head 코드의 줄 범위 안을 인용한다", () => {
  const hold = holdReview();
  const tenLines = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
  const changes = { files: [{ oldPath: "src/input.js", newPath: "src/input.js", baseContent: tenLines, headContent: "one line\n" }] };
  assert.deepEqual(normalizeReviewResult(hold, { context, changes }), hold);
  for (const replacement of ["src/missing.js:10", "src/input.js:11", "src/input.js:0", "src/input.js:99999999999999999999"]) {
    const invalid = structuredClone(hold);
    invalid.body = invalid.body.replace("src/input.js:10", replacement);
    assert.throws(() => normalizeReviewResult(invalid, { context, changes }), { code: "review_locations_invalid" });
  }
  const extra = structuredClone(hold);
  extra.body = extra.body.replace("### 확인한 범위", "- [데이터] 코드 위치 없이 추가한 확인된 지적\n\n### 확인한 범위");
  assert.throws(() => normalizeReviewResult(extra, { context, changes }), UserError);
  const renamed = { files: [{ oldPath: "src/old.js", newPath: "src/input.js", baseContent: tenLines, headContent: "one line\n" }] };
  assert.throws(() => normalizeReviewResult(hold, { context, changes: renamed }), UserError);
  const old = structuredClone(hold);
  old.body = old.body.replace("src/input.js:10", "src/old.js:10");
  assert.deepEqual(normalizeReviewResult(old, { context, changes: renamed }), old);
});

test("지적 설명의 점 표기 식은 파일 인용으로 오인하지 않고 실제 파일 근거는 유지한다", () => {
  const changes = { files: [{ oldPath: "src/input.js", newPath: "src/input.js", baseContent: null,
    headContent: Array(10).fill("const value = input.value;").join("\n") }] };
  const value = holdReview();
  value.body = value.body.replace("빈 입력을 거부하지 않아", "`input.value`와 `evidence.length`의 빈 입력을 거부하지 않아");
  assert.deepEqual(normalizeReviewResult(value, { context, changes }), value);
  for (const replacement of ["`input.value`", "`missing.js:10`", "`src/missing.js`", "`src/input.js:11`", "`src/input.js:0`"]) {
    const invalid = structuredClone(value);
    invalid.body = invalid.body.replace("`src/input.js:10`", replacement);
    assert.throws(() => normalizeReviewResult(invalid, { context, changes }), { code: "review_locations_invalid" });
  }
  const additionalUnknown = structuredClone(value);
  additionalUnknown.body = additionalUnknown.body.replace("빈 입력을", "`src/missing.js`의 빈 입력을");
  assert.throws(() => normalizeReviewResult(additionalUnknown, { context, changes }), { code: "review_locations_invalid" });
});

test("텍스트와 이미지가 함께 바뀐 승인은 물론 보류에도 이미지 미검토 범위를 한 번만 공개한다", async () => {
  const changes = {
    files: [{ oldPath: "src/input.js", newPath: "src/input.js", baseContent: "\n".repeat(10), headContent: "\n".repeat(10) }],
    excludedImages: [{ oldPath: "assets/old[logo].png", newPath: "assets/logo(2).png" }],
  };
  const note = "이미지 1개는 시각적으로 확인하지 않았으며, 이미지 내용·모양은 검토 범위에서 제외했습니다.";
  for (const value of [review(), holdReview()]) {
    const normalized = normalizeReviewResult(value, { context, changes });
    assert.ok(normalized.body.includes(`### 확인한 범위\n${note}\n\n`));
    assert.equal(normalized.body.split(note).length - 1, 1);
    assert.deepEqual(normalizeReviewResult(normalized, { context, changes }), normalized);
    assert.deepEqual(normalizeReviewResult(normalized, { context }), normalized);
    assert.deepEqual(normalized.memory, value.memory);
  }
  const fake = fakeRunner();
  const actual = await new ClaudeReviewRunner({ spawnImpl: fake.spawnImpl }).review({ context, changes });
  assert.ok(actual.body.includes(note));
  assert.match(REVIEW_SYSTEM_PROMPT, /excludedImages.*시각적 내용은 확인하지 않았습니다/);
  assert.match(REVIEW_SYSTEM_PROMPT, /SVG.*렌더링된 외관은 확인하지 않았습니다/);
  assert.deepEqual(normalizeReviewResult(review(), { context, changes: { ...changes, excludedImages: [] } }), review());
});

test("제외된 이미지 경로나 가상 줄은 보류 근거와 읽은 코드 메모리로 사용할 수 없다", () => {
  const changes = {
    files: [{ oldPath: "src/input.js", newPath: "src/input.js", baseContent: "\n".repeat(10), headContent: "\n".repeat(10) }],
    excludedImages: [{ oldPath: "assets/old[logo].png", newPath: "assets/logo(2).png" }],
  };
  for (const path of ["assets/old[logo].png", "assets/logo(2).png"]) {
    const hold = holdReview();
    hold.body = hold.body.replace("src/input.js:10", `${path}:1`);
    assert.throws(() => normalizeReviewResult(hold, { context, changes }), { code: "review_locations_invalid" });
    for (const ref of [path, `${path}:1`, `${path}:1 @ ${context.headSha}`, `${path} @ ${context.headSha}`]) {
      for (const key of ["implementation", "decisions", "validations", "remainingWork"]) {
        const value = review();
        if (key === "remainingWork") value.memory.remainingWork = [{ summary: "이미지 확인 필요", basis: "unknown", evidence: [] }];
        value.memory[key][0].evidence = [{ kind: "code", ref }];
        assert.throws(() => normalizeReviewResult(value, { context, changes }), { code: "review_memory_invalid" });
      }
    }
  }
  const reported = review();
  reported.memory.implementation.push({ summary: "작성자가 이미지 교체를 보고했다.", basis: "reported",
    evidence: [{ kind: "mr_description", ref: "https://gitlab.example.test/project/-/merge_requests/1" }] });
  assert.deepEqual(normalizeReviewResult(reported, { context, changes }).memory, reported.memory);
});

test("이미지 미검토 고지를 추가한 최종 본문도 최대 길이를 넘길 수 없다", () => {
  const value = review();
  const maximum = REVIEW_RESULT_SCHEMA.properties.body.maxLength;
  const note = "이미지 1개는 시각적으로 확인하지 않았으며, 이미지 내용·모양은 검토 범위에서 제외했습니다.";
  const changes = { files: [], excludedImages: [{ oldPath: "assets/logo.png", newPath: "assets/logo.png" }] };
  value.body += "x".repeat(maximum - value.body.length);
  assert.equal(normalizeReviewResult(value).body.length, maximum);
  assert.throws(() => normalizeReviewResult(value, { context, changes }), { code: "review_body_invalid" });
  value.body = value.body.slice(0, maximum - note.length - 2);
  const normalized = normalizeReviewResult(value, { context, changes });
  assert.equal(normalized.body.length, maximum);
  assert.deepEqual(normalizeReviewResult(normalized, { context, changes }), normalized);
});

test("오류 출력·미완료 결과·JSON 파싱 오류의 원문을 외부로 노출하지 않는다", async () => {
  for (const options of [
    { error: "fixture-private-token", expectedCode: "runner_start_failed" },
    { code: 1, stderr: "fixture-private-token", expectedCode: "runner_exit_failed" },
    { hang: true, onInput: (call) => call.child.stdout.emit("error", new Error("fixture-private-token")), expectedCode: "runner_output_failed" },
    { hang: true, onInput: (call) => call.child.stderr.emit("error", new Error("fixture-private-token")), expectedCode: "runner_output_failed" },
    { raw: "fixture-private-token" },
    { raw: JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "fixture-private-token" }) },
    { raw: JSON.stringify({ type: "result", subtype: "success", structured_output: { ...review(), body: "fixture-private-token" } }), expectedCode: "review_sections_invalid" },
    { raw: JSON.stringify({ type: "result", subtype: "success", result: JSON.stringify(review()) }) },
  ]) {
    const fake = fakeRunner(options);
    await assert.rejects(new ClaudeReviewRunner({ spawnImpl: fake.spawnImpl }).review({ context }),
      (error) => error instanceof UserError && error.code === (options.expectedCode ?? "runner_response_invalid")
        && !error.message.includes("fixture-private-token"));
    assert.equal(fake.calls.length, 1, "No fallback invocation is allowed.");
    assert.equal(existsSync(fake.calls[0].options.cwd), false);
  }
});

test("입력 크기를 실행 전에 확인하고 stdout·stderr 한도 초과와 timeout은 프로세스를 종료한다", async () => {
  const unused = fakeRunner();
  await assert.rejects(new ClaudeReviewRunner({ spawnImpl: unused.spawnImpl, maxInputBytes: 10 }).review({ source: "too much input" }), /input exceeds/);
  assert.equal(unused.calls.length, 0);
  for (const options of [{ raw: "x".repeat(101) }, { stderr: "x".repeat(101) }, { hang: true }]) {
    const fake = fakeRunner(options);
    const runner = new ClaudeReviewRunner({ spawnImpl: fake.spawnImpl, maxOutputBytes: 100, timeoutMs: 20 });
    await assert.rejects(runner.review({}), /limit|timed out/);
    assert.equal(fake.calls[0].child.killed, "SIGKILL");
    assert.equal(existsSync(fake.calls[0].options.cwd), false);
  }
});

test("취소는 실행 전과 실행 중 모두 처리하고 실행 중 프로세스는 종료한다", async () => {
  const before = new AbortController();
  before.abort();
  const unused = fakeRunner();
  await assert.rejects(new ClaudeReviewRunner({ spawnImpl: unused.spawnImpl }).review({}, { signal: before.signal }), /cancelled/);
  assert.equal(unused.calls.length, 0);
  const during = new AbortController();
  const fake = fakeRunner({ hang: true, onInput: () => during.abort() });
  await assert.rejects(new ClaudeReviewRunner({ spawnImpl: fake.spawnImpl }).review({}, { signal: during.signal }), /cancelled/);
  assert.equal(fake.calls[0].child.killed, "SIGKILL");
  assert.equal(existsSync(fake.calls[0].options.cwd), false);
});
