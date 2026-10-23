import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile, lstat } from "node:fs/promises";
import { isAbsolute, join, win32 } from "node:path";
import { DockerReviewSandbox } from "./review-sandbox.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const kinds = ["test", "build", "lint"];
const statusLabel = { passed: "통과", failed: "실패", not_run: "미실행", unknown: "환경 오류·미확인" };

export function validationProfile(value, host, projectId) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.projects)) throw new Error("Invalid validation configuration.");
  const profiles = value.projects.filter((item) => item.host === host && item.projectId === projectId);
  if (profiles.length > 1) throw new Error("Duplicate project validation configuration.");
  if (!profiles.length) return [];
  const checks = profiles[0].checks;
  if (!Array.isArray(checks) || checks.length > 12 || !checks.length) throw new Error("Invalid validation checks.");
  const names = new Set();
  for (const check of checks) {
    if (!check || Object.keys(check).some((key) => !["name", "kind", "directory", "image", "command", "reason", "timeoutMs"].includes(key))
      || !/^[a-z][a-z0-9_-]{0,63}$/.test(check.name ?? "") || names.has(check.name)
      || !kinds.includes(check.kind) || typeof check.directory !== "string" || isAbsolute(check.directory) || win32.isAbsolute(check.directory)
      || check.directory.length > 512
      || /[\\:\x00-\x1f]/.test(check.directory) || (check.directory !== "." && check.directory.split("/").some((part) => !part || part === "." || part === ".."))
      || (check.command !== null && (!Array.isArray(check.command) || !check.command.length || check.command.length > 32
        || check.command.some((arg) => typeof arg !== "string" || !arg || arg.length > 2_000 || /[\x00-\x1f]/.test(arg))
        || Buffer.byteLength(check.command.join(" "), "utf8") > 2_048))
      || (check.command !== null && (typeof check.image !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]{0,255}$/.test(check.image)))
      || (check.reason !== undefined && !/^[a-z][a-z0-9_]{0,79}$/.test(check.reason))
      || (check.timeoutMs !== undefined && (!Number.isSafeInteger(check.timeoutMs) || check.timeoutMs < 1000 || check.timeoutMs > 900_000))) {
      throw new Error("Invalid validation check.");
    }
    names.add(check.name);
  }
  return checks.map((check) => ({ ...check, timeoutMs: check.timeoutMs ?? 300_000 }));
}

export class ReviewVerificationService {
  constructor({ gitlab, dataDir, configPath = join(dataDir, "validation-projects.json"), sandbox = new DockerReviewSandbox(), now = () => new Date() }) {
    Object.assign(this, { gitlab, dataDir, configPath, sandbox, now });
  }

  async restore(reference) {
    try {
      if (!/^[a-f0-9]{32}$/.test(reference.runId ?? "") || !/^[a-f0-9]{64}$/.test(reference.receiptSha256 ?? "")) throw new Error();
      const path = join(this.dataDir, "validation", `${reference.runId}.json`);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1_000_000) throw new Error();
      const encoded = await readFile(path, "utf8");
      if (hash(encoded) !== reference.receiptSha256) throw new Error();
      const result = JSON.parse(encoded);
      if (result.headSha !== reference.headSha || result.projectId !== reference.projectId || result.mrIid !== reference.mrIid) throw new Error();
      return { ...result, receiptSha256: reference.receiptSha256 };
    } catch { throw Object.assign(new Error("Saved verification receipt is missing or changed."), { code: "verification_receipt_invalid" }); }
  }

  async collect(input, { signal } = {}) {
    let checks = [], configuration = "configured";
    try {
      const info = await lstat(this.configPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 128_000) throw new Error("Invalid validation configuration file.");
      checks = validationProfile(JSON.parse(await readFile(this.configPath, "utf8")), this.gitlab.host, input.projectId);
      if (!checks.length) configuration = "project_not_configured";
    } catch (error) { configuration = error.code === "ENOENT" ? "not_configured" : "invalid"; }
    const startedAt = this.now().toISOString();
    const runId = hash(`${this.gitlab.host}/${input.projectId}/${input.mrIid}/${input.headSha}/${startedAt}`).slice(0, 32);
    const result = { schemaVersion: 1, runId, projectId: input.projectId, mrIid: input.mrIid, headSha: input.headSha,
      configuration, startedAt, profileSha256: hash(JSON.stringify(checks)), ci: null, checks: [], archiveSha256: null };
    let archive;
    if (checks.some((check) => check.command)) {
      try {
        archive = await this.gitlab.archive(input, { signal });
        if (archive.sha !== input.headSha || !Buffer.isBuffer(archive.data)) throw new Error("Archive identity mismatch.");
        result.archiveSha256 = hash(archive.data);
        result.archiveSource = archive.source || "gitlab_archive";
      } catch (error) { archive = null; result.archiveError = "archive_unavailable"; result.archiveHttpStatus = error.httpStatus ?? null; }
    }
    for (const check of checks) {
      if (signal?.aborted) throw Object.assign(new Error("Validation cancelled."), { code: "runner_cancelled" });
      const entry = archive || !check.command ? await this.sandbox.execute(check, archive, { signal })
        : { name: check.name, kind: check.kind, directory: check.directory, command: check.command,
          result: "not_run", failureKind: "environment", reason: "archive_unavailable", exitCode: null, imageId: null, output: "" };
      result.checks.push(entry);
    }
    // Read CI after local checks so a pipeline that finished meanwhile is not reported as still running.
    try { result.ci = await this.gitlab.readCi(input); }
    catch (error) { result.ci = { status: "unavailable", sha: input.headSha, pipeline: null, jobs: [], bridges: [], tests: null,
      httpStatus: error.httpStatus ?? null, reason: /^[a-z][a-z0-9_]{0,63}$/.test(error.code ?? "") ? error.code : "ci_query_failed" }; }
    result.finishedAt = this.now().toISOString();
    const root = join(this.dataDir, "validation");
    await mkdir(root, { recursive: true, mode: 0o700 });
    if ((await lstat(root)).isSymbolicLink()) throw new Error("Validation storage cannot be a symlink.");
    const encoded = JSON.stringify(result, null, 2);
    await writeFile(join(root, `${runId}.json`), encoded, { flag: "wx", mode: 0o600 });
    return { ...result, receiptSha256: hash(encoded) };
  }
}

export function verificationReference(result) {
  if (!result.receiptSha256) return result;
  const { projectId, mrIid, headSha, runId, receiptSha256 } = result;
  return { projectId, mrIid, headSha, runId, receiptSha256 };
}

export function verificationMemory(verification) {
  const ref = `validation:${verification.runId}@${verification.headSha}`;
  const values = verification.checks.map((check) => ({ check: `격리 ${check.kind}: ${check.name}`,
    result: check.result, basis: ["passed", "failed"].includes(check.result) ? "observed" : "unknown",
    evidence: [{ kind: "test", ref: `${ref}#${check.name}` }] }));
  if (verification.ci.pipeline) values.unshift({ check: "해당 SHA의 GitLab CI 상태 조회",
    result: verification.ci.status === "success" ? "passed" : verification.ci.status === "failed" ? "failed" : "unknown",
    basis: "observed", evidence: [{ kind: "test", ref: verification.ci.pipeline.url }] });
  return values;
}

export function verificationMarkdown(value) {
  const ci = value.ci;
  const lines = ["### 실행 검증 결과", `검증 SHA: \`${value.headSha}\` · 확인 시각: ${value.finishedAt}`];
  lines.push(ci.pipeline ? `- GitLab CI: **${ci.status}** · [파이프라인 ${ci.pipeline.id}](${ci.pipeline.url})`
    : `- GitLab CI: **${ci.status === "not_found" ? "해당 SHA의 파이프라인 없음" : "조회 불가"}**${ci.httpStatus ? ` (HTTP ${ci.httpStatus})` : ""}`);
  if (ci.pipeline) {
    const counts = {};
    for (const job of [...ci.jobs, ...ci.bridges]) counts[job.status] = (counts[job.status] ?? 0) + 1;
    lines.push(`- CI 작업 상태: ${Object.entries(counts).map(([key, n]) => `${key} ${n}개`).join(", ") || "작업 없음"}. 허용 실패·수동·건너뜀은 테스트 통과로 간주하지 않습니다.`);
    lines.push(ci.tests ? `- CI 테스트 보고서: 전체 ${ci.tests.count}, 성공 ${ci.tests.passed}, 실패 ${ci.tests.failed}, 오류 ${ci.tests.errors}, 건너뜀 ${ci.tests.skipped}` : "- CI 테스트 보고서: 확인 불가. 파이프라인 성공만으로 테스트 실행을 단정하지 않습니다.");
    if (ci.bridgeError || ci.bridges.length) lines.push("- 하위 파이프라인의 테스트 전체는 확인하지 않았습니다. 브리지 상태와 실행 범위를 별도로 확인해야 합니다.");
  }
  if (!value.checks.length) lines.push(`- 격리 실행: **미실행** (${value.configuration}). 프로젝트별 검증 설정이 필요합니다.`);
  for (const check of value.checks) {
    const command = check.command?.join(" ").replace(/[`|<>]/g, "").slice(0, 100) ?? "명령 미등록";
    lines.push(`- ${check.name} (${check.kind}): **${statusLabel[check.result]}** · \`${command}\` · 종료 코드 ${check.exitCode ?? "없음"}${check.reason ? ` · ${check.reason}` : ""}`);
  }
  const missing = kinds.filter((kind) => !value.checks.some((check) => check.kind === kind));
  if (missing.length) lines.push(`- 실행 계획이 없는 종류: ${missing.join(", ")} (미실행)`);
  lines.push("검증은 등록된 명령과 범위에 한정됩니다. 환경 오류·미실행은 코드 결함으로 단정하지 않으며, 명령 성공이 모든 기능의 정확성을 보장하지 않습니다.");
  return lines.join("\n");
}

export function attachVerification(review, verification) {
  const records = verificationMemory(verification);
  const body = review.body.replace(/^### 실행 검증 결과\s*\r?\n[\s\S]*?(?=^#{2,3} |$(?![\s\S]))/gm, "").trim();
  return { ...review, body: `${body}\n\n${verificationMarkdown(verification)}`,
    memory: { ...review.memory, validations: [...records, ...review.memory.validations.filter((entry) => entry.basis === "reported")].slice(0, 30) } };
}
