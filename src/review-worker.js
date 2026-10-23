import { createHash } from "node:crypto";
import { UserError } from "./core.js";
import { normalizeReviewResult, ClaudeReviewRunner } from "./review-runner.js";
import { CodexReviewRunner } from "./codex-review-runner.js";
import { GitlabReviewClient } from "./review-gitlab.js";
import { MattermostReviewNotifier } from "./review-notifier.js";
import { ReviewVerificationService, attachVerification, verificationReference } from "./review-verification.js";

function problem(code) { return Object.assign(new UserError("Automatic review could not complete. Check the worker job status."), { code }); }
const OBSOLETE = new Set(["request_obsolete", "stale_head", "review_not_open"]);
const TERMINAL = new Set(["comment_conflict", "duplicate_comment", "unsupported_content", "no_reviewable_text", "context_too_large", "incomplete_context", "notification_setup_missing", "review_author_unmapped", "verification_receipt_invalid"]);

export class ReviewWorker {
  constructor({ inbox, gitlab, contextService, runner, notifier, now = () => new Date(),
    verificationService, leaseMs = 120_000, retryDelayMs = 60_000, maxAttempts = 5, intervalMs = 5000 }) {
    Object.assign(this, { inbox, gitlab, contextService, runner, notifier, verificationService, now, leaseMs, retryDelayMs, maxAttempts, intervalMs });
    this.task = null;
    this.timer = null;
    this.controller = null;
    this.lastResult = null;
  }

  runOnce() {
    if (this.task) return Promise.resolve({ status: "busy" });
    this.task = this.#run().then((result) => { this.lastResult = result; return result; }).finally(() => { this.task = null; });
    return this.task;
  }

  async #run() {
    const job = this.inbox.claimNext({ now: this.now(), leaseMs: this.leaseMs });
    if (!job) return { status: "idle" };
    const { id, leaseToken } = job;
    let stage = job.stage;
    let artifact = job.artifact;
    let verification;
    let lostLease = false;
    const controller = new AbortController();
    this.controller = controller;
    const owned = ({ allowStopped = false } = {}) => {
      if (lostLease) throw problem("lease_lost");
      if (!allowStopped && controller.signal.aborted) throw problem("worker_stopped");
      try { this.inbox.renewClaim(id, leaseToken, { now: this.now(), leaseMs: this.leaseMs }); }
      catch { lostLease = true; controller.abort(); throw problem("lease_lost"); }
    };
    const current = () => {
      owned();
      if (!this.inbox.isCurrent(id, leaseToken, { now: this.now() })) throw problem("request_obsolete");
    };
    const checkpoint = (next, update = {}, allowStopped = false) => {
      owned({ allowStopped });
      this.inbox.checkpoint(id, leaseToken, { stage: next, artifact: update, now: this.now() });
      stage = next;
      artifact = { ...artifact, ...update };
    };
    const heartbeat = setInterval(() => { try { owned(); } catch { /* The next boundary stops this owner. */ } }, Math.max(10, Math.floor(this.leaseMs / 3)));
    heartbeat.unref();
    try {
      if (["notifying", "notification_unknown"].includes(stage)) throw problem("notification_unknown");
      if (stage !== "posted" && artifact.verification) {
        verification = artifact.verification.receiptSha256
          ? await this.verificationService.restore(artifact.verification) : artifact.verification;
        if (verification.headSha !== job.headSha || (verification.projectId !== undefined && verification.projectId !== job.projectId)
          || (verification.mrIid !== undefined && verification.mrIid !== job.mrIid)) throw problem("invalid_checkpoint");
      }
      if (!["posting", "posted"].includes(stage)) {
        current();
        let bundle;
        if (stage === "reviewed" && artifact.contextRef) {
          const key = createHash("sha256").update(artifact.contextRef.mrUrl).digest("hex").slice(0, 24);
          bundle = this.contextService.store.getReviewBundle(key, job.headSha);
          if (bundle?.contextVersion !== artifact.contextRef.contextVersion) bundle = null;
        }
        if (!bundle) {
          checkpoint("reviewing", { review: null, completion: null, comment: null });
          const changes = await this.gitlab.readReview(job);
          current();
          // Validate notification setup before spending a review run or publishing anything.
          this.notifier.prepare({ ...changes, issueKeys: changes.issueKeys, verdict: "approve", commentUrl: changes.mrUrl });
          bundle = await this.contextService.prepareReview({ mrUrl: changes.mrUrl, headSha: changes.headSha,
            author: changes.author, changedPaths: changes.changedPaths, inferredIssueKeys: changes.issueKeys,
            mrSource: { title: changes.title.slice(0, 512), description: changes.description.slice(0, 16_000), descriptionTruncated: changes.description.length > 16_000 } });
          current();
          this.#assertHead(await this.gitlab.readHead(job), job.headSha);
          if (this.verificationService && verification?.headSha !== job.headSha) {
            checkpoint("validating");
            verification = await this.verificationService.collect(job, { signal: controller.signal });
            current();
            this.#assertHead(await this.gitlab.readHead(job), job.headSha);
            checkpoint("reviewing", { verification: verificationReference(verification) });
          }
          const options = { context: bundle, changes, verification };
          let result = normalizeReviewResult(await this.runner.review({ context: bundle, changes,
            ...(verification ? { verification } : {}) }, { signal: controller.signal }), options);
          if (verification) result = normalizeReviewResult(attachVerification(result, verification), options);
          current();
          checkpoint("reviewed", { review: result,
            contextRef: { mrUrl: bundle.mrUrl, headSha: bundle.headSha, contextVersion: bundle.contextVersion },
            snapshot: { mrUrl: changes.mrUrl, author: changes.author, issueKeys: bundle.relatedIssues.map((issue) => issue.key) } });
        }
        current();
        this.#assertHead(await this.gitlab.readHead(job), job.headSha);
        const review = normalizeReviewResult(artifact.review, { context: bundle, verification });
        const saved = await this.contextService.completeReview({ ...artifact.contextRef, verdict: review.verdict, memory: review.memory });
        current();
        checkpoint("posting", { completion: { id: saved.id, headSha: saved.headSha, contextVersion: saved.contextVersion } });
      }
      if (stage === "posting") {
        owned();
        const review = normalizeReviewResult(artifact.review, { verification });
        if (!artifact.completion?.id || artifact.completion.headSha !== job.headSha
          || artifact.completion.contextVersion !== artifact.contextRef?.contextVersion) throw problem("invalid_checkpoint");
        // Existing marked comments can be reconciled even after the MR moves to a new head.
        const comment = await this.gitlab.ensureComment({ ...job, body: review.body, beforeCreate: current });
        checkpoint("posted", { comment });
      }
      if (stage !== "posted" || !artifact.comment?.url || !artifact.snapshot) throw problem("invalid_checkpoint");
      owned();
      const notification = this.notifier.prepare({ ...artifact.snapshot, mrIid: job.mrIid, headSha: job.headSha,
        verdict: artifact.review.verdict, commentUrl: artifact.comment.url });
      checkpoint("notifying");
      await this.notifier.send(notification);
      owned();
      this.inbox.finish(id, leaseToken, { now: this.now() });
      return { status: "completed", requestId: id, commentUrl: artifact.comment.url };
    } catch (error) {
      if (lostLease || error?.code === "lease_lost") return { status: "lease_lost", requestId: id };
      const code = stage === "notifying" || error?.code === "notification_unknown" ? "notification_unknown"
        : /^[a-z][a-z0-9_]{0,63}$/.test(error?.code ?? "") ? error.code : "review_step_failed";
      try {
        owned({ allowStopped: true });
        if (OBSOLETE.has(code)) {
          checkpoint("skipped", { outcome: code }, true);
          this.inbox.finish(id, leaseToken, { now: this.now() });
          return { status: "skipped", requestId: id, reason: code };
        }
        if (code === "notification_unknown") checkpoint("notification_unknown", {}, true);
        this.inbox.retry(id, leaseToken, { errorCode: code, delayMs: this.retryDelayMs * 2 ** Math.min(job.attempt - 1, 4),
          maxAttempts: code === "notification_unknown" || TERMINAL.has(code) ? 1 : this.maxAttempts, now: this.now() });
        return { status: "failed", requestId: id, code };
      } catch { return { status: "lease_lost", requestId: id }; }
    } finally {
      clearInterval(heartbeat);
      if (this.controller === controller) this.controller = null;
    }
  }

  #assertHead(snapshot, expected) {
    if (snapshot.headSha !== expected) throw problem("stale_head");
    if (snapshot.state !== "opened" || snapshot.draft) throw problem("review_not_open");
  }

  start({ unref = true } = {}) {
    if (this.timer) return;
    const tick = () => { void this.runOnce().catch(() => { this.lastResult = { status: "failed", code: "worker_failed" }; }); };
    this.timer = setInterval(tick, this.intervalMs);
    if (unref) this.timer.unref();
    tick();
  }

  async stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.controller?.abort();
    await this.task;
  }
}

export function createConfiguredReviewWorker({ inbox, contextService, mattermost, settings }) {
  if (!settings.ready) throw new UserError("Enable automatic review and configure its GitLab host, project IDs and notification channel first.");
  const provider = settings.provider ?? "claude";
  if (!["claude", "codex"].includes(provider)) throw new UserError("Unsupported review provider.");
  const Runner = provider === "codex" ? CodexReviewRunner : ClaudeReviewRunner;
  const gitlab = new GitlabReviewClient({ host: settings.host, allowedProjectIds: settings.projectIds });
  return new ReviewWorker({ inbox, contextService,
    gitlab, verificationService: new ReviewVerificationService({ gitlab, dataDir: settings.dataDir,
      ...(settings.validationConfigPath ? { configPath: settings.validationConfigPath } : {}) }),
    runner: new Runner({ command: settings.command, model: settings.model, timeoutMs: settings.timeoutMs }),
    notifier: new MattermostReviewNotifier({ service: mattermost, channelName: settings.channelName }),
    intervalMs: settings.intervalMs });
}
