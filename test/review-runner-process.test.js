import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import test from "node:test";
import { runReviewProcess, withReviewWorkspace } from "../src/review-runner-process.js";

test("프로세스 종료 직후 Windows cwd 잠금이 풀린 뒤 임시 작업 공간을 삭제한다", async () => {
  let directory;
  let closed;
  try {
    await assert.rejects(withReviewWorkspace(async (cwd) => {
      directory = cwd;
      return runReviewProcess({ command: process.execPath,
        args: ["-e", "process.stdin.resume();setInterval(()=>{},1000)"], directory: cwd, env: {}, input: "{}",
        timeoutMs: 30, maxOutputBytes: 1_000, spawnImpl: (...args) => {
          const child = spawn(...args);
          closed = new Promise((resolveClose) => child.once("close", resolveClose));
          return child;
        } });
    }), /timed out/);
    assert.equal(existsSync(directory), false);
  } finally {
    await closed;
    if (directory && dirname(resolve(directory)) === resolve(tmpdir()) && basename(directory).startsWith("reviewbot-runner-")) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
