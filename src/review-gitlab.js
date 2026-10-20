import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { UserError } from "./core.js";
import { canonicalMrUrl, extractIssueKeys, parseGitlabMrUrl } from "./gitlab-context.js";

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const PAGE_SIZE = 100;
const MAX_PAGES = 100;

function fail(code, message) {
  const error = new UserError(message);
  error.code = code;
  throw error;
}

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail("invalid_input", `${label} must be a positive integer.`);
  return value;
}

function path(value) {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("\\")
    || /[\x00-\x1f]/.test(value) || value.split("/").some((part) => !part || part === "." || part === "..")) {
    fail("invalid_gitlab_response", "GitLab changed file path is invalid.");
  }
  return value;
}

function hash(value) { return createHash("sha256").update(value).digest("hex"); }

async function run(file, args, { input, ...options } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, {
      encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
      ...options, shell: false,
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export function reviewCommentMarker({ host, projectId, mrIid, headSha }) {
  integer(projectId, "projectId");
  integer(mrIid, "mrIid");
  if (typeof host !== "string" || !SHA.test(headSha ?? "")) fail("invalid_input", "Review comment identity is invalid.");
  return `<!-- reviewbot:${hash(`${host.toLowerCase()}/${projectId}/${mrIid}/${headSha.toLowerCase()}`)} -->`;
}

export class GitlabReviewClient {
  constructor({ host, allowedProjectIds = [], runImpl = run, maxContextBytes = 1_000_000 } = {}) {
    let url;
    try { url = new URL(`https://${host}`); } catch { fail("invalid_input", "GitLab host is invalid."); }
    if (typeof host !== "string" || !host || host.startsWith("-") || url.host !== host.toLowerCase()
      || url.pathname !== "/" || url.username || url.password || url.search || url.hash) {
      fail("invalid_input", "GitLab host must contain only a hostname and optional port.");
    }
    if (!Array.isArray(allowedProjectIds) || !allowedProjectIds.length) fail("invalid_input", "GitLab project allowlist is required.");
    this.host = url.host;
    this.allowedProjectIds = new Set(allowedProjectIds.map((id) => integer(id, "projectId")));
    if (!Number.isSafeInteger(maxContextBytes) || maxContextBytes < 1024 || maxContextBytes > 16_000_000) {
      fail("invalid_input", "maxContextBytes must be between 1024 and 16000000.");
    }
    this.maxContextBytes = maxContextBytes;
    this.runImpl = runImpl;
    this.userPromise = null;
  }

  address({ projectId, mrIid }) {
    integer(projectId, "projectId");
    integer(mrIid, "mrIid");
    if (!this.allowedProjectIds.has(projectId)) fail("project_not_allowed", "GitLab project is not allowed.");
    return `projects/${projectId}/merge_requests/${mrIid}`;
  }

  async api(endpoint, { method = "GET", body } = {}) {
    const args = ["api", endpoint, "--hostname", this.host, "--method", method];
    if (body !== undefined) args.push("--input", "-");
    let value;
    try {
      const result = await this.runImpl("glab", args, {
        shell: false, ...(body === undefined ? {} : { input: JSON.stringify(body) }),
        maxBuffer: Math.max(4 * 1024 * 1024, this.maxContextBytes * 2),
      });
      value = JSON.parse(result);
    } catch {
      fail("gitlab_request_failed", "GitLab request failed. Check glab authentication and project access.");
    }
    if (!value || typeof value !== "object" || value.error || (!Array.isArray(value) && value.message)) {
      fail("gitlab_request_failed", "GitLab returned an invalid or rejected response.");
    }
    return value;
  }

  async pages(endpoint, { onPage } = {}) {
    const result = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const items = await this.api(`${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=${PAGE_SIZE}&page=${page}`);
      if (!Array.isArray(items) || items.length > PAGE_SIZE) fail("invalid_gitlab_response", "GitLab list response is invalid.");
      onPage?.(items);
      result.push(...items);
      if (items.length < PAGE_SIZE) return result;
    }
    fail("incomplete_context", "GitLab pagination limit reached. Review cannot use partial context.");
  }

  mrUrl(mr, input) {
    if (mr.project_id !== input.projectId || mr.iid !== input.mrIid) fail("invalid_gitlab_response", "GitLab MR identity did not match the requested project and MR.");
    let mrUrl;
    try {
      mrUrl = canonicalMrUrl(mr.web_url);
      const address = parseGitlabMrUrl(mrUrl);
      if (address.host !== this.host || address.iid !== input.mrIid) throw new Error("mismatch");
    } catch { fail("invalid_gitlab_response", "GitLab MR URL did not match the configured host and MR."); }
    return mrUrl;
  }

  snapshot(mr, input) {
    const mrUrl = this.mrUrl(mr, input);
    const headSha = mr.diff_refs?.head_sha ?? mr.sha;
    if (!SHA.test(headSha ?? "") || (mr.sha && (!SHA.test(mr.sha) || mr.sha.toLowerCase() !== headSha.toLowerCase()))) {
      fail("incomplete_context", "GitLab MR diff is not ready for its latest commit.");
    }
    if (!Number.isSafeInteger(mr.author?.id) || mr.author.id < 1 || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(mr.author?.username ?? "")) {
      fail("invalid_gitlab_response", "GitLab MR author is invalid.");
    }
    if (!["opened", "closed", "locked", "merged"].includes(mr.state)) fail("invalid_gitlab_response", "GitLab MR state is invalid.");
    return {
      projectId: input.projectId, mrIid: input.mrIid, mrUrl, headSha: headSha.toLowerCase(),
      author: { id: mr.author.id, username: mr.author.username }, state: mr.state,
      draft: Boolean(mr.draft || mr.work_in_progress || /^(?:Draft:|WIP:)\s/i.test(mr.title ?? "")),
    };
  }

  assertReady(snapshot, expectedHeadSha) {
    if (snapshot.state !== "opened" || snapshot.draft) fail("review_not_open", "MR is closed, merged, locked, or a draft. Automatic review is paused.");
    if (expectedHeadSha && (!SHA.test(expectedHeadSha) || snapshot.headSha !== expectedHeadSha.toLowerCase())) {
      fail("stale_head", "MR has a different head commit. Review must restart for the latest commit.");
    }
  }

  async readHead(input) {
    return this.snapshot(await this.api(this.address(input)), input);
  }

  async readReview(input) {
    const endpoint = this.address(input);
    const mr = await this.api(endpoint);
    const snapshot = this.snapshot(mr, input);
    this.assertReady(snapshot, input.expectedHeadSha ?? input.headSha);
    const baseSha = mr.diff_refs?.base_sha;
    const startSha = mr.diff_refs?.start_sha;
    if (!SHA.test(baseSha ?? "") || !SHA.test(startSha ?? "")) fail("incomplete_context", "GitLab MR base commits are not ready.");
    let bytes = 0;
    const consume = (value) => {
      bytes += Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
      if (bytes > this.maxContextBytes) fail("context_too_large", "MR context exceeds the configured byte limit. Automatic review cannot use a partial diff or file.");
    };
    const title = String(mr.title ?? "");
    const description = String(mr.description ?? "");
    consume({ title, description });
    const notes = [];
    await this.pages(`${endpoint}/notes?sort=asc&order_by=created_at`, { onPage: (items) => {
      for (const note of items) {
        if (!note || note.system) continue;
        if (!Number.isSafeInteger(note.id) || typeof note.body !== "string") fail("invalid_gitlab_response", "GitLab MR comment is invalid.");
        const normalized = { id: note.id, body: note.body, author: { id: note.author?.id, username: note.author?.username }, createdAt: note.created_at ?? null };
        consume(normalized);
        notes.push(normalized);
      }
    } });
    const diffs = await this.pages(`${endpoint}/diffs`, { onPage: (items) => consume(items) });
    if (!/^\d+$/.test(String(mr.changes_count ?? "")) || Number(mr.changes_count) !== diffs.length || !diffs.length) {
      fail("incomplete_context", "GitLab did not provide a complete, nonempty MR file list.");
    }
    const seen = new Set();
    const files = [];
    for (const diff of diffs) {
      if (!diff || typeof diff.diff !== "string" || diff.too_large || diff.collapsed) {
        fail("incomplete_context", "GitLab omitted a changed file diff. Automatic review cannot use partial context.");
      }
      const oldPath = path(diff.old_path);
      const newPath = path(diff.new_path);
      if ([diff.new_file, diff.deleted_file, diff.renamed_file].some((value) => typeof value !== "boolean")
        || !/^\d{6}$/.test(diff.a_mode ?? "") || !/^\d{6}$/.test(diff.b_mode ?? "")) {
        fail("invalid_gitlab_response", "GitLab changed file metadata is invalid.");
      }
      const key = `${oldPath}\0${newPath}`;
      if (seen.has(key)) fail("incomplete_context", "GitLab returned duplicate changed files.");
      seen.add(key);
      if (diff.a_mode === "160000" || diff.b_mode === "160000") fail("unsupported_content", "Submodule changes require a separate review and are not automatically reviewed.");
      const baseContent = diff.new_file ? null : await this.file(input.projectId, oldPath, baseSha);
      if (baseContent !== null) consume(baseContent);
      const headContent = diff.deleted_file ? null : await this.file(input.projectId, newPath, snapshot.headSha);
      if (headContent !== null) consume(headContent);
      const emptyFileAddedOrDeleted = (diff.new_file && headContent === "") || (diff.deleted_file && baseContent === "");
      if (!diff.diff.trim() && baseContent !== headContent && !emptyFileAddedOrDeleted) {
        fail("incomplete_context", "GitLab returned an empty diff for changed file contents.");
      }
      files.push({ oldPath, newPath, diff: diff.diff, newFile: Boolean(diff.new_file), deletedFile: Boolean(diff.deleted_file),
        renamedFile: Boolean(diff.renamed_file), oldMode: diff.a_mode, newMode: diff.b_mode, baseContent, headContent });
    }
    const finalHead = await this.readHead(input);
    this.assertReady(finalHead, snapshot.headSha);
    return {
      ...snapshot, baseSha: baseSha.toLowerCase(), startSha: startSha.toLowerCase(), title, description,
      notes, files, changedPaths: [...new Set(files.flatMap((file) => [file.oldPath, file.newPath]))],
      issueKeys: extractIssueKeys(title, description, mr.source_branch),
      mrSource: { title, description, descriptionTruncated: false }, contextBytes: bytes,
    };
  }

  async file(projectId, filePath, ref) {
    integer(projectId, "projectId");
    if (!this.allowedProjectIds.has(projectId)) fail("project_not_allowed", "GitLab project is not allowed.");
    path(filePath);
    if (!SHA.test(ref ?? "")) fail("invalid_input", "GitLab file commit SHA is invalid.");
    const result = await this.api(`projects/${projectId}/repository/files/${encodeURIComponent(filePath)}?ref=${ref}`);
    if (result.encoding !== "base64" || typeof result.content !== "string" || result.file_path !== filePath
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result.content.replace(/\n/g, ""))) {
      fail("invalid_gitlab_response", "GitLab file content is invalid.");
    }
    const content = Buffer.from(result.content, "base64");
    if (content.length > this.maxContextBytes) fail("context_too_large", "A changed file exceeds the configured review byte limit.");
    if (result.content_sha256 && (typeof result.content_sha256 !== "string" || result.content_sha256.toLowerCase() !== hash(content))) {
      fail("invalid_gitlab_response", "GitLab file content checksum did not match.");
    }
    if (content.includes(0)) fail("unsupported_content", "Binary changed files require a separate review and are not automatically reviewed.");
    try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content); }
    catch { fail("unsupported_content", "Non-UTF-8 changed files require a separate review."); }
  }

  async authenticatedUser() {
    this.userPromise ??= this.api("user").then((user) => {
      integer(user.id, "GitLab authenticated user ID");
      return user;
    }).catch((error) => { this.userPromise = null; throw error; });
    return this.userPromise;
  }

  async ensureComment({ projectId, mrIid, headSha, body, beforeCreate }) {
    const input = { projectId, mrIid };
    const endpoint = this.address(input);
    if (!SHA.test(headSha ?? "") || typeof body !== "string" || !body.trim() || body.length > 60_000 || body.includes("\0")) {
      fail("invalid_input", "Review comment body or commit SHA is invalid.");
    }
    if (/^\s*\/[A-Za-z][A-Za-z_-]*(?:\s|$)/m.test(body)) fail("unsafe_comment", "Review comments cannot contain GitLab quick action commands.");
    const marker = reviewCommentMarker({ host: this.host, projectId, mrIid, headSha });
    if (body.includes("<!-- reviewbot:")) fail("invalid_input", "Review comment body cannot supply an internal marker.");
    const user = await this.authenticatedUser();
    const notes = await this.pages(`${endpoint}/notes?sort=desc&order_by=created_at`);
    const publishedBody = `${body.trim()}\n\n${marker}`;
    const matches = notes.filter((note) => !note.system && note.author?.id === user.id && typeof note.body === "string"
      && note.body.split(/\r?\n/).includes(marker));
    if (matches.length > 1) fail("duplicate_comment", "Multiple comments share this review marker. Resolve the existing duplicates before retrying.");
    if (matches.length) {
      const existing = matches[0];
      integer(existing.id, "GitLab comment ID");
      if (existing.body !== publishedBody) fail("comment_conflict", "The existing review comment has different content. It was preserved; reconcile it before retrying.");
      const mrUrl = this.mrUrl(await this.api(endpoint), input);
      return { id: existing.id, url: `${mrUrl}#note_${existing.id}`, created: false, marker,
        headSha: headSha.toLowerCase(), bodyHash: hash(existing.body), matchesBody: existing.body === publishedBody };
    }
    const snapshot = await this.readHead(input);
    this.assertReady(snapshot, headSha);
    await beforeCreate?.();
    const result = await this.api(`${endpoint}/notes`, { method: "POST", body: { body: publishedBody } });
    if (!Number.isSafeInteger(result.id) || result.id < 1 || result.author?.id !== user.id || result.body !== publishedBody) {
      fail("gitlab_write_uncertain", "GitLab comment creation returned an incomplete receipt. Retry to reconcile the review marker.");
    }
    return { id: result.id, url: `${snapshot.mrUrl}#note_${result.id}`, created: true, marker,
      headSha: headSha.toLowerCase(), bodyHash: hash(result.body), matchesBody: true };
  }
}
