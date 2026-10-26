#!/usr/bin/env node
import { workerSettings } from "../src/review-worker-config.js";
import { TeamContextService } from "../src/team-context.js";
import { ReviewInbox } from "../src/review-inbox.js";
import { GitlabReviewClient } from "../src/review-gitlab.js";
import { syncReviewComments } from "../src/review-comment-sync.js";

let inbox, contextService;
try {
  const settings = workerSettings();
  inbox = new ReviewInbox({ dataDir: settings.dataDir, projectIds: settings.projectIds });
  contextService = new TeamContextService({ dataDir: settings.dataDir });
  const gitlab = new GitlabReviewClient({ host: settings.host, allowedProjectIds: settings.projectIds });
  let offset = 0, page;
  do {
    page = await syncReviewComments({ inbox, contextService, gitlab, limit: 25, offset });
    console.log(JSON.stringify(page));
    if (page.status === "partial") process.exitCode = 1;
    offset = page.nextOffset;
  } while (offset !== null);
} catch {
  process.stderr.write("Comment sync failed. Check private policy, GitLab access and configured project IDs.\n");
  process.exitCode = 1;
} finally {
  inbox?.close();
  contextService?.store.close();
}
