# 로컬 리뷰 수신함

MMP의 기존 stdio MCP와 Mattermost 기능을 유지하면서 GitLab 요청을 로컬 수신함에 보관합니다. 수신함은 수집·조회 단계입니다. 별도 `review_context_prepare`의 GitLab/Jira 조회와 등록 팀원의 작업 맥락·주간 요약은 [팀 작업 맥락](TEAM-CONTEXT.md)에 설명합니다. 수신함부터 코드 리뷰·댓글·작성자 알림까지의 실행은 [자동 리뷰](AUTO-REVIEW.md)를 설정해 활성화합니다. 웹훅 누락을 복구하는 5분 API 폴링은 아직 포함하지 않습니다.

## 구성

```text
GitLab 이벤트 → HTTP 수신기 → reviews.sqlite3 ← 로컬 stdio MCP
```

- MCP: 기존 `npm start`, 새 도구 `review_inbox_status`, `review_pending_list`
- 수신기: `npm run webhook:serve`
- 상태 확인: `GET http://127.0.0.1:8765/health`
- 이벤트 수신: `POST http://127.0.0.1:8765/webhooks/gitlab`
- 저장 위치: 기존 MMP와 같은 `~/.mmp/`, 또는 `MATTERMOST_MCP_DATA_DIR`
- 기존 설정은 `mattermost.sqlite3`, 리뷰 수신함은 `reviews.sqlite3`에 보관

수신기는 `127.0.0.1`에만 연결됩니다. 이 주소를 GitLab 웹훅 URL에 넣어도 외부 GitLab에서 PC에 도달하지 않습니다. 공개 수신 주소를 준비하기 전에는 아래 로컬 검증만 수행합니다. 실제 GitLab 버전과 HTTPS 경로를 확인한 뒤 수신 인증 방식도 대조해야 합니다.

## 설치와 검증

Node.js 22.13 이상이 필요합니다. 현재 로컬 검증은 Node.js 24에서 진행합니다.

```powershell
npm ci --ignore-scripts
npm test
npm run smoke
npm run smoke:review
```

`smoke:review`는 임시 데이터 폴더와 임의의 테스트 토큰을 사용합니다. 실제 GitLab·Jira·Mattermost에는 접속하지 않습니다. HTTP 인증, SQLite 저장, stdio MCP 조회, 동일 이벤트 재전송, 추적 MR의 새 커밋을 한 흐름으로 확인합니다.

## 수신기 설정

`.env.example`은 변수 목록이며 자동으로 읽지 않습니다. 값을 실행 환경에 설정해야 합니다. 실제 토큰은 채팅·로그·Git에 남기지 않습니다.

| 변수 | 용도 |
|---|---|
| `MATTERMOST_MCP_DATA_DIR` | MCP와 수신기가 공유할 데이터 폴더, 생략 시 `~/.mmp/` |
| `REVIEWBOT_GITLAB_USERNAME` | 감지할 GitLab 사용자명, `@` 제외 |
| `REVIEWBOT_GITLAB_USER_ID` | 감지할 GitLab 숫자 사용자 ID |
| `REVIEWBOT_GITLAB_BOT_USER_ID` | 자체 댓글 감지에서 제외할 게시 계정 ID, 선택 |
| `REVIEWBOT_GITLAB_PROJECT_IDS` | 허용 프로젝트 숫자 ID, 쉼표 구분 |
| `REVIEWBOT_WEBHOOK_SECRET` | `X-Gitlab-Token`과 대조할 16~512자 토큰 |
| `REVIEWBOT_PORT` | 로컬 수신 포트, 기본 `8765` |

설명·댓글의 멘션 감지에는 사용자명이 필요하고, 리뷰어의 안정적인 연결에는 숫자 ID도 함께 설정하는 것을 권장합니다. 실행 프로세스 간 환경변수는 자동으로 공유되지 않으므로, 데이터 폴더를 바꾼다면 양쪽을 같은 위치로 설정해야 합니다.

가상 사용자와 가상 프로젝트로 수신기만 실행하는 예시입니다. 실제 연결 정보로 해석하지 않습니다.

```powershell
$env:REVIEWBOT_GITLAB_USERNAME = 'reviewer'
$env:REVIEWBOT_GITLAB_USER_ID = '42'
$env:REVIEWBOT_GITLAB_PROJECT_IDS = '100'
$env:REVIEWBOT_WEBHOOK_SECRET = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
npm run webhook:serve
```

## 현재 처리 규칙

- MR 설명 멘션, MR 댓글 멘션, 리뷰어 지정 중 하나로 추적을 시작합니다.
- 추적 중인 MR은 새 커밋이 오면 최신 SHA로 대기 요청을 갱신합니다.
- Draft는 추적만 하고 준비 상태가 되면 대기열에 넣습니다. 닫힘·머지는 대기 요청을 취소합니다.
- 같은 이벤트와 같은 코드 버전의 대기 요청은 중복 생성하지 않습니다.
- 재시작 후에도 SQLite의 추적·대기 기록을 유지합니다.
- 웹훅 이벤트 원문 코드·댓글·MR 제목·이메일은 이벤트 수신 기록에 저장하지 않습니다. 자동 worker의 실행 기록에는 재시작을 위해 검증한 리뷰 결과와 게시 영수증을 비공개로 저장합니다.
- 오래된 이벤트로 코드 버전이 되돌아가지 않도록 MR 갱신 시각을 비교합니다. 자동 worker는 자료 수집과 게시 전에 GitLab API로 현재 MR·SHA를 다시 확인합니다.

인증 실패는 `401`, 잘못된 본문은 `400`, 본문 크기 초과는 `413`, JSON 이외 본문은 `415`, 설정 미완료는 `503`입니다. 이 단계의 대기열 조회는 리뷰 완료나 외부 게시를 의미하지 않습니다.
