#!/usr/bin/env node
import { MattermostService, UserError } from "../src/core.js";
import { ReviewInbox } from "../src/review-inbox.js";
import { TeamContextService } from "../src/team-context.js";
import { workerSettings } from "../src/review-worker-config.js";
import { createConfiguredReviewWorker } from "../src/review-worker.js";
import { StartupContextSync } from "../src/startup-context-sync.js";
import { GitlabReviewClient } from "../src/review-gitlab.js";

let inbox;
let team;
let mattermost;
try {
  const settings = workerSettings();
  if (!settings.ready) throw new UserError(`Configure REVIEWBOT_AUTO_REVIEW=1 and ${settings.missing.join(", ") || "the automatic-review settings"}.`);
  inbox = new ReviewInbox({ dataDir: settings.dataDir, projectIds: settings.projectIds });
  team = new TeamContextService({ dataDir: settings.dataDir });
  mattermost = new MattermostService({ dataDir: settings.dataDir });
  let stopWeekly = () => {};
  const worker = createConfiguredReviewWorker({ inbox, contextService: team, mattermost, settings });
  const beginOperations = () => { stopWeekly = team.startWeeklyScheduler(); worker.start({ unref: false }); };
  const startupSync = settings.startupSync ? new StartupContextSync({ contextService: team,
    gitlab: new GitlabReviewClient({ host: settings.host, allowedProjectIds: settings.projectIds }),
    projectIds: settings.projectIds, onReady: beginOperations }) : null;
  if (startupSync) startupSync.start({ unref: false }); else beginOperations();
  process.stderr.write(startupSync ? "Startup context recovery started; automatic review waits for completion.\n" : "Automatic review worker started. Inspect job stages with review_worker_status.\n");
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await startupSync?.stop();
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
