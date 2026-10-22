import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { GitlabReviewClient, reviewCommentMarker } from "../src/review-gitlab.js";

const host = "gitlab.example.com";
const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const input = { projectId: 12, mrIid: 7, expectedHeadSha: headSha };
const mrUrl = `https://${host}/team/project/-/merge_requests/7`;
const mr = (extra = {}) => ({ project_id: 12, iid: 7, web_url: mrUrl, state: "opened", draft: false,
  author: { id: 8, username: "dev.one" }, sha: headSha,
  diff_refs: { head_sha: headSha, base_sha: baseSha, start_sha: "c".repeat(40) },
  title: "TEAM-7 implementation", description: "Decided TEAM-8 for compatibility.", source_branch: "feat/TEAM-9-api",
  changes_count: "1", ...extra });
const diff = (extra = {}) => ({ old_path: "src/api.js", new_path: "src/api.js", diff: "@@ -1 +1 @@\n-old\n+new\n",
  a_mode: "100644", b_mode: "100644", new_file: false, deleted_file: false, renamed_file: false,
  collapsed: false, too_large: false, ...extra });

function fixture({ metadata = mr(), diffs = [diff()], notes = [], contents, afterPost, intercept } = {}) {
  const calls = [];
  let reads = 0;
  const runImpl = async (file, args, options) => {
    assert.equal(file, "glab");
    assert.equal(options.shell, false);
    assert.equal(args[args.indexOf("--hostname") + 1], host);
    const endpoint = args[1];
    const method = args[args.indexOf("--method") + 1];
    calls.push({ endpoint, method, options });
    const override = await intercept?.({ endpoint, method, options, calls });
    if (override !== undefined) return JSON.stringify(override);
    if (endpoint === "user") return JSON.stringify({ id: 90, username: "review.account" });
    if (endpoint === "projects/12/merge_requests/7") {
      reads += 1;
      return JSON.stringify(typeof metadata === "function" ? metadata(reads) : metadata);
    }
    if (endpoint.includes("/diffs?")) {
      const page = Number(new URL(`https://unused/${endpoint}`).searchParams.get("page"));
      return JSON.stringify(diffs.slice((page - 1) * 100, page * 100));
    }
    if (endpoint.includes("/notes?") && method === "GET") {
      const page = Number(new URL(`https://unused/${endpoint}`).searchParams.get("page"));
      return JSON.stringify(notes.slice((page - 1) * 100, page * 100));
    }
    if (endpoint.endsWith("/notes") && method === "POST") {
      assert.deepEqual(args.slice(-2), ["--input", "-"]);
      const body = JSON.parse(options.input).body;
      const note = { id: 1000 + notes.length, body, author: { id: 90, username: "review.account" }, system: false };
      notes.push(note);
      await afterPost?.(note);
      return JSON.stringify(note);
    }
    if (endpoint.includes("/repository/files/")) {
      const url = new URL(`https://unused/${endpoint}`);
      const filePath = decodeURIComponent(url.pathname.split("/repository/files/")[1]);
      const ref = url.searchParams.get("ref");
      const content = Buffer.from(contents?.({ filePath, ref }) ?? (ref === headSha ? "new\n" : "old\n"));
      return JSON.stringify({ file_path: filePath, encoding: "base64", content: content.toString("base64"),
        size: content.length,
        content_sha256: createHash("sha256").update(content).digest("hex") });
    }
    throw new Error(`Unexpected fixture endpoint: ${endpoint}`);
  };
  return { client: new GitlabReviewClient({ host, allowedProjectIds: [12], runImpl }), calls, notes, runImpl };
}

test("자동 리뷰는 숫자 프로젝트 허용 목록과 안전한 host를 강제한다", async () => {
  for (const invalidHost of ["https://gitlab.example.com", "user:secret@gitlab.example.com", "-example.com", "example.com/path", "example.com?token=secret"]) {
    assert.throws(() => new GitlabReviewClient({ host: invalidHost, allowedProjectIds: [12] }));
  }
  assert.throws(() => new GitlabReviewClient({ host, allowedProjectIds: [] }));
  const { client, calls } = fixture();
  await assert.rejects(client.readReview({ ...input, projectId: 13 }), { code: "project_not_allowed" });
  await assert.rejects(client.readReview({ ...input, mrIid: "7" }), { code: "invalid_input" });
  await assert.rejects(client.file(13, "src/file.js", headSha), { code: "project_not_allowed" });
  assert.equal(calls.length, 0);
});

test("실제 MR 신원·SHA·전체 diff와 변경 전후 파일·설명·댓글을 수집한다", async () => {
  const { client, calls } = fixture({ notes: [
    { id: 1, body: "decided due to retries", author: { id: 8, username: "dev.one" }, created_at: "2026-10-20T00:00:00Z", system: false },
    { id: 2, body: "system event", system: true },
  ] });
  const result = await client.readReview(input);
  assert.equal(result.mrUrl, mrUrl);
  assert.deepEqual(result.author, { id: 8, username: "dev.one" });
  assert.equal(result.headSha, headSha);
  assert.equal(result.baseSha, baseSha);
  assert.equal(result.notes.length, 1);
  assert.equal(result.notes[0].body, "decided due to retries");
  assert.deepEqual(result.issueKeys, ["TEAM-7", "TEAM-8", "TEAM-9"]);
  assert.deepEqual(result.changedPaths, ["src/api.js"]);
  assert.equal(result.files[0].baseContent, "old\n");
  assert.equal(result.files[0].headContent, "new\n");
  assert.equal(result.files[0].oldMode, "100644");
  assert.equal(result.mrSource.descriptionTruncated, false);
  assert.equal(calls.filter((call) => call.endpoint === "projects/12/merge_requests/7").length, 2);
  assert.ok(calls.some((call) => call.endpoint.includes("src%2Fapi.js")));
});

test("이름 변경·새 파일·삭제 파일은 해당 커밋과 정확한 경로만 읽는다", async () => {
  const diffs = [diff({ old_path: "old.js", new_path: "new.js", renamed_file: true }),
    diff({ old_path: "added.js", new_path: "added.js", new_file: true, a_mode: "000000" }),
    diff({ old_path: "deleted.js", new_path: "deleted.js", deleted_file: true, b_mode: "000000" })];
  const { client, calls } = fixture({ metadata: mr({ changes_count: "3" }), diffs });
  const result = await client.readReview(input);
  assert.equal(result.files[1].baseContent, null);
  assert.equal(result.files[2].headContent, null);
  const files = calls.filter((call) => call.endpoint.includes("/repository/files/")).map((call) => call.endpoint);
  assert.equal(files.length, 4);
  assert.ok(files.includes(`projects/12/repository/files/old.js?ref=${baseSha}`));
  assert.ok(files.includes(`projects/12/repository/files/new.js?ref=${headSha}`));
});

test("신규·삭제 파일의 없는 쪽 모드 0을 허용하고 실제 파일만 읽는다", async () => {
  const diffs = [diff({ old_path: "added.js", new_path: "added.js", new_file: true, a_mode: "0" }),
    diff({ old_path: "deleted.js", new_path: "deleted.js", deleted_file: true, b_mode: "0" })];
  const { client, calls } = fixture({ metadata: mr({ changes_count: "2" }), diffs });
  const result = await client.readReview(input);
  assert.equal(result.files[0].oldMode, "0");
  assert.equal(result.files[0].baseContent, null);
  assert.equal(result.files[1].newMode, "0");
  assert.equal(result.files[1].headContent, null);
  const files = calls.filter((call) => call.endpoint.includes("/repository/files/")).map((call) => call.endpoint);
  assert.deepEqual(files, [`projects/12/repository/files/added.js?ref=${headSha}`,
    `projects/12/repository/files/deleted.js?ref=${baseSha}`]);
});

test("모드 0은 없는 쪽에만 허용하고 서브모듈·바이너리 검증을 유지한다", async () => {
  for (const changedFile of [diff({ a_mode: "0" }), diff({ b_mode: "0" }),
    diff({ new_file: true, b_mode: "0" }), diff({ deleted_file: true, a_mode: "0" }),
    diff({ new_file: true, a_mode: null }), diff({ deleted_file: true, b_mode: "" })]) {
    await assert.rejects(fixture({ diffs: [changedFile] }).client.readReview(input), { code: "invalid_gitlab_response" });
  }
  await assert.rejects(fixture({ diffs: [diff({ new_file: true, a_mode: "0", b_mode: "160000" })] })
    .client.readReview(input), { code: "unsupported_content" });
  await assert.rejects(fixture({ diffs: [diff({ new_file: true, a_mode: "0" })], contents: () => Buffer.from([0, 1]) })
    .client.readReview(input), { code: "unsupported_content" });
});

test("diff와 댓글은 다음 페이지까지 빠짐없이 조회한다", async () => {
  const diffs = Array.from({ length: 101 }, (_, index) => diff({ old_path: `src/${index}.js`, new_path: `src/${index}.js` }));
  const notes = Array.from({ length: 101 }, (_, id) => ({ id: id + 1, body: `note ${id}`, author: { id: 8 }, system: false }));
  const { client, calls } = fixture({ metadata: mr({ changes_count: "101" }), diffs, notes });
  const result = await client.readReview(input);
  assert.equal(result.files.length, 101);
  assert.equal(result.notes.length, 101);
  assert.ok(calls.some((call) => call.endpoint.includes("/diffs?per_page=100&page=2")));
  assert.ok(calls.some((call) => call.endpoint.includes("/notes?") && call.endpoint.endsWith("page=2")));
});

test("접힌 diff는 같은 커밋·전체 파일 목록의 원본 diff로 복구하고 일반 요청은 추가 조회하지 않는다", async () => {
  const changedFiles = [diff({ diff: "", collapsed: true }), diff({ old_path: "src/other.js", new_path: "src/other.js" })];
  const metadata = mr({ changes_count: "2" });
  const rawFiles = changedFiles.map((file) => ({ ...file, collapsed: false, diff: diff().diff }));
  const { client, calls } = fixture({ metadata, diffs: changedFiles, intercept: ({ endpoint }) =>
    endpoint.endsWith("/changes?access_raw_diffs=true") ? { ...metadata, overflow: false, changes: rawFiles } : undefined });
  const result = await client.readReview(input);
  assert.equal(result.files.length, 2);
  assert.equal(result.files[0].diff, diff().diff);
  assert.equal(calls.filter((call) => call.endpoint.endsWith("/changes?access_raw_diffs=true")).length, 1);
  const ordinary = fixture();
  await ordinary.client.readReview(input);
  assert.equal(ordinary.calls.some((call) => call.endpoint.includes("/changes?")), false);
});

test("원본 diff의 불완전·초과·다른 커밋·파일·모드·수집 중 변경은 복구 성공으로 처리하지 않는다", async () => {
  const original = diff({ collapsed: true, diff: "" });
  const raw = () => ({ ...mr(), overflow: false, changes: [diff()] });
  for (const mutate of [
    (r) => { r.overflow = true; }, (r) => { delete r.overflow; },
    (r) => { r.project_id = 13; }, (r) => { r.iid = 8; },
    (r) => { r.sha = "d".repeat(40); r.diff_refs.head_sha = r.sha; },
    (r) => { r.diff_refs.base_sha = "d".repeat(40); }, (r) => { r.diff_refs.start_sha = "d".repeat(40); },
    (r) => { r.changes = []; }, (r) => { r.changes = null; },
    (r) => { r.changes[0].new_path = "src/unknown.js"; }, (r) => { r.changes[0].b_mode = "100755"; },
    (r) => { r.changes[0].new_file = true; }, (r) => { r.changes[0].collapsed = true; },
    (r) => { r.changes[0].too_large = true; }, (r) => { r.changes[0].diff = ""; },
    (r) => { r.changes[0].diff = null; },
  ]) {
    const response = raw(); mutate(response);
    await assert.rejects(fixture({ diffs: [original], intercept: ({ endpoint }) =>
      endpoint.endsWith("/changes?access_raw_diffs=true") ? response : undefined }).client.readReview(input));
  }
  const duplicate = fixture({ metadata: mr({ changes_count: "2" }), diffs: [original, diff({ new_path: "src/other.js" })],
    intercept: ({ endpoint }) => endpoint.endsWith("/changes?access_raw_diffs=true")
      ? { ...mr(), overflow: false, changes: [diff(), diff()] } : undefined });
  await assert.rejects(duplicate.client.readReview(input), { code: "incomplete_context" });
  const changed = fixture({ diffs: [original], metadata: (reads) => reads > 1 ? mr({ state: "merged" }) : mr(),
    intercept: ({ endpoint }) => endpoint.endsWith("/changes?access_raw_diffs=true") ? raw() : undefined });
  await assert.rejects(changed.client.readReview(input), { code: "review_not_open" });
  const large = fixture({ diffs: [original], intercept: ({ endpoint }) => endpoint.endsWith("/changes?access_raw_diffs=true")
    ? { ...raw(), changes: [diff({ diff: "x".repeat(2000) })] } : undefined });
  await assert.rejects(new GitlabReviewClient({ host, allowedProjectIds: [12], runImpl: large.runImpl, maxContextBytes: 1024 })
    .readReview(input), { code: "context_too_large" });
});

test("서버가 일부 diff만 주거나 경로·인코딩·내용이 불완전하면 리뷰를 중단한다", async () => {
  for (const setting of [
    { metadata: mr({ changes_count: "2" }) }, { metadata: mr({ changes_count: "1+" }) },
    { diffs: [diff({ too_large: true })] }, { diffs: [diff({ collapsed: true })] },
    { diffs: [diff({ diff: "" })] }, { diffs: [diff({ diff: "", renamed_file: true, new_path: "renamed.js" })] },
    { diffs: [diff({ old_path: "../secret" })] },
    { diffs: [diff({ a_mode: "160000" })] }, { diffs: [diff({ new_file: "false" })] },
    { contents: () => Buffer.from([0, 1, 2]) }, { contents: () => Buffer.from([0xff, 0xfe]) },
    { metadata: mr({ changes_count: "2" }), diffs: [diff(), diff()] },
  ]) {
    await assert.rejects(fixture(setting).client.readReview(input));
  }
  await assert.rejects(fixture({ intercept: ({ endpoint }) => endpoint.includes("/repository/files/")
    ? { file_path: "src/api.js", encoding: "base64", content: "!!!!" } : undefined }).client.readReview(input));
});

test("전체 자료 또는 단일 파일이 한도를 넘으면 잘라서 성공하지 않는다", async () => {
  const settings = [
    { metadata: mr({ description: "x".repeat(2000) }) },
    { contents: () => "x".repeat(2000) },
    { notes: [{ id: 1, body: "x".repeat(2000) }] },
  ];
  for (const setting of settings) {
    const fake = fixture(setting);
    const client = new GitlabReviewClient({ host, allowedProjectIds: [12], runImpl: fake.runImpl, maxContextBytes: 1024 });
    await assert.rejects(client.readReview(input), { code: "context_too_large" });
  }
});

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=", "base64");
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
const imageDiff = (name, extra = {}) => diff({ old_path: name, new_path: name, diff: "", ...extra });
const digest = (content) => createHash("sha256").update(content).digest("hex");

test("코드와 JPEG·PNG가 섞인 MR은 이미지 원문 없이 변경 범위와 식별 메타데이터를 보존한다", async () => {
  const diffs = [imageDiff("docs/screen.JPG", { new_file: true, a_mode: "0" }), diff(),
    imageDiff("docs/old.png", { new_path: "docs/new.png", renamed_file: true })];
  const { client } = fixture({ metadata: mr({ changes_count: "3" }), diffs,
    contents: ({ filePath, ref }) => filePath.endsWith(".JPG") ? jpeg : filePath.endsWith(".png") ? png : ref === headSha ? "new\n" : "old\n" });
  const result = await client.readReview(input);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].newPath, "src/api.js");
  assert.deepEqual(result.changedPaths, ["docs/screen.JPG", "src/api.js", "docs/old.png", "docs/new.png"]);
  assert.deepEqual(result.excludedImages, [
    { oldPath: "docs/screen.JPG", newPath: "docs/screen.JPG", newFile: true, deletedFile: false, renamedFile: false,
      oldMode: "0", newMode: "100644", reason: "image_content_not_reviewed", base: null,
      head: { size: jpeg.length, sha256: digest(jpeg), format: "jpeg" } },
    { oldPath: "docs/old.png", newPath: "docs/new.png", newFile: false, deletedFile: false, renamedFile: true,
      oldMode: "100644", newMode: "100644", reason: "image_content_not_reviewed",
      base: { size: png.length, sha256: digest(png), format: "png" }, head: { size: png.length, sha256: digest(png), format: "png" } },
  ]);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(png.toString("base64")));
  assert.equal(result.excludedImages[0].diff, undefined);
});

test("삭제·이름 변경한 이미지와 GIF·WebP·ICO는 각 커밋의 메타데이터만 남긴다", async () => {
  const gif = Buffer.from([71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 0, 0, 0]);
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([12, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(4)]);
  const ico = Buffer.alloc(22); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4);
  const images = { "before.jpeg": jpeg, "after.jpg": jpeg, "old.gif": gif, "current.webp": webp, "icon.ico": ico };
  const diffs = [diff(), imageDiff("before.jpeg", { new_path: "after.jpg", renamed_file: true }),
    imageDiff("old.gif", { deleted_file: true, b_mode: "0" }),
    imageDiff("current.webp", { new_file: true, a_mode: "000000" }), imageDiff("icon.ico")];
  const { client, calls } = fixture({ metadata: mr({ changes_count: "5" }), diffs,
    contents: ({ filePath, ref }) => images[filePath] ?? (ref === headSha ? "new\n" : "old\n") });
  const result = await client.readReview(input);
  assert.deepEqual(result.excludedImages.map((image) => image.head?.format ?? image.base.format), ["jpeg", "gif", "webp", "ico"]);
  assert.equal(result.excludedImages[1].head, null);
  assert.equal(result.excludedImages[2].base, null);
  assert.ok(calls.some((call) => call.endpoint.endsWith(`before.jpeg?ref=${baseSha}`)));
  assert.ok(calls.some((call) => call.endpoint.endsWith(`after.jpg?ref=${headSha}`)));
  assert.ok(!calls.some((call) => call.endpoint.endsWith(`old.gif?ref=${headSha}`)));
});

test("SVG와 이미지 확장자의 UTF-8 텍스트는 일반 텍스트로 빠짐없이 리뷰한다", async () => {
  const { client } = fixture({ metadata: mr({ changes_count: "2" }),
    diffs: [diff({ old_path: "icon.svg", new_path: "icon.svg" }), diff({ old_path: "source.png", new_path: "source.png" })],
    contents: ({ filePath, ref }) => filePath.endsWith(".svg") ? `<svg>${ref}</svg>` : `export const value = '${ref}';` });
  const result = await client.readReview(input);
  assert.equal(result.files.length, 2);
  assert.deepEqual(result.excludedImages, []);
  assert.match(result.files[0].headContent, /<svg>/);
  assert.match(result.files[1].headContent, /export const/);
});

test("GitLab이 UTF-8로 변환한 텍스트는 원본 크기와 달라도 기존처럼 전체 내용을 리뷰한다", async () => {
  const { client } = fixture({ intercept: ({ endpoint }) => {
    if (!endpoint.includes("/repository/files/")) return undefined;
    const content = Buffer.from(endpoint.endsWith(`ref=${headSha}`) ? "é" : "e", "utf8");
    return { file_path: "src/api.js", encoding: "base64", content: content.toString("base64"),
      size: 1, content_sha256: digest(content) };
  } });
  const result = await client.readReview(input);
  assert.equal(result.files[0].baseContent, "e");
  assert.equal(result.files[0].headContent, "é");
  assert.deepEqual(result.excludedImages, []);
});

test("확장자만 이미지인 바이너리·잘못된 이미지 형식·이미지로 위장한 소스·이미지와 텍스트 전환은 차단한다", async () => {
  for (const setting of [
    { diffs: [diff(), imageDiff("source.png")], contents: ({ filePath }) => filePath === "source.png" ? Buffer.from([0, 1, 2]) : "source" },
    { diffs: [diff(), imageDiff("source.png")], contents: ({ filePath }) => filePath === "source.png" ? jpeg : "source" },
    { diffs: [diff(), imageDiff("source.js")], contents: ({ filePath }) => filePath === "source.js" ? png : "source" },
    { diffs: [diff(), imageDiff("source.zip")], contents: ({ filePath }) => filePath === "source.zip" ? Buffer.from([80, 75, 3, 4, 0]) : "source" },
    { diffs: [diff(), imageDiff("source.jpg")], contents: ({ filePath }) => filePath === "source.jpg" ? Buffer.from([0xff, 0xfe]) : "source" },
    { diffs: [diff(), imageDiff("before.js", { new_path: "after.png", renamed_file: true })], contents: ({ filePath }) => filePath === "after.png" ? png : "source" },
    { diffs: [diff(), imageDiff("before.png", { new_path: "after.js", renamed_file: true })], contents: ({ filePath }) => filePath === "before.png" ? png : "source" },
    { diffs: [diff(), imageDiff("screen.png", { a_mode: "120000", b_mode: "120000" })], contents: ({ filePath }) => filePath === "screen.png" ? png : "source" },
  ]) {
    await assert.rejects(fixture({ metadata: mr({ changes_count: "2" }), ...setting }).client.readReview(input), { code: "unsupported_content" });
  }
});

test("이미지 제외는 전체 diff·크기·checksum·최종 head 검증이나 이미지 전용 MR 중단을 우회하지 않는다", async () => {
  const onlyImage = { diffs: [imageDiff("screen.png", { new_file: true, a_mode: "0" })], contents: () => png };
  await assert.rejects(fixture(onlyImage).client.readReview(input), { code: "no_reviewable_text" });
  await assert.rejects(fixture({ ...onlyImage, metadata: (reads) => reads === 1 ? mr() : mr({ sha: baseSha, diff_refs: { ...mr().diff_refs, head_sha: baseSha } }) })
    .client.readReview(input), { code: "stale_head" });
  await assert.rejects(fixture({ ...onlyImage, diffs: [imageDiff("screen.png", { collapsed: true })],
    intercept: ({ endpoint }) => endpoint.endsWith("/changes?access_raw_diffs=true")
      ? { ...mr(), overflow: false, changes: [imageDiff("screen.png", { collapsed: true })] } : undefined })
    .client.readReview(input), { code: "incomplete_context" });
  for (const invalid of [{ size: png.length + 1 }, { content_sha256: "0".repeat(64) }]) {
    await assert.rejects(fixture({ ...onlyImage, intercept: ({ endpoint }) => endpoint.includes("/repository/files/")
      ? { file_path: "screen.png", encoding: "base64", content: png.toString("base64"), ...invalid } : undefined })
      .client.readReview(input), { code: "invalid_gitlab_response" });
  }
  const oversized = Buffer.concat([png, Buffer.alloc(1024)]);
  const fake = fixture({ ...onlyImage, contents: () => oversized });
  await assert.rejects(new GitlabReviewClient({ host, allowedProjectIds: [12], runImpl: fake.runImpl, maxContextBytes: 1024 })
    .readReview(input), { code: "context_too_large" });
});

test("제외 이미지 바이트는 모델 컨텍스트에 넣지 않고 메타데이터만 집계한다", async () => {
  const content = Buffer.concat([png, Buffer.alloc(15_000)]);
  const diffs = [diff(), imageDiff("one.png", { new_file: true, a_mode: "0" }), imageDiff("two.png", { new_file: true, a_mode: "0" })];
  const fake = fixture({ metadata: mr({ changes_count: "3" }), diffs,
    contents: ({ filePath, ref }) => filePath.endsWith(".png") ? content : ref === headSha ? "new\n" : "old\n" });
  const result = await new GitlabReviewClient({ host, allowedProjectIds: [12], runImpl: fake.runImpl, maxContextBytes: 20_000 }).readReview(input);
  assert.equal(result.excludedImages.length, 2);
  assert.ok(result.contextBytes < 4000);
  assert.ok(JSON.stringify(result).length < 5000);
});

test("다른 MR·host·커밋·닫힘·draft와 수집 중 커밋 변경을 차단한다", async () => {
  for (const metadata of [mr({ project_id: 13 }), mr({ iid: 8 }), mr({ web_url: mrUrl.replace(host, "other.example.com") }),
    mr({ author: {} }), mr({ sha: "invalid" }), mr({ state: "merged" }), mr({ draft: true }), mr({ title: "Draft: pending" })]) {
    await assert.rejects(fixture({ metadata }).client.readReview(input));
  }
  await assert.rejects(fixture().client.readReview({ ...input, expectedHeadSha: "d".repeat(40) }), { code: "stale_head" });
  await assert.rejects(fixture({ metadata: (reads) => reads === 1 ? mr() : mr({ sha: "d".repeat(40), diff_refs: { ...mr().diff_refs, head_sha: "d".repeat(40) } }) }).client.readReview(input), { code: "stale_head" });
});

test("실패한 CLI 원문에 인증정보가 있어도 외부 오류에는 포함하지 않는다", async () => {
  const client = new GitlabReviewClient({ host, allowedProjectIds: [12], runImpl: async () => { throw new Error("PRIVATE_TOKEN=do-not-print"); } });
  await assert.rejects(client.readReview(input), (error) => {
    assert.equal(error.code, "gitlab_request_failed");
    assert.doesNotMatch(error.message, /do-not-print/);
    return true;
  });
});

test("댓글 marker는 같은 host·프로젝트·MR·SHA마다 고정된다", () => {
  const identity = { host, projectId: 12, mrIid: 7, headSha };
  assert.equal(reviewCommentMarker(identity), reviewCommentMarker({ ...identity, headSha: headSha.toUpperCase() }));
  assert.notEqual(reviewCommentMarker(identity), reviewCommentMarker({ ...identity, mrIid: 8 }));
  assert.notEqual(reviewCommentMarker(identity), reviewCommentMarker({ ...identity, headSha: baseSha }));
});

test("첫 댓글은 JSON stdin으로 게시하고 재시도는 같은 인증계정의 marker를 찾아 보존한다", async () => {
  const { client, calls, notes } = fixture();
  let checked = 0;
  const first = await client.ensureComment({ ...input, headSha, body: "## 리뷰 결과: 승인\n\n확인 완료", beforeCreate: async () => { checked += 1; } });
  const second = await client.ensureComment({ ...input, headSha, body: "## 리뷰 결과: 승인\n\n확인 완료", beforeCreate: async () => { checked += 1; } });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.id, second.id);
  assert.equal(first.url, `${mrUrl}#note_${first.id}`);
  assert.equal(first.bodyHash, second.bodyHash);
  assert.equal(checked, 1);
  assert.equal(notes.length, 1);
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
  assert.ok(calls.filter((call) => call.method === "POST").every((call) => !call.endpoint.includes("body=")));
});

test("댓글 작성 응답이 끊겨도 다음 실행은 marker로 기존 게시 결과를 복구한다", async () => {
  let failPost = true;
  const { client, calls, notes } = fixture({ afterPost: async () => {
    if (failPost) { failPost = false; throw new Error("network disconnected with token=hidden"); }
  } });
  await assert.rejects(client.ensureComment({ ...input, headSha, body: "review" }), { code: "gitlab_request_failed" });
  assert.equal(notes.length, 1);
  const receipt = await client.ensureComment({ ...input, headSha, body: "review" });
  assert.equal(receipt.created, false);
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
});

test("이미 게시한 댓글은 MR이 닫히거나 새 커밋으로 바뀌어도 영수증만 복구한다", async () => {
  const marker = reviewCommentMarker({ host, ...input, headSha });
  for (const metadata of [mr({ state: "closed" }), mr({ draft: true }),
    mr({ sha: baseSha, diff_refs: { ...mr().diff_refs, head_sha: baseSha } }), mr({ sha: null, diff_refs: null })]) {
    const { client, calls } = fixture({ metadata, notes: [{ id: 44, body: `review\n\n${marker}`, author: { id: 90 }, system: false }] });
    const receipt = await client.ensureComment({ ...input, headSha, body: "review", beforeCreate: () => assert.fail("must not create") });
    assert.equal(receipt.id, 44);
    assert.equal(receipt.created, false);
    assert.equal(receipt.headSha, headSha);
    assert.equal(calls.filter((call) => call.method === "POST").length, 0);
  }
});

test("타인이 복사한 marker는 게시 영수증으로 인정하지 않는다", async () => {
  const marker = reviewCommentMarker({ host, ...input, headSha });
  const { client, notes } = fixture({ notes: [{ id: 6, body: `review\n\n${marker}`, author: { id: 8 }, system: false }] });
  const receipt = await client.ensureComment({ ...input, headSha, body: "review" });
  assert.equal(receipt.created, true);
  assert.equal(notes.length, 2);
});

test("기존 댓글이 수정됐거나 중복 marker가 있으면 덮어쓰거나 새로 작성하지 않는다", async () => {
  const marker = reviewCommentMarker({ host, ...input, headSha });
  for (const notes of [[{ id: 5, body: `edited review\n\n${marker}`, author: { id: 90 } }],
    [{ id: 5, body: `review\n\n${marker}`, author: { id: 90 } }, { id: 6, body: `review\n\n${marker}`, author: { id: 90 } }]]) {
    const { client, calls } = fixture({ notes });
    await assert.rejects(client.ensureComment({ ...input, headSha, body: "review" }));
    assert.equal(calls.filter((call) => call.method !== "GET").length, 0);
  }
});

test("게시 직전 lease 상실·새 커밋·닫힌 MR이면 쓰기를 실행하지 않는다", async () => {
  const fake = fixture();
  await assert.rejects(fake.client.ensureComment({ ...input, headSha, body: "review", beforeCreate: async () => { throw new Error("lease lost"); } }), /lease lost/);
  assert.equal(fake.calls.filter((call) => call.method === "POST").length, 0);
  for (const metadata of [mr({ state: "closed" }), mr({ draft: true }), mr({ sha: baseSha, diff_refs: { ...mr().diff_refs, head_sha: baseSha } })]) {
    const { client, calls } = fixture({ metadata });
    await assert.rejects(client.ensureComment({ ...input, headSha, body: "review" }));
    assert.equal(calls.filter((call) => call.method === "POST").length, 0);
  }
});

test("리뷰 본문은 GitLab quick action이나 내부 marker를 삽입할 수 없다", async () => {
  for (const body of ["review\n/merge", "review\n  /approve", "review\n\t/assign @someone", "<!-- reviewbot:fake -->", "bad\0body"]) {
    const { client, calls } = fixture();
    await assert.rejects(client.ensureComment({ ...input, headSha, body }));
    assert.equal(calls.length, 0);
  }
});
