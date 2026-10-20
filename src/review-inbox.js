import { createHash, randomUUID } from "node:crypto";
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
  const legacy = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?) (UTC|[+-]\d{4})$/.exec(value);
  if (legacy) {
    const zone = legacy[3] === "UTC" ? "Z" : `${legacy[3].slice(0, 3)}:${legacy[3].slice(3)}`;
    value = `${legacy[1]}T${legacy[2]}${zone}`;
  }
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

function workerTime(value = new Date()) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new UserError("Invalid worker time.");
  return parsed.toISOString();
}

function workerDuration(value, maximum = 86_400_000) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new UserError("Invalid worker duration.");
  return value;
}

function workerWord(value) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(value)) throw new UserError("Invalid worker state.");
  return value;
}

function workerArtifact(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UserError("Invalid worker artifact.");
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw new UserError("Invalid worker artifact."); }
  if (typeof encoded !== "string" || !encoded.startsWith("{")) throw new UserError("Invalid worker artifact.");
  if (Buffer.byteLength(encoded, "utf8") > 262_144) throw new UserError("Worker artifact exceeds its storage limit.");
  return encoded;
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
      CREATE TABLE IF NOT EXISTS review_executions (
        request_id INTEGER PRIMARY KEY REFERENCES review_requests(id),
        status TEXT NOT NULL CHECK (status IN ('running', 'retry', 'completed', 'failed')),
        stage TEXT NOT NULL,
        artifact TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        lease_token TEXT,
        lease_expires_at TEXT,
        next_attempt_at TEXT,
        error_code TEXT,
        updated_at TEXT NOT NULL
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
        const resumed = newer && current.state === "opened" && !current.draft;
        if (resumed) {
          this.db.prepare(`UPDATE review_executions SET status = 'retry', stage = 'queued', artifact = '{}', attempts = 0,
            lease_token = NULL, lease_expires_at = NULL, next_attempt_at = '1970-01-01T00:00:00.000Z',
            error_code = NULL, updated_at = ? WHERE request_id = ? AND status = 'completed' AND stage = 'skipped'`)
            .run(new Date().toISOString(), request.id);
        }
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
      pending: count("SELECT COUNT(*) AS count FROM review_requests r WHERE status = 'pending' AND NOT EXISTS (SELECT 1 FROM review_executions e WHERE e.request_id = r.id AND e.status IN ('completed', 'failed'))"),
      tracked: count("SELECT COUNT(*) AS count FROM review_merge_requests WHERE tracked = 1"),
      held: count("SELECT COUNT(*) AS count FROM review_requests WHERE status = 'held'"),
      closed: count("SELECT COUNT(*) AS count FROM review_merge_requests WHERE tracked = 1 AND state IN ('closed', 'merged')"),
      events: count("SELECT COUNT(*) AS count FROM review_events"),
    };
  }

  listPending({ limit = 20 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new UserError("limit must be an integer between 1 and 100.");
    return this.db.prepare("SELECT id, project_id, mr_iid, head_sha, reasons FROM review_requests r WHERE status = 'pending' AND NOT EXISTS (SELECT 1 FROM review_executions e WHERE e.request_id = r.id AND e.status IN ('completed', 'failed')) ORDER BY id LIMIT ?").all(limit)
      .map((row) => ({ requestId: Number(row.id), projectId: row.project_id, mrIid: row.mr_iid, headSha: row.head_sha, reasons: JSON.parse(row.reasons) }));
  }

  claimNext({ now = new Date(), leaseMs = 300_000 } = {}) {
    const at = workerTime(now);
    const expiresAt = new Date(Date.parse(at) + workerDuration(leaseMs)).toISOString();
    if (!this.projectIds.size) return null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const allowed = [...this.projectIds];
      this.db.prepare(`UPDATE review_executions AS e SET status = 'completed', stage = 'skipped',
        lease_token = NULL, lease_expires_at = NULL, next_attempt_at = NULL,
        error_code = 'request_obsolete', updated_at = ?
        WHERE e.stage NOT IN ('posting', 'posted', 'notifying', 'notification_unknown')
          AND (e.status = 'retry' OR (e.status = 'running' AND e.lease_expires_at <= ?))
          AND EXISTS (SELECT 1 FROM review_requests r JOIN review_merge_requests m
            ON m.project_id = r.project_id AND m.mr_iid = r.mr_iid
            WHERE r.id = e.request_id AND r.project_id IN (${allowed.map(() => "?").join(",")})
              AND (r.status <> 'pending' OR m.state <> 'opened' OR m.draft <> 0 OR m.head_sha IS NOT r.head_sha))`)
        .run(at, at, ...allowed);
      const row = this.db.prepare(`SELECT r.*, e.stage, e.artifact, e.attempts FROM review_requests r
        JOIN review_merge_requests m ON m.project_id = r.project_id AND m.mr_iid = r.mr_iid
        LEFT JOIN review_executions e ON e.request_id = r.id
        WHERE ((r.status = 'pending' AND m.state = 'opened' AND m.draft = 0 AND m.head_sha = r.head_sha)
            OR e.stage IN ('posting', 'posted', 'notifying', 'notification_unknown'))
          AND r.project_id IN (${allowed.map(() => "?").join(",")})
          AND (e.request_id IS NULL OR (e.status = 'retry' AND e.next_attempt_at <= ?)
            OR (e.status = 'running' AND e.lease_expires_at <= ?))
        ORDER BY r.id LIMIT 1`).get(...allowed, at, at);
      if (!row) { this.db.exec("COMMIT"); return null; }
      const leaseToken = randomUUID();
      const attempt = Number(row.attempts ?? 0) + 1;
      const stage = row.stage ?? "queued";
      const artifact = row.artifact ?? "{}";
      this.db.prepare(`INSERT INTO review_executions
        (request_id, status, stage, artifact, attempts, lease_token, lease_expires_at, updated_at)
        VALUES (?, 'running', ?, ?, ?, ?, ?, ?)
        ON CONFLICT(request_id) DO UPDATE SET status = 'running', attempts = excluded.attempts,
          lease_token = excluded.lease_token, lease_expires_at = excluded.lease_expires_at,
          next_attempt_at = NULL, updated_at = excluded.updated_at`)
        .run(row.id, stage, artifact, attempt, leaseToken, expiresAt, at);
      this.db.exec("COMMIT");
      return {
        id: Number(row.id), requestId: Number(row.id), projectId: row.project_id,
        mrIid: row.mr_iid, headSha: row.head_sha, reasons: JSON.parse(row.reasons),
        leaseToken, leaseExpiresAt: expiresAt, attempt, stage, artifact: JSON.parse(artifact),
      };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  activeClaim(requestId, token, at) {
    id(requestId);
    if (typeof token !== "string" || !/^[a-f\d-]{36}$/i.test(token)) throw new UserError("Invalid worker claim.");
    const row = this.db.prepare(`SELECT * FROM review_executions WHERE request_id = ?
      AND status = 'running' AND lease_token = ? AND lease_expires_at > ?`).get(requestId, token, at);
    if (!row) throw new UserError("Review worker claim has expired or is no longer owned.");
    return row;
  }

  renewClaim(requestId, token, { now = new Date(), leaseMs = 300_000 } = {}) {
    const at = workerTime(now);
    const expiresAt = new Date(Date.parse(at) + workerDuration(leaseMs)).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.activeClaim(requestId, token, at);
      this.db.prepare("UPDATE review_executions SET lease_expires_at = ?, updated_at = ? WHERE request_id = ?")
        .run(expiresAt, at, requestId);
      this.db.exec("COMMIT");
      return { leaseExpiresAt: expiresAt };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  isCurrent(requestId, token, { now = new Date() } = {}) {
    const at = workerTime(now);
    try { this.activeClaim(requestId, token, at); } catch (error) {
      if (error instanceof UserError) return false;
      throw error;
    }
    const row = this.db.prepare(`SELECT r.project_id FROM review_requests r
      JOIN review_merge_requests m ON m.project_id = r.project_id AND m.mr_iid = r.mr_iid
      WHERE r.id = ? AND r.status = 'pending' AND m.state = 'opened' AND m.draft = 0 AND m.head_sha = r.head_sha`).get(requestId);
    return Boolean(row && this.projectIds.has(row.project_id));
  }

  checkpoint(requestId, token, { stage, artifact = {}, now = new Date() } = {}) {
    const at = workerTime(now);
    workerWord(stage);
    workerArtifact(artifact);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.activeClaim(requestId, token, at);
      const merged = { ...JSON.parse(row.artifact), ...artifact };
      this.db.prepare("UPDATE review_executions SET stage = ?, artifact = ?, updated_at = ? WHERE request_id = ?")
        .run(stage, workerArtifact(merged), at, requestId);
      this.db.exec("COMMIT");
      return { stage, artifact: merged };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  finish(requestId, token, { now = new Date() } = {}) {
    const at = workerTime(now);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.activeClaim(requestId, token, at);
      this.db.prepare(`UPDATE review_executions SET status = 'completed', stage = CASE stage WHEN 'notifying' THEN 'completed' ELSE stage END, lease_token = NULL,
        lease_expires_at = NULL, next_attempt_at = NULL, error_code = NULL, updated_at = ? WHERE request_id = ?`).run(at, requestId);
      this.db.exec("COMMIT");
      return { status: "completed" };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  retry(requestId, token, { errorCode, delayMs = 60_000, maxAttempts = 5, now = new Date() } = {}) {
    const at = workerTime(now);
    workerWord(errorCode);
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) throw new UserError("Invalid worker attempt limit.");
    const nextAt = new Date(Date.parse(at) + workerDuration(delayMs)).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.activeClaim(requestId, token, at);
      const status = row.attempts >= maxAttempts ? "failed" : "retry";
      this.db.prepare(`UPDATE review_executions SET status = ?, lease_token = NULL, lease_expires_at = NULL,
        next_attempt_at = ?, error_code = ?, updated_at = ? WHERE request_id = ?`)
        .run(status, status === "retry" ? nextAt : null, errorCode, at, requestId);
      this.db.exec("COMMIT");
      return { status, nextAttemptAt: status === "retry" ? nextAt : null };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  retryFailed(requestId, { allowNotificationDuplicate = false, now = new Date() } = {}) {
    id(requestId);
    const at = workerTime(now);
    if (typeof allowNotificationDuplicate !== "boolean") throw new UserError("Invalid notification retry choice.");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT * FROM review_executions WHERE request_id = ? AND status = 'failed'").get(requestId);
      if (!row) throw new UserError("Only a failed review execution can be retried.");
      const uncertain = ["notifying", "notification_unknown"].includes(row.stage);
      if (uncertain && !allowNotificationDuplicate) throw new UserError("Notification delivery is uncertain; retry requires explicit duplicate-delivery permission.");
      const stage = uncertain ? "posted" : row.stage;
      this.db.prepare(`UPDATE review_executions SET status = 'retry', stage = ?, attempts = 0,
        lease_token = NULL, lease_expires_at = NULL, next_attempt_at = ?, error_code = NULL,
        updated_at = ? WHERE request_id = ?`).run(stage, at, at, requestId);
      this.db.exec("COMMIT");
      return { requestId, status: "retry", stage, nextAttemptAt: at };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  workerStatus({ limit = 20 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new UserError("limit must be an integer between 1 and 100.");
    const counts = { running: 0, retry: 0, completed: 0, failed: 0 };
    for (const row of this.db.prepare("SELECT status, COUNT(*) AS count FROM review_executions GROUP BY status").all()) counts[row.status] = Number(row.count);
    const jobs = this.db.prepare(`SELECT request_id, stage, status, attempts, error_code, next_attempt_at
      FROM review_executions ORDER BY updated_at DESC, request_id DESC LIMIT ?`).all(limit).map((row) => ({
      requestId: Number(row.request_id), stage: row.stage, status: row.status,
      attempt: Number(row.attempts), lastErrorCode: row.error_code, nextAttemptAt: row.next_attempt_at,
    }));
    return { counts, jobs };
  }

  close() {
    this.db.close();
  }
}
