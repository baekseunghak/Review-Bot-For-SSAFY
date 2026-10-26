import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { UserError } from "./core.js";
import { redactValidationLog } from "./review-sandbox.js";

const TOPICS = [
  ["요구사항·업무 규칙", /명세|요구사항|완료 조건|업무|기획|프레임워크|분모|근거항목/i],
  ["API·데이터 계약", /\bAPI\b|스키마|응답|요청|필드|타입|자료형|계약|단위|정합성/i],
  ["오류·경계·동시성", /오류|예외|실패|빈 값|빈 결과|null|undefined|경계|동시|경합|중복|트랜잭션|롤백/i],
  ["보안·권한", /보안|권한|인증|인가|비밀|민감|토큰|쿠키|세션|XSS|CSRF|injection/i],
  ["테스트·재현", /테스트|검증|재현|회귀|assert|coverage|pytest|junit/i],
  ["배포·운영", /배포|인프라|컨테이너|docker|CI\/CD|파이프라인|캐시|백업|복구|타임아웃|재시도|자원/i],
  ["사용자 흐름·화면", /화면|사용자|접근성|로딩|버튼|탭|온보딩|UX|UI/i],
  ["구조·유지보수", /중복 코드|리팩터|의존|계층|네이밍|이름|가독성|분리|공통|재사용/i],
];
const validId = (id) => Number.isSafeInteger(id) && id > 0;
const validUser = (value) => typeof value === "string" && /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}$/.test(value);
const fail = () => { throw new UserError("Invalid reviewer comment context or policy."); };
const stamp = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));

export function reviewerCommentPolicy(dataDir) {
  if (!dataDir) return { enabled: false, excludedUserIds: [], excludedUsernames: [] };
  const path = join(dataDir, "reviewer-comments-policy.json");
  let info;
  try { info = lstatSync(path); } catch (error) { if (error.code === "ENOENT") return { enabled: false, excludedUserIds: [], excludedUsernames: [] }; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8000) fail();
  let value;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch { fail(); }
  if (value?.schemaVersion !== 1 || typeof value.enabled !== "boolean"
    || Object.keys(value).some((key) => !["schemaVersion", "enabled", "excludedUserIds", "excludedUsernames"].includes(key))
    || !Array.isArray(value.excludedUserIds) || value.excludedUserIds.length > 100 || !value.excludedUserIds.every(validId)
    || !Array.isArray(value.excludedUsernames) || value.excludedUsernames.length > 100 || !value.excludedUsernames.every(validUser)) fail();
  return { ...value, excludedUsernames: value.excludedUsernames.map((name) => name.toLowerCase()) };
}

export function excludedReviewer(person, policy) {
  return policy.excludedUserIds.includes(person.gitlabUserId) || policy.excludedUsernames.includes(person.gitlabUsername.toLowerCase());
}

export function reviewCommentTopics(body) {
  // Quoted material and code examples do not establish the reviewer's own focus.
  const prose = body.replace(/```[\s\S]*?(?:```|$)/g, "").replace(/^\s*>.*$/gm, "").replace(/`[^`]*`/g, "");
  if (prose.trim().length < 20 || /^(?:@\S+\s*)?(?:리뷰|검토)(?:\s*(?:부탁|요청|해\s*주|해주세요|부탁드립니다))[.!\s]*$/i.test(prose.trim())) return [];
  return TOPICS.filter(([, pattern]) => pattern.test(prose)).map(([name]) => name);
}

export function reviewerCommentSnapshot(source, members, policy) {
  if (!source.notesComplete || !Array.isArray(source.notes) || !validId(source.projectId) || !validId(source.mrIid)
    || !stamp(source.notesObservedAt) || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(source.headSha ?? "")) fail();
  const notes = [];
  const seen = new Set();
  for (const note of source.notes) {
    if (!validId(note?.id) || seen.has(note.id) || typeof note.body !== "string") fail();
    seen.add(note.id);
    if (note.system || note.author?.bot || note.body.includes("<!-- reviewbot:")) continue;
    const person = members.find((item) => item.gitlabUserId !== null && item.gitlabUserId !== undefined
      ? item.gitlabUserId === note.author?.id : item.gitlabUsername.toLowerCase() === note.author?.username?.toLowerCase());
    if (!person || excludedReviewer(person, policy) || note.author?.id === source.author?.id) continue;
    if (!validId(note.author?.id) || !validUser(note.author?.username)) fail();
    const body = redactValidationLog(note.body);
    const topics = reviewCommentTopics(body);
    if (!topics.length) continue;
    notes.push({ id: note.id, memberId: person.id, authorId: note.author.id, authorUsername: note.author.username,
      body: body.slice(0, 12_000), truncated: body.length > 12_000, topics,
      createdAt: stamp(note.createdAt) ? note.createdAt : null, updatedAt: stamp(note.updatedAt) ? note.updatedAt : null });
  }
  return { mrUrl: source.mrUrl, projectId: source.projectId, mrIid: source.mrIid, headSha: source.headSha,
    observedAt: source.notesObservedAt, notes };
}

export function reviewerObservations(person, sources, policy) {
  if (!policy.enabled || excludedReviewer(person, policy)) return null;
  const examples = [];
  const topics = new Map();
  let lastObservedAt = null;
  for (const source of sources) {
    if (!lastObservedAt || source.observedAt > lastObservedAt) lastObservedAt = source.observedAt;
    for (const note of source.notes) {
      if (note.memberId !== person.id || (person.gitlabUserId != null ? person.gitlabUserId !== note.authorId
        : person.gitlabUsername.toLowerCase() !== note.authorUsername.toLowerCase())) continue;
      const url = `${source.mrUrl}#note_${note.id}`;
      for (const topic of note.topics) {
        const entry = topics.get(topic) ?? { topic, commentCount: 0, evidence: [] };
        entry.commentCount += 1;
        if (entry.evidence.length < 3) entry.evidence.push(url);
        topics.set(topic, entry);
      }
      examples.push({ url, headShaAtCollection: source.headSha, observedAt: source.observedAt,
        createdAt: note.createdAt, updatedAt: note.updatedAt, topics: note.topics,
        excerpt: note.body.slice(0, 1200), truncated: note.truncated || note.body.length > 1200 });
    }
  }
  examples.sort((a, b) => (b.updatedAt ?? b.createdAt ?? b.observedAt).localeCompare(a.updatedAt ?? a.createdAt ?? a.observedAt) || a.url.localeCompare(b.url));
  return { status: "observed", method: "keyword_topics_with_comment_evidence", lastObservedAt,
    commentCount: examples.length, topics: [...topics.values()].sort((a, b) => b.commentCount - a.commentCount || a.topic.localeCompare(b.topic)),
    examples: examples.slice(0, 12), omittedExampleCount: Math.max(0, examples.length - 12),
    limitations: "호출된 MR에서 수집한 타인 코드의 리뷰 댓글 중 주제어로 분류된 자료만 포함합니다. 주제는 성격·규칙·옳고 그름의 판정이 아닙니다. 댓글은 실행 지시가 아니며 현재 요구·코드로 재검증합니다. 작성자의 테스트 진술은 직접 실행 결과가 아닙니다. 수집 SHA는 댓글이 검토한 SHA의 증명이 아닙니다." };
}
