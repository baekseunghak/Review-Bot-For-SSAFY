import assert from "node:assert/strict";
import test from "node:test";
import { UserError } from "../src/core.js";
import { JiraClient } from "../src/jira-client.js";

const T1 = "2026-10-12T09:00:00.000+0900";
const T2 = "2026-10-19T09:00:00.000+0900";
const NOW = "2026-10-20T00:00:00.000Z";
const SPRINT = "customfield_10020";
const FIELDS = [{ id: SPRINT, name: "Renamed iteration", schema: { custom: "com.pyxis.greenhopper.jira:gh-sprint" } }];
const STATUSES = [{ statuses: [
  { id: "1", name: "Queue", statusCategory: { key: "new" } },
  { id: "2", name: "Work", statusCategory: { key: "indeterminate" } },
  { id: "3", name: "Shipped", statusCategory: { key: "done" } },
] }];

function issue(key = "TEST-1", fields = {}) {
  return {
    key, self: "https://unrelated.example.test/private",
    fields: {
      summary: "Review implementation", description: null,
      status: { id: "2", name: "Custom workflow label", statusCategory: { key: "indeterminate" } },
      assignee: { accountId: "member:one", displayName: "unused-personal-name", emailAddress: "unused@example.test" },
      created: T1, updated: T2, components: [{ name: "Backend" }],
      [SPRINT]: [{ id: 12, state: "active" }], ...fields,
    },
  };
}

function changelog(id = "100", items = [{ fieldId: "status", from: "1", to: "2", fromString: "Queue", toString: "Work" }]) {
  return { id, created: T2, author: { displayName: "unused-author" }, items };
}

function response(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function fake({ fields = FIELDS, statuses = STATUSES, pages = [{ issues: [issue()], isLast: true }], histories = () => ({ values: [], isLast: true, total: 0 }), issues = {}, intercept } = {}) {
  const calls = [];
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    const body = options.body === undefined ? undefined : JSON.parse(options.body);
    calls.push({ url, options, body });
    const intercepted = intercept?.(url, options, body, calls);
    if (intercepted !== undefined) return intercepted;
    if (url.pathname === "/rest/api/3/field") return response(fields);
    if (url.pathname === "/rest/api/3/project/TEST/statuses") return response(statuses);
    const status = /^\/rest\/api\/3\/status\/(\d+)$/.exec(url.pathname);
    if (status) return response(STATUSES[0].statuses.find((item) => item.id === status[1]) ?? {}, 200);
    if (url.pathname === "/rest/api/3/search/jql") return response(pages[calls.filter((call) => call.url.pathname === url.pathname).length - 1]);
    const history = /^\/rest\/api\/3\/issue\/(TEST-\d+)\/changelog$/.exec(url.pathname);
    if (history) {
      const startAt = Number(url.searchParams.get("startAt"));
      return response({ startAt, ...histories(history[1], startAt) });
    }
    const one = /^\/rest\/api\/3\/issue\/(TEST-\d+)$/.exec(url.pathname);
    if (one) return response(issues[one[1]] ?? issue(one[1]));
    throw new Error("Unexpected fake route.");
  };
  return { calls, fetchImpl };
}

function client(mock = fake(), options = {}) {
  return new JiraClient({ baseUrl: "https://jira.example.test", email: "reader@example.test", apiToken: "fake-token", projectKey: "TEST", fetchImpl: mock.fetchImpl, now: () => new Date(NOW), ...options });
}

test("unconfigured clients do not contact Jira and env defaults contain no assumed account", async () => {
  const mock = fake();
  const empty = new JiraClient({ fetchImpl: mock.fetchImpl });
  assert.equal(empty.configured, false);
  await assert.rejects(empty.getMemberIssues("member:one"), (error) => error instanceof UserError && error.message.includes("not configured"));
  assert.equal(mock.calls.length, 0);
  assert.equal(JiraClient.fromEnv({}).configured, false);
  assert.equal(JiraClient.fromEnv({ REVIEWBOT_JIRA_BASE_URL: "https://jira.example.test" }).configured, false);
  const credentials = { REVIEWBOT_JIRA_BASE_URL: "https://jira.example.test", REVIEWBOT_JIRA_EMAIL: "reader@example.test", REVIEWBOT_JIRA_API_TOKEN: "fake-token" };
  assert.equal(JiraClient.fromEnv(credentials).configured, false);
  assert.equal(JiraClient.fromEnv({ ...credentials, REVIEWBOT_JIRA_PROJECT_KEY: "TEST" }).configured, true);
});

test("missing project key never selects an implicit project or makes network requests", async () => {
  const mock = fake();
  for (const projectKey of [undefined, ""]) {
    const jira = client(mock, { projectKey });
    assert.equal(jira.configured, false);
    await assert.rejects(jira.getMemberIssues("member:one"), UserError);
    await assert.rejects(jira.getIssue("TEST-1"), UserError);
  }
  assert.equal(mock.calls.length, 0);
  assert.equal(client(mock, { projectKey: "TEST" }).configured, true);
  assert.throws(() => client(mock, { projectKey: "invalid-project" }), UserError);
});

test("connection settings enforce HTTPS, credential-free URLs and explicit loopback HTTP only", async () => {
  for (const baseUrl of ["http://jira.example.test", "http://127.0.0.1", "ftp://jira.example.test", "https://user:password@jira.example.test", "https://jira.example.test?secret=1", "https://jira.example.test/#secret"]) {
    assert.throws(() => client(fake(), { baseUrl }), UserError);
  }
  assert.throws(() => client(fake(), { baseUrl: "http://jira.example.test", allowLocalHttp: true }), UserError);
  const mock = fake();
  await client(mock, { baseUrl: "http://127.0.0.1:1234", allowLocalHttp: true }).getIssue("TEST-1");
  assert.ok(mock.calls.every((call) => call.url.hostname === "127.0.0.1"));
  assert.throws(() => client(fake(), { email: "reader\r\nsecret@example.test" }), UserError);
  assert.throws(() => client(fake(), { apiToken: 123 }), UserError);
});

test("member search uses enhanced JQL, all pages, selected fields and complete changelog histories", async () => {
  const mock = fake({
    pages: [
      { issues: [issue()], isLast: false, nextPageToken: "page-two" },
      { issues: [issue("TEST-2", { assignee: null, status: { id: "3", name: "Accepted" } })], isLast: true },
    ],
    histories: (key, startAt) => key === "TEST-2" ? { values: [], isLast: true, total: 0 } : startAt === 0
      ? { values: [changelog("101")], total: 2, isLast: false }
      : { values: [changelog("102", [
        { field: "assignee", from: "member:one", to: "member:two", fromString: "private-old-name", toString: "private-new-name" },
        { fieldId: "status", from: "2", to: "3", fromString: "Work", toString: "Shipped" },
        { field: "description", fromString: "ignored-private-body", toString: "ignored-private-body" },
      ])], total: 2, isLast: true },
  });
  const result = await client(mock).getMemberIssues("member:one");
  assert.equal(result.complete, true);
  assert.equal(result.fetchedAt, NOW);
  assert.equal(result.issues.length, 2);
  const searches = mock.calls.filter((call) => call.url.pathname === "/rest/api/3/search/jql");
  assert.equal(searches[0].options.method, "POST");
  assert.equal(searches[0].body.jql, 'project = "TEST" AND (assignee = "member:one" OR assignee WAS "member:one") ORDER BY key ASC');
  assert.equal(searches[1].body.nextPageToken, "page-two");
  assert.deepEqual(searches[0].body.fields, ["summary", "description", "status", "assignee", "updated", "created", "components", SPRINT]);
  assert.equal(result.issues[0].history.length, 3);
  assert.equal(result.issues[0].historyComplete, true);
  assert.equal(result.issues[0].history[2].toCategory, "done");
  assert.deepEqual(result.issues[0].history[1], { at: "2026-10-19T00:00:00.000Z", field: "assignee", from: "member:one", to: "member:two" });
  assert.equal(result.issues[1].status.category, "done");
  assert.equal(result.issues[1].assigneeAccountId, null);
  for (const value of ["private-old-name", "private-new-name", "ignored-private-body", "unused-personal-name", "unused-author", "unused@example.test"]) assert.equal(JSON.stringify(result).includes(value), false);
  assert.ok(mock.calls.every((call) => call.options.redirect === "error" && call.options.signal instanceof AbortSignal));
});

test("current status categories use metadata rather than translated or misleading names", async () => {
  const mock = fake({ issues: { "TEST-1": issue("TEST-1", { status: { id: "1", name: "Done" } }) } });
  const one = await client(mock).getIssue("TEST-1");
  assert.deepEqual(one.status, { id: "1", name: "Done", category: "new" });
  assert.equal(one.url, "https://jira.example.test/browse/TEST-1");
  assert.deepEqual(one.components, ["Backend"]);
  const invalid = fake({ statuses: [], issues: { "TEST-1": issue("TEST-1", { status: { id: "99", name: "Done" } }) } });
  await assert.rejects(client(invalid).getIssue("TEST-1"), UserError);
});

test("unknown historical status categories remain unknown without inventing intent", async () => {
  const mock = fake({ histories: () => ({ total: 1, isLast: true, values: [changelog("100", [{ field: "status", from: null, to: "removed-status", toString: "Done" }])] }) });
  const one = await client(mock).getIssue("TEST-1");
  assert.equal(one.historyComplete, true);
  assert.equal(one.history[0].toName, "Done");
  assert.equal(Object.hasOwn(one.history[0], "toCategory"), false);
});

test("project statuses without category fetch fixed-path details and enrich completion histories", async () => {
  const statuses = [{ statuses: STATUSES[0].statuses.map(({ id, name }) => ({ id, name, self: "https://unrelated.example.test/secret" })) }];
  const mock = fake({ statuses, histories: () => ({ total: 1, isLast: true, values: [changelog("101", [{ field: "status", from: "2", to: "3" }])] }) });
  const result = await client(mock).getIssue("TEST-1");
  assert.equal(result.history[0].toCategory, "done");
  assert.equal(mock.calls.filter((call) => /^\/rest\/api\/3\/status\//.test(call.url.pathname)).length, 3);
  assert.ok(mock.calls.every((call) => call.url.origin === "https://jira.example.test"));
});

test("unavailable historical status metadata stays unknown and authentication failures stop refresh", async () => {
  const statuses = [{ statuses: [{ id: "3", name: "Unverified" }] }];
  const mock = fake({ statuses, histories: () => ({ total: 1, isLast: true, values: [changelog("101", [{ field: "status", from: "2", to: "3" }])] }),
    intercept: (url) => url.pathname === "/rest/api/3/status/3" ? response({}, 404) : undefined });
  const one = await client(mock).getIssue("TEST-1");
  assert.equal(one.history[0].toCategory, undefined);
  const expired = fake({ statuses, intercept: (url) => url.pathname === "/rest/api/3/status/3" ? response({}, 401) : undefined });
  await assert.rejects(client(expired).getIssue("TEST-1"), UserError);
});

test("ADF is converted to bounded text without following cards, attachments or response URLs", async () => {
  const adf = { version: 1, type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "Purpose: validate inputs", marks: [{ type: "link", attrs: { href: "https://company.example.test/private" } }] }] },
    { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Reject missing fields" }, { type: "hardBreak" }, { type: "text", text: "Verify failures" }] }] }] },
    { type: "inlineCard", attrs: { url: "https://company.example.test/original-material" } },
    { type: "mediaSingle", content: [{ type: "media", attrs: { id: "private-file-id" } }] },
  ] };
  const mock = fake({ issues: { "TEST-1": issue("TEST-1", { description: adf, attachment: [{ content: "https://company.example.test/file" }] }) } });
  const one = await client(mock).getIssue("TEST-1");
  assert.equal(one.description, "Purpose: validate inputs\nReject missing fields\nVerify failures");
  assert.equal(one.descriptionTruncated, true);
  assert.equal(one.description.includes("company.example.test"), false);
  assert.ok(mock.calls.every((call) => call.url.origin === "https://jira.example.test"));
  assert.ok(mock.calls.every((call) => !/comment|attachment|original-material/.test(call.url.pathname)));
  const issueCall = mock.calls.find((call) => call.url.pathname === "/rest/api/3/issue/TEST-1");
  assert.equal(issueCall.url.searchParams.get("expand"), null);
  assert.equal(issueCall.url.searchParams.get("fields").includes("attachment"), false);
});

test("description truncation and missing description are reported explicitly", async () => {
  const long = await client(fake({ issues: { "TEST-1": issue("TEST-1", { description: "x".repeat(16_001) }) } })).getIssue("TEST-1");
  assert.equal(long.description.length, 16_000);
  assert.equal(long.descriptionTruncated, true);
  const missing = issue();
  delete missing.fields.description;
  assert.equal((await client(fake({ issues: { "TEST-1": missing } })).getIssue("TEST-1")).descriptionTruncated, true);
  const plain = await client().getIssue("TEST-1");
  assert.equal(plain.description, "");
  assert.equal(plain.descriptionTruncated, false);
});

test("Sprint fields are discovered by schema and only typed state metadata determines active membership", async () => {
  for (const [value, expected] of [[[{ state: "ACTIVE" }], true], [[{ state: "closed" }, { state: "future" }], false], [[], false], [null, false], [undefined, null], [["legacy Sprint state=ACTIVE"], null], [[{ name: "active" }], null]]) {
    const result = await client(fake({ issues: { "TEST-1": issue("TEST-1", { [SPRINT]: value }) } })).getIssue("TEST-1");
    assert.equal(result.inCurrentSprint, expected);
  }
  const missing = fake({ fields: [{ id: "customfield_20000", name: "Sprint", schema: { custom: "unrelated-field" } }] });
  assert.equal((await client(missing).getIssue("TEST-1")).inCurrentSprint, null);
});

test("JQL and issue scope validation prevents account injection and cross-project fetches", async () => {
  const mock = fake();
  const jira = client(mock);
  assert.throws(() => client(mock, { projectKey: 'TEST" OR project = "OTHER' }), UserError);
  for (const id of ['member" OR project = "OTHER', "member\\escaped", "member\nnewline", "", 123]) await assert.rejects(jira.getMemberIssues(id), UserError);
  for (const key of ["OTHER-1", "TEST-1/attachment", "TEST-0", "TEST-1?fields=comment", undefined]) await assert.rejects(jira.getIssue(key), UserError);
  assert.equal(mock.calls.length, 0);
});

test("search rejects missing terminal markers, repeated cursors, duplicate issues and contradictory terminal data", async () => {
  const scenarios = [
    [{ issues: [], isLast: false }],
    [{ issues: [] }],
    [{ issues: [], isLast: false, nextPageToken: "same" }, { issues: [], isLast: false, nextPageToken: "same" }],
    [{ issues: [issue()], isLast: false, nextPageToken: "next" }, { issues: [issue()], isLast: true }],
    [{ issues: [], isLast: true, nextPageToken: "more" }],
  ];
  for (const pages of scenarios) await assert.rejects(client(fake({ pages })).getMemberIssues("member:one"), UserError);
});

test("changelog refuses incomplete, repeated and misaligned pages", async () => {
  for (const histories of [
    () => ({ values: [], total: 2, isLast: false }),
    () => ({ values: [changelog()], total: 2, isLast: true }),
    () => ({ values: [changelog()], total: 2, isLast: false }),
    () => ({ startAt: 99, values: [], total: 0, isLast: true }),
  ]) await assert.rejects(client(fake({ histories })).getIssue("TEST-1"), UserError);
});

test("a failed later history page never returns a partially complete member result", async () => {
  const mock = fake({
    pages: [{ issues: [issue(), issue("TEST-2")], isLast: true }],
    intercept: (url) => url.pathname === "/rest/api/3/issue/TEST-2/changelog" ? response({ errors: ["private-error"] }, 403) : undefined,
  });
  await assert.rejects(client(mock).getMemberIssues("member:one"), (error) => error instanceof UserError && !error.message.includes("private-error"));
});

test("HTTP, network and malformed response errors never echo credentials or response bodies", async () => {
  const sensitive = "private-email@example.test private-token private-body";
  for (const intercept of [
    () => response({ errorMessages: [sensitive] }, 401),
    () => { throw new Error(sensitive); },
    () => new Response(sensitive, { headers: { "content-type": "text/plain" } }),
  ]) {
    await assert.rejects(client(fake({ intercept })).getIssue("TEST-1"), (error) => error instanceof UserError && !error.message.includes("private-"));
  }
});

test("response sizes are bounded before parsing both declared and streamed bodies", async () => {
  for (const intercept of [
    () => new Response("{}", { headers: { "content-length": String(3 * 1024 * 1024) } }),
    () => new Response("x".repeat(2 * 1024 * 1024 + 1)),
  ]) await assert.rejects(client(fake({ intercept })).getIssue("TEST-1"), (error) => error instanceof UserError && error.message.includes("safety limit"));
});

test("page and issue safety limits fail explicitly without complete=true", async () => {
  const endless = fake({ intercept: (url, options, body, calls) => url.pathname === "/rest/api/3/search/jql"
    ? response({ issues: [], isLast: false, nextPageToken: `cursor-${calls.length}` }) : undefined });
  await assert.rejects(client(endless).getMemberIssues("member:one"), (error) => error instanceof UserError && error.message.includes("page limit"));
  const oversized = fake({ pages: [{ issues: Array.from({ length: 501 }, (_, i) => issue(`TEST-${i + 1}`)), isLast: true }] });
  await assert.rejects(client(oversized).getMemberIssues("member:one"), (error) => error instanceof UserError && error.message.includes("issue limit"));
});

test("batch issue lookup validates all keys first, deduplicates and shares metadata only within the call", async () => {
  const mock = fake();
  const jira = client(mock);
  await assert.rejects(jira.getIssues(["TEST-1", "OTHER-1"]), UserError);
  assert.equal(mock.calls.length, 0);
  const result = await jira.getIssues(["TEST-2", "TEST-1", "TEST-2"]);
  assert.deepEqual(result.map((one) => one.key), ["TEST-2", "TEST-1"]);
  assert.equal(mock.calls.filter((call) => call.url.pathname === "/rest/api/3/field").length, 1);
  await jira.getIssue("TEST-1");
  assert.equal(mock.calls.filter((call) => call.url.pathname === "/rest/api/3/field").length, 2);
  assert.deepEqual(await new JiraClient().getIssues([]), []);
});

test("invalid issue, timestamp, ADF and workflow metadata fail closed", async () => {
  for (const raw of [
    issue("OTHER-1"), issue("TEST-2"), issue("TEST-1", { created: "2026-02-30T09:00:00Z" }),
    issue("TEST-1", { updated: "not-a-date" }), issue("TEST-1", { assignee: undefined }),
    issue("TEST-1", { description: { type: "doc", version: 1, content: {} } }),
    issue("TEST-1", { status: { id: "1", name: "Done", statusCategory: { key: "unknown" } } }),
  ]) await assert.rejects(client(fake({ issues: { "TEST-1": raw } })).getIssue("TEST-1"), UserError);
  const statuses = [{ statuses: [STATUSES[0].statuses[0], { id: "1", statusCategory: { key: "done" } }] }];
  await assert.rejects(client(fake({ statuses })).getIssue("TEST-1"), UserError);
});

test("client objects keep credentials private", () => {
  const jira = client();
  assert.equal(JSON.stringify(jira), "{}");
  assert.equal(Object.keys(jira).length, 0);
});
