import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { TeamContextService } from "../src/team-context.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const networkGuard = `data:text/javascript,${encodeURIComponent('globalThis.fetch = async () => { throw new Error("Network disabled in protocol test"); };')}`;

async function start(dataDir, { headSha } = {}) {
  const env = { MATTERMOST_MCP_DATA_DIR: dataDir };
  for (const key of ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP", "ComSpec"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const mockGlab = headSha ? `data:text/javascript,${encodeURIComponent(`
    import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    function fixtureExec() { throw new Error('Real CLI disabled in test'); }
    fixtureExec[Symbol.for('nodejs.util.promisify.custom')] = async (file, args) => {
      if (file !== 'glab' || args[0] !== 'api' || !args[1].endsWith('/merge_requests/31')) throw new Error('Unexpected test CLI request');
      return { stdout: JSON.stringify({ sha: ${JSON.stringify(headSha)} }), stderr: '' };
    };
    cp.execFile = fixtureExec;
    syncBuiltinESMExports();
    globalThis.fetch = async () => { throw new Error('Network disabled in protocol test'); };
  `)}` : networkGuard;
  const child = spawn(process.execPath, ["--import", mockGlab, join(root, "src/server.js")], {
    cwd: root, env, stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 1;
  const rejectAll = () => {
    for (const waiter of pending.values()) waiter.reject(new Error("The test MCP server stopped before replying."));
    pending.clear();
  };
  child.on("error", rejectAll);
  child.on("exit", rejectAll);
  lines.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { rejectAll(); return; }
    const waiter = pending.get(message.id);
    if (waiter) { pending.delete(message.id); waiter.resolve(message); }
  });

  function request(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("The test MCP request timed out.")); }, 5_000);
      pending.set(id, {
        resolve: (result) => { clearTimeout(timer); resolve(result); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
        if (error) { pending.delete(id); clearTimeout(timer); reject(new Error("The test MCP request could not be written.")); }
      });
    });
  }

  async function stop() {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit", { signal: AbortSignal.timeout(5_000) });
      child.kill();
      await exited;
    }
  }

  try {
    const initialized = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "team-context-test", version: "1.0.0" } });
    assert.equal(initialized.result.serverInfo.name, "mmp");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
    return {
      request, stop,
      async tool(name, args = {}) {
        const reply = await request("tools/call", { name, arguments: args });
        assert.equal(reply.error, undefined);
        return { isError: reply.result.isError, data: JSON.parse(reply.result.content[0].text) };
      },
    };
  } catch (error) { await stop(); throw error; }
}

function profile(index) {
  return {
    id: `test-member-${index}`, display_name: `테스트 팀원 ${index}`,
    gitlab_username: `test.member.${index}`, gitlab_user_id: 100 + index,
    jira_account_id: `test-member:${index}`, areas: [`Test area ${index}`],
    paths: [`module-${index}/src`], review_focus: ["Input and integration failures"],
  };
}

test("stdio MCP registers ten profiles, persists responsibilities and distinguishes unconnected context from empty Jira work", { timeout: 20_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "team-context-protocol-"));
  let mcp;
  try {
    mcp = await start(dataDir);
    const tools = await mcp.request("tools/list");
    for (const name of ["team_member_upsert", "team_member_list", "team_sync", "team_member_context", "team_weekly_summary", "review_context_prepare"]) {
      assert.ok(tools.result.tools.some((tool) => tool.name === name));
    }
    assert.deepEqual((await mcp.tool("team_member_list")).data, []);
    const unknown = await mcp.tool("team_member_context", { member_id: "test-member-1" });
    assert.equal(unknown.isError, true);
    assert.equal((await mcp.tool("team_weekly_summary")).isError, true);

    for (let index = 1; index <= 10; index++) {
      const args = profile(index);
      const created = await mcp.tool("team_member_upsert", args);
      assert.equal(created.isError, false);
      assert.equal(created.data.id, args.id);
      assert.deepEqual(created.data.paths, args.paths);
      assert.deepEqual(created.data.reviewFocus, args.review_focus);
      const file = join(dataDir, "people", args.id, "profile.md");
      assert.ok(existsSync(file));
      assert.ok(readFileSync(file, "utf8").includes(args.review_focus[0]));
    }
    assert.equal((await mcp.tool("team_member_list")).data.length, 10);
    const updated = await mcp.tool("team_member_upsert", { ...profile(1), areas: ["Updated test area"] });
    assert.equal(updated.isError, false);
    assert.equal(existsSync(join(dataDir, "people", "test-member-7", "profile.md")), true);

    for (const name of ["team_sync", "team_weekly_summary"]) {
      const result = await mcp.tool(name);
      assert.equal(result.isError, true);
      assert.match(result.data.error, /REVIEWBOT_JIRA/);
    }
    const context = await mcp.tool("team_member_context", { member_id: "test-member-1" });
    assert.equal(context.isError, false);
    assert.deepEqual(context.data.member.areas, ["Updated test area"]);
    assert.deepEqual(context.data.issues, []);
    assert.equal(context.data.sync.lastSuccessAt, null);
    assert.equal(context.data.sync.lastFailureAt, null);
    assert.equal(context.data.nextOffset, null);
    assert.equal(existsSync(join(dataDir, "people", "test-member-1", "weekly")), false);

    await mcp.stop();
    mcp = await start(dataDir);
    const restored = await mcp.tool("team_member_list");
    assert.equal(restored.isError, false);
    assert.equal(restored.data.length, 10);
    assert.deepEqual(restored.data[0].areas, ["Updated test area"]);
    const restoredContext = await mcp.tool("team_member_context", { member_id: "test-member-10" });
    assert.equal(restoredContext.isError, false);
    assert.equal(restoredContext.data.member.jiraAccountId, "test-member:10");
    assert.equal(restoredContext.data.sync.lastSuccessAt, null);
  } finally {
    await mcp?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("stdio completion persists bound memory and returns it through the history tool without external writes", { timeout: 20_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "review-memory-protocol-"));
  const headSha = "b".repeat(40);
  const mrUrl = "https://gitlab.example.test/team/repo/-/merge_requests/31";
  const issue = { key: "TEST-31", summary: "Fixture workflow", description: "Fixture acceptance criteria",
    status: { id: "1", name: "In progress", category: "indeterminate" },
    assigneeAccountId: "test-member:1", updatedAt: "2026-10-20T00:00:00.000Z", createdAt: "2026-10-19T00:00:00.000Z",
    url: "https://jira.example.test/browse/TEST-31", components: [], inCurrentSprint: true,
    history: [], historyComplete: true, descriptionTruncated: false };
  let contextService;
  let mcp;
  try {
    contextService = new TeamContextService({ dataDir, jiraClient: { configured: true,
      async getMemberIssues() { return { issues: [issue], complete: true, fetchedAt: "2026-10-20T00:00:00.000Z" }; },
      async getIssue() { return issue; },
    } });
    const p = profile(1);
    contextService.upsertMember({ id: p.id, displayName: p.display_name, gitlabUsername: p.gitlab_username,
      gitlabUserId: p.gitlab_user_id, jiraAccountId: p.jira_account_id, areas: p.areas, paths: p.paths, reviewFocus: p.review_focus });
    const prepared = await contextService.prepareReview({ mrUrl, headSha, author: { id: p.gitlab_user_id, username: p.gitlab_username },
      issueKeys: [issue.key], changedPaths: ["module-1/src/handler.js"] });
    contextService.close();
    contextService = null;
    mcp = await start(dataDir, { headSha });
    const listed = await mcp.request("tools/list");
    assert.equal(listed.result.tools.length, 35);
    assert.ok(listed.result.tools.some((tool) => tool.name === "review_context_prepare" && tool.inputSchema.properties.jira_keys));
    assert.equal((await mcp.tool("review_history_list")).data.total, 0);
    const memory = {
      implementation: [{ summary: "Handler validates requests before processing", basis: "observed", evidence: [{ kind: "code", ref: "module-1/src/handler.js:12" }] }],
      decisions: [{ decision: "Validate first", reason: "Reject invalid requests before doing work", basis: "reported", evidence: [{ kind: "mr_description", ref: mrUrl }] }],
      validations: [{ check: "Fixture handler test", result: "passed", basis: "reported", evidence: [{ kind: "mr_comment", ref: `${mrUrl}#note_19` }] }],
      remainingWork: [{ summary: "Load test has not been confirmed", basis: "unknown", evidence: [] }],
    };
    const args = { mr_url: mrUrl, head_sha: headSha, context_version: prepared.contextVersion, verdict: "hold", memory };
    const mismatched = await mcp.tool("review_context_complete", { ...args, context_version: "0".repeat(64) });
    assert.equal(mismatched.isError, true);
    assert.equal((await mcp.tool("review_history_list")).data.total, 0);
    const saved = await mcp.tool("review_context_complete", args);
    assert.equal(saved.isError, false);
    assert.equal(saved.data.stage, "reviewed");
    assert.equal(saved.data.authorMemberId, p.id);
    assert.deepEqual(saved.data.issueKeys, [issue.key]);
    assert.deepEqual(saved.data.changedPaths, ["module-1/src/handler.js"]);
    assert.deepEqual(saved.data.memory, memory);
    const repeated = await mcp.tool("review_context_complete", args);
    assert.equal(repeated.isError, false);
    assert.equal(repeated.data.id, saved.data.id);
    assert.ok(existsSync(saved.data.path));
    const found = await mcp.tool("review_history_list", { jira_keys: [issue.key], limit: 1 });
    assert.equal(found.isError, false);
    assert.equal(found.data.total, 1);
    assert.equal(found.data.nextOffset, null);
    assert.equal(found.data.records[0].id, saved.data.id);
    assert.equal((await mcp.tool("review_history_list", { jira_keys: ["TEST-99"] })).data.total, 0);
    const extraField = await mcp.request("tools/call", { name: "review_context_complete", arguments: { ...args, jira_keys: ["TEST-99"] } });
    assert.equal(extraField.result.isError, true);
    assert.equal((await mcp.tool("review_history_list")).data.total, 1);
  } finally {
    contextService?.close();
    await mcp?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
