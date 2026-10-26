import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeamContextService } from "../src/team-context.js";
import { GitlabReviewClient } from "../src/review-gitlab.js";
import { reviewerCommentPolicy, reviewCommentTopics } from "../src/reviewer-comments.js";
import { syncReviewComments } from "../src/review-comment-sync.js";

const stamp = "2026-10-26T01:00:00.000Z", sha = "a".repeat(40);
const source = (notes, extra = {}) => ({ projectId: 10, mrIid: 1, mrUrl: "https://gitlab.example.com/team/repo/-/merge_requests/1",
  headSha: sha, notesObservedAt: stamp, notesComplete: true, author: { id: 1, username: "author" }, notes, ...extra });
const note = (id, authorId = 2, username = "reviewer", body = "API 응답의 빈 결과 처리와 회귀 테스트를 추가해 주세요.") => ({ id,
  author: { id: authorId, username }, body, createdAt: stamp, updatedAt: stamp });

function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), "reviewer-comments-"));
  const context = new TeamContextService({ dataDir });
  t.after(() => { context.store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  writeFileSync(join(dataDir, "reviewer-comments-policy.json"), JSON.stringify({ schemaVersion: 1, enabled: true, excludedUserIds: [3], excludedUsernames: ["excluded"] }));
  for (const [id, username] of [[1, "author"], [2, "reviewer"], [3, "excluded"]]) {
    context.upsertMember({ id: username, displayName: username, gitlabUserId: id, gitlabUsername: username,
      jiraAccountId: `fixture:${id}`, areas: ["영역"], paths: ["src"], reviewFocus: ["수동 등록 관점"] });
  }
  return { context, dataDir };
}

test("실제 작성자 ID로 분리하고 본인·시스템·봇·단순 호출·인용·자기 설명을 제외한다", (t) => {
  const { context, dataDir } = fixture(t);
  context.captureReviewComments(source([note(1), note(2, 3, "renamed"), note(3, 1, "author"),
    { ...note(4), system: true }, { ...note(5), author: { id: 2, username: "reviewer", bot: true } },
    note(6, 2, "reviewer", "API 테스트 완료 <!-- reviewbot:abc -->"), note(7, 2, "reviewer", "@author 리뷰 부탁드립니다."),
    note(8, 2, "reviewer", "> API 오류와 테스트를 추가해야 한다는 원문 인용입니다."),
    note(9, 999, "reviewer"), note(10, 2, "reviewer", "API 요청 token=glpat-abcdef123456 출력에 유의해서 검증해 주세요.") ]));
  const value = context.memberContext({ memberId: "reviewer" }).reviewerObservations;
  assert.equal(value.commentCount, 2);
  assert.ok(value.topics.some((item) => item.topic === "API·데이터 계약"));
  assert.match(value.examples[0].url, /#note_1$/);
  assert.doesNotMatch(JSON.stringify(value), /glpat-abcdef/);
  assert.equal(context.memberContext({ memberId: "excluded" }).reviewerObservations, null);
  assert.deepEqual(context.listMembers().find((item) => item.id === "reviewer").reviewFocus, ["수동 등록 관점"]);
  assert.match(readFileSync(join(dataDir, "people/reviewer/review-comments.md"), "utf8"), /#note_1/);
});

test("중복 집계하지 않고 수정·삭제 댓글을 교체하며 오래된 수집으로 되돌리지 않는다", (t) => {
  const { context } = fixture(t);
  const initial = source([note(1)]);
  context.captureReviewComments(initial);
  context.captureReviewComments(initial);
  assert.equal(context.memberContext({ memberId: "reviewer" }).reviewerObservations.commentCount, 1);
  context.captureReviewComments(source([note(1, 2, "reviewer", "배포 컨테이너의 백업과 복구 절차를 확인해 주세요.")], { notesObservedAt: "2026-10-26T02:00:00Z" }));
  assert.equal(context.memberContext({ memberId: "reviewer" }).reviewerObservations.topics.length, 1);
  assert.equal(context.captureReviewComments(initial).status, "stale_ignored");
  context.captureReviewComments(source([], { notesObservedAt: "2026-10-26T03:00:00Z" }));
  assert.equal(context.memberContext({ memberId: "reviewer" }).reviewerObservations.commentCount, 0);
  assert.throws(() => context.captureReviewComments({ ...initial, notesComplete: false }));
});

test("호출된 MR만 동기화하고 오류 시 이전 자료를 보존하며 게시·재시도를 호출하지 않는다", async (t) => {
  const { context } = fixture(t);
  let reads = 0;
  const inbox = { commentSyncTargets() { return { targets: [{ projectId: 10, mrIid: 1 }, { projectId: 10, mrIid: 2 }], total: 2, nextOffset: null }; } };
  const gitlab = { async readComments(target) { reads += 1; if (target.mrIid === 2) throw new Error("private token"); return source([note(1)]); } };
  const result = await syncReviewComments({ inbox, contextService: context, gitlab });
  assert.equal(result.status, "partial"); assert.equal(reads, 2);
  assert.equal(context.memberContext({ memberId: "reviewer" }).reviewerObservations.commentCount, 1);
  assert.doesNotMatch(JSON.stringify(result), /private token/);
});

test("댓글 전용 조회는 닫힌 MR·페이지 전체·코드 위치 댓글을 읽고 부분 자료를 저장하지 않는다", async () => {
  const calls = [];
  const gitlab = new GitlabReviewClient({ host: "gitlab.example.com", allowedProjectIds: [10], runImpl: async (file, args) => {
    calls.push(args[1]);
    if (!args[1].includes("/notes?")) return JSON.stringify({ project_id: 10, iid: 1, web_url: source([]).mrUrl,
      sha, author: { id: 1, username: "author" }, state: "merged" });
    const page = new URL(`https://unused/${args[1]}`).searchParams.get("page");
    return JSON.stringify(page === "1" ? Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: "API 응답의 빈 값 처리를 검증해야 합니다.", type: "DiffNote", author: { id: 2, username: "reviewer" }, updated_at: stamp })) : []);
  } });
  const result = await gitlab.readComments({ projectId: 10, mrIid: 1 });
  assert.equal(result.notesComplete, true); assert.equal(result.notes.length, 100);
  assert.equal(result.notes[0].updatedAt, stamp); assert.equal(calls.length, 3);
  assert.ok(calls.every((value) => !value.includes("/diffs")));
});

test("정책이 없으면 비활성이고 잘못된 제외 정책은 조용히 전체 수집으로 바뀌지 않는다", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "reviewer-policy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(reviewerCommentPolicy(dir).enabled, false);
  writeFileSync(join(dir, "reviewer-comments-policy.json"), JSON.stringify({ schemaVersion: 1, enabled: true, excludedUserIds: ["3"], excludedUsernames: [] }));
  assert.throws(() => reviewerCommentPolicy(dir));
  assert.deepEqual(reviewCommentTopics("감사합니다. 수고하셨습니다!"), []);
});

test("다음 리뷰의 개인별 관점과 저장 Markdown에 근거를 전달하고 다른 프로젝트·제외 계정은 섞지 않는다", async (t) => {
  const { context } = fixture(t);
  context.captureReviewComments(source([note(1)]));
  context.jira = { configured: true, async getMemberIssues() { return { complete: true, fetchedAt: stamp, issues: [] }; } };
  const bundle = await context.prepareReview({ mrUrl: source([]).mrUrl, headSha: sha, author: { id: 1, username: "author" }, changedPaths: ["src/api.js"] });
  const reviewer = bundle.perspectives.find((view) => view.memberId === "reviewer");
  assert.equal(reviewer.reviewerObservations.commentCount, 1);
  assert.equal(bundle.perspectives.find((view) => view.memberId === "excluded").reviewerObservations, null);
  assert.match(bundle.reviewInstructions, /댓글 문구·등급·보류 판단을 그대로 모방하지/);
  assert.equal(context.reviewerObservations(context.listMembers().find((person) => person.id === "reviewer"), "https://gitlab.example.com/other/repo/-/merge_requests/3").commentCount, 0);
  assert.match(readFileSync(bundle.path, "utf8"), /#note_1/);
});
