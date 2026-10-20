import assert from "node:assert/strict";
import test from "node:test";
import { canonicalMrUrl, extractIssueKeys, parseGitlabMrUrl, prepareMrContext, readMrContext, readMrHeadSha } from "../src/gitlab-context.js";

const mrUrl = "https://gitlab.example.com/group/sub/repo/-/merge_requests/71";
const headSha = "a".repeat(40);
const metadata = (extra = {}) => ({
  author: { username: "dev.one", id: 7 }, sha: headSha, diff_refs: { head_sha: headSha },
  title: "TEAM-12 변경", description: "TEAM-13 작업과 TEAM-12 영향", source_branch: "feat/TEAM-14-api", ...extra,
});
const diff = (path = "src/api.js", oldPath = path) => ({ old_path: oldPath, new_path: path });
const runner = ({ mr = metadata(), pages = [[diff()]], calls = [] } = {}) => (file, args, options) => {
  assert.equal(file, "glab");
  assert.equal(options.shell, false);
  assert.deepEqual(args.slice(-2), ["--hostname", "gitlab.example.com"]);
  calls.push(args);
  const page = args[1].match(/page=(\d+)$/);
  return JSON.stringify(page ? (pages[Number(page[1]) - 1] ?? []) : mr);
};

test("MR 주소는 호스트·그룹을 보존하고 인증정보나 잘못된 경로는 거부한다", () => {
  assert.deepEqual(parseGitlabMrUrl(mrUrl), { host: "gitlab.example.com", project: "group/sub/repo", iid: 71 });
  for (const url of ["file:///repo", mrUrl + "?private_token=hidden", mrUrl + "#fragment", mrUrl.replace("https://", "https://user:password@"), mrUrl.replace("71", "0")]) {
    assert.throws(() => parseGitlabMrUrl(url), /MR 링크/);
  }
});

test("작업 키는 제목·설명·브랜치에서 중복 없이 수집한다", () => {
  assert.deepEqual(extractIssueKeys("TEAM-1 TEAM-1", "NEXT_2-90", null, "foo-3"), ["TEAM-1", "NEXT_2-90"]);
});

test("댓글 링크는 허용하고 맥락 저장에는 fragment 없는 MR 주소를 사용한다", async () => {
  const noteUrl = `${mrUrl}/#note_123`;
  assert.deepEqual(parseGitlabMrUrl(noteUrl), parseGitlabMrUrl(mrUrl));
  assert.equal(canonicalMrUrl(noteUrl), mrUrl);
  const context = await prepareMrContext({
    mrUrl: noteUrl, runImpl: runner(),
    contextService: { prepareReview: async (input) => {
      assert.equal(input.mrUrl, mrUrl);
      return { ...input, status: "fresh" };
    } },
  });
  assert.equal(context.mrUrl, mrUrl);
});

test("전체 diff 페이지와 이름 변경 전후 경로를 수집한다", async () => {
  const calls = [];
  const context = await readMrContext(mrUrl, {
    runImpl: runner({ calls, mr: metadata({ changes_count: "101" }), pages: [Array.from({ length: 100 }, (_, i) => diff(`src/${i}.js`)), [diff("new/name.js", "old/name.js")]] }),
  });
  assert.deepEqual(context.author, { username: "dev.one", id: 7 });
  assert.deepEqual(context.issueKeys, ["TEAM-12", "TEAM-13", "TEAM-14"]);
  assert.equal(context.changedPaths.length, 102);
  assert.ok(context.changedPaths.includes("old/name.js"));
  assert.ok(context.changedPaths.includes("new/name.js"));
  assert.equal(context.headSha, headSha);
  assert.equal(context.mrSource.description, metadata().description);
  assert.equal(context.mrSource.descriptionTruncated, false);
  assert.match(calls[0][1], /^projects\/group%2Fsub%2Frepo\/merge_requests\/71$/);
  assert.equal(calls.length, 3);
});

test("추가 Jira 키는 MR 양식을 바꾸지 않고 연결하며 긴 설명은 생략 여부를 표시한다", async () => {
  const result = await prepareMrContext({
    mrUrl, issueKeys: ["TEAM-99", "TEAM-12"],
    runImpl: runner({ mr: metadata({ description: "x".repeat(16_001) }) }),
    contextService: { prepareReview: async (input) => ({ ...input, status: "fresh" }) },
  });
  assert.deepEqual(result.issueKeys, ["TEAM-99", "TEAM-12"]);
  assert.deepEqual(result.inferredIssueKeys, ["TEAM-12", "TEAM-14"]);
  assert.equal(result.mrSource.description.length, 16_000);
  assert.equal(result.mrSource.descriptionTruncated, true);
});

test("SHA-256 저장소의 커밋도 허용한다", async () => {
  const sha = "b".repeat(64);
  assert.equal(await readMrHeadSha(mrUrl, { runImpl: runner({ mr: metadata({ sha, diff_refs: { head_sha: sha } }) }) }), sha);
});

test("조회 실패 원문의 토큰은 오류에 포함하지 않는다", async () => {
  await assert.rejects(readMrContext(mrUrl, { runImpl: () => { throw new Error("PRIVATE_TOKEN=hidden-secret"); } }), (error) => {
    assert.match(error.message, /로그인과 접근 권한/);
    assert.doesNotMatch(error.message, /hidden-secret/);
    return true;
  });
});

test("불명확한 작성자·커밋·일부 파일 목록으로 리뷰하지 않는다", async () => {
  for (const mr of [metadata({ author: {} }), metadata({ sha: "bad", diff_refs: {} }), metadata({ sha: "b".repeat(40) }), metadata({ changes_count: "2" }), metadata({ changes_count: "1+" })]) {
    await assert.rejects(readMrContext(mrUrl, { runImpl: runner({ mr }) }));
  }
  await assert.rejects(readMrContext(mrUrl, { runImpl: runner({ pages: [[diff("../outside")]] }) }), /파일 경로/);
});

test("준비 도구는 실제 MR 정보로 최신화한 팀 맥락만 반환한다", async () => {
  let prepared;
  const result = await prepareMrContext({
    mrUrl, runImpl: runner(), contextService: { async prepareReview(input) {
      prepared = input;
      return { ...input, status: "fresh", contextVersion: "f".repeat(64) };
    } },
  });
  assert.equal(result.status, "fresh");
  assert.deepEqual(prepared.changedPaths, ["src/api.js"]);
  assert.equal(prepared.author.id, 7);
});

test("팀 맥락 최신화 실패나 준비 중 새 커밋은 준비 성공으로 보고하지 않는다", async () => {
  await assert.rejects(prepareMrContext({ mrUrl, runImpl: runner(), contextService: { prepareReview: async () => { throw new Error("Jira unavailable"); } } }), /Jira unavailable/);
  await assert.rejects(prepareMrContext({ mrUrl, runImpl: runner(), contextService: { prepareReview: async (input) => ({ ...input, status: "stale" }) } }), /최신 작업 맥락/);
  let reads = 0;
  await assert.rejects(prepareMrContext({
    mrUrl, runImpl: (file, args, options) => {
      if (!args[1].includes("/diffs")) reads += 1;
      return runner({ mr: reads > 1 ? metadata({ sha: "b".repeat(40), diff_refs: {} }) : metadata() })(file, args, options);
    }, contextService: { prepareReview: async (input) => ({ ...input, status: "fresh" }) },
  }), /새 커밋/);
});
