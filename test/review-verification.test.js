import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DockerReviewSandbox, redactValidationLog } from "../src/review-sandbox.js";
import { ReviewVerificationService, validationProfile, attachVerification, verificationMemory, verificationReference } from "../src/review-verification.js";
import { normalizeReviewResult } from "../src/review-runner.js";
import { GitlabReviewClient } from "../src/review-gitlab.js";

const sha = "a".repeat(40), imageId = `sha256:${"b".repeat(64)}`;
const check = { name: "unit-test", kind: "test", directory: "backend", image: "fixture:local", command: ["node", "test.js"], timeoutMs: 1000 };
const config = (checks = [check]) => ({ schemaVersion: 1, projects: [{ host: "gitlab.example.test", projectId: 12, checks }] });
const archive = { data: Buffer.from("fixture archive"), sha, sha256: "c".repeat(64) };
const input = { projectId: 12, mrIid: 7, headSha: sha };

function sandboxFixture(outcome = { exitCode: 0, output: "ok", reason: null }) {
  const calls = [];
  const run = async (args, options) => {
    calls.push({ args, options });
    if (args[0] === "info") return { exitCode: 0, output: "linux|true|true|true|true", reason: null };
    if (args[0] === "image") return { exitCode: 0, output: JSON.stringify({ Os: "linux", Id: imageId, Config: { Env: ["PATH=/usr/bin"] } }), reason: null };
    if (args[0] === "rm") return { exitCode: 0, output: "", reason: null };
    return outcome;
  };
  return { sandbox: new DockerReviewSandbox({ run }), calls };
}

test("검증 계획은 프로젝트별 운영 설정만 사용하고 경로 이탈·중복·임의 환경변수를 거부한다", () => {
  assert.equal(validationProfile(config(), "gitlab.example.test", 12).length, 1);
  assert.deepEqual(validationProfile(config(), "other.example.test", 12), []);
  for (const override of [{ directory: "../secret" }, { directory: "C:\\private" }, { command: ["node\nsecret"] },
    { image: "--privileged" }, { timeoutMs: 900001 }, { name: "bad\nname" }, { env: { TOKEN: "fixture" } }]) {
    assert.throws(() => validationProfile(config([{ ...check, ...override }]), "gitlab.example.test", 12));
  }
  assert.throws(() => validationProfile(config([check, check]), "gitlab.example.test", 12));
});

test("격리 명령은 고정 이미지 ID·네트워크 차단·비루트·자원 제한으로 실행하고 호스트 폴더를 연결하지 않는다", async () => {
  const { sandbox, calls } = sandboxFixture();
  const result = await sandbox.execute(check, archive);
  assert.equal(result.result, "passed");
  assert.equal(result.exitCode, 0);
  assert.equal(result.imageId, imageId);
  const run = calls.find((call) => call.args[0] === "run");
  for (const flag of ["--network=none", "--read-only", "--log-driver=none", "--no-healthcheck", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user=1000:1000", "--pids-limit=256", "--memory=3g", "--pull=never", imageId]) assert.ok(run.args.includes(flag));
  assert.equal(run.args.some((arg) => ["-v", "--volume", "--mount", "--privileged", "--env-file"].includes(arg)), false);
  assert.deepEqual(run.options.input, archive.data);
  assert.deepEqual(run.args.slice(-3), ["backend", "node", "test.js"]);
  assert.equal(calls.at(-1).args[0], "rm");
});

test("실제 명령 실패와 환경 오류를 구분하고 타임아웃·취소에도 컨테이너를 정리한다", async () => {
  for (const [outcome, result, failureKind] of [
    [{ exitCode: 1, output: "AssertionError", reason: null }, "failed", "command"],
    [{ exitCode: 122, output: "dependency mismatch", reason: null }, "unknown", "environment"],
    [{ exitCode: null, output: "", reason: "timeout" }, "unknown", "environment"],
    [{ exitCode: null, output: "", reason: "cancelled" }, "unknown", "environment"],
    [{ exitCode: 1, output: "No cached version of example available for offline mode", reason: null }, "unknown", "environment"],
    [{ exitCode: 4, output: "ImportError: libexpat.so.1: cannot open shared object file: No such file or directory", reason: null }, "unknown", "environment"],
  ]) {
    const fixture = sandboxFixture(outcome);
    const actual = await fixture.sandbox.execute(check, archive);
    assert.equal(actual.result, result);
    assert.equal(actual.failureKind, failureKind);
    assert.equal(fixture.calls.at(-1).args[0], "rm");
  }
  let called = false;
  const noRun = await new DockerReviewSandbox({ run: async () => { called = true; } }).execute({ ...check, command: null, reason: "not_defined" });
  assert.equal(noRun.result, "not_run");
  assert.equal(called, false);
});

test("인증값이나 지속 볼륨이 들어 있는 기존 서비스 이미지를 검증용으로 실행하지 않는다", async () => {
  for (const Config of [{ Env: ["API_TOKEN=fixture"] }, { Volumes: { "/data": {} } }]) {
    const calls = [];
    const sandbox = new DockerReviewSandbox({ run: async (args) => {
      calls.push(args);
      return { exitCode: 0, output: args[0] === "info" ? "linux|true|true|true|true" : JSON.stringify({ Os: "linux", Id: imageId, Config }) };
    } });
    assert.equal((await sandbox.execute(check, archive)).reason, "clean_local_image_required");
    assert.equal(calls.some((args) => args[0] === "run"), false);
  }
});

test("검증 로그의 토큰·인증 URL·터미널 제어 문자를 모델 입력 전에 제거한다", () => {
  const redacted = redactValidationLog("\x1b[31mfailed token=fixture-sensitive https://user:password@example.test glpat-example1234567890\x00");
  assert.doesNotMatch(redacted, /fixture-sensitive|user:password|glpat-|\x1b|\x00/);
  assert.match(redacted, /failed/);
  assert.doesNotMatch(redactValidationLog("Authorization: Bearer opaque-fixture-credential"), /opaque-fixture-credential/);
  assert.doesNotMatch(redactValidationLog("-----BEGIN PRIVATE KEY-----\nfixture-incomplete-material"), /fixture-incomplete-material/);
});

test("다국어 진단 출력도 영수증과 작업 checkpoint의 바이트 제한 안에 남긴다", async () => {
  const { sandbox } = sandboxFixture({ exitCode: 1, output: "실패".repeat(10_000), reason: null });
  const result = await sandbox.execute(check, archive);
  assert.equal(result.result, "failed");
  assert.ok(Buffer.byteLength(result.output, "utf8") <= 8_000);
});

test("자원 제한을 지원하지 않는 Docker에서는 격리 실행을 시작하지 않는다", async () => {
  const sandbox = new DockerReviewSandbox({ run: async (args) => {
    assert.equal(args[0], "info");
    return { exitCode: 0, output: "linux|false|false|true|true", reason: null };
  } });
  assert.equal((await sandbox.execute(check, archive)).reason, "docker_isolation_unsupported");
});

test("같은 SHA의 소스를 실행하고 CI를 직접 읽어 비공개 영수증과 공개 요약에 반영한다", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "review-verification-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await writeFile(join(dataDir, "validation-projects.json"), JSON.stringify(config()));
  const calls = [];
  const service = new ReviewVerificationService({ dataDir, gitlab: {
    host: "gitlab.example.test", async archive(got) { assert.deepEqual(got, input); calls.push("archive"); return archive; },
    async readCi(got) { assert.deepEqual(got, input); calls.push("ci"); return { status: "success", sha,
      pipeline: { id: 9, url: "https://gitlab.example.test/group/repo/-/pipelines/9" }, jobs: [], bridges: [], tests: null }; },
  }, sandbox: { async execute(got, source) { assert.equal(source, archive); calls.push("check"); return { ...got,
    result: "passed", exitCode: 0, failureKind: null, imageId, output: "ok" }; } } });
  const verified = await service.collect(input);
  assert.deepEqual(calls, ["archive", "check", "ci"]);
  assert.equal(JSON.parse(await readFile(join(dataDir, "validation", `${verified.runId}.json`), "utf8")).headSha, sha);
  const reference = verificationReference(verified);
  assert.equal(Object.hasOwn(reference, "checks"), false, "대용량 로그를 작업 DB에 복제하지 않는다");
  assert.deepEqual(await service.restore(reference), verified);
  const review = { verdict: "approve", body: "## 리뷰 결과: 승인\n### 확인한 범위\n정적 점검\n### 작업 맥락\nbackend 입력 계약 확인",
    memory: { implementation: [{ summary: "검증 추가", basis: "observed", evidence: [{ kind: "code", ref: "input.js:1" }] }], decisions: [], validations: [], remainingWork: [] } };
  const augmented = attachVerification(review, verified);
  assert.match(augmented.body, /테스트 보고서: 확인 불가/);
  assert.match(augmented.body, /unit-test.*통과/);
  assert.equal(normalizeReviewResult(augmented, { verification: verified }).memory.validations.length, 2);
  assert.throws(() => normalizeReviewResult(augmented), { code: "review_test_claim_invalid" });
  const invented = structuredClone(augmented);
  invented.memory.validations[1].result = "failed";
  assert.throws(() => normalizeReviewResult(invented, { verification: verified }), { code: "review_test_claim_invalid" });
  assert.deepEqual(verificationMemory(verified), augmented.memory.validations);
  const accidentalCredential = structuredClone(verified);
  accidentalCredential.checks[0].command = ["test", "--token=fixture-sensitive-command"];
  assert.doesNotMatch(attachVerification(review, accidentalCredential).body, /fixture-sensitive-command/);
  await writeFile(join(dataDir, "validation", `${verified.runId}.json`), "{}");
  await assert.rejects(service.restore(reference), { code: "verification_receipt_invalid" });
});

test("CI와 실행 설정이 없으면 통과를 꾸미지 않고 미실행·조회 불가로 남긴다", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "review-verification-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = new ReviewVerificationService({ dataDir, gitlab: { host: "gitlab.example.test",
    async archive() { assert.fail("Unconfigured source must not run."); }, async readCi() { throw new Error("no access"); } } });
  const verified = await service.collect(input);
  assert.equal(verified.configuration, "not_configured");
  assert.equal(verified.ci.status, "unavailable");
  assert.deepEqual(verified.checks, []);
  assert.deepEqual(verificationMemory(verified), []);
});

test("CI가 없거나 조회 실패해도 커밋 메시지가 있는 정상 응답에서 소스를 받아 검사를 실행한다", async (t) => {
  for (const unavailable of [false, true]) {
    const dataDir = await mkdtemp(join(tmpdir(), "review-no-ci-"));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
    await writeFile(join(dataDir, "validation-projects.json"), JSON.stringify(config()));
    let executions = 0;
    const gitlab = new GitlabReviewClient({ host: "gitlab.example.test", allowedProjectIds: [12], runImpl: async (file, args) => {
      if (args[1].includes("/commits/")) return JSON.stringify({ id: sha, message: "Normal commit message" });
      if (args[1].includes("archive.tar.gz")) return Buffer.from([0x1f, 0x8b, 0x00]);
      if (args[1].includes("/pipelines?")) {
        if (unavailable) throw Object.assign(new Error("private"), { stderr: "HTTP 502" });
        return "[]";
      }
      assert.fail("Unexpected request");
    } });
    const service = new ReviewVerificationService({ dataDir, gitlab, sandbox: { async execute(got, source) {
      executions += 1;
      assert.equal(source.sha, sha);
      return { ...got, result: "passed", exitCode: 0, output: "Executed independently of CI" };
    } } });
    const verified = await service.collect(input);
    assert.equal(executions, 1);
    assert.equal(verified.checks[0].result, "passed");
    assert.equal(verified.ci.status, unavailable ? "unavailable" : "not_found");
  }
});

test("소스 실패 원인·HTTP 상태를 보존하며 검사를 실행한 것으로 기록하지 않는다", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "review-archive-failure-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await writeFile(join(dataDir, "validation-projects.json"), JSON.stringify(config()));
  const service = new ReviewVerificationService({ dataDir, gitlab: { host: "gitlab.example.test",
    async archive() { throw Object.assign(new Error("private"), { code: "gitlab_request_failed", httpStatus: 502 }); },
    async readCi() { return { status: "not_found", pipeline: null }; },
  }, sandbox: { execute() { assert.fail("Source unavailable"); } } });
  const verified = await service.collect(input);
  assert.equal(verified.archiveError, "gitlab_request_failed");
  assert.equal(verified.archiveHttpStatus, 502);
  assert.equal(verified.checks[0].result, "not_run");
  const body = attachVerification({ body: "Reviewed", memory: { validations: [] } }, verified).body;
  assert.match(body, /소스 확보 실패: gitlab_request_failed \(HTTP 502\)/);
  assert.doesNotMatch(body, /private/);
});
