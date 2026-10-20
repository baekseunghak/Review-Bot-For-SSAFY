import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import test from "node:test";
import { prepareMrContext } from "../src/gitlab-context.js";
import { JiraClient } from "../src/jira-client.js";
import { TeamContextService } from "../src/team-context.js";
import { TeamContextStore } from "../src/team-context-store.js";

const MONDAY = "2026-10-19T00:00:00.000Z";
const NEXT_DAY = "2026-10-20T00:00:00.000Z";
const SHA = "a".repeat(40);
const SPRINT = "customfield_10020";
const STATUS = {
  "1": { id: "1", name: "Waiting", statusCategory: { key: "new" } },
  "2": { id: "2", name: "Building", statusCategory: { key: "indeterminate" } },
  "3": { id: "3", name: "Accepted", statusCategory: { key: "done" } },
};
const adf = (value) => ({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: value }] }] });

function profile(index) {
  return {
    id: `member-${index}`, displayName: `가상 통합 팀원 ${index}`, gitlabUsername: `fixture.${index}`,
    gitlabUserId: index, jiraAccountId: `fixture-member:${index}`, areas: [`영역 ${index}`],
    paths: [`component-${index}`], reviewFocus: [`검토 관점 ${index}`],
  };
}

function rawIssue(index, statusId = "2") {
  return {
    key: `TEST-${index}`, self: "https://unused.example.test/original-material",
    fields: {
      summary: `가상 통합 작업 ${index}`, description: adf(`완료 조건 ${index}: 입력 오류를 검증한다.`),
      status: { id: statusId, name: STATUS[statusId].name },
      assignee: index === 999 ? null : { accountId: `fixture-member:${index}` },
      created: "2026-10-10T00:00:00.000Z", updated: "2026-10-18T00:00:00.000Z", components: [{ name: `영역 ${index}` }],
      [SPRINT]: index === 6 ? undefined : [{ id: 12, state: index === 5 ? "future" : "active" }],
    },
  };
}

test("loopback Jira REST flows through the real client, weekly files and refreshed six-perspective MR context", { timeout: 20_000 }, async () => {
  const temporaryRoot = realpathSync(tmpdir());
  const dataDir = mkdtempSync(join(temporaryRoot, "team-context-integration-"));
  const records = new Map(Array.from({ length: 6 }, (_, i) => {
    const index = i + 1;
    return [`TEST-${index}`, rawIssue(index, index === 1 ? "3" : [3, 5, 6].includes(index) ? "1" : "2")];
  }));
  records.set("TEST-999", rawIssue(999, "1"));
  const changes = new Map([
    ["TEST-1", [
      { id: "101", created: "2026-10-13T00:00:00Z", items: [{ fieldId: "status", from: "1", to: "2", fromString: "Waiting", toString: "Building" }] },
      { id: "102", created: "2026-10-16T00:00:00Z", items: [{ fieldId: "status", from: "2", to: "3", fromString: "Building", toString: "Accepted" }] },
    ]],
  ]);
  const calls = [];
  const fixtureProblems = [];
  const auth = `Basic ${Buffer.from("fixture@example.test:fixture-token").toString("base64")}`;
  const server = createServer(async (request, response) => {
    const send = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      calls.push({ path: url.pathname, method: request.method });
      if (request.headers.authorization !== auth) return send({ error: "Fixture authentication required." }, 401);
      if (url.pathname === "/rest/api/3/field") return send([{ id: SPRINT, name: "Iteration", schema: { custom: "com.pyxis.greenhopper.jira:gh-sprint" } }]);
      if (url.pathname === "/rest/api/3/project/TEST/statuses") return send([{ statuses: Object.values(STATUS).map(({ id, name }) => ({ id, name })) }]);
      const status = /^\/rest\/api\/3\/status\/([123])$/.exec(url.pathname);
      if (status) return send(STATUS[status[1]]);
      if (url.pathname === "/rest/api/3/search/jql") {
        assert.equal(request.method, "POST");
        let body = "";
        for await (const chunk of request) body += chunk.toString("utf8");
        const search = JSON.parse(body);
        assert.match(search.jql, /^project = "TEST"/);
        assert.match(search.jql, /OR assignee WAS/);
        const account = /assignee = "([^"]+)"/.exec(search.jql)?.[1];
        assert.ok(account);
        assert.ok(search.fields.includes(SPRINT));
        assert.equal(search.fields.includes("comment"), false);
        assert.equal(search.fields.includes("attachment"), false);
        return send({ issues: [...records.values()].filter((issue) => issue.fields.assignee?.accountId === account), isLast: true });
      }
      const history = /^\/rest\/api\/3\/issue\/(TEST-\d+)\/changelog$/.exec(url.pathname);
      if (history) {
        const values = changes.get(history[1]) ?? [];
        const startAt = Number(url.searchParams.get("startAt"));
        const page = values.slice(startAt, startAt + 1);
        return send({ startAt, maxResults: 1, total: values.length, values: page, isLast: startAt + page.length >= values.length });
      }
      const one = /^\/rest\/api\/3\/issue\/(TEST-\d+)$/.exec(url.pathname);
      if (one && records.has(one[1])) {
        assert.equal(url.searchParams.get("fields").includes("comment"), false);
        return send(records.get(one[1]));
      }
      fixtureProblems.push("Unexpected fixture route.");
      send({}, 404);
    } catch {
      fixtureProblems.push("Invalid fixture request.");
      if (!response.headersSent) send({}, 500);
      else response.end();
    }
  });
  let service;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    let clock = MONDAY;
    const jiraClient = new JiraClient({
      baseUrl, email: "fixture@example.test", apiToken: "fixture-token", projectKey: "TEST", allowLocalHttp: true,
      now: () => new Date(clock),
      fetchImpl: (url, options) => { assert.equal(new URL(url).origin, baseUrl); return fetch(url, options); },
    });
    const store = new TeamContextStore({ dataDir });
    service = new TeamContextService({ store, jiraClient, now: () => new Date(clock) });
    for (let index = 1; index <= 6; index++) service.upsertMember(profile(index));
    assert.equal(service.listMembers().length, 6);
    const readPrivate = (file) => {
      const inside = relative(dataDir, file);
      assert.equal(isAbsolute(inside), false);
      assert.equal(inside === ".." || inside.startsWith(`..\\`) || inside.startsWith("../"), false);
      return readFileSync(file, "utf8");
    };

    const weekly = await service.refreshWeekly();
    assert.equal(weekly.status, "fresh");
    assert.equal(weekly.weekStart, "2026-10-19");
    assert.equal(weekly.summaries.length, 6);
    assert.deepEqual(weekly.summaries[0].completed.map((issue) => issue.key), ["TEST-1"]);
    assert.deepEqual(weekly.summaries[1].inProgress.map((issue) => issue.key), ["TEST-2"]);
    assert.deepEqual(weekly.summaries[2].planned.map((issue) => issue.key), ["TEST-3"]);
    assert.deepEqual(weekly.summaries[5].planUnconfirmed.map((issue) => issue.key), ["TEST-6"]);
    for (const summary of weekly.summaries) assert.match(readPrivate(summary.path), /Jira 상태 근거/);

    const mrUrl = "https://gitlab.example.test/team/project/-/merge_requests/71";
    const glabCalls = [];
    const runImpl = (file, args, options) => {
      assert.equal(file, "glab");
      assert.equal(options.shell, false);
      assert.deepEqual(args.slice(-2), ["--hostname", "gitlab.example.test"]);
      glabCalls.push(args);
      return JSON.stringify(args[1].includes("/diffs?")
        ? [{ old_path: "component-3/src/check.js", new_path: "component-3/src/check.js" }]
        : { author: { id: 2, username: "fixture.2" }, sha: SHA, diff_refs: { head_sha: SHA }, changes_count: "1", title: "TEST-999 integration", description: "TEST-999 acceptance criteria", source_branch: "feature/integration" });
    };
    const first = await prepareMrContext({ mrUrl, contextService: service, runImpl });
    assert.equal(first.status, "fresh");
    assert.equal(first.headSha, SHA);
    assert.equal(first.perspectives.length, 6);
    assert.equal(first.perspectives[0].memberId, "member-2");
    assert.equal(first.perspectives[0].relevance, "author");
    assert.equal(first.perspectives[1].memberId, "member-3");
    assert.equal(first.perspectives[1].relevance, "affected");
    assert.deepEqual(first.relatedIssues.map((issue) => issue.key), ["TEST-999"]);
    assert.equal(store.getIssuesForMember("member-2").some((issue) => issue.key === "TEST-999"), false);
    const firstMarkdown = readPrivate(first.path);
    for (let index = 1; index <= 6; index++) assert.ok(firstMarkdown.includes(`검토 관점 ${index}`));
    assert.match(firstMarkdown, /완료 조건 999/);

    clock = NEXT_DAY;
    records.get("TEST-2").fields.status = { id: "3", name: "Accepted" };
    records.get("TEST-2").fields.updated = NEXT_DAY;
    records.get("TEST-999").fields.description = adf("변경된 완료 조건: 실패 응답까지 확인한다.");
    records.get("TEST-999").fields.updated = NEXT_DAY;
    changes.set("TEST-2", [{ id: "201", created: NEXT_DAY, items: [{ field: "status", from: "2", to: "3", toString: "Accepted" }] }]);
    const second = await prepareMrContext({ mrUrl, contextService: service, runImpl });
    assert.equal(second.preparedAt, NEXT_DAY);
    assert.notEqual(second.contextVersion, first.contextVersion);
    assert.equal(second.perspectives[0].workItems.find((issue) => issue.key === "TEST-2").status.category, "done");
    assert.match(second.relatedIssues[0].description, /변경된 완료 조건/);
    assert.match(readPrivate(second.path), /변경된 완료 조건/);
    assert.equal(service.memberContext({ memberId: "member-2" }).sync.lastSuccessAt, NEXT_DAY);
    assert.equal(calls.filter((call) => call.path === "/rest/api/3/search/jql").length, 18);
    assert.equal(calls.filter((call) => call.path === "/rest/api/3/issue/TEST-999").length, 2);
    assert.ok(calls.some((call) => call.path === "/rest/api/3/status/3"));
    assert.equal(glabCalls.filter((args) => !args[1].includes("/diffs?")).length, 4);
    assert.deepEqual(fixtureProblems, []);
  } finally {
    service?.close();
    server.closeAllConnections();
    if (server.listening) await new Promise((done) => server.close(done));
    assert.equal(dirname(resolve(dataDir)), temporaryRoot);
    assert.ok(dataDir.startsWith(join(temporaryRoot, "team-context-integration-")));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
