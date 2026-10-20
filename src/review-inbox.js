import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveDataDir, UserError } from "./core.js";

const ACTIONS = new Set(["open", "update", "close", "reopen", "merge", "approval", "approved", "unapproval", "unapproved"]);
const STATES = new Set(["opened", "closed", "merged", "locked"]);
const USERNAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}$/;

function invalid() {
  throw new UserError("Invalid review webhook data.");
}

function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value;
}

function id(value) {
  if (!Number.isSafeInteger(value) || value < 1) invalid();
  return value;
}

function text(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") invalid();
  return value;
}

function timestamp(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") invalid();
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  const parsed = Date.parse(value);
  if (!match || !Number.isFinite(parsed) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) invalid();
  const date = new Date(`${match[1]}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== match[1]) invalid();
  return `${new Date(parsed).toISOString().slice(0, 19)}.${(match[5] ?? "").padEnd(9, "0")}Z`;
}

function sha(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(value)) invalid();
  return value.toLowerCase();
}

function mentioned(body, username) {
  if (!username) return false;
  let fence = null;
  let quote = false;
  const lines = [];
  for (const line of body.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      continue;
    }
    if (!line.trim()) { quote = false; lines.push(""); continue; }
    if (/^ {0,3}>/.test(line)) { quote = true; continue; }
    if (marker) { fence = marker[1]; quote = false; continue; }
    if (quote && !/^ {0,3}(?:#{1,6}\s|[-*_]{3,}\s*$|(?:[-+*]|\d+[.)])\s)/.test(line)) continue;
    quote = false;
    if (/^(?: {4}|\t)/.test(line)) continue;
    lines.push(line);
  }
  const visible = lines.join("\n")
    .replace(/<(pre|code|blockquote)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, " ")
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/\b(?:[a-z][a-z\d+.-]*:\/\/|www\.)[^\s<>]+/gi, " ")
    .replace(/\b(?:[a-z\d-]+\.)+[a-z]{2,}[/?#][^\s<>]*/gi, " ")
    .replace(/\b[A-Z\d._%+-]+@[A-Z\d.-]+\.[A-Z]{2,}\b/gi, " ");
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}_@./:\\\\-])@${escaped}(?![\\p{L}\\p{N}_@/-]|\\.[\\p{L}\\p{N}_-])`, "iu").test(visible);
}

function reviewerMatches(reviewers, reviewerIds, target) {
  if (reviewers !== undefined && reviewers !== null && !Array.isArray(reviewers)) invalid();
  if (reviewerIds !== undefined && reviewerIds !== null && !Array.isArray(reviewerIds)) invalid();
  let found = false;
  for (const reviewer of reviewers ?? []) {
    object(reviewer);
    if (reviewer.id !== undefined) id(reviewer.id);
    const username = text(reviewer.username);
    if ((target.userId !== null && reviewer.id === target.userId)
      || (target.username && username.toLowerCase() === target.username)) found = true;
  }
  for (const reviewerId of reviewerIds ?? []) {
    id(reviewerId);
    if (target.userId !== null && reviewerId === target.userId) found = true;
  }
  return found;
}

function normalize(eventType, payload, target) {
  object(payload);
  const attrs = object(payload.object_attributes);
  const isNote = eventType === "Note Hook";
  if (payload.object_kind !== (isNote ? "note" : "merge_request")) invalid();
  if (isNote) {
    if (typeof attrs.noteable_type !== "string") invalid();
    if (attrs.noteable_type !== "MergeRequest") return { ignored: "not_merge_request" };
    const authorId = attrs.author_id ?? payload.user?.id;
    if (authorId !== undefined && authorId !== null) id(authorId);
    if (target.botUserId !== null && (authorId === undefined || authorId === null)) invalid();
    if (target.botUserId !== null && authorId === target.botUserId) return { ignored: "own_comment" };
  }
  const mr = isNote ? object(payload.merge_request) : attrs;
  const project = payload.project === undefined ? undefined : object(payload.project);
  const projectId = id(project?.id ?? payload.project_id);
  if (payload.project_id !== undefined && id(payload.project_id) !== projectId) invalid();
  const mrIid = id(mr.iid);
  const action = attrs.action ?? (isNote ? "create" : undefined);
  if (!(isNote ? ["create", "update"].includes(action) : ACTIONS.has(action))) invalid();
  if (!STATES.has(mr.state)) invalid();
  if (mr.draft !== undefined && typeof mr.draft !== "boolean") invalid();
  if (mr.work_in_progress !== undefined && typeof mr.work_in_progress !== "boolean") invalid();
  if (mr.last_commit !== undefined && mr.last_commit !== null) object(mr.last_commit);
  const description = text(mr.description);
  if (isNote && typeof attrs.note !== "string") invalid();
  const reasons = [];
  if (mentioned(description, target.username)) reasons.push("description_mention");
  if (isNote && mentioned(attrs.note, target.username)) reasons.push("comment_mention");
  if (reviewerMatches(isNote ? mr.reviewers : payload.reviewers ?? mr.reviewers, mr.reviewer_ids, target)) reasons.push("reviewer_assigned");
  return {
    projectId, mrIid, state: mr.state, draft: mr.draft ?? mr.work_in_progress ?? false,
    headSha: sha(mr.last_commit?.id), updatedAt: timestamp(mr.updated_at), reasons,
  };
}

function fingerprint(eventType, eventId, payload) {
  if (eventId !== undefined && eventId !== null && (typeof eventId !== "string" || eventId.length > 256 || /[\r\n\0]/.test(eventId))) invalid();
  let value;
  try { value = JSON.stringify([eventType, eventId || payload]); } catch { invalid(); }
  return createHash("sha256").update(value).digest("hex");
}

export class ReviewInbox {
  constructor({ dataDir, username = "", userId = null, botUserId = null, projectIds = [] } = {}) {
    if (typeof username !== "string" || (username && !USERNAME.test(username))) invalid();
    if (userId !== null) id(userId);
    if (botUserId !== null) id(botUserId);
    if (!Array.isArray(projectIds)) invalid();
    this.projectIds = new Set(projectIds.map(id));
    this.target = { username: username.toLowerCase(), userId, botUserId };
    if (dataDir !== undefined && (typeof dataDir !== "string" || !dataDir.trim())) invalid();
    const directory = resolveDataDir(dataDir);
    mkdirSync(directory, { recursive: true });
    try { chmodSync(directory, 0o700); } catch { /* Windows uses inherited ACLs. */ }
    this.db = new DatabaseSync(join(directory, "reviews.sqlite3"));
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS review_events (
        event_key TEXT PRIMARY KEY,
        received_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS review_merge_requests (
        project_id INTEGER NOT NULL,
        mr_iid INTEGER NOT NULL,
        tracked INTEGER NOT NULL,
        state TEXT NOT NULL,
        draft INTEGER NOT NULL,
        head_sha TEXT,
        updated_at TEXT,
        reasons TEXT NOT NULL,
        PRIMARY KEY (project_id, mr_iid)
      );
      CREATE TABLE IF NOT EXISTS review_requests (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL,
        mr_iid INTEGER NOT NULL,
        head_sha TEXT NOT NULL,
        reasons TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'held', 'superseded', 'cancelled')),
        created_at TEXT NOT NULL,
        UNIQUE (project_id, mr_iid, head_sha)
      );
    `);
    try { chmodSync(join(directory, "reviews.sqlite3"), 0o600); } catch { /* Windows uses inherited ACLs. */ }
  }

  ingest({ eventType, eventId, payload }) {
    if (!["Merge Request Hook", "Note Hook"].includes(eventType)) return { status: "ignored", reason: "unsupported_event" };
    if (!this.projectIds.size) return { status: "ignored", reason: "not_configured" };
    const event = normalize(eventType, payload, this.target);
    if (event.ignored) return { status: "ignored", reason: event.ignored };
    if (!this.projectIds.has(event.projectId)) return { status: "ignored", reason: "project_not_allowed" };
    const key = fingerprint(eventType, eventId, payload);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const inserted = this.db.prepare("INSERT OR IGNORE INTO review_events VALUES (?, ?)").run(key, new Date().toISOString());
      if (!inserted.changes) { this.db.exec("COMMIT"); return { status: "duplicate" }; }
      const old = this.db.prepare("SELECT * FROM review_merge_requests WHERE project_id = ? AND mr_iid = ?").get(event.projectId, event.mrIid);
      // Equal or undated snapshots cannot safely replace a dated, conflicting revision.
      const newer = !old || (event.updatedAt !== null && (old.updated_at === null || event.updatedAt > old.updated_at));
      const current = newer ? event : {
        ...event, state: old.state, draft: Boolean(old.draft), headSha: old.head_sha, updatedAt: old.updated_at,
      };
      // A simultaneous close is safe to honor; a reopen requires a newer snapshot.
      if (old && event.updatedAt !== null && event.updatedAt === old.updated_at && ["closed", "merged", "locked"].includes(event.state)) current.state = event.state;
      const reasons = [...new Set([...(old ? JSON.parse(old.reasons) : []), ...event.reasons])];
      const tracked = Boolean(old?.tracked || reasons.length);
      this.db.prepare(`INSERT INTO review_merge_requests VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, mr_iid) DO UPDATE SET tracked = excluded.tracked,
        state = excluded.state, draft = excluded.draft, head_sha = excluded.head_sha,
        updated_at = excluded.updated_at, reasons = excluded.reasons`)
        .run(current.projectId, current.mrIid, Number(tracked), current.state, Number(current.draft), current.headSha, current.updatedAt, JSON.stringify(reasons));
      let result;
      if (!tracked) {
        result = { status: "ignored", reason: "not_requested" };
      } else if (current.state !== "opened") {
        this.db.prepare("UPDATE review_requests SET status = 'cancelled' WHERE project_id = ? AND mr_iid = ? AND status IN ('pending', 'held')")
          .run(current.projectId, current.mrIid);
        result = { status: "cancelled", reason: "mr_not_open" };
      } else if (!current.headSha) {
        this.db.prepare("UPDATE review_requests SET status = 'superseded' WHERE project_id = ? AND mr_iid = ? AND status IN ('pending', 'held')")
          .run(current.projectId, current.mrIid);
        result = { status: "tracked", reason: "sha_pending" };
      } else {
        this.db.prepare("UPDATE review_requests SET status = 'superseded' WHERE project_id = ? AND mr_iid = ? AND head_sha <> ? AND status IN ('pending', 'held')")
          .run(current.projectId, current.mrIid, current.headSha);
        const existing = this.db.prepare("SELECT id, reasons FROM review_requests WHERE project_id = ? AND mr_iid = ? AND head_sha = ?")
          .get(current.projectId, current.mrIid, current.headSha);
        const requestReasons = [...new Set([...reasons, ...(existing ? JSON.parse(existing.reasons) : []),
          ...(old?.tracked && current.headSha !== old.head_sha ? ["new_commit"] : [])])];
        this.db.prepare(`INSERT INTO review_requests(project_id, mr_iid, head_sha, reasons, status, created_at) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(project_id, mr_iid, head_sha) DO UPDATE SET reasons = excluded.reasons, status = excluded.status`)
          .run(current.projectId, current.mrIid, current.headSha, JSON.stringify(requestReasons), current.draft ? "held" : "pending", new Date().toISOString());
        const request = this.db.prepare("SELECT id FROM review_requests WHERE project_id = ? AND mr_iid = ? AND head_sha = ?")
          .get(current.projectId, current.mrIid, current.headSha);
        result = { status: current.draft ? "held" : "queued", requestId: Number(request.id) };
      }
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  status() {
    const count = (sql) => Number(this.db.prepare(sql).get().count);
    return {
      pending: count("SELECT COUNT(*) AS count FROM review_requests WHERE status = 'pending'"),
      tracked: count("SELECT COUNT(*) AS count FROM review_merge_requests WHERE tracked = 1"),
      held: count("SELECT COUNT(*) AS count FROM review_requests WHERE status = 'held'"),
      closed: count("SELECT COUNT(*) AS count FROM review_merge_requests WHERE tracked = 1 AND state IN ('closed', 'merged')"),
      events: count("SELECT COUNT(*) AS count FROM review_events"),
    };
  }

  listPending({ limit = 20 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new UserError("limit must be an integer between 1 and 100.");
    return this.db.prepare("SELECT id, project_id, mr_iid, head_sha, reasons FROM review_requests WHERE status = 'pending' ORDER BY id LIMIT ?").all(limit)
      .map((row) => ({ requestId: Number(row.id), projectId: row.project_id, mrIid: row.mr_iid, headSha: row.head_sha, reasons: JSON.parse(row.reasons) }));
  }

  close() {
    this.db.close();
  }
}
