#!/usr/bin/env node
// MR 리뷰 하네스. prepare → record → post → notify 순서를 상태 파일로 강제한다.
// 상태 파일은 워크트리별 git 디렉터리에 두므로 워크트리마다 독립이고 커밋되지 않는다.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultChannel, effectiveMode, readState as readAutoState } from "./bypass-review.mjs";
import { canonicalMrUrl, parseGitlabMrUrl, prepareMrContext, readMrHeadSha } from "../src/gitlab-context.js";

// bypass 동안은 사용자 승인 단계를 건너뛴다. 그 외 모드에서는 평소대로 승인을 요구한다.
const autoMode = () => effectiveMode(readAutoState());

const STATE_FILE = "mmp-mr-review.json";
const MAX_AUTHOR_NOTES = 5;
const STEPS = ["prepared", "reviewed", "posted", "notified"];

// 보류 사유를 "구체적으로 풀어서" 쓰게 만드는 구조적 강제. 섹션이 없으면 record가 거부한다.
export const REQUIRED_SECTIONS = {
  hold: ["## 리뷰 결과: 보류", "### 왜 보류인가", "### 수정이 필요한 부분", "### 확인한 범위"],
  approve: ["## 리뷰 결과: 승인", "### 확인한 범위"],
};

// 보류는 "병합 후에 고치면 늦는 것"에만 쓴다. 보류 항목은 아래 중 하나로 분류돼야 한다.
// 문서·오타·네이밍·취향은 이 목록에 없으므로 자연히 승인+안내 쪽으로 밀린다.
export const HOLD_CATEGORIES = ["[정확성]", "[안전]", "[데이터]", "[계약]", "[구현]"];

export function usedHoldCategories(body) {
  return HOLD_CATEGORIES.filter((category) => String(body).includes(category));
}

// 보류 항목은 실제로 읽은 코드를 가리켜야 한다. 위치를 못 대면 확인한 게 아니라 추측이다.
// 백틱으로 감싼 `경로/파일.확장자` 또는 `경로/파일.확장자:줄` 을 인용으로 인정한다.
export function citedLocations(body) {
  return [...String(body).matchAll(/`([^`\n]*\.[A-Za-z0-9]+(?::\d+)?)`/g)].map((match) => match[1]);
}

// 심각도와 미확인 표시. 태그는 지적 항목의 첫 줄에만 붙인다(확인한 범위에는 쓰지 않는다).
export const SEVERE = "[높음]";
export const UNVERIFIED = "[확인 필요]";

// 제목 다음 제목(## 또는 ###)까지의 본문을 돌려준다. 없으면 빈 문자열.
function sectionOf(body, title) {
  const text = String(body);
  const start = text.indexOf(title);
  if (start < 0) return "";
  const rest = text.slice(start + title.length);
  const next = rest.search(/^#{2,3} /m);
  return next < 0 ? rest : rest.slice(0, next);
}

// 판정이 지적과 맞는지 본다. 지적을 지우는 기준(반증)과 판정 기준은 다르다 —
// 확인하지 못한 지적은 지우지 않고 남기되, 판정은 확인된 것으로만 한다.
//  - 확인하지 못한 지적 수를 제목에 드러낸다: "## 리뷰 결과: 승인 (미확인 2건)"
//  - 확인된 [높음]이 있으면 승인할 수 없다
//  - 보류는 확인된 사유(카테고리 태그와 코드 위치가 같은 줄, [확인 필요] 아님)가 하나는 있어야 한다
export function verdictProblems(verdict, body) {
  const lines = String(body).split(/\r?\n/);
  const confirmed = (line) => !line.includes(UNVERIFIED);
  const problems = [];

  const unverified = lines.filter((line) => line.includes(UNVERIFIED)).length;
  const heading = `## 리뷰 결과: ${verdict === "hold" ? "보류" : "승인"}`;
  const expected = unverified ? `${heading} (미확인 ${unverified}건)` : heading;
  const actual = lines.find((line) => line.startsWith(heading))?.trim();
  if (actual !== expected) {
    problems.push(`제목 줄은 \`${expected}\` 이어야 합니다(지금: \`${actual ?? "없음"}\`). `
      + `확인하지 못한 지적이 몇 건인지 제목에서 보이게 합니다. ${UNVERIFIED} 는 지적 항목에만 쓰세요.`);
  }

  if (verdict === "approve") {
    const severe = lines.filter((line) => line.includes(SEVERE) && confirmed(line));
    if (severe.length) {
      problems.push(`확인된 ${SEVERE} 지적이 있으면 승인할 수 없습니다. 보류하거나, 확인하지 못했다면 ${UNVERIFIED} 를 붙이세요:\n`
        + severe.map((line) => `  ${line.trim()}`).join("\n"));
    }
  }

  if (verdict === "hold") {
    const reasons = sectionOf(body, "### 수정이 필요한 부분").split(/\r?\n/).filter((line) => confirmed(line)
      && HOLD_CATEGORIES.some((category) => line.includes(category))
      && citedLocations(line).length > 0);
    if (!reasons.length) {
      problems.push("`### 수정이 필요한 부분` 에 확인된 보류 사유가 없습니다. 보류 항목은 한 줄에 사유 카테고리와 코드 위치를 함께 적고, "
        + `${UNVERIFIED} 가 아니어야 합니다. 확인하지 못한 것으로는 병합을 막지 않습니다 — 확인하거나 승인하세요.`);
    }
  }
  return problems;
}

export class HarnessError extends Error {}

function fail(message) {
  throw new HarnessError(message);
}

function run(file, args, options = {}) {
  return execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options, shell: false }).trim();
}

// 종료 코드와 무관하게 두 스트림을 모두 본다.
// glab auth status는 exit 0으로 끝나면서 결과를 전부 stderr에 쓴다 — stdout만 읽으면 항상 빈 문자열이다.
function tryRun(file, args, options = {}) {
  const result = spawnSync(file, args, { encoding: "utf8", ...options });
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
}

// https://host/group/sub/project/-/merge_requests/71  →  { host, project, iid }
export function parseMrUrl(input) {
  try { return parseGitlabMrUrl(input); }
  catch (error) { return fail(error.message); }
}

// 세션 제목. 형식을 스킬이 직접 조립하면 매번 흔들리므로 하네스가 완성해서 넘긴다.
export function sessionTitleFor({ authorName, iid }) {
  return `${authorName || "작성자 불명"}) !${iid} 리뷰`;
}

// Mattermost 전송에 필요한 선택들. 리뷰 시작 전이 아니라 게시 승인 시점에 한 번에 묻는다.
export function mmQuestions({ authorGitlab, mention, channels = [], hasConvention, storageError }) {
  const questions = [];
  if (storageError) {
    questions.push({ id: "mm_storage", ask: `로컬 Mattermost 설정을 읽지 못했습니다(${storageError}). MM 전송을 건너뛸까요?` });
    return questions; // 설정을 못 읽으면 나머지는 물을 근거가 없다
  }
  if (!hasConvention) questions.push({ id: "mm_convention", ask: "'review-complete' 컨벤션이 없습니다. 지금 등록할까요?" });
  if (!mention) {
    questions.push({ id: "mm_participant", ask: `GitLab @${authorGitlab ?? "?"} 의 Mattermost 아이디가 등록돼 있지 않습니다. 무엇인가요?` });
  }
  // 리뷰 완료는 작성자 DM으로 간다. 논리 채널은 목적지가 아니라 DM에 쓸 웹훅 출처다.
  if (channels.length === 0) questions.push({ id: "mm_channel", ask: "등록된 논리 채널이 없습니다. DM에 쓸 웹훅을 어떻게 등록할까요?" });
  else if (channels.length > 1) questions.push({ id: "mm_channel_pick", ask: "DM 전송에 쓸 웹훅(논리 채널)을 골라주세요.", options: channels });
  return questions;
}

export function missingSections(verdict, body) {
  const required = REQUIRED_SECTIONS[verdict];
  if (!required) fail(`verdict는 approve 또는 hold여야 합니다: ${verdict}`);
  return required.filter((section) => !body.includes(section));
}

// `glab mr view --comments -F json`은 배열이 아니라 MR 객체를 주고, 댓글은 대문자 `Discussions`에 들어 있다.
// 각 discussion 안의 노트 키는 소문자 `notes`다. 케이싱이 섞여 있어 양쪽을 다 받는다.
export function collectAuthorNotes(payload, authorGitlab) {
  if (!authorGitlab || !payload) return [];
  const discussions = Array.isArray(payload)
    ? payload
    : payload.Discussions ?? payload.discussions ?? payload.Notes ?? payload.notes ?? [];
  if (!Array.isArray(discussions)) return [];
  const notes = [];
  for (const discussion of discussions) {
    for (const note of discussion?.notes ?? discussion?.Notes ?? [discussion]) {
      if (!note || note.system) continue; // 시스템 활동 로그는 게시자 의도가 아니다
      if (note.author?.username !== authorGitlab) continue;
      notes.push({ createdAt: note.created_at ?? null, body: note.body ?? "" });
    }
  }
  return notes.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

function gitDir(cwd) {
  return run("git", ["rev-parse", "--absolute-git-dir"], { cwd });
}

function statePath(cwd = process.cwd()) {
  return join(gitDir(cwd), STATE_FILE);
}

function readState(cwd = process.cwd()) {
  try {
    const path = statePath(cwd);
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  } catch {
    return null; // git 저장소 밖이거나 손상 → 워크플로 밖으로 간주
  }
}

function writeState(state, cwd = process.cwd()) {
  writeFileSync(statePath(cwd), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  return state;
}

function requireStep(state, expected, hint) {
  if (!state) fail("먼저 `prepare <MR 링크>`를 실행하세요.");
  if (state.step !== expected) fail(`현재 단계는 '${state.step}'입니다. ${hint} (필요한 단계: '${expected}')`);
}

function glabJson(args, exec = run) {
  const out = exec("glab", [...args, "--output", "json"]);
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    return fail(`glab이 JSON을 반환하지 않았습니다: ${args.join(" ")}`);
  }
  // glab은 실패해도 exit 0으로 {"error": ...}를 뱉는다. 조용히 빈 필드로 진행하지 않는다.
  if (parsed?.error) fail(`glab 오류 (${args.join(" ")}): ${parsed.error}`);
  return parsed;
}

function assertGlabAuth(host, exec = tryRun) {
  // glab auth status 는 다른 호스트가 401이어도 exit 0이므로 종료코드가 아니라 출력으로 판정한다.
  if (!exec("glab", ["auth", "status"]).includes(`Logged in to ${host}`)) {
    fail(`glab이 ${host}에 로그인돼 있지 않습니다. 먼저 실행하세요:\n  glab auth login --hostname ${host}`);
  }
}

async function mattermostService() {
  const here = dirname(fileURLToPath(import.meta.url));
  const { MattermostService } = await import(pathToFileURL(join(here, "..", "src", "core.js")).href);
  return new MattermostService();
}

function refExists(cwd, ref, exec) {
  try {
    exec("git", ["rev-parse", "--verify", "--quiet", ref], { cwd });
    return true;
  } catch {
    return false;
  }
}

// main working tree는 git-dir과 git-common-dir이 같다. linked worktree만 갈라진다.
export function isLinkedWorktree(cwd, exec = run) {
  const own = exec("git", ["rev-parse", "--absolute-git-dir"], { cwd });
  const common = exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd });
  return resolve(own) !== resolve(common);
}

function checkoutAt(dir, branch, targetRef, exec) {
  if (exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir }) !== branch) {
    try {
      exec("git", refExists(dir, `refs/heads/${branch}`, exec)
        ? ["checkout", branch]
        : ["checkout", "-b", branch, targetRef], { cwd: dir });
    } catch (error) {
      // git은 한 브랜치를 두 워크트리에 동시에 체크아웃하지 못한다. 원인과 대안을 같이 알려준다.
      const held = String(error?.stderr ?? "").match(/already used by worktree at '([^']+)'/);
      if (held) fail(`'${branch}' 브랜치는 이미 워크트리 ${held[1]} 가 쓰고 있습니다. 거기서 리뷰하거나, --here 없이 실행하세요.`);
      throw error;
    }
  }
  // ff-only라서 로컬 커밋이 있으면 조용히 덮지 않고 시끄럽게 실패한다.
  exec("git", ["merge", "--ff-only", targetRef], { cwd: dir });
}

// main working tree의 루트. linked worktree 안에서도 메인을 가리킨다(--show-toplevel은 그 워크트리를 가리켜 중첩된다).
export function mainWorktreeRoot(cwd, exec = run) {
  return dirname(exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd }));
}

// MR의 원격 브랜치를 그대로 가져와 리뷰용 디렉터리에 올린다.
//
// 이미 linked worktree 안이면 그 자리를 쓰되, **다른 브랜치로 작업 중이면 건드리지 않는다.**
// 세션이 제 브랜치를 달고 있는 워크트리(태스크 워크트리 등)를 MR 브랜치로 갈아끼우면
// 그 세션의 작업 맥락이 조용히 사라진다. 그럴 땐 전용 워크트리를 따로 만든다.
// `here: true`는 그 판단을 무시하고 이 자리를 쓴다.
export function syncMrWorktree({ cwd, remote, iid, sourceBranch, worktreeRoot, here = false }, exec = run) {
  let branch = sourceBranch;
  let targetRef = `refs/remotes/${remote}/${sourceBranch}`;
  let forked = false;
  try {
    exec("git", ["fetch", remote, `+refs/heads/${sourceBranch}:${targetRef}`], { cwd });
  } catch {
    // 포크 MR이면 source branch가 이 원격에 없다. 그때만 MR head ref로 폴백한다.
    forked = true;
    branch = `mr-${iid}`;
    targetRef = `refs/mmp/mr-${iid}`;
    exec("git", ["fetch", remote, `+merge-requests/${iid}/head:${targetRef}`], { cwd });
  }

  if (isLinkedWorktree(cwd, exec) && (here || exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd }) === branch)) {
    if (exec("git", ["status", "--porcelain"], { cwd })) {
      fail("이 워크트리에 커밋되지 않은 변경이 있습니다. 정리한 뒤 다시 실행하세요.");
    }
    checkoutAt(cwd, branch, targetRef, exec);
    return { path: cwd, branch, targetRef, forked, createdWorktree: false, reusedInPlace: true };
  }

  const path = join(worktreeRoot, `mr-${iid}`);
  const registered = exec("git", ["worktree", "list", "--porcelain"], { cwd })
    .split(/\r?\n/)
    .some((line) => line.startsWith("worktree ") && resolve(line.slice(9).trim()) === resolve(path));
  if (!registered) {
    mkdirSync(dirname(path), { recursive: true });
    exec("git", refExists(cwd, `refs/heads/${branch}`, exec)
      ? ["worktree", "add", path, branch]
      : ["worktree", "add", "-b", branch, path, targetRef], { cwd });
  }
  checkoutAt(path, branch, targetRef, exec);
  return { path, branch, targetRef, forked, createdWorktree: !registered, reusedInPlace: false };
}

export async function cmdPrepare(rawUrl, flags = {}, dependencies = {}) {
  if (!rawUrl) fail("사용법: mr-review.mjs prepare <MR 링크> [--worktree-root <경로>] [--here]");
  rawUrl = canonicalMrUrl(rawUrl);
  const { host, project, iid } = parseMrUrl(rawUrl);
  assertGlabAuth(host, dependencies.tryRunImpl ?? tryRun);

  const cwd = dependencies.cwd ?? process.cwd();
  const exec = dependencies.runImpl ?? run;
  gitDir(cwd); // git 저장소가 아니면 여기서 끝난다

  const remote = (exec("git", ["remote"], { cwd }).split(/\r?\n/)[0] || "origin").trim();
  const remoteUrl = exec("git", ["remote", "get-url", remote], { cwd });
  if (!remoteUrl.toLowerCase().replace(/\.git$/, "").includes(project.toLowerCase())) {
    fail(`현재 저장소(${remoteUrl})는 MR 프로젝트(${project})가 아닙니다. 해당 저장소에서 실행하세요.`);
  }

  // 진행 중인 다른 MR 리뷰를 덮어쓰지 않는다.
  const inProgress = readState(cwd);
  if (inProgress && inProgress.iid !== iid && inProgress.step !== "notified") {
    fail(`이 워크트리는 MR !${inProgress.iid} 리뷰가 '${inProgress.step}' 단계로 진행 중입니다. 끝내거나 \`reset\` 후 실행하세요.`);
  }

  // --comments 응답은 일반 응답의 상위집합(Discussions가 추가될 뿐)이라 한 번만 부른다.
  const mr = glabJson(["mr", "view", String(iid), "--repo", `${host}/${project}`, "--comments"], exec);
  const authorGitlab = mr.author?.username ?? null;
  // author.name 은 GitLab에 등록된 표시 이름(한글 실명)이다. 세션 제목과 보고에 쓴다.
  const authorName = mr.author?.name ?? authorGitlab;
  if (!mr.source_branch) fail(`MR !${iid}의 source branch를 읽지 못했습니다.`);

  const worktreeRoot = flags["worktree-root"] ?? join(mainWorktreeRoot(cwd, exec), ".claude", "worktrees");
  const worktree = syncMrWorktree({
    cwd, remote, iid, sourceBranch: mr.source_branch, worktreeRoot, here: flags.here === true,
  }, exec);
  // 최신화가 실패했을 때 직전 준비 상태로 검토·게시하는 일을 막는다.
  writeState({ version: 2, mrUrl: String(rawUrl).trim(), host, project, iid,
    step: "preparing", contextRequired: true, context: null }, worktree.path);
  // diff base. 없으면 diffCommand가 눈에 띄게 실패하므로 조용히 틀린 범위를 리뷰하는 일은 없다.
  try { exec("git", ["fetch", remote, `+refs/heads/${mr.target_branch}:refs/remotes/${remote}/${mr.target_branch}`], { cwd }); }
  catch { /* diffCommand가 실패하면 확인 범위를 추정하지 않고 멈춘다. */ }

  let contextService = dependencies.contextService;
  const ownsContextService = !contextService;
  if (!contextService) {
    const { TeamContextService } = await import("../src/team-context.js");
    contextService = new TeamContextService();
  }
  let context;
  try {
    context = await prepareMrContext({ mrUrl: String(rawUrl).trim(), contextService, runImpl: exec });
  } finally {
    if (ownsContextService) contextService.close();
  }
  const worktreeHead = exec("git", ["rev-parse", "HEAD"], { cwd: worktree.path }).toLowerCase();
  if (worktreeHead !== context.headSha) fail("리뷰 워크트리가 최신 MR 커밋과 다릅니다. prepare부터 다시 실행하세요.");

  const allAuthorNotes = collectAuthorNotes(mr, authorGitlab);
  const authorNotes = allAuthorNotes.slice(-MAX_AUTHOR_NOTES);

  // MR 진행 여부만 리뷰 전에 묻는다. Mattermost 관련 선택은 게시 승인 때로 미룬다(postQuestions).
  const questions = [];
  if (mr.state !== "opened") questions.push({ id: "mr_state", ask: `MR 상태가 '${mr.state}'입니다. 그래도 진행할까요?` });
  if (mr.draft || mr.work_in_progress) questions.push({ id: "mr_draft", ask: "이 MR은 Draft입니다. 그래도 진행할까요?" });

  let mention = null;
  let participantId = null;
  let channels = [];
  let hasConvention = false;
  let storageError = null;
  try {
    const service = await (dependencies.mattermostService ?? mattermostService)();
    try {
      channels = service.listChannels().filter((channel) => channel.enabled).map((channel) => channel.name);
      if (authorGitlab) {
        // DM 전송은 참여자 id가 필요하다(멘션 문자열로는 보낼 수 없다).
        const participant = service.listParticipants({ gitlabUsername: authorGitlab })[0];
        mention = participant?.mention ?? null;
        participantId = participant?.id ?? null;
      }
      hasConvention = service.listConventions({ name: "review-complete" }).length > 0;
    } finally {
      service.close();
    }
  } catch (error) {
    storageError = error.message;
  }
  const postQuestions = mmQuestions({ authorGitlab, mention, channels, hasConvention, storageError });

  const state = writeState({
    version: 2,
    mrUrl: String(rawUrl).trim(),
    host,
    project,
    iid,
    title: mr.title ?? null,
    authorGitlab,
    authorName,
    authorMention: mention,
    authorParticipantId: participantId,
    sourceBranch: mr.source_branch,
    targetBranch: mr.target_branch ?? null,
    branch: worktree.branch,
    contextRequired: true,
    context,
    headSha: context.headSha,
    contextVersion: context.contextVersion,
    worktreePath: worktree.path,
    step: "prepared",
    verdict: null,
    body: null,
    preparedAt: new Date().toISOString(),
    postedAt: null,
    notifiedAt: null,
    // 상태 파일은 리뷰가 실제로 일어나는 워크트리의 git 디렉터리에 둔다.
  }, worktree.path);

  return {
    ...state,
    sessionTitle: sessionTitleFor({ authorName, iid }),
    createdWorktree: worktree.createdWorktree,
    reusedInPlace: worktree.reusedInPlace,
    forked: worktree.forked,
    webUrl: mr.web_url ?? null,
    description: mr.description ?? "",
    authorNotes,
    // 댓글이 0건일 때 "정말 없음"과 "파싱이 깨짐"을 구분하기 위한 대조값.
    authorNoteCount: allAuthorNotes.length,
    totalNoteCount: mr.user_notes_count ?? null,
    channels,
    diffCommand: `git diff ${remote}/${mr.target_branch}...HEAD`,
    questions,
    postQuestions,
  };
}

export function reviewContextProblems(state, body) {
  if (!state?.contextRequired) return [];
  const context = state.context;
  if (context?.status !== "fresh" || context.headSha !== state.headSha
    || !/^[a-f0-9]{64}$/i.test(context.contextVersion ?? "") || context.contextVersion !== state.contextVersion
    || !Array.isArray(context.perspectives) || context.perspectives.length !== 6) {
    return ["최신 팀 작업 맥락이 없습니다. prepare부터 다시 실행하세요."];
  }
  if (body === undefined) return [];
  const section = sectionOf(body, "### 작업 맥락").trim();
  if (!section) return ["리뷰 본문에 ### 작업 맥락 섹션과 담당 관점별 확인 근거를 적으세요."];
  const references = [
    ...(context.relatedIssues ?? []).map((issue) => issue.key),
    ...context.perspectives.flatMap((person) => [...(person.areas ?? []), ...(person.changedPaths ?? [])]),
  ].filter((reference) => typeof reference === "string" && reference.trim());
  return references.some((reference) => section.includes(reference)) ? []
    : ["작업 맥락에 관련 Jira 키나 실제 담당 영역·변경 경로를 인용하고 확인 결과를 적으세요. 영향이 없다면 그 근거를 적으세요."];
}

export function cmdRecord(verdict, bodyFile, { cwd = process.cwd() } = {}) {
  const state = readState(cwd);
  if (!state) fail("먼저 `prepare <MR 링크>`를 실행하세요.");
  if (state.step === "posted" || state.step === "notified") fail("이미 게시된 리뷰입니다. 다시 하려면 `reset` 후 시작하세요.");
  if (!bodyFile) fail("사용법: mr-review.mjs record <approve|hold> <본문파일>");

  const body = readFileSync(bodyFile, "utf8").trim();
  if (!body) fail("리뷰 본문이 비어 있습니다.");
  const contextProblems = reviewContextProblems(state, body);
  if (contextProblems.length) fail(contextProblems.join("\n"));
  const missing = missingSections(verdict, body);
  if (missing.length) {
    fail(`리뷰 본문에 필수 섹션이 없습니다: ${missing.join(", ")}\n보류 사유는 상대가 바로 고칠 수 있게 항목별로 풀어서 써야 합니다.`);
  }
  // 보류하려면 "병합 후에 고치면 늦는 이유"가 카테고리로 분류돼야 한다.
  // 분류가 안 되는 지적(문서·오타·네이밍·취향)은 보류가 아니라 승인 + 안내다.
  if (verdict === "hold" && usedHoldCategories(body).length === 0) {
    fail(`보류하려면 각 항목에 사유 카테고리를 붙여야 합니다: ${HOLD_CATEGORIES.join(" ")}\n`
      + "이 중 어디에도 안 들어가면 병합을 막을 사유가 아닙니다. 승인하고 '고치면 좋을 것'에 적으세요.");
  }
  // 위치를 못 대는 보류는 확인이 아니라 추측이다. 추측으로 남의 병합을 막지 않는다.
  if (verdict === "hold" && citedLocations(body).length === 0) {
    fail("보류 항목은 실제 코드 위치를 인용해야 합니다. 예: `src/service/auth.js:42`\n"
      + "위치를 댈 수 없다면 확인한 것이 아니므로 보류 사유가 될 수 없습니다.");
  }
  const problems = verdictProblems(verdict, body);
  if (problems.length) fail(problems.join("\n"));
  return writeState({ ...state, step: "reviewed", verdict, body }, cwd);
}

export async function cmdPost(flags = {}, { cwd = process.cwd(), runImpl = run } = {}) {
  const state = readState(cwd);
  requireStep(state, "reviewed", "`record <approve|hold> <본문파일>`을 먼저 실행하세요.");
  const contextProblems = reviewContextProblems(state, state.body);
  if (contextProblems.length) fail(contextProblems.join("\n"));
  // 권한 프롬프트는 세션 모드(auto 등)에 따라 사람에게 닿지 않는다.
  // 그래서 승인을 권한 계층이 아니라 대화 계층(AskUserQuestion)에 두고, 여기서 그 증거를 요구한다.
  if (flags.confirmed !== true && autoMode() !== "bypass") {
    fail("게시 전 사용자 승인이 필요합니다.\n1) 답글 전문을 대화에 보여주고\n2) AskUserQuestion으로 게시 여부를 묻고\n3) 승인받은 뒤 `post --confirmed`로 실행하세요.\n"
      + "(전체 무승인으로 돌리려면 `/mmp:bypass-review on`)");
  }

  if (state.contextRequired && await readMrHeadSha(state.mrUrl, { runImpl }) !== state.headSha) {
    fail("리뷰 후 새 커밋이 올라왔습니다. 이전 결과는 게시하지 않습니다. prepare부터 다시 실행하세요.");
  }

  // --unique: 같은 본문이 이미 있으면 다시 달지 않는다(재실행 안전).
  const args = ["mr", "note", "create", String(state.iid), "--repo", `${state.host}/${state.project}`, "--message", state.body, "--unique"];
  // 승인 코멘트가 "모든 스레드 해결" 정책에서 머지를 막지 않도록 비해결형으로 남긴다.
  if (state.verdict === "approve") args.push("--resolvable=false");
  await runImpl("glab", args);

  return writeState({ ...state, step: "posted", postedAt: new Date().toISOString() }, cwd);
}

async function cmdNotify(flags) {
  const cwd = process.cwd();
  const state = readState(cwd);
  requireStep(state, "posted", "`post`로 MR 답글을 먼저 게시하세요.");

  // 팀 채널이 아니라 MR 작성자에게 DM으로 보낸다. --channel 은 목적지가 아니라 웹훅 자격증명 출처다.
  // bypass 동안은 채널을 묻지 않는다. 설정된 기본 채널을 쓴다.
  const fallbackChannel = autoMode() === "bypass" ? defaultChannel(readAutoState()) : null;
  const viaChannel = flags.channel ?? fallbackChannel ?? fail("--channel <논리채널명> 이 필요합니다(DM에 쓸 웹훅 출처).");
  const mention = flags.mention ?? state.authorMention ?? fail("--mention @아이디 가 필요합니다.");
  const jira = flags.jira ?? fail("--jira <지라키> 가 필요합니다.");
  const participantId = Number(flags["participant-id"] ?? state.authorParticipantId);
  if (!Number.isInteger(participantId) || participantId <= 0) {
    fail("DM 수신자를 특정하지 못했습니다. `participant_list`로 작성자를 등록한 뒤 --participant-id <숫자> 로 넘기세요.");
  }

  const service = await mattermostService();
  try {
    // review-complete 컨벤션이 한 줄 형식과 이모지를 강제하고, 멘션이 수신자와 일치하는지도 검사한다.
    // mr_number는 상태 파일에서 오므로 틀릴 수 없다.
    const sent = await service.sendDirectMessage({
      participantId,
      viaChannelName: viaChannel,
      conventionName: "review-complete",
      // 템플릿이 쓰지 않는 변수는 무시되므로, 팀 템플릿이 요구할 수 있는 값은 미리 다 넘긴다.
      variables: {
        mention,
        mr_number: String(state.iid),
        jira_key: jira,
        mr_url: state.mrUrl,
        message: flags.message ?? "리뷰 완료 했습니다.",
      },
    });
    writeState({ ...state, step: "notified", notifiedAt: new Date().toISOString() }, cwd);
    return sent;
  } finally {
    service.close();
  }
}

// ---- PreToolUse 게이트 -------------------------------------------------

const deny = (reason) => ({ permissionDecision: "deny", permissionDecisionReason: reason });
// 게이트가 이미 검증한 단계는 권한 프롬프트를 다시 띄우지 않는다.
// 사용자 확인은 AskUserQuestion(대화 계층) 한 번으로 끝나야지, 승인 직후 또 묻는 건 의미 없는 마찰이다.
const allow = (reason) => ({ permissionDecision: "allow", permissionDecisionReason: reason });

// state는 지연 로딩한다. 문자열만으로 판정되는 금지 항목은 git이 없어도 막혀야 한다.
export function gateDecision(input, loadState, loadMode = autoMode) {
  if (input?.tool_name !== "Bash" && input?.tool_name !== "PowerShell") return null;
  const command = String(input?.tool_input?.command ?? "");

  // 명령 위치(문자열 시작, 또는 ; && || | 뒤)에 있는 glab만 본다.
  // 앵커가 없으면 인용부호나 heredoc 안에 문자열로 적힌 예시까지 차단해 오탐이 실사용을 방해한다.
  const glabMr = (sub) => new RegExp(String.raw`(?:^|[\n;&|(])\s*glab\s+mr\s+${sub}`);

  if (glabMr(String.raw`approve\b`).test(command)) return deny("이 워크플로는 코멘트만 게시합니다. GitLab 승인 버튼은 직접 눌러주세요.");
  if (glabMr(String.raw`merge\b`).test(command)) return deny("머지는 이 워크플로의 범위가 아닙니다.");
  // `note list`는 읽기 전용이라 막지 않는다. 그 외(기본형 `note <id> -m`, create/update/delete/resolve)는 모두 게시·변경이다.
  // 단, 이 저장소에서 리뷰가 진행 중일 때만 막는다. 진행 중이 아니면 우회할 하네스가 없다 —
  // 작성자가 자기 MR에 리뷰 요청 댓글을 다는 것까지 막으면 그건 오탐이다.
  if (glabMr(String.raw`note\b(?!\s+list\b)`).test(command)) {
    return loadState()
      ? deny("리뷰 진행 중입니다. 판정 답글은 `mr-review.mjs post`로만 게시할 수 있습니다. 리뷰 요청·질문 같은 다른 댓글이라면 리뷰를 끝내거나 `mr-review.mjs reset` 후에 다세요.")
      : null;
  }

  // glab 규칙과 같은 이유로 여기도 명령 위치에 있는 node 실행만 본다.
  const subs = String.raw`(prepare|record|post|notify|status|reset)`;
  const nodeCall = (middle) => new RegExp(String.raw`(?:^|[\n;&|(])\s*node\b[^&|;]*?${middle}\s${subs}(?:\s|$)`);
  const explicit = command.match(nodeCall("mr-review[^&|;]*?"));
  // 셸 변수나 별칭으로 우회해도 잡는다. 확신이 없는 이 경로에서는 거부만 하고 자동 승인은 하지 않는다.
  const implicit = explicit ? null : command.match(nodeCall(""));
  if (!explicit && !implicit) return null;

  const sub = (explicit ?? implicit)[1];
  const pass = (reason) => (explicit ? allow(reason) : null);
  // prepare 는 상태가 없을 때 실행되는 첫 단계다. 나머지는 상태를 요구한다.
  if (sub === "prepare") return pass("리뷰 준비 — 로컬 워크트리 작업");
  if (sub === "status" || sub === "reset") return pass("로컬 상태 조회·초기화");

  const state = loadState();
  if (!state) return explicit ? deny("`mr-review.mjs prepare <MR 링크>`를 먼저 실행하세요.") : null;

  if (sub === "record") return pass("판정 기록 — 하네스가 섹션·카테고리를 검증한다");

  if (sub === "post") {
    if (state.step === "posted" || state.step === "notified") return deny(`MR !${state.iid} 답글은 이미 게시됐습니다.`);
    if (state.step !== "reviewed") return deny("`record <approve|hold> <본문파일>`을 먼저 실행하세요.");
    // deny는 세션 권한 모드와 무관하게 확정적이다. 승인 증거(--confirmed)가 없으면 확정적으로 막는다.
    if (!/--confirmed\b/.test(command) && loadMode() !== "bypass") {
      return deny("답글 전문을 대화에 보여주고 AskUserQuestion으로 게시 승인을 받은 뒤 `post --confirmed`로 실행하세요. 권한 프롬프트는 이 확인을 대신하지 못합니다.");
    }
    return pass(`MR !${state.iid} 답글 게시`);
  }

  if (state.step !== "posted") return deny(`MR 답글 게시 후에만 리뷰 완료를 보낼 수 있습니다. 현재 단계: '${state.step}'`);
  return pass("리뷰 완료 DM — 게시 완료 후 자동 전송");
}

async function cmdGate() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let decision = null;
  try {
    decision = gateDecision(JSON.parse(raw || "{}"), () => readState());
  } catch {
    decision = null; // 게이트가 깨져도 세션을 막지 않는다
  }
  if (decision) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", ...decision } }));
  return null;
}

// ---- entrypoint --------------------------------------------------------

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[argv[i].slice(2)] = true; // --here 처럼 값 없는 불리언 플래그
    } else {
      flags[argv[i].slice(2)] = next;
      i += 1;
    }
  }
  return flags;
}

async function main(argv) {
  const [command, ...rest] = argv;
  switch (command) {
    case "prepare": return cmdPrepare(rest[0], parseFlags(rest.slice(1)));
    case "record": return cmdRecord(rest[0], rest[1]);
    case "post": return cmdPost(parseFlags(rest));
    case "notify": return cmdNotify(parseFlags(rest));
    case "status": return readState() ?? { step: null };
    case "reset": {
      const path = statePath();
      if (existsSync(path)) rmSync(path);
      return { reset: true };
    }
    case "gate": return cmdGate();
    default:
      return fail(`알 수 없는 명령: ${command ?? "(없음)"}\n사용: prepare | record | post | notify | status | reset | gate\n단계: ${STEPS.join(" → ")}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((result) => {
      if (result !== null && result !== undefined) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof HarnessError ? error.message : `실패: ${error.message}`}\n`);
      process.exit(1);
    });
}
