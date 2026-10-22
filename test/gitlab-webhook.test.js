import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWebhookServer } from "../bin/gitlab-webhook.mjs";
import { reviewSettings } from "../src/review-config.js";
import { ReviewInbox } from "../src/review-inbox.js";
import { reviewCommentMarker } from "../src/review-gitlab.js";

const secret = "local-test-only-secret-123456789";

async function withServer(callback, options = {}) {
  const received = [];
  const inbox = { status: () => ({ pending: received.length }), ingest: (event) => { received.push(event); return { status: "queued" }; } };
  const server = createWebhookServer({ inbox, secret, ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try { await callback({ url, received }); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

function post(url, body = "{}", extraHeaders = {}) {
  return fetch(`${url}/webhooks/gitlab`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Gitlab-Token": secret, "X-Gitlab-Event": "Merge Request Hook", ...extraHeaders }, body,
  });
}

test("health is readable but missing receiver settings reject events", async () => {
  await withServer(async ({ url, received }) => {
    const health = await (await fetch(`${url}/health`)).json();
    assert.equal(health.configured, false);
    assert.equal((await post(url)).status, 503);
    assert.equal(received.length, 0);
  }, { ready: false });
});

test("invalid authentication cannot reach storage or echo its token", async () => {
  await withServer(async ({ url, received }) => {
    const response = await post(url, "{}", { "X-Gitlab-Token": "wrong-secret" });
    assert.equal(response.status, 401);
    assert.equal((await response.text()).includes("wrong-secret"), false);
    assert.equal(received.length, 0);
  });
});

test("authenticated JSON passes only the expected event fields", async () => {
  await withServer(async ({ url, received }) => {
    const response = await post(url, '{"project":{"id":100}}', { "X-Gitlab-Event-UUID": "test-event" });
    assert.equal(response.status, 202);
    assert.deepEqual(received, [{ eventType: "Merge Request Hook", eventId: "test-event", payload: { project: { id: 100 } } }]);
    assert.equal((await fetch(`${url}/webhooks/gitlab`)).status, 405);
    assert.equal((await fetch(`${url}/unknown`)).status, 404);
  });
});

test("authenticated self-mentions queue once while posted review webhooks cannot start a loop", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "review-self-mention-"));
  const inbox = new ReviewInbox({ dataDir, username: "reviewer", userId: 42, botUserId: 42, projectIds: [100] });
  const server = createWebhookServer({ inbox, secret });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${server.address().port}`;
  const headSha = "a".repeat(40);
  const payload = {
    object_kind: "note", project: { id: 100 }, user: { id: 42 },
    object_attributes: { id: 1, author_id: 42, noteable_type: "MergeRequest", action: "create", note: "@reviewer please review" },
    merge_request: { iid: 7, author_id: 42, state: "opened", description: "", last_commit: { id: headSha } },
  };
  const deliver = (eventId) => post(url, JSON.stringify(payload), { "X-Gitlab-Event": "Note Hook", "X-Gitlab-Event-UUID": eventId });
  try {
    assert.equal((await (await deliver("human-note")).json()).status, "queued");
    assert.equal((await deliver("human-note")).status, 200);
    const job = inbox.claimNext();
    payload.object_attributes.note = `@reviewer review result\n\n${reviewCommentMarker({ host: "gitlab.example.test", projectId: 100, mrIid: 7, headSha })}`;
    payload.object_attributes.id = 2;
    for (const action of ["create", "update"]) {
      payload.object_attributes.action = action;
      assert.deepEqual(await (await deliver(`bot-note-${action}`)).json(), { status: "ignored", reason: "own_comment" });
    }
    inbox.finish(job.id, job.leaseToken);
    payload.object_attributes.note = "@reviewer please review again";
    payload.object_attributes.id = 3;
    await deliver("another-human-note");
    assert.equal(inbox.claimNext(), null);
    assert.equal(inbox.status().pending, 0);
    assert.equal(inbox.workerStatus().counts.completed, 1);
  } finally {
    await new Promise((done) => server.close(done));
    inbox.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("malformed JSON and wrong media types are rejected", async () => {
  await withServer(async ({ url, received }) => {
    assert.equal((await post(url, "{")).status, 400);
    assert.equal((await post(url, "{}", { "Content-Type": "text/plain" })).status, 415);
    assert.equal(received.length, 0);
  });
});

test("oversized bodies are rejected before reaching storage", async () => {
  await withServer(async ({ url, received }) => {
    assert.equal((await post(url, JSON.stringify({ text: "x".repeat(200) }))).status, 413);
    assert.equal(received.length, 0);
  }, { maxBodyBytes: 100 });
});

test("chunked requests obey the body limit without Content-Length", async () => {
  await withServer(async ({ url, received }) => {
    const status = await new Promise((done, reject) => {
      const request = httpRequest(`${url}/webhooks/gitlab`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Gitlab-Token": secret, "Transfer-Encoding": "chunked" },
      }, (response) => { response.resume(); response.once("end", () => done(response.statusCode)); });
      request.on("error", reject);
      request.write("x".repeat(60));
      request.write("y".repeat(60));
      request.end();
    });
    assert.equal(status, 413);
    assert.equal(received.length, 0);
  }, { maxBodyBytes: 100 });
});

test("receiver settings validate IDs, port and secret without exposing inputs", () => {
  const settings = reviewSettings({ REVIEWBOT_GITLAB_PROJECT_IDS: "100, 101,100", REVIEWBOT_GITLAB_USER_ID: "42" });
  assert.deepEqual(settings.projectIds, [100, 101]);
  assert.equal(settings.userId, 42);
  assert.equal(settings.port, 8765);
  assert.throws(() => reviewSettings({ REVIEWBOT_PORT: "65536" }));
  assert.throws(() => reviewSettings({ REVIEWBOT_GITLAB_PROJECT_IDS: "-1" }));
  assert.throws(() => reviewSettings({ REVIEWBOT_WEBHOOK_SECRET: "short" }));
});
