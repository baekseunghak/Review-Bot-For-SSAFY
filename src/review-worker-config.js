import { UserError } from "./core.js";
import { reviewSettings } from "./review-config.js";
import { isAbsolute, win32 } from "node:path";

function integer(value, fallback, min, max, name) {
  if (value === undefined || value === "") return fallback;
  const result = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(result) || result < min || result > max) throw new UserError(`Invalid ${name}.`);
  return result;
}

export function workerSettings(env = process.env) {
  if (![undefined, "", "0", "1"].includes(env.REVIEWBOT_AUTO_REVIEW)) throw new UserError("REVIEWBOT_AUTO_REVIEW must be 0 or 1.");
  if (![undefined, "", "0", "1"].includes(env.REVIEWBOT_STARTUP_SYNC)) throw new UserError("REVIEWBOT_STARTUP_SYNC must be 0 or 1.");
  const { dataDir, projectIds } = reviewSettings(env);
  const enabled = env.REVIEWBOT_AUTO_REVIEW === "1";
  const host = env.REVIEWBOT_GITLAB_HOST?.trim() || "";
  if (host) {
    let url;
    try { url = new URL(`https://${host}`); } catch { throw new UserError("Invalid REVIEWBOT_GITLAB_HOST."); }
    if (host.startsWith("-") || url.host !== host.toLowerCase() || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new UserError("REVIEWBOT_GITLAB_HOST must be a hostname with an optional port.");
  }
  const channelName = env.REVIEWBOT_MATTERMOST_CHANNEL?.trim() || "";
  if (channelName && (!/^[\p{L}\p{N}](?:[\p{L}\p{N} ._-]*[\p{L}\p{N}._-])?$/u.test(channelName) || channelName.length > 64)) throw new UserError("Invalid REVIEWBOT_MATTERMOST_CHANNEL.");
  const provider = env.REVIEWBOT_REVIEW_PROVIDER?.trim().toLowerCase() || "claude";
  if (!["claude", "codex"].includes(provider)) throw new UserError("REVIEWBOT_REVIEW_PROVIDER must be claude or codex.");
  const command = env.REVIEWBOT_REVIEW_COMMAND?.trim() || provider;
  if (command.length > 2048 || /[\x00-\x1f\x7f]/.test(command)) throw new UserError("Invalid REVIEWBOT_REVIEW_COMMAND.");
  const model = env.REVIEWBOT_REVIEW_MODEL?.trim() || null;
  if (model !== null && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model)) throw new UserError("Invalid REVIEWBOT_REVIEW_MODEL.");
  const missing = [];
  if (!host) missing.push("REVIEWBOT_GITLAB_HOST");
  if (!projectIds.length) missing.push("REVIEWBOT_GITLAB_PROJECT_IDS");
  if (!channelName) missing.push("REVIEWBOT_MATTERMOST_CHANNEL");
  const validationConfigPath = env.REVIEWBOT_VALIDATION_CONFIG?.trim() || null;
  if (validationConfigPath && ((!isAbsolute(validationConfigPath) && !win32.isAbsolute(validationConfigPath))
    || /[\x00-\x1f]/.test(validationConfigPath) || validationConfigPath.length > 2048)) throw new UserError("Invalid REVIEWBOT_VALIDATION_CONFIG.");
  const startupSync = env.REVIEWBOT_STARTUP_SYNC === "1";
  if (startupSync && (!host || !projectIds.length)) throw new UserError("Startup sync requires the GitLab host and project allowlist.");
  return { dataDir, enabled, startupSync, ready: enabled && !missing.length, missing, host: host.toLowerCase(), projectIds, channelName, provider, command, model, validationConfigPath,
    intervalMs: integer(env.REVIEWBOT_WORKER_INTERVAL_MS, 5000, 1000, 300_000, "REVIEWBOT_WORKER_INTERVAL_MS"),
    timeoutMs: integer(env.REVIEWBOT_REVIEW_TIMEOUT_MS, 180_000, 1000, 900_000, "REVIEWBOT_REVIEW_TIMEOUT_MS") };
}
