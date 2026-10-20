import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { UserError } from "./core.js";

export function validateRunnerConfiguration({ command, model = null, timeoutMs, maxInputBytes, maxOutputBytes }) {
  if (typeof command !== "string" || !command.trim() || command.length > 2_048 || /[\x00-\x1f]/.test(command)
    || (model !== null && (typeof model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model)))
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1_800_000
    || !Number.isInteger(maxInputBytes) || maxInputBytes < 1 || maxInputBytes > 5_000_000
    || !Number.isInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 1_000_000) {
    throw new UserError("Invalid review runner configuration.");
  }
}

export function serializeReviewInput(input, maxInputBytes, signal) {
  let serialized;
  try { serialized = JSON.stringify(input); } catch { throw new UserError("Invalid review input."); }
  if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > maxInputBytes) {
    throw new UserError("The review input exceeds the runner limit. No partial review was published.");
  }
  if (signal?.aborted) throw new UserError("The review runner was cancelled.");
  return serialized;
}

export async function withReviewWorkspace(callback) {
  let directory;
  try { directory = await mkdtemp(join(tmpdir(), "reviewbot-runner-")); }
  catch { throw new UserError("The review runner could not create its temporary workspace."); }
  try {
    await chmod(directory, 0o700).catch(() => {});
    return await callback(directory);
  } finally {
    // Only the fresh directory created above is removed; no input path is ever used here.
    if (dirname(resolve(directory)) === resolve(tmpdir()) && basename(directory).startsWith("reviewbot-runner-")) {
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
    }
  }
}

export function runReviewProcess({ command, args, directory, env, input, spawnImpl, timeoutMs, maxOutputBytes, signal }) {
  return new Promise((resolveOutput, reject) => {
    let child;
    let timer;
    let finished = false;
    const chunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (error) {
        try { child?.kill("SIGKILL"); } catch {}
        reject(new UserError(error));
      } else resolveOutput(value);
    };
    const cancel = () => finish("The review runner was cancelled.");
    try {
      child = spawnImpl(command, args, { cwd: directory, env, shell: false,
        windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      child.once("error", () => finish("The review runner could not start. Check the CLI installation and authentication."));
      child.stdin.on("error", () => finish("The review runner could not receive its input."));
      child.stdout.on("error", () => finish("The review runner output could not be read."));
      child.stderr.on("error", () => finish("The review runner error output could not be read."));
      child.stdout.on("data", (chunk) => {
        stdoutBytes += Buffer.byteLength(chunk);
        if (stdoutBytes > maxOutputBytes) return finish("The review runner output exceeded its limit.");
        if (!finished) chunks.push(Buffer.from(chunk));
      });
      child.stderr.on("data", (chunk) => {
        stderrBytes += Buffer.byteLength(chunk);
        if (stderrBytes > maxOutputBytes) finish("The review runner error output exceeded its limit.");
      });
      child.once("close", (code) => {
        if (code !== 0) return finish("The review runner failed. Check CLI authentication, supported flags and usage limits.");
        finish(null, Buffer.concat(chunks).toString("utf8"));
      });
      timer = setTimeout(() => finish("The review runner timed out."), timeoutMs);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) return cancel();
      child.stdin.end(input);
    } catch {
      finish("The review runner could not start. Check the CLI installation and authentication.");
    }
  });
}
