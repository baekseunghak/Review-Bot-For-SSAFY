#!/usr/bin/env node
import { parseArgs } from "node:util";
import { workerSettings } from "../src/review-worker-config.js";
import { ReviewInbox } from "../src/review-inbox.js";
import { TeamContextService } from "../src/team-context.js";
import { MattermostService } from "../src/core.js";
import { createConfiguredReviewWorker } from "../src/review-worker.js";

let inbox, team, mattermost, worker;
try {
  const { positionals } = parseArgs({ allowPositionals: true });
  if (positionals.length !== 1 || !/^[1-9]\d*$/.test(positionals[0])) throw new Error("Invalid request ID");
  const requestId = Number(positionals[0]), settings = workerSettings();
  inbox = new ReviewInbox({ dataDir: settings.dataDir, projectIds: settings.projectIds });
  team = new TeamContextService({ dataDir: settings.dataDir });
  mattermost = new MattermostService({ dataDir: settings.dataDir });
  worker = createConfiguredReviewWorker({ inbox, contextService: team, mattermost, settings });
  // A failed explicit run stays failed, so an older background process cannot take its retry.
  worker.maxAttempts = 1;
  // The supported claim checks the stored current head and prevents any other worker from taking this retry.
  const result = await worker.runOnce({ requestId });
  console.log(JSON.stringify(result));
  if (result.status !== "completed") process.exitCode = 1;
} catch {
  process.stderr.write("The selected review request could not be run. Check its current SHA, stage, ownership and configuration.\n");
  process.exitCode = 1;
} finally { await worker?.stop(); inbox?.close(); team?.close(); mattermost?.close(); }
