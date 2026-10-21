import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { UserError } from "../src/core.js";
import { ReviewInbox } from "../src/review-inbox.js";

const SHA = "a".repeat(40);
const NEXT_SHA = "b".repeat(40);
const NOW = "2026-10-20T09:00:00.000Z";
const LATER = "2026-10-20T09:00:01.000Z";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "review-inbox-worker-test-"));
  const instances = [];
  const open = (projectIds = [10]) => {
    const inbox = new ReviewInbox({ dataDir: directory, username: "reviewer", projectIds });
    instances.push(inbox);
    return inbox;
  };
  t.after(() => { for (const instance of instances) instance.close(); rmSync(directory, { recursive: true, force: true }); });
  return { instance: open(), open };
}

function send(instance, attributes = {}, eventId) {
  return instance.ingest({
    eventType: "Merge Request Hook", eventId,
    payload: {
      object_kind: "merge_request", project: { id: 10 },
      object_attributes: {
        iid: 7, action: "update", state: "opened", draft: false,
        description: "@reviewer", reviewer_ids: [], updated_at: NOW,
        last_commit: { id: SHA }, ...attributes,
      },
    },
  });
}

test("a request has one durable worker owner and completion prevents same-SHA repetition", (t) => {
  const { instance, open } = fixture(t);
  send(instance);
  const other = open();
  const job = instance.claimNext({ now: NOW });
  assert.equal(job.headSha, SHA);
  assert.equal(job.stage, "queued");
  assert.equal(job.attempt, 1);
  assert.equal(other.claimNext({ now: NOW }), null);
  assert.equal(instance.isCurrent(job.id, job.leaseToken, { now: NOW }), true);
  instance.checkpoint(job.id, job.leaseToken, { stage: "posted", artifact: { noteId: 12 }, now: NOW });
  instance.finish(job.id, job.leaseToken, { now: NOW });
  send(instance, {}, "same-sha-later-event");
  assert.equal(other.claimNext({ now: "2026-10-21T00:00:00Z" }), null);
  assert.equal(instance.listPending().length, 0);
  assert.equal(instance.status().pending, 0);
  assert.deepEqual(instance.workerStatus().counts, { running: 0, retry: 0, completed: 1, failed: 0 });
  send(instance, { updated_at: LATER, last_commit: { id: NEXT_SHA } });
  assert.equal(other.claimNext({ now: LATER }).headSha, NEXT_SHA);
});

test("expired leases recover prior artifacts while old owners lose mutation rights", (t) => {
  const { instance, open } = fixture(t);
  send(instance);
  const first = instance.claimNext({ now: NOW, leaseMs: 1000 });
  instance.checkpoint(first.id, first.leaseToken, { stage: "reviewed", artifact: { reviewId: "fixture-review" }, now: NOW });
  const other = open();
  const recovered = other.claimNext({ now: LATER });
  assert.equal(recovered.attempt, 2);
  assert.equal(recovered.stage, "reviewed");
  assert.deepEqual(recovered.artifact, { reviewId: "fixture-review" });
  assert.notEqual(recovered.leaseToken, first.leaseToken);
  assert.equal(instance.isCurrent(first.id, first.leaseToken, { now: LATER }), false);
  assert.throws(() => instance.finish(first.id, first.leaseToken, { now: LATER }), UserError);
  assert.throws(() => instance.checkpoint(first.id, first.leaseToken, { stage: "posted", now: LATER }), UserError);
  const renewed = other.renewClaim(recovered.id, recovered.leaseToken, { now: LATER, leaseMs: 1000 });
  assert.equal(renewed.leaseExpiresAt, "2026-10-20T09:00:02.000Z");
  other.checkpoint(recovered.id, recovered.leaseToken, { stage: "posted", artifact: { noteId: 12 }, now: LATER });
  assert.equal(instance.claimNext({ now: LATER }), null);
});

test("retry keeps completed stages and backs off before eventually failing closed", (t) => {
  const { instance } = fixture(t);
  send(instance);
  const first = instance.claimNext({ now: NOW });
  instance.checkpoint(first.id, first.leaseToken, { stage: "posted", artifact: { noteId: 12 }, now: NOW });
  assert.deepEqual(instance.retry(first.id, first.leaseToken, { errorCode: "mattermost_unavailable", delayMs: 1000, maxAttempts: 2, now: NOW }), {
    status: "retry", nextAttemptAt: LATER,
  });
  assert.equal(instance.claimNext({ now: NOW }), null);
  const second = instance.claimNext({ now: LATER });
  assert.equal(second.stage, "posted");
  assert.deepEqual(second.artifact, { noteId: 12 });
  assert.deepEqual(instance.retry(second.id, second.leaseToken, { errorCode: "mattermost_unavailable", maxAttempts: 2, now: LATER }), {
    status: "failed", nextAttemptAt: null,
  });
  assert.equal(instance.claimNext({ now: "2026-10-21T00:00:00Z" }), null);
  assert.equal(instance.status().pending, 0);
  assert.deepEqual(instance.workerStatus().counts, { running: 0, retry: 0, completed: 0, failed: 1 });
});

test("new commits, close, draft and changed allowlists invalidate external-mutation checks", (t) => {
  for (const update of [
    { last_commit: { id: NEXT_SHA } },
    { state: "closed", action: "close" },
    { draft: true },
  ]) {
    const { instance } = fixture(t);
    send(instance);
    const job = instance.claimNext({ now: NOW });
    send(instance, { ...update, updated_at: LATER });
    assert.equal(instance.isCurrent(job.id, job.leaseToken, { now: LATER }), false);
    // A publication receipt must survive even if the MR changed just after publishing.
    instance.checkpoint(job.id, job.leaseToken, { stage: "posted", artifact: { noteId: 12 }, now: LATER });
  }
  const { instance, open } = fixture(t);
  send(instance);
  const job = instance.claimNext({ now: NOW });
  const unconfigured = open([]);
  assert.equal(unconfigured.isCurrent(job.id, job.leaseToken, { now: NOW }), false);
  assert.equal(unconfigured.claimNext({ now: "2026-10-21T00:00:00Z" }), null);
});

test("worker inputs reject unsafe artifacts and errors without replacing a durable checkpoint", (t) => {
  const { instance } = fixture(t);
  send(instance);
  const job = instance.claimNext({ now: NOW });
  instance.checkpoint(job.id, job.leaseToken, { stage: "reviewed", artifact: { reviewId: "safe" }, now: NOW });
  assert.throws(() => instance.checkpoint(job.id, job.leaseToken, { stage: "bad stage", now: NOW }), UserError);
  assert.throws(() => instance.checkpoint(job.id, job.leaseToken, { stage: "reviewed", artifact: { body: "x".repeat(262144) }, now: NOW }), UserError);
  assert.throws(() => instance.retry(job.id, job.leaseToken, { errorCode: "Bearer secret token", now: NOW }), UserError);
  assert.throws(() => instance.claimNext({ now: "invalid" }), UserError);
  assert.throws(() => instance.renewClaim(job.id, job.leaseToken, { leaseMs: 0, now: NOW }), UserError);
  instance.retry(job.id, job.leaseToken, { errorCode: "temporary", delayMs: 1000, now: NOW });
  assert.deepEqual(instance.claimNext({ now: LATER }).artifact, { reviewId: "safe" });
});

test("publication recovery and notification resume despite a newer commit or closed MR", (t) => {
  for (const stage of ["posting", "posted", "notifying", "notification_unknown"]) {
    const { instance } = fixture(t);
    send(instance);
    const job = instance.claimNext({ now: NOW, leaseMs: 1000 });
    instance.checkpoint(job.id, job.leaseToken, { stage, artifact: { noteId: 12 }, now: NOW });
    send(instance, { updated_at: LATER, last_commit: { id: NEXT_SHA }, state: "closed", action: "close" });
    const recovered = instance.claimNext({ now: LATER });
    assert.equal(recovered.id, job.id);
    assert.equal(recovered.stage, stage);
    assert.equal(instance.isCurrent(recovered.id, recovered.leaseToken, { now: LATER }), false);
    instance.finish(recovered.id, recovered.leaseToken, { now: LATER });
    assert.equal(instance.claimNext({ now: LATER }), null);
  }
});

test("manual retry of uncertain notification requires explicit duplicate-delivery permission", (t) => {
  const { instance } = fixture(t);
  send(instance);
  const job = instance.claimNext({ now: NOW });
  instance.checkpoint(job.id, job.leaseToken, { stage: "notification_unknown", artifact: { noteId: 12, body: "private fixture body" }, now: NOW });
  instance.retry(job.id, job.leaseToken, { errorCode: "delivery_unknown", maxAttempts: 1, now: NOW });
  assert.throws(() => instance.retryFailed(job.id, { now: LATER }), UserError);
  assert.deepEqual(instance.workerStatus(), {
    counts: { running: 0, retry: 0, completed: 0, failed: 1 },
    jobs: [{ requestId: job.id, stage: "notification_unknown", status: "failed", attempt: 1, lastErrorCode: "delivery_unknown",
      lastErrorMessage: "추가 진단이 필요한 처리 오류입니다. 오류 코드와 단계를 확인하세요.", nextAttemptAt: null }],
  });
  assert.deepEqual(instance.retryFailed(job.id, { allowNotificationDuplicate: true, now: LATER }), {
    requestId: job.id, status: "retry", stage: "posted", nextAttemptAt: LATER,
  });
  const retried = instance.claimNext({ now: LATER });
  assert.equal(retried.stage, "posted");
  assert.equal(retried.attempt, 1);
  assert.equal(retried.artifact.noteId, 12);
  assert.throws(() => instance.retryFailed(job.id, { now: LATER }), UserError);
});

test("ordinary failed reviews can be retried without notification permission", (t) => {
  const { instance } = fixture(t);
  send(instance);
  const job = instance.claimNext({ now: NOW });
  instance.retry(job.id, job.leaseToken, { errorCode: "provider_unavailable", maxAttempts: 1, now: NOW });
  assert.equal(instance.retryFailed(job.id, { now: LATER }).stage, "queued");
  assert.equal(instance.claimNext({ now: LATER }).attempt, 1);
  assert.throws(() => instance.workerStatus({ limit: 0 }), UserError);
});

test("explicit retry advances a waiting job without duplicating a running or completed job", (t) => {
  const { instance } = fixture(t);
  send(instance);
  const job = instance.claimNext({ now: NOW });
  instance.checkpoint(job.id, job.leaseToken, { stage: "reviewing", artifact: { marker: "fixture" }, now: NOW });
  instance.retry(job.id, job.leaseToken, { errorCode: "runner_response_invalid", delayMs: 60_000, now: NOW });
  assert.equal(instance.claimNext({ now: LATER }), null);
  assert.deepEqual(instance.retryFailed(job.id, { now: LATER }), {
    requestId: job.id, status: "retry", stage: "reviewing", nextAttemptAt: LATER,
  });
  const resumed = instance.claimNext({ now: LATER });
  assert.equal(resumed.id, job.id);
  assert.equal(resumed.attempt, 1);
  assert.equal(resumed.artifact.marker, "fixture");
  assert.throws(() => instance.retryFailed(job.id, { now: LATER }), UserError);
  instance.finish(resumed.id, resumed.leaseToken, { now: LATER });
  assert.throws(() => instance.retryFailed(job.id, { now: LATER }), UserError);
});

test("successful notification finishes atomically with its completed stage", (t) => {
  const { instance } = fixture(t);
  send(instance);
  const job = instance.claimNext({ now: NOW });
  instance.checkpoint(job.id, job.leaseToken, { stage: "notifying", now: NOW });
  instance.finish(job.id, job.leaseToken, { now: NOW });
  assert.equal(instance.workerStatus().jobs[0].stage, "completed");
});

test("obsolete expired and retry executions are cleaned up while another valid lease is preserved", (t) => {
  for (const status of ["expired", "retry", "owned"]) {
    const { instance } = fixture(t);
    send(instance);
    const first = instance.claimNext({ now: NOW, leaseMs: status === "owned" ? 5000 : 1000 });
    instance.checkpoint(first.id, first.leaseToken, { stage: "reviewed", now: NOW });
    if (status === "retry") instance.retry(first.id, first.leaseToken, { errorCode: "temporary", now: NOW });
    send(instance, { updated_at: LATER, last_commit: { id: NEXT_SHA } });
    const next = instance.claimNext({ now: LATER });
    assert.equal(next.headSha, NEXT_SHA);
    const previous = instance.workerStatus().jobs.find((job) => job.requestId === first.id);
    assert.equal(previous.status, status === "owned" ? "running" : "completed");
    assert.equal(previous.stage, status === "owned" ? "reviewed" : "skipped");
    assert.equal(instance.workerStatus().counts.running, status === "owned" ? 2 : 1);
    assert.equal(instance.workerStatus().counts.retry, 0);
  }
});

test("ready and reopen transitions resume skipped same-SHA reviews but stale or repeated events do not", (t) => {
  for (const paused of [{ draft: true }, { state: "closed", action: "close" }]) {
    const { instance } = fixture(t);
    send(instance);
    const job = instance.claimNext({ now: NOW });
    send(instance, { ...paused, updated_at: LATER });
    instance.checkpoint(job.id, job.leaseToken, { stage: "skipped", now: LATER });
    instance.finish(job.id, job.leaseToken, { now: LATER });
    send(instance, { updated_at: NOW, draft: false, state: "opened", action: "reopen" }, "stale-ready");
    assert.equal(instance.claimNext({ now: LATER }), null);
    send(instance, { updated_at: "2026-10-20T09:00:02Z", draft: false, state: "opened", action: "reopen" });
    const resumed = instance.claimNext({ now: "2026-10-20T09:00:02Z" });
    assert.equal(resumed.headSha, SHA);
    assert.equal(resumed.stage, "queued");
    assert.equal(resumed.attempt, 1);
    assert.deepEqual(resumed.artifact, {});
    instance.checkpoint(resumed.id, resumed.leaseToken, { stage: "skipped", now: "2026-10-20T09:00:02Z" });
    instance.finish(resumed.id, resumed.leaseToken, { now: "2026-10-20T09:00:02Z" });
    send(instance, { updated_at: "2026-10-20T09:00:02Z" }, "repeated-opened");
    assert.equal(instance.claimNext({ now: "2026-10-20T09:00:03Z" }), null);
  }
});

test("returning to a prior skipped SHA requeues it while actual completed publications stay completed", (t) => {
  for (const stage of ["skipped", "completed"]) {
    const { instance } = fixture(t);
    send(instance);
    const first = instance.claimNext({ now: NOW });
    instance.checkpoint(first.id, first.leaseToken, { stage, now: NOW });
    instance.finish(first.id, first.leaseToken, { now: NOW });
    send(instance, { updated_at: LATER, last_commit: { id: NEXT_SHA } });
    send(instance, { updated_at: "2026-10-20T09:00:02Z", last_commit: { id: SHA } });
    const resumed = instance.claimNext({ now: "2026-10-20T09:00:02Z" });
    assert.equal(resumed?.headSha ?? null, stage === "skipped" ? SHA : null);
  }
});

test("obsolete cleanup touches only projects in this worker's allowlist", (t) => {
  const { instance, open } = fixture(t);
  send(instance);
  const job = instance.claimNext({ now: NOW, leaseMs: 1000 });
  send(instance, { updated_at: LATER, state: "closed", action: "close" });
  const unrelated = open([11]);
  assert.equal(unrelated.claimNext({ now: LATER }), null);
  assert.equal(instance.workerStatus().jobs[0].status, "running");
  assert.equal(instance.claimNext({ now: LATER }), null);
  assert.equal(instance.workerStatus().jobs[0].requestId, job.id);
  assert.equal(instance.workerStatus().jobs[0].status, "completed");
  assert.equal(instance.workerStatus().jobs[0].stage, "skipped");
});

test("a fresh ready webhook recovers a live-API skip when the pause webhook never arrived", (t) => {
  const { instance } = fixture(t);
  send(instance);
  const job = instance.claimNext({ now: NOW });
  // GitLab reported a closed MR during live verification; its close webhook was absent.
  instance.checkpoint(job.id, job.leaseToken, { stage: "skipped", artifact: { outcome: "review_not_open" }, now: NOW });
  instance.finish(job.id, job.leaseToken, { now: NOW });
  send(instance, { updated_at: NOW }, "same-opened-snapshot");
  assert.equal(instance.claimNext({ now: LATER }), null);
  send(instance, { updated_at: LATER }, "fresh-reopened-snapshot");
  const resumed = instance.claimNext({ now: LATER });
  assert.equal(resumed.id, job.id);
  assert.equal(resumed.headSha, SHA);
  assert.equal(resumed.stage, "queued");
  assert.equal(resumed.attempt, 1);
});
