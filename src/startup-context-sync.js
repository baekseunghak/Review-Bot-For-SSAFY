import { createHash } from "node:crypto";
import { UserError } from "./core.js";
import { extractIssueKeys } from "./gitlab-context.js";
import { reviewerCommentPolicy, excludedReviewer } from "./reviewer-comments.js";
import { redactValidationLog } from "./review-sandbox.js";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const failure = (code) => Object.assign(new UserError("Startup context synchronization could not complete."), { code });

export function projectMrSnapshot(source, policy) {
  if (source.notesComplete !== true || !Array.isArray(source.notes)) throw failure("incomplete_context");
  const description = redactValidationLog(source.description ?? "");
  const notes = source.notes.filter((note) => !note.system && !note.author?.bot && !note.body.includes("<!-- reviewbot:")
    && !excludedReviewer({ gitlabUserId: note.author?.id, gitlabUsername: note.author?.username ?? "" }, policy)).map((note) => {
    if (!Number.isSafeInteger(note.id) || note.id < 1 || !Number.isSafeInteger(note.author?.id) || note.author.id < 1
      || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}$/.test(note.author?.username ?? "")) throw failure("invalid_gitlab_response");
    const body = redactValidationLog(note.body);
    return { id: note.id, url: `${source.mrUrl}#note_${note.id}`, author: { id: note.author.id, username: note.author.username },
      body: body.slice(0, 12_000), bodyHash: hash(body), truncated: body.length > 12_000,
      createdAt: note.createdAt, updatedAt: note.updatedAt };
  }).sort((a, b) => a.id - b.id);
  if (new Set(notes.map((note) => note.id)).size !== notes.length) throw failure("invalid_gitlab_response");
  return { projectId: source.projectId, mrIid: source.mrIid, mrUrl: source.mrUrl, headSha: source.headSha,
    state: source.state, author: source.author, title: redactValidationLog(source.title ?? "").slice(0, 512),
    description: description.slice(0, 16_000), descriptionHash: hash(description), descriptionTruncated: description.length > 16_000,
    issueKeys: extractIssueKeys(source.title, source.description, source.sourceBranch).filter((key) => !/^[a-f0-9]{64}$/i.test(key)).slice(0, 20),
    sourceBranch: redactValidationLog(source.sourceBranch ?? "").slice(0, 512), targetBranch: redactValidationLog(source.targetBranch ?? "").slice(0, 512),
    createdAt: source.createdAt, updatedAt: source.updatedAt, observedAt: source.notesObservedAt, notes };
}

export class StartupContextSync {
  constructor({ contextService, gitlab, projectIds, now = () => new Date(), onReady = () => {}, leaseMs = 120_000 }) {
    this.context = contextService; this.gitlab = gitlab;
    this.projectIds = [...new Set(projectIds)].sort((a, b) => a - b);
    if (!this.projectIds.length || this.projectIds.some((id) => !gitlab.allowedProjectIds.has(id))) throw failure("project_not_allowed");
    this.now = now; this.onReady = onReady; this.leaseMs = leaseMs;
    this.scope = hash([gitlab.host, this.projectIds]);
    this.requestedAt = now().toISOString();
    this.task = null; this.timer = null; this.stopped = false; this.ready = false;
  }

  status() {
    const missing = [];
    if (!this.context.listMembers().length) missing.push("team_members");
    if (!this.context.jira.configured) missing.push("jira_connection");
    return { ready: this.ready, active: Boolean(this.task), missing,
      ...(this.context.store.startupSyncState(this.scope) ?? { status: missing.length ? "not_configured" : "pending", lastSuccessAt: null }) };
  }

  runOnce() {
    if (this.task) return this.task;
    this.task = this.#run().finally(() => { this.task = null; });
    return this.task;
  }

  async #run() {
    if (this.ready || this.stopped) return this.status();
    const store = this.context.store;
    const state = store.startupSyncState(this.scope);
    if (state?.completedAt >= this.requestedAt) {
      this.ready = true; this.onReady(); return this.status();
    }
    if (!this.context.listMembers().length || !this.context.jira.configured) return { ...this.status(), reason: "team_or_jira_not_configured" };
    const owner = store.claimStartupSync(this.scope, { now: this.now(), requestedAt: this.requestedAt, leaseMs: this.leaseMs });
    if (!owner) return this.status();
    const startedAt = this.now().toISOString();
    let lostLease = false;
    const guard = () => {
      if (this.stopped) throw failure("startup_sync_stopped");
      if (lostLease || !store.renewStartupSync(this.scope, owner, { now: this.now(), leaseMs: this.leaseMs })) {
        lostLease = true; throw failure("startup_sync_lease_lost");
      }
    };
    const lease = setInterval(() => { try { guard(); } catch { /* Checked before each write and checkpoint. */ } }, Math.max(10, Math.floor(this.leaseMs / 3)));
    lease.unref();
    const summary = { since: state?.lastSuccessAt ?? null, through: startedAt, projectCount: this.projectIds.length,
      deltaBasis: "writes_in_this_attempt; earlier partial writes may already be present",
      mrCount: 0, changedMrs: 0, commentsAdded: 0, commentsEdited: 0, commentsRemoved: 0, jiraChangedIssues: 0 };
    try {
      const members = this.context.listMembers();
      const policy = reviewerCommentPolicy(this.context.dataDir);
      for (const projectId of this.projectIds) {
        guard();
        const targets = await this.gitlab.listProjectMrs(projectId);
        for (const target of targets) {
          guard();
          const source = await this.gitlab.readComments(target);
          guard();
          this.context.requireUnchangedTeam(members);
          if (hash(reviewerCommentPolicy(this.context.dataDir)) !== hash(policy)) throw failure("startup_sync_policy_changed");
          const delta = store.saveProjectMrContext(projectMrSnapshot(source, policy));
          this.context.captureReviewComments(source);
          summary.mrCount += 1;
          summary.changedMrs += Number(delta.changed);
          summary.commentsAdded += delta.added ?? 0;
          summary.commentsEdited += delta.edited ?? 0;
          summary.commentsRemoved += delta.removed ?? 0;
        }
      }
      guard();
      const priorIssues = new Map(members.flatMap((person) => store.getIssuesForMember(person.id).map((issue) => [issue.key, hash(issue)])));
      const synced = await this.context.syncMembers();
      guard();
      if (synced.status !== "fresh") throw failure("startup_sync_jira_failed");
      this.context.requireUnchangedTeam(members);
      if (hash(reviewerCommentPolicy(this.context.dataDir)) !== hash(policy)) throw failure("startup_sync_policy_changed");
      const currentIssues = new Map(members.flatMap((person) => store.getIssuesForMember(person.id).map((issue) => [issue.key, hash(issue)])));
      summary.jiraChangedIssues = [...currentIssues].filter(([key, value]) => priorIssues.get(key) !== value).length;
      if (!store.finishStartupSync(this.scope, owner, { now: this.now(), startedAt, success: true, summary })) throw failure("startup_sync_lease_lost");
      if (!this.stopped) { this.ready = true; this.onReady(); }
      return this.status();
    } catch (error) {
      const code = /^[a-z][a-z0-9_]{0,63}$/.test(error.code ?? "") ? error.code : "startup_sync_failed";
      if (!lostLease) store.finishStartupSync(this.scope, owner, { now: this.now(), startedAt, success: false, errorCode: code });
      return { ...this.status(), reason: code };
    } finally { clearInterval(lease); }
  }

  start({ unref = true } = {}) {
    if (this.timer) return;
    const tick = () => { void this.runOnce().catch(() => {}); };
    this.timer = setInterval(tick, 10_000);
    if (unref) this.timer.unref();
    tick();
  }

  async stop() { this.stopped = true; clearInterval(this.timer); this.timer = null; await this.task; }
}
