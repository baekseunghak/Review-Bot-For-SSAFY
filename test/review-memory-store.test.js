import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { UserError } from "../src/core.js";
import { normalizeReviewMemory, reviewMemoryMarkdown } from "../src/review-memory.js";
import { TeamContextStore } from "../src/team-context-store.js";

const SHA = "a".repeat(40);
const VERSION = "b".repeat(64);
const NOW = "2026-10-20T01:00:00.000Z";
const MR = "https://gitlab.example.test/team/project/-/merge_requests/7";

function memory(overrides = {}) {
  return {
    implementation: [{ summary: "입력 오류를 확인하고 잘못된 요청을 거절한다.", basis: "observed", evidence: [{ kind: "code", ref: "src/example.js:12" }] }],
    decisions: [{ decision: "기존 검증 함수를 재사용한다.", reason: null, basis: "observed", evidence: [{ kind: "code", ref: "src/example.js:20" }] }],
    validations: [{ check: "잘못된 입력 회귀 테스트", result: "passed", basis: "observed", evidence: [{ kind: "test", ref: "fixture test run 1" }] }],
    remainingWork: [{ summary: "외부 연결은 아직 확인하지 못했다.", basis: "unknown", evidence: [] }],
    ...overrides,
  };
}

function completion(overrides = {}) {
  return { mrUrl: MR, headSha: SHA, contextVersion: VERSION, authorMemberId: "fixture-member", issueKeys: ["DEMO-1"],
    changedPaths: ["src/example.js"], verdict: "approve", memory: memory(), recordedAt: NOW, stage: "reviewed", ...overrides };
}

function prepare(store, overrides = {}) {
  const bundle = { status: "fresh", mrUrl: MR, headSha: SHA, author: { memberId: "fixture-member" },
    relatedIssues: [{ key: "DEMO-1" }], changedPaths: ["src/example.js"], perspectives: [], ...overrides };
  const reviewKey = createHash("sha256").update(MR).digest("hex").slice(0, 24);
  return store.saveReviewBundle(reviewKey, SHA, { bundle, markdown: "# 가상 준비 맥락" });
}

function issue() {
  return { key: "DEMO-1", summary: "가상 Jira 작업", description: "원본 Jira 설명", status: { id: "1", name: "진행 중", category: "indeterminate" },
    assigneeAccountId: "fixture-jira", updatedAt: NOW, createdAt: "2026-10-19T00:00:00.000Z", url: "https://jira.example.test/browse/DEMO-1",
    components: [], inCurrentSprint: true, history: [], historyComplete: true, descriptionTruncated: false };
}

function storage(t, { legacy = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "review-memory-test-"));
  if (legacy) {
    const db = new DatabaseSync(join(directory, "team-context.sqlite3"));
    db.exec("CREATE TABLE team_members(id TEXT PRIMARY KEY, gitlab_username TEXT NOT NULL UNIQUE COLLATE NOCASE, jira_account_id TEXT NOT NULL UNIQUE, profile_json TEXT NOT NULL)");
    db.close();
  }
  const instances = new Set();
  const open = () => { const store = new TeamContextStore({ dataDir: directory }); instances.add(store); return store; };
  const close = (store) => { store.close(); instances.delete(store); };
  const store = open();
  store.putMember({ id: "fixture-member", displayName: "가상 메모리 팀원", gitlabUsername: "fixture-member", gitlabUserId: 1,
    jiraAccountId: "fixture-jira", areas: ["테스트 영역"], paths: ["src"], reviewFocus: ["입력 오류"] });
  t.after(() => {
    for (const instance of instances) instance.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, store, open, close };
}

test("memory separates observed code, reported reasons, unknown work and validation evidence", () => {
  const record = memory({ decisions: [{ decision: "기존 함수를 재사용한다.", reason: "작성자가 중복 검증을 줄이려 했다고 설명했다.",
    basis: "reported", evidence: [{ kind: "mr_description", ref: MR }] }] });
  assert.deepEqual(normalizeReviewMemory(record), record);
  const unknown = memory({ validations: [{ check: "작성자가 성공 여부를 남기지 않은 검증", result: "unknown", basis: "unknown", evidence: [] }] });
  assert.equal(normalizeReviewMemory(unknown).validations[0].result, "unknown");
  assert.match(reviewMemoryMarkdown(completion({ memory: unknown })), /basis=unknown은 미확인/);
  assert.match(reviewMemoryMarkdown(completion()), /댓글 게시·승인·병합을 뜻하지 않습니다/);
  assert.throws(() => normalizeReviewMemory(memory({ decisions: [{ decision: "함수 재사용", reason: "속도를 높이려 했을 것이다.",
    basis: "observed", evidence: [{ kind: "code", ref: "src/example.js:12" }] }] })), UserError);
  assert.throws(() => normalizeReviewMemory(memory({ decisions: [{ decision: "함수 재사용", reason: "속도 개선", basis: "reported", evidence: [{ kind: "code", ref: "src/example.js:12" }] }] })), UserError);
  assert.throws(() => normalizeReviewMemory(memory({ validations: [{ check: "검증", result: "passed", basis: "observed", evidence: [{ kind: "code", ref: "src/example.js:12" }] }] })), UserError);
  assert.throws(() => normalizeReviewMemory(memory({ validations: [{ check: "검증", result: "failed", basis: "reported", evidence: [{ kind: "test", ref: "fixture test run" }] }] })), UserError);
});

test("memory requires bounded structured fields and rejects ungrounded claims and control characters", () => {
  const cases = [
    {}, memory({ implementation: [] }), memory({ decisions: undefined }),
    memory({ remainingWork: Array.from({ length: 31 }, () => ({ summary: "미확인", basis: "unknown", evidence: [] })) }),
    memory({ implementation: [{ summary: "x".repeat(2_001), basis: "unknown", evidence: [] }] }),
    memory({ implementation: [{ summary: "미확인", basis: "inferred", evidence: [] }] }),
    memory({ implementation: [{ summary: "확인 주장", basis: "observed", evidence: [] }] }),
    memory({ implementation: [{ summary: "작성자 주장", basis: "reported", evidence: [] }] }),
    memory({ implementation: [{ summary: "확인", basis: "observed", evidence: [{ kind: "code", ref: "src/a.js\nrun command" }] }] }),
    memory({ implementation: [{ summary: "확인", basis: "observed", evidence: [{ kind: "code", ref: "x".repeat(2_049) }] }] }),
    memory({ implementation: [{ summary: "확인", basis: "observed", evidence: Array.from({ length: 11 }, () => ({ kind: "code", ref: "src/a.js:1" })) }] }),
  ];
  for (const record of cases) assert.throws(() => normalizeReviewMemory(record), UserError);
});

test("specification evidence names supplied cells and cannot prove an executed validation", () => {
  const ref = "requirements.xlsx#Contract!D20";
  const specification = { source: { name: "requirements.xlsx" },
    sheets: [{ name: "Contract", rows: [{ row: 20, cells: [{ address: "D20", value: "Count evidence entries." }] }] }] };
  const record = memory({ decisions: [{ decision: "Count evidence entries independently.", reason: "The supplied specification defines that unit.",
    basis: "reported", evidence: [{ kind: "specification", ref }] }] });
  assert.deepEqual(normalizeReviewMemory(record, { specification }), record);
  assert.throws(() => normalizeReviewMemory(record, { specification: null }), UserError);
  for (const missing of ["requirements.xlsx#Contract!D21", "other.xlsx#Contract!D20", "requirements.xlsx#Missing!D20"]) {
    const invalid = structuredClone(record);
    invalid.decisions[0].evidence[0].ref = missing;
    assert.throws(() => normalizeReviewMemory(invalid, { specification }), UserError);
  }
  for (const basis of ["reported", "observed"]) {
    assert.throws(() => normalizeReviewMemory(memory({ validations: [{ check: "Build execution", result: "passed", basis,
      evidence: [{ kind: "specification", ref }] }] }), { specification }), UserError);
  }
});

test("memory has a total UTF-8 budget even when every individual entry fits", () => {
  const make = (character) => memory({
    implementation: Array.from({ length: 30 }, () => ({ summary: character.repeat(1_000), basis: "unknown", evidence: [] })),
    decisions: [], validations: [], remainingWork: [],
  });
  const ascii = make("x");
  const korean = make("가");
  assert.ok(JSON.stringify(korean).length < 64 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(korean), "utf8") > 64 * 1024);
  assert.deepEqual(normalizeReviewMemory(ascii), ascii);
  assert.throws(() => normalizeReviewMemory(korean), UserError);
});

test("source references cannot retain credentials in URLs", () => {
  for (const ref of [
    "https://fixture-user:fixture-password@gitlab.example.test/team/project/-/merge_requests/7",
    "https://fixture-user@gitlab.example.test/team/project/-/merge_requests/7",
    "MR source https://fixture-user:fixture-password@gitlab.example.test/team/project",
    "ssh://fixture-user@gitlab.example.test/team/project",
  ]) {
    assert.throws(() => normalizeReviewMemory(memory({ implementation: [{ summary: "가상 근거", basis: "observed", evidence: [{ kind: "code", ref }] }] })), UserError);
  }
  const source = memory({ implementation: [{ summary: "가상 근거", basis: "reported", evidence: [{ kind: "mr_description", ref: MR }] }] });
  assert.deepEqual(normalizeReviewMemory(source), source);
});

test("completion retries deduplicate, while changed memory and a changed context append immutable records", (t) => {
  const { store } = storage(t);
  const first = store.saveReviewCompletion(completion());
  const original = readFileSync(first.path, "utf8");
  const repeated = store.saveReviewCompletion(completion({ recordedAt: "2026-10-21T01:00:00Z", mrUrl: `${MR}/#note_42` }));
  assert.equal(repeated.id, first.id);
  assert.equal(repeated.recordedAt, NOW);
  assert.equal(store.listReviewCompletions().total, 1);
  const changed = store.saveReviewCompletion(completion({ memory: memory({ remainingWork: [] }), recordedAt: "2026-10-21T01:00:00Z" }));
  assert.notEqual(changed.id, first.id);
  assert.notEqual(changed.path, first.path);
  const contextChanged = store.saveReviewCompletion(completion({ contextVersion: "c".repeat(64) }));
  assert.notEqual(contextChanged.id, first.id);
  assert.equal(store.listReviewCompletions().total, 3);
  assert.equal(readFileSync(first.path, "utf8"), original);
  assert.deepEqual(readdirSync(dirname(first.path)).sort(), [first.id, changed.id, contextChanged.id].map((id) => `${id}.md`).sort());
});

test("MR and issue links share one canonical record without copying private memory into the issue index", (t) => {
  const { store, directory } = storage(t);
  const saved = store.saveReviewCompletion(completion({ issueKeys: ["DEMO-2", "DEMO-1", "DEMO-1"] }));
  assert.equal(saved.path, join(directory, "reviews", saved.reviewKey, "history", `${saved.id}.md`));
  for (const key of ["DEMO-1", "DEMO-2"]) {
    const index = readFileSync(join(directory, "issues", key, "review-history.md"), "utf8");
    assert.ok(index.includes(`../../reviews/${saved.reviewKey}/history/${saved.id}.md`));
    assert.equal(index.includes(saved.memory.implementation[0].summary), false);
    assert.equal(index.includes(saved.memory.decisions[0].decision), false);
  }
  store.saveReviewCompletion(completion({ verdict: "hold" }));
  const index = readFileSync(join(directory, "issues", "DEMO-1", "review-history.md"), "utf8");
  assert.equal((index.match(/\]\(\.\.\/\.\.\/reviews\//g) ?? []).length, 2);
  store.saveIssues("fixture-member", [issue()], { fetchedAt: NOW });
  store.saveIssues("fixture-member", [], { fetchedAt: "2026-10-22T00:00:00Z" });
  assert.equal(store.listReviewCompletions({ issueKeys: ["DEMO-1"] }).total, 2);
  assert.equal(readFileSync(join(directory, "issues", "DEMO-1", "review-history.md"), "utf8"), index);
  assert.equal(existsSync(saved.path), true);
});

test("history queries combine MR, issue and exact changed-path matches and paginate without duplicate records", (t) => {
  const { store } = storage(t);
  const first = store.saveReviewCompletion(completion());
  const second = store.saveReviewCompletion(completion({ mrUrl: MR.replace("/7", "/8"), issueKeys: ["DEMO-2"], changedPaths: ["src/other.js"], recordedAt: "2026-10-21T00:00:00Z" }));
  const third = store.saveReviewCompletion(completion({ mrUrl: MR.replace("/7", "/9"), issueKeys: ["DEMO-3"], changedPaths: ["shared/schema.sql"], recordedAt: "2026-10-22T00:00:00Z" }));
  assert.equal(store.listReviewCompletions({ mrUrl: MR }).records[0].id, first.id);
  assert.equal(store.listReviewCompletions({ issueKeys: ["DEMO-2"] }).records[0].id, second.id);
  assert.equal(store.listReviewCompletions({ changedPaths: ["shared/schema.sql"] }).records[0].id, third.id);
  assert.equal(store.listReviewCompletions({ changedPaths: ["src"] }).total, 0);
  const combined = store.listReviewCompletions({ mrUrl: MR, issueKeys: ["DEMO-1", "DEMO-2"], changedPaths: ["src/example.js", "shared/schema.sql"], limit: 2 });
  assert.equal(combined.total, 3);
  assert.equal(combined.records.length, 2);
  assert.equal(combined.nextOffset, 2);
  const last = store.listReviewCompletions({ offset: combined.nextOffset, limit: 2 });
  assert.equal(last.records.length, 1);
  assert.equal(last.nextOffset, null);
  assert.equal(new Set([...combined.records, ...last.records].map((record) => record.id)).size, 3);
});

test("automatic path matches stay within their host and project while explicit MR and Jira matches remain available", (t) => {
  const { store } = storage(t);
  const own = store.saveReviewCompletion(completion());
  const sameProject = store.saveReviewCompletion(completion({ mrUrl: MR.replace("/7", "/8"), issueKeys: ["DEMO-2"] }));
  const otherProject = store.saveReviewCompletion(completion({ mrUrl: MR.replace("team/project", "team/other-project"), issueKeys: ["DEMO-3"] }));
  const otherHost = store.saveReviewCompletion(completion({ mrUrl: MR.replace("gitlab.example.test", "other-gitlab.example.test"), issueKeys: ["DEMO-4"] }));
  const scoped = store.listReviewCompletions({ changedPaths: ["src/example.js"], pathScopeMrUrl: MR });
  assert.deepEqual(new Set(scoped.records.map((record) => record.id)), new Set([own.id, sameProject.id]));
  assert.equal(store.listReviewCompletions({ changedPaths: ["src/example.js"] }).total, 4);
  const withExplicit = store.listReviewCompletions({ mrUrl: otherHost.mrUrl, issueKeys: ["DEMO-3"], changedPaths: ["src/example.js"], pathScopeMrUrl: MR });
  assert.deepEqual(new Set(withExplicit.records.map((record) => record.id)), new Set([own.id, sameProject.id, otherProject.id, otherHost.id]));
});

test("prepared context binding is checked inside the completion transaction after a second process refreshes it", (t) => {
  const { store, open, directory } = storage(t);
  const prepared = prepare(store);
  const candidate = completion({ contextVersion: prepared.contextVersion });
  const reviewKey = createHash("sha256").update(MR).digest("hex").slice(0, 24);
  assert.equal(store.getReviewBundle(reviewKey, SHA).contextVersion, prepared.contextVersion);
  const replacement = prepare(open(), { relatedIssues: [{ key: "DEMO-2" }], changedPaths: ["src/changed.js"] });
  assert.throws(() => store.saveReviewCompletion(candidate, { requirePreparedContext: true }), /binding changed/);
  assert.equal(store.listReviewCompletions().total, 0);
  assert.equal(existsSync(join(directory, "reviews", reviewKey, "history")), false);
  const saved = store.saveReviewCompletion(completion({ contextVersion: replacement.contextVersion, issueKeys: ["DEMO-2"], changedPaths: ["src/changed.js"] }), { requirePreparedContext: true });
  assert.equal(saved.contextVersion, replacement.contextVersion);
  assert.equal(store.listReviewCompletions().total, 1);
});

test("strict completion binding rejects altered MR, SHA, author, issue and path metadata", (t) => {
  const { store } = storage(t);
  store.putMember({ id: "other-fixture", displayName: "다른 가상 팀원", gitlabUsername: "other-fixture", gitlabUserId: 2,
    jiraAccountId: "other-fixture-jira", areas: ["다른 영역"], paths: ["other"], reviewFocus: ["다른 관점"] });
  const prepared = prepare(store);
  const candidate = completion({ contextVersion: prepared.contextVersion });
  for (const overrides of [
    { mrUrl: MR.replace("/7", "/8") }, { headSha: "c".repeat(40) }, { contextVersion: "c".repeat(64) },
    { authorMemberId: "other-fixture" }, { issueKeys: ["DEMO-2"] }, { changedPaths: ["src/changed.js"] },
  ]) assert.throws(() => store.saveReviewCompletion({ ...candidate, ...overrides }, { requirePreparedContext: true }), UserError);
  const stale = prepare(store, { status: "partial" });
  assert.throws(() => store.saveReviewCompletion({ ...candidate, contextVersion: stale.contextVersion }, { requirePreparedContext: true }), UserError);
  assert.equal(store.listReviewCompletions().total, 0);
});

test("existing databases gain memory tables and both bundles and completed history survive restart", (t) => {
  const { store, open, close } = storage(t, { legacy: true });
  const prepared = store.saveReviewBundle("fixture-review", SHA, { bundle: { status: "fresh", headSha: SHA, mrUrl: MR }, markdown: "# 검증 자료" });
  const saved = store.saveReviewCompletion(completion());
  close(store);
  const restarted = open();
  assert.deepEqual(restarted.getReviewBundle("fixture-review", SHA), prepared);
  assert.equal(restarted.getReviewBundle("missing-review", SHA), null);
  assert.equal(restarted.listReviewCompletions({ mrUrl: MR }).records[0].id, saved.id);
  assert.equal(restarted.saveReviewCompletion(completion()).id, saved.id);
  assert.equal(restarted.listMembers().length, 1);
});

test("invalid bound fields and unsafe identifiers cannot create review-history files", (t) => {
  const { store, directory } = storage(t);
  for (const overrides of [
    { mrUrl: "file:///tmp/private" }, { mrUrl: "https://user:password@gitlab.example.test/team/project/-/merge_requests/7" },
    { headSha: "../outside" }, { contextVersion: "invalid" }, { authorMemberId: "../outside" },
    { issueKeys: ["../../private"] }, { changedPaths: ["C:/outside"] }, { changedPaths: ["src/../private"] },
    { verdict: "merged" }, { stage: "posted" }, { recordedAt: "invalid" },
  ]) assert.throws(() => store.saveReviewCompletion(completion(overrides)), UserError);
  assert.equal(existsSync(join(directory, "reviews")), false);
  assert.equal(store.listReviewCompletions().total, 0);
  assert.throws(() => store.listReviewCompletions({ issueKeys: ["../escape"] }), UserError);
  assert.throws(() => store.listReviewCompletions({ changedPaths: ["/private"] }), UserError);
  assert.throws(() => store.listReviewCompletions({ offset: -1 }), UserError);
});

test("an external directory link cannot redirect completion writes or create database history", (t) => {
  const { store, directory } = storage(t);
  const outside = mkdtempSync(join(tmpdir(), "review-memory-outside-"));
  t.after(() => {
    assert.equal(dirname(resolve(outside)), resolve(tmpdir()));
    rmSync(outside, { recursive: true, force: true });
  });
  try { symlinkSync(outside, join(directory, "reviews"), process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (error.code === "EPERM") { t.skip("Creating directory links is unavailable."); return; } throw error; }
  assert.throws(() => store.saveReviewCompletion(completion()), UserError);
  assert.equal(store.listReviewCompletions().total, 0);
  assert.deepEqual(readdirSync(outside), []);
});
