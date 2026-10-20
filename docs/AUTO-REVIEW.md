# 웹훅부터 코드 리뷰·MR 댓글·Mattermost DM까지

자동 worker는 GitLab 웹훅으로 저장한 요청을 선점하고, 현재 코드와 최신 Jira 관점을 검토한 뒤 MR 댓글과 작성자 DM까지 처리합니다. 기본값은 비활성입니다. `REVIEWBOT_AUTO_REVIEW=1`로 켜면 대상 요청마다 게시 확인을 다시 묻지 않습니다. MR 승인·머지 API는 호출하지 않습니다.

## 1. 처리 흐름

```text
인증된 GitLab 웹훅
  → reviews.sqlite3 요청 저장
  → worker claim + lease
  → glab: 실제 MR 주소·현재 SHA·전체 diff·변경 전후 파일·설명·댓글
  → Jira 최신화 + 등록 팀원 관점 + 관련 누적 리뷰 기록
  → Claude Code CLI: 도구 없이 자료 검토
  → 판정·공개 댓글·비공개 memory 검증
  → 비공개 누적 기록 저장
  → 현재 열린 MR·비draft·SHA·lease 재확인
  → 기존 댓글 확인 또는 새 MR 댓글 게시
  → 작성자 Mattermost DM
  → 완료
```

요청 조건은 MR 설명의 `@멘션`, 댓글의 `@멘션`, 리뷰어 지정입니다. 추적을 시작한 MR은 새 커밋 웹훅으로 다시 검토합니다. 수신 계정과 게시 계정이 다르면 각각의 사용자 ID를 설정합니다. 게시 계정은 `REVIEWBOT_GITLAB_BOT_USER_ID`에 등록해 자신의 댓글로 루프가 생기지 않도록 합니다.

웹훅의 저장소 URL이나 경로는 명령 실행에 사용하지 않습니다. 설정한 `REVIEWBOT_GITLAB_HOST`와 허용 프로젝트 숫자 ID로 GitLab API를 조회하고 실제 MR 신원을 확인합니다. 한 설치의 데이터 디렉터리는 한 GitLab 호스트를 기준으로 사용합니다.

## 2. 필요한 계정과 프로그램

기본 설치는 [README](../README.md)의 Node.js·Jira·팀원 등록·수신기 설정을 먼저 완료합니다. 자동 처리에는 다음 설정이 더 필요합니다.

| 항목 | 확인할 내용 |
|---|---|
| `glab` | worker를 실행할 OS 계정에서 대상 호스트에 로그인. MR·코드·댓글 읽기와 MR 댓글 작성 권한 |
| Claude Code CLI | 같은 OS 계정에서 로그인. 기본 명령은 `claude`, Windows는 실제 `.exe` 실행 파일 권장 |
| Jira | 네 환경변수 설정, 팀원 1명 이상 등록, MR 작성자의 GitLab 계정을 프로필에 연결 |
| Mattermost | Incoming Webhook, 활성 논리 채널, 작성자의 GitLab→Mattermost 참가자 매핑, `review-complete` 템플릿 |
| 공개 HTTPS 경로 | GitLab 웹훅이 같은 데이터 디렉터리를 쓰는 로컬 수신기에 도착하는 경로 |

자동 리뷰는 설치한 CLI의 기존 인증과 사용량을 사용합니다. 별도 모델 API 키를 이 서버에 등록할 필요는 없습니다. 모델 서비스에는 수집한 코드·MR 논의·Jira·누적 기록이 전달됩니다. CLI의 인증 방식과 데이터 처리 정책은 해당 실행 환경을 기준으로 적용됩니다.

CLI는 임시 작업 폴더에서 `--safe-mode`, `--restricted`, 도구 비활성, 빈 MCP 구성, 세션 미보관 설정으로 실행합니다. 저장소 훅이나 검토 자료에 적힌 명령을 실행하는 흐름은 제공하지 않습니다. 조직에서 강제한 CLI 설정·hook은 설치자가 확인해야 합니다. 사용 중인 CLI가 필요한 옵션을 지원하지 않으면 작업을 실패 처리하며 다른 권한 모드로 자동 전환하지 않습니다. [CLI 옵션](https://code.claude.com/docs/en/cli-reference), [관리 hook 설정](https://code.claude.com/docs/en/hooks#disable-or-remove-hooks).

```sh
glab --version
claude --version
glab auth status --hostname gitlab.example.com
```

Windows에서 `claude`가 `.cmd` 또는 PowerShell 스크립트로만 잡히면 `REVIEWBOT_REVIEW_COMMAND`에 실제 실행 파일의 절대 경로를 지정합니다. 이 값에는 실행 파일 하나만 적으며 추가 인수나 셸 명령을 붙이지 않습니다.

## 3. Mattermost 매핑

[README 13절](../README.md#13-mattermost-설정)에서 웹훅·논리 채널·사람·템플릿을 등록합니다. 예를 들어 논리 채널이 `team-reviews`, MR 작성자의 GitLab 사용자명이 `member.a.gitlab`이면 참가자를 다음처럼 연결합니다.

`participant_create`:

```json
{
  "display_name": "팀원 A",
  "mattermost_username": "member.a",
  "gitlab_username": "member.a.gitlab",
  "is_self": false
}
```

`convention_create`:

```json
{
  "name": "review-complete",
  "template": "{{mention}} :review_complete_shake: !{{mr_number}} | [{{jira_key}}] {{message}}"
}
```

이미 등록한 템플릿을 바꾸려면 `convention_update`를 사용합니다. 실제 DM은 참가자의 `mattermost_username`으로 전송합니다. `REVIEWBOT_MATTERMOST_CHANNEL`은 이 전송에 사용할 웹훅의 논리 채널 이름이며 팀 채널에 공개 리뷰를 올리는 대상이 아닙니다. 채널이 활성 상태이고 연결 웹훅이 DM 목적지를 허용해야 합니다.

알림에는 판정·검토한 SHA·게시 댓글 링크를 넣습니다. Jira 개인별 작업 원문·코드·내부 memory JSON은 DM으로 보내지 않습니다. 기존 리뷰 템플릿은 Jira키 자리도 요구하므로 연결 이슈가 없을 때는 미연결 표시를 사용합니다. 필수 변수와 한 줄 형식 검사는 기존 Mattermost 서비스가 적용합니다.

팀 프로필과 Mattermost 참가자 등록은 별개입니다. `team_member_upsert`만 호출하면 DM 매핑이 생기지 않으며 참가자만 등록하면 Jira 관점이 생기지 않습니다. 같은 표시 이름이라는 이유로 자동 연결하지 않습니다.

## 4. 환경변수

소스 루트의 `.env`에 다음 값을 자신의 환경으로 설정합니다. 기존 Jira·수신기 설정도 그대로 필요합니다.

```dotenv
MATTERMOST_MCP_DATA_DIR="C:/Users/YOUR_USER/.reviewbot/team-a"

REVIEWBOT_GITLAB_HOST=gitlab.example.com
REVIEWBOT_GITLAB_PROJECT_IDS=100,200
REVIEWBOT_GITLAB_USERNAME=your.review.account
REVIEWBOT_GITLAB_USER_ID=123
REVIEWBOT_GITLAB_BOT_USER_ID=456

REVIEWBOT_AUTO_REVIEW=1
REVIEWBOT_MATTERMOST_CHANNEL=team-reviews
REVIEWBOT_REVIEW_COMMAND=claude
REVIEWBOT_REVIEW_TIMEOUT_MS=180000
REVIEWBOT_WORKER_INTERVAL_MS=5000
```

| 변수 | 의미 |
|---|---|
| `MATTERMOST_MCP_DATA_DIR` | 수신기·MCP·별도 worker가 공유할 비공개 절대 경로 |
| `REVIEWBOT_GITLAB_HOST` | 단일 GitLab 호스트명과 선택 포트. 프로토콜·경로 제외 |
| `REVIEWBOT_GITLAB_PROJECT_IDS` | 자동 처리를 허용한 숫자 프로젝트 ID 목록 |
| `REVIEWBOT_AUTO_REVIEW` | `1`이면 활성화. 미설정·빈 값·`0`이면 비활성, 다른 값은 설정 오류 |
| `REVIEWBOT_MATTERMOST_CHANNEL` | 작성자 DM 웹훅을 찾는 기존 논리 채널 이름 |
| `REVIEWBOT_REVIEW_COMMAND` | CLI 실행 파일, 기본 `claude` |
| `REVIEWBOT_REVIEW_TIMEOUT_MS` | 리뷰 CLI 제한 시간, 기본 180,000ms |
| `REVIEWBOT_WORKER_INTERVAL_MS` | 로컬 대기열 확인 간격, 기본 5,000ms |

`.env`는 자동으로 읽지 않습니다. 아래 실행 명령처럼 Node `--env-file`로 전달하거나 서비스의 환경변수에 설정합니다. 운영 설정과 사용자별 기록은 Git에 올리지 않습니다.

## 5. 실행 방법

### MCP 서버에 포함해 실행

MCP 클라이언트가 같은 `.env`를 읽고 `src/server.js`를 시작하도록 설정한 뒤 재시작합니다. 자동 처리가 활성화되면 background worker도 시작합니다. MCP는 stdio를 사용하므로 터미널의 이 프로세스에 로그를 입력하거나 HTTP로 접속하지 않습니다.

```sh
node --env-file=.env src/server.js
```

실제 MCP 클라이언트에는 소스와 `.env`의 절대 경로를 등록합니다. [README의 연결 예시](../README.md#6-mcp-클라이언트에-연결)를 사용합니다.

### 별도 worker로 실행

MCP 클라이언트의 실행 여부와 분리해 worker만 실행할 수 있습니다.

```sh
node --env-file=.env bin/review-worker.mjs
```

환경변수를 이미 서비스가 전달한다면 다음도 같습니다.

```sh
npm run worker:serve
```

웹훅 수신기는 계속 별도로 실행합니다.

```sh
node --env-file=.env bin/gitlab-webhook.mjs
```

MCP 내부 worker와 별도 worker가 동시에 있어도 같은 SQLite에서는 lease로 요청 하나를 선점합니다. 데이터 경로가 다르거나 SQLite를 여러 서버의 공유 드라이브로 연결한 구성에는 적용하지 않습니다. 이 저장소는 Windows 서비스·systemd·공개 HTTPS 터널을 자동 설치하지 않습니다.

worker를 끄려면 `REVIEWBOT_AUTO_REVIEW=0`으로 바꾸고 실행 프로세스를 재시작합니다. 수신기는 계속 요청을 저장할 수 있습니다. 이미 보낸 댓글이나 DM은 설정을 끈다고 삭제되지 않습니다.

## 6. 저장·단계·재시작

`reviews.sqlite3`의 `review_executions`가 요청별 실행 상태를 보관합니다. 같은 프로젝트·MR·SHA의 완료 작업은 반복하지 않습니다. 새 SHA는 별도 요청으로 처리합니다. stage와 artifact를 checkpoint로 저장해 모델 리뷰를 끝낸 뒤 게시만 실패했다면 저장한 결과부터 재개합니다.

| 단계 | 의미와 복구 |
|---|---|
| `queued` | 검토 전. 현재 열린 MR·비draft·SHA가 요청과 맞을 때 시작 |
| `reviewing` | 자료 수집·Jira 최신화·모델 검토 진행 중. 중단되면 최신 자료로 다시 수행 |
| `reviewed` | 구조 검증한 리뷰 결과 보관, 비공개 누적 저장과 댓글 게시 전 |
| `posting` | 게시를 시도하는 중. 재시작하면 자신의 기존 댓글 식별자를 먼저 조회 |
| `posted` | 게시 댓글 확인 완료. MR이 닫히거나 새 SHA가 있어도 이 댓글의 알림을 완료할 수 있음 |
| `notifying` | DM 전송 직전 checkpoint. 중단 시 전달 여부를 추정하지 않음 |
| `notification_unknown` | 전달 여부 불명. 자동 재전송 없이 최종 실패로 남김 |
| `completed` | 파이프라인 종료. 실제 댓글·알림 여부는 보존한 단계와 처리 결과로 구분 |

lease가 만료되면 다른 worker가 저장한 stage와 artifact를 가져올 수 있습니다. 이전 소유자는 lease를 잃으면 checkpoint나 외부 쓰기를 계속할 수 없습니다. 게시 전에는 대기열의 최신 상태와 GitLab의 현재 상태를 둘 다 확인합니다. 일반 실패는 기본 최대 5회까지 1분부터 늘어나는 백오프로 재시도하며, 불완전한 자료·지원하지 않는 파일·게시 충돌·불명 알림은 자동 재시도를 멈춥니다.

댓글에는 호스트·프로젝트·MR·SHA에 고정된 숨은 식별자를 붙입니다. 게시 성공 직후 프로세스가 종료돼도 다음 시도는 현재 인증 계정의 기존 댓글을 찾아 재사용합니다. 같은 식별자에 다른 본문이 있거나 댓글이 여러 개면 자동 수정·추가 게시하지 않고 실패 처리합니다. 계정을 바꿔 실행하면 기존 게시 계정의 소유권 확인이 달라지므로 진행 중 작업의 게시 계정을 유지합니다.

`posting` 복구에서 기존 댓글이 있으면 새 SHA·닫힌 상태여도 그 댓글의 알림으로 진행할 수 있습니다. 기존 댓글이 없고 MR이 이미 바뀌었으면 이전 SHA의 댓글을 새로 만들지 않고 종료합니다.

게시 전 무효화된 작업은 `skipped`로 정리합니다. 이후 더 최신인 열린 비draft 웹훅이 도착하면 같은 SHA라도 검토를 다시 대기시킬 수 있습니다. 이미 게시·알림까지 완료한 리뷰는 이 재개 대상이 아닙니다. 같은 시각이나 오래된 스냅샷은 건너뛴 실행을 되살리지 않습니다.

## 7. 조회와 실패 복구

MCP `review_worker_status`:

```json
{"limit":20}
```

설정·실행 상태와 최근 작업의 `requestId`, `stage`, `status`, `attempt`, `lastErrorCode`, `nextAttemptAt`를 확인합니다. 상태 목록에는 리뷰 본문·Jira 원문·인증값이 포함되지 않습니다. `running`은 선점 중, `retry`는 백오프 대기, `completed`는 종료, `failed`는 자동 재시도를 멈춘 상태입니다.

설정·인증·매핑 문제를 고친 후 `review_job_retry`로 최종 실패 작업을 다시 대기시킵니다.

```json
{"request_id":123}
```

`notifying` 또는 `notification_unknown`에서 실패했다면 실제 DM의 도착 여부를 먼저 확인합니다. 중복 알림 가능성을 받아들이고 다시 보낼 때만 다음처럼 호출합니다.

```json
{"request_id":123,"allow_notification_duplicate":true}
```

이 선택은 해당 작업을 `posted` 단계로 되돌려 알림만 재시도하도록 합니다. 댓글을 새로 만들거나 이미 완료한 리뷰를 다시 수행하는 설정이 아닙니다. 알림이 이미 도착했다면 이 호출로 같은 알림이 다시 전달될 수 있습니다. 아직 자동 처리 중이거나 완료한 작업은 수동 재시도할 수 없습니다.

## 8. 자료 범위와 한계

- 모든 변경 파일의 diff와 base/head 내용을 읽습니다. 페이지 상한·자료 크기 제한·생략 diff·binary·submodule·UTF-8이 아닌 변경을 만나면 부분 검토를 성공 처리하지 않습니다.
- GitLab 자료 기본 한도는 1,000,000 UTF-8 bytes입니다. CLI 입력은 최신 팀 맥락까지 포함해 최대 2MiB, stdout/stderr는 각각 최대 200,000 bytes, 기본 실행 제한은 180초입니다. Jira 자체의 이슈·이력·설명 한도는 [팀 작업 맥락](TEAM-CONTEXT.md)의 생략 표시를 유지합니다.
- CLI는 코드·명령·테스트를 실행하지 않습니다. 테스트 성공을 직접 확인한 결과로 남기지 않습니다. MR 작성자가 보고한 결과는 `reported`, 미확인은 `unknown`으로 남깁니다.
- 변경되지 않은 호출부나 저장소 전체를 자동 탐색하지 않습니다. 변경 파일과 제공한 근거만 정적으로 검토하므로 자료 밖 동작은 미확인으로 남깁니다.
- 결정 이유는 기존 MR 설명·댓글·Jira 진술에 근거가 있을 때만 기록합니다. 확인하지 못한 이유는 `reason: null`입니다. MR 양식을 바꿀 필요는 없습니다.
- 자동 리뷰는 제목·설명·소스 브랜치에서 Jira키를 연결합니다. 키가 없으면 MR·SHA·변경 파일 기준으로 누적하며 Jira 완료 조건을 추정하지 않습니다.
- 비공개 누적 기록의 `reviewed`는 코드 검토 저장을 뜻합니다. 댓글 게시나 DM 전송 성공은 수신함의 worker 실행 상태에서 따로 관리합니다.
- 새 커밋·닫힘·draft 웹훅을 받거나 게시 직전 GitLab에서 이를 확인하면 오래된 댓글의 새 게시를 막습니다. 이미 게시한 댓글을 자동 삭제하지 않습니다.
- worker의 5초 확인은 로컬 대기열 조회입니다. GitLab API 5분 폴링, 웹훅 누락 복구, 상시 서비스·공개 수신 주소 설치는 포함하지 않습니다.

## 9. 검증 범위

테스트는 임시 SQLite·가상 웹훅·모의 GitLab/Jira/모델/Mattermost 응답을 사용합니다. 실제 운영 계정으로 코드 읽기·댓글 게시·DM 도착을 확인하지 않았습니다. 설치 후에는 본인에게 허용된 시험 MR로 HTTPS 수신, 대상 계정, 댓글 작성 권한, CLI 인증·자료 한도, DM 정책을 확인합니다. 검증 중 실제 외부 쓰기를 원하지 않으면 자동 활성화 값을 `0`으로 유지합니다.

2026-10-20 기준 전체 테스트 218개 중 217개 통과·실패 0개·Windows 파일 링크 권한으로 1개 생략, MCP 도구 34개 smoke와 수신기 smoke가 통과했습니다. 설치한 CLI의 필요한 옵션 지원은 확인했으며 실제 모델 호출은 수행하지 않았습니다.

주요 검증 명령은 저장소 루트에서 실행합니다.

```sh
npm test
npm run smoke
npm run smoke:review
```
