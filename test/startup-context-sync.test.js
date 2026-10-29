import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeamContextService } from "../src/team-context.js";
import { GitlabReviewClient } from "../src/review-gitlab.js";
import { StartupContextSync } from "../src/startup-context-sync.js";
import { workerSettings } from "../src/review-worker-config.js";

const sha = "a".repeat(40), url = "https://gitlab.example.test/team/repo/-/merge_requests/1";
const initial = "2026-10-26T01:00:00.000Z";
const note = (id, body = "API 응답의 빈 값 처리와 회귀 테스트를 확인해 주세요.", author = 2) => ({ id, body,
  author: { id: author, username: `user${author}` }, createdAt: initial, updatedAt: initial });
const issue = () => ({ key: "TEAM-1", summary: "작업", description: "이슈 설명", url: "https://jira.example.test/browse/TEAM-1",
  status: { name: "진행", category: "indeterminate" }, assigneeAccountId: "fixture:1", updatedAt: initial,
  createdAt: initial, history: [], historyComplete: true, descriptionTruncated: false });

function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), "startup-context-"));
  let clock = Date.parse(initial), jiraIssue = issue();
  const state = { targets: [1], notes: [note(1), note(2), note(3, "API 검증을 확인해 주세요. 제외할 사용자입니다.", 3)],
    title: "TEAM-1 새 기능", failMr: null, failJira: false, pause: null, reads: 0, jiraReads: 0 };
  const now = () => new Date(clock);
  const jira = { configured: true, async getMemberIssues() { state.jiraReads++; if (state.failJira) throw new Error("private-token");
    return { complete: true, fetchedAt: now().toISOString(), issues: [jiraIssue] }; }, async getIssue() { return jiraIssue; } };
  const context = new TeamContextService({ dataDir, jiraClient: jira, now });
  writeFileSync(join(dataDir, "reviewer-comments-policy.json"), JSON.stringify({ schemaVersion: 1, enabled: true, excludedUserIds: [3], excludedUsernames: [] }));
  for (const id of [1, 2, 3]) context.upsertMember({ id: `user${id}`, displayName: `User ${id}`, gitlabUserId: id,
    gitlabUsername: `user${id}`, jiraAccountId: `fixture:${id}`, areas: ["API"], paths: ["src"], reviewFocus: ["계약"] });
  const gitlab = { host: "gitlab.example.test", allowedProjectIds: new Set([10]),
    async listProjectMrs() { return state.targets.map((mrIid) => ({ projectId: 10, mrIid })); },
    async readComments({ mrIid }) { state.reads++; await state.pause?.(); if (state.failMr === mrIid) throw Object.assign(new Error("secret"), { code: "gitlab_request_failed" });
      return { projectId: 10, mrIid, mrUrl: url.replace(/1$/, String(mrIid)), headSha: mrIid === 2 ? null : sha,
        state: mrIid === 2 ? "closed" : "opened", author: { id: 1, username: "user1" }, title: state.title,
        description: "TEAM-1 구현 설명", sourceBranch: "feature/TEAM-1", targetBranch: "main", createdAt: initial,
        updatedAt: initial, notesObservedAt: now().toISOString(), notesComplete: true, notes: mrIid === 2 ? [] : state.notes }; } };
  const syncs = [];
  const make = (onReady = () => {}) => { const sync = new StartupContextSync({ contextService: context, gitlab, projectIds: [10], now, onReady }); syncs.push(sync); return sync; };
  t.after(async () => { for (const sync of syncs) await sync.stop(); context.close(); rmSync(dataDir, { recursive: true, force: true }); });
  return { dataDir, state, context, gitlab, make, now, advance(ms = 86_400_000) { clock += ms; },
    changeJira() { jiraIssue = { ...jiraIssue, description: "변경된 완료 조건", updatedAt: now().toISOString(), history: [{ field: "status", at: now().toISOString(), to: "done" }] }; } };
}

test("재시작 시 MR·댓글·Jira를 복구한 뒤 작업을 허용하고 동일 자료를 중복 기록하지 않는다", async (t) => {
  const f = fixture(t); let ready = 0;
  const first = f.make(() => { ready++; assert.equal(f.context.store.getIssuesForMember("user1")[0].key, "TEAM-1"); });
  await first.runOnce();
  assert.equal(first.status().ready, true); assert.equal(ready, 1);
  assert.equal(first.status().lastSuccessAt, initial);
  assert.equal(first.status().summary.commentsAdded, 2);
  const reads = f.state.reads; await first.runOnce(); assert.equal(f.state.reads, reads);
  f.advance();
  f.state.title = "TEAM-1 갱신"; f.state.notes = [note(1, "API 예외 처리에 대한 테스트를 수정해 주세요."), note(4)]; f.changeJira();
  const restarted = f.make(() => { ready++; }); await restarted.runOnce();
  assert.equal(restarted.status().ready, true); assert.equal(ready, 2);
  assert.equal(restarted.status().summary.since, initial);
  assert.equal(restarted.status().summary.commentsAdded, 1);
  assert.equal(restarted.status().summary.commentsEdited, 1);
  assert.equal(restarted.status().summary.commentsRemoved, 1);
  assert.equal(restarted.status().summary.jiraChangedIssues, 1);
  const project = f.context.store.projectContextForReview(url, ["TEAM-1"]);
  assert.equal(project.total, 1); assert.equal(project.records[0].title, f.state.title);
  assert.equal(project.records[0].noteCount, 2);
  assert.equal(f.context.reviewerObservations(f.context.listMembers().find(m => m.id === "user2")).commentCount, 2);
  const bundle = await f.context.prepareReview({ mrUrl: url, headSha: sha, author: { id: 1, username: "user1" }, changedPaths: ["src/api.js"] });
  assert.equal(bundle.projectActivity.records[0].title, f.state.title);
  assert.match(bundle.reviewInstructions, /다른 MR의 구현 설명이나 댓글을 현재 SHA의 코드·테스트 검증으로 간주하지/);
});

test("일부 MR·Jira 실패는 성공 시각을 유지하고 재시도에서 이미 저장한 자료를 중복하지 않는다", async (t) => {
  const f = fixture(t); await f.make().runOnce(); f.advance();
  f.state.targets = [1, 2]; f.state.failMr = 2;
  const restarted = f.make(); await restarted.runOnce();
  assert.equal(restarted.status().ready, false); assert.equal(restarted.status().lastSuccessAt, initial);
  assert.equal(restarted.status().errorCode, "gitlab_request_failed");
  const reads = f.state.reads; await restarted.runOnce(); assert.equal(f.state.reads, reads);
  f.advance(60_001); f.state.failMr = null; f.state.failJira = true;
  await restarted.runOnce(); assert.equal(restarted.status().lastSuccessAt, initial);
  assert.equal(restarted.status().errorCode, "startup_sync_jira_failed");
  f.advance(60_001); f.state.failJira = false;
  await restarted.runOnce(); assert.equal(restarted.status().ready, true);
  assert.equal(f.context.store.projectContextForReview(url).total, 2);
  assert.equal(f.context.store.reviewCommentSources().find(s=>s.mrIid===1).notes.length, 2);
  assert.doesNotMatch(JSON.stringify(restarted.status()), /private-token|secret/);
});

test("두 프로세스의 동시 복구를 선점으로 막고 만료 후 인계하면 이전 실행은 쓰지 않는다", async (t) => {
  const f = fixture(t); let release, entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const pause = new Promise(resolve => { release = resolve; });
  f.state.pause = async () => { entered(); await pause; };
  const old = f.make(); const running = old.runOnce(); await enteredPromise;
  await f.make().runOnce(); assert.equal(f.state.reads, 1);
  f.advance(120_001); f.state.pause = null;
  const replacement = f.make(); await replacement.runOnce();
  assert.equal(replacement.status().ready, true);
  release(); await running;
  assert.equal(old.status().ready, false);
  assert.equal(f.context.store.projectContextForReview(url).total, 1);
});

test("조회 중 종료하면 성공 checkpoint나 작업 시작을 남기지 않는다", async (t) => {
  const f = fixture(t); let release, entered; let ready = 0;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const pause = new Promise(resolve => { release = resolve; });
  f.state.pause = async () => { entered(); await pause; };
  const sync = f.make(() => { ready++; }); const running = sync.runOnce(); await enteredPromise;
  const stopping = sync.stop(); release(); await stopping; await running;
  assert.equal(ready, 0); assert.equal(sync.status().lastSuccessAt, null);
  assert.equal(f.context.store.projectContextForReview(url).total, 0);
});

test("전체 MR 목록은 모든 상태·페이지를 확인하고 외부 프로젝트·중복 목록을 거부한다", async () => {
  const calls = [];
  const g = new GitlabReviewClient({ host: "gitlab.example.test", allowedProjectIds: [10], runImpl: async (file, args) => {
    calls.push(args[1]); const page = new URL(`https://unused/${args[1]}`).searchParams.get("page");
    return JSON.stringify(page === "1" ? Array.from({ length: 100 }, (_, i) => ({ project_id: 10, iid: i + 1 })) : [{ project_id: 10, iid: 101 }]);
  } });
  const all = await g.listProjectMrs(10); assert.equal(all.length, 101); assert.match(calls[0], /scope=all&state=all/);
  await assert.rejects(g.listProjectMrs(11), { code: "project_not_allowed" });
  const invalid = new GitlabReviewClient({ host: "gitlab.example.test", allowedProjectIds: [10], runImpl: async () => JSON.stringify([{ project_id: 11, iid: 1 }]) });
  await assert.rejects(invalid.listProjectMrs(10), { code: "invalid_gitlab_response" });
});

test("head가 사라진 종료 MR의 댓글은 저장하되 코드 리뷰의 SHA 요구는 유지한다", async (t) => {
  const f = fixture(t);
  const g = new GitlabReviewClient({ host: "gitlab.example.test", allowedProjectIds: [10], runImpl: async (file, args) => JSON.stringify(args[1].includes("/notes?") ? []
    : { project_id: 10, iid: 2, web_url: url.replace(/1$/, "2"), state: "closed", sha: null, diff_refs: null, author: { id: 1, username: "user1" } }) });
  const source = await g.readComments({ projectId: 10, mrIid: 2 });
  assert.equal(source.headSha, null);
  f.context.captureReviewComments(source);
  await assert.rejects(g.readReview({ projectId: 10, mrIid: 2 }), { code: "incomplete_context" });
});

test("복구 활성화는 명시 설정과 GitLab 범위를 요구하고 기존 설치는 동작을 유지한다", () => {
  assert.equal(workerSettings({}).startupSync, false);
  assert.throws(() => workerSettings({ REVIEWBOT_STARTUP_SYNC: "true" }));
  assert.throws(() => workerSettings({ REVIEWBOT_STARTUP_SYNC: "1" }));
  assert.equal(workerSettings({ REVIEWBOT_STARTUP_SYNC: "1", REVIEWBOT_GITLAB_HOST: "gitlab.example.test", REVIEWBOT_GITLAB_PROJECT_IDS: "10" }).startupSync, true);
});

test("Jira 미연결은 대기 사유를 공개하고 복구 성공으로 처리하지 않는다", async (t) => {
  const f = fixture(t); f.context.jira.configured = false;
  const sync = f.make(); await sync.runOnce();
  assert.equal(sync.status().status, "not_configured");
  assert.deepEqual(sync.status().missing, ["jira_connection"]);
  assert.equal(sync.status().lastSuccessAt, null); assert.equal(f.state.reads, 0);
});
