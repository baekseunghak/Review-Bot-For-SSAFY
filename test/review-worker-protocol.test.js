import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createWebhookServer } from "../bin/gitlab-webhook.mjs";
import { MattermostService } from "../src/core.js";
import { ReviewInbox } from "../src/review-inbox.js";
import { TeamContextService } from "../src/team-context.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const SHA = "a".repeat(40);

async function installWorkerFixture() {
  const cp = (await import("node:child_process")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const { writeFileSync } = await import("node:fs");
  const effectsPath = process.env.REVIEWBOT_TEST_EFFECTS;
  const provider = process.env.REVIEWBOT_REVIEW_PROVIDER || "claude";
  const sha = "a".repeat(40);
  const baseSha = "c".repeat(40);
  const mrUrl = "https://gitlab.example.test/team/repo/-/merge_requests/7";
  const effects = { modelCalls: 0, commentPosts: 0, mmPosts: 0, rawDiffReads: 0, unexpected: [], notes: [] };
  const save = () => writeFileSync(effectsPath, JSON.stringify(effects));
  const unexpected = (what) => { effects.unexpected.push(what); save(); throw new Error("Unexpected fixture operation"); };
  save();
  const mr = { project_id: 10, iid: 7, web_url: mrUrl, state: "opened", draft: false,
    author: { id: 11, username: "fixture.author" }, sha, diff_refs: { head_sha: sha, base_sha: baseSha, start_sha: baseSha },
    title: "TEST-1 Input validation", description: "Reject empty input", source_branch: "feat/TEST-1", changes_count: "2" };
  const issue = { key: "TEST-1", fields: { summary: "Input validation", description: "Reject empty input before processing",
    status: { id: "2", name: "In progress", statusCategory: { key: "indeterminate" } },
    assignee: { accountId: "fixture:1" }, updated: "2026-10-20T00:00:00.000Z", created: "2026-10-19T00:00:00.000Z", components: [] } };
  function glab(file, args, input) {
    if (file !== "glab" || args[0] !== "api" || args[args.indexOf("--hostname") + 1] !== "gitlab.example.test") return unexpected("CLI identity");
    const endpoint = args[1];
    const method = args.includes("--method") ? args[args.indexOf("--method") + 1] : "GET";
    if (endpoint.startsWith(`projects/10/pipelines?sha=${sha}&`) && method === "GET") return [];
    if (endpoint === "user" && method === "GET") return { id: 999, username: "reviewbot" };
    if (["projects/10/merge_requests/7", "projects/team%2Frepo/merge_requests/7"].includes(endpoint) && method === "GET") return mr;
    if (endpoint.startsWith("projects/10/merge_requests/7/notes?") && method === "GET") return effects.notes;
    if ((endpoint.startsWith("projects/10/merge_requests/7/diffs?")
      || endpoint === "projects/10/merge_requests/7/changes?access_raw_diffs=true") && method === "GET") {
      const diffs = [{
      old_path: "src/input.js", new_path: "src/input.js", diff: "@@ -1 +1,2 @@\n+if (!input) throw new Error('empty');\n process(input);",
      new_file: false, deleted_file: false, renamed_file: false, a_mode: "100644", b_mode: "100644",
    }, {
      old_path: "docs/screen.png", new_path: "docs/screen.png", diff: "",
      new_file: true, deleted_file: false, renamed_file: false, a_mode: "0", b_mode: "100644",
      }];
      if (endpoint.includes("/changes?")) { effects.rawDiffReads++; save(); return { ...mr, overflow: false, changes: diffs }; }
      return diffs.map((diff, index) => index === 0 ? { ...diff, collapsed: true, diff: "" } : diff);
    }
    if (endpoint.startsWith("projects/10/repository/files/src%2Finput.js?ref=") && method === "GET") {
      const ref = endpoint.split("?ref=")[1];
      if (![sha, baseSha].includes(ref)) return unexpected("File ref");
      const source = ref === sha ? "if (!input) throw new Error('empty');\nprocess(input);\n" : "process(input);\n";
      return { encoding: "base64", file_path: "src/input.js", content: Buffer.from(source).toString("base64") };
    }
    if (endpoint === `projects/10/repository/files/docs%2Fscreen.png?ref=${sha}` && method === "GET") {
      return { encoding: "base64", file_path: "docs/screen.png",
        content: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGfYAAAAASUVORK5CYII=" };
    }
    if (endpoint === "projects/10/merge_requests/7/notes" && method === "POST") {
      const payload = JSON.parse(input);
      effects.commentPosts++;
      const note = { id: 77, author: { id: 999 }, body: payload.body, system: false };
      effects.notes.push(note);
      save();
      return note;
    }
    return unexpected(`GitLab ${method} ${endpoint}`);
  }
  function fixtureExec(file, args, options, callback) {
    if (typeof callback !== "function") return unexpected("CLI callback");
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    let input = "";
    child.stdin.on("data", (chunk) => { input += chunk; });
    child.stdin.on("finish", () => {
      try { callback(null, JSON.stringify(glab(file, args, input)), ""); }
      catch (error) { callback(error, "", ""); }
    });
    return child;
  }
  fixtureExec[Symbol.for("nodejs.util.promisify.custom")] = async (file, args) => ({ stdout: JSON.stringify(glab(file, args)), stderr: "" });
  cp.execFile = fixtureExec;
  cp.spawn = (file, args, options) => {
    if (file !== provider || options.shell !== false) return unexpected("Model runner identity");
    if (provider === "claude" && (!args.includes("--safe-mode") || !args.includes("--restricted"))) return unexpected("Claude runner options");
    if (provider === "codex" && (args[0] !== "exec" || !args.includes("--ephemeral") || !args.includes("--json")
      || !args.includes("--output-schema") || !args.includes("--ignore-user-config") || !args.includes("--ignore-rules")
      || args[args.indexOf("--sandbox") + 1] !== "read-only")) return unexpected("Codex runner options");
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { queueMicrotask(() => child.emit("close", null)); return true; };
    let input = "";
    child.stdin.on("data", (chunk) => { input += chunk; });
    child.stdin.on("finish", () => {
      try {
        const data = JSON.parse(input);
        if (data.context?.status !== "fresh" || data.changes?.headSha !== sha || !data.changes?.files?.[0]?.headContent?.includes("throw new Error")) return unexpected("Incomplete model evidence");
        if (data.changes.files.length !== 1 || data.changes.excludedImages?.length !== 1
          || data.changes.excludedImages[0].newPath !== "docs/screen.png"
          || /iVBORw0KGgo/.test(input)) return unexpected("Image scope metadata");
        effects.modelCalls++;
        effects.modelEvidence = { headSha: data.context.headSha, perspectives: data.context.perspectives.length, jiraKeys: data.context.relatedIssues.map((entry) => entry.key) };
        save();
        const result = { verdict: "approve", body: "## 리뷰 결과: 승인\n\n### 확인한 범위\n제공된 현재 코드만 정적으로 확인했고 테스트는 실행하지 않았습니다.\n\n### 작업 맥락\nTEST-1의 빈 입력 거부 조건을 `src/input.js:1`과 대조했습니다.",
          memory: { implementation: [{ summary: "빈 입력을 명시 오류로 거부한다.", basis: "observed", evidence: [{ kind: "code", ref: "src/input.js:1" }] }],
            decisions: [], validations: [{ check: "단위 테스트 실행", result: "not_run", basis: "unknown", evidence: [] }], remainingWork: [] } };
        if (provider === "codex") {
          const events = [
            { type: "thread.started", thread_id: "fixture-thread" },
            { type: "item.completed", item: { id: "startup-code-mode", type: "error", message: "Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`." } },
            { type: "turn.started" },
            { type: "item.completed", item: { id: "fixture-review", type: "agent_message", text: JSON.stringify(result) } },
            { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
          ];
          child.stdout.end(events.map((event) => JSON.stringify(event)).join("\n") + "\n");
        } else {
          child.stdout.end(JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: result }));
        }
        child.emit("close", 0);
      } catch (error) { child.emit("error", error); }
    });
    return child;
  };
  for (const name of ["exec", "execSync", "execFileSync", "spawnSync", "fork"]) cp[name] = () => unexpected(`Real process ${name}`);
  for (const moduleName of ["node:http", "node:https", "node:net"]) {
    const network = (await import(moduleName)).default;
    for (const name of ["request", "get", "connect", "createConnection"]) if (typeof network[name] === "function") network[name] = () => unexpected("Native network");
  }
  globalThis.fetch = async (address, options = {}) => {
    const url = new URL(address);
    const json = (body) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (url.origin === "https://jira.example.test") {
      if (url.pathname === "/rest/api/3/field") return json([]);
      if (url.pathname === "/rest/api/3/project/TEST/statuses") return json([{ statuses: [{ id: "2", name: "In progress", statusCategory: { key: "indeterminate" } }] }]);
      if (url.pathname === "/rest/api/3/search/jql" && options.method === "POST") return json({ issues: [issue], isLast: true });
      if (url.pathname === "/rest/api/3/issue/TEST-1") return json(issue);
      if (url.pathname === "/rest/api/3/issue/TEST-1/changelog") return json({ startAt: 0, values: [], isLast: true, total: 0 });
    }
    if (url.href === "https://mattermost.example.test/hooks/fixture-secret" && options.method === "POST") {
      effects.mmPosts++;
      effects.notification = JSON.parse(options.body);
      save();
      return new Response("ok");
    }
    return unexpected(`Fetch ${url.origin}${url.pathname}`);
  };
  syncBuiltinESMExports();
}

async function startMcp(dataDir, effectsPath, provider) {
  const env = { MATTERMOST_MCP_DATA_DIR: dataDir, REVIEWBOT_AUTO_REVIEW: "1", REVIEWBOT_GITLAB_HOST: "gitlab.example.test",
    REVIEWBOT_GITLAB_PROJECT_IDS: "10", REVIEWBOT_MATTERMOST_CHANNEL: "fixture-channel", REVIEWBOT_WORKER_INTERVAL_MS: "1000",
    REVIEWBOT_JIRA_BASE_URL: "https://jira.example.test", REVIEWBOT_JIRA_EMAIL: "fixture@example.test", REVIEWBOT_JIRA_API_TOKEN: "fixture-token",
    REVIEWBOT_JIRA_PROJECT_KEY: "TEST", REVIEWBOT_TEST_EFFECTS: effectsPath, REVIEWBOT_REVIEW_PROVIDER: provider };
  for (const key of ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP", "ComSpec"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  const preload = `data:text/javascript,${encodeURIComponent(`await (${installWorkerFixture.toString()})();`)}`;
  const child = spawn(process.execPath, ["--import", preload, join(root, "src/server.js")], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout });
  const waiting = new Map();
  let nextId = 0;
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const rejectAll = () => { for (const waiter of waiting.values()) waiter.reject(new Error(`Fixture MCP stopped: ${stderr}`)); waiting.clear(); };
  child.on("error", rejectAll); child.on("exit", rejectAll);
  lines.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { rejectAll(); return; }
    const waiter = waiting.get(message.id);
    if (waiter) { waiting.delete(message.id); waiter.resolve(message); }
  });
  const request = (method, params = {}) => new Promise((resolveRequest, rejectRequest) => {
    const id = ++nextId;
    const timer = setTimeout(() => { waiting.delete(id); rejectRequest(new Error(`Fixture MCP timeout: ${stderr}`)); }, 5000);
    waiting.set(id, { resolve: (value) => { clearTimeout(timer); resolveRequest(value); }, reject: (error) => { clearTimeout(timer); rejectRequest(error); } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const stop = async () => {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit", { signal: AbortSignal.timeout(5000) });
      child.kill(); await exited;
    }
  };
  try {
    const initialized = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "worker-fixture", version: "1.0.0" } });
    assert.equal(initialized.result.serverInfo.name, "mmp");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
    return { request, stop, async tool(name, args = {}) {
      const reply = await request("tools/call", { name, arguments: args });
      assert.equal(reply.error, undefined);
      return { isError: reply.result.isError, data: JSON.parse(reply.result.content[0].text) };
    } };
  } catch (error) { await stop(); throw error; }
}

for (const provider of ["claude", "codex"]) test(`authenticated webhook drives the actual stdio MCP worker through ${provider} review, memory, comment and author DM`, { timeout: 20_000 }, async () => {
  const temporaryRoot = realpathSync(tmpdir());
  const dataDir = mkdtempSync(join(temporaryRoot, "review-worker-protocol-"));
  let mcp;
  let receiver;
  let inbox;
  try {
    const team = new TeamContextService({ dataDir, jiraClient: { configured: false } });
    try { team.upsertMember({ id: "fixture-member", displayName: "Fixture Author", gitlabUsername: "fixture.author", gitlabUserId: 11,
      jiraAccountId: "fixture:1", areas: ["Input validation"], paths: ["src"], reviewFocus: ["Invalid input"] }); }
    finally { team.close(); }
    const mattermost = new MattermostService({ dataDir });
    try {
      mattermost.createWebhook({ name: "fixture-webhook", webhookUrl: "https://mattermost.example.test/hooks/fixture-secret" });
      mattermost.createChannel({ name: "fixture-channel", webhookName: "fixture-webhook" });
      mattermost.createParticipant({ displayName: "Fixture Author", mattermostUsername: "fixture.mm", gitlabUsername: "fixture.author" });
      mattermost.createConvention({ name: "review-complete", template: "{{mention}} :review_complete_shake: !{{mr_number}} | [{{jira_key}}] {{message}}" });
    } finally { mattermost.close(); }
    inbox = new ReviewInbox({ dataDir, username: "reviewer", botUserId: 999, projectIds: [10] });
    receiver = createWebhookServer({ inbox, secret: "fixture-webhook-secret" });
    receiver.listen(0, "127.0.0.1"); await once(receiver, "listening");
    const endpoint = `http://127.0.0.1:${receiver.address().port}/webhooks/gitlab`;
    const event = { object_kind: "merge_request", project: { id: 10 }, object_attributes: { iid: 7, action: "update", state: "opened", draft: false,
      description: "@reviewer TEST-1", reviewer_ids: [], updated_at: new Date().toISOString(), last_commit: { id: SHA } } };
    const deliver = () => fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", "x-gitlab-token": "fixture-webhook-secret",
      "x-gitlab-event": "Merge Request Hook", "x-gitlab-event-uuid": "fixture-worker-protocol-event" }, body: JSON.stringify(event) });
    const accepted = await deliver(); assert.equal(accepted.status, 202); await accepted.json();
    const duplicate = await deliver(); assert.equal(duplicate.status, 200); assert.equal((await duplicate.json()).status, "duplicate");
    const effectsPath = join(dataDir, "effects.json");
    mcp = await startMcp(dataDir, effectsPath, provider);
    const listed = await mcp.request("tools/list");
    assert.equal(listed.result.tools.length, 34);
    for (const name of ["review_worker_status", "review_job_retry"]) assert.ok(listed.result.tools.some((tool) => tool.name === name));
    let status;
    for (let attempt = 0; attempt < 100; attempt++) {
      status = await mcp.tool("review_worker_status");
      assert.equal(status.isError, false);
      assert.equal(status.data.enabled, true); assert.equal(status.data.configured, true);
      assert.equal(status.data.counts.failed, 0, JSON.stringify(status.data));
      assert.equal(status.data.counts.retry, 0, JSON.stringify(status.data));
      if (status.data.counts.completed === 1) break;
      await delay(50);
    }
    assert.equal(status.data.counts.completed, 1, JSON.stringify(status.data));
    const effects = JSON.parse(readFileSync(effectsPath, "utf8"));
    assert.deepEqual([effects.modelCalls, effects.commentPosts, effects.mmPosts], [1, 1, 1]);
    assert.equal(effects.rawDiffReads, 1);
    assert.deepEqual(effects.unexpected, []);
    assert.deepEqual(effects.modelEvidence, { headSha: SHA, perspectives: 1, jiraKeys: ["TEST-1"] });
    assert.equal(effects.notification.channel, "@fixture.mm");
    assert.match(effects.notification.text, /#note_77/);
    assert.match(effects.notes[0].body, /<!-- reviewbot:[a-f0-9]{64} -->/);
    assert.match(effects.notes[0].body, /이미지 1개는 시각적으로 확인하지 않았으며/);
    assert.equal(effects.notes[0].body.match(/이미지 1개는 시각적으로 확인하지 않았으며/g).length, 1);
    const history = await mcp.tool("review_history_list", { jira_keys: ["TEST-1"] });
    assert.equal(history.isError, false); assert.equal(history.data.total, 1);
    assert.equal(history.data.records[0].headSha, SHA);
    assert.equal((await mcp.tool("review_job_retry", { request_id: status.data.jobs[0].requestId })).isError, true);
    assert.equal(JSON.stringify(status.data).includes("빈 입력을 명시"), false, "Worker status must not disclose review memory bodies.");
  } finally {
    await mcp?.stop();
    if (receiver) { receiver.closeAllConnections(); if (receiver.listening) await new Promise((done) => receiver.close(done)); }
    inbox?.close();
    assert.equal(dirname(resolve(dataDir)), temporaryRoot);
    assert.ok(basename(dataDir).startsWith("review-worker-protocol-"));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
