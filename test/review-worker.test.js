import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { ReviewInbox } from "../src/review-inbox.js";
import { GitlabReviewClient } from "../src/review-gitlab.js";
import { MattermostReviewNotifier } from "../src/review-notifier.js";
import { ReviewWorker } from "../src/review-worker.js";
import { TeamContextService } from "../src/team-context.js";
import { TeamContextStore } from "../src/team-context-store.js";

const HEAD = "a".repeat(40);
const NEXT = "d".repeat(40);
const BASE = "b".repeat(40);
const HOST = "gitlab.example.test";
const MR_URL = `https://${HOST}/fixture/repository/-/merge_requests/7`;
const INITIAL_TIME = "2026-10-20T09:00:00.000Z";
const SOURCE = "export function api() { return 'head-implementation-marker'; }\n";
const OLD_SOURCE = "export function api() { return 'old'; }\n";

function result() {
  return {
    verdict: "approve",
    body: "## 리뷰 결과: 승인\n\n### 확인한 범위\n제공된 현재 SHA의 diff와 변경 전후 파일을 정적으로 확인했습니다. 테스트는 실행하지 않았습니다.\n\n### 작업 맥락\nTEAM-7의 응답 계약과 `src/api.js:1`의 반환값을 대조했습니다.",
    memory: {
      implementation: [{ summary: "API 함수에서 새 반환값을 사용한다.", basis: "observed", evidence: [{ kind: "code", ref: `src/api.js:1 @ ${HEAD}` }] }],
      decisions: [{ decision: "API 반환값을 갱신한다.", reason: "기존 응답 계약을 유지하기 위해서다.", basis: "reported",
        evidence: [{ kind: "mr_description", ref: MR_URL }] }],
      validations: [{ check: "단위 테스트 실행", result: "not_run", basis: "unknown", evidence: [] }],
      remainingWork: [{ summary: "실제 외부 계정 연동 검증이 남아 있다.", basis: "unknown", evidence: [] }],
    },
  };
}

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

function fixture(t) {
  const root = realpathSync(tmpdir());
  const dataDir = mkdtempSync(join(root, "review-worker-test-"));
  const hooks = {};
  const events = [];
  const calls = { glab: [], reviews: [], notifications: [], preparations: [], jira: [] };
  const notes = [];
  let time = Date.parse(INITIAL_TIME);
  let metadata = { project_id: 12, iid: 7, web_url: MR_URL, state: "opened", draft: false,
    author: { id: 8, username: "dev.one" }, sha: HEAD,
    diff_refs: { head_sha: HEAD, base_sha: BASE, start_sha: "c".repeat(40) },
    title: "TEAM-7 API response", description: "기존 응답 계약을 유지하기 위해 반환값을 갱신한다.",
    source_branch: "feat/api", changes_count: "1" };
  const now = () => new Date(time);
  const runImpl = async (file, args, options) => {
    assert.equal(file, "glab");
    assert.equal(options.shell, false);
    assert.equal(args[args.indexOf("--hostname") + 1], HOST);
    const endpoint = args[1];
    const method = args[args.indexOf("--method") + 1];
    calls.glab.push({ endpoint, method });
    await hooks.glab?.({ endpoint, method });
    if (endpoint === "user") return JSON.stringify({ id: 90, username: "review.account" });
    if (endpoint === "projects/12/merge_requests/7") return JSON.stringify(metadata);
    if (endpoint.includes("/notes?") && method === "GET") return JSON.stringify(notes);
    if (endpoint.endsWith("/notes") && method === "POST") {
      const note = { id: 100 + notes.length, author: { id: 90, username: "review.account" }, system: false,
        body: JSON.parse(options.input).body };
      notes.push(note);
      events.push("comment");
      await hooks.afterPost?.(note);
      return JSON.stringify(note);
    }
    if (endpoint.includes("/diffs?")) return JSON.stringify([{ old_path: "src/api.js", new_path: "src/api.js",
      diff: "@@ -1 +1 @@\n-export function api() { return 'old'; }\n+export function api() { return 'head-implementation-marker'; }\n",
      new_file: false, deleted_file: false, renamed_file: false, a_mode: "100644", b_mode: "100644" }]);
    if (endpoint.includes("/repository/files/")) {
      const ref = new URL(`https://unused/${endpoint}`).searchParams.get("ref");
      const content = Buffer.from(ref === BASE ? OLD_SOURCE : SOURCE);
      return JSON.stringify({ file_path: "src/api.js", content: content.toString("base64"), encoding: "base64",
        content_sha256: createHash("sha256").update(content).digest("hex") });
    }
    assert.fail(`Unexpected fake GitLab route ${endpoint}`);
  };
  const gitlab = new GitlabReviewClient({ host: HOST, allowedProjectIds: [12], runImpl });
  const jiraIssue = () => ({ key: "TEAM-7", summary: "API 응답 계약", description: "응답 형식을 유지한다.",
    status: { id: "2", name: "In progress", category: "indeterminate" }, assigneeAccountId: "fixture:8",
    updatedAt: now().toISOString(), createdAt: "2026-10-10T00:00:00.000Z", url: "https://jira.example.test/browse/TEAM-7",
    components: ["API"], inCurrentSprint: true, history: [], historyComplete: true, descriptionTruncated: false });
  const jira = {
    configured: true,
    acceptsIssueKey: (key) => /^TEAM-[1-9]\d{0,14}$/.test(key),
    async getMemberIssues(accountId) {
      calls.jira.push({ type: "member", accountId });
      return { issues: [jiraIssue()], complete: true, fetchedAt: now().toISOString() };
    },
    async getIssue(key) { calls.jira.push({ type: "issue", key }); assert.equal(key, "TEAM-7"); return jiraIssue(); },
  };
  let inbox;
  let contextService;
  const extraInboxes = [];
  const workers = [];
  const open = () => {
    inbox = new ReviewInbox({ dataDir, username: "reviewer", userId: 99, botUserId: 90, projectIds: [12] });
    contextService = new TeamContextService({ store: new TeamContextStore({ dataDir }), jiraClient: jira, now,
      readHead: async () => (await gitlab.readHead({ projectId: 12, mrIid: 7 })).headSha });
  };
  open();
  contextService.upsertMember({ id: "dev-one", displayName: "가상 팀원", gitlabUsername: "dev.one", gitlabUserId: 8,
    jiraAccountId: "fixture:8", areas: ["API 응답"], paths: ["src"], reviewFocus: ["응답 계약"] });
  const runner = {
    async review(input, options) {
      calls.reviews.push(input);
      events.push("review");
      assert.equal(input.changes.files[0].headContent, SOURCE);
      assert.equal(input.changes.files[0].baseContent, OLD_SOURCE);
      assert.equal(input.context.status, "fresh");
      assert.equal(input.context.author.memberId, "dev-one");
      await hooks.review?.(input, options);
      return result();
    },
  };
  const notifier = {
    prepare(input) {
      calls.preparations.push(input);
      hooks.prepare?.(input, calls.preparations.length);
      return { fixtureNotification: true, ...input };
    },
    async send(payload) {
      calls.notifications.push(payload);
      events.push("notification");
      await hooks.send?.(payload);
      return { ok: true };
    },
  };
  const send = (attributes = {}, eventId) => inbox.ingest({ eventType: "Merge Request Hook", eventId,
    payload: { object_kind: "merge_request", project: { id: 12 }, object_attributes: {
      iid: 7, action: "update", state: "opened", draft: false, description: "@reviewer", reviewer_ids: [],
      updated_at: now().toISOString(), last_commit: { id: metadata.sha }, ...attributes,
    } } });
  const makeWorker = (overrides = {}) => {
    const worker = new ReviewWorker({ inbox, gitlab, contextService, runner, notifier, now,
      retryDelayMs: 1000, leaseMs: 10_000, ...overrides });
    workers.push(worker);
    return worker;
  };
  t.after(async () => {
    for (const worker of workers) await worker.stop();
    for (const instance of extraInboxes) instance.close();
    inbox.close();
    contextService.close();
    assert.equal(dirname(resolve(dataDir)), root);
    assert.ok(basename(dataDir).startsWith("review-worker-test-"));
    rmSync(dataDir, { recursive: true, force: true });
  });
  return {
    get inbox() { return inbox; }, get contextService() { return contextService; },
    hooks, calls, notes, events, gitlab, runner, notifier, send, makeWorker, now,
    advance(ms = 1001) { time += ms; },
    changeMr(changes) { metadata = { ...metadata, ...changes }; },
    restart() { inbox.close(); contextService.close(); open(); },
    secondInbox() {
      const instance = new ReviewInbox({ dataDir, username: "reviewer", projectIds: [12] });
      extraInboxes.push(instance);
      return instance;
    },
    artifact(requestId = 1) { return JSON.parse(inbox.db.prepare("SELECT artifact FROM review_executions WHERE request_id = ?").get(requestId).artifact); },
  };
}

test("자동 worker는 수집한 사람의 리뷰 댓글을 저장한 뒤 같은 실행의 모델 관점에 전달한다", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.contextService.dataDir, "reviewer-comments-policy.json"), JSON.stringify({ schemaVersion: 1, enabled: true, excludedUserIds: [8], excludedUsernames: [] }));
  f.contextService.upsertMember({ id: "human-reviewer", displayName: "검토자", gitlabUsername: "human.reviewer", gitlabUserId: 9,
    jiraAccountId: "fixture:9", areas: ["API"], paths: ["src"], reviewFocus: ["응답 계약"] });
  f.notes.push({ id: 55, author: { id: 9, username: "human.reviewer" }, system: false,
    body: "API의 빈 결과 처리와 회귀 테스트를 추가해 주세요.", created_at: INITIAL_TIME, updated_at: INITIAL_TIME });
  f.hooks.review = (input) => {
    const view = input.context.perspectives.find((item) => item.memberId === "human-reviewer");
    assert.equal(view.reviewerObservations.commentCount, 1);
    assert.equal(view.reviewerObservations.examples[0].url, `${MR_URL}#note_55`);
    assert.equal(input.context.perspectives.find((item) => item.memberId === "dev-one").reviewerObservations, null);
  };
  f.send();
  assert.equal((await f.makeWorker().runOnce()).status, "completed");
  assert.equal(f.calls.reviews.length, 1);
  assert.equal(f.calls.notifications.length, 1);
});

test("웹훅 요청은 실제 코드 검토·누적 기록·MR 댓글·Mattermost까지 이어지고 동일 SHA는 반복하지 않는다", async (t) => {
  const f = fixture(t);
  assert.equal(f.send().status, "queued");
  const output = await f.makeWorker().runOnce();
  assert.deepEqual(output, { status: "completed", requestId: 1, commentUrl: `${MR_URL}#note_100` });
  assert.deepEqual(f.events, ["review", "comment", "notification"]);
  assert.equal(f.calls.reviews.length, 1);
  assert.equal(f.notes.length, 1);
  assert.equal(f.calls.notifications[0].commentUrl, `${MR_URL}#note_100`);
  assert.equal(f.calls.notifications[0].headSha, HEAD);
  assert.equal(f.contextService.reviewHistory().total, 1);
  const saved = f.contextService.reviewHistory().records[0];
  assert.deepEqual(saved.issueKeys, ["TEAM-7"]);
  assert.equal(saved.mrUrl, MR_URL);
  assert.deepEqual(saved.memory, result().memory);
  const artifact = f.artifact();
  assert.ok(artifact.completion.id);
  assert.deepEqual(Object.keys(artifact.contextRef).sort(), ["contextVersion", "headSha", "mrUrl"]);
  assert.equal(Object.hasOwn(artifact, "context"), false);
  assert.equal(Object.hasOwn(artifact, "changes"), false);
  assert.doesNotMatch(JSON.stringify(artifact), /head-implementation-marker/);
  assert.equal(f.inbox.workerStatus().counts.completed, 1);
  f.advance();
  f.send({}, "same-sha-new-delivery");
  assert.deepEqual(await f.makeWorker().runOnce(), { status: "idle" });
});

test("격리 실행 결과를 모델·댓글·누적 기록에 연결하고 모델 실패 재시도에 검증을 반복하지 않는다", async (t) => {
  const f = fixture(t);
  let verificationCalls = 0;
  const verification = { schemaVersion: 1, runId: "fixture-verification", projectId: 12, mrIid: 7, headSha: HEAD,
    configuration: "configured", startedAt: INITIAL_TIME, finishedAt: INITIAL_TIME,
    ci: { status: "not_found", sha: HEAD, pipeline: null, jobs: [], bridges: [], tests: null },
    checks: [{ name: "backend-test", kind: "test", command: ["test"], result: "passed", exitCode: 0, reason: null }] };
  const verificationService = { async collect() { verificationCalls++; return verification; } };
  const runner = { async review(input) {
    assert.equal(input.verification.headSha, HEAD);
    if (f.calls.reviews.length === 0) { f.calls.reviews.push(input); throw Object.assign(new Error("fixture failure"), { code: "runner_timeout" }); }
    return result();
  } };
  f.send();
  assert.equal((await f.makeWorker({ verificationService, runner }).runOnce()).status, "failed");
  f.advance();
  assert.equal((await f.makeWorker({ verificationService, runner }).runOnce()).status, "completed");
  assert.equal(verificationCalls, 1);
  assert.match(f.notes[0].body, /backend-test.*통과/);
  const saved = f.contextService.reviewHistory().records[0];
  assert.ok(saved.memory.validations.some((item) => item.check === "격리 test: backend-test" && item.result === "passed" && item.basis === "observed"));
  assert.equal(f.notes.length, 1);
  assert.equal(f.calls.notifications.length, 1);
});

test("MR 설명의 SHA-256은 Jira 후보에서 제외하고 실제 이슈와 리뷰·게시·알림을 처리한다", async (t) => {
  const f = fixture(t);
  f.changeMr({ description: "SHA-256을 사용해 응답을 검증합니다. OTHER-12는 외부 참조입니다." });
  f.send();
  assert.equal((await f.makeWorker().runOnce()).status, "completed");
  assert.deepEqual(f.calls.jira.filter((call) => call.type === "issue").map((call) => call.key), ["TEAM-7"]);
  assert.deepEqual(f.calls.reviews[0].context.relatedIssues.map((item) => item.key), ["TEAM-7"]);
  assert.match(f.calls.reviews[0].context.warnings.join(" "), /2개.*제외/);
  assert.deepEqual(f.events, ["review", "comment", "notification"]);
});

test("이미지만 있는 MR은 검토할 텍스트가 없음을 기록하고 자동 재시도·게시를 멈춘다", async (t) => {
  const f = fixture(t);
  f.gitlab.readReview = async () => { throw Object.assign(new Error("No reviewable text"), { code: "no_reviewable_text" }); };
  f.send();
  const worker = f.makeWorker();
  assert.deepEqual(await worker.runOnce(), { status: "failed", requestId: 1, code: "no_reviewable_text" });
  const status = f.inbox.workerStatus().jobs[0];
  assert.equal(status.status, "failed");
  assert.equal(status.attempt, 1);
  assert.match(status.lastErrorMessage, /검토할 코드·텍스트 파일이 없습니다/);
  f.advance(1_000_000);
  assert.deepEqual(await worker.runOnce(), { status: "idle" });
  assert.equal(f.calls.reviews.length, 0);
  assert.equal(f.notes.length, 0);
  assert.equal(f.calls.notifications.length, 0);
});

test("알림 채널·작성자 연결이 빠지거나 중복되면 검토 전에 명확한 설정 오류로 멈춘다", async (t) => {
  for (const setting of [
    { channels: [], participants: [{ id: 1, mention: "@fixture" }] },
    { channels: [{ enabled: false }], participants: [{ id: 1, mention: "@fixture" }] },
    { channels: [{ enabled: true }], participants: [] },
    { channels: [{ enabled: true }], participants: [{ id: 1 }, { id: 2 }] },
  ]) {
    const f = fixture(t);
    const notifier = new MattermostReviewNotifier({ channelName: "fixture", service: {
      listChannels: () => setting.channels, listParticipants: () => setting.participants,
      previewMessage: () => assert.fail("Invalid setup cannot prepare a message"),
      sendDirectMessage: () => assert.fail("Invalid setup cannot send a message"),
    } });
    f.send();
    const worker = f.makeWorker({ notifier });
    assert.deepEqual(await worker.runOnce(), { status: "failed", requestId: 1, code: "notification_setup_missing" });
    const status = f.inbox.workerStatus().jobs[0];
    assert.equal(status.status, "failed");
    assert.equal(status.attempt, 1);
    assert.equal(status.nextAttemptAt, null);
    assert.match(status.lastErrorMessage, /GitLab·Mattermost.*명시적으로 재시도/);
    f.advance(1_000_000);
    assert.deepEqual(await worker.runOnce(), { status: "idle" });
    assert.equal(f.calls.jira.length, 0);
    assert.equal(f.calls.reviews.length, 0);
    assert.equal(f.notes.length, 0);
    assert.equal(f.calls.notifications.length, 0);
  }
});

test("팀원 미등록 작성자는 Jira·모델·게시 호출 없이 등록 조치가 필요한 오류로 멈춘다", async (t) => {
  const f = fixture(t);
  f.changeMr({ author: { id: 100, username: "unregistered.author" } });
  f.send();
  const worker = f.makeWorker();
  assert.deepEqual(await worker.runOnce(), { status: "failed", requestId: 1, code: "review_author_unmapped" });
  const status = f.inbox.workerStatus().jobs[0];
  assert.equal(status.status, "failed");
  assert.equal(status.attempt, 1);
  assert.equal(status.nextAttemptAt, null);
  assert.match(status.lastErrorMessage, /GitLab·Jira.*담당 영역.*명시적으로 재시도/);
  f.advance(1_000_000);
  assert.deepEqual(await worker.runOnce(), { status: "idle" });
  assert.equal(f.calls.jira.length, 0);
  assert.equal(f.calls.reviews.length, 0);
  assert.equal(f.notes.length, 0);
  assert.equal(f.calls.notifications.length, 0);
  assert.equal(f.contextService.reviewHistory().total, 0);
});

test("다음 커밋 자동 리뷰는 이전 구현 기록을 다시 참고하며 새 기록을 누적한다", async (t) => {
  const f = fixture(t);
  f.send();
  assert.equal((await f.makeWorker().runOnce()).status, "completed");
  f.advance();
  f.changeMr({ sha: NEXT, diff_refs: { head_sha: NEXT, base_sha: BASE, start_sha: "c".repeat(40) } });
  f.send();
  assert.equal((await f.makeWorker().runOnce()).status, "completed");
  assert.equal(f.calls.reviews.length, 2);
  assert.equal(f.calls.reviews[1].context.reviewHistory.total, 1);
  assert.equal(f.calls.reviews[1].context.reviewHistory.records[0].headSha, HEAD);
  assert.equal(f.contextService.reviewHistory().total, 2);
  assert.equal(f.notes.length, 2);
  assert.equal(f.calls.notifications.length, 2);
});

test("게시 이후 알림 준비 실패는 재시작 후 Mattermost만 재개한다", async (t) => {
  const f = fixture(t);
  f.send();
  f.hooks.prepare = (_input, count) => { if (count === 2) throw new Error("notification setup changed"); };
  const first = await f.makeWorker().runOnce();
  assert.equal(first.status, "failed");
  assert.equal(f.inbox.workerStatus().jobs[0].stage, "posted");
  assert.equal(f.notes.length, 1);
  assert.equal(f.calls.notifications.length, 0);
  f.restart();
  f.advance();
  delete f.hooks.prepare;
  const resumed = await f.makeWorker().runOnce();
  assert.equal(resumed.status, "completed");
  assert.equal(f.calls.reviews.length, 1);
  assert.equal(f.contextService.reviewHistory().total, 1);
  assert.equal(f.calls.glab.filter((call) => call.method === "POST").length, 1);
  assert.equal(f.calls.notifications.length, 1);
});

test("댓글 서버 반영 후 timeout은 marker로 복구하며 종료된 MR에도 중복 댓글 없이 알림을 완료한다", async (t) => {
  const f = fixture(t);
  f.send();
  f.hooks.afterPost = () => { throw new Error("ambiguous GitLab timeout"); };
  const first = await f.makeWorker().runOnce();
  assert.equal(first.status, "failed");
  assert.equal(first.code, "gitlab_request_failed");
  assert.equal(f.inbox.workerStatus().jobs[0].stage, "posting");
  assert.equal(f.notes.length, 1);
  assert.equal(f.calls.notifications.length, 0);
  f.advance();
  f.changeMr({ state: "closed", sha: NEXT, diff_refs: { head_sha: NEXT, base_sha: BASE, start_sha: "c".repeat(40) } });
  f.send({ state: "closed", action: "close" });
  f.restart();
  delete f.hooks.afterPost;
  assert.equal((await f.makeWorker().runOnce()).status, "completed");
  assert.equal(f.notes.length, 1);
  assert.equal(f.calls.glab.filter((call) => call.method === "POST").length, 1);
  assert.equal(f.calls.reviews.length, 1);
  assert.equal(f.calls.notifications.length, 1);
  assert.equal(f.calls.notifications[0].headSha, HEAD);
});

test("리뷰 중 최신 커밋·닫힘·draft를 발견하면 MR 댓글과 알림을 생성하지 않는다", async (t) => {
  for (const change of [
    { sha: NEXT, diff_refs: { head_sha: NEXT, base_sha: BASE, start_sha: "c".repeat(40) } },
    { state: "closed" }, { draft: true },
  ]) {
    const f = fixture(t);
    f.send();
    f.hooks.review = () => f.changeMr(change);
    const output = await f.makeWorker().runOnce();
    assert.equal(output.status, "skipped");
    assert.equal(f.notes.length, 0);
    assert.equal(f.calls.notifications.length, 0);
    assert.equal(f.contextService.reviewHistory().total, 0);
  }
});

test("webhook가 댓글 직전 요청을 무효화하면 beforeCreate가 게시를 차단한다", async (t) => {
  const f = fixture(t);
  f.send();
  const originalEnsureComment = f.gitlab.ensureComment.bind(f.gitlab);
  f.gitlab.ensureComment = (input) => originalEnsureComment({ ...input, beforeCreate: () => {
    f.advance();
    f.send({ state: "closed", action: "close" });
    return input.beforeCreate();
  } });
  const output = await f.makeWorker().runOnce();
  assert.equal(output.status, "skipped");
  assert.equal(output.reason, "request_obsolete");
  assert.equal(f.notes.length, 0);
  assert.equal(f.calls.notifications.length, 0);
});

test("공유 DB를 사용하는 두 worker는 한 요청의 모델 실행과 게시를 하나만 수행한다", async (t) => {
  const f = fixture(t);
  f.send();
  const entered = deferred();
  const release = deferred();
  f.hooks.review = async () => { entered.resolve(); await release.promise; };
  const first = f.makeWorker();
  const active = first.runOnce();
  await entered.promise;
  assert.deepEqual(await first.runOnce(), { status: "busy" });
  const second = f.makeWorker({ inbox: f.secondInbox() });
  assert.deepEqual(await second.runOnce(), { status: "idle" });
  release.resolve();
  assert.equal((await active).status, "completed");
  assert.equal(f.calls.reviews.length, 1);
  assert.equal(f.notes.length, 1);
  assert.equal(f.calls.notifications.length, 1);
});

test("lease가 만료돼 다른 worker가 인계하면 이전 모델 결과는 게시할 수 없다", async (t) => {
  const f = fixture(t);
  f.send();
  const entered = deferred();
  const release = deferred();
  f.hooks.review = async () => {
    if (f.calls.reviews.length === 1) { entered.resolve(); await release.promise; }
  };
  const oldWork = f.makeWorker().runOnce();
  await entered.promise;
  try {
    f.advance(10_001);
    const next = await f.makeWorker({ inbox: f.secondInbox() }).runOnce();
    assert.equal(next.status, "completed");
  } finally { release.resolve(); }
  assert.equal((await oldWork).status, "lease_lost");
  assert.equal(f.calls.reviews.length, 2);
  assert.equal(f.notes.length, 1);
  assert.equal(f.calls.notifications.length, 1);
  assert.equal(f.contextService.reviewHistory().total, 1);
});

test("실행기 검증 오류는 구체적인 코드와 안전한 설명으로 조회되고 원문을 남기거나 게시하지 않는다", async (t) => {
  const f = fixture(t);
  f.send();
  f.hooks.review = async () => { throw Object.assign(new Error("fixture-private-output"), { code: "review_locations_invalid" }); };
  assert.deepEqual(await f.makeWorker().runOnce(), { status: "failed", requestId: 1, code: "review_locations_invalid" });
  let status = f.inbox.workerStatus();
  assert.equal(status.jobs[0].lastErrorCode, "review_locations_invalid");
  assert.match(status.jobs[0].lastErrorMessage, /파일·줄 위치/);
  assert.equal(JSON.stringify(status).includes("fixture-private-output"), false);
  assert.equal(f.notes.length, 0);
  assert.equal(f.calls.notifications.length, 0);
  assert.equal(f.contextService.reviewHistory().total, 0);
  f.advance();
  f.hooks.review = async () => { throw new Error("fixture-private-output"); };
  await f.makeWorker().runOnce();
  status = f.inbox.workerStatus();
  assert.equal(status.jobs[0].lastErrorCode, "review_step_failed");
  assert.match(status.jobs[0].lastErrorMessage, /원인을 확정할 수 없/);
  assert.equal(JSON.stringify(status).includes("fixture-private-output"), false);
});

test("모델 실행 중 stop은 AbortSignal을 전달하고 후속 게시 없이 lease를 재시도 상태로 해제한다", async (t) => {
  const f = fixture(t);
  f.send();
  const entered = deferred();
  let signal;
  f.hooks.review = async (_input, options) => {
    signal = options.signal;
    entered.resolve();
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
  };
  const worker = f.makeWorker();
  const running = worker.runOnce();
  await entered.promise;
  await worker.stop();
  assert.equal(signal.aborted, true);
  assert.deepEqual(await running, { status: "failed", requestId: 1, code: "worker_stopped" });
  assert.equal(f.notes.length, 0);
  assert.equal(f.calls.notifications.length, 0);
  assert.equal(f.contextService.reviewHistory().total, 0);
  assert.equal(f.inbox.workerStatus().jobs[0].stage, "reviewing");
  assert.equal(f.inbox.workerStatus().jobs[0].status, "retry");
  delete f.hooks.review;
  f.advance();
  assert.equal((await f.makeWorker().runOnce()).status, "completed");
  assert.equal(f.calls.reviews.length, 2);
  assert.equal(f.notes.length, 1);
  assert.equal(f.calls.notifications.length, 1);
});

test("Mattermost 송신 결과가 모호하면 자동 재시도하지 않고 명시적 중복 허용 후 알림만 보낸다", async (t) => {
  const f = fixture(t);
  f.send();
  f.hooks.send = () => { throw new Error("sent but response lost"); };
  const first = await f.makeWorker().runOnce();
  assert.deepEqual(first, { status: "failed", requestId: 1, code: "notification_unknown" });
  assert.equal(f.inbox.workerStatus().jobs[0].stage, "notification_unknown");
  assert.equal(f.inbox.workerStatus().jobs[0].status, "failed");
  assert.throws(() => f.inbox.retryFailed(1, { now: f.now() }), /duplicate-delivery permission/);
  f.advance(100_000);
  assert.equal((await f.makeWorker().runOnce()).status, "idle");
  f.restart();
  delete f.hooks.send;
  f.inbox.retryFailed(1, { allowNotificationDuplicate: true, now: f.now() });
  assert.equal((await f.makeWorker().runOnce()).status, "completed");
  assert.equal(f.calls.reviews.length, 1);
  assert.equal(f.notes.length, 1);
  assert.equal(f.calls.glab.filter((call) => call.method === "POST").length, 1);
  assert.equal(f.calls.notifications.length, 2);
  assert.equal(f.contextService.reviewHistory().total, 1);
});

test("Mattermost HTTP 성공 직후 중단돼 완료 처리를 못하면 즉시 결과 미확인으로 해제하고 재송신하지 않는다", async (t) => {
  const f = fixture(t);
  f.send();
  const worker = f.makeWorker();
  f.hooks.send = () => { worker.controller.abort(); };
  assert.deepEqual(await worker.runOnce(), { status: "failed", requestId: 1, code: "notification_unknown" });
  assert.equal(f.inbox.workerStatus().jobs[0].stage, "notification_unknown");
  assert.equal(f.inbox.workerStatus().jobs[0].status, "failed");
  assert.equal(f.inbox.workerStatus().counts.running, 0);
  assert.equal(f.calls.notifications.length, 1);
  assert.equal(f.notes.length, 1);
  f.advance(100_000);
  assert.deepEqual(await f.makeWorker().runOnce(), { status: "idle" });
  assert.equal(f.calls.notifications.length, 1);
  assert.throws(() => f.inbox.retryFailed(1, { now: f.now() }), /duplicate-delivery permission/);
});

test("알림 checkpoint 직후 crash도 결과 미확인으로 중단하며 자동 송신하지 않는다", async (t) => {
  const f = fixture(t);
  f.send();
  const checkpoint = f.inbox.checkpoint.bind(f.inbox);
  f.inbox.checkpoint = (id, token, options) => {
    const output = checkpoint(id, token, options);
    if (options.stage === "notifying") f.advance(10_001);
    return output;
  };
  // Simulate process loss before the side effect without leaving an unresolved promise.
  f.hooks.send = () => { throw new Error("process ended before send"); };
  assert.equal((await f.makeWorker().runOnce()).status, "lease_lost");
  assert.equal(f.inbox.workerStatus().jobs[0].stage, "notifying");
  f.restart();
  delete f.hooks.send;
  const before = f.calls.notifications.length;
  const recovered = await f.makeWorker().runOnce();
  assert.deepEqual(recovered, { status: "failed", requestId: 1, code: "notification_unknown" });
  assert.equal(f.calls.notifications.length, before);
  assert.equal(f.inbox.workerStatus().jobs[0].stage, "notification_unknown");
  f.inbox.retryFailed(1, { allowNotificationDuplicate: true, now: f.now() });
  assert.equal((await f.makeWorker().runOnce()).status, "completed");
  assert.equal(f.calls.reviews.length, 1);
  assert.equal(f.notes.length, 1);
});
