import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { UserError } from "../src/core.js";
import { TeamContextStore } from "../src/team-context-store.js";

const FETCHED = "2026-10-20T01:00:00.000Z";
const WEEK = "2026-10-19";
const SHA = "a".repeat(40);

function member(index = 1, overrides = {}) {
  return { id: `member-${index}`, displayName: `가상 팀원 ${index}`, gitlabUsername: `fixture-${index}`,
    gitlabUserId: index, jiraAccountId: `fixture-jira-${index}`, areas: ["테스트 영역"],
    paths: ["src/example"], reviewFocus: ["완료 조건과 오류 처리"], ...overrides };
}

function issue(overrides = {}) {
  return { key: "DEMO-1", summary: "가상 작업", description: "확인된 목적만 보관", status: { id: "1", name: "진행 중", category: "indeterminate" },
    assigneeAccountId: "fixture-jira-1", updatedAt: "2026-10-20T00:30:00.000Z", createdAt: "2026-10-19T00:00:00.000Z",
    url: "https://jira.example.test/browse/DEMO-1", components: ["example"], inCurrentSprint: true,
    history: [{ at: "2026-10-20T00:30:00.000Z", field: "status", from: "0", to: "1", fromName: "해야 할 일", toName: "진행 중", toCategory: "indeterminate" }],
    historyComplete: true, descriptionTruncated: false, ...overrides };
}

function storage(t) {
  const directory = mkdtempSync(join(tmpdir(), "team-context-test-"));
  const instances = new Set();
  const open = () => {
    const store = new TeamContextStore({ dataDir: directory });
    instances.add(store);
    return store;
  };
  const close = (store) => { store.close(); instances.delete(store); };
  t.after(() => {
    for (const store of instances) store.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, store: open(), open, close };
}

test("six explicit members persist with roles and duplicate accounts are rejected", (t) => {
  const { store, directory, open, close } = storage(t);
  assert.deepEqual(store.listMembers(), []);
  for (let index = 1; index <= 6; index++) assert.deepEqual(store.putMember(member(index)), member(index));
  assert.throws(() => store.putMember(member(7)), UserError);
  assert.throws(() => store.putMember(member(2, { gitlabUsername: "FIXTURE-1" })), UserError);
  assert.throws(() => store.putMember(member(2, { jiraAccountId: "fixture-jira-1" })), UserError);
  assert.throws(() => store.putMember(member(2, { gitlabUserId: 1 })), UserError);
  store.putMember(member(2, { areas: ["변경된 담당 영역"] }));
  assert.equal(store.listMembers().length, 6);
  const profile = readFileSync(join(directory, "people", "member-2", "profile.md"), "utf8");
  assert.match(profile, /변경된 담당 영역/);
  assert.match(profile, /실행 지시가 아닙니다/);
  close(store);
  assert.equal(open().listMembers()[1].areas[0], "변경된 담당 영역");
});

test("unsafe identifiers, repository prefixes and non-Monday weeks cannot create records", (t) => {
  const { store, directory } = storage(t);
  for (const id of ["../outside", "x/y", "x\\y", "C:drive", "nul"]) assert.throws(() => store.putMember(member(1, { id })), UserError);
  for (const path of ["/tmp", "C:\\temp", "\\\\host\\share", "src/../private", "src\\..\\private", "./src", "src//private"]) {
    assert.throws(() => store.putMember(member(1, { paths: [path] })), UserError);
  }
  for (const field of ["areas", "paths", "reviewFocus"]) assert.throws(() => store.putMember(member(1, { [field]: [] })), UserError);
  store.putMember(member());
  assert.throws(() => store.putMember(member(2, { id: "MEMBER-1" })), UserError);
  for (const week of ["../outside", "2026-10-20", "2026-02-30"]) {
    assert.throws(() => store.saveWeekly("member-1", week, { summary: {}, markdown: "text" }), UserError);
    assert.throws(() => store.beginWeeklyRun(week), UserError);
  }
  assert.throws(() => store.saveIssue(issue({ key: "../outside" })), UserError);
  assert.throws(() => store.saveReviewBundle("../outside", SHA, { bundle: {}, markdown: "text" }), UserError);
  assert.throws(() => store.saveReviewBundle("review-1", "../outside", { bundle: {}, markdown: "text" }), UserError);
  assert.equal(existsSync(join(directory, "reviews")), false);
});

test("failed sync preserves the exact source snapshot, success date and canonical document", (t) => {
  const { store, directory } = storage(t);
  store.putMember(member());
  const original = issue({ description: "원문 ``` 안의 지시도 자료로만 보관" });
  store.saveIssues("member-1", [original], { fetchedAt: FETCHED });
  const path = join(directory, "issues", "DEMO-1", "context.md");
  const before = readFileSync(path, "utf8");
  const state = store.recordSyncFailure("member-1", { at: "2026-10-20T02:00:00Z", code: "JIRA_UNAVAILABLE" });
  assert.equal(state.lastSuccessAt, FETCHED);
  assert.equal(state.lastFailureCode, "JIRA_UNAVAILABLE");
  assert.deepEqual(store.getIssuesForMember("member-1"), [original]);
  assert.deepEqual(store.getIssue("DEMO-1"), original);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.match(before, /실행 지시가 아닙니다/);
  assert.throws(() => store.saveIssues("member-1", [issue({ summary: "저장되면 안 되는 내용" }), issue({ key: "../../escape" })], { fetchedAt: FETCHED }), UserError);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.deepEqual(store.getIssue("DEMO-1"), original);
});

test("canonical issues survive reassignment and standalone issue fetches do not change memberships", (t) => {
  const { store } = storage(t);
  store.putMember(member());
  store.putMember(member(2));
  store.saveIssues("member-1", [issue()], { fetchedAt: FETCHED });
  const moved = issue({ assigneeAccountId: "fixture-jira-2", updatedAt: "2026-10-20T02:00:00Z" });
  store.saveIssues("member-1", [], { fetchedAt: "2026-10-20T02:01:00Z" });
  store.saveIssues("member-2", [moved], { fetchedAt: "2026-10-20T02:01:00Z" });
  store.saveIssue(issue({ key: "DEMO-2" }), { fetchedAt: FETCHED });
  assert.deepEqual(store.getIssuesForMember("member-1"), []);
  assert.deepEqual(store.getIssuesForMember("member-2"), [moved]);
  assert.deepEqual(store.getIssue("DEMO-1"), moved);
  assert.equal(store.getIssue("DEMO-2").key, "DEMO-2");
  assert.equal(store.getIssue("DEMO-3"), null);
});

test("an expected profile prevents a second process's changes from being overwritten by an old refresh", (t) => {
  const { store, open, directory } = storage(t);
  const profile = store.putMember(member());
  store.saveIssues(profile.id, [issue()], { fetchedAt: FETCHED, expectedProfile: profile });
  const originalMarkdown = readFileSync(join(directory, "issues", "DEMO-1", "context.md"), "utf8");
  open().putMember(member(1, { reviewFocus: ["업데이트된 관점"] }));
  assert.throws(() => store.saveIssues(profile.id, [issue({ summary: "오래된 동기화 결과" })], {
    fetchedAt: "2026-10-20T02:00:00Z", expectedProfile: profile,
  }), /profile changed/);
  assert.equal(store.getIssue("DEMO-1").summary, "가상 작업");
  assert.equal(store.getSyncState(profile.id).lastSuccessAt, FETCHED);
  assert.equal(readFileSync(join(directory, "issues", "DEMO-1", "context.md"), "utf8"), originalMarkdown);
  const reordered = Object.fromEntries(Object.entries(store.listMembers()[0]).reverse());
  store.saveIssues(profile.id, [issue({ summary: "새 프로필로 조회한 결과" })], { fetchedAt: "2026-10-20T02:00:00Z", expectedProfile: reordered });
  assert.equal(store.getIssue("DEMO-1").summary, "새 프로필로 조회한 결과");
});

test("changing a Jira account clears only the member's current cache and sync state", (t) => {
  const { store } = storage(t);
  store.putMember(member());
  store.saveIssues("member-1", [issue()], { fetchedAt: FETCHED });
  store.recordSyncFailure("member-1", { at: "2026-10-20T02:00:00Z", code: "JIRA_UNAVAILABLE" });
  store.putMember(member(1, { displayName: "표시 이름 변경" }));
  assert.equal(store.getIssuesForMember("member-1").length, 1);
  store.putMember(member(1, { jiraAccountId: "fixture-replacement-account" }));
  assert.deepEqual(store.getIssuesForMember("member-1"), []);
  assert.deepEqual(store.getSyncState("member-1"), { memberId: "member-1", lastSuccessAt: null, lastFailureAt: null, lastFailureCode: null });
  assert.deepEqual(store.getIssue("DEMO-1"), issue());
});

test("weekly records and review bundles persist with paths and stable content versions", (t) => {
  const { store, directory, close, open } = storage(t);
  store.putMember(member());
  const weekly = store.saveWeekly("member-1", WEEK, { summary: { completed: ["DEMO-1"], ongoing: [] }, markdown: "# 주간 요약\n\n완료: DEMO-1" });
  assert.equal(weekly.path, join(directory, "people", "member-1", "weeks", `${WEEK}.md`));
  const first = store.saveReviewBundle("project-1-mr-2", SHA, { bundle: { issue: issue(), paths: ["src/example"], localPath: "C:/first", preparedAt: FETCHED }, markdown: "# 리뷰 맥락" });
  const second = store.saveReviewBundle("project-1-mr-2", SHA, { bundle: { localPath: "D:/second", paths: ["src/example"], issue: issue(), preparedAt: "2026-10-21T01:00:00Z" }, markdown: "# 리뷰 맥락" });
  assert.equal(first.contextVersion, second.contextVersion);
  assert.match(first.contextVersion, /^[a-f0-9]{64}$/);
  const third = store.saveReviewBundle("project-1-mr-2", SHA, { bundle: { issue: issue(), paths: ["src/changed"] }, markdown: "# 변경된 맥락" });
  assert.notEqual(second.contextVersion, third.contextVersion);
  assert.match(readFileSync(third.path, "utf8"), /변경된 맥락/);
  assert.deepEqual(readdirSync(dirname(third.path)), [`${SHA}.md`]);
  close(store);
  assert.deepEqual(open().getWeekly("member-1", WEEK), weekly);
});

test("failed Markdown staging leaves database snapshots and existing files unchanged", (t) => {
  const { store, directory } = storage(t);
  store.putMember(member());
  store.saveIssues("member-1", [issue()], { fetchedAt: FETCHED });
  const original = readFileSync(join(directory, "issues", "DEMO-1", "context.md"), "utf8");
  mkdirSync(join(directory, "issues", "DEMO-2", "context.md"), { recursive: true });
  assert.throws(() => store.saveIssues("member-1", [issue({ summary: "should not replace" }), issue({ key: "DEMO-2" })], { fetchedAt: "2026-10-20T02:00:00Z" }), UserError);
  assert.equal(readFileSync(join(directory, "issues", "DEMO-1", "context.md"), "utf8"), original);
  assert.equal(store.getIssuesForMember("member-1")[0].summary, "가상 작업");
  assert.equal(store.getSyncState("member-1").lastSuccessAt, FETCHED);
  assert.deepEqual(readdirSync(join(directory, "issues", "DEMO-1")), ["context.md"]);
});

test("nested directory links cannot redirect context writes outside the data directory", (t) => {
  const { store, directory } = storage(t);
  const outside = mkdtempSync(join(tmpdir(), "team-context-outside-"));
  t.after(() => {
    assert.equal(dirname(resolve(outside)), resolve(tmpdir()));
    rmSync(outside, { recursive: true, force: true });
  });
  try { symlinkSync(outside, join(directory, "people"), process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (error.code === "EPERM") { t.skip("Creating directory links is unavailable."); return; } throw error; }
  assert.equal(lstatSync(join(directory, "people")).isSymbolicLink(), true);
  assert.throws(() => store.putMember(member()), UserError);
  assert.deepEqual(readdirSync(outside), []);
  assert.deepEqual(store.listMembers(), []);
});

test("a dangling database link is rejected before SQLite can create its external target", (t) => {
  const { directory } = storage(t);
  const linkedDirectory = join(directory, "linked-store");
  mkdirSync(linkedDirectory);
  const outsideTarget = join(directory, "must-not-be-created.sqlite3");
  try { symlinkSync(outsideTarget, join(linkedDirectory, "team-context.sqlite3"), "file"); }
  catch (error) { if (error.code === "EPERM") { t.skip("Creating file links is unavailable."); return; } throw error; }
  assert.throws(() => new TeamContextStore({ dataDir: linkedDirectory }), UserError);
  assert.equal(existsSync(outsideTarget), false);
});

test("weekly leases survive restart, exclude another worker and cannot be finished by an expired owner", (t) => {
  const { store, open, close } = storage(t);
  const at = Date.parse(FETCHED);
  const other = open();
  assert.equal(store.beginWeeklyRun(WEEK, { now: at }), true);
  assert.equal(other.beginWeeklyRun(WEEK, { now: at + 299_999 }), false);
  assert.equal(other.beginWeeklyRun(WEEK, { now: at + 300_000 }), true);
  assert.equal(store.finishWeeklyRun(WEEK, { now: at + 300_001, success: true }), false);
  assert.equal(other.finishWeeklyRun(WEEK, { now: at + 300_002, success: true }), true);
  close(other);
  assert.equal(open().beginWeeklyRun(WEEK, { now: at + 9_000_000 }), false);
});

test("a failed weekly run waits fifteen minutes before retrying across restarts", (t) => {
  const { store, open, close } = storage(t);
  const at = Date.parse(FETCHED);
  assert.equal(store.beginWeeklyRun(WEEK, { now: at }), true);
  assert.equal(store.finishWeeklyRun(WEEK, { now: at + 1000, success: false }), true);
  close(store);
  const restarted = open();
  assert.equal(restarted.beginWeeklyRun(WEEK, { now: at + 900_999 }), false);
  assert.equal(restarted.beginWeeklyRun(WEEK, { now: at + 901_000 }), true);
  assert.equal(restarted.finishWeeklyRun(WEEK, { now: at + 901_001, success: true }), true);
  assert.equal(restarted.beginWeeklyRun(WEEK, { now: at + 1_800_000 }), false);
});
