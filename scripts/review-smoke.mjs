import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createWebhookServer } from "../bin/gitlab-webhook.mjs";
import { ReviewInbox } from "../src/review-inbox.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), "reviewbot-smoke-"));
const secret = randomBytes(32).toString("hex");
const inbox = new ReviewInbox({ dataDir, username: "reviewer", userId: 42, projectIds: [100] });
const receiver = createWebhookServer({ inbox, secret });
await new Promise((done) => receiver.listen(0, "127.0.0.1", done));
const endpoint = `http://127.0.0.1:${receiver.address().port}/webhooks/gitlab`;
const child = spawn(process.execPath, [join(root, "src", "server.js")], {
  cwd: root, env: { ...process.env, MATTERMOST_MCP_DATA_DIR: dataDir }, stdio: ["pipe", "pipe", "pipe"],
});
let buffer = "";
let stderr = "";
const pending = new Map();
child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8000); });
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (waiter) { pending.delete(message.id); waiter(message); }
  }
});

function request(id, method, params = {}) {
  return new Promise((done, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP request failed: ${method}. ${stderr}`)); }, 10_000);
    pending.set(id, (value) => { clearTimeout(timer); done(value); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

async function call(id, name, args = {}) {
  const reply = await request(id, "tools/call", { name, arguments: args });
  assert.equal(reply.result.isError, false);
  return JSON.parse(reply.result.content[0].text);
}

const payload = {
  object_kind: "merge_request", project: { id: 100 }, user: { id: 7 },
  object_attributes: {
    iid: 12, action: "open", state: "opened", draft: false, description: "@reviewer please review",
    source_branch: "feature/example", last_commit: { id: "a".repeat(40) }, updated_at: "2026-10-20T00:00:00Z",
  }, reviewers: [],
};
async function deliver(eventId, event, token = secret) {
  return fetch(endpoint, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Gitlab-Event": "Merge Request Hook", "X-Gitlab-Token": token, "X-Gitlab-Event-UUID": eventId },
    body: JSON.stringify(event),
  });
}

try {
  const initialized = await request(1, "initialize", {
    protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "reviewbot-local-smoke", version: "1.0.0" },
  });
  assert.equal(initialized.result.serverInfo.name, "mmp");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
  assert.equal((await call(2, "review_pending_list")).length, 0);
  assert.equal((await deliver("event-1", payload, "invalid")).status, 401);
  assert.equal((await deliver("event-1", payload)).status, 202);
  assert.equal((await deliver("event-1", payload)).status, 200);
  const first = await call(3, "review_pending_list");
  assert.equal(first.length, 1);
  assert.equal(first[0].headSha, "a".repeat(40));
  const updated = structuredClone(payload);
  updated.object_attributes.description = "";
  updated.object_attributes.action = "update";
  updated.object_attributes.last_commit.id = "b".repeat(40);
  updated.object_attributes.updated_at = "2026-10-20T00:01:00Z";
  assert.equal((await deliver("event-2", updated)).status, 202);
  const latest = await call(4, "review_pending_list");
  assert.equal(latest.length, 1);
  assert.equal(latest[0].headSha, "b".repeat(40));
  assert.equal((await call(5, "review_inbox_status")).pending, 1);
  process.stdout.write("Local review smoke passed: authenticated webhook -> SQLite -> stdio MCP, duplicate delivery and new commit checked.\n");
} finally {
  if (child.exitCode === null) {
    const exited = new Promise((done) => child.once("exit", done));
    child.kill();
    await exited;
  }
  await new Promise((done) => receiver.close(done));
  inbox.close();
  assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()));
  rmSync(dataDir, { recursive: true, force: true });
}
