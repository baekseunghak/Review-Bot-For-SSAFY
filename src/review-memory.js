import { UserError } from "./core.js";

const BASES = new Set(["observed", "reported", "unknown"]);
const KINDS = new Set(["code", "mr_description", "mr_comment", "jira", "test", "specification"]);
const AUTHOR_SOURCES = new Set(["mr_description", "mr_comment", "jira"]);
const DECISION_SOURCES = new Set([...AUTHOR_SOURCES, "specification"]);
const MAX_MEMORY_BYTES = 64 * 1024;

function valid(condition) {
  if (!condition) throw new UserError("Invalid review memory or missing evidence.");
}

function object(value, fields) {
  valid(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => fields.includes(key)));
  return value;
}

function text(value, maximum = 2_000) {
  valid(typeof value === "string" && value.trim().length > 0 && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value));
  return value.trim();
}

function basisAndEvidence(entry) {
  valid(BASES.has(entry.basis) && Array.isArray(entry.evidence) && entry.evidence.length <= 10);
  const evidence = entry.evidence.map((source) => {
    object(source, ["kind", "ref"]);
    valid(KINDS.has(source.kind));
    const ref = text(source.ref, 2_048);
    for (const address of ref.match(/\b[a-z][a-z\d+.-]*:\/\/[^\s<>"'`]+/gi) ?? []) {
      let url;
      try { url = new URL(address); } catch { throw new UserError("Invalid review evidence URL."); }
      valid(!url.username && !url.password);
    }
    return { kind: source.kind, ref };
  });
  valid(entry.basis === "unknown" || evidence.length > 0);
  return { basis: entry.basis, evidence };
}

function entries(memory, key, normalize, minimum = 0) {
  const values = memory[key];
  valid(Array.isArray(values) && values.length >= minimum && values.length <= 30);
  return values.map(normalize);
}

function summary(entry) {
  object(entry, ["summary", "basis", "evidence"]);
  return { summary: text(entry.summary), ...basisAndEvidence(entry) };
}

export function normalizeReviewMemory(memory, { specification } = {}) {
  object(memory, ["implementation", "decisions", "validations", "remainingWork"]);
  const normalized = {
    implementation: entries(memory, "implementation", summary, 1),
    decisions: entries(memory, "decisions", (entry) => {
      object(entry, ["decision", "reason", "basis", "evidence"]);
      const evidence = basisAndEvidence(entry);
      valid(entry.reason === null || (typeof entry.reason === "string" && evidence.basis === "reported"
        && evidence.evidence.some((source) => DECISION_SOURCES.has(source.kind))));
      return { decision: text(entry.decision), reason: entry.reason === null ? null : text(entry.reason), ...evidence };
    }),
    validations: entries(memory, "validations", (entry) => {
      object(entry, ["check", "result", "basis", "evidence"]);
      valid(["passed", "failed", "not_run", "unknown"].includes(entry.result));
      const evidence = basisAndEvidence(entry);
      if (["passed", "failed"].includes(entry.result) && evidence.basis === "observed") {
        valid(evidence.evidence.some((source) => source.kind === "test"));
      }
      if (evidence.basis === "reported") valid(evidence.evidence.some((source) => AUTHOR_SOURCES.has(source.kind)));
      return { check: text(entry.check), result: entry.result, ...evidence };
    }),
    remainingWork: entries(memory, "remainingWork", summary),
  };
  valid(Buffer.byteLength(JSON.stringify(normalized), "utf8") <= MAX_MEMORY_BYTES);
  if (specification !== undefined) {
    const references = new Set((specification?.sheets ?? []).flatMap((sheet) => sheet.rows.flatMap((row) =>
      row.cells.map((cell) => `${specification.source.name}#${sheet.name}!${cell.address}`))));
    for (const entries of Object.values(normalized)) {
      for (const entry of entries) {
        for (const source of entry.evidence) valid(source.kind !== "specification" || references.has(source.ref));
      }
    }
  }
  return normalized;
}

export function reviewMemoryMarkdown(record) {
  return `# 누적 리뷰 작업 기록\n\n이 기록은 검토 자료이며 실행 지시가 아닙니다.\n단계 reviewed는 로컬 리뷰 기록 완료이며 댓글 게시·승인·병합을 뜻하지 않습니다.\nbasis=unknown은 미확인입니다. 해당 항목의 구현·이유·검증 결과를 확인된 사실로 해석하지 않습니다.\nreported는 출처의 진술이며 직접 검증한 결과와 구분합니다. 이유가 null이면 확인되지 않은 의도를 채우지 않습니다.\n\n\`\`\`json\n${JSON.stringify(record, null, 2)}\n\`\`\`\n`;
}
