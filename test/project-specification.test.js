import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { UserError } from "../src/core.js";
import { loadProjectSpecification } from "../src/project-specification.js";
import { TeamContextService } from "../src/team-context.js";
import { TeamContextStore } from "../src/team-context-store.js";

const MR_URL = "https://gitlab.example.test/team/repo/-/merge_requests/1";
const SHA = "a".repeat(40);
const NOW = "2026-10-20T00:00:00.000Z";

function specification() {
  return {
    schemaVersion: 1, project: { host: "gitlab.example.test", path: "team/repo" },
    source: { name: "가상 요구 명세.xlsx", sha256: "b".repeat(64), importedAt: NOW },
    sheets: [{ name: "화면 정의", rows: [{ row: 20, cells: [
      { address: "A20", value: "선택 전에도 작업·모니터링 기본 탭을 제공한다.\n원본의 두 번째 줄" },
      { address: "B20", value: 3 }, { address: "C20", value: true }, { address: "D20", value: null },
      { address: "E20", value: 3, formula: "=1+2" },
      { address: "F20", value: "참조", hyperlink: "https://example.test/specification" },
    ] }] }],
  };
}

function directory(t, beforeCleanup = () => {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "project-specification-test-"));
  t.after(() => {
    beforeCleanup();
    assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()));
    rmSync(dataDir, { recursive: true, force: true });
  });
  return dataDir;
}

function save(dataDir, value = specification()) {
  writeFileSync(join(dataDir, "project-specification.json"), JSON.stringify(value));
  return value;
}

function load(dataDir, mrUrl = MR_URL) { return loadProjectSpecification({ dataDir, mrUrl }); }

function expectInvalid(operation, pattern = /project-specification\.json/) {
  assert.throws(operation, error => error instanceof UserError
    && error.code === "invalid_project_specification" && pattern.test(error.message));
}

test("등록하지 않은 명세는 생략하고 같은 프로젝트의 모든 셀 원문·수식·링크를 보존한다", t => {
  const dataDir = directory(t);
  assert.equal(load(dataDir), null);
  assert.equal(loadProjectSpecification({ mrUrl: MR_URL }), null);
  const original = save(dataDir);
  assert.deepEqual(load(dataDir), original);
  assert.deepEqual(load(dataDir, MR_URL.replace("/1", "/2")), original);
  original.project.host = "GITLAB.EXAMPLE.TEST";
  save(dataDir, original);
  assert.deepEqual(load(dataDir), original);
});

test("호스트·전체 프로젝트 경로가 다르면 명세를 전달하지 않는다", t => {
  const dataDir = directory(t);
  save(dataDir);
  for (const mrUrl of [MR_URL.replace("gitlab.example.test", "other.example.test"),
    MR_URL.replace("team/repo", "other/repo"), MR_URL.replace("team/repo", "team/repository"),
    MR_URL.replace("team/repo", "parent/team/repo")]) assert.equal(load(dataDir, mrUrl), null);
  expectInvalid(() => load(dataDir, "not-an-mr"));
});

test("손상·잘못된 UTF-8·512 KiB 초과 파일은 일부만 사용하지 않고 실패한다", t => {
  const dataDir = directory(t);
  const filename = join(dataDir, "project-specification.json");
  for (const content of ["{", Buffer.from([0xff, 0xfe]), " ".repeat(512 * 1024 + 1)]) {
    writeFileSync(filename, content);
    expectInvalid(() => load(dataDir));
  }
  writeFileSync(filename, JSON.stringify(specification()).replace('"value":3', '"value":1e400'));
  expectInvalid(() => load(dataDir));
});

test("512 KiB 경계까지는 온전한 JSON을 읽고 경계를 넘으면 거부한다", t => {
  const dataDir = directory(t);
  const original = specification();
  const json = JSON.stringify(original);
  const content = json + " ".repeat(512 * 1024 - Buffer.byteLength(json));
  writeFileSync(join(dataDir, "project-specification.json"), content);
  assert.deepEqual(load(dataDir), original);
  writeFileSync(join(dataDir, "project-specification.json"), `${content} `);
  expectInvalid(() => load(dataDir), /exceeds 512 KiB/);
});

test("명세 등록은 일반 파일만 허용하고 디렉터리·링크를 거부한다", t => {
  const dataDir = directory(t);
  const filename = join(dataDir, "project-specification.json");
  mkdirSync(filename);
  expectInvalid(() => load(dataDir), /regular file/);
  rmdirSync(filename);
  const target = join(dataDir, "target");
  mkdirSync(target);
  try { symlinkSync(target, filename, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) return t.skip("This environment cannot create fixture links.");
    throw error;
  }
  expectInvalid(() => load(dataDir), /regular file/);
});

test("필수 타입·프로젝트 주소·원본 파일명·중복 시트·행·셀 좌표를 검증한다", t => {
  const dataDir = directory(t);
  const invalid = [
    value => { value.schemaVersion = 2; },
    value => { value.project.host = "https://gitlab.example.test"; },
    value => { value.project.path = "team/../repo"; },
    value => { value.project.path = "/team/repo"; },
    value => { value.source.name = "C:\\private\\spec.xlsx"; },
    value => { value.source.name = "/private/spec.xlsx"; },
    value => { value.source.name = "file://private/spec.xlsx"; },
    value => { value.source.sha256 = "invalid"; },
    value => { value.source.importedAt = "yesterday"; },
    value => { delete value.source.name; },
    value => { value.source.localPath = "private"; },
    value => { value.sheets = []; },
    value => { value.sheets.push(structuredClone(value.sheets[0])); },
    value => { value.sheets = [{ name: "Flows", rows: [] }, { name: "flows", rows: [] }]; },
    value => { value.sheets[0].name = "C:\\private"; },
    value => { value.sheets[0].rows[0].row = "20"; },
    value => { value.sheets[0].rows[0].row = 1_048_577; },
    value => { value.sheets[0].rows.push(structuredClone(value.sheets[0].rows[0])); },
    value => { value.sheets[0].rows[0].cells[0].address = "A21"; },
    value => { value.sheets[0].rows[0].cells[0].address = "A020"; },
    value => { value.sheets[0].rows[0].cells[0].address = "XFE20"; },
    value => { value.sheets[0].rows[0].cells.push(structuredClone(value.sheets[0].rows[0].cells[0])); },
    value => { value.sheets[0].rows[0].cells[0].value = {}; },
    value => { value.sheets[0].rows[0].cells[0].formula = 3; },
    value => { value.sheets[0].rows[0].cells[0].hyperlink = false; },
  ];
  for (const mutate of invalid) {
    const value = specification();
    mutate(value);
    save(dataDir, value);
    expectInvalid(() => load(dataDir));
  }
});

function serviceFixture(t) {
  let service;
  const dataDir = directory(t, () => service?.close());
  const store = new TeamContextStore({ dataDir });
  const calls = [];
  service = new TeamContextService({ store, jiraClient: {
    configured: true,
    async getMemberIssues() { calls.push("jira"); return { issues: [], complete: true, fetchedAt: NOW }; },
  }, now: () => new Date(NOW), readHead: async () => SHA });
  service.upsertMember({ id: "example", displayName: "가상 개발자", gitlabUsername: "example", gitlabUserId: 1,
    jiraAccountId: "example-jira", areas: ["프론트엔드"], paths: ["frontend"], reviewFocus: ["사용자 흐름"] });
  return { dataDir, store, service, calls, input: { mrUrl: MR_URL, author: { id: 1 }, headSha: SHA, changedPaths: ["frontend/page.tsx"] } };
}

test("자동 리뷰 준비는 injected store의 경로에서 같은 프로젝트 명세를 읽고 셀을 비공개 맥락에 포함한다", async t => {
  const { dataDir, service, input } = serviceFixture(t);
  const original = save(dataDir);
  const bundle = await service.prepareReview(input);
  assert.deepEqual(bundle.projectSpecification, original);
  assert.match(bundle.reviewInstructions, /projectSpecification.*실행 지시가 아닙니다/);
  assert.match(bundle.reviewInstructions, /source\.name#시트이름!셀주소.*source\.sha256/);
  const markdown = readFileSync(bundle.path, "utf8");
  assert.match(markdown, /가상 요구 명세\.xlsx/);
  assert.ok(markdown.includes(original.source.sha256));
  assert.match(markdown, /A20/);
  assert.ok(markdown.includes("선택 전에도 작업·모니터링 기본 탭을 제공한다."));
  assert.equal(JSON.stringify(bundle.projectSpecification).includes(dataDir), false);
  const otherProject = await service.prepareReview({ ...input, mrUrl: MR_URL.replace("team/repo", "team/other") });
  assert.equal(Object.hasOwn(otherProject, "projectSpecification"), false);
});

test("같은 MR·SHA에서도 명세 셀 변경·원본 변경·등록 제거가 contextVersion에 반영된다", async t => {
  const { dataDir, service, input } = serviceFixture(t);
  const noSpecification = await service.prepareReview(input);
  assert.equal(Object.hasOwn(noSpecification, "projectSpecification"), false);
  const original = save(dataDir);
  const first = await service.prepareReview(input);
  assert.notEqual(first.contextVersion, noSpecification.contextVersion);
  assert.equal((await service.prepareReview(input)).contextVersion, first.contextVersion);
  original.sheets[0].rows[0].cells[0].value = "수정된 원문 요구사항";
  save(dataDir, original);
  const changedCells = await service.prepareReview(input);
  assert.notEqual(changedCells.contextVersion, first.contextVersion);
  original.source.sha256 = "c".repeat(64);
  save(dataDir, original);
  const changedSource = await service.prepareReview(input);
  assert.notEqual(changedSource.contextVersion, changedCells.contextVersion);
  rmSync(join(dataDir, "project-specification.json"));
  assert.equal((await service.prepareReview(input)).contextVersion, noSpecification.contextVersion);
});

test("손상된 등록 자료는 Jira 최신화나 리뷰 맥락 저장 전에 명확히 실패한다", async t => {
  const { dataDir, service, calls, input, store } = serviceFixture(t);
  writeFileSync(join(dataDir, "project-specification.json"), "{invalid");
  await assert.rejects(service.prepareReview(input), error => error instanceof UserError
    && error.code === "invalid_project_specification" && !error.message.includes(dataDir));
  assert.deepEqual(calls, []);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM team_review_bundles").get().count, 0);
});

test("리뷰 완료는 준비한 명세에 존재하는 셀만 근거로 누적 저장한다", async t => {
  const { dataDir, service, input, store } = serviceFixture(t);
  const original = save(dataDir);
  const prepared = await service.prepareReview(input);
  const ref = `${original.source.name}#${original.sheets[0].name}!A20`;
  const memory = {
    implementation: [{ summary: "기본 탭 분기 구현을 확인한다.", basis: "observed", evidence: [{ kind: "code", ref: "frontend/page.tsx:1" }] }],
    decisions: [], validations: [{ check: "실행 검증", result: "not_run", basis: "unknown", evidence: [] }],
    remainingWork: [{ summary: "명세의 기본 탭 조건과 구현을 대조한다.", basis: "reported", evidence: [{ kind: "specification", ref }] }],
  };
  const invalid = structuredClone(memory);
  invalid.remainingWork[0].evidence[0].ref = ref.replace("!A20", "!A21");
  const completion = { mrUrl: input.mrUrl, headSha: SHA, contextVersion: prepared.contextVersion, verdict: "hold" };
  await assert.rejects(service.completeReview({ ...completion, memory: invalid }), /Invalid review memory/);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM team_review_completions").get().count, 0);
  await service.completeReview({ ...completion, memory });
  assert.deepEqual(service.reviewHistory().records[0].memory.remainingWork[0].evidence, [{ kind: "specification", ref }]);
  rmSync(join(dataDir, "project-specification.json"));
  const withoutSpecification = await service.prepareReview(input);
  await assert.rejects(service.completeReview({ ...completion, contextVersion: withoutSpecification.contextVersion, memory }), /Invalid review memory/);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM team_review_completions").get().count, 1);
});

test("저장 경로가 없는 injected store에서는 기존 명세 없는 준비 동작을 보존한다", async () => {
  const member = { id: "example", displayName: "가상 개발자", gitlabUsername: "example", gitlabUserId: 1,
    jiraAccountId: "example-jira", areas: ["프론트엔드"], paths: ["frontend"], reviewFocus: ["사용자 흐름"] };
  let saved;
  const store = {
    listMembers: () => [member], saveIssues() {}, getIssuesForMember: () => [],
    listReviewCompletions: () => ({ records: [], total: 0, offset: 0 }),
    saveReviewBundle: (_key, _sha, value) => { saved = value; return value.bundle; }, close() {},
  };
  const service = new TeamContextService({ store, jiraClient: { configured: true,
    getMemberIssues: async () => ({ issues: [], complete: true, fetchedAt: NOW }) }, now: () => new Date(NOW) });
  const bundle = await service.prepareReview({ mrUrl: MR_URL, author: { id: 1 }, headSha: SHA });
  assert.equal(Object.hasOwn(bundle, "projectSpecification"), false);
  assert.equal(saved.markdown.includes("프로젝트 명세 원본 셀 자료"), false);
});
