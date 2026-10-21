import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { UserError } from "./core.js";
import { normalizeReviewResult, REVIEW_RESULT_SCHEMA, REVIEW_SYSTEM_PROMPT } from "./review-runner.js";
import { runReviewProcess, serializeReviewInput, validateRunnerConfiguration, withReviewWorkspace } from "./review-runner-process.js";

const DISABLED_CODE_MODE_NOTICES = new Set([
  "Code Mode is unavailable because code-mode host is disabled. Falling back to direct tools; enable `features.code_mode_host` and install `codex-code-mode-host`.",
  "Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.",
]);

function runnerEnvironment(env) {
  const keep = /^(?:PATH|PATHEXT|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|LOCALAPPDATA|APPDATA|SYSTEMROOT|WINDIR|COMSPEC|TMP|TEMP|TMPDIR|LANG|LC_[A-Z_]+|TZ|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|CODEX_HOME)$/i;
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => keep.test(key) && typeof value === "string"));
}

function completedReview(output) {
  try {
    let completed = false;
    let started = false;
    let disabledCodeModeNotice = false;
    let response;
    for (const line of output.split(/\r?\n/).filter((value) => value.trim())) {
      const event = JSON.parse(line);
      if (!event || typeof event !== "object" || Array.isArray(event) || completed) throw new Error();
      if (event.type === "thread.started") continue;
      if (event.type === "turn.started") {
        if (started) throw new Error();
        started = true;
      } else if (["item.started", "item.updated", "item.completed"].includes(event.type)) {
        if (event.type === "item.completed" && event.item?.type === "error" && !started && !response
          && !disabledCodeModeNotice && DISABLED_CODE_MODE_NOTICES.has(event.item.message)) {
          // The host is deliberately disabled; the remaining tool and sandbox restrictions still apply.
          disabledCodeModeNotice = true;
          continue;
        }
        if (!event.item || !["reasoning", "agent_message"].includes(event.item.type)) throw new Error();
        if (event.type === "item.completed" && event.item.type === "agent_message") {
          if (typeof event.item.text !== "string" || !event.item.text.trim()) throw new Error();
          response = event.item.text;
        }
      } else if (event.type === "turn.completed") {
        if (!response) throw new Error();
        completed = true;
      } else throw new Error();
    }
    if (!completed) throw new Error();
    return JSON.parse(response);
  } catch {
    throw Object.assign(new UserError("The review runner did not return a completed review. No review was published."), { code: "runner_response_invalid" });
  }
}

export class CodexReviewRunner {
  constructor({ command = "codex", model = null, timeoutMs = 180_000, maxInputBytes = 2 * 1024 * 1024,
    maxOutputBytes = 200_000, spawnImpl = spawn, env = process.env } = {}) {
    validateRunnerConfiguration({ command, model, timeoutMs, maxInputBytes, maxOutputBytes });
    this.command = command;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.maxInputBytes = maxInputBytes;
    this.maxOutputBytes = maxOutputBytes;
    this.spawn = spawnImpl;
    this.env = runnerEnvironment(env);
  }

  async review(input, { signal } = {}) {
    const serialized = serializeReviewInput(input, this.maxInputBytes, signal);
    return withReviewWorkspace(async (directory) => {
      const schemaFile = join(directory, "review-result.schema.json");
      try { await writeFile(schemaFile, JSON.stringify(REVIEW_RESULT_SCHEMA), { flag: "wx", mode: 0o600 }); }
      catch { throw Object.assign(new UserError("The review runner could not prepare its output schema."), { code: "runner_start_failed" }); }
      const args = ["exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check",
        "--sandbox", "read-only", "--json", "--output-schema", schemaFile,
        "-c", `developer_instructions=${JSON.stringify(REVIEW_SYSTEM_PROMPT)}`,
        "-c", 'approval_policy="never"', "-c", "project_doc_max_bytes=0", "-c", 'web_search="disabled"',
        "-c", "suppress_unstable_features_warning=true",
        "-c", "skills.include_instructions=false", "-c", "skills.bundled.enabled=false",
        "-c", "features.skip_host_skill_discovery=true"];
      for (const feature of ["shell_tool", "apps", "hooks", "plugins", "multi_agent", "browser_use", "computer_use", "image_generation", "workspace_dependencies", "view_image", "code_mode", "code_mode_host",
        "skill_search", "remote_plugin", "shell_snapshot", "sleep_tool"]) {
        args.push("-c", `features.${feature}=false`);
      }
      if (this.model) args.push("--model", this.model);
      args.push("-");
      const output = await runReviewProcess({ command: this.command, args, directory, env: this.env,
        input: serialized, spawnImpl: this.spawn, timeoutMs: this.timeoutMs, maxOutputBytes: this.maxOutputBytes, signal });
      return normalizeReviewResult(completedReview(output), { context: input?.context, changes: input?.changes });
    });
  }
}
