import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultChannel, describe as describeState, effectiveMode, readState, writeState } from "../bin/bypass-review.mjs";

const file = () => join(mkdtempSync(join(tmpdir(), "mmp-bypass-")), "bypass-review.json");

// 무승인이 사고로 기본값이 되는 일은 없어야 한다. 모르면 승인을 받는 쪽으로 간다.
test("명시적으로 켜지 않은 모든 상태는 승인을 받는다", () => {
  for (const state of [null, undefined, {}, { bypass: false }, { bypass: "true" }, { bypass: 1 }]) {
    assert.equal(effectiveMode(state), "on", JSON.stringify(state));
  }
  assert.equal(effectiveMode({ bypass: true }), "bypass");
});

test("손상된 상태 파일은 멈추지 않고 승인을 받는 쪽으로 읽힌다", () => {
  const path = file();
  writeFileSync(path, "{ 깨진 json");
  assert.equal(readState(path), null);
  assert.equal(effectiveMode(readState(path)), "on");
});

test("on/off를 오가도 기본 채널은 남는다", () => {
  const path = file();
  writeState({ defaultChannel: "팀-채널" }, path);
  assert.equal(effectiveMode(readState(path)), "on", "채널만 바꾼다고 bypass가 켜지지 않는다");

  writeState({ ...readState(path), bypass: true }, path);
  assert.equal(defaultChannel(readState(path)), "팀-채널");

  writeState({ ...readState(path), bypass: false }, path);
  assert.equal(defaultChannel(readState(path)), "팀-채널");
  assert.equal(effectiveMode(readState(path)), "on");
});

test("기본 채널은 코드에 박혀 있지 않고 상태가 이긴다", () => {
  assert.ok(defaultChannel(null), "초기값이 있어야 bypass가 보낼 곳을 안다");
  assert.equal(defaultChannel({ defaultChannel: "다른-채널" }), "다른-채널");
  assert.equal(defaultChannel({ defaultChannel: "" }), defaultChannel(null), "빈 값은 초기값으로");
});

test("status 출력에 사용자가 확인할 두 값이 모두 있다", () => {
  const shown = describeState({ bypass: true, defaultChannel: "팀-채널", updatedAt: "2026-09-22T00:00:00.000Z" });
  assert.deepEqual(shown, {
    bypass: true, defaultChannel: "팀-채널", updatedAt: "2026-09-22T00:00:00.000Z",
  });
  assert.equal(describeState(null).updatedAt, null);
});

// 시간이 지나 저절로 풀리는 만료 개념은 없앴다. 켜면 끌 때까지 켜져 있다.
test("만료 없이 껐다 켰다만 한다", () => {
  const path = file();
  const on = writeState({ bypass: true }, path);
  assert.ok(!("expiresAt" in on));
  assert.equal(effectiveMode(readState(path)), "bypass");
  assert.equal(effectiveMode(writeState({ ...readState(path), bypass: false }, path)), "on");
});
