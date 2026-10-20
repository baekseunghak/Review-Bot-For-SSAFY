import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MattermostService, resolveDataDir } from "../src/core.js";

test("default data path uses the user home outside AppData", () => {
  assert.equal(resolveDataDir(), join(homedir(), ".mmp"));
});

test("forwarded Claude USERPROFILE selects shared storage", () => {
  const forwardedUserProfile = process.env.MATTERMOST_MCP_USERPROFILE;
  const forwarded = join(tmpdir(), "forwarded-user-profile");
  process.env.MATTERMOST_MCP_USERPROFILE = forwarded;
  try {
    assert.equal(resolveDataDir(), join(forwarded, ".mmp"));
  } finally {
    if (forwardedUserProfile === undefined) delete process.env.MATTERMOST_MCP_USERPROFILE;
    else process.env.MATTERMOST_MCP_USERPROFILE = forwardedUserProfile;
  }
});

test("non-empty legacy data migrates once into empty shared storage", () => {
  const root = mkdtempSync(join(tmpdir(), "mattermost-manager-migration-"));
  const legacyDir = join(root, "legacy");
  const sharedDir = join(root, "shared");
  const legacy = new MattermostService({ dataDir: legacyDir });
  legacy.createWebhook({ name: "legacy-webhook", webhookUrl: "https://mattermost.example.com/hooks/secret" });
  legacy.createChannel({ name: "legacy-channel", webhookName: "legacy-webhook" });
  legacy.createParticipant({ displayName: "Legacy User", mattermostUsername: "legacy.user" });
  legacy.addChannelMember({ channelName: "legacy-channel", mattermostUsername: "legacy.user" });
  legacy.createConvention({ name: "legacy-convention", template: "{{message}}" });
  legacy.close();

  const shared = new MattermostService({ dataDir: sharedDir });
  try {
    assert.equal(shared.migrateLegacyData(join(legacyDir, "mattermost.sqlite3")), true);
    assert.equal(shared.listWebhooks().length, 1);
    assert.equal(shared.listChannels().length, 1);
    assert.equal(shared.listParticipants().length, 1);
    assert.equal(shared.listConventions().length, 1);
    assert.equal(shared.migrateLegacyData(join(legacyDir, "mattermost.sqlite3")), false);
  } finally {
    shared.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("CRUD, template rendering, secret redaction, and webhook delivery", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mattermost-manager-test-"));
  let received;
  const mock = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      received = JSON.parse(body);
      response.writeHead(200).end("ok");
    });
  });
  await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const { port } = mock.address();
  const service = new MattermostService({ dataDir, allowHttp: true });

  try {
    const secret = `http://127.0.0.1:${port}/hooks/super-secret-token`;
    service.createWebhook({ name: "특화-프로젝트", webhookUrl: secret });
    const listedWebhook = service.listWebhooks()[0];
    assert.equal(listedWebhook.name, "특화-프로젝트");
    assert.equal(JSON.stringify(listedWebhook).includes("super-secret-token"), false);

    service.createChannel({ name: "나에게 보내기", webhookName: "특화-프로젝트", mattermostChannel: "dev-alerts" });
    service.updateChannel({ name: "나에게 보내기", username: "Codex" });
    service.createParticipant({
      displayName: "김철수",
      mattermostUsername: "chulsoo.kim",
      gitlabUsername: "my-gitlab-id",
      isSelf: true,
    });
    service.addChannelMember({ channelName: "나에게 보내기", mattermostUsername: "chulsoo.kim" });
    service.addChannelMember({
      channelName: "나에게 보내기",
      displayName: "리뷰 요청자",
      mattermostUsername: "reviewer.mm",
      gitlabUsername: "review-author",
    });
    service.createParticipant({ displayName: "이철수", mattermostUsername: "other.dh" });
    const requester = service.listParticipants({ channelName: "나에게 보내기", gitlabUsername: "REVIEW-AUTHOR" })[0];
    assert.equal(requester.mention, "@reviewer.mm");
    assert.deepEqual(requester.channels, ["나에게 보내기"]);
    assert.equal(service.listParticipants({ channelName: "나에게 보내기", displayName: "리뷰 요청자" })[0].mattermostUsername, "reviewer.mm");
    assert.equal(service.listParticipants({ nameQuery: "철수" }).length, 2);
    assert.equal(service.listParticipants({ selfOnly: true })[0].mention, "@chulsoo.kim");
    assert.throws(() => service.createParticipant({
      displayName: "다른 본인",
      mattermostUsername: "other-self",
      isSelf: true,
    }), /self participant/);
    service.updateParticipant({ mattermostUsername: "reviewer.mm", newMattermostUsername: "requester.mm" });
    assert.equal(service.listParticipants({ gitlabUsername: "review-author" })[0].mention, "@requester.mm");
    service.removeChannelMember({ channelName: "나에게 보내기", mattermostUsername: "requester.mm" });
    assert.deepEqual(service.listParticipants({ mattermostUsername: "requester.mm" })[0].channels, []);
    service.createConvention({ name: "deploy_ok", template: "✅ {{service}} {{version}} deployed" });
    service.createConvention({
      name: "review-request",
      template: "{{mention}} :merge_please: !{{mr_number}} | [{{jira_key}}] {{message}}",
    });
    service.updateConvention({ name: "deploy_ok", description: "Successful deployment" });
    assert.deepEqual(service.listConventions({ name: "deploy_ok" })[0].variables, ["service", "version"]);
    assert.equal(service.previewMessage({ conventionName: "deploy_ok", variables: { service: "api", version: "v1" } }).text, "✅ api v1 deployed");

    const dm = await service.sendDirectMessage({
      participantId: requester.id,
      viaChannelName: "나에게 보내기",
      text: "DM hello",
    });
    assert.equal(dm.ok, true);
    assert.deepEqual(received, { text: "DM hello", channel: "@requester.mm", username: "Codex" });

    await service.sendDirectMessage({
      participantId: requester.id,
      viaChannelName: "나에게 보내기",
      text: "리뷰 회의는 오후 3시입니다.",
    });
    assert.equal(received.text, "리뷰 회의는 오후 3시입니다.");

    const reviewDm = await service.sendDirectMessage({
      participantId: requester.id,
      viaChannelName: "나에게 보내기",
      conventionName: "review-request",
      variables: {
        mention: "@requester.mm",
        mr_number: 124,
        jira_key: "PROJ-124",
        message: "리뷰 부탁드립니당.",
      },
    });
    assert.equal(reviewDm.ok, true);
    assert.deepEqual(received, {
      text: "@requester.mm :merge_please: !124 | [PROJ-124] 리뷰 부탁드립니당.",
      channel: "@requester.mm",
      username: "Codex",
    });
    await assert.rejects(
      service.sendDirectMessage({
        participantId: requester.id,
        viaChannelName: "나에게 보내기",
        conventionName: "review-request",
        variables: {
          mention: "@chulsoo.kim",
          mr_number: 124,
          jira_key: "PROJ-124",
          message: "리뷰 부탁드립니당.",
        },
      }),
      /mention must match the selected participant/,
    );
    await assert.rejects(
      service.sendDirectMessage({
        participantId: requester.id,
        viaChannelName: "나에게 보내기",
        text: "영희님, MR !124 리뷰 부탁드립니다.",
      }),
      /Review messages must use convention_name/,
    );
    assert.throws(() => service.previewMessage({
      conventionName: "review-request",
      variables: {
        mention: "영희님",
        mr_number: 124,
        jira_key: "PROJ-124",
        message: "리뷰 부탁드립니당.",
      },
    }), /mention must start with @/);

    // 팀이 템플릿에 MR URL과 줄바꿈을 넣어도 통과해야 한다. 강제되는 것은 레이아웃이 아니라 내용이다.
    service.updateConvention({
      name: "review-request",
      template: "{{mention}} :merge_please: !{{mr_number}} | [{{jira_key}}]\n{{mr_url}}\n - {{message}}",
    });
    const multiline = service.previewMessage({
      conventionName: "review-request",
      variables: {
        mention: "@requester.mm",
        mr_number: 124,
        jira_key: "PROJ-124",
        mr_url: "https://gitlab.example.com/group/repo/-/merge_requests/124",
        message: "리뷰 부탁드립니당.",
      },
    });
    assert.match(multiline.text, /^@requester\.mm :merge_please: !124 \| \[PROJ-124\]\n/);
    assert.match(multiline.text, /merge_requests\/124\n - 리뷰 부탁드립니당\.$/);

    // 레이아웃이 자유로워져도 수신자·이모지는 여전히 틀릴 수 없다.
    service.updateConvention({ name: "review-request", template: "{{mr_url}} {{mention}} {{mr_number}} {{jira_key}} {{message}}" });
    assert.throws(() => service.previewMessage({
      conventionName: "review-request",
      variables: {
        mention: "@requester.mm",
        mr_number: 124,
        jira_key: "PROJ-124",
        mr_url: "https://gitlab.example.com/group/repo/-/merge_requests/124",
        message: "리뷰 부탁드립니당.",
      },
    }), /must begin with the recipient's exact @mention/);

    service.updateConvention({
      name: "review-request",
      template: "{{mention}} :merge_please: !{{mr_number}} | [{{jira_key}}] {{message}}",
    });

    // 여러 명을 부르는 리뷰 컨벤션도 검증을 받는다.
    service.createConvention({
      name: "review-request-multi",
      template: "{{mentions}}\n:merge_please: !{{mr_number}} | [{{jira_key}}]\n{{mr_url}}\n - {{message}}",
    });
    const multiVars = {
      mentions: "@requester.mm @second.mm",
      mr_number: 124,
      jira_key: "PROJ-124",
      mr_url: "https://gitlab.example.com/group/repo/-/merge_requests/124",
      message: "리뷰 부탁드립니당.",
    };
    assert.match(
      service.previewMessage({ conventionName: "review-request-multi", variables: multiVars }).text,
      /^@requester\.mm @second\.mm\n:merge_please: !124 \| \[PROJ-124\]\n/,
    );
    assert.throws(() => service.previewMessage({
      conventionName: "review-request-multi",
      variables: { ...multiVars, mentions: "@requester.mm 영희님" },
    }), /mention must start with @/);
    assert.throws(() => service.previewMessage({
      conventionName: "review-request-multi",
      variables: { ...multiVars, mr_number: "!124" },
    }), /mr_number must contain digits only/);
    await assert.rejects(
      service.sendDirectMessage({
        participantId: requester.id,
        viaChannelName: "나에게 보내기",
        conventionName: "review-request-multi",
        variables: multiVars,
      }),
      /multi-reviewer review convention cannot be sent as a DM/,
    );
    service.deleteConvention({ name: "review-request-multi" });

    const sent = await service.sendMessage({
      channelNames: ["나에게 보내기"],
      conventionName: "deploy_ok",
      variables: { service: "api", version: "v1" },
    });
    assert.equal(sent.ok, true);
    assert.deepEqual(received, { text: "✅ api v1 deployed", channel: "dev-alerts", username: "Codex" });
    assert.throws(() => service.deleteWebhook({ name: "특화-프로젝트" }), /used by channels/);

    service.deleteChannel({ name: "나에게 보내기" });
    service.deleteParticipant({ mattermostUsername: "chulsoo.kim" });
    service.deleteParticipant({ mattermostUsername: "requester.mm" });
    service.deleteParticipant({ mattermostUsername: "other.dh" });
    service.deleteConvention({ name: "deploy_ok" });
    service.deleteConvention({ name: "review-request" });
    service.deleteWebhook({ name: "특화-프로젝트" });
    assert.deepEqual(service.listWebhooks(), []);
  } finally {
    service.close();
    await new Promise((resolve) => mock.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
