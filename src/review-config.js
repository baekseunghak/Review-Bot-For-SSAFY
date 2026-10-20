import { UserError, resolveDataDir } from "./core.js";

function positiveInteger(value, name) {
  if (value === undefined || value === "") return null;
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1) {
    throw new UserError(`${name} must be a positive integer.`);
  }
  return number;
}

export function reviewSettings(env = process.env) {
  const username = env.REVIEWBOT_GITLAB_USERNAME?.trim() || "";
  if (username && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(username)) {
    throw new UserError("REVIEWBOT_GITLAB_USERNAME must be a username without @.");
  }
  const projectIds = [...new Set((env.REVIEWBOT_GITLAB_PROJECT_IDS || "")
    .split(",").map((value) => value.trim()).filter(Boolean)
    .map((value) => positiveInteger(value, "REVIEWBOT_GITLAB_PROJECT_IDS")))];
  const webhookSecret = env.REVIEWBOT_WEBHOOK_SECRET || null;
  if (webhookSecret && !/^[\x21-\x7e]{16,512}$/.test(webhookSecret)) {
    throw new UserError("REVIEWBOT_WEBHOOK_SECRET must contain 16 to 512 printable ASCII characters without spaces.");
  }
  const port = positiveInteger(env.REVIEWBOT_PORT || "8765", "REVIEWBOT_PORT");
  if (port > 65535) throw new UserError("REVIEWBOT_PORT must be at most 65535.");
  return {
    dataDir: env.MATTERMOST_MCP_DATA_DIR || resolveDataDir(),
    username,
    userId: positiveInteger(env.REVIEWBOT_GITLAB_USER_ID, "REVIEWBOT_GITLAB_USER_ID"),
    botUserId: positiveInteger(env.REVIEWBOT_GITLAB_BOT_USER_ID, "REVIEWBOT_GITLAB_BOT_USER_ID"),
    projectIds,
    webhookSecret,
    port,
  };
}
