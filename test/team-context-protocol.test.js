import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const networkGuard = `data:text/javascript,${encodeURIComponent('globalThis.fetch = async () => { throw new Error("Network disabled in protocol test"); };')}`;

async function start(dataDir) {
  const env = { MATTERMOST_MCP_DATA_DIR: dataDir };
  for (const key of ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP", "ComSpec"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const child = spawn(process.execPath, ["--import", networkGuard, join(root, "src/server.js")], {
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

test("stdio MCP registers six profiles, persists responsibilities and distinguishes unconnected context from empty Jira work", { timeout: 20_000 }, async () => {
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

    for (let index = 1; index <= 6; index++) {
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
    assert.equal((await mcp.tool("team_member_list")).data.length, 6);
    const updated = await mcp.tool("team_member_upsert", { ...profile(1), areas: ["Updated test area"] });
    assert.equal(updated.isError, false);
    const tooMany = await mcp.tool("team_member_upsert", profile(7));
    assert.equal(tooMany.isError, true);
    assert.equal((await mcp.tool("team_member_list")).data.length, 6);
    assert.equal(existsSync(join(dataDir, "people", "test-member-7", "profile.md")), false);

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
    assert.equal(restored.data.length, 6);
    assert.deepEqual(restored.data[0].areas, ["Updated test area"]);
    const restoredContext = await mcp.tool("team_member_context", { member_id: "test-member-6" });
    assert.equal(restoredContext.isError, false);
    assert.equal(restoredContext.data.member.jiraAccountId, "test-member:6");
    assert.equal(restoredContext.data.sync.lastSuccessAt, null);
  } finally {
    await mcp?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
