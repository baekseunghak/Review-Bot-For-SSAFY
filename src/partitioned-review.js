import { createHash } from "node:crypto";
import { mkdir, lstat, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, win32 } from "node:path";
import { UserError } from "./core.js";
import { normalizeReviewResult, REVIEW_SYSTEM_PROMPT } from "./review-runner.js";

const bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const volatileFields = new Set(["preparedAt", "notesObservedAt", "localPath", "localPaths", "markdownPath", "storagePath"]);
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
const fail = (code) => { throw Object.assign(new UserError("Partitioned review did not complete. No partial review was published."), { code }); };
const filePath = (file) => file.deletedFile ? file.oldPath : file.newPath;
const lineCount = (value) => value ? value.split(/\r?\n/).length - Number(/\n$/.test(value)) : 0;
const location = (path, line, files) => Number.isSafeInteger(line) && line > 0 && files.some((file) => [file.oldPath, file.newPath].includes(path)
  && line <= Math.max(...[file.baseContent, file.headContent].filter((value) => typeof value === "string").map(lineCount), 0));

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
  }

  async review(input, { signal, assertCurrent = () => {}, onProgress = () => {} } = {}) {
    if (bytes(input) <= Math.min(this.thresholdBytes, this.maxInputBytes) && (input.changes.contextBytes ?? 0) <= this.thresholdBytes) {
      return this.runner.review(input, { signal });
    }
    const files = input.changes.files;
    if (!Array.isArray(files) || !files.length || files.length > 512 || new Set(files.map(filePath)).size !== files.length) fail("review_partition_invalid");
    const manifest = files.map((file) => ({ path: filePath(file), oldPath: file.oldPath, newPath: file.newPath,
      baseHash: hash(file.baseContent), headHash: hash(file.headContent), diffHash: hash(file.diff),
      oldMode: file.oldMode, newMode: file.newMode, deletedFile: file.deletedFile, newFile: file.newFile, renamedFile: file.renamedFile }));
    const { notesObservedAt, ...stableChanges } = input.changes;
    const identity = { version: 1, planner: [this.thresholdBytes, this.batchBytes, this.maxFilesPerBatch, this.maxInputBytes],
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
      ...(phase === "integration" ? { partitionReports: reports } : {}),
    });
    const batches = [];
    let pending = [];
    for (const file of files) {
      const trial = [...pending, file];
      if (pending.length && (trial.length > this.maxFilesPerBatch || bytes(makeInput(trial, "files", 512, 512)) > Math.min(this.batchBytes, this.maxInputBytes))) {
        batches.push(pending); pending = [];
      }
      pending.push(file);
      if (bytes(makeInput(pending, "files", 512, 512)) > this.maxInputBytes) fail("review_file_too_large");
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
        const normalized = normalizeReviewResult({ verdict: saved.result.verdict, body: saved.result.body, memory: saved.result.memory }, payload);
        const restored = { ...normalized, reviewAudit: saved.result.reviewAudit };
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
    const payload = makeInput(integrationFiles, "integration", batches.length + 1, batches.length, reports, findings);
    if (bytes(payload) > this.maxInputBytes) fail("review_integration_too_large");
    await checkpoint({ phase: "integration", totalBatches: batches.length, completedBatches: batches.length });
    const integrated = await receipt("integration", payload, () => this.runner.review(payload, { signal }),
      (value) => validateAudit(value, integrationFiles, "integration", findings));
    let body = integrated.body;
    for (const finding of [...findings, ...integrated.reviewAudit.findings]) body = body.replaceAll(`[${finding.id}]`, "");
    const result = normalizeReviewResult({ verdict: integrated.verdict, body: `${body}\n\n### 분할 검토 범위\n텍스트 파일 ${files.length}/${files.length}개를 ${batches.length}개 묶음으로 검토한 뒤 전체 현재 파일과 분할 결과의 연동 검토를 완료했습니다.`, memory: integrated.memory }, input);
    await checkpoint({ phase: "completed", totalBatches: batches.length, completedBatches: batches.length });
    return result;
  }
}
