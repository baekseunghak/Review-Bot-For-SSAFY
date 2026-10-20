---
name: bypass-review
description: MR 리뷰 자동화의 승인 정책을 켜고 끈다. "무승인으로 돌려줘", "승인 건너뛰게 해줘", "bypass 켜줘·꺼줘", "지금 승인 받나?", "기본 채널 바꿔줘" 처럼 리뷰 게시·DM에 사용자 확인을 받을지 물어볼 때 쓴다. 감시를 켜고 끄는 것과는 다르다 — 감시는 auto-review 가 담당한다.
---

# 리뷰 승인 정책 (bypass)

이 스킬이 정하는 건 **하나**다. 리뷰가 MR에 답글을 달고 DM을 보내기 전에 **사람에게 물어보느냐**.

| bypass | MR 답글 게시 | MM 알림 채널 |
|---|---|---|
| 꺼짐 (기본값) | `AskUserQuestion` 승인 후에만 | 승인할 때 같이 고름 |
| 켜짐 | 승인 없이 바로 | 저장된 기본 채널로 자동 |

**이 스킬은 감시를 켜고 끄지 않는다.** 감시가 도는지는 `/mmp:auto-review` 로 Monitor 를 띄웠는지로 결정되고, 파일이 알 수 있는 사실이 아니다. "감시 꺼줘"는 이 스킬이 아니라 그 Monitor 를 멈추는 일이다.

## 명령

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/bypass-review.mjs" status          # 지금 어떤 상태인지
node "${CLAUDE_PLUGIN_ROOT}/bin/bypass-review.mjs" on              # 무승인 진행
node "${CLAUDE_PLUGIN_ROOT}/bin/bypass-review.mjs" off             # 승인 받기 (기본값)
node "${CLAUDE_PLUGIN_ROOT}/bin/bypass-review.mjs" channel "팀-채널명"
```

출력은 JSON 하나다: `{ bypass, defaultChannel, updatedAt }`.

## 지켜야 할 것

**1. `on` 은 되돌릴 수 없는 행동을 자동화한다. 켤 때 한 번 확인한다.**
MR 답글은 팀에 보이고, DM은 회수되지 않는다. `on` 으로 바꾸기 전에 그 사실과 현재 기본 채널을 말하고 승인을 받는다. `off` 로 돌리는 건 안전한 방향이므로 그냥 실행한다.

**2. 상태를 바꾼 뒤에는 반드시 결과를 보고한다.**
`status` 출력의 `bypass` 와 `defaultChannel` 을 그대로 말한다. "켰습니다"로 끝내지 마라 — 사용자가 확인할 수 있는 건 그 두 값뿐이다.

**3. 감시가 도는지 같이 알려준다.**
모드를 바꿨는데 감시 Monitor 가 이 세션에 없으면, 바뀐 정책이 당장 아무 데도 적용되지 않는다. 그럴 땐 한 줄 덧붙인다: "지금 이 세션에 감시가 없으니 `/mmp:auto-review` 로 띄우거나, `/mmp:mr-review <MR링크>` 를 직접 쓸 때 적용됩니다."

**4. 승인 면제이지 검증 면제가 아니다.**
`bypass` 여도 하네스는 그대로 돈다 — 단계 순서, 보류 카테고리·코드 위치 인용, 중복 게시 차단, `glab mr approve`/`merge` 금지. 사용자가 "검사도 끄자"고 하면 그건 이 스킬이 하는 일이 아니라고 말한다.

**5. 기본 채널은 코드에 없다.**
초기값이 하나 박혀 있을 뿐이고 `channel` 로 언제든 바꾼다. 사용자가 다른 팀 채널을 말하면 그 값을 그대로 저장한다.
