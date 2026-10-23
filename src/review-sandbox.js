import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

// The Docker CLI receives host credentials; the container receives only the explicit --env values below.
export function dockerProcess(args, { input, timeoutMs = 30_000, signal, maxOutputBytes = 256_000 } = {}) {
  return new Promise((resolve) => {
    let child, timer, settled = false, size = 0;
    const chunks = [];
    const finish = (reason, exitCode = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (reason) child?.kill();
      resolve({ reason, exitCode, output: Buffer.concat(chunks).toString("utf8") });
    };
    const abort = () => finish("cancelled");
    if (signal?.aborted) return finish("cancelled");
    try {
      child = spawn("docker", args, { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      child.on("error", () => finish("docker_unavailable"));
      for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxOutputBytes) return finish("output_limit");
        chunks.push(Buffer.from(chunk));
      });
      child.on("close", (code) => finish(null, code));
      // A command can close stdin while the source archive is still being sent.
      child.stdin.on("error", () => {});
      child.stdin.end(input);
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => finish("timeout"), timeoutMs);
    } catch { finish("docker_unavailable"); }
  });
}

export function redactValidationLog(value) {
  return String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\n]*PRIVATE KEY-----|$)/g, "[redacted private key]")
    .replace(/\b(?:glpat-|github_pat_|ghp_|xox[baprs]-|sk-ant-)[A-Za-z0-9_-]+/g, "[redacted token]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted jwt]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/(\b(?:password|passwd|secret|token|api[_-]?key|authorization)\b\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[redacted]@");
}

export class DockerReviewSandbox {
  constructor({ run = dockerProcess } = {}) { this.run = run; }

  async execute(check, archive, { signal } = {}) {
    const base = { name: check.name, kind: check.kind, directory: check.directory, command: check.command,
      result: "not_run", failureKind: "environment", exitCode: null, imageId: null, output: "" };
    if (!check.command) return { ...base, reason: check.reason || "command_not_configured" };
    const info = await this.run(["info", "--format", "{{.OSType}}|{{.MemoryLimit}}|{{.SwapLimit}}|{{.CPUCfsQuota}}|{{.PidsLimit}}"], { signal });
    if (info.reason || info.exitCode !== 0) return { ...base, reason: "linux_docker_unavailable" };
    if (info.output.trim() !== "linux|true|true|true|true") return { ...base, reason: "docker_isolation_unsupported" };
    const inspected = await this.run(["image", "inspect", check.image, "--format", "{{json .}}"], { signal });
    let image;
    try { image = JSON.parse(inspected.output); } catch { /* An unprepared image is an environment limitation. */ }
    if (inspected.reason || inspected.exitCode !== 0 || image?.Os !== "linux" || !/^sha256:[a-f0-9]{64}$/.test(image?.Id ?? "")
      || Object.keys(image?.Config?.Volumes ?? {}).length
      || (image?.Config?.Env ?? []).some((entry) => /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|CREDENTIAL)/i.test(entry.split("=", 1)[0]))) {
      return { ...base, reason: "clean_local_image_required" };
    }
    base.imageId = image.Id;
    const name = `reviewbot-check-${randomUUID()}`;
    // No checkout is extracted on the host. No host bind, Docker socket, service network or credential is mounted.
    const bootstrap = "mkdir -p /workspace/src || exit 120; tar -xzf - -C /workspace/src --strip-components=1 --no-same-owner || exit 120; cd \"/workspace/src/$1\" || exit 121; shift; exec \"$@\"";
    const args = ["run", "--rm", "--pull=never", "--name", name, "--network=none", "--read-only", "--log-driver=none", "--no-healthcheck",
      "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=256", "--cpus=2", "--memory=3g", "--memory-swap=3g",
      "--user=1000:1000", "--tmpfs", "/workspace:rw,exec,nosuid,nodev,size=2147483648,uid=1000,gid=1000,mode=0700",
      "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=1073741824,uid=1000,gid=1000,mode=0700",
      "--workdir=/workspace", "--env=HOME=/tmp", "--env=CI=true", "--env=GRADLE_USER_HOME=/tmp/gradle",
      "--entrypoint=/bin/sh", "-i", image.Id, "-c", bootstrap, "reviewbot", check.directory, ...check.command];
    const startedAt = new Date().toISOString();
    let outcome;
    try { outcome = await this.run(args, { input: archive.data, timeoutMs: check.timeoutMs, signal }); }
    finally {
      // Killing the CLI alone does not terminate a detached container after a timeout or cancellation.
      await this.run(["rm", "--force", "--volumes", name], { timeoutMs: 15_000 });
    }
    const missingDependency = /No cached version of .+ available for offline mode|No cached resource .+ available for offline mode/.test(outcome.output);
    const missingLibrary = /ImportError: [^\r\n]*cannot open shared object file: No such file or directory/.test(outcome.output);
    const infrastructure = outcome.reason || missingDependency || missingLibrary || [null, 120, 121, 122, 125, 126, 127, 137].includes(outcome.exitCode);
    const tail = Buffer.from(redactValidationLog(outcome.output), "utf8").subarray(-8_000);
    const firstCharacter = tail.findIndex((byte) => (byte & 0xc0) !== 0x80);
    return { ...base, startedAt, finishedAt: new Date().toISOString(), exitCode: outcome.exitCode,
      result: infrastructure ? "unknown" : outcome.exitCode === 0 ? "passed" : "failed",
      failureKind: infrastructure ? "environment" : outcome.exitCode === 0 ? null : "command",
      reason: outcome.reason || (missingDependency ? "offline_dependency_missing" : missingLibrary ? "runtime_dependency_missing" : infrastructure ? "container_or_runtime_error" : null),
      output: tail.subarray(Math.max(0, firstCharacter)).toString("utf8") };
  }
}
