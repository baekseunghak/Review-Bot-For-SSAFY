import { UserError } from "./core.js";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_PAGES = 50;
const MAX_ISSUES = 500;
const MAX_DESCRIPTION = 16_000;
const CATEGORIES = new Set(["new", "indeterminate", "done"]);
const FIELDS = ["summary", "description", "status", "assignee", "updated", "created", "components"];

function invalid() {
  throw new UserError("Jira returned invalid or incomplete data.");
}

function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value;
}

function string(value, max = 256) {
  if (typeof value !== "string" || !value.length || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) invalid();
  return value;
}

function account(value) {
  if (typeof value !== "string" || !/^[A-Za-z\d:_.-]{1,255}$/.test(value)) throw new UserError("A valid Jira account ID is required.");
  return value;
}

function nullable(value) {
  return value === null || value === undefined || value === "" ? null : string(value);
}

function date(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) invalid();
  const parsed = new Date(value);
  const day = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || !Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== value.slice(0, 10) || Number(value.slice(11, 13)) > 23) invalid();
  return parsed.toISOString();
}

function description(value) {
  if (value === undefined) return { text: "", truncated: true };
  if (value === null) return { text: "", truncated: false };
  if (typeof value === "string") return { text: value.slice(0, MAX_DESCRIPTION), truncated: value.length > MAX_DESCRIPTION };
  const doc = record(value);
  if (doc.type !== "doc" || doc.version !== 1 || !Array.isArray(doc.content)) invalid();
  const stack = [{ node: doc, depth: 0 }];
  let output = "";
  let count = 0;
  let truncated = false;
  while (stack.length) {
    const entry = stack.pop();
    if (entry.end) { if (output && !output.endsWith("\n")) output += "\n"; continue; }
    if (++count > 10_000 || entry.depth > 64) { truncated = true; break; }
    const node = record(entry.node);
    if (node.type === "text") {
      if (typeof node.text !== "string") invalid();
      output += node.text;
    } else if (node.type === "hardBreak") output += "\n";
    else if (node.type === "mention" || node.type === "emoji") {
      if (typeof node.attrs?.text === "string") output += node.attrs.text;
      else truncated = true;
    } else if (node.content !== undefined) {
      if (!Array.isArray(node.content)) invalid();
      if (["paragraph", "heading", "listItem", "codeBlock", "tableRow"].includes(node.type)) stack.push({ end: true });
      for (let i = node.content.length - 1; i >= 0; i--) stack.push({ node: node.content[i], depth: entry.depth + 1 });
    } else truncated = true;
    if (output.length > MAX_DESCRIPTION) { truncated = true; output = output.slice(0, MAX_DESCRIPTION); break; }
  }
  return { text: output.trim(), truncated };
}

function currentSprint(fields, sprintFields) {
  if (!sprintFields.length) return null;
  let unknown = false;
  for (const field of sprintFields) {
    const values = fields[field];
    if (values === undefined) { unknown = true; continue; }
    if (values === null) continue;
    if (!Array.isArray(values)) { unknown = true; continue; }
    for (const sprint of values) {
      if (!sprint || typeof sprint !== "object" || Array.isArray(sprint) || typeof sprint.state !== "string") { unknown = true; continue; }
      if (sprint.state.toLowerCase() === "active") return true;
      if (!["closed", "future"].includes(sprint.state.toLowerCase())) unknown = true;
    }
  }
  return unknown ? null : false;
}

export class JiraClient {
  #baseUrl;
  #authorization;
  #projectKey;
  #fetch;
  #now;
  #configured;

  constructor({ baseUrl, email, apiToken, projectKey = "", fetchImpl = globalThis.fetch, allowLocalHttp = false, now = () => new Date() } = {}) {
    if (typeof projectKey !== "string" || (projectKey && !/^[A-Z][A-Z\d_]{0,127}$/.test(projectKey))) throw new UserError("A valid Jira project key is required.");
    for (const value of [baseUrl, email, apiToken]) {
      if (value !== undefined && (typeof value !== "string" || /[\r\n\0]/.test(value))) throw new UserError("Invalid Jira connection configuration.");
    }
    const mail = email?.trim() ?? "";
    const token = apiToken?.trim() ?? "";
    if (mail && !/^[^:\s@]+@[^:\s@]+$/.test(mail)) throw new UserError("Invalid Jira connection configuration.");
    this.#baseUrl = "";
    if (baseUrl?.trim()) {
      let url;
      try { url = new URL(baseUrl); } catch { throw new UserError("Jira base URL must use HTTPS."); }
      const local = url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
      if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(allowLocalHttp === true && local && url.protocol === "http:"))) throw new UserError("Jira base URL must use HTTPS without credentials, query, or fragment.");
      this.#baseUrl = url.toString().replace(/\/+$/, "");
    }
    if (typeof fetchImpl !== "function" || typeof now !== "function") throw new UserError("Invalid Jira client configuration.");
    this.#configured = Boolean(this.#baseUrl && mail && token && projectKey);
    this.#authorization = this.#configured ? `Basic ${Buffer.from(`${mail}:${token}`).toString("base64")}` : "";
    this.#projectKey = projectKey;
    this.#fetch = fetchImpl;
    this.#now = now;
  }

  static fromEnv(env = process.env) {
    return new JiraClient({
      baseUrl: env.REVIEWBOT_JIRA_BASE_URL,
      email: env.REVIEWBOT_JIRA_EMAIL,
      apiToken: env.REVIEWBOT_JIRA_API_TOKEN,
      projectKey: env.REVIEWBOT_JIRA_PROJECT_KEY || "",
    });
  }

  get configured() { return this.#configured; }

  acceptsIssueKey(key) {
    return Boolean(this.#projectKey) && typeof key === "string"
      && new RegExp(`^${this.#projectKey}-[1-9]\\d{0,14}$`).test(key);
  }

  #issueKey(key) {
    if (!this.#projectKey) throw new UserError("Jira connection is not configured.");
    if (!this.acceptsIssueKey(key)) throw new UserError("Issue key must belong to the configured Jira project.");
    return key;
  }

  async #request(path, body) {
    if (!this.#configured) throw new UserError("Jira connection is not configured.");
    let response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { accept: "application/json", authorization: this.#authorization, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error", signal: AbortSignal.timeout(10_000),
      });
    } catch { throw new UserError("Jira request failed or timed out."); }
    if (!response.ok) {
      try { await response.body?.cancel(); } catch {}
      const error = new UserError(`Jira request failed (HTTP ${Number.isInteger(response.status) ? response.status : "error"}).`);
      error.status = response.status;
      throw error;
    }
    const reader = response.body?.getReader();
    if (!reader) invalid();
    const chunks = [];
    let size = 0;
    try {
      if (Number(response.headers.get("content-length")) > MAX_BYTES) throw new UserError("Jira response exceeded the safety limit.");
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) throw new UserError("Jira response exceeded the safety limit.");
        chunks.push(Buffer.from(value));
      }
      try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { invalid(); }
    } catch (error) {
      try { await reader.cancel(); } catch {}
      if (error instanceof UserError) throw error;
      throw new UserError("Jira response could not be read.");
    } finally { reader.releaseLock(); }
  }

  async #metadata() {
    const [fields, issueTypes] = await Promise.all([
      this.#request("/rest/api/3/field"),
      this.#request(`/rest/api/3/project/${this.#projectKey}/statuses`),
    ]);
    if (!Array.isArray(fields) || !Array.isArray(issueTypes)) invalid();
    const sprintFields = [];
    for (const field of fields) {
      record(field);
      if (typeof field.schema?.custom === "string" && field.schema.custom.includes("gh-sprint")) {
        if (typeof field.id !== "string" || !/^customfield_\d+$/.test(field.id)) invalid();
        sprintFields.push(field.id);
      }
    }
    const statuses = new Map();
    const statusIds = new Set();
    for (const type of issueTypes) {
      if (!Array.isArray(record(type).statuses)) invalid();
      for (const status of type.statuses) {
        record(status);
        const statusId = string(status.id);
        statusIds.add(statusId);
        const category = status.statusCategory?.key;
        if (category !== undefined && !CATEGORIES.has(category)) invalid();
        if (category !== undefined) {
          if (statuses.has(statusId) && statuses.get(statusId) !== category) invalid();
          statuses.set(statusId, category);
        }
      }
    }
    const missing = [...statusIds].filter((statusId) => !statuses.has(statusId));
    if (missing.length > 200) throw new UserError("Jira status metadata exceeded the safety limit.");
    for (const statusId of missing) {
      let details;
      try { details = record(await this.#request(`/rest/api/3/status/${encodeURIComponent(statusId)}`)); }
      catch (error) {
        if (error instanceof UserError && [403, 404].includes(error.status)) continue;
        throw error;
      }
      if (details.id !== statusId) invalid();
      const category = details.statusCategory?.key;
      if (category !== undefined && !CATEGORIES.has(category)) invalid();
      if (category !== undefined) statuses.set(statusId, category);
    }
    return { sprintFields, statuses };
  }

  async #history(key, statuses) {
    const history = [];
    const seen = new Set();
    let startAt = 0;
    for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber++) {
      const page = record(await this.#request(`/rest/api/3/issue/${key}/changelog?startAt=${startAt}&maxResults=100`));
      if (!Array.isArray(page.values) || page.startAt !== startAt || (page.isLast !== undefined && typeof page.isLast !== "boolean") || (page.total !== undefined && (!Number.isSafeInteger(page.total) || page.total < 0))) invalid();
      for (const change of page.values) {
        record(change);
        const historyId = string(change.id);
        if (seen.has(historyId)) throw new UserError("Jira changelog pagination was inconsistent.");
        seen.add(historyId);
        if (seen.size > 5_000) throw new UserError("Jira changelog exceeded the safety limit.");
        const at = date(change.created);
        if (!Array.isArray(change.items)) invalid();
        for (const item of change.items) {
          record(item);
          const field = item.fieldId ?? item.field;
          if (field !== "status" && field !== "assignee") continue;
          const from = nullable(item.from);
          const to = nullable(item.to);
          history.push({
            at, field, from, to,
            ...(field === "status" && Object.hasOwn(item, "fromString") && item.fromString ? { fromName: string(item.fromString) } : {}),
            ...(field === "status" && Object.hasOwn(item, "toString") && item.toString ? { toName: string(item.toString) } : {}),
            ...(field === "status" && statuses.has(to) ? { toCategory: statuses.get(to) } : {}),
          });
          if (history.length > 10_000) throw new UserError("Jira changelog exceeded the safety limit.");
        }
      }
      const next = startAt + page.values.length;
      if (page.isLast === true) {
        if (page.total !== undefined && next < page.total) invalid();
        return history.sort((a, b) => a.at.localeCompare(b.at));
      }
      if (page.isLast === undefined && page.total !== undefined && next >= page.total) return history.sort((a, b) => a.at.localeCompare(b.at));
      if (!page.values.length) throw new UserError("Jira changelog pagination did not complete.");
      startAt = next;
    }
    throw new UserError("Jira changelog exceeded the page limit.");
  }

  async #normalize(raw, metadata, expectedKey) {
    record(raw);
    const key = this.#issueKey(raw.key);
    if (expectedKey !== undefined && key !== expectedKey) invalid();
    const fields = record(raw.fields);
    const status = record(fields.status);
    const statusId = string(status.id);
    const category = status.statusCategory?.key ?? metadata.statuses.get(statusId);
    if (!CATEGORIES.has(category)) invalid();
    const statuses = new Map(metadata.statuses).set(statusId, category);
    if (fields.assignee !== null) record(fields.assignee);
    const assigneeAccountId = fields.assignee === null ? null : account(fields.assignee.accountId);
    if (!Array.isArray(fields.components)) invalid();
    const detail = description(fields.description);
    const issue = {
      key, summary: string(fields.summary, 1_000), description: detail.text,
      status: { id: statusId, name: string(status.name), category },
      assigneeAccountId, updatedAt: date(fields.updated), createdAt: date(fields.created),
      url: `${this.#baseUrl}/browse/${key}`,
      components: fields.components.map((component) => string(record(component).name)),
      inCurrentSprint: currentSprint(fields, metadata.sprintFields),
      descriptionTruncated: detail.truncated,
    };
    return { ...issue, history: await this.#history(key, statuses), historyComplete: true };
  }

  async getIssue(key) {
    return (await this.getIssues([key]))[0];
  }

  async getIssues(keys) {
    if (!Array.isArray(keys) || keys.length > 100) throw new UserError("Provide at most 100 Jira issue keys.");
    const unique = [...new Set(keys.map((key) => this.#issueKey(key)))];
    if (!unique.length) return [];
    const metadata = await this.#metadata();
    const fields = [...FIELDS, ...metadata.sprintFields].join(",");
    const issues = [];
    for (const key of unique) {
      const raw = await this.#request(`/rest/api/3/issue/${key}?fields=${encodeURIComponent(fields)}`);
      issues.push(await this.#normalize(raw, metadata, key));
    }
    return issues;
  }

  async getMemberIssues(accountId) {
    account(accountId);
    const metadata = await this.#metadata();
    const escaped = accountId.replace(/[\\"]/g, "\\$&");
    const jql = `project = "${this.#projectKey}" AND (assignee = "${escaped}" OR assignee WAS "${escaped}") ORDER BY key ASC`;
    const raws = [];
    const keys = new Set();
    const cursors = new Set();
    let cursor;
    let complete = false;
    for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber++) {
      const page = record(await this.#request("/rest/api/3/search/jql", {
        jql, fields: [...FIELDS, ...metadata.sprintFields], maxResults: 100,
        ...(cursor === undefined ? {} : { nextPageToken: cursor }),
      }));
      if (!Array.isArray(page.issues) || (page.isLast !== undefined && typeof page.isLast !== "boolean")) invalid();
      for (const issue of page.issues) {
        const key = this.#issueKey(record(issue).key);
        if (keys.has(key)) throw new UserError("Jira search pagination was inconsistent.");
        keys.add(key);
        raws.push(issue);
        if (raws.length > MAX_ISSUES) throw new UserError("Jira search exceeded the issue limit.");
      }
      if (page.isLast === true) {
        if (page.nextPageToken !== undefined && page.nextPageToken !== null && page.nextPageToken !== "") invalid();
        complete = true;
        break;
      }
      if (typeof page.nextPageToken !== "string" || !page.nextPageToken || page.nextPageToken.length > 4_096 || cursors.has(page.nextPageToken)) throw new UserError("Jira search pagination did not complete.");
      cursors.add(page.nextPageToken);
      cursor = page.nextPageToken;
    }
    if (!complete) throw new UserError("Jira search exceeded the page limit.");
    const issues = [];
    for (const raw of raws) issues.push(await this.#normalize(raw, metadata));
    const fetchedAt = this.#now();
    if (!(fetchedAt instanceof Date) || !Number.isFinite(fetchedAt.getTime())) throw new UserError("Invalid Jira fetch timestamp.");
    return { issues, fetchedAt: fetchedAt.toISOString(), complete: true };
  }
}
