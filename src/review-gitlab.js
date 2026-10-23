import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { UserError } from "./core.js";
import { canonicalMrUrl, extractIssueKeys, parseGitlabMrUrl } from "./gitlab-context.js";
import { hasPriorityNotation } from "../bin/mr-review.mjs";

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const PAGE_SIZE = 100;
const MAX_PAGES = 100;

function fail(code, message, details = {}) {
  const error = new UserError(message);
  error.code = code;
  Object.assign(error, details);
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

function imageFormat(content) {
  if (content.length >= 4 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) return "jpeg";
  if (content.length >= 24 && content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && content.toString("ascii", 12, 16) === "IHDR") return "png";
  if (content.length >= 13 && ["GIF87a", "GIF89a"].includes(content.toString("ascii", 0, 6))) return "gif";
  if (content.length >= 20 && content.toString("ascii", 0, 4) === "RIFF" && content.toString("ascii", 8, 12) === "WEBP"
    && ["VP8 ", "VP8L", "VP8X"].includes(content.toString("ascii", 12, 16))) return "webp";
  if (content.length >= 22 && content.readUInt32LE(0) === 0x00010000 && content.readUInt16LE(4) > 0) return "ico";
  return null;
}

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
    } catch (error) {
      const status = [...String(error?.stderr ?? "").matchAll(/\bHTTP\s+(\d{3})\b/g)].at(-1)?.[1];
      fail("gitlab_request_failed", "GitLab request failed. Check glab authentication and project access.", status ? { httpStatus: Number(status) } : {});
    }
    // Successful commit responses contain a `message` field too. HTTP failures
    // are rejected by glab; only a message-only error envelope is rejected here.
    if (!value || typeof value !== "object" || value.error
      || (!Array.isArray(value) && value.message && Object.keys(value).every((key) => key === "message"))) {
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

  async readCi(input) {
    this.address(input);
    if (!SHA.test(input.headSha ?? "")) fail("invalid_input", "A full commit SHA is required for CI verification.");
    const sha = input.headSha.toLowerCase();
    const pipelines = await this.api(`projects/${input.projectId}/pipelines?sha=${sha}&order_by=id&sort=desc&per_page=100`);
    if (!Array.isArray(pipelines) || pipelines.length > 100 || pipelines.some((item) => !Number.isSafeInteger(item?.id) || item.id < 1
      || item.sha?.toLowerCase() !== sha || (item.project_id !== undefined && item.project_id !== input.projectId))) {
      fail("invalid_gitlab_response", "CI pipeline identity does not match the reviewed commit.");
    }
    if (!pipelines.length) return { status: "not_found", sha, pipeline: null, jobs: [], bridges: [], tests: null };
    const id = Math.max(...pipelines.map((item) => item.id));
    const endpoint = `projects/${input.projectId}/pipelines/${id}`;
    const pipeline = await this.api(endpoint);
    if (pipeline.id !== id || pipeline.project_id !== input.projectId || pipeline.sha?.toLowerCase() !== sha
      || !/^[a-z_]+$/.test(pipeline.status ?? "")) fail("invalid_gitlab_response", "CI pipeline changed identity.");
    const publicUrl = (value) => {
      const url = new URL(value);
      if (value.length > 2048 || url.host !== this.host || !["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        fail("invalid_gitlab_response", "CI result URL does not match GitLab.");
      }
      return url.href;
    };
    const jobResult = (job) => {
      if (!Number.isSafeInteger(job?.id) || job.id < 1 || typeof job.name !== "string" || typeof job.stage !== "string"
        || !/^[a-z_]+$/.test(job.status ?? "") || typeof job.allow_failure !== "boolean"
        || job.pipeline?.id !== id || job.pipeline?.sha?.toLowerCase() !== sha) {
        fail("invalid_gitlab_response", "CI job identity does not match the selected pipeline.");
      }
      return { id: job.id, name: job.name.slice(0, 160), stage: job.stage.slice(0, 80), status: job.status,
        allowFailure: job.allow_failure, url: publicUrl(job.web_url), failureReason: /^[a-z_]+$/.test(job.failure_reason ?? "") ? job.failure_reason : null };
    };
    const jobs = (await this.pages(`${endpoint}/jobs?include_retried=false`)).map(jobResult);
    // Bridge status is reported separately; it does not prove the child pipeline's tests ran.
    let bridges = [], bridgeError = null, tests = null, testReportError = null;
    try { bridges = (await this.pages(`${endpoint}/bridges`)).map(jobResult); }
    catch { bridgeError = "unavailable"; }
    try {
      const report = await this.api(`${endpoint}/test_report_summary`);
      const total = report.total;
      if (!total || total.suite_error || ["count", "success", "failed", "skipped", "error"].some((key) => !Number.isSafeInteger(total[key]) || total[key] < 0)
        || total.count !== total.success + total.failed + total.skipped + total.error) {
        throw new Error("Invalid test report.");
      }
      tests = { count: total.count, passed: total.success, failed: total.failed, skipped: total.skipped, errors: total.error };
    } catch { testReportError = "unavailable"; }
    const result = { status: pipeline.status, sha, pipeline: { id, url: publicUrl(pipeline.web_url),
      source: String(pipeline.source ?? "unknown").slice(0, 80) }, jobs, bridges, bridgeError, tests, testReportError,
      checkedAt: new Date().toISOString() };
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > 32_000) fail("ci_context_too_large", "CI metadata exceeds the bounded review context.");
    return result;
  }

  async archive(input, { signal } = {}) {
    this.address(input);
    if (!SHA.test(input.headSha ?? "")) fail("invalid_input", "A full commit SHA is required for the source archive.");
    const sha = input.headSha.toLowerCase();
    const commit = await this.api(`projects/${input.projectId}/repository/commits/${sha}`);
    if (commit.id?.toLowerCase() !== sha) fail("invalid_gitlab_response", "Source archive commit did not match.");
    let data;
    try {
      data = await this.runImpl("glab", ["api", `projects/${input.projectId}/repository/archive.tar.gz?sha=${sha}`,
        "--hostname", this.host, "--method", "GET"], { shell: false, encoding: "buffer", maxBuffer: 128 * 1024 * 1024, signal });
    } catch (error) {
      const status = [...String(error?.stderr ?? "").matchAll(/\bHTTP\s+(\d{3})\b/g)].at(-1)?.[1];
      fail("archive_unavailable", "The reviewed source archive could not be downloaded.", status ? { httpStatus: Number(status) } : {});
    }
    if (!Buffer.isBuffer(data) || data.length > 128 * 1024 * 1024 || data[0] !== 0x1f || data[1] !== 0x8b) {
      fail("archive_invalid", "GitLab did not return a bounded gzip source archive.");
    }
    return { data, sha, sha256: hash(data), source: "gitlab_archive" };
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
    let diffs = await this.pages(`${endpoint}/diffs`, { onPage: (items) => consume(items) });
    if (!/^\d+$/.test(String(mr.changes_count ?? "")) || Number(mr.changes_count) !== diffs.length || !diffs.length) {
      fail("incomplete_context", "GitLab did not provide a complete, nonempty MR file list.");
    }
    if (diffs.some((diff) => diff?.too_large)) {
      fail("incomplete_context", "GitLab omitted a changed file diff. Automatic review cannot use partial context.");
    }
    if (diffs.some((diff) => diff?.collapsed === true)) {
      // Gitaly can supply diffs hidden by the database-backed display limits.
      const raw = await this.api(`${endpoint}/changes?access_raw_diffs=true`);
      this.assertReady(this.snapshot(raw, input), snapshot.headSha);
      if (typeof raw.diff_refs?.base_sha !== "string" || typeof raw.diff_refs?.start_sha !== "string"
        || raw.diff_refs.base_sha.toLowerCase() !== baseSha.toLowerCase()
        || raw.diff_refs?.start_sha?.toLowerCase() !== startSha.toLowerCase()
        || raw.overflow !== false || !Array.isArray(raw.changes) || raw.changes.length !== diffs.length) {
        fail("incomplete_context", "GitLab raw diffs did not match the complete revision.");
      }
      const identity = (diff) => JSON.stringify([diff?.old_path, diff?.new_path]);
      const byPath = new Map(raw.changes.map((diff) => [identity(diff), diff]));
      const fields = ["old_path", "new_path", "a_mode", "b_mode", "new_file", "deleted_file", "renamed_file"];
      if (byPath.size !== diffs.length) fail("incomplete_context", "GitLab raw diffs contain duplicate files.");
      diffs = diffs.map((diff) => {
        const expanded = byPath.get(identity(diff));
        if (!expanded || fields.some((key) => expanded[key] !== diff?.[key])) {
          fail("incomplete_context", "GitLab raw diff file identities did not match.");
        }
        if (!diff.collapsed) return diff;
        consume(expanded);
        return expanded;
      });
    }
    const seen = new Set();
    const files = [];
    const excludedImages = [];
    const changedPaths = new Set();
    for (const diff of diffs) {
      if (!diff || typeof diff.diff !== "string" || diff.too_large || diff.collapsed) {
        fail("incomplete_context", "GitLab omitted a changed file diff. Automatic review cannot use partial context.");
      }
      const oldPath = path(diff.old_path);
      const newPath = path(diff.new_path);
      if ([diff.new_file, diff.deleted_file, diff.renamed_file].some((value) => typeof value !== "boolean")
        || (!/^\d{6}$/.test(diff.a_mode ?? "") && !(diff.new_file && diff.a_mode === "0"))
        || (!/^\d{6}$/.test(diff.b_mode ?? "") && !(diff.deleted_file && diff.b_mode === "0"))) {
        fail("invalid_gitlab_response", "GitLab changed file metadata is invalid.");
      }
      const key = `${oldPath}\0${newPath}`;
      if (seen.has(key)) fail("incomplete_context", "GitLab returned duplicate changed files.");
      seen.add(key);
      changedPaths.add(oldPath);
      changedPaths.add(newPath);
      if (diff.a_mode === "160000" || diff.b_mode === "160000") fail("unsupported_content", "Submodule changes require a separate review and are not automatically reviewed.");
      const baseContent = diff.new_file ? null : await this.file(input.projectId, oldPath, baseSha);
      const headContent = diff.deleted_file ? null : await this.file(input.projectId, newPath, snapshot.headSha);
      const metadata = { oldPath, newPath, newFile: diff.new_file, deletedFile: diff.deleted_file,
        renamedFile: diff.renamed_file, oldMode: diff.a_mode, newMode: diff.b_mode };
      if ((baseContent !== null && typeof baseContent === "object") || (headContent !== null && typeof headContent === "object")) {
        if (typeof baseContent === "string" || typeof headContent === "string") {
          fail("unsupported_content", "A changed file switches between image and text content and requires a separate review.");
        }
        if ((baseContent !== null && !["100644", "100755"].includes(diff.a_mode))
          || (headContent !== null && !["100644", "100755"].includes(diff.b_mode))) {
          fail("unsupported_content", "Only regular image files can be excluded from text review.");
        }
        const excluded = { ...metadata, reason: "image_content_not_reviewed", base: baseContent, head: headContent };
        consume(excluded);
        excludedImages.push(excluded);
        continue;
      }
      if (baseContent !== null) consume(baseContent);
      if (headContent !== null) consume(headContent);
      const emptyFileAddedOrDeleted = (diff.new_file && headContent === "") || (diff.deleted_file && baseContent === "");
      if (!diff.diff.trim() && baseContent !== headContent && !emptyFileAddedOrDeleted) {
        fail("incomplete_context", "GitLab returned an empty diff for changed file contents.");
      }
      files.push({ ...metadata, diff: diff.diff, baseContent, headContent });
    }
    const finalHead = await this.readHead(input);
    this.assertReady(finalHead, snapshot.headSha);
    if (!files.length) fail("no_reviewable_text", "MR contains only excluded images and has no reviewable text. Image contents require a separate review.");
    return {
      ...snapshot, baseSha: baseSha.toLowerCase(), startSha: startSha.toLowerCase(), title, description,
      notes, files, excludedImages, changedPaths: [...changedPaths],
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
    const format = imageFormat(content);
    if (format) {
      if (result.size !== undefined && (!Number.isSafeInteger(result.size) || result.size !== content.length)) {
        fail("invalid_gitlab_response", "GitLab image content size did not match.");
      }
      const extension = /\.([^.\/]+)$/.exec(filePath)?.[1].toLowerCase();
      if (extension !== format && !(format === "jpeg" && extension === "jpg")) {
        fail("unsupported_content", "An image file signature does not match its filename extension.");
      }
      return { size: content.length, sha256: hash(content), format };
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
    if (hasPriorityNotation(body)) fail("review_severity_invalid", "Review findings must use 위험, 주의 or 미미 instead of P0-P3.");
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
