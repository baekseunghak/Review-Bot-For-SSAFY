import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { scoreReview, validateFixtures } from "../scripts/review-quality-eval.mjs";

const fixtures = validateFixtures(JSON.parse(readFileSync(new URL("../scripts/fixtures/review-quality-cases.json", import.meta.url), "utf8")));
const entry = (id) => fixtures.cases.find((item) => item.id === id);
function review(findings, comparison = "") {
  return { verdict: "hold", body: `## 리뷰 결과: 보류\n\n### 수정이 필요한 부분\n${findings.map((finding) =>
    `- [정확성] \`${finding.path}:${finding.lineRange[0]}\` ${finding.anyTerms[0]} 검증 누락으로 잘못된 입력이 통과합니다.`).join("\n")}\n\n### 확인한 범위\n정적 검토이며 테스트는 실행하지 않았습니다.\n${comparison}` };
}

test("여러 파일·분기의 독립 결함 중 하나라도 빠지면 일괄 탐지 평가는 실패한다", () => {
  const initial = entry("batch-broken");
  assert.equal(initial.expected.findings.length, 5);
  assert.equal(scoreReview(initial, review(initial.expected.findings)).passed, true);
  for (const finding of initial.expected.findings) {
    assert.equal(scoreReview(initial, review(initial.expected.findings.filter((item) => item !== finding))).passed, false, finding.id);
  }
});

test("재리뷰는 남은 결함과 이전 대비를 포함하고 해결한 결함을 다시 요구하면 실패한다", () => {
  const followup = entry("batch-followup");
  const comparison = "### 이전 리뷰 대비\n이전 지적 세 건은 현재 코드에서 해결됐으며 나머지 두 건은 추가 발견입니다. 발생 시점은 미확인입니다.";
  assert.equal(scoreReview(followup, review(followup.expected.findings, comparison)).passed, true);
  assert.equal(scoreReview(followup, review(followup.expected.findings)).comparisonMissing, true);
  for (const resolved of followup.expected.resolvedFindings) {
    const result = scoreReview(followup, review([...followup.expected.findings, resolved], comparison));
    assert.deepEqual(result.repeatedResolvedTargets, [resolved.id]);
    assert.equal(result.passed, false);
  }
});

test("후속 예제는 알려진 세 결함만 수정하고 헤더 누락과 잘못된 모드는 그대로 남긴다", () => {
  const files = entry("batch-followup").input.changes.files;
  assert.match(files.find((file) => file.newPath.endsWith("count.js")).headContent, /cell\.value/);
  assert.match(files.find((file) => file.newPath.endsWith("rules.js")).headContent, /if \(header >= 0\)/);
  assert.match(files.find((file) => file.newPath.endsWith("rules.js")).headContent, /invalid rule code.*continue/);
  assert.match(files.find((file) => file.newPath.endsWith("mode.js")).headContent, /: 'none'/);
  assert.match(files.find((file) => file.newPath.endsWith("load.js")).headContent, /duplicate item ID/);
});

test("합의된 첫 대표값 선택은 승인하고 근거 없는 과거 지적을 정정해야 한다", () => {
  const normal = entry("accepted-behavior");
  const approved = { verdict: "approve", body: "## 리뷰 결과: 승인\n\n### 확인한 범위\n첫 대표값 계약과 일치합니다.\n\n### 이전 리뷰 대비\n이전 판단 정정: 모든 행의 검증을 요구한 지적은 현재 계약에 근거가 없어 철회합니다." };
  assert.equal(scoreReview(normal, approved).passed, true);
  assert.equal(scoreReview(normal, { ...approved, body: approved.body.replace("이전 판단 정정", "수정 없음").replace("지적은 현재 계약에 근거가 없어 철회합니다", "개선이 필요합니다") }).passed, false);
  const unjustified = { ...approved, body: approved.body + "\n### 수정이 필요한 부분\n- [정확성] `src/import/metadata.js:3` 뒤쪽 행을 검증해야 합니다." };
  assert.equal(scoreReview(normal, unjustified).unexpectedConfirmedFindings, true);
  assert.equal(scoreReview(normal, unjustified).passed, false);
});

test("대표값 계약을 실제로 깨뜨린 경우에는 기준 조정 뒤에도 보류한다", () => {
  const broken = entry("representative-regression");
  assert.equal(scoreReview(broken, review(broken.expected.findings)).passed, true);
  assert.equal(scoreReview(broken, { verdict: "approve", body: "문제없음" }).passed, false);
});
