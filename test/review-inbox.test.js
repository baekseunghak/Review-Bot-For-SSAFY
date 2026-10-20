import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { UserError } from "../src/core.js";
import { ReviewInbox } from "../src/review-inbox.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(64);
const T1 = "2026-10-20T09:00:00.000001Z";
const T2 = "2026-10-20T09:00:00.000002Z";
const T3 = "2026-10-20T09:00:01Z";

function mr(attributes = {}, reviewers = []) {
  return {
    object_kind: "merge_request",
    project: { id: 10 },
    user: { id: 20 },
    object_attributes: {
      iid: 7, state: "opened", action: "update", draft: false,
      description: "", reviewer_ids: [], updated_at: T1, last_commit: { id: A },
      ...attributes,
    },
    reviewers,
  };
}

function note(body = "@reviewer please review", attributes = {}, mrAttributes = {}) {
  return {
    object_kind: "note", project: { id: 10 }, user: { id: 20 },
    object_attributes: { id: 90, noteable_type: "MergeRequest", action: "create", note: body, author_id: 20, ...attributes },
    merge_request: mr(mrAttributes).object_attributes,
  };
}

function inbox(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), "review-inbox-test-"));
  const instance = new ReviewInbox({ dataDir: directory, username: "reviewer", userId: 30, botUserId: 99, projectIds: [10], ...overrides });
  t.after(() => { instance.close(); rmSync(directory, { recursive: true, force: true }); });
  return { instance, directory };
}

function send(instance, payload = mr({ description: "@reviewer please review" }), eventId) {
  return instance.ingest({ eventType: payload.object_kind === "note" ? "Note Hook" : "Merge Request Hook", eventId, payload });
}

test("description mention, comment mention and reviewer assignment each queue requests", (t) => {
  const { instance } = inbox(t);
  send(instance, mr({ description: "@reviewer please review" }));
  send(instance, note("@reviewer please review", {}, { iid: 8 }));
  send(instance, mr({ iid: 9 }, [{ id: 30, username: "renamed-account" }]));
  assert.deepEqual(instance.listPending().map((request) => request.reasons), [
    ["description_mention"], ["comment_mention"], ["reviewer_assigned"],
  ]);
  send(instance, mr({ iid: 11 }, [{ id: 31, username: "REVIEWER" }]));
  send(instance, mr({ iid: 12, reviewer_ids: [30] }));
  assert.equal(instance.status().pending, 5);
});

test("mentions in code, quotes, addresses, URLs, and different usernames do not trigger", (t) => {
  const { instance } = inbox(t);
  const excluded = [
    "`@reviewer`", "``code ` @reviewer``", "```js\n@reviewer\n```",
    "~~~\n@reviewer\n~~~", "    @reviewer", "\t@reviewer",
    "> @reviewer", "> quoted\n@reviewer", "<code>@reviewer</code>",
    "<pre>\n@reviewer\n</pre>", "<blockquote>@reviewer</blockquote>",
    "sender@reviewer.example", "sender@reviewer", "@reviewer@example.com",
    "https://example.test/@reviewer", "www.example.test/@reviewer",
    "example.test?user=@reviewer", '<span title="@reviewer">plain text</span>',
    "[link](/profile/@reviewer)", "@reviewer2", "@reviewer.other", "@reviewer-team", "@reviewer/team",
  ];
  for (const [index, body] of excluded.entries()) {
    assert.equal(send(instance, mr({ iid: index + 1, description: body })).status, "ignored", body);
  }
  assert.equal(instance.status().pending, 0);
  send(instance, mr({ iid: 100, description: "> quoted @other\n\n@reviewer, please review." }));
  send(instance, mr({ iid: 101, description: "Please review, @reviewer." }));
  assert.equal(instance.status().pending, 2);
});

test("comments use the same exact mention rules", (t) => {
  const { instance } = inbox(t);
  send(instance, note("`@reviewer`"));
  send(instance, note("> @reviewer", { id: 91 }));
  assert.equal(instance.status().pending, 0);
  send(instance, note("@REVIEWER please", { id: 92 }));
  assert.deepEqual(instance.listPending()[0].reasons, ["comment_mention"]);
});

test("all three reasons merge into one request for the same revision", (t) => {
  const { instance } = inbox(t);
  const first = send(instance, mr({ description: "@reviewer" }), "first-event");
  const second = send(instance, note("@reviewer", {}, { reviewers: [{ id: 30 }], description: "@reviewer" }), "second-event");
  assert.equal(first.requestId, second.requestId);
  assert.equal(instance.status().pending, 1);
  assert.deepEqual(new Set(instance.listPending()[0].reasons), new Set(["description_mention", "comment_mention", "reviewer_assigned"]));
});

test("delivery IDs and fallback payload hashes reject duplicates", (t) => {
  const { instance } = inbox(t);
  assert.equal(send(instance, undefined, "delivery-1").status, "queued");
  assert.equal(send(instance, undefined, "delivery-1").status, "duplicate");
  assert.equal(send(instance).status, "queued");
  assert.equal(send(instance).status, "duplicate");
  assert.equal(instance.status().pending, 1);
  assert.equal(instance.status().events, 2);
});

test("a separate instance and a restart see the durable pending request and deduplication", (t) => {
  const { instance, directory } = inbox(t);
  const first = send(instance, undefined, "persisted-delivery");
  let reopened = new ReviewInbox({ dataDir: directory, username: "reviewer", projectIds: [10] });
  assert.equal(reopened.listPending()[0].requestId, first.requestId);
  reopened.close();
  reopened = new ReviewInbox({ dataDir: directory, username: "reviewer", projectIds: [10] });
  try {
    assert.equal(send(reopened, undefined, "persisted-delivery").status, "duplicate");
    assert.equal(reopened.status().pending, 1);
  } finally { reopened.close(); }
});

test("a tracked MR queues a new commit without another mention and supersedes the previous revision", (t) => {
  const { instance } = inbox(t);
  send(instance);
  send(instance, mr({ updated_at: T2, last_commit: { id: B } }));
  assert.equal(instance.status().pending, 1);
  assert.equal(instance.listPending()[0].headSha, B);
  assert.ok(instance.listPending()[0].reasons.includes("new_commit"));
  send(instance, mr({ updated_at: T3, last_commit: { id: C.toUpperCase() } }));
  assert.equal(instance.listPending()[0].headSha, C);
});

test("old snapshots cannot roll back the head or close a newer open revision", (t) => {
  const { instance } = inbox(t);
  send(instance);
  send(instance, mr({ updated_at: T2, last_commit: { id: B } }));
  send(instance, mr({ action: "close", state: "closed", updated_at: T1 }));
  assert.equal(instance.listPending()[0].headSha, B);
  assert.equal(instance.status().closed, 0);
});

test("a late first mention uses the previously observed latest snapshot", (t) => {
  const { instance } = inbox(t);
  send(instance, mr({ updated_at: T2, last_commit: { id: B } }));
  assert.equal(instance.status().tracked, 0);
  send(instance, note());
  assert.equal(instance.listPending()[0].headSha, B);
  assert.deepEqual(instance.listPending()[0].reasons, ["comment_mention"]);
});

test("old and undated requests cannot reopen a newer closed MR", (t) => {
  const { instance } = inbox(t);
  send(instance, mr({ action: "close", state: "closed", updated_at: T2 }));
  send(instance, note());
  send(instance, mr({ action: "reopen", description: "@reviewer", updated_at: null }));
  assert.equal(instance.status().pending, 0);
  assert.equal(instance.status().tracked, 1);
  assert.equal(instance.status().closed, 1);
});

test("equal timestamps with conflicting heads retain the observed revision", (t) => {
  const { instance } = inbox(t);
  send(instance);
  send(instance, mr({ last_commit: { id: B } }));
  assert.equal(instance.listPending()[0].headSha, A);
});

test("a close at the same timestamp cancels work and cannot be undone by a simultaneous reopen", (t) => {
  const { instance } = inbox(t);
  send(instance);
  send(instance, mr({ action: "close", state: "closed" }));
  assert.equal(instance.status().pending, 0);
  send(instance, mr({ action: "reopen" }));
  assert.equal(instance.status().pending, 0);
});

test("close and merge cancel pending reviews; reopen resumes tracking", (t) => {
  const { instance } = inbox(t);
  send(instance);
  send(instance, mr({ action: "close", state: "closed", updated_at: T2 }));
  assert.equal(instance.status().pending, 0);
  send(instance, mr({ action: "reopen", updated_at: T3 }));
  assert.equal(instance.status().pending, 1);
  send(instance, mr({ action: "merge", state: "merged", updated_at: "2026-10-20T09:00:02Z" }));
  assert.equal(instance.status().pending, 0);
  assert.equal(instance.status().closed, 1);
});

test("draft requests remain tracked and resume when marked ready", (t) => {
  const { instance } = inbox(t);
  assert.equal(send(instance, mr({ description: "@reviewer", draft: true })).status, "held");
  assert.equal(instance.status().tracked, 1);
  assert.equal(instance.status().held, 1);
  assert.equal(instance.status().pending, 0);
  send(instance, mr({ updated_at: T2, draft: false }));
  assert.equal(instance.status().pending, 1);
  assert.equal(instance.status().held, 0);
  send(instance, mr({ updated_at: T3, draft: true }));
  assert.equal(instance.status().pending, 0);
  assert.equal(instance.status().held, 1);
});

test("missing SHAs defer requests and invalidate a previously pending unknown revision", (t) => {
  const { instance } = inbox(t);
  send(instance, mr({ description: "@reviewer", last_commit: null }));
  assert.equal(instance.status().tracked, 1);
  assert.equal(instance.status().pending, 0);
  send(instance, mr({ updated_at: T2, last_commit: { id: A } }));
  assert.equal(instance.status().pending, 1);
  send(instance, mr({ updated_at: T3, last_commit: { id: "" } }));
  assert.equal(instance.status().pending, 0);
});

test("the bot's own notes are ignored without dropping human requests", (t) => {
  const { instance } = inbox(t);
  assert.deepEqual(send(instance, note("@reviewer", { author_id: 99 })), { status: "ignored", reason: "own_comment" });
  assert.equal(instance.status().events, 0);
  assert.equal(send(instance, note()).status, "queued");
});

test("project allowlists fail closed and unsupported events or issue notes are ignored", (t) => {
  const { instance } = inbox(t);
  const other = mr({ description: "@reviewer" });
  other.project.id = 11;
  assert.deepEqual(send(instance, other), { status: "ignored", reason: "project_not_allowed" });
  assert.equal(instance.ingest({ eventType: "Push Hook", payload: {} }).reason, "unsupported_event");
  assert.equal(send(instance, note("@reviewer", { noteable_type: "Issue" })).reason, "not_merge_request");
  assert.equal(instance.status().events, 0);
  const { instance: unconfigured } = inbox(t, { projectIds: [] });
  assert.equal(send(unconfigured).reason, "not_configured");
  const { instance: noTarget } = inbox(t, { username: "", userId: null });
  assert.equal(send(noTarget).reason, "not_requested");
});

test("invalid boundaries raise redacted UserError without storing an event", (t) => {
  const { instance } = inbox(t);
  const malformed = [
    null, [], { ...mr(), object_attributes: [] }, { ...mr(), project: [] },
    { ...mr(), project: { id: "sensitive-input" } }, { ...mr(), project_id: 11 },
    mr({ iid: true }), mr({ description: { sensitive: true } }), mr({ draft: "true" }),
    mr({ last_commit: { id: "sensitive-input" } }), mr({ last_commit: [] }),
    mr({ updated_at: "sensitive-input" }), mr({ updated_at: "2026-02-30T00:00:00Z" }),
    mr({ updated_at: "2026-10-20T09:00:00" }), mr({ updated_at: "2026-10-20T24:00:00Z" }),
    mr({}, [{ id: "sensitive-input" }]), note({ sensitive: true }),
    { ...note(), merge_request: [] }, note("@reviewer", { author_id: false }),
  ];
  for (const payload of malformed) {
    assert.throws(() => instance.ingest({ eventType: payload?.object_kind === "note" ? "Note Hook" : "Merge Request Hook", payload }), (error) => error instanceof UserError && !error.message.includes("sensitive"));
  }
  assert.throws(() => send(instance, undefined, { sensitive: true }), UserError);
  assert.equal(instance.status().events, 0);
  assert.equal(instance.status().pending, 0);
});

test("configuration and limits validate numbers and identity before accessing storage", (t) => {
  for (const options of [{ projectIds: [true] }, { projectIds: "10" }, { userId: -1 }, { botUserId: "99" }, { username: "@reviewer" }, { username: {} }, { dataDir: "" }]) {
    assert.throws(() => new ReviewInbox(options), UserError);
  }
  const { instance } = inbox(t);
  assert.throws(() => instance.listPending({ limit: 0 }), UserError);
  assert.throws(() => instance.listPending({ limit: 101 }), UserError);
  assert.throws(() => instance.listPending({ limit: "20" }), UserError);
});

test("equivalent timestamp offsets compare in UTC and preserve sub-millisecond ordering", (t) => {
  const { instance } = inbox(t);
  send(instance, mr({ description: "@reviewer", updated_at: "2026-10-20T18:00:00.000001+09:00" }));
  send(instance, mr({ updated_at: T2, last_commit: { id: B } }));
  assert.equal(instance.listPending()[0].headSha, B);
});

test("stored data and returned results omit payload text, names, email, titles and raw event IDs", (t) => {
  const { instance, directory } = inbox(t);
  const payload = mr({ description: "@reviewer private-body-sentinel", title: "private-title-sentinel" });
  payload.user = { id: 20, name: "private-name-sentinel", email: "private-email-sentinel@example.test" };
  const result = send(instance, payload, "private-event-id-sentinel");
  const output = JSON.stringify([result, instance.listPending(), instance.status()]);
  const storage = readdirSync(directory).map((file) => readFileSync(join(directory, file)).toString("utf8")).join("");
  for (const sentinel of ["private-body-sentinel", "private-title-sentinel", "private-name-sentinel", "private-email-sentinel", "private-event-id-sentinel"]) {
    assert.equal(output.includes(sentinel), false);
    assert.equal(storage.includes(sentinel), false);
  }
});
