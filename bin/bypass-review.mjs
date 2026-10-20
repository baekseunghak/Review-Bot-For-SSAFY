#!/usr/bin/env node
// 리뷰 자동화의 승인 정책. bypass 켜짐/꺼짐 둘뿐이다.
//
// "감시가 도느냐"는 여기서 다루지 않는다. 그건 감시 세션이 열려 있느냐로 결정되고,
// 파일은 그 사실을 알 수 없다. 파일은 지킬 수 있는 약속만 한다 — "돌 때 승인을 받느냐".
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// 초기값일 뿐이다. `channel <이름>` 으로 바꾼다. 다른 곳 어디에도 이 문자열은 없다.
const INITIAL_CHANNEL = "특화-팀-BND";

export class BypassError extends Error {}

export function dataDir() {
  return process.env.MATTERMOST_MCP_DATA_DIR ?? join(homedir(), ".mmp");
}

export function stateFile(dir = dataDir()) {
  return join(dir, "bypass-review.json");
}

export function readState(file = stateFile()) {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  } catch {
    return null; // 손상된 파일로 멈추지 않는다. 승인을 받는 쪽(안전한 쪽)으로 간다.
  }
}

export function writeState(state, file = stateFile()) {
  mkdirSync(dirname(file), { recursive: true });
  const next = { ...state, updatedAt: new Date().toISOString() };
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return next;
}

// 명시적으로 켠 적이 없으면 승인을 받는다. 무승인이 기본값이 되는 일은 없어야 한다.
export function effectiveMode(state) {
  return state?.bypass === true ? "bypass" : "on";
}

export function defaultChannel(state) {
  return state?.defaultChannel || INITIAL_CHANNEL;
}

export function describe(state) {
  return {
    bypass: effectiveMode(state) === "bypass",
    defaultChannel: defaultChannel(state),
    updatedAt: state?.updatedAt ?? null,
  };
}

function main(argv) {
  const [command, arg] = argv;
  const file = stateFile();
  const state = readState(file);

  switch (command) {
    case undefined:
    case "status":
      return describe(state);
    case "on":
      return describe(writeState({ ...state, bypass: true }, file));
    case "off":
      return describe(writeState({ ...state, bypass: false }, file));
    case "channel": {
      if (!arg) throw new BypassError("사용법: bypass-review.mjs channel <논리채널명>");
      return describe(writeState({ ...state, defaultChannel: arg }, file));
    }
    default:
      throw new BypassError(`알 수 없는 인자: ${command}\n사용: on | off | status | channel <이름>`);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll("\\", "/")}`).href) {
  try {
    process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof BypassError ? error.message : `실패: ${error.message}`}\n`);
    process.exit(1);
  }
}
