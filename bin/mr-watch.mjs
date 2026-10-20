#!/usr/bin/env node
// GitLab todos 감시기. 내가 리뷰어로 지정되거나 MR에서 멘션되면 한 줄씩 stdout에 뱉는다.
//
// Mattermost를 보지 않는 이유: GitLab todos는 이미 있는 glab 인증으로 읽히고(새 토큰 0개),
// action_name 필드가 "리뷰 요청인가"를 대신 판정해 주며, target_url이 그대로 /mmp:mr-review 의 입력이 된다.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { effectiveMode, readState as readBypassState } from "./bypass-review.mjs";

const POLL_MS = 60_000;
const MAX_SEEN = 500; // 오래된 todo id는 버린다. done 처리된 todo가 다시 pending으로 돌아오지는 않는다.

// 리뷰 요청이 확실한 것. 판정 없이 바로 리뷰 세션을 띄워도 된다.
export const REVIEW_ACTIONS = new Set(["review_requested", "approval_required"]);
// MR에서 나를 부른 것. 리뷰 요청인지 단순 질문인지는 body를 보고 판단해야 한다.
export const MAYBE_ACTIONS = new Set(["directly_addressed", "mentioned"]);
// assigned 는 보통 "네가 머지해라"지 "리뷰해라"가 아니라서 뺀다.

export class WatchError extends Error {}

function dataDir() {
  return process.env.MATTERMOST_MCP_DATA_DIR ?? join(homedir(), ".mmp");
}

function readJson(path, fallback) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;
  } catch {
    return fallback;
  }
}

// glab 이 실제로 로그인한 호스트를 읽는다. 호스트명을 코드에 박지 않는 이유는 이 저장소가 공개라서다.
// glab auth status 는 다른 호스트가 401이어도 exit 0이고 전부 stderr로 쓴다 — 종료코드가 아니라 출력으로 판정한다.
export function loggedInHosts(authStatus) {
  return [...String(authStatus).matchAll(/Logged in to (\S+)/g)].map((m) => m[1]);
}

function detectHosts() {
  const out = spawnSync("glab", ["auth", "status"], { encoding: "utf8" });
  return loggedInHosts(`${out.stdout ?? ""} ${out.stderr ?? ""}`);
}

// 설정의 host 가 항상 이긴다. 없을 때만 추론하고, 후보가 정확히 하나일 때만 쓴다 —
// 여러 곳에 로그인돼 있으면 어느 쪽을 볼지 우리가 알 수 없고, 틀린 추측은 조용한 401이 된다.
function resolveHost(config, hosts) {
  if (config.host) return config.host;
  const found = hosts();
  if (found.length === 1) return found[0];
  if (found.length === 0) {
    throw new WatchError("glab 이 어느 GitLab 에도 로그인돼 있지 않습니다. `glab auth login --hostname <호스트>` 먼저 실행하거나, 감시 설정에 \"host\" 를 적으세요.");
  }
  throw new WatchError(`glab 이 여러 호스트에 로그인돼 있습니다(${found.join(", ")}). 감시 설정에 \"host\" 로 하나를 지정하세요.`);
}

export function loadConfig(path, hosts = detectHosts) {
  const config = readJson(path, null);
  if (!config) {
    throw new WatchError(`감시 설정이 없습니다: ${path}\n`
      + '{"host":"gitlab.example.com","projects":{"group/repo":{"workdir":"C:/work/repo","jiraBaseUrl":"https://jira.example.com/browse"}}} 형태로 만드세요.');
  }
  // 호스트를 반드시 정한다. 비워두면 glab 이 현재 디렉터리의 remote 로 추론하는데,
  // 감시기는 어디서 돌지 모르므로 조용히 gitlab.com 에 붙어 401이 난다.
  const host = resolveHost(config, hosts);
  const projects = config.projects ?? {};
  for (const [name, entry] of Object.entries(projects)) {
    // 설정 게이트: 작업 폴더와 지라 base URL이 둘 다 있어야 그 프로젝트를 감시한다.
    if (!entry?.workdir || !entry?.jiraBaseUrl) {
      throw new WatchError(`프로젝트 '${name}' 설정에 workdir 와 jiraBaseUrl 이 모두 필요합니다.`);
    }
    if (!existsSync(entry.workdir)) throw new WatchError(`프로젝트 '${name}'의 workdir 가 없습니다: ${entry.workdir}`);
  }
  if (Object.keys(projects).length === 0) throw new WatchError("감시할 프로젝트가 하나도 설정되지 않았습니다.");
  return { host, projects };
}

// 어떤 todo를 리뷰 작업으로 흘려보낼지 고른다. 순수 함수 — 이 감시기의 판단은 전부 여기 있다.
export function selectTodos(todos, { projects, seen, since }) {
  const picked = [];
  for (const todo of Array.isArray(todos) ? todos : []) {
    if (todo?.target_type !== "MergeRequest") continue;
    const action = todo.action_name;
    const certain = REVIEW_ACTIONS.has(action);
    if (!certain && !MAYBE_ACTIONS.has(action)) continue;

    const project = todo.project?.path_with_namespace;
    if (!project || !projects[project]) continue; // 설정되지 않은 프로젝트는 건드리지 않는다
    if (seen.has(todo.id)) continue;
    // 감시 시작 이전에 쌓여 있던 todo는 재생하지 않는다. 부팅 때 수십 건이 쏟아지는 게 놓치는 것보다 나쁘다.
    if (since && !(Date.parse(todo.created_at) > since)) continue;

    picked.push({
      todoId: todo.id,
      action,
      certain,
      project,
      iid: todo.target?.iid ?? null,
      mrUrl: todo.target_url,
      title: todo.target?.title ?? null,
      authorName: todo.author?.name ?? null,
      authorUsername: todo.author?.username ?? null,
      createdAt: todo.created_at,
      body: todo.body ?? "",
      workdir: projects[project].workdir,
      jiraBaseUrl: projects[project].jiraBaseUrl,
    });
  }
  picked.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

  // 같은 폴링 배치에서 한 MR에 여러 todo가 오는 일이 흔하다(리뷰어 지정 + 같은 댓글의 멘션).
  // 한 MR당 하나로 합친다. 확정 액션이 있으면 그것을 남겨 판단 단계를 건너뛴다.
  // 배치를 넘어선 중복은 합치지 않는다 — 수정 후 2차 리뷰 요청은 별개 사건이다.
  const byMr = new Map();
  for (const item of picked) {
    const key = `${item.project}#${item.iid}`;
    const kept = byMr.get(key);
    if (!kept) {
      byMr.set(key, { ...item, todoIds: [item.todoId] });
      continue;
    }
    // 확정 액션이 나중에 오면 그쪽으로 교체한다. 처리한 todo id는 전부 들고 간다.
    const todoIds = [...kept.todoIds, item.todoId];
    byMr.set(key, kept.certain || !item.certain ? { ...kept, todoIds } : { ...item, todoIds });
  }
  return [...byMr.values()];
}

function fetchTodos(host) {
  let out;
  try {
    out = execFileSync("glab", ["api", "todos?state=pending&per_page=100"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GITLAB_HOST: host },
    });
  } catch (error) {
    throw new WatchError(`glab api 호출 실패: ${String(error?.stderr ?? error?.message).trim().slice(0, 300)}`);
  }
  try {
    return JSON.parse(out);
  } catch {
    throw new WatchError("glab이 todos에 대해 JSON을 반환하지 않았습니다.");
  }
}

function emit(line) {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

function tick(paths, state) {
  const { host, projects } = loadConfig(paths.config);
  const mode = effectiveMode(readBypassState());
  const todos = fetchTodos(host);
  const seen = new Set(state.seen);
  const picked = selectTodos(todos, { projects, seen, since: state.since });

  for (const item of picked) {
    emit({ ...item, mode });
    // 합쳐진 todo까지 전부 기록한다. 하나라도 빠지면 다음 폴링에 다시 올라온다.
    for (const id of item.todoIds) seen.add(id);
  }
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.state, `${JSON.stringify({ since: state.since, seen: [...seen].slice(-MAX_SEEN) }, null, 2)}\n`, { mode: 0o600 });
  return { picked: picked.length, pending: todos.length };
}

// 감시 시작 전에 이미 쌓여 있는 리뷰 요청을 보여준다.
// 상태를 건드리지 않으므로, 여기서 본 것이 나중에 이벤트로 또 오지는 않는다(since가 그것을 막는다).
function listPending(paths) {
  const { host, projects } = loadConfig(paths.config);
  return selectTodos(fetchTodos(host), { projects, seen: new Set(), since: 0 })
    .map(({ iid, project, mrUrl, title, authorName, action, certain, createdAt }) =>
      ({ iid, project, mrUrl, title, authorName, action, certain, createdAt }));
}

async function main(argv) {
  const dir = dataDir();
  const paths = { dir, config: join(dir, "watch.json"), state: join(dir, "watch-state.json") };

  if (argv.includes("--pending")) {
    process.stdout.write(`${JSON.stringify(listPending(paths), null, 2)}\n`);
    return;
  }

  let state = readJson(paths.state, null);

  if (!state) {
    // 첫 실행: 지금 쌓여 있는 것은 전부 건너뛰고 이후에 생기는 것만 본다.
    state = { since: Date.now(), seen: [] };
    mkdirSync(dir, { recursive: true });
    writeFileSync(paths.state, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    process.stderr.write(`감시 시작. 기존 pending todo는 건너뜁니다. 상태: ${paths.state}\n`);
  }

  const once = argv.includes("--once");
  for (;;) {
    try {
      const { picked, pending } = tick(paths, state);
      state = readJson(paths.state, state);
      process.stderr.write(`[${new Date().toISOString()}] pending=${pending} 신규=${picked}\n`);
    } catch (error) {
      if (!(error instanceof WatchError)) throw error;
      // 조용히 죽지 않는다. 세션이 알아야 고칠 수 있다.
      emit({ type: "watch_error", message: error.message, at: new Date().toISOString() });
      if (once) process.exitCode = 1;
    }
    if (once) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll("\\", "/")}`).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`실패: ${error.message}\n`);
    process.exit(1);
  });
}
