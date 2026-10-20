import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { HOLD_CATEGORIES, citedLocations, cmdPost, cmdPrepare, cmdRecord, collectAuthorNotes, gateDecision, missingSections, mmQuestions, parseMrUrl, reviewContextProblems, sessionTitleFor, syncMrWorktree, usedHoldCategories, verdictProblems } from "../bin/mr-review.mjs";

const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });
const at = (step, extra = {}) => () => ({ step, iid: 71, project: "group/repo", verdict: "hold", body: "본문", ...extra });
const none = () => null;

const contextState = (memberCount = 6) => {
  const headSha = "a".repeat(40);
  const contextVersion = "f".repeat(64);
  return {
    step: "prepared", contextRequired: true, headSha, contextVersion,
    host: "gitlab.example.com", project: "group/repo", iid: 71,
    mrUrl: "https://gitlab.example.com/group/repo/-/merge_requests/71",
    context: {
      status: "fresh", headSha, contextVersion,
      relatedIssues: [{ key: "TEAM-12" }],
      perspectives: Array.from({ length: memberCount }, (_, i) => ({ memberId: `member-${i}`, displayName: `개발자 ${i}`, areas: ["src/api"], changedPaths: ["src/api/auth.js"] })),
    },
  };
};

test("신규 리뷰 기록에는 최신 팀 맥락과 작업 근거를 요구한다", () => {
  const state = contextState();
  assert.match(reviewContextProblems(state, "## 리뷰 결과: 승인").join(), /작업 맥락/);
  assert.match(reviewContextProblems(state, "### 작업 맥락\n모두 확인함").join(), /Jira 키/);
  assert.deepEqual(reviewContextProblems(state, "### 작업 맥락\nTEAM-12의 API 계약을 호출부와 대조함"), []);
  assert.deepEqual(reviewContextProblems(state, "### 작업 맥락\nsrc/api 영역과 분리되어 영향이 없음: 이벤트 입력을 사용하지 않음"), []);
  assert.match(reviewContextProblems({ ...state, contextVersion: "0".repeat(64) }).join(), /최신 팀 작업 맥락/);
  assert.match(reviewContextProblems({ ...state, context: { ...state.context, perspectives: [] } }).join(), /최신 팀 작업 맥락/);
  assert.deepEqual(reviewContextProblems({ step: "prepared" }, "예전 수동 리뷰"), [], "진행 중이던 구버전 수동 상태 호환");
});

test("등록한 팀 규모가 1명이나 7명 이상이어도 전원의 관점이 있으면 리뷰할 수 있다", () => {
  for (const count of [1, 7, 12]) {
    const state = contextState(count);
    state.context.teamMemberIds = state.context.perspectives.map((person) => person.memberId).reverse();
    state.context.author = { memberId: "member-0" };
    assert.deepEqual(reviewContextProblems(state, "### 작업 맥락\nTEAM-12 요구사항을 호출부와 대조함"), []);
  }
});

test("빈 팀·중복 관점·등록 팀원 누락·등록되지 않은 작성자는 거부한다", () => {
  const invalid = (change) => {
    const state = contextState(7);
    state.context.teamMemberIds = state.context.perspectives.map((person) => person.memberId);
    state.context.author = { memberId: "member-0" };
    change(state.context);
    assert.match(reviewContextProblems(state).join(), /최신 팀 작업 맥락/);
  };
  invalid((context) => { context.perspectives = []; context.teamMemberIds = []; });
  invalid((context) => { context.perspectives[1].memberId = "member-0"; });
  invalid((context) => { context.perspectives[1].memberId = ""; });
  invalid((context) => { context.perspectives[1] = null; });
  invalid((context) => { context.perspectives.pop(); });
  invalid((context) => { context.teamMemberIds.pop(); });
  invalid((context) => { context.teamMemberIds[1] = "member-0"; });
  invalid((context) => { context.teamMemberIds[1] = "unregistered"; });
  invalid((context) => { context.teamMemberIds = []; });
  invalid((context) => { context.teamMemberIds = null; });
  invalid((context) => { context.author.memberId = "unregistered"; });
  invalid((context) => { delete context.author; });
});

test("이전 리뷰 상태는 팀원 목록 필드 없이도 고유한 관점과 유효한 작성자가 있으면 호환된다", () => {
  for (const count of [1, 6, 8]) {
    const state = contextState(count);
    assert.deepEqual(reviewContextProblems(state), []);
    state.context.author = { memberId: "member-0" };
    assert.deepEqual(reviewContextProblems(state), []);
    state.context.author.memberId = "unregistered";
    assert.match(reviewContextProblems(state).join(), /최신 팀 작업 맥락/);
    delete state.context.author;
    state.context.perspectives[0].memberId = undefined;
    assert.match(reviewContextProblems(state).join(), /최신 팀 작업 맥락/);
  }
  assert.match(reviewContextProblems(contextState(0)).join(), /최신 팀 작업 맥락/);
  const duplicate = contextState(6);
  duplicate.context.perspectives[1].memberId = "member-0";
  assert.match(reviewContextProblems(duplicate).join(), /최신 팀 작업 맥락/);
});

test("record의 작업 근거 검사와 post의 최신 커밋 검사가 실제 흐름에서 적용된다", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "mmp-context-harness-"));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git("init", "-b", "main");
    const stateFile = join(cwd, ".git", "mmp-mr-review.json");
    writeFileSync(stateFile, JSON.stringify(contextState()));
    const bodyFile = join(cwd, "review.md");
    writeFileSync(bodyFile, "## 리뷰 결과: 승인\n### 확인한 범위\nsrc/api/auth.js");
    assert.throws(() => cmdRecord("approve", bodyFile, { cwd }), /작업 맥락/);
    assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).step, "prepared");
    writeFileSync(bodyFile, "## 리뷰 결과: 승인\n### 확인한 범위\nsrc/api/auth.js\n### 작업 맥락\nTEAM-12의 요구사항을 확인함");
    assert.equal(cmdRecord("approve", bodyFile, { cwd }).step, "reviewed");
    let posted = 0;
    await assert.rejects(cmdPost({ confirmed: true }, { cwd, runImpl: (_file, args) => {
      if (args[0] === "api") return JSON.stringify({ sha: "b".repeat(40) });
      posted += 1;
      return "";
    } }), /새 커밋/);
    assert.equal(posted, 0);
    assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).step, "reviewed");
    const result = await cmdPost({ confirmed: true }, { cwd, runImpl: (_file, args) => {
      if (args[0] === "api") return JSON.stringify({ sha: "a".repeat(40) });
      posted += 1;
      assert.equal(args[args.indexOf("--repo") + 1], "gitlab.example.com/group/repo");
      return "created";
    } });
    assert.equal(result.step, "posted");
    assert.equal(posted, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("prepare는 실제 워크트리와 최신 팀 맥락을 연결하고 갱신 실패 시 이전 상태 사용을 막는다", async () => {
  const root = mkdtempSync(join(tmpdir(), "mmp-context-prepare-"));
  const git = (cwd, ...args) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    const origin = join(root, "origin.git");
    const author = join(root, "author");
    const clone = join(root, "clone");
    git(root, "init", "--bare", "-b", "main", origin);
    git(root, "clone", origin, author);
    writeFileSync(join(author, "auth.js"), "export const v = 1;\n");
    git(author, "add", "-A");
    git(author, "commit", "-m", "base");
    git(author, "push", "origin", "main");
    git(author, "checkout", "-b", "feat/TEAM-12-auth");
    writeFileSync(join(author, "auth.js"), "export const v = 2;\n");
    git(author, "commit", "-am", "auth");
    git(author, "push", "origin", "feat/TEAM-12-auth");
    git(root, "clone", origin, clone);
    const headSha = git(author, "rev-parse", "HEAD");
    const state = contextState();
    const metadata = {
      state: "opened", sha: headSha, author: { id: 1, username: "dev.one", name: "개발자 0" },
      title: "TEAM-12 auth", description: "auth 변경", source_branch: "feat/TEAM-12-auth", target_branch: "main",
    };
    const dependencies = {
      cwd: clone,
      tryRunImpl: () => "Logged in to gitlab.example.com",
      runImpl: (file, args, options) => {
        if (file === "git") {
          if (args[0] === "remote" && args[1] === "get-url") return "https://gitlab.example.com/group/repo.git";
          return execFileSync(file, args, { ...options, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
        }
        if (args[0] === "api" && args[1].includes("/diffs?")) return JSON.stringify([{ old_path: "auth.js", new_path: "auth.js" }]);
        return JSON.stringify(metadata);
      },
      contextService: { prepareReview: async (input) => {
        assert.deepEqual(input.issueKeys, ["TEAM-12"]);
        assert.deepEqual(input.changedPaths, ["auth.js"]);
        assert.deepEqual(input.author, { username: "dev.one", id: 1 });
        return { ...state.context, mrUrl: input.mrUrl, headSha: input.headSha };
      } },
      mattermostService: async () => ({ listChannels: () => [], listParticipants: () => [], listConventions: () => [], close() {} }),
    };
    const result = await cmdPrepare(state.mrUrl, { "worktree-root": join(root, "worktrees") }, dependencies);
    assert.equal(result.step, "prepared");
    assert.equal(result.contextRequired, true);
    assert.equal(result.headSha, headSha);
    assert.equal(result.contextVersion, state.contextVersion);
    assert.equal(git(result.worktreePath, "rev-parse", "HEAD"), headSha);
    assert.equal(git(clone, "rev-parse", "--abbrev-ref", "HEAD"), "main");
    await assert.rejects(cmdPrepare(state.mrUrl, { "worktree-root": join(root, "worktrees") }, {
      ...dependencies, contextService: { prepareReview: async () => { throw new Error("Jira refresh failed"); } },
    }), /Jira refresh failed/);
    const stateFile = join(git(result.worktreePath, "rev-parse", "--absolute-git-dir"), "mmp-mr-review.json");
    const failed = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(failed.step, "preparing");
    assert.equal(failed.context, null);
    assert.match(reviewContextProblems(failed).join(), /최신/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MR 링크에서 프로젝트와 번호를 뽑는다", () => {
  assert.deepEqual(parseMrUrl("https://gitlab.example.com/group/repo/-/merge_requests/71"), {
    host: "gitlab.example.com", project: "group/repo", iid: 71,
  });
  assert.equal(parseMrUrl("https://gitlab.example.com/group/sub/repo/-/merge_requests/8/").project, "group/sub/repo");
});

test("MR 링크가 아니면 거부한다", () => {
  for (const bad of ["!71", "71", "", "https://gitlab.example.com/group/repo/-/issues/71", "https://gitlab.example.com/group/repo"]) {
    assert.throws(() => parseMrUrl(bad), /MR 링크/);
  }
});

test("세션 제목은 '<작성자 이름>) !<번호> 리뷰' 형식이다", () => {
  assert.equal(sessionTitleFor({ authorName: "박영희", iid: 173 }), "박영희) !173 리뷰");
  assert.equal(sessionTitleFor({ authorName: "이영수", iid: 172 }), "이영수) !172 리뷰");
  // author.name이 비어 있어도 제목이 깨지지 않는다
  assert.equal(sessionTitleFor({ authorName: null, iid: 9 }), "작성자 불명) !9 리뷰");
});

// MM 선택은 리뷰 시작 전이 아니라 게시 승인 때 한 번에 묻는다.
test("Mattermost 질문은 필요한 것만 모아 게시 시점용으로 낸다", () => {
  const ready = mmQuestions({ authorGitlab: "youngsoo.lee", mention: "@lee", channels: ["팀채널"], hasConvention: true });
  assert.deepEqual(ready, [], "다 갖춰져 있으면 물을 게 없다");

  const ids = (args) => mmQuestions(args).map((q) => q.id);
  assert.deepEqual(ids({ authorGitlab: "youngsoo.lee", mention: null, channels: ["a", "b"], hasConvention: true }),
    ["mm_participant", "mm_channel_pick"]);
  assert.deepEqual(ids({ authorGitlab: "youngsoo.lee", mention: "@x", channels: [], hasConvention: false }),
    ["mm_convention", "mm_channel"]);

  // 채널이 여러 개면 선택지를 같이 준다
  const pick = mmQuestions({ mention: "@x", channels: ["팀채널", "나에게"], hasConvention: true })[0];
  assert.deepEqual(pick.options, ["팀채널", "나에게"]);

  // 설정을 아예 못 읽으면 나머지를 물을 근거가 없다
  assert.deepEqual(ids({ storageError: "db locked", mention: null, channels: [] }), ["mm_storage"]);
});

test("보류 본문은 네 섹션이 모두 있어야 통과한다", () => {
  const partial = "## 리뷰 결과: 보류\n### 왜 보류인가\n터집니다.";
  assert.deepEqual(missingSections("hold", partial), ["### 수정이 필요한 부분", "### 확인한 범위"]);

  const full = `## 리뷰 결과: 보류
### 왜 보류인가
빈 배열에서 터집니다.
### 수정이 필요한 부분
1. \`src/a.js:42\` — 길이 검사가 없습니다.
### 확인한 범위
src/a.js`;
  assert.deepEqual(missingSections("hold", full), []);
});

// "병합 후에 고쳐도 되는가"로 갈린다. 분류 안 되는 지적은 병합을 막을 수 없다.
test("보류는 사유 카테고리가 붙어야 성립한다", () => {
  const docOnly = `## 리뷰 결과: 보류
### 왜 보류인가
README 오타가 있습니다.
### 수정이 필요한 부분
1. \`docs/README.md:3\` — 오타
### 확인한 범위
docs/README.md`;
  assert.deepEqual(usedHoldCategories(docOnly), [], "문서 오타만으로는 보류 카테고리가 안 붙는다");

  const real = docOnly.replace("1. `docs/README.md:3` — 오타", "1. `[정확성]` `src/a.js:42` — 빈 배열에서 터짐");
  assert.deepEqual(usedHoldCategories(real), ["[정확성]"]);

  const many = "`[안전]` 인가 누락 / `[데이터]` 마이그레이션 비가역";
  assert.deepEqual(usedHoldCategories(many), ["[안전]", "[데이터]"]);

  // 카테고리 목록 자체가 흔들리면 스킬 문서와 어긋난다
  assert.deepEqual(HOLD_CATEGORIES, ["[정확성]", "[안전]", "[데이터]", "[계약]", "[구현]"]);
});

// 위치를 못 대는 보류는 확인이 아니라 추측이다.
test("보류 항목은 실제 코드 위치를 인용해야 한다", () => {
  assert.deepEqual(citedLocations("`src/auth/session.js:42` 에서 터집니다"), ["src/auth/session.js:42"]);
  assert.deepEqual(citedLocations("`package.json` 의존성 누락"), ["package.json"]);
  assert.deepEqual(citedLocations("여러 곳: `a/b.ts:9` 와 `c.py`"), ["a/b.ts:9", "c.py"]);

  // 위치 없는 일반론은 인용으로 치지 않는다
  assert.deepEqual(citedLocations("빈 배열에서 터질 수 있습니다"), []);
  assert.deepEqual(citedLocations("`npm test` 를 돌려보세요"), [], "명령어는 코드 위치가 아니다");
});

test("승인 본문은 결과와 확인 범위만 요구한다", () => {
  assert.deepEqual(missingSections("approve", "## 리뷰 결과: 승인\n### 확인한 범위\nsrc/a.js"), []);
  assert.deepEqual(missingSections("approve", "## 리뷰 결과: 승인"), ["### 확인한 범위"]);
  assert.throws(() => missingSections("maybe", "x"), /approve 또는 hold/);
});

test("승인과 머지는 상태와 무관하게 막는다", () => {
  for (const command of ["glab mr approve 71", "glab mr merge 71 -R group/repo"]) {
    for (const state of [none, at("prepared"), at("notified")]) {
      assert.equal(gateDecision(bash(command), state)?.permissionDecision, "deny", command);
    }
  }
  // 복합 명령으로 우회하지 못한다
  assert.equal(gateDecision(bash("cd /repo && glab mr approve 71"), none)?.permissionDecision, "deny");
});

// 게이트의 목적은 "리뷰 세션이 하네스를 우회하지 못하게"다. 리뷰 중이 아니면 우회할 하네스가 없다.
// 작성자가 자기 MR에 리뷰 요청 댓글을 다는 것까지 막으면 그건 오탐이고, 실제로 사용자를 막았다.
test("직접 코멘트는 리뷰가 진행 중일 때만 막는다", () => {
  const comments = [
    "glab mr note create 71 -m hi",
    "glab mr note 71 -m hi", // 서브커맨드 없는 기본형도 코멘트를 만든다
    "glab mr note delete 5 71",
  ];
  for (const command of comments) {
    assert.equal(gateDecision(bash(command), at("prepared"))?.permissionDecision, "deny", command);
    assert.equal(gateDecision(bash(command), none), null, `리뷰 중이 아니면 통과: ${command}`);
  }
  // 막을 때는 빠져나갈 길을 알려준다
  assert.match(gateDecision(bash(comments[0]), at("reviewed")).permissionDecisionReason, /reset/);
  // 읽기 전용 조회는 리뷰 중에도 막지 않는다
  assert.equal(gateDecision(bash("glab mr note list 71 -R group/repo -F json"), at("prepared")), null);
});

// 앵커가 없으면 문서를 쓰거나 예시를 출력하는 명령까지 막혀 실사용을 방해한다.
test("명령이 아니라 문자열로 언급된 것은 막지 않는다", () => {
  for (const command of [
    `echo "glab mr approve 71 은 차단됩니다"`,
    `node -e 'console.log("glab mr note create 9")'`,
    `grep -n 'glab mr merge' README.md`,
    `echo "node bin/mr-review.mjs post 로 게시합니다"`,
    `node -e 'console.log("mr-review.mjs post")'`,
  ]) {
    assert.equal(gateDecision(bash(command), at("reviewed")), null, command);
  }
  // 앵커를 넣어도 실제 호출은 여전히 잡힌다
  assert.equal(gateDecision(bash("glab mr approve 71"), none).permissionDecision, "deny");
  assert.equal(gateDecision(bash("cd /repo && glab mr approve 71"), none).permissionDecision, "deny");
  assert.equal(gateDecision(bash("echo start; glab mr note create 9 -m hi"), at("prepared")).permissionDecision, "deny");
});

test("게이트는 순서를 강제한다", () => {
  const post = bash('node "/plugins/mmp/bin/mr-review.mjs" post');
  const confirmed = bash('node "/plugins/mmp/bin/mr-review.mjs" post --confirmed');
  assert.match(gateDecision(post, none).permissionDecisionReason, /prepare/);
  assert.match(gateDecision(post, at("prepared")).permissionDecisionReason, /record/);
  assert.equal(gateDecision(confirmed, at("reviewed")).permissionDecision, "allow");
  assert.equal(gateDecision(confirmed, at("posted")).permissionDecision, "deny", "중복 게시는 막는다");

  const notify = bash("node bin/mr-review.mjs notify --channel team");
  assert.equal(gateDecision(notify, at("reviewed")).permissionDecision, "deny");
  assert.equal(gateDecision(notify, at("posted")).permissionDecision, "allow", "게시 후 DM은 묻지 않고 통과한다");
});

// 권한 프롬프트(ask)는 auto 모드에서 사람에게 닿지 않을 수 있다.
// 그래서 승인 증거가 없으면 ask가 아니라 deny — deny는 세션 모드와 무관하게 확정적이다.
test("사용자 승인 없이 게시하려 하면 확정적으로 deny한다", () => {
  const withoutConfirm = gateDecision(bash("node bin/mr-review.mjs post"), at("reviewed"), () => "on");
  assert.equal(withoutConfirm.permissionDecision, "deny");
  assert.match(withoutConfirm.permissionDecisionReason, /AskUserQuestion/);
});

// bypass 동안은 사용자가 "전부 무승인"을 명시적으로 켠 상태다. 게이트가 막지 않는다.
test("auto-review bypass면 승인 없이도 게시를 통과시킨다", () => {
  const post = bash("node bin/mr-review.mjs post");
  assert.equal(gateDecision(post, at("reviewed"), () => "bypass").permissionDecision, "allow");
  // 순서 위반은 bypass여도 그대로 막는다 — 승인 면제이지 검증 면제가 아니다
  assert.equal(gateDecision(post, at("prepared"), () => "bypass").permissionDecision, "deny");
  assert.equal(gateDecision(post, at("posted"), () => "bypass").permissionDecision, "deny");
});

// 확인은 AskUserQuestion 한 번으로 끝난다. 승인 직후 권한 프롬프트를 또 띄우지 않는다.
test("검증을 통과한 하네스 단계는 자동 승인한다", () => {
  const allowed = (command, state) => gateDecision(bash(`node /p/mr-review.mjs ${command}`), state)?.permissionDecision;
  assert.equal(allowed("post --confirmed", at("reviewed")), "allow");
  assert.equal(allowed("notify --channel team", at("posted")), "allow");
  assert.equal(allowed("prepare https://gitlab.example.com/g/r/-/merge_requests/1", none), "allow", "prepare는 상태 없이도 통과");
  assert.equal(allowed("record hold body.md", at("prepared")), "allow");
  assert.equal(allowed("status", none), "allow");

  // 자동 승인은 우리 하네스라고 확신할 때만. 별칭 경로는 거부만 하고 승인하지 않는다.
  assert.equal(gateDecision(bash('node "$HARNESS" post --confirmed'), at("reviewed")), null);
});

test("셸 변수로 우회해도 리뷰 진행 중이면 게이트가 잡는다", () => {
  const aliased = bash('node "$HARNESS" post --confirmed');
  assert.equal(gateDecision(aliased, at("prepared")).permissionDecision, "deny", "별칭으로도 순서 위반은 잡는다");
  assert.equal(gateDecision(aliased, at("reviewed")), null, "확신 없는 경로는 자동 승인하지 않는다");
  assert.equal(gateDecision(aliased, none), null, "리뷰 중이 아니면 무관한 node 명령에 간섭하지 않는다");
});

test("게이트는 워크플로 밖의 호출에 간섭하지 않는다", () => {
  assert.equal(gateDecision(bash("npm test"), at("prepared")), null);
  assert.equal(gateDecision(bash("glab mr list -R group/repo"), at("prepared")), null);
  assert.equal(gateDecision({ tool_name: "Read", tool_input: { file_path: "a.js" } }, at("reviewed")), null);
  assert.equal(gateDecision({}, none), null);
});

test("게시자 댓글만 시간순으로 모은다", () => {
  const discussions = [
    { notes: [{ author: { username: "gildong" }, created_at: "2026-09-02T00:00:00Z", body: "두번째" }] },
    { notes: [
      { author: { username: "reviewer" }, created_at: "2026-09-03T00:00:00Z", body: "남의 댓글" },
      { author: { username: "gildong" }, created_at: "2026-09-01T00:00:00Z", body: "첫번째" },
      { author: { username: "gildong" }, created_at: "2026-09-04T00:00:00Z", body: "시스템", system: true },
    ] },
  ];
  assert.deepEqual(collectAuthorNotes(discussions, "gildong").map((note) => note.body), ["첫번째", "두번째"]);
  assert.deepEqual(collectAuthorNotes(discussions, null), []);
  assert.deepEqual(collectAuthorNotes(null, "gildong"), []);
});

// 회귀: `glab mr view --comments -F json`은 배열이 아니라 MR 객체를 주고, 댓글은 대문자 Discussions에 있다.
// 배열만 받던 이전 구현은 여기서 항상 []를 돌려줘 "게시자 댓글 없음"으로 잘못 보고했다.
test("MR 객체의 Discussions에서 게시자 댓글을 찾는다", () => {
  const mr = {
    author: { username: "youngsoo.lee", name: "이영수" },
    user_notes_count: 5,
    Discussions: [
      { id: "d1", individual_note: true, notes: [
        { author: { username: "youngsoo.lee" }, system: true, created_at: "2026-09-01T00:00:00Z", body: "assigned to @x" },
      ] },
      { id: "d2", notes: [
        { author: { username: "chulsoo.kim" }, system: false, created_at: "2026-09-02T00:00:00Z", body: "리뷰어 지적" },
      ] },
      { id: "d3", notes: [
        { author: { username: "youngsoo.lee" }, system: false, created_at: "2026-09-04T00:00:00Z", body: "게시자 최신 답변" },
        { author: { username: "youngsoo.lee" }, system: false, created_at: "2026-09-03T00:00:00Z", body: "게시자 먼저 쓴 말" },
      ] },
    ],
  };
  assert.deepEqual(
    collectAuthorNotes(mr, "youngsoo.lee").map((note) => note.body),
    ["게시자 먼저 쓴 말", "게시자 최신 답변"],
    "시스템 노트와 남의 댓글은 빼고, 게시자 댓글만 시간순으로",
  );
  assert.equal(collectAuthorNotes(mr, "chulsoo.kim").length, 1);
  assert.deepEqual(collectAuthorNotes({ author: { username: "youngsoo.lee" } }, "youngsoo.lee"), [], "Discussions가 없으면 빈 배열");
});

test("MR의 원격 브랜치를 워크트리로 가져오고 현재 작업 트리는 건드리지 않는다", () => {
  const root = mkdtempSync(join(tmpdir(), "mmp-worktree-"));
  const git = (cwd, ...args) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    const origin = join(root, "origin.git");
    const author = join(root, "author");
    const clone = join(root, "clone");
    const worktreeRoot = join(root, "wt");

    git(root, "init", "--bare", "-b", "main", origin);
    git(root, "clone", origin, author);
    writeFileSync(join(author, "a.txt"), "base\n");
    git(author, "add", "-A");
    git(author, "commit", "-m", "base");
    git(author, "push", "-u", "origin", "main");
    git(author, "checkout", "-b", "feat/login");
    writeFileSync(join(author, "a.txt"), "mr work\n");
    git(author, "commit", "-am", "mr work");
    git(author, "push", "-u", "origin", "feat/login");

    git(root, "clone", origin, clone);
    const cloneHeadBefore = git(clone, "rev-parse", "HEAD");

    const first = syncMrWorktree({ cwd: clone, remote: "origin", iid: 172, sourceBranch: "feat/login", worktreeRoot });

    assert.equal(first.createdWorktree, true);
    assert.equal(first.forked, false);
    assert.equal(first.branch, "feat/login", "합성 mr-<iid> 브랜치가 아니라 원격 브랜치를 그대로 써야 한다");
    assert.equal(resolve(first.path), resolve(join(worktreeRoot, "mr-172")));
    assert.equal(readFileSync(join(first.path, "a.txt"), "utf8").trim(), "mr work");
    assert.equal(git(clone, "rev-parse", "HEAD"), cloneHeadBefore, "현재 작업 트리의 HEAD는 그대로여야 한다");
    assert.equal(git(clone, "rev-parse", "--abbrev-ref", "HEAD"), "main", "현재 작업 트리의 브랜치도 그대로여야 한다");

    // 저자가 MR에 커밋을 더 밀면 ff-only로 따라간다.
    writeFileSync(join(author, "a.txt"), "mr work v2\n");
    git(author, "commit", "-am", "more");
    git(author, "push");

    const second = syncMrWorktree({ cwd: clone, remote: "origin", iid: 172, sourceBranch: "feat/login", worktreeRoot });
    assert.equal(second.createdWorktree, false, "이미 있는 워크트리는 재사용한다");
    assert.equal(readFileSync(join(second.path, "a.txt"), "utf8").trim(), "mr work v2");

    // 이미 그 MR 브랜치를 올린 워크트리 안이면 새로 만들지 않고 그 자리를 쓴다.
    const inside = syncMrWorktree({ cwd: first.path, remote: "origin", iid: 172, sourceBranch: "feat/login", worktreeRoot });
    assert.equal(inside.createdWorktree, false);
    assert.equal(inside.reusedInPlace, true);
    assert.equal(resolve(inside.path), resolve(first.path));

    // 가드: 다른 브랜치로 작업 중인 워크트리는 갈아끼우지 않고 전용 워크트리를 따로 만든다.
    const task = join(root, "task-wt");
    git(clone, "worktree", "add", "-b", "claude/other-task", task, "main");
    const guarded = syncMrWorktree({ cwd: task, remote: "origin", iid: 172, sourceBranch: "feat/login", worktreeRoot });

    assert.equal(guarded.reusedInPlace, false, "남의 작업 워크트리를 재사용하면 안 된다");
    assert.notEqual(resolve(guarded.path), resolve(task));
    assert.equal(git(task, "rev-parse", "--abbrev-ref", "HEAD"), "claude/other-task", "그 워크트리의 브랜치는 그대로여야 한다");

    // --here 인데 그 브랜치를 이미 다른 워크트리가 쓰고 있으면, git 원문 대신 대안을 알려주고 멈춘다.
    assert.throws(
      () => syncMrWorktree({ cwd: task, remote: "origin", iid: 172, sourceBranch: "feat/login", worktreeRoot, here: true }),
      /이미 워크트리 .* 가 쓰고 있습니다/,
    );
    assert.equal(git(task, "rev-parse", "--abbrev-ref", "HEAD"), "claude/other-task", "실패해도 브랜치는 그대로");

    // 충돌이 없으면 --here 가 그 자리를 그대로 쓴다.
    git(clone, "worktree", "remove", "--force", first.path);
    const forced = syncMrWorktree({ cwd: task, remote: "origin", iid: 172, sourceBranch: "feat/login", worktreeRoot, here: true });
    assert.equal(forced.reusedInPlace, true);
    assert.equal(resolve(forced.path), resolve(task));
    assert.equal(git(task, "rev-parse", "--abbrev-ref", "HEAD"), "feat/login");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 판정은 확인된 지적으로만 한다. 확인하지 못한 것은 지우지 않고 남기되 제목에 드러낸다.
test("확인하지 못한 지적 수가 제목에 드러나야 한다", () => {
  const body = (heading) => `${heading}\n요약\n### 확인하지 못한 것\n1. [높음] [확인 필요] 테스트 14개를 돌리지 못했습니다\n### 확인한 범위\n- 전부`;
  assert.match(verdictProblems("approve", body("## 리뷰 결과: 승인")).join(), /미확인 1건/, "개수를 숨긴 승인은 거부");
  assert.deepEqual(verdictProblems("approve", body("## 리뷰 결과: 승인 (미확인 1건)")), []);
  assert.match(verdictProblems("approve", body("## 리뷰 결과: 승인 (미확인 2건)")).join(), /미확인 1건/, "개수가 틀려도 거부");

  // 미확인이 없으면 제목에 괄호를 붙이지 않는다
  const clean = "## 리뷰 결과: 승인\n요약\n### 확인한 범위\n- 전부";
  assert.deepEqual(verdictProblems("approve", clean), []);
  assert.match(verdictProblems("approve", clean.replace("승인", "승인 (미확인 0건)")).join(), /이어야 합니다/);
});

test("확인된 [높음] 지적이 있으면 승인할 수 없다", () => {
  const approve = (item) => `## 리뷰 결과: 승인${item.includes("[확인 필요]") ? " (미확인 1건)" : ""}\n요약\n### 고치면 좋을 것\n${item}\n### 확인한 범위\n- 전부`;
  assert.match(verdictProblems("approve", approve("1. [높음] [정확성] `a.py:3` — 빈 배열에서 터짐")).join(), /승인할 수 없습니다/);
  assert.deepEqual(verdictProblems("approve", approve("1. [높음] [확인 필요] `a.py:3` — 동시 호출 시 중복 삽입 가능성")), [],
    "확인하지 못한 [높음]은 막지 않고 제목에만 드러낸다");
  assert.deepEqual(verdictProblems("approve", approve("1. [중간] `a.py:3` — 로그 문구")), [], "중간·낮음은 승인과 함께 갈 수 있다");
});

test("보류는 확인된 사유가 하나는 있어야 한다", () => {
  const hold = (items, count = 0) => [
    `## 리뷰 결과: 보류${count ? ` (미확인 ${count}건)` : ""}`,
    "### 왜 보류인가", "이유",
    "### 수정이 필요한 부분", ...items,
    "### 확인한 범위", "- `[계약]`: 호출부 `b.py` 확인",
  ].join("\n");

  assert.deepEqual(verdictProblems("hold", hold(["1. [높음] [정확성] `a.py:3` — 빈 배열에서 터짐"])), []);
  assert.match(verdictProblems("hold", hold(["1. [높음] [정확성] [확인 필요] `a.py:3` — 아마 터짐"], 1)).join(), /확인된 보류 사유가 없습니다/,
    "추측만으로는 막지 않는다");
  assert.match(verdictProblems("hold", hold(["1. [높음] [정확성] — 위치 없이 터진다고만"])).join(), /확인된 보류 사유가 없습니다/,
    "코드 위치가 같은 줄에 있어야 한다");
  // 확인한 범위에 적힌 카테고리·인용은 보류 사유로 치지 않는다
  assert.match(verdictProblems("hold", hold(["1. 이름이 이상함"])).join(), /확인된 보류 사유가 없습니다/);
});
