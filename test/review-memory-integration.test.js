import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import test from "node:test";
import { prepareMrContext, readMrHeadSha } from "../src/gitlab-context.js";
import { TeamContextService } from "../src/team-context.js";
import { TeamContextStore } from "../src/team-context-store.js";

const HOST = "gitlab.example.test";
const PROJECT = "fixture/repository";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const mrUrl = (iid) => `https://${HOST}/${PROJECT}/-/merge_requests/${iid}`;

function issue(key, accountId = "fixture-account:1") {
  return {
    key, summary: `가상 작업 ${key}`, description: "입력 오류를 호출부에서 판별할 수 있어야 한다.",
    status: { id: "2", name: "Building", category: "indeterminate" },
    assigneeAccountId: accountId, updatedAt: "2026-10-19T00:00:00.000Z", createdAt: "2026-10-10T00:00:00.000Z",
    url: `https://jira.example.test/browse/${key}`, components: ["검증"], inCurrentSprint: true,
    history: [], historyComplete: true, descriptionTruncated: false,
  };
}

function memoryFor(bundle) {
  const code = { kind: "code", ref: `src/auth.js:10 @ ${bundle.headSha}` };
  return {
    implementation: [{ summary: "가상 입력 검증을 공통 함수에서 수행한다.", basis: "observed", evidence: [code] }],
    decisions: [
      { decision: "공통 검증 함수를 사용한다.", reason: null, basis: "observed", evidence: [code] },
      { decision: "캐시 정책의 이유는 확인하지 못했다.", reason: null, basis: "unknown", evidence: [] },
      { decision: "실패를 명시 오류로 반환한다.", reason: "기존 호출부의 오류 판별을 유지한다.", basis: "reported",
        evidence: [{ kind: "mr_description", ref: bundle.mrUrl }] },
    ],
    validations: [
      { check: "가상 단위 테스트 결과 확인", result: "passed", basis: "observed",
        evidence: [{ kind: "test", ref: `fixture-test-run @ ${bundle.headSha}` }] },
      { check: "외부 서비스 연동 테스트", result: "not_run", basis: "unknown", evidence: [] },
    ],
    remainingWork: [{ summary: "입력 경계값에 대한 후속 검토가 남아 있다.", basis: "observed", evidence: [code] }],
  };
}

function fixture(t) {
  const temporaryRoot = realpathSync(tmpdir());
  const dataDir = mkdtempSync(join(temporaryRoot, "review-memory-integration-"));
  const issues = new Map([["TEST-1", issue("TEST-1")], ["TEST-2", issue("TEST-2", "fixture-account:2")]]);
  const mergeRequests = new Map();
  const glabCalls = [];
  const jiraCalls = [];
  let clock = "2026-10-20T00:00:00.000Z";
  const jira = {
    configured: true,
    async getMemberIssues(accountId) {
      jiraCalls.push({ method: "getMemberIssues", accountId });
      return { issues: structuredClone([...issues.values()].filter((value) => value.assigneeAccountId === accountId)),
        complete: true, fetchedAt: clock };
    },
    async getIssue(key) {
      jiraCalls.push({ method: "getIssue", key });
      assert.ok(issues.has(key), "Only fake Jira issues may be read.");
      return structuredClone(issues.get(key));
    },
  };
  const runImpl = async (file, args, options) => {
    assert.equal(file, "glab");
    assert.deepEqual(options, { shell: false });
    assert.equal(args[0], "api");
    assert.deepEqual(args.slice(2), ["--hostname", HOST]);
    const route = new RegExp(`^projects/${encodeURIComponent(PROJECT)}/merge_requests/([1-9]\\d*)(/diffs\\?per_page=100&page=1)?$`).exec(args[1]);
    assert.ok(route, "The fake glab runner permits only MR/diff reads.");
    const mr = mergeRequests.get(Number(route[1]));
    assert.ok(mr, "Only fake merge requests may be read.");
    glabCalls.push(args[1]);
    return JSON.stringify(route[2] ? mr.paths.map((path) => ({ old_path: path, new_path: path })) : {
      author: { id: 1, username: "fixture.1" }, title: mr.title, description: mr.description,
      source_branch: "fixture-review", sha: mr.sha, diff_refs: { head_sha: mr.sha }, changes_count: String(mr.paths.length),
    });
  };
  let service;
  const open = () => {
    service = new TeamContextService({ store: new TeamContextStore({ dataDir }), jiraClient: jira,
      now: () => new Date(clock), readHead: (url) => readMrHeadSha(url, { runImpl }) });
    return service;
  };
  open();
  for (let index = 1; index <= 2; index++) {
    service.upsertMember({ id: `member-${index}`, displayName: `가상 팀원 ${index}`, gitlabUsername: `fixture.${index}`,
      gitlabUserId: index, jiraAccountId: `fixture-account:${index}`, areas: ["검증"], paths: ["src"], reviewFocus: ["오류 계약"] });
  }
  t.after(() => {
    service.close();
    assert.equal(dirname(resolve(dataDir)), temporaryRoot);
    assert.ok(basename(dataDir).startsWith("review-memory-integration-"));
    rmSync(dataDir, { recursive: true, force: true });
  });
  return {
    get service() { return service; }, dataDir, issues, mergeRequests, glabCalls, jiraCalls,
    setClock(value) { clock = value; },
    addMr(iid, { sha = SHA_A, paths = ["src/auth.js"], key = "TEST-1" } = {}) {
      mergeRequests.set(iid, { sha, paths, title: key ? `가상 변경 ${key}` : "가상 변경", description: "가상 리뷰 자료" });
    },
    prepare(iid, issueKeys = []) { return prepareMrContext({ mrUrl: mrUrl(iid), contextService: service, runImpl, issueKeys }); },
    complete(bundle, memory = memoryFor(bundle)) {
      return service.completeReview({ mrUrl: bundle.mrUrl, headSha: bundle.headSha,
        contextVersion: bundle.contextVersion, verdict: "approve", memory });
    },
    restart() { service.close(); open(); },
    readPrivate(path) {
      const suffix = relative(dataDir, path);
      assert.ok(suffix && !isAbsolute(suffix) && !suffix.startsWith(".."));
      return readFileSync(path, "utf8");
    },
  };
}

test("completed review memory survives refresh/restart and is reused by a different MR linked to the same Jira issue", async (t) => {
  const f = fixture(t);
  f.addMr(71);
  const first = await f.prepare(71);
  assert.equal(first.reviewHistory.total, 0);
  const memory = memoryFor(first);
  const saved = await f.complete(first, memory);
  assert.match(saved.id, /^[a-f\d]{64}$/);
  assert.equal(saved.stage, "reviewed");
  assert.equal(saved.authorMemberId, "member-1");
  assert.deepEqual(saved.issueKeys, ["TEST-1"]);
  assert.deepEqual(saved.changedPaths, ["src/auth.js"]);
  assert.deepEqual(saved.memory, memory);
  assert.match(f.readPrivate(saved.path), /unknown은 미확인/);
  const issueIndex = join(f.dataDir, "issues", "TEST-1", "review-history.md");
  assert.ok(f.readPrivate(issueIndex).includes(`history/${saved.id}.md`));

  f.setClock("2026-10-20T00:01:00.000Z");
  const repeated = await f.complete(first, memory);
  assert.equal(repeated.id, saved.id);
  assert.equal(repeated.recordedAt, saved.recordedAt);
  assert.equal(f.service.reviewHistory().total, 1);

  const originalMarkdown = f.readPrivate(saved.path);
  f.issues.get("TEST-1").description = "가상 Jira 설명의 새 완료 조건";
  f.issues.get("TEST-1").updatedAt = "2026-10-20T00:01:00.000Z";
  await f.service.syncMembers();
  assert.equal(f.readPrivate(saved.path), originalMarkdown);
  assert.ok(f.readPrivate(issueIndex).includes(saved.id));
  f.restart();

  // The next MR has no Jira key in its existing text; an explicit link is enough.
  f.addMr(72, { paths: ["src/contracts.js"], key: null });
  const next = await f.prepare(72, ["TEST-1"]);
  assert.deepEqual(next.relatedIssues.map((value) => value.key), ["TEST-1"]);
  assert.equal(next.reviewHistory.total, 1);
  assert.equal(next.reviewHistory.omittedRecordCount, 0);
  assert.equal(next.reviewHistory.records[0].id, saved.id);
  assert.equal(next.reviewHistory.records[0].mrUrl, mrUrl(71));
  assert.equal(next.reviewHistory.records[0].memory.decisions[1].reason, null);
  assert.equal(next.reviewHistory.records[0].memory.decisions[1].basis, "unknown");
  assert.equal(next.reviewHistory.records[0].memory.validations[1].result, "not_run");
  assert.deepEqual(next.reviewHistory.records[0].memory.remainingWork, memory.remainingWork);
  assert.match(f.readPrivate(next.path), /가상 Jira 설명의 새 완료 조건/);
  assert.ok(f.readPrivate(next.path).includes(saved.id));
  assert.match(next.reviewInstructions, /현재 요구·코드/);
  assert.ok(f.jiraCalls.some((call) => call.method === "getIssue" && call.key === "TEST-1"));
  assert.ok(f.glabCalls.every((route) => !route.includes("notes")));
});

test("new SHA appends history while unrelated MR/issues/files stay out and exact changed files match", async (t) => {
  const f = fixture(t);
  f.addMr(71);
  const first = await f.prepare(71);
  const firstRecord = await f.complete(first);
  f.setClock("2026-10-20T00:02:00.000Z");
  f.mergeRequests.get(71).sha = SHA_B;
  const second = await f.prepare(71);
  assert.equal(second.reviewHistory.records[0].id, firstRecord.id);
  const secondRecord = await f.complete(second);
  assert.notEqual(secondRecord.id, firstRecord.id);
  assert.notEqual(secondRecord.path, firstRecord.path);
  assert.equal(f.service.reviewHistory({ mrUrl: mrUrl(71) }).total, 2);
  assert.equal(f.readPrivate(firstRecord.path).includes(SHA_A), true);
  assert.equal(f.readPrivate(secondRecord.path).includes(SHA_B), true);

  f.addMr(73, { paths: ["src/auth-helper.js"], key: "TEST-2" });
  const unrelated = await f.prepare(73);
  assert.equal(unrelated.reviewHistory.total, 0);
  assert.deepEqual(unrelated.reviewHistory.records, []);

  f.addMr(74, { paths: ["src/auth.js"], key: "TEST-2" });
  const sameFile = await f.prepare(74);
  assert.equal(sameFile.reviewHistory.total, 2);
  assert.deepEqual(new Set(sameFile.reviewHistory.records.map((value) => value.id)), new Set([firstRecord.id, secondRecord.id]));

  const otherRepository = { mrUrl: `https://${HOST}/fixture/other/-/merge_requests/74`,
    author: { id: 1, username: "fixture.1" }, headSha: SHA_A, changedPaths: ["src/auth.js"] };
  const unrelatedRepository = await f.service.prepareReview({ ...otherRepository, issueKeys: ["TEST-2"] });
  assert.equal(unrelatedRepository.reviewHistory.total, 0);
  const explicitJiraConnection = await f.service.prepareReview({ ...otherRepository, issueKeys: ["TEST-1"] });
  assert.equal(explicitJiraConnection.reviewHistory.total, 2);

  f.mergeRequests.get(71).title = "가상 변경: Jira 연결 없음";
  f.mergeRequests.get(71).paths = ["other/file.js"];
  const sameMr = await f.prepare(71);
  assert.equal(sameMr.relatedIssues.length, 0);
  assert.equal(sameMr.reviewHistory.total, 2);
  const page = f.service.reviewHistory({ issueKeys: ["TEST-1"], offset: 0, limit: 1 });
  assert.equal(page.total, 2);
  assert.equal(page.nextOffset, 1);
  assert.equal(page.records[0].id, secondRecord.id);
  assert.equal(f.service.reviewHistory({ issueKeys: ["TEST-1"], offset: page.nextOffset, limit: 1 }).records[0].id, firstRecord.id);
});

test("stale SHA, changed context and unsupported claims cannot create completion memory", async (t) => {
  const f = fixture(t);
  f.addMr(71, { key: null });
  const prepared = await f.prepare(71);
  const badReason = memoryFor(prepared);
  badReason.decisions[0].reason = "출처에 없는 이유";
  await assert.rejects(() => f.complete(prepared, badReason), /Invalid review memory/);
  const falseTest = memoryFor(prepared);
  falseTest.validations[0].evidence = [{ kind: "code", ref: "src/auth.js:10" }];
  await assert.rejects(() => f.complete(prepared, falseTest), /Invalid review memory/);
  const missingSection = memoryFor(prepared);
  delete missingSection.remainingWork;
  await assert.rejects(() => f.complete(prepared, missingSection), /Invalid review memory/);
  f.mergeRequests.get(71).sha = SHA_B;
  await assert.rejects(() => f.complete(prepared), /new commits/);
  f.mergeRequests.get(71).sha = SHA_A;
  const oldVersion = prepared.contextVersion;
  f.issues.get("TEST-1").description = "준비 후 변경된 가상 작업 설명";
  f.issues.get("TEST-1").updatedAt = "2026-10-20T00:03:00.000Z";
  const current = await f.prepare(71);
  assert.notEqual(current.contextVersion, oldVersion);
  await assert.rejects(() => f.complete(prepared), /context is missing or changed/);
  assert.equal(f.service.reviewHistory().total, 0);

  const saved = await f.complete(current);
  assert.deepEqual(saved.issueKeys, []);
  assert.equal(saved.memory.decisions[1].reason, null);
  assert.equal(saved.memory.decisions[1].basis, "unknown");
  assert.equal(f.service.reviewHistory({ issueKeys: ["TEST-1"] }).total, 0);
  assert.equal(f.service.reviewHistory({ mrUrl: mrUrl(71) }).total, 1);
});

test("automatic history keeps whole records within its character budget and nextOffset resumes without gaps", async (t) => {
  const f = fixture(t);
  f.addMr(71);
  const prepared = await f.prepare(71);
  const memory = memoryFor(prepared);
  memory.implementation = Array.from({ length: 18 }, (_, index) => ({
    summary: `large-fake-implementation-${index}: `.padEnd(1_900, "x"), basis: "unknown", evidence: [],
  }));
  assert.ok(Buffer.byteLength(JSON.stringify(memory), "utf8") < 64 * 1024);
  for (let index = 1; index <= 4; index++) {
    f.service.store.saveReviewCompletion({ mrUrl: mrUrl(71), headSha: index.toString(16).padStart(40, "0"),
      contextVersion: prepared.contextVersion, authorMemberId: "member-1", issueKeys: ["TEST-1"],
      changedPaths: ["src/auth.js"], verdict: "approve", memory,
      recordedAt: `2026-10-20T00:0${index}:00.000Z`, stage: "reviewed" });
  }
  const next = await f.prepare(71);
  const automatic = next.reviewHistory;
  assert.equal(automatic.total, 4);
  assert.ok(automatic.records.length > 0 && automatic.records.length < automatic.total);
  assert.equal(automatic.omittedRecordCount, automatic.total - automatic.records.length);
  assert.equal(automatic.nextOffset, automatic.records.length);
  assert.ok(automatic.records.reduce((sum, value) => sum + JSON.stringify(value).length, 0) <= 100_000);
  for (const record of automatic.records) {
    assert.deepEqual(record.memory, memory);
    assert.equal(Object.hasOwn(record, "changedPaths"), false);
  }
  assert.ok(next.warnings.some((warning) => warning.includes("100,000")));
  const remainder = f.service.reviewHistory({ mrUrl: mrUrl(71), offset: automatic.nextOffset, limit: 20 });
  assert.equal(remainder.nextOffset, null);
  const all = f.service.reviewHistory({ mrUrl: mrUrl(71), limit: 20 });
  assert.deepEqual([...automatic.records, ...remainder.records].map((value) => value.id), all.records.map((value) => value.id));
  assert.equal(new Set([...automatic.records, ...remainder.records].map((value) => value.id)).size, all.total);
  assert.ok(remainder.records.every((record) => record.changedPaths.includes("src/auth.js")));
});
