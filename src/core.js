import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const NAME_PATTERN = /^[\p{L}\p{N}](?:[\p{L}\p{N} ._-]*[\p{L}\p{N}._-])?$/u;
const USERNAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9_-])?$/;
const PLACEHOLDER_PATTERN = /\{\{([A-Za-z_][A-Za-z0-9_.-]*)\}\}/g;
const MAX_MESSAGE_LENGTH = 16_000;
const REVIEW_CONVENTIONS = new Map([
  ["review-request", ":merge_please:"],
  ["review-request-multi", ":merge_please:"],
  ["review-complete", ":review_complete_shake:"],
]);
const REVIEW_TEXT_PATTERN = /(?:리뷰(?:를)?\s*(?:요청|완료|부탁)|검토\s*부탁|\breview\s+(?:request|requested|complete|completed|please)\b)/iu;

export class UserError extends Error {}

function now() {
  return new Date().toISOString();
}

function requireName(value, label = "name") {
  if (value.length > 64 || !NAME_PATTERN.test(value)) {
    throw new UserError(`${label} must start with a Unicode letter or number and contain only letters, numbers, internal spaces, dot, underscore, or hyphen (max 64).`);
  }
}

function requireUsername(value, label) {
  if (!USERNAME_PATTERN.test(value)) {
    throw new UserError(`${label} must omit @ and contain only letters, numbers, dot, underscore, or hyphen (max 64).`);
  }
}

export function resolveDataDir(explicitPath) {
  if (explicitPath) return explicitPath;
  if (process.env.MATTERMOST_MCP_DATA_DIR) return process.env.MATTERMOST_MCP_DATA_DIR;
  const forwardedUserProfile = process.env.MATTERMOST_MCP_USERPROFILE;
  const base = forwardedUserProfile && forwardedUserProfile !== "__MMP_UNSET__"
    ? forwardedUserProfile
    : homedir();
  return join(base, ".mmp");
}

function resolveLegacyDataDir() {
  const forwardedLocalAppData = process.env.MATTERMOST_MCP_LOCALAPPDATA;
  const base = process.env.LOCALAPPDATA
    || (forwardedLocalAppData === "__MMP_UNSET__" ? undefined : forwardedLocalAppData);
  return base ? join(base, "mattermost-manager-mcp") : null;
}

function prepareDataDir(path) {
  mkdirSync(path, { recursive: true });
  try {
    chmodSync(path, 0o700);
  } catch {
    // Windows uses the current user's inherited ACLs.
  }
}

function validateWebhookUrl(value, allowHttp) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new UserError("webhook_url must be a valid URL.");
  }
  if (url.username || url.password || url.hash) {
    throw new UserError("webhook_url cannot contain credentials or a fragment.");
  }
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw new UserError("webhook_url must use HTTPS. Set MATTERMOST_MCP_ALLOW_HTTP=1 only for a trusted local Mattermost server.");
  }
  return url.toString();
}

function redactWebhookUrl(value) {
  const url = new URL(value);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length) parts[parts.length - 1] = "[redacted]";
  url.pathname = `/${parts.join("/")}`;
  url.search = "";
  return url.toString();
}

function variablesIn(template) {
  return [...new Set([...template.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1]))];
}

// 리뷰 메시지는 레이아웃이 아니라 내용을 강제한다.
// 팀이 템플릿을 바꿔도(줄바꿈 추가, MR URL 포함) 수신자·상태 이모지·MR 번호·지라 키는 틀릴 수 없어야 한다.
// 고정 문자열과 완전 일치를 요구하면 템플릿을 조금만 손봐도 전송이 통째로 막힌다.
// 리뷰 컨벤션은 한 명(mention) 또는 여러 명(mentions)을 받는다. 둘 다 같은 규칙으로 검사한다.
function reviewMentions(variables) {
  const raw = variables.mention ?? variables.mentions;
  if (raw === undefined) throw new UserError("Review message requires a mention or mentions variable.");
  const text = String(raw).trim();
  if (!text || /[\r\n]/u.test(text)) throw new UserError("Review mentions must be one non-empty line.");
  for (const one of text.split(/\s+/)) {
    if (!one.startsWith("@")) throw new UserError("Review mention must start with @.");
    requireUsername(one.slice(1), "review mention");
  }
  return text;
}

function assertReviewMessage(conventionName, variables, rendered) {
  const emoji = REVIEW_CONVENTIONS.get(conventionName);
  if (!emoji) return;
  const mentions = reviewMentions(variables);
  const mrNumber = String(variables.mr_number ?? "");
  const jiraKey = String(variables.jira_key ?? "");
  const message = String(variables.message ?? "");
  if (!/^\d+$/.test(mrNumber)) throw new UserError("Review mr_number must contain digits only, without !.");
  if (!jiraKey || /[\[\]\r\n]/u.test(jiraKey)) throw new UserError("Review jira_key must be one line without brackets.");
  if (!message.trim() || /[\r\n]/u.test(message)) throw new UserError("Review message must be one non-empty line.");

  // 멘션 바로 뒤는 공백이나 줄바꿈이어야 한다. @kim 이 @kim2 에 우연히 맞는 것을 막는다.
  const after = rendered.slice(mentions.length);
  if (!rendered.startsWith(mentions) || (after && !/^\s/.test(after))) {
    throw new UserError("Review message must begin with the recipient's exact @mention(s).");
  }
  if (!rendered.includes(emoji)) throw new UserError(`Review message must include the ${emoji} status emoji.`);
  if (!rendered.includes(`!${mrNumber}`)) throw new UserError("Review message must include the MR number as !<number>.");
  if (!rendered.includes(`[${jiraKey}]`)) throw new UserError("Review message must include the Jira key in brackets.");
  if (!rendered.includes(message)) throw new UserError("Review message must include the supplied message text.");
}

export function renderTemplate(template, variables = {}) {
  const missing = variablesIn(template).filter((name) => !(name in variables));
  if (missing.length) {
    throw new UserError(`Missing template variables: ${missing.join(", ")}`);
  }
  const text = template.replace(PLACEHOLDER_PATTERN, (_, name) => String(variables[name]));
  if (text.length > MAX_MESSAGE_LENGTH) {
    throw new UserError(`Rendered message exceeds ${MAX_MESSAGE_LENGTH} characters.`);
  }
  return text;
}

function affected(result, message) {
  if (Number(result.changes) === 0) throw new UserError(message);
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, "\\$&");
}

export class MattermostService {
  constructor({ dataDir, allowHttp, fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
    const shouldMigrateLegacy = dataDir === undefined && !process.env.MATTERMOST_MCP_DATA_DIR;
    this.dataDir = resolveDataDir(dataDir);
    this.allowHttp = allowHttp ?? process.env.MATTERMOST_MCP_ALLOW_HTTP === "1";
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    prepareDataDir(this.dataDir);
    this.db = new DatabaseSync(join(this.dataDir, "mattermost.sqlite3"));
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS webhooks (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        url TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS channels (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE RESTRICT,
        mattermost_channel TEXT,
        username TEXT,
        icon_url TEXT,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conventions (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        template TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS participants (
        id INTEGER PRIMARY KEY,
        display_name TEXT NOT NULL,
        mattermost_username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        gitlab_username TEXT UNIQUE COLLATE NOCASE,
        is_self INTEGER NOT NULL DEFAULT 0 CHECK (is_self IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS participants_one_self
        ON participants(is_self) WHERE is_self = 1;
      CREATE TABLE IF NOT EXISTS channel_members (
        channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
        PRIMARY KEY (channel_id, participant_id)
      );
    `);
    if (shouldMigrateLegacy) {
      const legacyDataDir = resolveLegacyDataDir();
      if (legacyDataDir && legacyDataDir !== this.dataDir) {
        this.migrateLegacyData(join(legacyDataDir, "mattermost.sqlite3"));
      }
    }
    try {
      chmodSync(join(this.dataDir, "mattermost.sqlite3"), 0o600);
    } catch {
      // Windows uses the current user's inherited ACLs.
    }
  }

  close() {
    this.db.close();
  }

  migrateLegacyData(databasePath) {
    const currentPath = join(this.dataDir, "mattermost.sqlite3");
    if (!databasePath || databasePath === currentPath || !existsSync(databasePath)) return false;
    this.db.prepare("ATTACH DATABASE ? AS legacy").run(databasePath);
    try {
      const tables = ["webhooks", "channels", "conventions", "participants", "channel_members"];
      const hasSchema = tables.every((table) => this.db.prepare(
        "SELECT 1 FROM legacy.sqlite_master WHERE type = 'table' AND name = ?",
      ).get(table));
      if (!hasSchema) return false;
      const count = (database, table) => Number(this.db.prepare(`SELECT COUNT(*) AS count FROM ${database}.${table}`).get().count);
      if (tables.some((table) => count("main", table) > 0)) return false;
      if (tables.every((table) => count("legacy", table) === 0)) return false;
      this.db.exec(`
        BEGIN IMMEDIATE;
        INSERT INTO main.webhooks SELECT * FROM legacy.webhooks;
        INSERT INTO main.channels SELECT * FROM legacy.channels;
        INSERT INTO main.conventions SELECT * FROM legacy.conventions;
        INSERT INTO main.participants SELECT * FROM legacy.participants;
        INSERT INTO main.channel_members SELECT * FROM legacy.channel_members;
        COMMIT;
      `);
      return true;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    } finally {
      this.db.exec("DETACH DATABASE legacy");
    }
  }

  createWebhook({ name, webhookUrl }) {
    requireName(name, "name");
    if (this.#webhook(name)) throw new UserError(`Webhook '${name}' already exists.`);
    const timestamp = now();
    this.db.prepare("INSERT INTO webhooks(name, url, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(name, validateWebhookUrl(webhookUrl, this.allowHttp), timestamp, timestamp);
    return this.listWebhooks({ name })[0];
  }

  listWebhooks({ name } = {}) {
    const rows = name
      ? this.db.prepare("SELECT name, url, created_at, updated_at FROM webhooks WHERE name = ?").all(name)
      : this.db.prepare("SELECT name, url, created_at, updated_at FROM webhooks ORDER BY name").all();
    return rows.map((row) => ({
      name: row.name,
      endpoint: redactWebhookUrl(row.url),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  updateWebhook({ name, newName, webhookUrl }) {
    requireName(name, "name");
    if (!this.#webhook(name)) throw new UserError(`Webhook '${name}' does not exist.`);
    if (newName !== undefined) requireName(newName, "new_name");
    if (newName && newName !== name && this.#webhook(newName)) throw new UserError(`Webhook '${newName}' already exists.`);
    const fields = [];
    const values = [];
    if (newName !== undefined) { fields.push("name = ?"); values.push(newName); }
    if (webhookUrl !== undefined) { fields.push("url = ?"); values.push(validateWebhookUrl(webhookUrl, this.allowHttp)); }
    if (!fields.length) throw new UserError("Provide new_name or webhook_url.");
    fields.push("updated_at = ?");
    values.push(now(), name);
    this.db.prepare(`UPDATE webhooks SET ${fields.join(", ")} WHERE name = ?`).run(...values);
    return this.listWebhooks({ name: newName ?? name })[0];
  }

  deleteWebhook({ name }) {
    requireName(name, "name");
    const inUse = this.db.prepare(`
      SELECT channels.name FROM channels
      JOIN webhooks ON webhooks.id = channels.webhook_id
      WHERE webhooks.name = ? ORDER BY channels.name
    `).all(name);
    if (inUse.length) {
      throw new UserError(`Webhook '${name}' is used by channels: ${inUse.map((row) => row.name).join(", ")}. Delete or move them first.`);
    }
    affected(this.db.prepare("DELETE FROM webhooks WHERE name = ?").run(name), `Webhook '${name}' does not exist.`);
    return { deleted: name };
  }

  createChannel({ name, webhookName, mattermostChannel = null, username = null, iconUrl = null, enabled = true }) {
    requireName(name, "name");
    const webhook = this.#webhook(webhookName);
    if (!webhook) throw new UserError(`Webhook '${webhookName}' does not exist.`);
    if (this.#channel(name)) throw new UserError(`Channel '${name}' already exists.`);
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO channels(name, webhook_id, mattermost_channel, username, icon_url, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, webhook.id, mattermostChannel, username, iconUrl, enabled ? 1 : 0, timestamp, timestamp);
    return this.listChannels({ name })[0];
  }

  listChannels({ name } = {}) {
    const sql = `
      SELECT channels.name, webhooks.name AS webhook_name, channels.mattermost_channel,
             channels.username, channels.icon_url, channels.enabled,
             channels.created_at, channels.updated_at
      FROM channels JOIN webhooks ON webhooks.id = channels.webhook_id
      ${name ? "WHERE channels.name = ?" : ""}
      ORDER BY channels.name
    `;
    const rows = name ? this.db.prepare(sql).all(name) : this.db.prepare(sql).all();
    return rows.map((row) => ({
      name: row.name,
      webhookName: row.webhook_name,
      mattermostChannel: row.mattermost_channel,
      username: row.username,
      iconUrl: row.icon_url,
      enabled: Boolean(row.enabled),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  updateChannel({ name, newName, webhookName, mattermostChannel, username, iconUrl, enabled }) {
    requireName(name, "name");
    if (!this.#channel(name)) throw new UserError(`Channel '${name}' does not exist.`);
    if (newName !== undefined) requireName(newName, "new_name");
    if (newName && newName !== name && this.#channel(newName)) throw new UserError(`Channel '${newName}' already exists.`);
    const fields = [];
    const values = [];
    if (newName !== undefined) { fields.push("name = ?"); values.push(newName); }
    if (webhookName !== undefined) {
      const webhook = this.#webhook(webhookName);
      if (!webhook) throw new UserError(`Webhook '${webhookName}' does not exist.`);
      fields.push("webhook_id = ?"); values.push(webhook.id);
    }
    if (mattermostChannel !== undefined) { fields.push("mattermost_channel = ?"); values.push(mattermostChannel); }
    if (username !== undefined) { fields.push("username = ?"); values.push(username); }
    if (iconUrl !== undefined) { fields.push("icon_url = ?"); values.push(iconUrl); }
    if (enabled !== undefined) { fields.push("enabled = ?"); values.push(enabled ? 1 : 0); }
    if (!fields.length) throw new UserError("Provide at least one channel field to update.");
    fields.push("updated_at = ?");
    values.push(now(), name);
    this.db.prepare(`UPDATE channels SET ${fields.join(", ")} WHERE name = ?`).run(...values);
    return this.listChannels({ name: newName ?? name })[0];
  }

  deleteChannel({ name }) {
    requireName(name, "name");
    affected(this.db.prepare("DELETE FROM channels WHERE name = ?").run(name), `Channel '${name}' does not exist.`);
    return { deleted: name };
  }

  createParticipant({ displayName, mattermostUsername, gitlabUsername = null, isSelf = false }) {
    requireName(displayName, "display_name");
    requireUsername(mattermostUsername, "mattermost_username");
    if (gitlabUsername !== null) requireUsername(gitlabUsername, "gitlab_username");
    if (this.#participant(mattermostUsername)) throw new UserError(`Participant '@${mattermostUsername}' already exists.`);
    const timestamp = now();
    try {
      this.db.prepare(`
        INSERT INTO participants(display_name, mattermost_username, gitlab_username, is_self, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(displayName, mattermostUsername, gitlabUsername, isSelf ? 1 : 0, timestamp, timestamp);
    } catch (error) {
      this.#participantConstraint(error);
    }
    return this.listParticipants({ mattermostUsername })[0];
  }

  listParticipants({ channelName, displayName, nameQuery, gitlabUsername, mattermostUsername, selfOnly = false } = {}) {
    if (channelName !== undefined && !this.#channel(channelName)) throw new UserError(`Channel '${channelName}' does not exist.`);
    const conditions = [];
    const values = [];
    if (channelName !== undefined) { conditions.push("channels.name = ?"); values.push(channelName); }
    if (displayName !== undefined) { requireName(displayName, "display_name"); conditions.push("participants.display_name = ? COLLATE NOCASE"); values.push(displayName); }
    if (nameQuery !== undefined) {
      requireName(nameQuery, "name_query");
      conditions.push("participants.display_name LIKE ? ESCAPE '\\' COLLATE NOCASE");
      values.push(`%${escapeLike(nameQuery)}%`);
    }
    if (gitlabUsername !== undefined) { requireUsername(gitlabUsername, "gitlab_username"); conditions.push("participants.gitlab_username = ? COLLATE NOCASE"); values.push(gitlabUsername); }
    if (mattermostUsername !== undefined) { requireUsername(mattermostUsername, "mattermost_username"); conditions.push("participants.mattermost_username = ? COLLATE NOCASE"); values.push(mattermostUsername); }
    if (selfOnly) conditions.push("participants.is_self = 1");
    const rows = this.db.prepare(`
      SELECT DISTINCT participants.id, participants.display_name, participants.mattermost_username,
             participants.gitlab_username, participants.is_self,
             participants.created_at, participants.updated_at
      FROM participants
      LEFT JOIN channel_members ON channel_members.participant_id = participants.id
      LEFT JOIN channels ON channels.id = channel_members.channel_id
      ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY participants.display_name, participants.mattermost_username
    `).all(...values);
    const memberships = this.db.prepare(`
      SELECT channels.name FROM channel_members
      JOIN channels ON channels.id = channel_members.channel_id
      WHERE channel_members.participant_id = ? ORDER BY channels.name
    `);
    return rows.map((row) => ({
      id: Number(row.id),
      displayName: row.display_name,
      mattermostUsername: row.mattermost_username,
      mention: `@${row.mattermost_username}`,
      gitlabUsername: row.gitlab_username,
      isSelf: Boolean(row.is_self),
      channels: memberships.all(row.id).map((membership) => membership.name),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  updateParticipant({ mattermostUsername, displayName, newMattermostUsername, gitlabUsername, isSelf }) {
    requireUsername(mattermostUsername, "mattermost_username");
    if (!this.#participant(mattermostUsername)) throw new UserError(`Participant '@${mattermostUsername}' does not exist.`);
    const fields = [];
    const values = [];
    if (displayName !== undefined) { requireName(displayName, "display_name"); fields.push("display_name = ?"); values.push(displayName); }
    if (newMattermostUsername !== undefined) { requireUsername(newMattermostUsername, "new_mattermost_username"); fields.push("mattermost_username = ?"); values.push(newMattermostUsername); }
    if (gitlabUsername !== undefined) {
      if (gitlabUsername !== null) requireUsername(gitlabUsername, "gitlab_username");
      fields.push("gitlab_username = ?"); values.push(gitlabUsername);
    }
    if (isSelf !== undefined) { fields.push("is_self = ?"); values.push(isSelf ? 1 : 0); }
    if (!fields.length) throw new UserError("Provide at least one participant field to update.");
    fields.push("updated_at = ?");
    values.push(now(), mattermostUsername);
    try {
      this.db.prepare(`UPDATE participants SET ${fields.join(", ")} WHERE mattermost_username = ? COLLATE NOCASE`).run(...values);
    } catch (error) {
      this.#participantConstraint(error);
    }
    return this.listParticipants({ mattermostUsername: newMattermostUsername ?? mattermostUsername })[0];
  }

  deleteParticipant({ mattermostUsername }) {
    requireUsername(mattermostUsername, "mattermost_username");
    affected(
      this.db.prepare("DELETE FROM participants WHERE mattermost_username = ? COLLATE NOCASE").run(mattermostUsername),
      `Participant '@${mattermostUsername}' does not exist.`,
    );
    return { deleted: `@${mattermostUsername}` };
  }

  addChannelMember({ channelName, mattermostUsername, displayName, gitlabUsername = null }) {
    const channel = this.#channel(channelName);
    if (!channel) throw new UserError(`Channel '${channelName}' does not exist.`);
    let participant = this.#participant(mattermostUsername);
    if (!participant) {
      if (displayName === undefined) throw new UserError(`Participant '@${mattermostUsername}' does not exist. Provide display_name to create it first.`);
      this.createParticipant({ displayName, mattermostUsername, gitlabUsername });
      participant = this.#participant(mattermostUsername);
    }
    this.db.prepare("INSERT OR IGNORE INTO channel_members(channel_id, participant_id) VALUES (?, ?)")
      .run(channel.id, participant.id);
    return this.listParticipants({ mattermostUsername })[0];
  }

  removeChannelMember({ channelName, mattermostUsername }) {
    const channel = this.#channel(channelName);
    if (!channel) throw new UserError(`Channel '${channelName}' does not exist.`);
    const participant = this.#participant(mattermostUsername);
    if (!participant) throw new UserError(`Participant '@${mattermostUsername}' does not exist.`);
    affected(
      this.db.prepare("DELETE FROM channel_members WHERE channel_id = ? AND participant_id = ?").run(channel.id, participant.id),
      `Participant '@${mattermostUsername}' is not assigned to channel '${channelName}'.`,
    );
    return this.listParticipants({ mattermostUsername })[0];
  }

  createConvention({ name, template, description = null }) {
    requireName(name, "name");
    if (this.#convention(name)) throw new UserError(`Convention '${name}' already exists.`);
    if (template.length > MAX_MESSAGE_LENGTH) throw new UserError(`template exceeds ${MAX_MESSAGE_LENGTH} characters.`);
    const timestamp = now();
    this.db.prepare("INSERT INTO conventions(name, description, template, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(name, description, template, timestamp, timestamp);
    return this.listConventions({ name })[0];
  }

  listConventions({ name } = {}) {
    const rows = name
      ? this.db.prepare("SELECT name, description, template, created_at, updated_at FROM conventions WHERE name = ?").all(name)
      : this.db.prepare("SELECT name, description, template, created_at, updated_at FROM conventions ORDER BY name").all();
    return rows.map((row) => ({
      name: row.name,
      description: row.description,
      template: row.template,
      variables: variablesIn(row.template),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  updateConvention({ name, newName, template, description }) {
    requireName(name, "name");
    if (!this.#convention(name)) throw new UserError(`Convention '${name}' does not exist.`);
    if (newName !== undefined) requireName(newName, "new_name");
    if (newName && newName !== name && this.#convention(newName)) throw new UserError(`Convention '${newName}' already exists.`);
    if (template !== undefined && template.length > MAX_MESSAGE_LENGTH) throw new UserError(`template exceeds ${MAX_MESSAGE_LENGTH} characters.`);
    const fields = [];
    const values = [];
    if (newName !== undefined) { fields.push("name = ?"); values.push(newName); }
    if (template !== undefined) { fields.push("template = ?"); values.push(template); }
    if (description !== undefined) { fields.push("description = ?"); values.push(description); }
    if (!fields.length) throw new UserError("Provide at least one convention field to update.");
    fields.push("updated_at = ?");
    values.push(now(), name);
    this.db.prepare(`UPDATE conventions SET ${fields.join(", ")} WHERE name = ?`).run(...values);
    return this.listConventions({ name: newName ?? name })[0];
  }

  deleteConvention({ name }) {
    requireName(name, "name");
    affected(this.db.prepare("DELETE FROM conventions WHERE name = ?").run(name), `Convention '${name}' does not exist.`);
    return { deleted: name };
  }

  previewMessage({ conventionName, variables = {} }) {
    const convention = this.#convention(conventionName);
    if (!convention) throw new UserError(`Convention '${conventionName}' does not exist.`);
    const text = renderTemplate(convention.template, variables);
    assertReviewMessage(conventionName, variables, text);
    return { conventionName, text };
  }

  async sendMessage({ channelNames, conventionName, variables = {}, text }) {
    if (new Set(channelNames).size !== channelNames.length) throw new UserError("channel_names cannot contain duplicates.");
    const rendered = this.#messageText({ conventionName, variables, text });
    const results = await Promise.all(channelNames.map(async (channelName) => {
      const channel = this.#channelForSend(channelName);
      if (!channel) return { channel: channelName, ok: false, error: "Channel does not exist." };
      if (!channel.enabled) return { channel: channelName, ok: false, error: "Channel is disabled." };
      const payload = { text: rendered };
      if (channel.mattermost_channel) payload.channel = channel.mattermost_channel;
      if (channel.username) payload.username = channel.username;
      if (channel.icon_url) payload.icon_url = channel.icon_url;
      try {
        await this.#post(channel.url, payload);
        return { channel: channelName, ok: true };
      } catch (error) {
        return { channel: channelName, ok: false, error: error instanceof UserError ? error.message : "Mattermost request failed." };
      }
    }));
    return { ok: results.every((result) => result.ok), text: rendered, results };
  }

  async sendDirectMessage({ participantId, viaChannelName, conventionName, variables = {}, text }) {
    const participant = this.#participantById(participantId);
    if (!participant) throw new UserError(`Participant id '${participantId}' does not exist.`);
    const channel = this.#channelForSend(viaChannelName);
    if (!channel) throw new UserError(`Channel '${viaChannelName}' does not exist.`);
    if (!channel.enabled) throw new UserError(`Channel '${viaChannelName}' is disabled.`);
    if (REVIEW_CONVENTIONS.has(conventionName)) {
      // 여러 명을 부르는 리뷰 컨벤션은 DM 대상이 한 명이라 애초에 성립하지 않는다.
      if (variables.mentions !== undefined) {
        throw new UserError("A multi-reviewer review convention cannot be sent as a DM. Send it to a channel instead.");
      }
      if (variables.mention !== `@${participant.mattermost_username}`) {
        throw new UserError("Review DM mention must match the selected participant's Mattermost username.");
      }
    }
    const rendered = this.#messageText({ conventionName, variables, text });
    const payload = { text: rendered, channel: `@${participant.mattermost_username}` };
    if (channel.username) payload.username = channel.username;
    if (channel.icon_url) payload.icon_url = channel.icon_url;
    await this.#post(channel.url, payload);
    return {
      ok: true,
      participant: { id: Number(participant.id), displayName: participant.display_name, mention: `@${participant.mattermost_username}` },
      viaChannel: viaChannelName,
      text: rendered,
    };
  }

  #webhook(name) {
    return this.db.prepare("SELECT id, name, url FROM webhooks WHERE name = ?").get(name);
  }

  #channel(name) {
    return this.db.prepare("SELECT id, name FROM channels WHERE name = ?").get(name);
  }

  #participant(mattermostUsername) {
    requireUsername(mattermostUsername, "mattermost_username");
    return this.db.prepare("SELECT id, mattermost_username FROM participants WHERE mattermost_username = ? COLLATE NOCASE").get(mattermostUsername);
  }

  #participantById(id) {
    return this.db.prepare("SELECT id, display_name, mattermost_username FROM participants WHERE id = ?").get(id);
  }

  #messageText({ conventionName, variables, text }) {
    if (!conventionName && REVIEW_TEXT_PATTERN.test(text ?? "")) {
      throw new UserError("Review messages must use convention_name 'review-request' or 'review-complete'; direct text is not allowed.");
    }
    const rendered = conventionName ? this.previewMessage({ conventionName, variables }).text : text;
    if (!rendered) throw new UserError("Provide convention_name or text.");
    if (rendered.length > MAX_MESSAGE_LENGTH) throw new UserError(`Message exceeds ${MAX_MESSAGE_LENGTH} characters.`);
    return rendered;
  }

  #participantConstraint(error) {
    const message = String(error?.message);
    if (message.includes("participants_one_self") || message.includes("participants.is_self")) throw new UserError("A self participant is already registered. Update that participant first.");
    if (message.includes("participants.gitlab_username")) throw new UserError("That GitLab username is already mapped to another participant.");
    if (message.includes("participants.mattermost_username")) throw new UserError("That Mattermost username is already registered.");
    throw error;
  }

  #convention(name) {
    return this.db.prepare("SELECT id, name, template FROM conventions WHERE name = ?").get(name);
  }

  #channelForSend(name) {
    return this.db.prepare(`
      SELECT channels.name, channels.mattermost_channel, channels.username,
             channels.icon_url, channels.enabled, webhooks.url
      FROM channels JOIN webhooks ON webhooks.id = channels.webhook_id
      WHERE channels.name = ?
    `).get(name);
  }

  async #post(url, payload) {
    let response;
    try {
      response = await this.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") throw new UserError("Mattermost request timed out.");
      throw new UserError("Mattermost request failed.");
    }
    await response.body?.cancel();
    if (!response.ok) throw new UserError(`Mattermost returned HTTP ${response.status}.`);
  }
}
