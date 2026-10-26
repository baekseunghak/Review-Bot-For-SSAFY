import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = fileURLToPath(new URL("..", import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), "mattermost-manager-smoke-"));
const child = spawn(process.execPath, [join(root, "src", "server.js")], {
  cwd: root,
  env: { ...process.env, MATTERMOST_MCP_DATA_DIR: dataDir },
  stdio: ["pipe", "pipe", "pipe"],
});

let buffer = "";
let stderr = "";
const pending = new Map();
child.stderr.on("data", (chunk) => { stderr += chunk; });
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (waiter) { pending.delete(message.id); waiter.resolve(message); }
  }
});

function request(id, method, params = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}. stderr: ${stderr}`));
    }, 10_000);
    pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

try {
  const initialized = await request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "1.0.0" },
  });
  assert.equal(initialized.result.serverInfo.name, "mmp");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
  const listed = await request(2, "tools/list");
  assert.equal(listed.result.tools.length, 35);
  assert.ok(listed.result.tools.some((tool) => tool.name === "review_inbox_status"));
  assert.ok(listed.result.tools.some((tool) => tool.name === "review_pending_list"));
  assert.ok(listed.result.tools.some((tool) => tool.name === "review_worker_status"));
  assert.ok(listed.result.tools.some((tool) => tool.name === "review_job_retry"));
  for (const name of ["team_member_upsert", "team_member_list", "team_sync", "team_review_comments_sync", "team_member_context", "team_weekly_summary", "review_context_prepare", "review_context_complete", "review_history_list"]) {
    assert.ok(listed.result.tools.some((tool) => tool.name === name));
  }
  const storage = await request(3, "tools/call", { name: "storage_info", arguments: {} });
  assert.deepEqual(JSON.parse(storage.result.content[0].text), {
    dataDir,
    counts: { webhooks: 0, channels: 0, participants: 0, conventions: 0 },
  });
  const called = await request(4, "tools/call", { name: "channel_list", arguments: {} });
  assert.equal(called.result.isError, false);
  assert.equal(called.result.content[0].text, "[]");
  const created = await request(5, "tools/call", {
    name: "participant_create",
    arguments: { display_name: "Test User", mattermost_username: "test.mm", gitlab_username: "test.gitlab" },
  });
  assert.equal(created.result.isError, false);
  const found = await request(6, "tools/call", {
    name: "participant_list",
    arguments: { name_query: "User" },
  });
  assert.equal(JSON.parse(found.result.content[0].text)[0].mention, "@test.mm");
  process.stdout.write(`MCP smoke test passed: ${listed.result.tools.length} tools, channel and participant calls succeeded.\n`);
} finally {
  if (child.exitCode === null) {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
  }
  rmSync(dataDir, { recursive: true, force: true });
}
