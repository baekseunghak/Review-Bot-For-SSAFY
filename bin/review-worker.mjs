#!/usr/bin/env node
import { MattermostService, UserError } from "../src/core.js";
import { ReviewInbox } from "../src/review-inbox.js";
import { TeamContextService } from "../src/team-context.js";
import { workerSettings } from "../src/review-worker-config.js";
import { createConfiguredReviewWorker } from "../src/review-worker.js";

let inbox;
let team;
let mattermost;
try {
  const settings = workerSettings();
  if (!settings.ready) throw new UserError(`Configure REVIEWBOT_AUTO_REVIEW=1 and ${settings.missing.join(", ") || "the automatic-review settings"}.`);
  inbox = new ReviewInbox({ dataDir: settings.dataDir, projectIds: settings.projectIds });
  team = new TeamContextService({ dataDir: settings.dataDir });
  mattermost = new MattermostService({ dataDir: settings.dataDir });
  const stopWeekly = team.startWeeklyScheduler();
  const worker = createConfiguredReviewWorker({ inbox, contextService: team, mattermost, settings });
  worker.start({ unref: false });
  process.stderr.write("Automatic review worker started. Inspect job stages with review_worker_status.\n");
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    stopWeekly();
    await worker.stop();
    inbox.close(); team.close(); mattermost.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} catch (error) {
  inbox?.close(); team?.close(); mattermost?.close();
  process.stderr.write(`${error instanceof UserError ? error.message : "The automatic review worker could not start."}\n`);
  process.exitCode = 1;
}
