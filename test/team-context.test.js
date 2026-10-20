import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { UserError } from "../src/core.js";
import { TeamContextStore } from "../src/team-context-store.js";
import { TeamContextService, summarizeMember, weeklyMarkdown, weeklyWindow } from "../src/team-context.js";

const MONDAY = "2026-10-19T00:00:00.000Z";
const SHA = "a".repeat(40);

function member(index = 1) {
  return { id: `member-${index}`, displayName: `가상 팀원 ${index}`, gitlabUsername: `fixture-${index}`,
    gitlabUserId: index, jiraAccountId: `fixture-jira-${index}`, areas: [`영역 ${index}`],
    paths: [`component-${index}`], reviewFocus: [`관점 ${index}`] };
}

function issue(key = "DEMO-1", overrides = {}) {
  return { key, summary: `가상 작업 ${key}`, description: "목적과 완료 조건의 가상 원문", status: { id: "1", name: "진행 중", category: "indeterminate" },
    assigneeAccountId: "fixture-jira-1", updatedAt: "2026-10-18T00:00:00.000Z", createdAt: "2026-10-10T00:00:00.000Z",
    url: `https://jira.example.test/browse/${key}`, components: ["example"], inCurrentSprint: true,
    history: [], historyComplete: true, descriptionTruncated: false, ...overrides };
}

function fixture(t, { count = 6, configured = true, now = MONDAY } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "team-service-test-"));
  let current = now;
  const responses = new Map();
  const linked = new Map();
  const failures = new Set();
  const incomplete = new Set();
  const calls = [];
  const issueCalls = [];
  const jira = {
    configured,
    async getMemberIssues(accountId) {
      calls.push(accountId);
      if (failures.has(accountId)) throw new Error("fixture-only private connection detail");
      return { issues: structuredClone(responses.get(accountId) ?? []), complete: !incomplete.has(accountId), fetchedAt: new Date(current).toISOString() };
    },
    async getIssue(key) {
      issueCalls.push(key);
      if (!linked.has(key)) throw new Error("fixture-only missing issue detail");
      return structuredClone(linked.get(key));
    },
  };
  const store = new TeamContextStore({ dataDir: directory });
  const service = new TeamContextService({ store, jiraClient: jira, now: () => new Date(current) });
  for (let index = 1; index <= count; index++) service.upsertMember(member(index));
  t.after(() => {
    service.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, store, service, jira, responses, linked, failures, incomplete, calls, issueCalls, setNow: (value) => { current = value; } };
}

test("weekly due boundary is Monday 09:00 KST and completed dates cover the previous KST week", () => {
  assert.equal(weeklyWindow("2026-10-18T14:59:59.999Z").weekStart, "2026-10-12");
  assert.equal(weeklyWindow("2026-10-18T23:59:59.999Z").weekStart, "2026-10-12");
  assert.deepEqual(weeklyWindow(MONDAY), {
    weekStart: "2026-10-19", completedFrom: "2026-10-11T15:00:00.000Z",
    completedUntil: "2026-10-18T15:00:00.000Z", timezone: "Asia/Seoul",
  });
  assert.equal(weeklyWindow("2026-10-22T04:00:00.000Z").weekStart, "2026-10-19");
});

test("completion belongs to the assignee at completion, with reopened work and uncertain plans kept distinct", () => {
  const done = (at) => ({ at, field: "status", from: "1", to: "2", toCategory: "done" });
  const status = (category) => ({ id: category, name: category, category });
  const issues = [
    issue("DEMO-1", { assigneeAccountId: "fixture-jira-2", status: status("done"), history: [
      done("2026-10-11T15:00:00.000Z"), { at: "2026-10-17T00:00:00.000Z", field: "assignee", from: "fixture-jira-1", to: "fixture-jira-2" },
    ] }),
    issue("DEMO-2", { assigneeAccountId: "fixture-jira-2", status: status("done"), history: [
      { at: "2026-10-12T00:00:00.000Z", field: "assignee", from: "fixture-jira-1", to: "fixture-jira-2" }, done("2026-10-13T00:00:00.000Z"),
    ] }),
    issue("DEMO-3", { history: [done("2026-10-16T00:00:00.000Z"), { at: "2026-10-17T00:00:00.000Z", field: "status", from: "2", to: "1", toCategory: "indeterminate" }] }),
    issue("DEMO-4", { status: status("new"), inCurrentSprint: true }),
    issue("DEMO-5", { status: status("new"), inCurrentSprint: null }),
    issue("DEMO-6", { status: status("new"), inCurrentSprint: false }),
    issue("DEMO-7", { status: status("done") }),
    issue("DEMO-8", { status: status("done"), history: [done("2026-10-18T15:00:00.000Z")] }),
  ];
  const summary = summarizeMember(member(), issues, weeklyWindow(MONDAY), MONDAY);
  assert.deepEqual(summary.completed.map((item) => item.key), ["DEMO-1", "DEMO-3"]);
  assert.equal(summary.completed[1].reopened, true);
  assert.deepEqual(summary.inProgress.map((item) => item.key), ["DEMO-3"]);
  assert.deepEqual(summary.planned.map((item) => item.key), ["DEMO-4"]);
  assert.deepEqual(summary.planUnconfirmed.map((item) => item.key), ["DEMO-5"]);
  assert.deepEqual(summary.completedDateUnknown.map((item) => item.key), ["DEMO-7"]);
  const markdown = weeklyMarkdown(summary);
  assert.match(markdown, /완료 후 재개/);
  assert.match(markdown, /완료: 2026-10-16T00:00:00.000Z/);
  assert.match(markdown, /MR 머지·테스트 성공을 뜻하지 않습니다/);
});

test("refresh failure preserves successful snapshots and stops fresh review preparation", async (t) => {
  const { service, store, responses, failures, setNow } = fixture(t);
  responses.set("fixture-jira-1", [issue()]);
  assert.equal((await service.syncMembers()).status, "fresh");
  const previous = store.getIssuesForMember("member-1");
  setNow("2026-10-20T00:00:00.000Z");
  failures.add("fixture-jira-1");
  responses.set("fixture-jira-1", []);
  const refresh = await service.syncMembers();
  assert.equal(refresh.status, "partial");
  assert.equal(refresh.members[0].code, "JIRA_REFRESH_FAILED");
  assert.deepEqual(store.getIssuesForMember("member-1"), previous);
  assert.equal(store.getSyncState("member-1").lastSuccessAt, MONDAY);
  assert.equal(store.getSyncState("member-1").lastFailureAt, "2026-10-20T00:00:00.000Z");
  await assert.rejects(service.prepareReview({ mrUrl: "https://gitlab.example.test/team/repo/-/merge_requests/1", author: { id: 1 }, headSha: SHA }), /Jira refresh failed/);
  assert.equal(JSON.stringify(refresh).includes("private connection detail"), false);
});

test("an incomplete Jira response cannot replace existing member snapshots or weekly summaries", async (t) => {
  const { service, responses, incomplete, store, setNow } = fixture(t);
  responses.set("fixture-jira-1", [issue()]);
  const saved = await service.refreshWeekly();
  const before = readFileSync(saved.summaries[0].path, "utf8");
  incomplete.add("fixture-jira-1");
  responses.set("fixture-jira-1", []);
  setNow("2026-10-20T00:00:00.000Z");
  await assert.rejects(service.refreshWeekly(), /incomplete/);
  assert.equal(store.getIssuesForMember("member-1").length, 1);
  assert.equal(readFileSync(saved.summaries[0].path, "utf8"), before);
  assert.equal(store.getWeekly("member-1", "2026-10-19").generatedAt, MONDAY);
});

test("review context refreshes six perspectives, prioritizes author and affected areas, and fetches linked issues outside member results", async (t) => {
  const { service, store, responses, linked, calls, issueCalls, setNow } = fixture(t);
  for (let index = 1; index <= 6; index++) {
    responses.set(`fixture-jira-${index}`, [issue(`DEMO-${index}`, { assigneeAccountId: `fixture-jira-${index}` })]);
  }
  linked.set("DEMO-999", issue("DEMO-999", { assigneeAccountId: null, description: "별도 연결 이슈 완료 조건", descriptionTruncated: true }));
  const input = { mrUrl: "https://gitlab.example.test/team/repo/-/merge_requests/42", author: { id: 2, username: "old-username" },
    issueKeys: ["DEMO-999", "DEMO-999"], changedPaths: ["component-3/src/example.js", "component-30/other.js"], headSha: SHA };
  const prepared = await service.prepareReview(input);
  assert.equal(prepared.status, "fresh");
  assert.equal(calls.length, 6);
  assert.deepEqual(issueCalls, ["DEMO-999"]);
  assert.equal(prepared.perspectives.length, 6);
  assert.equal(prepared.perspectives[0].memberId, "member-2");
  assert.equal(prepared.perspectives[0].relevance, "author");
  assert.equal(prepared.perspectives[1].memberId, "member-3");
  assert.equal(prepared.perspectives[1].relevance, "affected");
  assert.deepEqual(prepared.perspectives[1].changedPaths, ["component-3/src/example.js"]);
  assert.equal(prepared.perspectives.filter((view) => view.relevance === "background").length, 4);
  assert.equal(prepared.relatedIssues[0].key, "DEMO-999");
  assert.equal(store.getIssue("DEMO-999").description, "별도 연결 이슈 완료 조건");
  assert.equal(store.getIssuesForMember("member-2").length, 1);
  assert.match(prepared.reviewInstructions, /실제 사용한 Jira키 또는 담당 영역 근거/);
  assert.ok(prepared.warnings.some((warning) => warning.includes("설명")));
  const markdown = readFileSync(prepared.path, "utf8");
  assert.equal(markdown.includes("[object Object]"), false);
  assert.match(markdown, /진행 중/);
  for (let index = 1; index <= 6; index++) assert.match(markdown, new RegExp(`관점 ${index}`));
  assert.match(markdown, /별도 연결 이슈 완료 조건/);
  setNow("2026-10-20T00:00:00.000Z");
  const repeated = await service.prepareReview(input);
  assert.equal(calls.length, 12);
  assert.equal(repeated.contextVersion, prepared.contextVersion);
});

test("review contexts disclose bounded work lists and allow paging through the full member history", async (t) => {
  const { service, responses, linked } = fixture(t);
  for (const [index, count] of [[1, 5], [2, 15], [3, 14]]) {
    responses.set(`fixture-jira-${index}`, Array.from({ length: count }, (_, item) => issue(`DEMO-${index * 100 + item + 1}`, { assigneeAccountId: `fixture-jira-${index}` })));
  }
  linked.set("DEMO-105", responses.get("fixture-jira-1")[4]);
  const result = await service.prepareReview({ mrUrl: "https://gitlab.example.test/team/repo/-/merge_requests/42", author: { id: 2 },
    issueKeys: ["DEMO-105"], changedPaths: ["component-3/src/test.js"], headSha: SHA });
  const author = result.perspectives.find((view) => view.memberId === "member-2");
  const affected = result.perspectives.find((view) => view.memberId === "member-3");
  const background = result.perspectives.find((view) => view.memberId === "member-1");
  assert.equal(author.workItems.length, 12);
  assert.equal(author.omittedIssueCount, 3);
  assert.equal(affected.omittedIssueCount, 2);
  assert.equal(background.workItems.length, 3);
  assert.equal(background.workItems[0].key, "DEMO-105");
  const first = service.memberContext({ memberId: "member-2", limit: 10 });
  const second = service.memberContext({ memberId: "member-2", offset: first.nextOffset, limit: 10 });
  assert.equal(first.total, 15);
  assert.equal(second.issues.length, 5);
  assert.equal(second.nextOffset, null);
  assert.throws(() => service.memberContext({ memberId: "member-2", limit: 101 }), UserError);
});

test("missing issue keys disclose requirement uncertainty and failed linked refresh stops preparation", async (t) => {
  const { service } = fixture(t);
  const input = { mrUrl: "https://gitlab.example.test/team/repo/-/merge_requests/1", author: { id: 1 }, headSha: SHA };
  const result = await service.prepareReview(input);
  assert.match(result.warnings.join(" "), /완료 조건/);
  await assert.rejects(service.prepareReview({ ...input, issueKeys: ["DEMO-404"] }), /linked Jira issue/);
  await assert.rejects(service.prepareReview({ ...input, author: { id: 999, username: "fixture-1" } }), /not mapped/);
});

test("invalid repository paths including Windows absolute paths are rejected before Jira access", async (t) => {
  const { service, calls } = fixture(t);
  const input = { mrUrl: "https://gitlab.example.test/team/repo/-/merge_requests/1", author: { id: 1 }, headSha: SHA };
  for (const path of ["C:/outside", "/outside", "../private", "src\\private", "src//private", "src/./private"]) {
    await assert.rejects(service.prepareReview({ ...input, changedPaths: [path] }), /repository path/);
  }
  assert.equal(calls.length, 0);
});

test("one service cannot update a profile while its own Jira refresh is pending", async (t) => {
  const { service, jira } = fixture(t);
  let release;
  const gate = new Promise((done) => { release = done; });
  const original = jira.getMemberIssues;
  jira.getMemberIssues = async (accountId) => { await gate; return original.call(jira, accountId); };
  const refreshing = service.syncMembers();
  try { assert.throws(() => service.upsertMember({ ...member(), reviewFocus: ["변경된 관점"] }), /in progress/); }
  finally { release(); await refreshing; }
  assert.deepEqual(service.listMembers()[0].reviewFocus, ["관점 1"]);
});

test("a second process changing Jira identity during refresh cannot save the old account's response", async (t) => {
  const { service, jira, directory, store, responses } = fixture(t);
  responses.set("fixture-jira-1", [issue()]);
  let release;
  const gate = new Promise((done) => { release = done; });
  const original = jira.getMemberIssues;
  jira.getMemberIssues = async (accountId) => { if (accountId === "fixture-jira-1") await gate; return original.call(jira, accountId); };
  const pending = service.prepareReview({ mrUrl: "https://gitlab.example.test/team/repo/-/merge_requests/1", author: { id: 1 }, headSha: SHA });
  const foreign = new TeamContextStore({ dataDir: directory });
  try { foreign.putMember({ ...member(), jiraAccountId: "fixture-replacement-account" }); }
  finally { foreign.close(); release(); }
  await assert.rejects(pending, /profiles changed|Jira refresh failed/);
  assert.deepEqual(store.getIssuesForMember("member-1"), []);
  assert.equal(store.getIssue("DEMO-1"), null);
  assert.equal(store.getSyncState("member-1").lastSuccessAt, null);
});

test("a profile change after member sync but during linked-issue fetch stops review preparation", async (t) => {
  const { service, jira, directory, store } = fixture(t);
  let fetched;
  let release;
  const fetching = new Promise((done) => { fetched = done; });
  const gate = new Promise((done) => { release = done; });
  jira.getIssue = async () => { fetched(); await gate; return issue("DEMO-999"); };
  const pending = service.prepareReview({ mrUrl: "https://gitlab.example.test/team/repo/-/merge_requests/1", author: { id: 1 }, issueKeys: ["DEMO-999"], headSha: SHA });
  await fetching;
  const foreign = new TeamContextStore({ dataDir: directory });
  try { foreign.putMember({ ...member(), reviewFocus: ["이전 조회와 다른 관점"] }); }
  finally { foreign.close(); release(); }
  await assert.rejects(pending, /profiles changed/);
  assert.equal(existsSync(join(directory, "reviews")), false);
  assert.equal(store.getIssue("DEMO-999").key, "DEMO-999");
});

test("a late weekly run catches up once and shares duplicate protection across service instances", async (t) => {
  const { service, directory, jira, calls } = fixture(t, { now: "2026-10-22T03:00:00.000Z" });
  const result = await service.runWeeklyIfDue();
  assert.equal(result.status, "fresh");
  assert.equal(result.weekStart, "2026-10-19");
  assert.equal(result.summaries.length, 6);
  assert.equal((await service.runWeeklyIfDue()).status, "already_claimed");
  const reopened = new TeamContextService({ dataDir: directory, jiraClient: jira, now: () => new Date("2026-10-22T03:00:00.000Z") });
  try { assert.equal((await reopened.runWeeklyIfDue()).status, "already_claimed"); }
  finally { reopened.close(); }
  assert.equal(calls.length, 6);
});

test("weekly failure retries only after fifteen minutes and missing setup does no Jira work", async (t) => {
  const { service, failures, setNow, calls } = fixture(t);
  failures.add("fixture-jira-1");
  assert.equal((await service.runWeeklyIfDue()).status, "failed");
  const previous = calls.length;
  failures.clear();
  setNow("2026-10-19T00:14:59.999Z");
  assert.equal((await service.runWeeklyIfDue()).status, "already_claimed");
  assert.equal(calls.length, previous);
  setNow("2026-10-19T00:15:00.000Z");
  assert.equal((await service.runWeeklyIfDue()).status, "fresh");
  const unconfigured = fixture(t, { configured: false });
  assert.equal((await unconfigured.service.runWeeklyIfDue()).status, "not_configured");
  assert.equal(unconfigured.calls.length, 0);
  const empty = fixture(t, { count: 0 });
  assert.equal((await empty.service.runWeeklyIfDue()).status, "not_configured");
  await assert.rejects(empty.service.syncMembers(), UserError);
  await assert.rejects(empty.service.prepareReview({ mrUrl: "https://gitlab.example.test/team/repo/-/merge_requests/1", author: { id: 1 }, headSha: SHA }), UserError);
  await assert.rejects(empty.service.refreshWeekly(), UserError);
  assert.equal(empty.calls.length, 0);
});

for (const count of [1, 3, 7, 10]) {
  test(`review and weekly summaries refresh exactly all ${count} registered members`, async (t) => {
    const { service, store, responses, calls, setNow } = fixture(t, { count });
    for (let index = 1; index <= count; index++) {
      responses.set(`fixture-jira-${index}`, [issue(`DEMO-${index}`, { assigneeAccountId: `fixture-jira-${index}` })]);
    }
    const registered = service.listMembers();
    const expectedIds = registered.map((profile) => profile.id);
    const expectedAccounts = registered.map((profile) => profile.jiraAccountId);
    const prepared = await service.prepareReview({
      mrUrl: "https://gitlab.example.test/team/repo/-/merge_requests/1", author: { id: 1 },
      changedPaths: [`component-${count}/src/check.js`], headSha: SHA,
    });
    assert.equal(prepared.perspectives.length, count);
    assert.deepEqual(prepared.teamMemberIds, expectedIds);
    assert.deepEqual(new Set(prepared.perspectives.map((view) => view.memberId)), new Set(expectedIds));
    assert.deepEqual(calls, expectedAccounts);
    assert.equal(prepared.perspectives[0].memberId, "member-1");
    for (const view of prepared.perspectives) {
      const profile = registered.find((person) => person.id === view.memberId);
      assert.deepEqual(view.reviewFocus, profile.reviewFocus);
      assert.equal(view.workItems.length, 1);
      assert.equal(view.workItems[0].assigneeAccountId, profile.jiraAccountId);
    }
    setNow("2026-10-20T00:00:00.000Z");
    const weekly = await service.runWeeklyIfDue();
    assert.equal(weekly.status, "fresh");
    assert.equal(weekly.summaries.length, count);
    assert.deepEqual(new Set(weekly.summaries.map((summary) => summary.memberId)), new Set(expectedIds));
    assert.deepEqual(calls, [...expectedAccounts, ...expectedAccounts]);
    for (const summary of weekly.summaries) {
      assert.equal(summary.path, join(store.dataDir, "people", summary.memberId, "weeks", "2026-10-19.md"));
      assert.equal(summary.inProgress.length, 1);
      assert.ok(readFileSync(summary.path, "utf8").includes(summary.displayName));
      assert.equal(store.getSyncState(summary.memberId).lastSuccessAt, "2026-10-20T00:00:00.000Z");
    }
    assert.equal((await service.runWeeklyIfDue()).status, "already_claimed");
    assert.equal(calls.length, count * 2);
  });
}

test("adding members after this week's completion creates their summaries on the next scheduled run", async (t) => {
  const { service, store, responses, calls } = fixture(t, { count: 1 });
  responses.set("fixture-jira-1", [issue("DEMO-1")]);
  const initial = await service.runWeeklyIfDue();
  assert.equal(initial.status, "fresh");
  assert.equal(initial.summaries.length, 1);
  assert.equal((await service.runWeeklyIfDue()).status, "already_claimed");
  for (const index of [2, 3]) {
    service.upsertMember(member(index));
    responses.set(`fixture-jira-${index}`, [issue(`DEMO-${index}`, { assigneeAccountId: `fixture-jira-${index}` })]);
  }
  const expanded = await service.runWeeklyIfDue();
  assert.equal(expanded.status, "fresh");
  assert.equal(expanded.summaries.length, 3);
  assert.deepEqual(expanded.summaries.map((summary) => summary.memberId), ["member-1", "member-2", "member-3"]);
  for (const summary of expanded.summaries) {
    assert.ok(existsSync(summary.path));
    assert.equal(store.getWeekly(summary.memberId, "2026-10-19").inProgress.length, 1);
  }
  assert.equal(calls.length, 4);
  assert.equal((await service.runWeeklyIfDue()).status, "already_claimed");
  assert.equal(calls.length, 4);
});

test("the scheduler starts a catch-up run and does not overlap a still-running refresh", async (t) => {
  const { service, jira } = fixture(t);
  let release;
  const gate = new Promise((done) => { release = done; });
  const original = jira.getMemberIssues;
  let calls = 0;
  jira.getMemberIssues = async (accountId) => { calls++; await gate; return original.call(jira, accountId); };
  const stop = service.startWeeklyScheduler({ intervalMs: 5 });
  try {
    await new Promise((done) => setTimeout(done, 25));
    assert.equal(calls, 1);
    release();
    for (let attempt = 0; attempt < 30 && service.syncPromise; attempt++) await new Promise((done) => setTimeout(done, 5));
    assert.equal(calls, 6);
    assert.equal((await service.runWeeklyIfDue()).status, "already_claimed");
  } finally { stop(); release(); }
});
