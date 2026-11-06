import { createHash } from "node:crypto";
import { mkdir, lstat, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, win32 } from "node:path";
import { UserError } from "./core.js";
import { normalizeReviewResult, normalizeRunnerEnvelope, REVIEW_SYSTEM_PROMPT, SYNTHESIS_REVIEW_PROMPT } from "./review-runner.js";

const bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const volatileFields = new Set(["preparedAt", "notesObservedAt", "observedAt", "lastObservedAt", "localPath", "localPaths", "markdownPath", "storagePath"]);
function reviewDigest(value) {
  const semantic = (item) => {
    if (Array.isArray(item)) return item.map(semantic);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(Object.keys(item).sort().filter((key) => !volatileFields.has(key)
      && !(key === "path" && typeof item[key] === "string" && (isAbsolute(item[key]) || win32.isAbsolute(item[key]))))
      .map((key) => [key, semantic(item[key])]));
  };
  return hash(semantic(value));
}

function integrationContext(context) {
  if (!context) return context;
  const { changedPaths, mrSource, ...uniqueContext } = context;
  return {
    ...uniqueContext,
    perspectives: context.perspectives?.map(({ workItems = [], reviewerObservations, ...view }) => ({
      ...view,
      workItems: workItems.map(({ key }) => ({ key })),
      detailsReviewedInFilePass: true,
    })),
    reviewHistory: context.reviewHistory && {
      ...context.reviewHistory,
      records: context.reviewHistory.records.map(({ memory, ...record }) => ({
        ...record, memory: { remainingWork: memory.remainingWork },
      })),
      detailsReviewedInFilePass: true,
    },
    projectActivity: context.projectActivity && {
      ...context.projectActivity,
      records: context.projectActivity.records.map(({ mrUrl, headSha, title }) => ({ mrUrl, headSha, title })),
      detailsReviewedInFilePass: true,
    },
    integrationContextPolicy: "파일별 단계에서 전체 배경 이력을 검토했습니다. 통합 단계의 배경 업무는 Jira 키, 과거 리뷰는 남은 작업, 프로젝트 활동은 MR 참조로 축약했습니다. MR 원문과 변경 경로는 changes와 파일별 담당 경로에 있습니다. 파일 해시는 실행기의 검토 계획에 저장돼 있고 전달 목록에는 모든 파일 경로를 유지합니다. 분할 본문 대신 구조화된 지적·인터페이스·구현·결정·검증·남은 작업을 제공합니다. 성공한 검사 로그는 실행 영수증에 있으며 명령·SHA·종료 코드·실행 결과는 유지합니다. 실패 로그와 현재 연결 Jira 요구사항·등록 명세·모든 현재 코드도 함께 제공합니다. 축약한 배경 이력에 관한 판단은 분할 검토 결과를 참고합니다.",
  };
}
const fail = (code) => { throw Object.assign(new UserError("Partitioned review did not complete. No partial review was published."), { code }); };
const filePath = (file) => file.deletedFile ? file.oldPath : file.newPath;
const lineCount = (value) => value ? value.split(/\r?\n/).length - Number(/\n$/.test(value)) : 0;
const location = (path, line, files) => Number.isSafeInteger(line) && line > 0 && files.some((file) => [file.oldPath, file.newPath].includes(path)
  && line <= Math.max(...[file.baseContent, file.headContent].filter((value) => typeof value === "string").map(lineCount), 0));

function integrationGroups(files, makePayload, maxBytes, maxCharacters) {
  const size = (selected) => {
    const serialized = JSON.stringify(makePayload(selected));
    return { bytes: Buffer.byteLength(serialized), characters: serialized.length };
  };
  const overhead = size([]);
  const singles = files.map((file) => size([file]));
  const availableBytes = maxBytes - overhead.bytes;
  const availableCharacters = maxCharacters - overhead.characters;
  const byteBudget = Math.min(availableBytes / 2, availableBytes - Math.max(...singles.map((n) => n.bytes - overhead.bytes)));
  const characterBudget = Math.min(availableCharacters / 2,
    availableCharacters - Math.max(...singles.map((n) => n.characters - overhead.characters)));
  if (singles.some((n) => n.bytes > maxBytes || n.characters > maxCharacters)) fail("review_integration_too_large");
  const withinGroup = (selected) => {
    const measured = size(selected);
    return measured.bytes - overhead.bytes <= byteBudget && measured.characters - overhead.characters <= characterBudget;
  };
  const groups = [];
  let pending = [];
  for (const file of files) {
    if (pending.length && !withinGroup([...pending, file])) { groups.push(pending); pending = []; }
    pending.push(file);
    if (!withinGroup(pending)) { groups.push(pending); pending = []; }
  }
  if (pending.length) groups.push(pending);
  return groups;
}

function validateAudit(result, files, phase, candidates = []) {
  const audit = result.reviewAudit;
  const paths = files.map(filePath);
  if (!audit || !Array.isArray(audit.coveredFiles) || audit.coveredFiles.length !== paths.length
    || new Set(audit.coveredFiles).size !== paths.length || paths.some((path) => !audit.coveredFiles.includes(path))
    || !Array.isArray(audit.interfaces) || !Array.isArray(audit.findings) || !Array.isArray(audit.resolutions)) fail("review_coverage_invalid");
  if (phase === "files" && (audit.interfaces.length !== paths.length || new Set(audit.interfaces.map((item) => item.file)).size !== paths.length
    || paths.some((path) => !audit.interfaces.some((item) => item.file === path && typeof item.summary === "string" && item.summary.trim())))) fail("review_coverage_invalid");
  const ids = new Set();
  for (const finding of audit.findings) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}(?::[A-Za-z][A-Za-z0-9_-]{0,31})?$/.test(finding.id ?? "") || ids.has(finding.id)
      || (phase === "files" && finding.id.includes(":"))
      || !["위험", "주의", "미미"].includes(finding.severity) || typeof finding.blocking !== "boolean"
      || (finding.blocking && finding.severity === "미미") || !location(finding.path, finding.line, files)
      || typeof finding.statement !== "string" || !finding.statement.trim()
      || !result.body.split(/\r?\n/).some((line) => line.includes(`[${finding.id}]`) && line.includes(`[${finding.severity}]`)
        && line.includes(`${finding.path}:${finding.line}`) && /\[(정확성|안전|데이터|계약|구현)\]/.test(line))) fail("review_audit_invalid");
    ids.add(finding.id);
  }
  if ((result.verdict === "hold") !== audit.findings.some((finding) => finding.blocking)) fail("review_audit_invalid");
  for (const line of result.body.split(/\r?\n/).filter((line) => /^\s*(?:[-*]|\d+[.)])\s+\[(위험|주의|미미)\]/.test(line))) {
    if (![...ids].some((id) => line.includes(`[${id}]`))) fail("review_audit_invalid");
  }
  if (phase === "files" && audit.resolutions.length) fail("review_audit_invalid");
  if (phase === "integration") {
    if (audit.resolutions.length !== candidates.length || new Set(audit.resolutions.map((item) => item.id)).size !== candidates.length) fail("review_integration_invalid");
    for (const candidate of candidates) {
      const resolution = audit.resolutions.find((item) => item.id === candidate.id);
      if (!resolution || !["retained", "dismissed"].includes(resolution.disposition) || typeof resolution.reason !== "string" || resolution.reason.trim().length < 16
        || !Array.isArray(resolution.evidence) || !resolution.evidence.length || resolution.evidence.some((ref) => !location(ref.path, ref.line, files))
        || (resolution.disposition === "retained") !== ids.has(candidate.id)) fail("review_integration_invalid");
    }
  }
  return audit;
}

export class PartitionedReviewRunner {
  constructor({ runner, dataDir, thresholdBytes = 1_000_000, batchBytes = 1_000_000, maxFilesPerBatch = 12 }) {
    Object.assign(this, { runner, dataDir, thresholdBytes, batchBytes, maxFilesPerBatch });
    this.maxInputBytes = runner.maxInputBytes ?? 2 * 1024 * 1024;
    this.maxInputCharacters = runner.maxInputCharacters ?? Infinity;
  }

  async review(input, { signal, assertCurrent = () => {}, onProgress = () => {} } = {}) {
    const fits = (payload, byteLimit = this.maxInputBytes) => {
      const serialized = JSON.stringify(payload);
      return Buffer.byteLength(serialized) <= byteLimit && serialized.length <= this.maxInputCharacters;
    };
    if (bytes(input) <= Math.min(this.thresholdBytes, this.maxInputBytes) && (input.changes.contextBytes ?? 0) <= this.thresholdBytes) {
      return this.runner.review(input, { signal });
    }
    const files = input.changes.files;
    if (!Array.isArray(files) || !files.length || files.length > 512 || new Set(files.map(filePath)).size !== files.length) fail("review_partition_invalid");
    const manifest = files.map((file) => ({ path: filePath(file), oldPath: file.oldPath, newPath: file.newPath,
      baseHash: hash(file.baseContent), headHash: hash(file.headContent), diffHash: hash(file.diff),
      oldMode: file.oldMode, newMode: file.newMode, deletedFile: file.deletedFile, newFile: file.newFile, renamedFile: file.renamedFile }));
    const { notesObservedAt, ...stableChanges } = input.changes;
    const identity = { version: 1, planner: [this.thresholdBytes, this.batchBytes, this.maxFilesPerBatch, this.maxInputBytes, this.maxInputCharacters],
      contextVersion: input.context?.contextVersion, contextHash: reviewDigest(input.context),
      changesHash: reviewDigest(stableChanges), verificationHash: hash(input.verification ?? null), promptHash: hash(REVIEW_SYSTEM_PROMPT),
      runner: [this.runner.constructor.name, this.runner.command, this.runner.model], manifest };
    const planId = hash(identity);
    const root = join(this.dataDir, "review-parts");
    const directory = join(root, planId);
    for (const path of [root, directory]) { await mkdir(path, { recursive: true, mode: 0o700 }); if ((await lstat(path)).isSymbolicLink()) fail("review_receipt_invalid"); }
    const checkpoint = async (progress) => { assertCurrent(); if (signal?.aborted) fail("runner_cancelled"); await onProgress({ planId, fileCount: files.length, ...progress }); };
    // Prior automated reviews remain in private history, without recursively repeating their bodies in every pass.
    const commonChanges = { ...input.changes, notes: (input.changes.notes ?? []).filter((note) => !note.body.includes("<!-- reviewbot:")) };
    const makeInput = (selected, phase, index, total, reports = [], findings = []) => ({ ...input,
      changes: { ...commonChanges, files: selected },
      reviewPartition: { phase, batchId: `b${String(index).padStart(3, "0")}`, batchIndex: index, totalBatches: total,
        requiredPaths: selected.map(filePath), fullManifest: manifest, priorFindings: findings,
        instructions: phase === "files" ? "이 묶음에 제공된 모든 파일의 변경 전후를 빠짐없이 검토합니다. 전체 연동의 최종 판단은 통합 단계에서 수행합니다." : "모든 현재 파일과 분할 결과를 함께 읽어 API 계약·호출 경로·데이터 정합성을 교차 검토합니다. priorFindings의 모든 ID를 resolutions에서 처리하고 유지할 지적은 동일 ID로 findings와 본문에 적습니다." },
      ...(phase !== "files" ? { partitionReports: reports } : {}),
    });
    const batches = [];
    let pending = [];
    for (const file of files) {
      const trial = [...pending, file];
      if (pending.length && (trial.length > this.maxFilesPerBatch || !fits(makeInput(trial, "files", 512, 512), Math.min(this.batchBytes, this.maxInputBytes)))) {
        batches.push(pending); pending = [];
      }
      pending.push(file);
      if (!fits(makeInput(pending, "files", 512, 512))) fail("review_file_too_large");
    }
    if (pending.length) batches.push(pending);
    const plan = { planId, headSha: input.changes.headSha, contextVersion: input.context?.contextVersion,
      identity, batches: batches.map((batch) => batch.map(filePath)) };
    const planPath = join(directory, "plan.json");
    try {
      const info = await lstat(planPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1_000_000
        || hash(JSON.parse(await readFile(planPath, "utf8"))) !== hash(plan)) fail("review_receipt_invalid");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      assertCurrent(); await writeFile(planPath, JSON.stringify(plan), { flag: "wx", mode: 0o600 });
    }
    const reports = [], findings = [];
    const receipt = async (name, payload, evaluate, validate) => {
      const path = join(directory, `${name}.json`), payloadHash = reviewDigest(payload);
      assertCurrent();
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 1_000_000) fail("review_receipt_invalid");
        const saved = JSON.parse(await readFile(path, "utf8"));
        if (saved.planId !== planId || saved.payloadHash !== payloadHash || saved.resultHash !== hash(saved.result)) fail("review_receipt_invalid");
        const restored = normalizeRunnerEnvelope(saved.result, payload);
        validate(restored); return restored;
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      const result = await evaluate(); validate(result); assertCurrent();
      const encoded = JSON.stringify({ planId, payloadHash, resultHash: hash(result), result });
      if (Buffer.byteLength(encoded) > 1_000_000) fail("review_receipt_invalid");
      await writeFile(path, encoded, { flag: "wx", mode: 0o600 });
      return result;
    };
    await checkpoint({ phase: "files", totalBatches: batches.length, completedBatches: 0 });
    for (let index = 0; index < batches.length; index++) {
      const payload = makeInput(batches[index], "files", index + 1, batches.length);
      const result = await receipt(`batch-${index + 1}`, payload, () => this.runner.review(payload, { signal }),
        (value) => validateAudit(value, batches[index], "files"));
      const prefix = `b${String(index + 1).padStart(3, "0")}`;
      const qualified = result.reviewAudit.findings.map((finding) => ({ ...finding, id: `${prefix}:${finding.id}` }));
      let qualifiedBody = result.body;
      for (const finding of result.reviewAudit.findings) qualifiedBody = qualifiedBody.replaceAll(`[${finding.id}]`, `[${prefix}:${finding.id}]`);
      findings.push(...qualified);
      reports.push({ batchId: prefix, files: batches[index].map(filePath), verdict: result.verdict,
        body: qualifiedBody, memory: result.memory, interfaces: result.reviewAudit.interfaces, findings: qualified });
      await checkpoint({ phase: "files", totalBatches: batches.length, completedBatches: index + 1 });
    }
    const integrationFiles = files.map((file) => ({ ...file, diff: "", baseContent: file.deletedFile ? file.baseContent : null }));
    const compact = (payload) => {
      const { mrSource, changedPaths, contextBytes, contextByteBreakdown, notesObservedAt, ...changes } = payload.changes;
      return { ...payload, changes, context: integrationContext(input.context),
        reviewPartition: { ...payload.reviewPartition, fullManifest: payload.changes.files.map((file) => ({ path: filePath(file) })) },
        partitionReports: reports.map(({ body, ...report }) => report),
        ...(input.verification ? { verification: { ...input.verification,
          checks: input.verification.checks.map((check) => check.result === "passed" ? { ...check, output: "" } : check) } } : {}) };
    };
    let payload = makeInput(integrationFiles, "integration", batches.length + 1, batches.length, reports, findings);
    if (!fits(payload)) payload = compact(payload);
    let integrated;
    let integrationCoverage = "";
    let integrationDetails = {};
    if (fits(payload)) {
      await checkpoint({ phase: "integration", totalBatches: batches.length, completedBatches: batches.length });
      integrated = await receipt("integration", payload, () => this.runner.review(payload, { signal }),
        (value) => validateAudit(value, integrationFiles, "integration", findings));
    } else {
      const pairPayload = (selected, candidates, index) => {
        const value = compact(makeInput(selected, "integration", index, batches.length, reports, candidates));
        value.reviewPartition.batchId = `i${String(index).padStart(6, "0")}`;
        value.reviewPartition.integrationMode = "group_pair";
        value.reviewPartition.instructions = "이 연동 묶음에 제공된 모든 원문 파일의 계약·호출·데이터 흐름을 대조합니다. 다른 파일의 인터페이스와 작업 맥락은 partitionReports를 참고하며 원문 부재를 구분합니다. 제공된 requiredPaths만 coveredFiles에 적고 priorFindings를 모두 근거와 함께 처리합니다. 새 지적은 콜론 없는 F1 같은 ID로, 기존 지적은 전달된 ID 그대로 작성합니다.";
        return value;
      };
      const groups = integrationGroups(integrationFiles, (selected) => pairPayload(selected, findings, 999999),
        this.maxInputBytes, this.maxInputCharacters);
      const pairs = [];
      for (let left = 0; left < groups.length; left++) {
        for (let right = left + 1; right < groups.length; right++) pairs.push([left, right]);
      }
      if (!pairs.length) pairs.push([0, 0]);
      integrationDetails = { integrationGroups: groups.length, totalIntegrationPairs: pairs.length };
      const selectedFor = ([left, right]) => left === right ? groups[left] : [...groups[left], ...groups[right]];
      const candidatesFor = (selected) => findings.filter((finding) => selected.some((file) =>
        [file.oldPath, file.newPath].includes(finding.path)));
      for (const pair of pairs) {
        const selected = selectedFor(pair);
        if (!fits(pairPayload(selected, candidatesFor(selected), 999999))) fail("review_integration_too_large");
      }
      const integrationReports = [];
      const candidates = [...findings];
      for (let index = 0; index < pairs.length; index++) {
        const selected = selectedFor(pairs[index]), prior = candidatesFor(selected);
        const pairInput = pairPayload(selected, prior, index + 1);
        await checkpoint({ phase: "integration", totalBatches: batches.length, completedBatches: batches.length,
          integrationGroups: groups.length, totalIntegrationPairs: pairs.length, completedIntegrationPairs: index });
        const result = await receipt(`links-v1-${pairs[index][0]}-${pairs[index][1]}`, pairInput,
          () => this.runner.review(pairInput, { signal }), (value) => {
            validateAudit(value, selected, "integration", prior);
            for (const finding of value.reviewAudit.findings) {
              const original = prior.find((item) => item.id === finding.id);
              if (original ? original.path !== finding.path || original.line !== finding.line : finding.id.includes(":")) {
                fail("review_audit_invalid");
              }
            }
          });
        const known = new Set(prior.map((finding) => finding.id));
        const qualified = result.reviewAudit.findings.map((finding) => {
          if (known.has(finding.id)) return finding;
          const added = { ...finding, id: `i${String(index + 1).padStart(6, "0")}:${finding.id}` };
          candidates.push(added);
          return added;
        });
        integrationReports.push({ groupPair: pairs[index], files: selected.map(filePath), verdict: result.verdict,
          memory: result.memory, findings: qualified, resolutions: result.reviewAudit.resolutions });
      }
      payload = compact(makeInput([], "synthesis", pairs.length + 1, batches.length, reports, candidates));
      payload.reviewPartition.requiredPaths = files.map(filePath);
      payload.reviewPartition.fullManifest = manifest.map(({ path }) => ({ path }));
      payload.reviewPartition.instructions = SYNTHESIS_REVIEW_PROMPT;
      payload.reviewPartition.synthesisPolicyHash = hash(SYNTHESIS_REVIEW_PROMPT);
      payload.integrationReports = integrationReports;
      if (candidates.length > 512 || !fits(payload)) fail("review_integration_too_large");
      await checkpoint({ phase: "synthesis", totalBatches: batches.length, completedBatches: batches.length,
        integrationGroups: groups.length, totalIntegrationPairs: pairs.length, completedIntegrationPairs: pairs.length });
      integrated = await receipt("synthesis-v1", payload, () => this.runner.review(payload, { signal }), (value) => {
        validateAudit(value, integrationFiles, "integration", candidates);
        for (const finding of value.reviewAudit.findings) {
          const prior = candidates.find((candidate) => candidate.id === finding.id);
          if (!prior || prior.path !== finding.path || prior.line !== finding.line) fail("review_integration_invalid");
          const versions = [prior, ...integrationReports.flatMap((report) => report.findings.filter((item) => item.id === finding.id))];
          if (!versions.some((item) => item.severity === finding.severity && item.blocking === finding.blocking)) fail("review_integration_invalid");
        }
        for (const resolution of value.reviewAudit.resolutions.filter((item) => item.disposition === "dismissed")) {
          const supported = integrationReports.flatMap((report) => report.resolutions).some((item) =>
            item.id === resolution.id && item.disposition === "dismissed" && resolution.evidence.every((ref) =>
              item.evidence.some((source) => source.path === ref.path && source.line === ref.line)));
          if (!supported) fail("review_integration_invalid");
        }
      });
      integrationCoverage = ` 연동 그룹 ${groups.length}개의 모든 ${pairs.length}/${pairs.length}개 조합을 원문으로 대조하고 결과를 종합했습니다.`;
      findings.push(...candidates.filter((candidate) => !findings.some((finding) => finding.id === candidate.id)));
    }
    let body = integrated.body;
    for (const finding of [...findings, ...integrated.reviewAudit.findings]) body = body.replaceAll(`[${finding.id}]`, "");
    const result = normalizeReviewResult({ verdict: integrated.verdict, body: `${body}\n\n### 분할 검토 범위\n텍스트 파일 ${files.length}/${files.length}개를 ${batches.length}개 묶음으로 검토한 뒤 전체 현재 파일과 분할 결과의 연동 검토를 완료했습니다.${integrationCoverage}`, memory: integrated.memory }, input);
    await checkpoint({ phase: "completed", totalBatches: batches.length, completedBatches: batches.length,
      ...integrationDetails, ...(integrationDetails.totalIntegrationPairs ? { completedIntegrationPairs: integrationDetails.totalIntegrationPairs } : {}) });
    return result;
  }
}
