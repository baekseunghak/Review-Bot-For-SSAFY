import { reviewerCommentPolicy } from "./reviewer-comments.js";

export async function syncReviewComments({ inbox, contextService, gitlab, limit = 25, offset = 0 }) {
  if (!reviewerCommentPolicy(contextService.dataDir).enabled) return { status: "disabled", results: [], nextOffset: null };
  const page = inbox.commentSyncTargets({ limit, offset });
  const results = [];
  for (const target of page.targets) {
    try {
      const source = await gitlab.readComments(target);
      const saved = contextService.captureReviewComments(source);
      results.push({ ...target, status: saved.status, commentCount: saved.commentCount ?? 0 });
    } catch (error) {
      results.push({ ...target, status: "failed", code: /^[a-z][a-z0-9_]{0,63}$/.test(error.code ?? "") ? error.code : "comment_sync_failed" });
    }
  }
  return { status: results.some((item) => item.status === "failed") ? "partial" : "fresh", totalMrs: page.total,
    results, nextOffset: page.nextOffset };
}
