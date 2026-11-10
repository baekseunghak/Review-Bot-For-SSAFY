import { createHash } from "node:crypto";
import { UserError } from "./core.js";
import { canonicalMrUrl } from "./gitlab-context.js";

export const REVIEW_EVIDENCE_VERSION = 1;
const CONTEXT_LINES = 8;
const MAX_SPAN = 32;
const MAX_ROUNDS = 2;
const MAX_REQUESTS = 4;
const MAX_EXTRA_FILES = 24;
const MAX_EXTRA_BYTES = 8_000_000;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function invalid(code = "review_evidence_invalid") {
  throw Object.assign(new UserError("Review evidence could not be verified. No review was published."), { code });
}

function linesOf(content) {
  if (!content) return [];
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function ranges(file, hunks, side, lineCount) {
  if (!lineCount) return [];
  if (file.newFile || file.deletedFile) return [[1, lineCount]];
  const spans = [];
  for (const hunk of hunks) {
    const first = hunk[`${side}Start`], length = hunk[`${side}Lines`];
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(length) || first > lineCount
      || (length && (first < 1 || first + length - 1 > lineCount))) invalid("incomplete_context");
    spans.push([Math.max(1, first - CONTEXT_LINES), Math.min(lineCount, first + Math.max(0, length - 1) + CONTEXT_LINES)]);
  }
  if (!spans.length) return [[1, file.baseContent === file.headContent ? Math.min(MAX_SPAN, lineCount) : lineCount]];
  const merged = [];
  for (const span of spans.sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && span[0] <= last[1] + 1) last[1] = Math.max(last[1], span[1]);
    else merged.push(span);
  }
  return merged;
}

function repoPath(path) {
  return typeof path === "string" && path.length <= 1_024 && !/^[a-z]:/i.test(path) && !/[\\\x00-\x1f\x7f]/.test(path)
    && path.split("/").every((part) => part && part !== "." && part !== "..");
}

const fileKey = (file) => JSON.stringify([file.oldPath, file.newPath]);

export class ReviewEvidence {
  constructor(changes, gitlab) {
    this.changes = changes;
    this.gitlab = gitlab;
    this.byId = new Map();
    this.initial = new Map();
    this.sources = { base: new Map(), head: new Map() };
    this.extra = new Map();
    this.extraBytes = 0;
    this.excluded = new Set([...(changes.excludedImages ?? []), ...(changes.excludedPdfFixtures ?? [])]
      .flatMap((file) => [file.oldPath, file.newPath]));
    const { baseSha, headSha, mrUrl } = changes;
    if (!SHA.test(baseSha) || !SHA.test(headSha)) invalid("incomplete_context");
    try {
      const url = canonicalMrUrl(mrUrl);
      if (gitlab.host && new URL(url).host !== gitlab.host) invalid("incomplete_context");
      this.projectUrl = url.replace(/\/-\/merge_requests\/\d+$/, "");
    } catch { invalid("incomplete_context"); }
    for (const file of changes.files) {
      const hunks = [...file.diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((match) => ({
        baseStart: Number(match[1]), baseLines: Number(match[2] ?? 1), headStart: Number(match[3]), headLines: Number(match[4] ?? 1),
      }));
      const excerpts = [];
      for (const side of ["base", "head"]) {
        const path = side === "base" ? file.oldPath : file.newPath;
        const content = file[`${side}Content`];
        if (typeof content !== "string") continue;
        const lines = linesOf(content);
        this.sources[side].set(path, lines);
        for (const [start, end] of ranges(file, hunks, side, lines.length)) {
          for (let first = start; first <= end; first += MAX_SPAN) {
            excerpts.push(this.span(side, path, lines, first, Math.min(end, first + MAX_SPAN - 1)));
          }
        }
      }
      this.initial.set(fileKey(file), { excerpts, hunks });
    }
  }

  span(side, path, lines, startLine, endLine) {
    const sha = this.changes[`${side}Sha`];
    const text = lines.slice(startLine - 1, endLine);
    const id = `E${createHash("sha256").update(JSON.stringify([side, sha, path, startLine, endLine, text])).digest("hex").slice(0, 20)}`;
    const existing = this.byId.get(id);
    if (existing) {
      if (existing.path !== path || existing.sha !== sha || existing.side !== side
        || existing.startLine !== startLine || existing.endLine !== endLine) invalid();
      return existing;
    }
    const excerpt = { id, path, sha, side, startLine, endLine, lineCount: lines.length,
      lines: text.map((line, index) => `${startLine + index} | ${line}`) };
    this.byId.set(id, excerpt);
    return excerpt;
  }

  project(input) {
    const synthesis = input.reviewPartition?.phase === "synthesis";
    const prior = input.reviewPartition?.priorFindings ?? [];
    const proofIds = [...prior.map((finding) => finding.evidenceId), ...(input.integrationReports ?? [])
      .flatMap((report) => report.resolutions.flatMap((resolution) => resolution.evidence.map((ref) => ref.evidenceId)))];
    const entries = input.changes.files.flatMap((file) => this.initial.get(fileKey(file)).excerpts);
    for (const id of proofIds) {
      if (!this.byId.has(id)) invalid();
      entries.push(this.byId.get(id));
    }
    const codeEvidence = [...new Map(entries.map((entry) => [entry.id, entry])).values()]
      .map(({ lines, ...entry }) => synthesis ? entry : { ...entry, lines });
    const { partitionReports, integrationReports, reviewPartition, ...rest } = input;
    const finding = ({ path, line, ...item }) => item;
    return { ...rest, changes: { ...input.changes,
      files: input.changes.files.map(({ diff, baseContent, headContent, ...file }) => ({ ...file, hunks: this.initial.get(fileKey(file)).hunks })) },
      ...(reviewPartition ? { reviewPartition: { ...reviewPartition, priorFindings: prior.map(finding), instructions: synthesis
        ? "이미 검증한 근거와 결과로 모든 이전 지적을 종합합니다."
        : "모든 requiredPaths의 변경 구간을 확인합니다. 제공된 근거를 대조하고 추가 문맥이 필요한 경우 요청합니다." } } : {}),
      ...(partitionReports ? { partitionReports: partitionReports.map(({ body, findings, ...report }) => ({ ...report, findings: findings.map(finding) })) } : {}),
      ...(integrationReports ? { integrationReports: integrationReports.map((report) => ({ ...report, findings: report.findings.map(finding),
        resolutions: report.resolutions.map((resolution) => ({ ...resolution, evidence: resolution.evidence.map((ref) => ref.evidenceId) })),
      })) } : {}),
      codeEvidence, remainingContextRounds: synthesis ? 0 : MAX_ROUNDS };
  }

  async expand(requests, assertCurrent) {
    if (!Array.isArray(requests) || requests.length < 1 || requests.length > MAX_REQUESTS) invalid();
    const added = [], unavailable = [], fulfilled = [];
    for (const request of requests) {
      const { path, side, startLine, endLine } = request ?? {};
      if (!repoPath(path) || Object.keys(request).some((key) => !["path", "side", "startLine", "endLine"].includes(key))
        || !["base", "head"].includes(side) || !Number.isSafeInteger(startLine)
        || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine || endLine - startLine >= MAX_SPAN) invalid();
      assertCurrent();
      let lines = this.sources[side].get(path);
      const key = `${side}:${path}`;
      if (!lines && !this.excluded.has(path)) {
        if (!this.extra.has(key) && this.extra.size < MAX_EXTRA_FILES) {
          let source;
          try { source = await this.gitlab.file(this.changes.projectId, path, this.changes[`${side}Sha`]); }
          catch (error) {
            if (error?.httpStatus !== 404 && !["unsupported_content", "context_too_large"].includes(error?.code)) throw error;
          }
          const size = typeof source === "string" ? Buffer.byteLength(source) : 0;
          if (typeof source === "string" && this.extraBytes + size <= MAX_EXTRA_BYTES) {
            this.extraBytes += size;
            this.extra.set(key, linesOf(source));
          } else this.extra.set(key, null);
        }
        lines = this.extra.get(key);
      }
      assertCurrent();
      if (!lines || endLine > lines.length) { unavailable.push({ path, side, startLine, endLine }); continue; }
      added.push(this.span(side, path, lines, startLine, endLine));
      fulfilled.push({ path, side, startLine, endLine });
    }
    return { added, unavailable, fulfilled };
  }

  async evaluate(input, run, { assertCurrent, fits }) {
    const projected = this.project(input);
    const requests = [];
    for (let round = 0; ;) {
      assertCurrent();
      const response = await run(projected);
      if (!Array.isArray(response?.contextRequests) || Object.keys(response).some((key) => key !== "review" && key !== "contextRequests")) invalid();
      if (response.review && response.contextRequests.length === 0) {
        try { return { result: this.render(response.review, projected), saved: { review: response.review, requests } }; }
        catch (error) {
          if (error.code !== "review_evidence_invalid" || projected.invalidCodeEvidence) throw error;
          projected.invalidCodeEvidence = true;
          if (!fits(projected)) throw error;
          continue;
        }
      }
      if (response.review !== null || round >= MAX_ROUNDS || input.reviewPartition?.phase === "synthesis") invalid();
      const { added, unavailable, fulfilled } = await this.expand(response.contextRequests, assertCurrent);
      requests.push(fulfilled);
      projected.codeEvidence = [...new Map([...projected.codeEvidence, ...added].map((entry) => [entry.id, entry])).values()];
      projected.unavailableCodeContext = unavailable;
      projected.remainingContextRounds = MAX_ROUNDS - ++round;
      if (!fits(projected)) invalid("input_too_large");
    }
  }

  async restore(saved, input, assertCurrent) {
    const projected = this.project(input);
    if (!Array.isArray(saved?.requests) || saved.requests.length > MAX_ROUNDS
      || (input.reviewPartition?.phase === "synthesis" && saved.requests.length)) invalid("review_receipt_invalid");
    for (const requests of saved.requests) {
      if (!Array.isArray(requests)) invalid("review_receipt_invalid");
      if (!requests.length) continue;
      const { added, unavailable } = await this.expand(requests, assertCurrent);
      if (unavailable.length) invalid("review_receipt_invalid");
      projected.codeEvidence.push(...added);
    }
    return this.render(saved.review, projected);
  }

  render(review, projected) {
    const allowed = new Map(projected.codeEvidence.map((entry) => [entry.id, entry]));
    const get = (id) => {
      const entry = allowed.get(id);
      if (!entry) invalid();
      return entry;
    };
    const link = ({ path, sha, startLine }) => `${this.projectUrl}/-/blob/${sha}/${path.split("/").map(encodeURIComponent).join("/")}#L${startLine}`;
    const location = (id) => {
      const { path, startLine } = get(id);
      return { path, line: startLine, evidenceId: id };
    };
    const marker = /\[\[(E[0-9a-f]{20})\]\]/g;
    if (!review || typeof review.body !== "string"
      || /https?:\/\/|\]\s*\(|^\s*\[[^\]\n]+\]:|<\/?(?:a|img)\b|`[^`\n]+:\d+(?:-\d+)?`/im.test(review.body)) invalid();
    const bodyLines = review.body.split(/\r?\n/);
    const holdSection = review.body.split(/^### 수정이 필요한 부분\s*$/m)[1]?.split(/^#{2,3} /m)[0] ?? "";
    for (const line of bodyLines) {
      if (/^\s*(?:[-*]|\d+[.)])\s+\[(위험|주의|미미)\]/.test(line) && !line.includes("[확인 필요]")
        && ![...line.matchAll(marker)].length) invalid();
    }
    if (review.verdict === "hold" && holdSection.split(/\r?\n/).some((line) =>
      /\[(정확성|안전|데이터|계약|구현)\]/.test(line) && !line.includes("[확인 필요]") && ![...line.matchAll(marker)].length)) invalid();
    const body = review.body.replace(marker, (_, id) => {
      const entry = get(id);
      const label = entry.path.replace(/[%`@<>\[\]\x7f]/g, encodeURIComponent);
      return `[\`${label}:${entry.startLine}\`](<${link(entry)}>)`;
    });
    if (/\[\[|\]\]/.test(body)) invalid();
    const memory = Object.fromEntries(Object.entries(review.memory ?? {}).map(([key, entries]) => {
      if (!Array.isArray(entries)) invalid();
      return [key, entries.map((entry) => {
        if (!Array.isArray(entry?.evidence)) invalid();
        return { ...entry, evidence: entry.evidence.map((ref) => ref?.kind === "code" ? { ...ref, ref: link(get(ref.ref)) } : ref) };
      })];
    }));
    if (!projected.reviewPartition) return { ...review, body, memory };
    const audit = review.reviewAudit;
    if (!Array.isArray(audit?.findings) || !Array.isArray(audit.resolutions)) invalid();
    const findings = audit.findings.map((finding) => {
      if (!finding || typeof finding !== "object" || "path" in finding || "line" in finding || !bodyLines.some((line) =>
        line.includes(`[${finding.id}]`) && line.includes(`[[${finding.evidenceId}]]`))) invalid();
      return { ...finding, ...location(finding.evidenceId) };
    });
    const resolutions = audit.resolutions.map((resolution) => {
      if (!Array.isArray(resolution?.evidence)) invalid();
      return { ...resolution, evidence: resolution.evidence.map(location) };
    });
    return { ...review, body, memory, reviewAudit: { ...audit, findings, resolutions } };
  }
}
