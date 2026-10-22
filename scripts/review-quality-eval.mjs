#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { citedLocations, reviewContextProblems } from "../bin/mr-review.mjs";
import { ClaudeReviewRunner } from "../src/review-runner.js";
import { CodexReviewRunner } from "../src/codex-review-runner.js";
import { workerSettings } from "../src/review-worker-config.js";

const fixtureUrl = new URL("./fixtures/review-quality-cases.json", import.meta.url);

export function validateFixtures(fixtures) {
  assert.equal(fixtures.schemaVersion, 1);
  assert.ok(Array.isArray(fixtures.cases) && fixtures.cases.length > 0);
  const ids = new Set();
  for (const entry of fixtures.cases) {
    assert.match(entry.id, /^[a-z][a-z-]*$/);
    assert.ok(!ids.has(entry.id));
    ids.add(entry.id);
    assert.ok(["approve", "hold"].includes(entry.expected.verdict));
    assert.ok(Array.isArray(entry.expected.findings));
    const { context, changes } = entry.input;
    assert.deepEqual(reviewContextProblems({ contextRequired: true, context,
      headSha: changes.headSha, contextVersion: context.contextVersion }), []);
    assert.match(changes.mrUrl, /^https:\/\/gitlab\.example\.test\//);
    assert.deepEqual(changes.issueKeys, ["TEST-1"]);
    assert.ok(Array.isArray(changes.files) && changes.files.length > 0);
    for (const finding of [...entry.expected.findings, ...(entry.expected.resolvedFindings ?? [])]) {
      const file = changes.files.find(item => item.newPath === finding.path);
      assert.ok(file);
      assert.ok(finding.lineRange.length === 2 && finding.lineRange.every(Number.isSafeInteger));
      assert.ok(finding.lineRange[0] > 0 && finding.lineRange[0] <= finding.lineRange[1]);
      assert.ok(finding.lineRange[1] <= file.headContent.trimEnd().split("\n").length);
      assert.ok(finding.anyTerms.length > 0 && finding.anyTerms.every(term => typeof term === "string" && term));
    }
  }
  return fixtures;
}

function confirmedFindingBlocks(body) {
  const section = body.split(/^### 수정이 필요한 부분\s*$/m)[1]?.split(/^#{2,3} /m)[0] ?? "";
  return section.split(/(?=^(?:[-*]|\d+[.)])\s)/m).map(block => block.trim())
    .filter(block => block && !block.includes("[확인 필요]"));
}

function hasUnsupportedClaim(body) {
  return body.split(/\n|(?<=[.!?])\s+/).some(line => {
    if (/(?:확인 필요|미확인|확인할 수 없|확인하지 못|판단할 수 없|여부|제공되지|자료가 없|정의가 없|가능성)/.test(line)) return false;
    const missingRouteClaim = line.includes("/select")
      && /(?:존재하지|등록되지|없는 (?:화면|경로|라우트)|(?:경로|라우트|화면).{0,12}없|404|미구현)/.test(line);
    const unseenSpecificationClaim = /(?:명세|기획서|상세 요구사항).{0,24}(?:원문을? ?확인|읽었|확인했|확인하였)/.test(line);
    return missingRouteClaim || unseenSpecificationClaim;
  });
}

export function scoreReview(entry, review) {
  const blocks = confirmedFindingBlocks(review.body);
  const matches = finding => blocks.some(block =>
    finding.anyTerms.some(term => block.includes(term)) && citedLocations(block).some(location => {
      const match = /^(.*):(\d+)$/.exec(location);
      return match && match[1] === finding.path && Number(match[2]) >= finding.lineRange[0]
        && Number(match[2]) <= finding.lineRange[1];
    }));
  const detectedTargets = entry.expected.findings.filter(matches).map(finding => finding.id);
  const repeatedResolvedTargets = (entry.expected.resolvedFindings ?? []).filter(matches).map(finding => finding.id);
  const unsupportedClaim = Boolean(entry.expected.noConfirmedUnsupportedClaims && hasUnsupportedClaim(review.body));
  const comparisonMissing = Boolean(entry.expected.previousReviewComparison
    && !/^### 이전 리뷰 대비\s*\r?\n\s*\S/m.test(review.body));
  return {
    case: entry.id, verdict: review.verdict, expectedVerdict: entry.expected.verdict,
    detectedTargets, expectedTargetCount: entry.expected.findings.length, repeatedResolvedTargets, unsupportedClaim, comparisonMissing,
    passed: review.verdict === entry.expected.verdict
      && detectedTargets.length === entry.expected.findings.length && !repeatedResolvedTargets.length && !unsupportedClaim && !comparisonMissing,
  };
}

async function main() {
  const { values } = parseArgs({ options: {
    run: { type: "boolean", default: false },
    case: { type: "string", multiple: true },
    help: { type: "boolean", default: false },
  } });
  if (values.help) {
    process.stdout.write("Usage: node --env-file=.env scripts/review-quality-eval.mjs [--run] [--case CASE_ID]\nWithout --run, only synthetic fixtures are checked. --run uses the configured CLI and model allowance. No MR, chat, or review-memory writes occur.\n");
    return;
  }
  const fixtures = validateFixtures(JSON.parse(await readFile(fixtureUrl, "utf8")));
  const selected = values.case?.length ? fixtures.cases.filter(entry => values.case.includes(entry.id)) : fixtures.cases;
  assert.ok(selected.length && (values.case ?? []).every(id => selected.some(entry => entry.id === id)), "Unknown evaluation case.");
  if (!values.run) {
    process.stdout.write(`${JSON.stringify({ mode: "fixtures-only", cases: selected.map(entry => entry.id), modelCalls: 0, passed: true })}\n`);
    return;
  }
  const settings = workerSettings();
  const Runner = settings.provider === "codex" ? CodexReviewRunner : ClaudeReviewRunner;
  const runner = new Runner({ command: settings.command, model: settings.model, timeoutMs: settings.timeoutMs });
  let failures = 0;
  for (const entry of selected) {
    let report;
    try {
      report = scoreReview(entry, await runner.review(entry.input));
      assert.equal(report.passed, true, `Quality expectations failed for ${entry.id}.`);
    } catch (error) {
      failures += 1;
      report ??= { case: entry.id, passed: false, error: /^[a-z][a-z0-9_]{0,63}$/.test(error?.code ?? "")
        ? error.code : "runner_failed_or_review_rejected" };
    }
    process.stdout.write(`${JSON.stringify(report)}\n`);
  }
  process.exitCode = failures ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write(`${JSON.stringify({ passed: false, error: "evaluation_configuration_or_fixtures_invalid" })}\n`);
    process.exitCode = 1;
  });
}
