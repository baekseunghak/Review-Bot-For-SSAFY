import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PartitionedReviewRunner } from "../src/partitioned-review.js";
import { normalizeRunnerEnvelope } from "../src/review-runner.js";

const pathOf = (file) => file.deletedFile ? file.oldPath : file.newPath;

function inputFixture() {
  const file = (oldPath, newPath, flags = {}) => ({ oldPath, newPath,
    baseContent: "export const value = 1;\n", headContent: "export const value = 2;\n",
    diff: "@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n",
    oldMode: "100644", newMode: "100644", deletedFile: false, renamedFile: false, newFile: false, ...flags });
  return {
    context: { status: "fresh", headSha: "a".repeat(40), contextVersion: "b".repeat(64),
      preparedAt: "2026-10-29T01:00:00Z", author: { memberId: "fixture-member" }, teamMemberIds: ["fixture-member"],
      relatedIssues: [{ key: "TEST-1", updatedAt: "2026-10-28T00:00:00Z" }],
      perspectives: [{ memberId: "fixture-member", areas: ["입력 검증"], changedPaths: ["src/input.js"] }],
      storage: { path: "C:/private/context/first.json", localPath: "C:/private/first.json", localPaths: ["C:/private/first.md"],
        markdownPath: "C:/private/first.md", nested: { storagePath: "C:/private/storage/first.json" } } },
    changes: { projectId: "101", mrIid: 81, headSha: "a".repeat(40), contextBytes: 8_000,
      notesObservedAt: "2026-10-29T01:00:00Z", notes: [], files: [
        file("src/input.js", "src/input.js"),
        file("src/old.js", "src/renamed.js", { renamedFile: true }),
        file("src/deleted.js", "src/deleted.js", { deletedFile: true, headContent: null }),
        file("src/extra.js", "src/extra.js", { newFile: true, baseContent: null }),
      ] },
  };
}

function reviewResult(payload, { findings = [], resolutions = [] } = {}) {
  const blocking = findings.some((finding) => finding.blocking);
  const verdict = blocking ? "hold" : "approve";
  const reasons = findings.map((finding) => `- [${finding.severity}] [정확성] [${finding.id}] \`${finding.path}:${finding.line}\` ${finding.statement}`).join("\n");
  const body = `## 리뷰 결과: ${blocking ? "보류" : "승인"}\n\n`
    + (blocking ? `### 왜 보류인가\n입력 검증의 필수 계약을 깨는 오류를 확인했습니다.\n\n### 수정이 필요한 부분\n${reasons}\n\n` : "")
    + "### 확인한 범위\n제공된 변경 전후 코드를 정적으로 검토했으며 테스트는 실행하지 않았습니다.\n\n"
    + "### 작업 맥락\nTEST-1 입력 검증 요구와 변경된 호출 관계를 대조했습니다.";
  const path = pathOf(payload.changes.files[0]);
  return normalizeRunnerEnvelope({ verdict, body, memory: {
    implementation: [{ summary: "변경된 입력과 반환 계약을 확인했습니다.", basis: "observed", evidence: [{ kind: "code", ref: `${path}:1` }] }],
    decisions: [], validations: [{ check: "테스트 실행", result: "not_run", basis: "unknown", evidence: [] }], remainingWork: [],
  }, reviewAudit: { coveredFiles: payload.changes.files.map(pathOf),
    interfaces: payload.reviewPartition.phase === "files" ? payload.changes.files.map((file) => ({ file: pathOf(file), summary: "입출력과 호출 관계를 변경 전후 코드에서 확인했습니다." })) : [],
    findings, resolutions } }, payload);
}

const findingFor = (payload) => ({ id: "F1", severity: "주의", blocking: true,
  path: pathOf(payload.changes.files[0]), line: 1, statement: "빈 입력이 저장되어 필수 입력 계약을 깨므로 병합 전에 거부해야 합니다." });
const resolutionFor = (finding, disposition) => ({ id: finding.id, disposition,
  reason: disposition === "dismissed" ? "전체 호출 경로의 입력 검증이 같은 요청을 저장 전에 거부함을 확인했습니다." : "전체 호출 경로에서도 빈 입력을 저장 전에 거부하는 방어가 없어 결함을 유지합니다.",
  evidence: [{ path: finding.path, line: finding.line }] });

async function setup(t, behavior = (payload) => reviewResult(payload), options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "partitioned-review-test-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const calls = [];
  const runner = { maxInputBytes: 100_000, command: "fixture-runner", model: "fixture-model",
    async review(payload, runtime) { calls.push(structuredClone(payload)); return behavior(payload, runtime, calls.length); } };
  const review = new PartitionedReviewRunner({ runner, dataDir, thresholdBytes: 1, batchBytes: 50_000, maxFilesPerBatch: 1, ...options });
  return { review, runner, calls, dataDir };
}

test("분할 검토는 이름 변경·삭제를 포함한 모든 파일을 완전하게 전달하고 전체 현재 소스로 통합한다", async (t) => {
  const input = inputFixture();
  const { review, calls } = await setup(t);
  const progress = [];
  const result = await review.review(input, { onProgress: (value) => progress.push(value) });
  const batches = calls.filter((payload) => payload.reviewPartition.phase === "files");
  assert.equal(batches.length, input.changes.files.length);
  assert.deepEqual(batches.flatMap((payload) => payload.changes.files), input.changes.files);
  for (const payload of batches) {
    assert.deepEqual(payload.reviewPartition.requiredPaths, payload.changes.files.map(pathOf));
    assert.deepEqual(payload.reviewPartition.fullManifest.map((file) => file.path), input.changes.files.map(pathOf));
  }
  const integration = calls.at(-1);
  assert.equal(integration.reviewPartition.phase, "integration");
  assert.deepEqual(integration.changes.files.map(pathOf), input.changes.files.map(pathOf));
  for (const [index, file] of integration.changes.files.entries()) {
    assert.equal(file.headContent, input.changes.files[index].headContent);
    assert.equal(file.baseContent, file.deletedFile ? input.changes.files[index].baseContent : null);
    assert.equal(file.diff, "");
  }
  assert.equal(integration.partitionReports.length, batches.length);
  assert.equal(result.verdict, "approve");
  assert.match(result.body, /텍스트 파일 4\/4개/);
  assert.equal(result.reviewAudit, undefined);
  assert.equal(progress.at(-1).phase, "completed");
});

for (const phase of ["files", "integration"]) {
  for (const invalid of ["missing", "duplicate"]) {
    test(`${phase} 단계의 ${invalid} 파일 검토 확인은 최종 리뷰를 만들지 않는다`, async (t) => {
      const { review } = await setup(t, (payload) => {
        const result = reviewResult(payload);
        if (payload.reviewPartition.phase === phase) {
          if (invalid === "missing") result.reviewAudit.coveredFiles.pop();
          else result.reviewAudit.coveredFiles[1] = result.reviewAudit.coveredFiles[0];
        }
        return result;
      }, { maxFilesPerBatch: 2 });
      const progress = [];
      await assert.rejects(review.review(inputFixture(), { onProgress: (value) => progress.push(value) }), { code: "review_coverage_invalid" });
      assert.equal(progress.some((value) => value.phase === "completed"), false);
    });
  }
}

test("통합 단계에서 이전 확정 결함을 누락하면 승인할 수 없다", async (t) => {
  const { review, calls } = await setup(t, (payload) => reviewResult(payload,
    payload.reviewPartition.phase === "files" && payload.reviewPartition.batchIndex === 1 ? { findings: [findingFor(payload)] } : {}));
  await assert.rejects(review.review(inputFixture()), { code: "review_integration_invalid" });
  assert.equal(calls.at(-1).reviewPartition.priorFindings[0].id, "b001:F1");
});

test("통합 단계의 구체적 반증과 코드 근거가 있어야 이전 결함을 기각하고 승인한다", async (t) => {
  const { review, calls } = await setup(t, (payload) => {
    if (payload.reviewPartition.phase === "integration") return reviewResult(payload, {
      resolutions: payload.reviewPartition.priorFindings.map((finding) => resolutionFor(finding, "dismissed")) });
    return reviewResult(payload, payload.reviewPartition.batchIndex === 1 ? { findings: [findingFor(payload)] } : {});
  });
  const result = await review.review(inputFixture());
  assert.equal(calls.at(-1).reviewPartition.priorFindings.length, 1);
  assert.equal(result.verdict, "approve");
  assert.doesNotMatch(result.body, /\[b001:F1\]/);
});

test("통합 단계에서 유지한 결함은 최종 보류에 남고 내부 식별자만 제거한다", async (t) => {
  const { review } = await setup(t, (payload) => {
    if (payload.reviewPartition.phase === "integration") return reviewResult(payload, {
      findings: payload.reviewPartition.priorFindings,
      resolutions: payload.reviewPartition.priorFindings.map((finding) => resolutionFor(finding, "retained")) });
    return reviewResult(payload, payload.reviewPartition.batchIndex === 1 ? { findings: [findingFor(payload)] } : {});
  });
  const result = await review.review(inputFixture());
  assert.equal(result.verdict, "hold");
  assert.match(result.body, /\[주의\] \[정확성\]/);
  assert.match(result.body, /`src\/input.js:1`/);
  assert.doesNotMatch(result.body, /\[b001:F1\]/);
});

test("나중 묶음의 일시 실패 후 같은 업무 자료의 완료 영수증을 재사용한다", async (t) => {
  let failed = false;
  const { review, calls } = await setup(t, (payload) => {
    if (payload.reviewPartition.phase === "files" && payload.reviewPartition.batchIndex === 2 && !failed) {
      failed = true;
      throw Object.assign(new Error("Temporary runner failure"), { code: "runner_timeout" });
    }
    return reviewResult(payload);
  });
  const input = inputFixture();
  await assert.rejects(review.review(input), { code: "runner_timeout" });
  const refreshed = structuredClone(input);
  refreshed.context.preparedAt = "2026-10-29T01:05:00Z";
  refreshed.context.storage = { path: "C:/private/context/second.json", localPath: "C:/private/second.json", localPaths: ["C:/private/second.md"],
    markdownPath: "C:/private/second.md", nested: { storagePath: "C:/private/storage/second.json" } };
  refreshed.changes.notesObservedAt = "2026-10-29T01:05:00Z";
  assert.equal((await review.review(refreshed)).verdict, "approve");
  assert.equal(calls.filter((payload) => payload.reviewPartition.batchIndex === 1).length, 1);
  assert.equal(calls.filter((payload) => payload.reviewPartition.phase === "files" && payload.reviewPartition.batchIndex === 2).length, 2);
  assert.equal(calls.filter((payload) => payload.reviewPartition.phase === "integration").length, 1);
});

for (const changed of ["headSha", "manifest", "businessUpdatedAt", "contextVersion"]) {
  test(`${changed} 변경은 이전 분할 영수증을 무효화한다`, async (t) => {
    const { review, calls } = await setup(t);
    const input = inputFixture();
    await review.review(input);
    const updated = structuredClone(input);
    if (changed === "headSha") updated.context.headSha = updated.changes.headSha = "c".repeat(40);
    if (changed === "manifest") updated.changes.files[0].headContent = "export const value = 3;\n";
    if (changed === "businessUpdatedAt") updated.context.relatedIssues[0].updatedAt = "2026-10-29T01:04:00Z";
    if (changed === "contextVersion") updated.context.contextVersion = "d".repeat(64);
    await review.review(updated);
    assert.equal(calls.filter((payload) => payload.reviewPartition.phase === "files").length, 8);
    assert.equal(calls.filter((payload) => payload.reviewPartition.phase === "integration").length, 2);
  });
}

test("현재 커밋 확인 실패는 완료된 부분 결과를 최종 결과로 반환하지 않는다", async (t) => {
  let current = true;
  const { review, calls } = await setup(t, (payload) => { current = false; return reviewResult(payload); });
  const progress = [];
  await assert.rejects(review.review(inputFixture(), {
    assertCurrent() { if (!current) throw Object.assign(new Error("Head changed"), { code: "stale_head" }); },
    onProgress: (value) => progress.push(value),
  }), { code: "stale_head" });
  assert.equal(calls.length, 1);
  assert.equal(progress.some((value) => value.phase === "completed"), false);
});

for (const phase of ["files", "integration"]) {
  test(`${phase} 단계에서 취소되면 최종 결과를 반환하지 않는다`, async (t) => {
    const controller = new AbortController();
    const { review, calls } = await setup(t, (payload, { signal }) => {
      assert.equal(signal, controller.signal);
      if (payload.reviewPartition.phase === phase) controller.abort();
      return reviewResult(payload);
    });
    const progress = [];
    await assert.rejects(review.review(inputFixture(), { signal: controller.signal, onProgress: (value) => progress.push(value) }), { code: "runner_cancelled" });
    assert.equal(progress.some((value) => value.phase === "completed"), false);
    if (phase === "files") assert.equal(calls.some((payload) => payload.reviewPartition.phase === "integration"), false);
  });
}

test("전체 연동 자료가 실행 한도를 넘으면 부분 승인 대신 명시적으로 실패한다", async (t) => {
  const { review, runner, calls } = await setup(t, (payload) => reviewResult(payload), { batchBytes: 32_000 });
  runner.maxInputBytes = review.maxInputBytes = 32_000;
  const input = inputFixture();
  for (const file of input.changes.files) {
    file.baseContent = file.baseContent === null ? null : `${"x".repeat(8_000)}\n`;
    file.headContent = file.headContent === null ? null : `${"y".repeat(8_000)}\n`;
    file.diff = "z".repeat(8_000);
  }
  const progress = [];
  await assert.rejects(review.review(input, { onProgress: (value) => progress.push(value) }), { code: "review_integration_too_large" });
  assert.equal(calls.filter((payload) => payload.reviewPartition.phase === "files").length, 4);
  assert.equal(calls.some((payload) => payload.reviewPartition.phase === "integration"), false);
  assert.equal(progress.some((value) => value.phase === "completed"), false);
});
