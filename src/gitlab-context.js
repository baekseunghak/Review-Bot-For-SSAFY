import { execFile } from "node:child_process";
import { promisify } from "node:util";

const SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const execFileAsync = promisify(execFile);

export function parseGitlabMrUrl(input) {
  let url;
  try { url = new URL(String(input ?? "").trim()); }
  catch { throw new Error("MR 링크를 URL 형태로 붙여주세요."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search
    || (url.hash && !/^#note_\d+$/.test(url.hash))) {
    throw new Error("MR 링크는 인증 정보와 쿼리가 없는 http(s) 주소여야 합니다.");
  }
  const match = url.pathname.match(/^\/([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)\/-\/merge_requests\/([1-9]\d*)\/?$/);
  if (!match || match[1].split("/").some((part) => part === "." || part === "..") || !Number.isSafeInteger(Number(match[2]))) {
    throw new Error("MR 링크에서 프로젝트와 번호를 찾지 못했습니다.");
  }
  return { host: url.host, project: match[1], iid: Number(match[2]) };
}

export function canonicalMrUrl(input) {
  parseGitlabMrUrl(input);
  const url = new URL(String(input).trim());
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

async function run(file, args, options) {
  const { stdout } = await execFileAsync(file, args, {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000,
    maxBuffer: 32 * 1024 * 1024, ...options, shell: false,
  });
  return stdout;
}

function apiReader(address, runImpl) {
  return async (suffix = "") => {
    const endpoint = `projects/${encodeURIComponent(address.project)}/merge_requests/${address.iid}${suffix}`;
    let value;
    try {
      value = JSON.parse(await runImpl("glab", ["api", endpoint, "--hostname", address.host], { shell: false }));
    } catch {
      // CLI 오류 원문에는 인증 관련 값이 있을 수 있으므로 공개하지 않는다.
      throw new Error(`GitLab MR !${address.iid} 조회에 실패했습니다. glab 로그인과 접근 권한을 확인하세요.`);
    }
    if (value?.error || value?.message) throw new Error(`GitLab MR !${address.iid} 조회가 거부됐습니다.`);
    return value;
  };
}

function headOf(mr) {
  const headSha = mr?.diff_refs?.head_sha ?? mr?.sha;
  if (!SHA_PATTERN.test(headSha ?? "")) throw new Error("MR의 최신 커밋을 확인하지 못했습니다.");
  if (mr.sha && mr.diff_refs?.head_sha && mr.sha !== mr.diff_refs.head_sha) {
    throw new Error("MR diff가 아직 최신 커밋으로 갱신되지 않았습니다. 잠시 후 다시 준비하세요.");
  }
  return headSha.toLowerCase();
}

export function extractIssueKeys(...texts) {
  return [...new Set(texts.flatMap((text) => String(text ?? "").match(/\b[A-Z][A-Z0-9_]*-\d+\b/g) ?? []))];
}

export async function readMrHeadSha(mrUrl, { runImpl = run } = {}) {
  return headOf(await apiReader(parseGitlabMrUrl(mrUrl), runImpl)());
}

export async function readMrContext(mrUrl, { runImpl = run } = {}) {
  const address = parseGitlabMrUrl(mrUrl);
  const api = apiReader(address, runImpl);
  const mr = await api();
  const headSha = headOf(mr);
  const author = { username: mr.author?.username, id: mr.author?.id };
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(author.username ?? "")
    || !Number.isSafeInteger(author.id) || author.id < 1) {
    throw new Error("MR 작성자의 GitLab 계정을 확인하지 못했습니다.");
  }
  const paths = new Set();
  let count = 0;
  let complete = false;
  for (let page = 1; page <= 1000; page += 1) {
    const diffs = await api(`/diffs?per_page=100&page=${page}`);
    if (!Array.isArray(diffs)) throw new Error("GitLab 변경 파일 목록의 형식이 올바르지 않습니다.");
    count += diffs.length;
    for (const diff of diffs) {
      for (const path of [diff.old_path, diff.new_path]) {
        if (typeof path !== "string" || !path || path.startsWith("/") || path.includes("\\")
          || path.split("/").some((part) => part === ".." || part === "." || !part)
          || /[\x00-\x1f]/.test(path)) throw new Error("GitLab 변경 파일 경로가 올바르지 않습니다.");
        paths.add(path);
      }
    }
    if (diffs.length < 100) { complete = true; break; }
  }
  const reported = String(mr.changes_count ?? "");
  if (!complete || (/^\d+\+?$/.test(reported) && (Number.parseInt(reported, 10) > count || (reported.endsWith("+") && Number.parseInt(reported, 10) >= count)))) {
    throw new Error("MR 변경 파일 목록이 일부만 조회됐습니다. 전체 파일을 확인한 뒤 다시 준비하세요.");
  }
  return {
    mrUrl: canonicalMrUrl(mrUrl), author, headSha, changedPaths: [...paths],
    issueKeys: extractIssueKeys(mr.title, mr.description, mr.source_branch),
    mrSource: { title: String(mr.title ?? "").slice(0, 512), description: String(mr.description ?? "").slice(0, 16_000),
      descriptionTruncated: String(mr.description ?? "").length > 16_000 },
  };
}

export async function prepareMrContext({ mrUrl, contextService, runImpl = run, issueKeys = [] }) {
  if (typeof contextService?.prepareReview !== "function") throw new Error("팀 작업 맥락 서비스가 필요합니다.");
  const input = await readMrContext(mrUrl, { runImpl });
  if (!Array.isArray(issueKeys)) throw new Error("Jira 연결 키 목록이 올바르지 않습니다.");
  input.issueKeys = [...new Set([...input.issueKeys, ...issueKeys])];
  const bundle = await contextService.prepareReview(input);
  if (bundle?.status !== "fresh" || bundle.headSha !== input.headSha || bundle.mrUrl !== input.mrUrl) {
    throw new Error("최신 작업 맥락을 준비하지 못했습니다. 리뷰를 시작할 수 없습니다.");
  }
  if (await readMrHeadSha(mrUrl, { runImpl }) !== input.headSha) {
    throw new Error("작업 맥락을 준비하는 동안 새 커밋이 올라왔습니다. prepare부터 다시 실행하세요.");
  }
  return bundle;
}
