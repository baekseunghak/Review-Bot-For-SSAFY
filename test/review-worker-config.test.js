import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { MattermostService } from "../src/core.js";
import { workerSettings } from "../src/review-worker-config.js";
import { MattermostReviewNotifier } from "../src/review-notifier.js";
import { createConfiguredReviewWorker } from "../src/review-worker.js";
import { ClaudeReviewRunner } from "../src/review-runner.js";
import { CodexReviewRunner } from "../src/codex-review-runner.js";

const settings = { REVIEWBOT_AUTO_REVIEW: "1", REVIEWBOT_GITLAB_HOST: "gitlab.example.test",
  REVIEWBOT_GITLAB_PROJECT_IDS: "10,20,10", REVIEWBOT_MATTERMOST_CHANNEL: "team-reviews" };

test("automatic publishing requires explicit activation and complete local settings", () => {
  assert.equal(workerSettings({}).enabled, false);
  assert.equal(workerSettings({ ...settings, REVIEWBOT_AUTO_REVIEW: "0" }).ready, false);
  const missing = workerSettings({ REVIEWBOT_AUTO_REVIEW: "1" });
  assert.deepEqual(missing.missing, ["REVIEWBOT_GITLAB_HOST", "REVIEWBOT_GITLAB_PROJECT_IDS", "REVIEWBOT_MATTERMOST_CHANNEL"]);
  const enabled = workerSettings(settings);
  assert.equal(enabled.ready, true);
  assert.deepEqual(enabled.projectIds, [10, 20]);
  assert.equal(enabled.timeoutMs, 180_000);
  assert.equal(enabled.intervalMs, 5000);
  assert.equal(enabled.command, "claude");
  assert.equal(enabled.provider, "claude");
  assert.equal(enabled.model, null);
});

test("provider selection chooses the matching runner, command and optional model without changing legacy installs", () => {
  for (const [provider, Runner] of [["codex", CodexReviewRunner], ["claude", ClaudeReviewRunner]]) {
    const selected = workerSettings({ ...settings, REVIEWBOT_REVIEW_PROVIDER: provider,
      REVIEWBOT_REVIEW_COMMAND: "", REVIEWBOT_REVIEW_MODEL: "fixture-model" });
    assert.equal(selected.provider, provider);
    assert.equal(selected.command, provider);
    assert.equal(selected.model, "fixture-model");
    const worker = createConfiguredReviewWorker({ inbox: {}, contextService: {}, mattermost: {}, settings: selected });
    assert.ok(worker.runner instanceof Runner);
    assert.equal(worker.runner.command, provider);
    assert.equal(worker.runner.model, "fixture-model");
  }
  assert.equal(workerSettings({ ...settings, REVIEWBOT_REVIEW_PROVIDER: " Codex ", REVIEWBOT_REVIEW_COMMAND: "C:\\Program Files\\Codex\\codex.exe" }).command,
    "C:\\Program Files\\Codex\\codex.exe");
  assert.throws(() => workerSettings({ ...settings, REVIEWBOT_REVIEW_PROVIDER: "typo" }), /REVIEWBOT_REVIEW_PROVIDER/);
  for (const model of ["--flag", "two models", "model\nsecret", "x".repeat(129)]) {
    assert.throws(() => workerSettings({ ...settings, REVIEWBOT_REVIEW_MODEL: model }), /REVIEWBOT_REVIEW_MODEL/);
  }
  assert.throws(() => createConfiguredReviewWorker({ settings: { ready: true, provider: "typo" } }), /Unsupported review provider/);
});

test("invalid host, worker intervals and unrecognized activation values fail safely", () => {
  for (const host of ["https://gitlab.example.test", "user:password@gitlab.example.test", "gitlab.example.test/path", "gitlab.example.test?token=private", "-option.example.test"]) {
    assert.throws(() => workerSettings({ ...settings, REVIEWBOT_GITLAB_HOST: host }), /REVIEWBOT_GITLAB_HOST/);
  }
  for (const extra of [{ REVIEWBOT_AUTO_REVIEW: "true" }, { REVIEWBOT_WORKER_INTERVAL_MS: "0" },
    { REVIEWBOT_REVIEW_TIMEOUT_MS: "900001" }, { REVIEWBOT_REVIEW_COMMAND: "claude\ncommand" },
    { REVIEWBOT_MATTERMOST_CHANNEL: "@all" }, { REVIEWBOT_GITLAB_PROJECT_IDS: "-1" }, { REVIEWBOT_VALIDATION_CONFIG: "from-mr/config.json" }]) {
    assert.throws(() => workerSettings({ ...settings, ...extra }));
  }
  const native = "C:\\Program Files\\Claude\\claude.exe";
  assert.equal(workerSettings({ ...settings, REVIEWBOT_REVIEW_COMMAND: native }).command, native);
});

function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), "review-notifier-test-"));
  const calls = [];
  const service = new MattermostService({ dataDir, fetchImpl: async (url, options) => {
    assert.equal(new URL(url).hostname, "mattermost.example.test");
    calls.push(JSON.parse(options.body));
    return new Response("ok", { status: 200 });
  } });
  const notifier = new MattermostReviewNotifier({ service, channelName: "team-reviews" });
  service.createWebhook({ name: "fixture-webhook", webhookUrl: "https://mattermost.example.test/hooks/fixture-only" });
  service.createChannel({ name: "team-reviews", webhookName: "fixture-webhook" });
  const input = { author: { username: "author.gitlab", id: 9 }, mrIid: 7,
    mrUrl: "https://gitlab.example.test/group/repo/-/merge_requests/7", headSha: "a".repeat(40),
    verdict: "hold", issueKeys: ["TEST-1"], commentUrl: "https://gitlab.example.test/group/repo/-/merge_requests/7#note_42" };
  t.after(() => { service.close(); assert.equal(dirname(resolve(dataDir)), resolve(tmpdir())); rmSync(dataDir, { recursive: true, force: true }); });
  return { service, notifier, calls, input };
}

test("notification preflight requires an enabled channel, explicit author mapping and valid template", (t) => {
  const f = fixture(t);
  assert.throws(() => f.notifier.prepare(f.input), /mapping/);
  f.service.createParticipant({ displayName: "Fixture author", mattermostUsername: "author.mm", gitlabUsername: "author.gitlab" });
  assert.throws(() => f.notifier.prepare(f.input), /Convention/);
  f.service.createConvention({ name: "review-complete", template: "{{mention}} :review_complete_shake: !{{mr_number}} | [{{jira_key}}] {{message}}" });
  f.service.updateChannel({ name: "team-reviews", enabled: false });
  assert.throws(() => f.notifier.prepare(f.input), /enabled notification/);
  assert.equal(f.calls.length, 0);
});

test("notifications use the configured webhook for the mapped author's DM and contain only the public result link", async (t) => {
  const f = fixture(t);
  f.service.createParticipant({ displayName: "Fixture author", mattermostUsername: "author.mm", gitlabUsername: "author.gitlab" });
  f.service.createConvention({ name: "review-complete", template: "{{mention}} :review_complete_shake: !{{mr_number}} | [{{jira_key}}] {{message}}" });
  const payload = f.notifier.prepare(f.input);
  assert.equal(f.calls.length, 0);
  await f.notifier.send(payload);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].channel, "@author.mm");
  assert.match(f.calls[0].text, /^@author\.mm /);
  assert.ok(f.calls[0].text.includes("!7"));
  assert.ok(f.calls[0].text.includes("[TEST-1]"));
  assert.ok(f.calls[0].text.includes("판정: 보류"));
  assert.ok(f.calls[0].text.includes(f.input.commentUrl));
  assert.equal(f.calls[0].text.includes('"memory"'), false);
  const unlinked = f.notifier.prepare({ ...f.input, issueKeys: [] });
  assert.equal(unlinked.variables.jira_key, "미연결");
});
