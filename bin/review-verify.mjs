#!/usr/bin/env node
import { parseArgs } from "node:util";
import { join } from "node:path";
import { parseGitlabMrUrl } from "../src/gitlab-context.js";
import { workerSettings } from "../src/review-worker-config.js";
import { GitlabReviewClient } from "../src/review-gitlab.js";
import { ReviewVerificationService } from "../src/review-verification.js";

try {
  const { positionals } = parseArgs({ allowPositionals: true });
  if (positionals.length !== 1) throw new Error("usage");
  const settings = workerSettings();
  const target = parseGitlabMrUrl(positionals[0]);
  if (target.host !== settings.host) throw new Error("host");
  const gitlab = new GitlabReviewClient({ host: settings.host, allowedProjectIds: settings.projectIds });
  const mr = await gitlab.api(`projects/${encodeURIComponent(target.project)}/merge_requests/${target.iid}`);
  const input = { projectId: mr.project_id, mrIid: target.iid };
  const head = await gitlab.readHead(input);
  gitlab.assertReady(head);
  input.headSha = head.headSha;
  const service = new ReviewVerificationService({ gitlab, dataDir: settings.dataDir,
    ...(settings.validationConfigPath ? { configPath: settings.validationConfigPath } : {}) });
  const result = await service.collect(input);
  const after = await gitlab.readHead(input);
  console.log(JSON.stringify({ runId: result.runId, headSha: result.headSha, stillCurrent: after.headSha === result.headSha,
    ci: { status: result.ci.status, pipeline: result.ci.pipeline, tests: result.ci.tests }, configuration: result.configuration,
    checks: result.checks.map(({ name, kind, result, reason, exitCode }) => ({ name, kind, result, reason, exitCode })),
    privateReport: join(settings.dataDir, "validation", `${result.runId}.json`), published: false }));
} catch {
  process.stderr.write("Verification could not complete. Use: node --env-file=.env bin/review-verify.mjs <allowed GitLab MR URL>. Check settings, access and local validation configuration.\n");
  process.exitCode = 1;
}
