# 웹훅부터 코드 리뷰·MR 댓글·Mattermost DM까지

자동 worker는 GitLab 웹훅으로 저장한 요청을 선점하고, 현재 코드와 최신 Jira 관점을 검토한 뒤 MR 댓글과 작성자 DM까지 처리합니다. 기본값은 비활성입니다. `REVIEWBOT_AUTO_REVIEW=1`로 켜면 대상 요청마다 게시 확인을 다시 묻지 않습니다. MR 승인·머지 API는 호출하지 않습니다.

## 1. 처리 흐름

```text
인증된 GitLab 웹훅
  → reviews.sqlite3 요청 저장
  → worker claim + lease
  → glab: 실제 MR 주소·현재 SHA·전체 diff·변경 전후 파일·설명·댓글
  → Jira 최신화 + 등록 팀원 관점 + 관련 누적 리뷰 기록
  → 선택한 Codex CLI 또는 Claude Code CLI: 수집한 자료의 정적 검토
  → 판정·공개 댓글·비공개 memory 검증
  → 비공개 누적 기록 저장
  → 현재 열린 MR·비draft·SHA·lease 재확인
  → 기존 댓글 확인 또는 새 MR 댓글 게시
  → 작성자 Mattermost DM
  → 완료
```

요청 조건은 MR 설명의 `@멘션`, 댓글의 `@멘션`, 리뷰어 지정입니다. 추적을 시작한 MR은 새 커밋 웹훅으로 다시 검토합니다. 수신 계정과 게시 계정이 다르면 각각의 사용자 ID를 설정합니다. 게시 계정은 `REVIEWBOT_GITLAB_BOT_USER_ID`에 등록해 자신의 댓글로 루프가 생기지 않도록 합니다.

개인 계정을 함께 쓰면 `REVIEWBOT_GITLAB_USER_ID`와 `REVIEWBOT_GITLAB_BOT_USER_ID`를 같은 값으로 설정합니다. 본인이 쓴 MR 댓글의 자기 멘션도 요청으로 받되, 봇의 `<!-- reviewbot:... -->` 식별 표시가 있는 같은 계정의 댓글은 생성·수정 모두 제외합니다. 봇 댓글의 식별 표시는 유지하세요. 별도 봇 계정을 사용하는 경우 그 계정의 댓글은 모두 무시합니다. 완료한 같은 SHA는 자기 멘션을 다시 달아도 재실행하지 않습니다.

웹훅의 저장소 URL이나 경로는 명령 실행에 사용하지 않습니다. 설정한 `REVIEWBOT_GITLAB_HOST`와 허용 프로젝트 숫자 ID로 GitLab API를 조회하고 실제 MR 신원을 확인합니다. 한 설치의 데이터 디렉터리는 한 GitLab 호스트를 기준으로 사용합니다.

## 2. 필요한 계정과 프로그램

기본 설치는 [README](../README.md)의 Node.js·Jira·팀원 등록·수신기 설정을 먼저 완료합니다. 자동 처리에는 다음 설정이 더 필요합니다.

| 항목 | 확인할 내용 |
|---|---|
| `glab` | worker를 실행할 OS 계정에서 대상 호스트에 로그인. MR·코드·댓글 읽기와 MR 댓글 작성 권한 |
| Codex CLI 또는 Claude Code CLI | 같은 OS 계정에서 선택한 CLI 로그인. provider별 기본 명령은 `codex`·`claude`, Windows는 실제 `.exe` 실행 파일 권장 |
| Jira | 네 환경변수 설정, 팀원 1명 이상 등록, MR 작성자의 GitLab 계정을 프로필에 연결 |
| Mattermost | Incoming Webhook, 활성 논리 채널, 작성자의 GitLab→Mattermost 참가자 매핑, `review-complete` 템플릿 |
| 공개 HTTPS 경로 | GitLab 웹훅이 같은 데이터 디렉터리를 쓰는 로컬 수신기에 도착하는 경로 |

자동 리뷰는 설치한 CLI의 기존 인증과 사용량을 사용합니다. 별도 모델 API 키를 이 서버에 등록할 필요는 없습니다. 모델 서비스에는 수집한 코드·MR 논의·Jira·누적 기록이 전달됩니다. CLI의 인증 방식과 데이터 처리 정책은 해당 실행 환경을 기준으로 적용됩니다.

자동 리뷰는 현재 열려 있는 대화를 재개하지 않고 매번 별도 비대화 CLI 실행으로 처리합니다. 같은 계정으로 로그인해도 현재 대화 전체가 자동으로 전달되지는 않습니다. 이전 맥락은 같은 비공개 데이터 디렉터리에 쌓인 Jira·MR 기록에서 다시 읽으며, provider를 바꿔도 기존 기록과 댓글·DM 복구 상태를 유지합니다.

Codex를 사용하려면 worker를 실행할 OS 계정에서 다음을 실행합니다. 로그인 화면의 계정으로 인증하며 인증 파일·토큰을 채팅이나 저장소로 복사하지 않습니다. [공식 비대화 실행 안내](https://learn.chatgpt.com/docs/non-interactive-mode)와 [CLI 명령 안내](https://learn.chatgpt.com/docs/developer-commands?surface=cli)를 참고하세요.

```sh
glab --version
codex --version
codex login
codex login status
glab auth status --hostname gitlab.example.com
```

Codex 선택 설정은 다음과 같습니다. 기존 `.env`가 `REVIEWBOT_REVIEW_COMMAND=claude`로 되어 있으면 provider와 함께 명령도 비우거나 `codex`로 바꿉니다. 진행 중인 작업을 확인하고 기존 worker 프로세스를 종료한 뒤 설정을 변경하고 재시작합니다. MCP 서버 안의 worker도 같은 변경을 적용하려면 MCP 서버를 재시작해야 합니다. `.env`를 수정하는 것만으로 실행 중인 프로세스의 설정이 바뀌지는 않습니다.

```dotenv
REVIEWBOT_REVIEW_PROVIDER=codex
REVIEWBOT_REVIEW_COMMAND=
REVIEWBOT_REVIEW_MODEL=
```

`REVIEWBOT_REVIEW_MODEL`은 선택 인수입니다. 비우면 CLI가 기본 모델을 선택합니다. Codex 자동 실행은 사용자 설정을 무시하므로 사용자 `config.toml`의 모델 설정을 그대로 사용한다고 가정하지 않습니다. 특정 모델을 사용하려면 해당 계정에서 허용한 모델 ID를 적습니다. 이 설정은 MCP 대화의 모델 선택을 바꾸지 않습니다.

Claude를 계속 쓰려면 `REVIEWBOT_REVIEW_PROVIDER=claude`를 선택하고 `claude --version`과 CLI 로그인을 확인합니다. provider를 미설정하거나 비우면 기존 설치와의 호환을 위해 `claude`를 사용합니다. 새 `.env.example`은 `codex`를 명시합니다.

Windows에서 `codex`·`claude`가 `.cmd` 또는 PowerShell 스크립트로만 잡히면 `REVIEWBOT_REVIEW_COMMAND`에 실제 실행 파일의 절대 경로를 지정합니다. 이 값에는 실행 파일 하나만 적으며 추가 인수나 셸 명령을 붙이지 않습니다.

두 provider 모두 비공개 임시 작업 폴더에서 실행하고 검토 자료는 stdin으로 전달합니다. Codex는 `exec --ignore-user-config --ignore-rules --ephemeral`, 읽기 전용 sandbox, 승인 요청 비활성, 구조화 출력을 사용합니다. 셸·웹 검색·앱·훅·플러그인·보조 에이전트·스킬 검색·Code Mode 등도 비활성화 설정을 전달합니다. 출력에 명령·도구 실행 이벤트가 있으면 결과를 게시하지 않고 실패 처리합니다. 이 설정이 CLI의 모든 내장 도구 제거를 보장하거나 읽기 전용 sandbox가 파일 읽기까지 막는다는 뜻은 아닙니다. 사용자 설정 무시는 시스템·조직의 관리 설정 전체 제거도 보장하지 않습니다. 검토 자료가 민감하거나 관리형 연결 기능이 있으면 전용 OS 계정·격리 환경의 접근 범위도 설정하세요.

Codex 시작 과정의 Code Mode 호스트 비활성 안내는 확인된 두 고정 문구(`Falling back to direct tools` 또는 `Code mode will fail closed`) 중 하나만 검토 턴 시작 전에 한 번 허용합니다. 문구 전체가 정확히 일치해야 하며, 반복되거나 턴이 시작된 뒤 나오는 안내는 거부합니다. 개별 기능 비활성·읽기 전용 설정과 완료된 JSON 결과 검증은 유지하며, 그 외 경고·오류·유사 문구·도구 실행 이벤트는 검토 결과로 받아들이지 않습니다.

Claude는 `--safe-mode`, `--restricted`, 도구 비활성, 빈 MCP 구성, 세션 미보관 설정으로 실행합니다. 저장소 훅이나 검토 자료에 적힌 명령을 실행하는 흐름은 제공하지 않습니다. 조직에서 강제한 CLI 설정·hook은 설치자가 확인해야 합니다. 필요한 옵션을 지원하지 않거나 허용되지 않은 실행 이벤트를 반환하면 작업을 실패 처리하며 다른 provider나 권한 모드로 자동 전환하지 않습니다. [Claude CLI 옵션](https://code.claude.com/docs/en/cli-reference), [관리 hook 설정](https://code.claude.com/docs/en/hooks#disable-or-remove-hooks).

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
REVIEWBOT_REVIEW_PROVIDER=codex
REVIEWBOT_REVIEW_COMMAND=
REVIEWBOT_REVIEW_MODEL=
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
| `REVIEWBOT_REVIEW_PROVIDER` | `codex`·`claude`만 허용. 새 설정 예시는 `codex`, 미설정·빈 값은 `claude` |
| `REVIEWBOT_REVIEW_COMMAND` | CLI 실행 파일. 비우면 선택한 provider의 명령 이름 |
| `REVIEWBOT_REVIEW_MODEL` | 선택한 CLI의 모델 ID. 비우면 CLI의 기본 모델 선택 |
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

설정·실행 상태와 최근 작업의 `requestId`, `stage`, `status`, `attempt`, `lastErrorCode`, `lastErrorMessage`, `nextAttemptAt`를 확인합니다. `lastErrorMessage`는 고정된 안전한 설명이며 CLI 출력·리뷰 본문·Jira 원문·인증값을 복사하지 않습니다. `running`은 선점 중, `retry`는 백오프 대기, `completed`는 종료, `failed`는 자동 재시도를 멈춘 상태입니다. `running`에 남은 오류 코드는 이전 시도의 실패일 수 있으므로 현재 단계·시도 번호도 확인합니다.

| 오류 코드 | 확인된 실패 구간 |
|---|---|
| `input_too_large`, `runner_configuration_invalid` | 입력 크기 또는 실행기 설정 검증 |
| `runner_start_failed`, `runner_input_failed`, `runner_output_failed` | 시작·입력 전달·출력 스트림 처리 |
| `runner_output_limit`, `runner_timeout`, `runner_cancelled` | 출력 크기·실행 시간 제한 또는 취소 |
| `runner_exit_failed` | CLI 비정상 종료. 인증·한도·지원 인수 중 어느 것인지는 이 코드만으로 확정하지 않음 |
| `runner_response_invalid` | 완료 이벤트·허용된 이벤트 형식·JSON 해석 검사 |
| `unsupported_content` | 지원하지 않는 바이너리·인코딩·서브모듈 또는 이미지와 텍스트 간 형식 전환 |
| `no_reviewable_text` | 이미지 제외 후 검토할 코드·텍스트가 없어 자동 리뷰 중단 |
| `notification_setup_missing` | 활성 알림 채널 또는 작성자의 GitLab·Mattermost 수신자 연결 누락/중복. 설정 후 명시적 재시도 필요 |
| `review_author_unmapped` | 작성자의 GitLab 계정과 팀원 프로필 연결 누락. 팀원 등록 후 명시적 재시도 필요 |
| `review_result_invalid`, `review_body_invalid`, `review_sections_invalid` | 리뷰 JSON 구조·공개 본문·필수 섹션 및 판정 형식 |
| `review_context_invalid`, `review_locations_invalid` | 작업 맥락 인용 또는 실제 코드 파일·줄 근거 |
| `review_memory_invalid`, `review_test_claim_invalid` | 누적 기록의 출처·형식 또는 실행하지 않은 검증의 직접 확인 주장 |
| `review_step_failed` | 상세 구분이 없는 처리 오류. 이 코드만으로 과거의 실제 원인을 추정하지 않음 |

실패를 보고할 때 요청·MR·단계와 함께 확인된 오류 설명, 재시도 상태, 댓글·알림 전송 여부를 구분합니다. 오래된 공통 오류 코드에 새 분류를 소급 적용해 원인을 확인한 것으로 쓰지 않습니다.

설정·인증·매핑 문제를 고친 후 `review_job_retry`로 최종 실패 작업이나 백오프 대기 중인 작업을 지금 다시 대기시킵니다. 명시적인 호출은 시도 횟수를 초기화하고 저장한 완료 단계를 유지합니다. 정기 상태 확인에서는 백오프를 임의로 앞당기지 않습니다.

```json
{"request_id":123}
```

`notifying` 또는 `notification_unknown`에서 실패했다면 실제 DM의 도착 여부를 먼저 확인합니다. 중복 알림 가능성을 받아들이고 다시 보낼 때만 다음처럼 호출합니다.

```json
{"request_id":123,"allow_notification_duplicate":true}
```

이 선택은 해당 작업을 `posted` 단계로 되돌려 알림만 재시도하도록 합니다. 댓글을 새로 만들거나 이미 완료한 리뷰를 다시 수행하는 설정이 아닙니다. 알림이 이미 도착했다면 이 호출로 같은 알림이 다시 전달될 수 있습니다. `running` 또는 `completed` 작업은 수동 재시도할 수 없습니다.

## 8. 자료 범위와 한계

- 모든 변경 파일 목록과 diff의 누락 여부를 확인하고, 코드·텍스트 파일의 base/head 내용을 읽습니다. 페이지 상한·자료 크기 제한·생략 diff·지원하지 않는 바이너리·submodule·UTF-8이 아닌 텍스트 변경은 부분 검토를 성공 처리하지 않습니다.
- GitLab이 파일 diff를 `collapsed=true`로 접으면 `/changes?access_raw_diffs=true`로 원본 diff를 한 번 조회해 해당 파일을 복구합니다. 원래 목록의 모든 파일 경로·변경 종류·모드와 MR·head/base/start SHA가 일치하고 `overflow=false`일 때만 사용하며, 복구된 diff도 기존 자료 크기 제한과 최종 head 확인을 거칩니다. `too_large=true`이거나 복구 후에도 접힘·누락·불일치가 있으면 중단합니다. 이 대체 경로는 [GitLab REST API v4의 원본 변경 조회](https://docs.gitlab.com/api/merge_requests/#retrieve-merge-request-changes)를 사용합니다. 해당 경로는 API v5에서 제거 예정이므로 향후 API 전환 시 교체가 필요하며, 일반 `/diffs` 응답이 완전하면 호출하지 않습니다.
- JPEG(`.jpg`, `.jpeg`)·PNG·GIF·WebP·ICO는 확장자와 바이너리 헤더가 일치하면 `excludedImages`로 분리합니다. 경로·변경 종류·base/head 크기·SHA-256·형식만 전달하고 이미지 바이트·Base64는 리뷰 입력에서 제외합니다. 이미지는 메타데이터만 전체 자료 한도에 포함하지만 기존 파일당 크기 제한은 유지합니다. 단순히 확장자를 바꾼 파일·확장자와 헤더 불일치·이미지와 텍스트 간 전환은 제외로 우회하지 않습니다. SVG는 UTF-8 XML 코드로 검토하며 렌더링하지 않습니다.
- 이미지와 코드·문서가 함께 있으면 텍스트 변경의 리뷰·기록·댓글·알림을 진행합니다. 댓글의 `확인한 범위`에 이미지 미검토 건수를 실행기가 자동으로 추가합니다. 이미지의 내용·외관을 확인한 것으로 쓰거나 이미지 경로를 읽은 코드 근거로 기록하지 않습니다. 이미지뿐인 MR은 `no_reviewable_text`로 종료하며, 승인 댓글이나 완료 알림을 만들지 않습니다. 이미지 내용을 검토하려면 별도의 시각 검토가 필요합니다.
- GitLab 자료 기본 한도는 1,000,000 UTF-8 bytes입니다. CLI 입력은 최신 팀 맥락까지 포함해 최대 2MiB, stdout/stderr는 각각 최대 200,000 bytes, 기본 실행 제한은 180초입니다. Jira 자체의 이슈·이력·설명 한도는 [팀 작업 맥락](TEAM-CONTEXT.md)의 생략 표시를 유지합니다.
- CLI에는 수집 자료의 정적 검토만 요청합니다. 테스트 성공을 직접 확인한 결과로 남기지 않으며 직접 실행 성공·실패를 주장한 결과도 검증에서 거부합니다. 코드와 요구사항을 읽고 대조한 사실은 구현 근거에 기록하며 검증을 실행한 결과로 바꾸지 않도록 공유 검토 지침에 명시했습니다. MR 작성자가 보고한 결과는 `reported`, 미확인은 `unknown`으로 남깁니다. Codex의 도구 비활성 설정과 이벤트 검사는 CLI 자체의 모든 도구 제거를 보장하지 않습니다.
- 변경되지 않은 호출부나 저장소 전체를 자동 탐색하지 않습니다. 변경 파일과 제공한 근거만 정적으로 검토하므로 자료 밖 동작은 미확인으로 남깁니다.
- 비공개 데이터 디렉터리의 [명세 셀 JSON](PROJECT-SPECIFICATION.md)을 등록하면 같은 GitLab 호스트·전체 프로젝트 경로의 리뷰 준비에 등록된 모든 셀을 전달합니다. 원본 파일명·해시·시트·셀을 근거로 필수·선택·후속 범위와 데이터 정의를 대조합니다. XLSX 자체나 외부 링크를 자동으로 읽지는 않으며, 수식·하이퍼링크는 실행하지 않습니다. 파일이 없으면 기존 동작을 유지하지만 손상·초과 크기·잘못된 형식의 등록은 부분 자료로 검토하지 않고 준비를 실패 처리합니다. 복구한 뒤 필요한 작업을 다시 준비·재시도합니다.
- 공통 검토 지침은 미설정·온보딩 건너뜀·오류 상태의 동선과 복구 수단, 업무 분류의 의미, API·집계·화면의 단위 및 분자·분모를 대조합니다. 필수 동선을 막는 결함은 작성자가 후속 작업이라고 적었어도 검토합니다. 실제 경로나 명세가 입력에 없으면 부재·불일치를 확정하지 않으며, 확인한 조건과 미확인 조건을 구분합니다. 문서·시트의 이름이나 링크만으로 원문 내용을 확인한 것으로 간주하지 않습니다.
- 결정 이유는 기존 MR 설명·댓글·Jira 또는 전달된 명세 셀의 진술에 근거가 있을 때만 기록합니다. 명세 근거는 현재 전달된 셀의 `source.name#시트명!셀주소`로 한정하며 명세만으로 테스트 실행 성공을 기록하지 않습니다. 확인하지 못한 이유는 `reason: null`입니다. MR 양식을 바꿀 필요는 없습니다.
- 자동 리뷰는 제목·설명·소스 브랜치에서 찾은 후보 중 설정된 Jira 프로젝트의 키만 연결합니다. `SHA-256` 같은 기술 용어와 다른 프로젝트 참조는 조회하지 않고 제외 개수를 맥락에 표시합니다. MCP에서 명시한 `jira_keys`는 기존대로 엄격히 조회합니다. 연결 키가 없으면 MR·SHA·변경 파일 기준으로 누적하며 Jira 완료 조건을 추정하지 않습니다.
- 비공개 누적 기록의 `reviewed`는 코드 검토 저장을 뜻합니다. 댓글 게시나 DM 전송 성공은 수신함의 worker 실행 상태에서 따로 관리합니다.
- 새 커밋·닫힘·draft 웹훅을 받거나 게시 직전 GitLab에서 이를 확인하면 오래된 댓글의 새 게시를 막습니다. 이미 게시한 댓글을 자동 삭제하지 않습니다.
- worker의 5초 확인은 로컬 대기열 조회입니다. GitLab API 5분 폴링, 웹훅 누락 복구, 상시 서비스·공개 수신 주소 설치는 포함하지 않습니다.

## 9. 검증 범위

자동화된 테스트는 임시 SQLite·가상 웹훅·모의 GitLab/Jira/모델/Mattermost 응답을 사용합니다. 각 설치의 운영 계정·주소·권한·DM 정책은 별도로 검증해야 합니다. 설치 후에는 본인에게 허용된 시험 MR로 HTTPS 수신, 대상 계정, 댓글 작성 권한, CLI 인증·자료 한도, DM 정책을 확인합니다. 검증 중 실제 외부 쓰기를 원하지 않으면 자동 활성화 값을 `0`으로 유지합니다.

2026-10-21 기준 전체 테스트 266개 중 265개 통과·실패 0개·Windows 파일 링크 권한으로 1개 생략, MCP 도구 34개 smoke와 수신기 smoke가 통과했습니다. Codex·Claude 각각의 모의 CLI로 실제 HTTP 웹훅·stdio MCP·리뷰·기록·댓글·DM 연결을 확인했습니다. 코드·이미지 혼합 MR에서 이미지 바이트 제외와 댓글의 미검토 범위 고지·중복 방지도 검증했습니다. Codex 통합 검증에는 실제로 확인한 `Code mode will fail closed` 시작 안내 순서도 포함합니다.

Codex CLI `0.154.0`의 기존 ChatGPT 로그인으로 합성 코드와 합성 Jira 요구사항을 전달해 실제 리뷰도 실행했습니다. 수량 0에서 예외를 요구하지만 0을 반환하는 코드를 `hold`로 판단했고, 구현 기록 1개·검증 기록 1개를 포함한 결과가 `normalizeReviewResult`를 통과했습니다. 이 확인에는 실제 GitLab·Jira·Mattermost 조회나 쓰기를 사용하지 않았습니다. 운영 프로젝트의 실제 댓글 게시·DM 도착은 별도 검증 대상입니다.

주요 검증 명령은 저장소 루트에서 실행합니다.

```sh
npm test
npm run smoke
npm run smoke:review
```

프롬프트의 결함 탐지 품질은 합성 자료로 별도 평가합니다. 미설정 시 막힌 동선·분류 설명의 의미 불일치·집계 단위 불일치가 있는 예제, 이를 수정한 예제, 판단 근거가 부족한 예제를 비교합니다. 실제 CLI 호출은 기존 로그인과 사용량을 사용하며, GitLab·Jira·Mattermost나 누적 리뷰 기록에는 쓰지 않습니다. `npm test`에서는 실제 모델을 호출하지 않습니다.

공유 검토 지침은 전체 전달 파일의 현재 코드를 점검한 뒤, 각 후보를 정상 계약·상위 검증·호출부·예외 처리와 대조하는 반증 점검을 요구합니다. 보류는 현재 요구·지원 입력 또는 외부 신뢰 경계에서 도달하는 재현 조건, 깨지는 계약, 실제 영향과 MR의 인과관계가 제공 자료로 확인되는 결함으로 제한합니다. 대표값만 선택하기·불필요한 행 무시·허용된 기본값 같은 정상 계약을 새 검증 요구로 바꾸지 않습니다. 추가 방어·선호 설계·희귀한 가정만 있는 경계 사례는 보류 근거가 아니며, 자료 부족은 미확인 범위로 표시합니다. 외부 입력에서 악용 가능한 보안·데이터 훼손은 입력이 비정상이라는 이유만으로 제외하지 않습니다.

같은 MR의 후속 리뷰는 `이전 리뷰 대비`에서 해결 확인·미해결·추가 발견을 구분하고, 과거 코드 근거가 없으면 발생 시점은 미확인으로 남깁니다. 과거 지적 자체를 요구사항으로 취급하지 않으며, 근거가 부족하거나 현재 계약과 충돌하면 `이전 판단 정정`으로 철회 이유를 설명합니다. 권고와 미확인은 확정 미해결 결함으로 누적하지 않습니다. 이는 한 번의 모델 호출 안에서 수행하는 정적 점검 지침이며 독립된 두 실행이나 모든 결함 탐지의 보장은 아닙니다. 본문 형식·근거 검증만으로 검토의 완전성을 자동 판정할 수는 없습니다.

`batch-broken`은 네 파일에 있는 독립 결함 다섯 개를 한 번에 찾는지 평가합니다. `batch-followup`은 기존 지적 세 개를 고친 후에도 남은 두 개를 찾고 해결한 지적을 반복하지 않는지, `batch-fixed`는 모두 수정한 뒤 불필요하게 보류하지 않는지 확인합니다. 여러 결함 중 하나라도 놓치면 해당 평가는 실패합니다. 예를 들어 `node --env-file=.env scripts/review-quality-eval.mjs --run --case batch-broken --case batch-followup --case batch-fixed`로 이 세 사례만 실행할 수 있습니다.

`accepted-behavior`는 첫 대표값 선택과 뒤쪽 메모 무시가 명시적으로 허용된 코드를 승인하고, 전체 행 검증을 요구한 과거 지적을 정정하는지 검사합니다. `representative-regression`은 같은 계약에서 첫 값 대신 마지막 값을 반환하도록 깨뜨린 경우를 보류해야 통과합니다. 탐지 사례와 정상 사례를 함께 유지해 지적 수를 늘리거나 무조건 승인하는 쪽으로 평가가 치우치지 않도록 합니다.

2026-10-22 보류 기준 조정 후 실제 CLI에서 위 정상·회귀 두 사례와 기존 `broken`·`batch-broken`을 실행해 네 사례 모두 기대 조건을 통과했습니다. 정상 사례는 승인·과거 판단 정정, 회귀 사례는 대표값 결함 보류, 기존 결함판은 각각 세 개·다섯 개 대상 탐지를 확인했습니다. 과거에 게시된 실제 MR 지적을 일괄 오탐으로 판정한 결과는 아니며, 실사용 오탐 여부는 당시 계약과 해당 SHA의 코드로 확인해야 합니다.

```sh
node scripts/review-quality-eval.mjs
node --env-file=.env scripts/review-quality-eval.mjs --run
```

첫 명령은 합성 자료의 구조를 검사합니다. `--run`은 선택한 provider로 실제 정적 리뷰를 실행해 탐지와 오탐을 확인합니다. 이 평가의 통과가 모든 실제 MR의 결함 탐지를 보장하지는 않습니다. 근거 문서와 연결 코드가 입력에 제공되는지도 함께 관리하세요.

2026-10-20의 최종 합성 자료로 실제 CLI 평가를 실행해 결함판의 세 대상 모두를 코드 위치와 함께 탐지했고, 수정판과 근거 부족판도 각 기대 판정을 통과했습니다. 한 번의 실행 결과이므로 모델·프롬프트·자료를 바꿀 때 다시 확인합니다. 근거 부족판의 허위 주장 검사는 제한된 표현 패턴을 사용하며 모든 잘못된 표현을 판별하지는 못합니다.

2026-10-22에는 전체 파일·유사 실패 경로·응답 전 누락 점검 지침을 추가했습니다. 실제 CLI 평가에서 기존 세 사례와 새 일괄 검토 세 사례의 기대 조건을 확인했습니다. 최초 실행에서 점 표기 식을 파일명으로 오인하는 위치 검증 오류가 드러나, 이를 수정한 뒤 거부됐던 결함판 두 사례를 재실행해 각각 세 대상·다섯 대상을 모두 탐지했습니다. 코드 식을 설명한 것만으로 리뷰를 버리지 않되, 각 확정 지적에는 수집된 실제 파일 근거가 필요하며 명시한 줄 번호도 범위를 검사합니다. 이 결과는 합성 사례의 검증이며 실제 프로젝트의 모든 결함을 찾는다는 뜻은 아닙니다.
