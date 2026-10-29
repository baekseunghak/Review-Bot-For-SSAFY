#!/usr/bin/env node
import { workerSettings } from "../src/review-worker-config.js";
import { TeamContextService } from "../src/team-context.js";
import { GitlabReviewClient } from "../src/review-gitlab.js";
import { StartupContextSync } from "../src/startup-context-sync.js";

let team, sync;
try {
  const settings = workerSettings();
  team = new TeamContextService({ dataDir: settings.dataDir });
  sync = new StartupContextSync({ contextService: team, projectIds: settings.projectIds,
    gitlab: new GitlabReviewClient({ host: settings.host, allowedProjectIds: settings.projectIds }) });
  await sync.runOnce();
  const state = sync.status();
  console.log(JSON.stringify({ ...state, published: false }));
  if (!state.ready) process.exitCode = 1;
} catch {
  process.stderr.write("Context catch-up failed. Check the local configuration and source access.\n");
  process.exitCode = 1;
} finally { await sync?.stop(); team?.close(); }
