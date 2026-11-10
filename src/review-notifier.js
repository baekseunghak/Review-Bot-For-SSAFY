import { UserError } from "./core.js";

export class MattermostReviewNotifier {
  constructor({ service, channelName }) { this.service = service; this.channelName = channelName; }

  prepare({ author, mrIid, mrUrl, headSha, issueKeys = [], verdict, commentUrl }) {
    return this.#prepare({ author, mrIid, mrUrl, issueKeys }, "review-complete",
      `리뷰 완료 · 판정: ${verdict === "hold" ? "보류" : "승인"} · SHA ${headSha.slice(0, 12)} · ${commentUrl}`);
  }

  prepareFailure({ author, mrIid, mrUrl, headSha, requestId, stage, errorCode, reason }) {
    return this.#prepare({ author, mrIid, mrUrl, issueKeys: ["미확인"] }, "review-failed",
      `자동 검토 실패 · 요청 #${requestId} · SHA ${headSha.slice(0, 12)} · ${stage} · ${reason} (${errorCode}) · ${mrUrl}`);
  }

  #prepare({ author, mrIid, mrUrl, issueKeys }, conventionName, message) {
    const channel = this.service.listChannels({ name: this.channelName })[0];
    let recipients = this.service.listParticipants({ gitlabUsername: author.username });
    if (conventionName === "review-failed" && !recipients.length) recipients = this.service.listParticipants({ selfOnly: true });
    if (!channel?.enabled || recipients.length !== 1) throw Object.assign(new UserError("Configure the enabled notification channel and the MR author's GitLab-to-Mattermost mapping first."), { code: "notification_setup_missing" });
    const [recipient] = recipients;
    const variables = { mention: recipient.mention, mr_number: String(mrIid), mr_url: mrUrl,
      jira_key: issueKeys.join(", ") || "미연결", message };
    this.service.previewMessage({ conventionName, variables });
    return { participantId: recipient.id, viaChannelName: this.channelName, conventionName, variables };
  }

  async send(payload) {
    const result = await this.service.sendDirectMessage(payload);
    if (!result?.ok) throw new UserError("Mattermost notification was not confirmed.");
    return { ok: true };
  }
}
