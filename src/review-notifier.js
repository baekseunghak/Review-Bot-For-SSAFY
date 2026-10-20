import { UserError } from "./core.js";

export class MattermostReviewNotifier {
  constructor({ service, channelName }) { this.service = service; this.channelName = channelName; }

  prepare({ author, mrIid, mrUrl, headSha, issueKeys = [], verdict, commentUrl }) {
    const channel = this.service.listChannels({ name: this.channelName })[0];
    const participant = this.service.listParticipants({ gitlabUsername: author.username });
    if (!channel?.enabled || participant.length !== 1) throw new UserError("Configure the enabled notification channel and the MR author's GitLab-to-Mattermost mapping first.");
    const variables = { mention: participant[0].mention, mr_number: String(mrIid), mr_url: mrUrl,
      jira_key: issueKeys.join(", ") || "미연결",
      message: `리뷰 완료 · 판정: ${verdict === "hold" ? "보류" : "승인"} · SHA ${headSha.slice(0, 12)} · ${commentUrl}` };
    this.service.previewMessage({ conventionName: "review-complete", variables });
    return { participantId: participant[0].id, viaChannelName: this.channelName, conventionName: "review-complete", variables };
  }

  async send(payload) {
    const result = await this.service.sendDirectMessage(payload);
    if (!result?.ok) throw new UserError("Mattermost notification was not confirmed.");
    return { ok: true };
  }
}
