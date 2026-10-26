import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { MattermostService, UserError } from "./core.js";
import { ReviewInbox } from "./review-inbox.js";
import { TeamContextService } from "./team-context.js";
import { prepareMrContext } from "./gitlab-context.js";
import { workerSettings } from "./review-worker-config.js";
import { createConfiguredReviewWorker } from "./review-worker.js";
import { GitlabReviewClient } from "./review-gitlab.js";
import { syncReviewComments } from "./review-comment-sync.js";
import pkg from "../package.json" with { type: "json" };

const service = new MattermostService();
let automaticSettings;
try { automaticSettings = workerSettings(); }
catch { automaticSettings = { enabled: false, ready: false, missing: [], projectIds: [], error: "invalid_worker_settings" }; }
const reviewInbox = new ReviewInbox({ dataDir: service.dataDir, projectIds: automaticSettings.projectIds });
const teamContext = new TeamContextService({ dataDir: service.dataDir });
const stopWeeklyScheduler = teamContext.startWeeklyScheduler();
const automaticWorker = automaticSettings.ready ? createConfiguredReviewWorker({ inbox: reviewInbox, contextService: teamContext, mattermost: service, settings: automaticSettings }) : null;
automaticWorker?.start();
const server = new McpServer({ name: "mmp", version: pkg.version });

const name = z.string().trim().min(1).max(64).regex(/^[\p{L}\p{N}](?:[\p{L}\p{N} ._-]*[\p{L}\p{N}._-])?$/u);
const nullableText = (max) => z.string().trim().min(1).max(max).nullable().optional();
const variables = z.record(z.string().max(64), z.union([z.string(), z.number(), z.boolean()]));
const username = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9_-])?$/);
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const mutate = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const remove = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const refresh = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const jiraKeys = z.array(z.string().regex(/^[A-Z][A-Z0-9_]*-[1-9]\d*$/).max(128)).max(20);
const memoryText = z.string().trim().min(1).max(2000);
const memoryEvidence = z.array(z.strictObject({
  kind: z.enum(["code", "mr_description", "mr_comment", "jira", "test", "specification"]),
  ref: z.string().trim().min(1).max(2048),
})).max(10);
const memoryBasis = z.enum(["observed", "reported", "unknown"]);
const reviewMemory = z.strictObject({
  implementation: z.array(z.strictObject({ summary: memoryText, basis: memoryBasis, evidence: memoryEvidence })).min(1).max(30),
  decisions: z.array(z.strictObject({ decision: memoryText, reason: memoryText.nullable(), basis: memoryBasis, evidence: memoryEvidence })).max(30),
  validations: z.array(z.strictObject({ check: memoryText, result: z.enum(["passed", "failed", "not_run", "unknown"]), basis: memoryBasis, evidence: memoryEvidence })).max(30),
  remainingWork: z.array(z.strictObject({ summary: memoryText, basis: memoryBasis, evidence: memoryEvidence })).max(30),
});

function result(data, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], isError };
}

function messageFor(error) {
  if (error instanceof UserError) return error.message;
  if (String(error?.message).includes("UNIQUE constraint failed")) return "An item with that name already exists.";
  return "The requested operation could not be completed.";
}

function register(name, config, handler) {
  server.registerTool(name, config, async (args) => {
    try {
      return result(await handler(args));
    } catch (error) {
      return result({ error: messageFor(error) }, true);
    }
  });
}

register("storage_info", {
  description: "Show the resolved local data directory and saved item counts for diagnosing shared Codex/Claude storage.",
  inputSchema: z.object({}), annotations: readOnly,
}, () => ({
  dataDir: service.dataDir,
  counts: {
    webhooks: service.listWebhooks().length,
    channels: service.listChannels().length,
    participants: service.listParticipants().length,
    conventions: service.listConventions().length,
  },
}));

register("review_inbox_status", {
  description: "Show local GitLab review inbox counts. This does not poll GitLab, execute a review, or publish anything.",
  inputSchema: z.object({}), annotations: readOnly,
}, () => reviewInbox.status());

register("review_pending_list", {
  description: "Read pending GitLab review requests captured by the local receiver. Results contain identifiers, reviewed candidate SHA, and trigger reasons, not original comment bodies.",
  inputSchema: z.object({ limit: z.int().min(1).max(100).optional().default(20) }), annotations: readOnly,
}, (args) => reviewInbox.listPending(args));

register("review_worker_status", {
  description: "Show automatic-review configuration readiness and durable job stages/errors without private review bodies. The enabled worker processes authenticated webhook requests through code review, memory, MR comment and author Mattermost DM. It never approves or merges an MR. Notification delivery marked unknown needs an explicit retry choice.",
  inputSchema: z.object({ limit: z.int().min(1).max(100).optional().default(20) }), annotations: readOnly,
}, ({ limit }) => ({ enabled: automaticSettings.enabled, configured: automaticSettings.ready,
  provider: automaticSettings.provider ?? null, model: automaticSettings.model ?? null,
  missing: automaticSettings.missing, ...(automaticSettings.error ? { error: automaticSettings.error } : {}),
  active: Boolean(automaticWorker?.task), lastResult: automaticWorker?.lastResult ?? null, ...reviewInbox.workerStatus({ limit }) }));

register("review_job_retry", {
  description: "Explicitly requeue a failed or backoff-waiting automatic-review job now, resetting its attempt budget and preserving completed stages. Running and completed jobs cannot be requeued. An enabled worker will resume external posting/notification automatically. Set allow_notification_duplicate=true only when intentionally retrying an uncertain Mattermost delivery; it may already have arrived. This retries notification only and never republishes a completed MR comment.",
  inputSchema: z.object({ request_id: z.int().positive(), allow_notification_duplicate: z.boolean().optional().default(false) }),
  annotations: { ...mutate, openWorldHint: true },
}, ({ request_id, allow_notification_duplicate }) => reviewInbox.retryFailed(request_id, { allowNotificationDuplicate: allow_notification_duplicate }));

register("team_member_upsert", {
  description: "Register or replace a team review profile. There is no fixed team size or member-count cap. Use stable Jira accountId and GitLab numeric ID when available; paths are repository-relative directory or file prefixes. This stores local context only.",
  inputSchema: z.object({
    id: z.string().min(1).max(96), display_name: name, gitlab_username: username,
    gitlab_user_id: z.int().positive().nullable().optional(), jira_account_id: z.string().min(1).max(256),
    areas: z.array(z.string().min(1).max(512)).min(1).max(30),
    paths: z.array(z.string().min(1).max(512)).min(1).max(100),
    review_focus: z.array(z.string().min(1).max(512)).min(1).max(30),
  }), annotations: mutate,
}, ({ id, display_name, gitlab_username, gitlab_user_id, jira_account_id, areas, paths, review_focus }) => teamContext.upsertMember({
  id, displayName: display_name, gitlabUsername: gitlab_username, gitlabUserId: gitlab_user_id ?? null,
  jiraAccountId: jira_account_id, areas, paths, reviewFocus: review_focus,
}));

register("team_member_list", {
  description: "List registered team profiles and review responsibilities. Actual identities must be registered by the user; no sample profiles are created automatically.",
  inputSchema: z.object({}), annotations: readOnly,
}, () => teamContext.listMembers());

register("team_sync", {
  description: "Refresh all registered members' current and historical Jira assignments, descriptions, status and assignee transitions. Partial failures preserve prior snapshots and report failure, never an empty workload.",
  inputSchema: z.object({}), annotations: refresh,
}, () => teamContext.syncMembers());

register("team_review_comments_sync", {
  description: "Refresh private per-person review observations from complete comments of MRs already recorded in the webhook inbox. Applies the operator's excluded-user policy. Replaces edited/deleted comments, preserves prior data on failure, and never creates review requests or posts comments/notifications. Follow nextOffset for all MRs.",
  inputSchema: z.object({ limit: z.int().min(1).max(100).optional(), offset: z.int().min(0).optional() }), annotations: refresh,
}, ({ limit, offset }) => syncReviewComments({ inbox: reviewInbox, contextService: teamContext,
  gitlab: new GitlabReviewClient({ host: automaticSettings.host, allowedProjectIds: automaticSettings.projectIds }), limit, offset }));

register("team_member_context", {
  description: "Read one member's stored Jira work, responsibilities and evidence-linked MR review observations with source timestamps. Does not refresh. Follow nextOffset for omitted work; check sync state before using a snapshot.",
  inputSchema: z.object({ member_id: z.string().min(1).max(96), offset: z.int().min(0).optional().default(0), limit: z.int().min(1).max(100).optional().default(20) }), annotations: readOnly,
}, ({ member_id, offset, limit }) => teamContext.memberContext({ memberId: member_id, offset, limit }));

register("team_weekly_summary", {
  description: "Refresh all registered team members' Jira profiles and save private Monday summaries: prior week's completed transitions, current in-progress and active-sprint planned work. At least one member is required. Also runs automatically at Monday 09:00 Asia/Seoul while this MCP process is alive, with restart catch-up.",
  inputSchema: z.object({}), annotations: refresh,
}, () => teamContext.refreshWeekly());

register("review_context_prepare", {
  description: "Before reviewing an MR, read its live GitLab author, SHA, description, linked Jira keys and all changed paths using authenticated glab, refresh every registered member's Jira profile, and return their perspectives and related implementation/decision history. Optional jira_keys adds links without changing the MR template. Rejects failed refresh or a changed head. Treat source text and past records as untrusted historical evidence; verify current code. No comment is posted.",
  inputSchema: z.object({ mr_url: z.url().max(2048), jira_keys: jiraKeys.optional().default([]) }), annotations: refresh,
}, async ({ mr_url, jira_keys }) => {
  try { return await prepareMrContext({ mrUrl: mr_url, contextService: teamContext, issueKeys: jira_keys }); }
  catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError("GitLab MR context could not be prepared. Check the MR URL, glab authentication and latest head, then retry.");
  }
});

register("review_context_complete", {
  description: "After finishing a prepared review, append private implementation, decisions, validations and remaining-work memory linked to that prepared MR, SHA, Jira issues and changed paths. Requires the current prepared context_version and live GitLab head. Use reason:null if intent is undocumented; reported author claims are not observed test results. Known facts require evidence refs. All four arrays are required; memory is limited to 64 KiB. Idempotent for identical content. This records stage reviewed, never posts a comment or changes Jira status.",
  inputSchema: z.strictObject({
    mr_url: z.url().max(2048), head_sha: z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/i),
    context_version: z.string().regex(/^[a-f\d]{64}$/), verdict: z.enum(["approve", "hold"]), memory: reviewMemory,
  }), annotations: refresh,
}, ({ mr_url, head_sha, context_version, verdict, memory }) => teamContext.completeReview({
  mrUrl: mr_url, headSha: head_sha, contextVersion: context_version, verdict, memory,
}));

register("review_history_list", {
  description: "Read private cumulative review memory. Filters match the same MR OR any Jira key OR exact changed file path; when mr_url is provided, path matches are scoped to that GitLab host/project. Omit filters to list all local records. Newest first. Follow nextOffset to paginate. Past decisions/test results belong to their recorded SHA, not the current code. Does not refresh Jira or post anything.",
  inputSchema: z.object({
    mr_url: z.url().max(2048).optional(), jira_keys: jiraKeys.optional().default([]),
    changed_paths: z.array(z.string().min(1).max(2048)).max(1000).optional().default([]),
    offset: z.int().min(0).optional().default(0), limit: z.int().min(1).max(100).optional().default(20),
  }), annotations: readOnly,
}, ({ mr_url, jira_keys, changed_paths, offset, limit }) => teamContext.reviewHistory({
  mrUrl: mr_url, issueKeys: jira_keys, changedPaths: changed_paths, offset, limit,
}));

register("webhook_create", {
  description: "Register a Mattermost incoming webhook. The secret URL is stored locally and never returned by read tools.",
  inputSchema: z.object({ name, webhook_url: z.url().max(2048) }), annotations: mutate,
}, ({ name, webhook_url }) => service.createWebhook({ name, webhookUrl: webhook_url }));

register("webhook_list", {
  description: "List registered webhook names and redacted endpoints.",
  inputSchema: z.object({ name: name.optional() }), annotations: readOnly,
}, (args) => service.listWebhooks(args));

register("webhook_update", {
  description: "Rename a registered webhook or replace its secret URL.",
  inputSchema: z.object({ name, new_name: name.optional(), webhook_url: z.url().max(2048).optional() })
    .refine((value) => value.new_name !== undefined || value.webhook_url !== undefined, "Provide new_name or webhook_url."),
  annotations: mutate,
}, ({ name, new_name, webhook_url }) => service.updateWebhook({ name, newName: new_name, webhookUrl: webhook_url }));

register("webhook_delete", {
  description: "Delete an unused webhook. Move or delete linked logical channels first.",
  inputSchema: z.object({ name }), annotations: remove,
}, (args) => service.deleteWebhook(args));

register("channel_create", {
  description: "Create a logical destination backed by a registered webhook. mattermost_channel overrides the webhook's default channel.",
  inputSchema: z.object({
    name,
    webhook_name: name,
    mattermost_channel: nullableText(128),
    username: nullableText(64),
    icon_url: z.url().max(2048).nullable().optional(),
    enabled: z.boolean().optional().default(true),
  }), annotations: mutate,
}, ({ name, webhook_name, mattermost_channel, username, icon_url, enabled }) => service.createChannel({
  name, webhookName: webhook_name, mattermostChannel: mattermost_channel, username, iconUrl: icon_url, enabled,
}));

register("channel_list", {
  description: "List logical Mattermost destinations. Omit name to list all.",
  inputSchema: z.object({ name: name.optional() }), annotations: readOnly,
}, (args) => service.listChannels(args));

register("channel_update", {
  description: "Update a logical Mattermost destination. Use null to clear an optional override.",
  inputSchema: z.object({
    name,
    new_name: name.optional(),
    webhook_name: name.optional(),
    mattermost_channel: nullableText(128),
    username: nullableText(64),
    icon_url: z.url().max(2048).nullable().optional(),
    enabled: z.boolean().optional(),
  }).refine((value) => Object.keys(value).some((key) => key !== "name"), "Provide at least one field to update."),
  annotations: mutate,
}, ({ name, new_name, webhook_name, mattermost_channel, username, icon_url, enabled }) => service.updateChannel({
  name, newName: new_name, webhookName: webhook_name, mattermostChannel: mattermost_channel, username, iconUrl: icon_url, enabled,
}));

register("channel_delete", {
  description: "Delete a logical Mattermost destination. This does not delete the Mattermost channel or webhook.",
  inputSchema: z.object({ name }), annotations: remove,
}, (args) => service.deleteChannel(args));

register("participant_create", {
  description: "Register a person for exact GitLab-to-Mattermost mention mapping. Usernames must omit @. Mark only the local user as is_self.",
  inputSchema: z.object({
    display_name: name,
    mattermost_username: username,
    gitlab_username: username.nullable().optional(),
    is_self: z.boolean().optional().default(false),
  }), annotations: mutate,
}, ({ display_name, mattermost_username, gitlab_username, is_self }) => service.createParticipant({
  displayName: display_name, mattermostUsername: mattermost_username, gitlabUsername: gitlab_username, isSelf: is_self,
}));

register("participant_list", {
  description: "List global participants and exact mentions. name_query performs a literal partial display-name match and may return multiple candidates.",
  inputSchema: z.object({
    channel_name: name.optional(),
    display_name: name.optional(),
    name_query: name.optional(),
    gitlab_username: username.optional(),
    mattermost_username: username.optional(),
    self_only: z.boolean().optional().default(false),
  }), annotations: readOnly,
}, ({ channel_name, display_name, name_query, gitlab_username, mattermost_username, self_only }) => service.listParticipants({
  channelName: channel_name, displayName: display_name, nameQuery: name_query, gitlabUsername: gitlab_username,
  mattermostUsername: mattermost_username, selfOnly: self_only,
}));

register("participant_update", {
  description: "Update a participant identity mapping. Use null to clear the GitLab username.",
  inputSchema: z.object({
    mattermost_username: username,
    display_name: name.optional(),
    new_mattermost_username: username.optional(),
    gitlab_username: username.nullable().optional(),
    is_self: z.boolean().optional(),
  }).refine((value) => Object.keys(value).some((key) => key !== "mattermost_username"), "Provide at least one field to update."),
  annotations: mutate,
}, ({ mattermost_username, display_name, new_mattermost_username, gitlab_username, is_self }) => service.updateParticipant({
  mattermostUsername: mattermost_username, displayName: display_name, newMattermostUsername: new_mattermost_username,
  gitlabUsername: gitlab_username, isSelf: is_self,
}));

register("participant_delete", {
  description: "Delete a participant identity mapping and its logical channel memberships.",
  inputSchema: z.object({ mattermost_username: username }), annotations: remove,
}, ({ mattermost_username }) => service.deleteParticipant({ mattermostUsername: mattermost_username }));

register("channel_member_add", {
  description: "Assign a global participant to a logical channel. If absent globally, display_name is required and the participant is created first. This does not change Mattermost server membership.",
  inputSchema: z.object({
    channel_name: name,
    mattermost_username: username,
    display_name: name.optional(),
    gitlab_username: username.nullable().optional(),
  }), annotations: mutate,
}, ({ channel_name, mattermost_username, display_name, gitlab_username }) => service.addChannelMember({
  channelName: channel_name, mattermostUsername: mattermost_username, displayName: display_name, gitlabUsername: gitlab_username,
}));

register("channel_member_remove", {
  description: "Remove a participant from a logical channel's local directory. This does not change Mattermost server membership.",
  inputSchema: z.object({ channel_name: name, mattermost_username: username }), annotations: remove,
}, ({ channel_name, mattermost_username }) => service.removeChannelMember({ channelName: channel_name, mattermostUsername: mattermost_username }));

register("convention_create", {
  description: "Create a reusable message template. Variables use {{variable_name}} syntax.",
  inputSchema: z.object({ name, template: z.string().min(1).max(16_000), description: nullableText(500) }), annotations: mutate,
}, (args) => service.createConvention(args));

register("convention_list", {
  description: "List message conventions and their required variable names. Omit name to list all.",
  inputSchema: z.object({ name: name.optional() }), annotations: readOnly,
}, (args) => service.listConventions(args));

register("convention_update", {
  description: "Update or rename a message convention. Use null to clear its description.",
  inputSchema: z.object({
    name,
    new_name: name.optional(),
    template: z.string().min(1).max(16_000).optional(),
    description: nullableText(500),
  }).refine((value) => Object.keys(value).some((key) => key !== "name"), "Provide at least one field to update."),
  annotations: mutate,
}, ({ name, new_name, template, description }) => service.updateConvention({ name, newName: new_name, template, description }));

register("convention_delete", {
  description: "Delete a message convention.",
  inputSchema: z.object({ name }), annotations: remove,
}, (args) => service.deleteConvention(args));

register("message_preview", {
  description: "Render a convention without sending it. Reserved review conventions enforce the canonical one-line mention format.",
  inputSchema: z.object({ convention_name: name, variables: variables.optional().default({}) }), annotations: readOnly,
}, ({ convention_name, variables }) => service.previewMessage({ conventionName: convention_name, variables }));

register("message_send", {
  description: "Send one rendered convention or direct text to saved logical channels. Review requests/completions must use review-request/review-complete, never direct text.",
  inputSchema: z.object({
    channel_names: z.array(name).min(1).max(20),
    convention_name: name.optional(),
    variables: variables.optional().default({}),
    text: z.string().min(1).max(16_000).optional(),
  }).refine((value) => Boolean(value.convention_name) !== Boolean(value.text), "Provide exactly one of convention_name or text."),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async ({ channel_names, convention_name, variables, text }) => {
  const sent = await service.sendMessage({ channelNames: channel_names, conventionName: convention_name, variables, text });
  return sent;
});

register("message_send_dm", {
  description: "Send to one saved participant by id through a logical channel webhook. Review messages must use a review convention and the rendered body must still begin with the participant's @mention; the DM destination alone is not a mention.",
  inputSchema: z.object({
    participant_id: z.int().positive(),
    via_channel_name: name,
    convention_name: name.optional(),
    variables: variables.optional().default({}),
    text: z.string().min(1).max(16_000).optional(),
  }).refine((value) => Boolean(value.convention_name) !== Boolean(value.text), "Provide exactly one of convention_name or text."),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, ({ participant_id, via_channel_name, convention_name, variables, text }) => service.sendDirectMessage({
  participantId: participant_id,
  viaChannelName: via_channel_name,
  conventionName: convention_name,
  variables,
  text,
}));

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  stopWeeklyScheduler();
  await automaticWorker?.stop();
  teamContext.close(); reviewInbox.close(); service.close(); process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
void serveStdio(() => server);
