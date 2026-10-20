# Review Bot for SSAFY

GitLab MR의 변경 내용과 팀원의 Jira 작업 맥락을 함께 검토하기 위한 로컬 MCP 서버입니다. 팀원별 담당 영역·작업 이력을 보관하고, 리뷰 직전에 최신 자료를 모아 리뷰를 수행하는 대화에 전달합니다. Mattermost 메시지 관리·전송과 GitLab 웹훅 수신함도 제공합니다.

이 프로젝트는 [kdHyeok/MMP](https://github.com/kdHyeok/MMP/tree/943ae776026daa4ec8d230f0fb65ddd35ea8c6f2)를 확장했습니다. 호환성을 위해 패키지·플러그인 이름 `mmp`를 유지합니다. 확장 소스는 [baekseunghak/Review-Bot-For-SSAFY](https://github.com/baekseunghak/Review-Bot-For-SSAFY)에서 받으세요. 원본 MMP만 설치하면 새 Jira·수신함 도구가 포함되지 않습니다.

## 목차

- [1. 현재 사용할 수 있는 기능](#1-현재-사용할-수-있는-기능)
- [2. 동작 구조](#2-동작-구조)
- [3. 준비물과 설정 순서](#3-준비물과-설정-순서)
- [4. 소스 설치와 로컬 검증](#4-소스-설치와-로컬-검증)
- [5. 환경변수 설정](#5-환경변수-설정)
- [6. MCP 클라이언트에 연결](#6-mcp-클라이언트에-연결)
- [7. GitLab 계정과 프로젝트 확인](#7-gitlab-계정과-프로젝트-확인)
- [8. Jira Cloud 연결](#8-jira-cloud-연결)
- [9. 팀원과 담당 영역 등록](#9-팀원과-담당-영역-등록)
- [10. Jira 동기화와 월요일 주간 요약](#10-jira-동기화와-월요일-주간-요약)
- [11. 작업 맥락을 사용해 MR 리뷰하기](#11-작업-맥락을-사용해-mr-리뷰하기)
- [12. GitLab 웹훅 수신기 연결](#12-gitlab-웹훅-수신기-연결)
- [13. Mattermost 설정](#13-mattermost-설정)
- [14. 기존 Claude Code 리뷰 흐름](#14-기존-claude-code-리뷰-흐름)
- [15. 전체 MCP 도구](#15-전체-mcp-도구)
- [16. 저장 위치와 백업](#16-저장-위치와-백업)
- [17. 문제 해결](#17-문제-해결)
- [18. 업데이트와 제거](#18-업데이트와-제거)
- [19. 개발과 공개 저장소 준비](#19-개발과-공개-저장소-준비)

## 1. 현재 사용할 수 있는 기능

| 기능 | 현재 상태 |
|---|---|
| 로컬 stdio MCP | 구현됨. 도구 30개 제공 |
| Mattermost 웹훅·채널·사람·템플릿 관리와 메시지 전송 | 구현됨. 실제 전송에는 별도 설정 필요 |
| GitLab 웹훅 수신·인증·중복 제거·SQLite 수신함 | 구현됨. 별도 수신 프로세스 실행 필요 |
| MR 설명 멘션·댓글 멘션·리뷰어 지정 감지 | 구현됨. 지정한 계정과 허용 프로젝트에 적용 |
| 추적 중인 MR의 새 커밋 요청 갱신 | 수신한 웹훅 기준 구현됨 |
| 팀원 계정·담당 영역·리뷰 초점 등록 | 구현됨. 인원 상한 없음 |
| Jira 현재/과거 담당 작업과 상태·담당자 이력 수집 | 구현됨. Jira Cloud REST API v3 사용 |
| 개인별 월요일 요약과 재시작 보충 실행 | 구현됨. MCP 프로세스 생존 필요 |
| 리뷰 직전 MR·Jira 최신화와 등록 팀원의 관점 구성 | 구현됨. `review_context_prepare` 사용 |
| 새 수신함 → 모델 리뷰 → MR 댓글 → Mattermost 전체 자동 처리 | 아직 연결되지 않음 |
| 새 수신함의 5분 API 폴링·웹훅 누락 복구 | 아직 구현되지 않음 |
| 공개 HTTPS 수신 주소·호스팅·상시 서비스 설치 | 사용자가 별도 준비 |

**팀 관점 리뷰와 주간 요약에는 팀원을 1명 이상 등록해야 합니다.** 등록 인원에 고정 상한은 없으며, 사용할 대상 팀원을 등록하면 됩니다. 등록된 팀원이 0명이면 리뷰 준비와 주간 요약을 시작할 수 없습니다. 여러 Jira 프로젝트·서로 다른 GitLab 인스턴스를 하나의 팀으로 묶는 구성은 지원하지 않습니다.

인원 상한이 없다는 것은 무제한 성능을 보장한다는 뜻이 아닙니다. 인원이 늘면 Jira 조회량과 처리 시간이 늘며, 이슈·페이지·설명 길이·도구 실행 시간 제한은 그대로 적용됩니다.

별도 모델 API 키는 이 서버의 필수 설정이 아닙니다. 코드를 읽고 판단하는 일은 연결된 MCP 클라이언트의 대화가 수행합니다. 서버가 독립적으로 모델을 실행하지는 않습니다.

## 2. 동작 구조

```text
GitLab ── 웹훅 POST ──> 공개 HTTPS 프록시/터널 ──> 로컬 수신기
                                                     │
                                              reviews.sqlite3
                                                     │
MCP 클라이언트 <── stdio ──> MCP 서버 ────────────────┘
                                │
                                ├── glab: MR 작성자·SHA·변경 경로
                                ├── Jira Cloud: 작업·상태/담당 이력
                                ├── SQLite + 개인별 Markdown 기록
                                └── Mattermost: 설정한 메시지 전송
```

- **MCP 서버**: `src/server.js`. MCP 클라이언트가 로컬 프로세스로 시작합니다. HTTP 접속 주소는 없습니다.
- **웹훅 수신기**: `bin/gitlab-webhook.mjs`. 별도 터미널/서비스에서 실행하며 기본 주소는 `http://127.0.0.1:8765`입니다.
- 두 프로세스의 `MATTERMOST_MCP_DATA_DIR`를 같은 절대 경로로 맞춥니다. 같은 사용자 PC 안에서 SQLite를 공유하는 구조입니다.
- 웹훅 수신 성공은 리뷰 완료를 뜻하지 않습니다. 수신함과 실제 리뷰 수행은 현재 별도 단계입니다.
- 공개 GitHub에는 프로그램과 예시만 올립니다. 운영 토큰·개인별 업무 기록·SQLite는 각 설치 환경에 보관합니다.

## 3. 준비물과 설정 순서

### 요구 환경

| 항목 | 필요한 기능 | 확인 방법 |
|---|---|---|
| Node.js 22.13 이상, 권장 24 | 모든 기능. 내장 `node:sqlite` 사용 | `node --version` |
| npm | 의존성 설치·검증 | `npm --version` |
| Git | 설치, 실제 코드 검토와 워크트리 | `git --version` |
| 로컬 stdio를 지원하는 MCP 클라이언트 | MCP 도구 사용 | 클라이언트의 MCP 설정 확인 |
| GitLab CLI `glab` | 실제 MR 맥락 조회, 기존 리뷰 하네스 | `glab --version` |
| GitLab 계정과 대상 프로젝트 읽기 권한 | MR 조회·코드 검토 | [7절](#7-gitlab-계정과-프로젝트-확인) |
| Jira Cloud 계정·API 토큰·프로젝트 키 | 작업 동기화·주간 요약·팀 관점 리뷰 | [8절](#8-jira-cloud-연결) |
| Mattermost Incoming Webhook | 메시지를 보낼 때만 필요 | [13절](#13-mattermost-설정) |
| GitLab에서 접근 가능한 HTTPS 주소 | 실제 웹훅을 받을 때만 필요 | [12절](#12-gitlab-웹훅-수신기-연결) |

현재 자동 테스트는 Windows + Node.js 24에서 확인했습니다. macOS·Linux용 명령도 제공하지만 운영 환경별 실행 검증은 별도로 진행하세요.

### 처음 설정할 때의 순서

1. 소스를 받고 로컬 테스트를 실행합니다. 외부 계정 없이 가능합니다.
2. `.env.example`을 `.env`로 복사하고 자신의 Jira·데이터 경로를 설정합니다.
3. MCP 클라이언트가 `node --env-file=... src/server.js`를 실행하도록 연결합니다.
4. GitLab 로그인과 Jira 계정 ID를 확인합니다.
5. `team_member_upsert`로 사용할 팀원을 1명 이상 등록합니다.
6. `team_sync` → `team_member_context` → `team_weekly_summary`를 확인합니다.
7. MR 한 건에 `review_context_prepare`를 호출해 코드 리뷰에 적용합니다.
8. 필요하면 웹훅 수신기와 Mattermost를 각각 연결합니다.

Jira만 먼저 연결해도 됩니다. Mattermost 설정이나 공개 수신 주소가 없어도 팀 작업 동기화와 MR 맥락 준비를 사용할 수 있습니다.

## 4. 소스 설치와 로컬 검증

이 확장 저장소를 클론합니다. 클론 경로와 검토할 프로젝트 저장소는 서로 달라도 됩니다.

```sh
git clone https://github.com/baekseunghak/Review-Bot-For-SSAFY.git reviewbot-mcp
cd reviewbot-mcp
npm ci
npm test
npm run smoke
npm run smoke:review
```

| 명령 | 확인하는 것 |
|---|---|
| `npm test` | 원본 기능, Jira·팀 저장소·주간 요약·리뷰 단계, 로컬 HTTP/stdio 통합 |
| `npm run smoke` | 별도 stdio 프로세스의 도구 30개와 기본 호출 |
| `npm run smoke:review` | 인증된 가상 웹훅 → SQLite → stdio 조회, 중복과 새 커밋 |

테스트는 임시 데이터와 모의 응답을 사용합니다. 운영 GitLab·Jira·Mattermost에 댓글·메시지를 보내지 않습니다. Windows에서 파일 심볼릭 링크 권한이 없으면 해당 검사 1개가 생략될 수 있습니다.

이후 예시는 소스를 Windows에서는 `C:/work/reviewbot-mcp`, macOS·Linux에서는 `/home/you/work/reviewbot-mcp`에 설치했다고 가정합니다. **명령과 설정의 경로는 실제 설치 위치로 바꾸세요.**

## 5. 환경변수 설정

### 5-1. 비공개 설정 파일 만들기

Windows PowerShell:

```powershell
Copy-Item -LiteralPath .env.example -Destination .env
notepad .env
```

macOS·Linux:

```bash
cp .env.example .env
chmod 600 .env
${EDITOR:-vi} .env
```

`.env`는 Git에서 제외됩니다. 파일을 공유 설정이나 이슈에 붙여 넣지 마세요. 아래 예시의 값은 모두 형식 설명용입니다.

```dotenv
MATTERMOST_MCP_DATA_DIR="C:/Users/YOUR_USER/.reviewbot/team-a"

REVIEWBOT_JIRA_BASE_URL=https://your-team.atlassian.net
REVIEWBOT_JIRA_EMAIL=you@example.com
REVIEWBOT_JIRA_API_TOKEN="REPLACE_WITH_YOUR_TOKEN"
REVIEWBOT_JIRA_PROJECT_KEY=TEAM

REVIEWBOT_GITLAB_USERNAME=your.gitlab.username
REVIEWBOT_GITLAB_USER_ID=123
REVIEWBOT_GITLAB_BOT_USER_ID=456
REVIEWBOT_GITLAB_PROJECT_IDS=100,200
REVIEWBOT_WEBHOOK_SECRET="REPLACE_WITH_RANDOM_SECRET"
REVIEWBOT_PORT=8765
```

macOS·Linux에서는 데이터 경로를 `/home/you/.reviewbot/team-a`처럼 바꿉니다. `~`, `$HOME`, `${변수명}`이 자동 치환된다고 가정하지 말고 **실제 절대 경로**를 적으세요. 공백이나 `#`가 포함된 값은 따옴표로 감쌉니다. 사용하지 않는 선택 값은 비워 둡니다.

### 5-2. 변수별 의미

| 변수 | 필수 시점 | 설정할 값 / 기본값 |
|---|---|---|
| `MATTERMOST_MCP_DATA_DIR` | 선택, 명시 권장 | 비공개 데이터 폴더. 생략하면 사용자 홈의 `.mmp` |
| `REVIEWBOT_JIRA_BASE_URL` | Jira 사용 | Jira Cloud 사이트 루트. `/browse`나 `/rest/api/3`를 붙이지 않음 |
| `REVIEWBOT_JIRA_EMAIL` | Jira 사용 | API 토큰을 발급한 계정의 이메일 |
| `REVIEWBOT_JIRA_API_TOKEN` | Jira 사용 | Jira API 토큰. 계정 비밀번호가 아님 |
| `REVIEWBOT_JIRA_PROJECT_KEY` | Jira 사용 | `TEAM` 같은 프로젝트 키. 기본값 없음 |
| `REVIEWBOT_GITLAB_USERNAME` | 설명·댓글 멘션 수신 | 감지할 계정의 사용자명, `@` 제외 |
| `REVIEWBOT_GITLAB_USER_ID` | 리뷰어 지정 수신 권장 | 같은 계정의 숫자 사용자 ID |
| `REVIEWBOT_GITLAB_BOT_USER_ID` | 선택 | 자체 댓글을 무시할 게시 계정 ID. 게시 계정이 감지 계정과 같으면 같은 값 |
| `REVIEWBOT_GITLAB_PROJECT_IDS` | 웹훅 수신 | 허용할 GitLab 숫자 프로젝트 ID를 쉼표로 구분. 비우면 수신 비활성 |
| `REVIEWBOT_WEBHOOK_SECRET` | 웹훅 수신 | GitLab Secret token과 동일한 16~512자 공백 없는 ASCII 문자열 |
| `REVIEWBOT_PORT` | 선택 | 로컬 수신 포트. 기본 `8765` |
| `MATTERMOST_MCP_ALLOW_HTTP` | 선택 | 신뢰하는 로컬 Mattermost가 HTTP만 쓸 때 `1`. 기본 HTTPS |

GitLab 환경변수는 **웹훅에서 누구의 요청을 감지할지** 정합니다. 팀원 프로필 등록을 대신하지 않습니다. GitLab 토큰도 이 변수에 넣지 않으며 실제 MR 조회 인증은 `glab`이 관리합니다.

### 5-3. 설정 파일을 실제로 읽게 하기

프로그램이 `.env`를 자동으로 찾지는 않습니다. 이 문서는 Node의 `--env-file`로 명시적으로 읽는 방법을 사용합니다.

```sh
node --env-file=.env src/server.js
```

위 명령은 HTTP 서버를 열지 않습니다. stdio 입력을 기다리므로 터미널에 출력이 없어도 이상한 것이 아닙니다. 평소에는 [6절](#6-mcp-클라이언트에-연결)처럼 MCP 클라이언트가 이 프로세스를 시작하게 합니다.

이미 실행 중인 프로세스의 환경변수는 `.env`를 수정해도 바뀌지 않습니다. 변경 후 MCP 서버와 수신기를 다시 시작하세요. 셸에서 동일한 변수를 이미 설정했다면 Node의 env-file 값보다 셸 값이 우선하므로 이전 값을 제거하거나 맞춰야 합니다. [Node env-file 문서](https://nodejs.org/api/cli.html#--env-filefile).

## 6. MCP 클라이언트에 연결

처음에는 **소스 경로를 직접 등록하는 방식**을 권장합니다. 서버와 `.env` 경로를 모두 절대 경로로 지정하면 클라이언트의 현재 작업 폴더에 영향을 받지 않습니다. 같은 서버를 플러그인과 직접 등록 방식으로 중복 연결하지 마세요.

### 6-1. Codex 설정 파일

사용자 설정 파일 `~/.codex/config.toml`의 기존 내용을 유지하고 다음 서버 항목을 추가합니다. Windows에서는 일반적으로 `%USERPROFILE%/.codex/config.toml`입니다.

```toml
[mcp_servers.reviewbot]
command = "C:/Program Files/nodejs/node.exe"
args = [
  "--env-file=C:/work/reviewbot-mcp/.env",
  "C:/work/reviewbot-mcp/src/server.js"
]
startup_timeout_sec = 10
tool_timeout_sec = 300
```

- `command`는 PowerShell의 `(Get-Command node).Source`로 확인한 경로를 사용합니다.
- macOS·Linux는 `command -v node`의 결과와 자신의 절대 경로로 바꿉니다.
- `reviewbot`은 연결 이름입니다. 내부 서버 이름 `mmp`와 달라도 됩니다.
- env-file을 사용하므로 토큰을 TOML의 `env`에 직접 복사할 필요가 없습니다.
- 새 작업을 열거나 MCP 연결을 다시 시작하고 `team_member_list`, `review_inbox_status`가 보이는지 확인합니다.

CLI로 먼저 등록할 수도 있습니다. 실행 위치는 소스 루트입니다.

```powershell
$reviewbotNode = (Get-Command node).Source
$reviewbotRoot = (Get-Location).Path
$reviewbotEnvFile = Join-Path $reviewbotRoot '.env'
$reviewbotServer = Join-Path $reviewbotRoot 'src/server.js'
codex mcp add reviewbot -- $reviewbotNode "--env-file=$reviewbotEnvFile" $reviewbotServer
codex mcp get reviewbot
```

CLI로 등록한 경우에도 해당 TOML 항목의 `tool_timeout_sec = 300`을 확인하세요. Jira 초기 동기화는 오래 걸릴 수 있습니다. 환경변수를 직접 전달하려면 공식 문서의 `env_vars` 설정을 사용하고 토큰을 명령행에 적지 않습니다. [공식 MCP 설정](https://developers.openai.com/codex/mcp/), [설정 필드](https://developers.openai.com/codex/config-reference/)를 참고하세요.

### 6-2. Claude Code에 MCP만 등록

Windows PowerShell, 소스 루트에서:

```powershell
$reviewbotNode = (Get-Command node).Source
$reviewbotRoot = (Get-Location).Path
$reviewbotEnvFile = Join-Path $reviewbotRoot '.env'
$reviewbotServer = Join-Path $reviewbotRoot 'src/server.js'
claude mcp add --transport stdio --scope user reviewbot -- $reviewbotNode "--env-file=$reviewbotEnvFile" $reviewbotServer
claude mcp get reviewbot
```

macOS·Linux:

```bash
claude mcp add --transport stdio --scope user reviewbot -- \
  "$(command -v node)" "--env-file=$(pwd)/.env" "$(pwd)/src/server.js"
claude mcp get reviewbot
```

새 세션의 `/mcp`에서 확인합니다. 이 방법은 MCP 도구를 등록하며 `/mmp:mr-review` 같은 스킬·훅은 설치하지 않습니다. 플러그인 방식은 [14절](#14-기존-claude-code-리뷰-흐름)을 참고하세요. [Claude Code 공식 MCP 문서](https://code.claude.com/docs/en/mcp).

### 6-3. 다른 stdio MCP 클라이언트

해당 클라이언트의 로컬 MCP 설정에 다음 구조를 넣고 경로를 바꿉니다. 설정 파일 위치와 시간 제한 필드 이름은 클라이언트 문서를 따릅니다.

```json
{
  "mcpServers": {
    "reviewbot": {
      "command": "C:/Program Files/nodejs/node.exe",
      "args": [
        "--env-file=C:/work/reviewbot-mcp/.env",
        "C:/work/reviewbot-mcp/src/server.js"
      ]
    }
  }
}
```

`http://127.0.0.1:8765`를 MCP 서버 URL로 넣으면 연결되지 않습니다. 그 포트는 GitLab 이벤트 수신 전용입니다.

## 7. GitLab 계정과 프로젝트 확인

`glab`을 설치하고 **MR이 있는 GitLab 호스트**에 로그인합니다. `gitlab.com`과 사내 GitLab은 서로 다른 호스트입니다.

```sh
glab auth login --hostname gitlab.example.com
glab auth status --hostname gitlab.example.com
glab api user --hostname gitlab.example.com --jq '{id, username}'
glab api projects/group%2Frepository --hostname gitlab.example.com --jq '{id, path_with_namespace}'
```

마지막 명령의 `group%2Frepository`는 `group/repository`를 URL 인코딩한 예시입니다. 하위 그룹이 있으면 모든 `/`를 `%2F`로 바꿉니다.

확인한 `username`, 숫자 사용자 `id`, 숫자 프로젝트 `id`를 `.env`의 GitLab 항목에 적습니다. `!42` 같은 MR 번호는 프로젝트 ID가 아닙니다. 팀원 ID는 각 팀원의 정확한 계정 정보로 확인하여 등록합니다.

MR 읽기에는 프로젝트의 MR·변경 파일 읽기 권한이 필요합니다. Git 코드 fetch 권한도 별도로 확인하세요. 기존 하네스로 댓글을 게시하려면 댓글 작성 권한도 필요합니다. 브라우저 로그인만으로 로컬 `glab` 인증이 완료되지는 않습니다. [glab 인증 안내](https://docs.gitlab.com/cli/auth/login/), [API 명령](https://docs.gitlab.com/cli/api/).

검토할 코드 저장소는 별도로 클론합니다. README의 설치 저장소는 리뷰봇 소스이며 검토 대상 코드가 아닙니다.

## 8. Jira Cloud 연결

현재 지원 방식은 **Jira Cloud 사이트 주소 + 계정 이메일 + API 토큰의 Basic 인증**입니다. Jira Data Center/Server의 사용자명 인증, OAuth 연결, 다른 Jira MCP의 기존 로그인 상태는 재사용하지 않습니다.

1. Jira Cloud 계정에서 API 토큰을 준비합니다. 비밀번호를 넣지 않습니다.
2. 토큰 소유 계정이 대상 프로젝트와 팀원 작업을 읽을 수 있는지 확인합니다. 이슈 보안 정책에 따라 검색에서 제외되는 작업도 확인해야 합니다.
3. `.env`의 Jira 4개 항목을 모두 채웁니다. 프로젝트 키를 생략하면 연결이 미설정 상태로 남습니다.
4. 등록할 팀원 각각의 `accountId`를 확인합니다. 이메일·표시 이름·GitLab ID와 다른 값입니다.
5. MCP 프로세스를 다시 시작합니다.

계정 ID는 Jira REST API의 사용자 조회 결과 `accountId`에서 확인합니다. 본인 계정은 로그인한 브라우저에서 `https://YOUR_SITE.atlassian.net/rest/api/3/myself`를 열어 확인할 수 있습니다. 다른 팀원은 Jira 관리자 또는 사용자 조회 API로 정확한 계정을 확인하세요. 동일한 이름만 보고 연결하지 않습니다. [Jira 인증](https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/), [사용자 조회 API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-user-search/).

이 클라이언트는 설정한 사이트 아래의 `/rest/api/3/...` 경로를 호출합니다. 별도의 `api.atlassian.com/ex/jira/...` 게이트웨이·OAuth가 필요한 토큰 구성은 현재 검증하지 않았습니다. 조직의 토큰 정책과 호출 경로가 맞는지 확인하세요.

수집 범위는 현재/과거 담당 이슈의 제목·설명, 상태·담당자 이력, 컴포넌트, Sprint 정보입니다. 댓글·첨부파일·외부 문서를 따라가며 수집하지 않습니다. Jira에 기록되지 않은 설계 의도나 구현 결정을 추정하여 채우지 않습니다.

## 9. 팀원과 담당 영역 등록

아래 코드 블록은 터미널 명령이 아니라 **MCP 도구 이름과 인수 예시**입니다. 클라이언트의 도구 호출 기능이나 대화로 요청합니다. 예시의 가상 계정을 그대로 운영용으로 등록하지 마세요.

### 9-1. 한 명 등록하기

`team_member_upsert`:

```json
{
  "id": "member-a",
  "display_name": "팀원 A",
  "gitlab_username": "member.a",
  "gitlab_user_id": 101,
  "jira_account_id": "actual-account-id-a",
  "areas": ["인증", "회원"],
  "paths": ["backend/src/auth", "backend/src/member"],
  "review_focus": ["권한 검사", "인증 상태 전이", "API 호환성"]
}
```

| 항목 | 입력 기준 |
|---|---|
| `id` | 바꾸지 않을 내부 식별자. 영문·숫자·`-`·`_`. 개인 폴더 이름에도 사용 |
| `display_name` | 화면에 표시할 이름 |
| `gitlab_username` | `@`를 제외한 정확한 사용자명 |
| `gitlab_user_id` | 숫자 ID 권장. 모르면 생략 또는 `null`. 있으면 작성자 매칭에 우선 사용 |
| `jira_account_id` | Jira Cloud의 실제 `accountId` |
| `areas` | 담당 기능·도메인. 하나 이상 |
| `paths` | 검토 대상 저장소 루트 기준 담당 파일/디렉터리. 하나 이상 |
| `review_focus` | 이 영역에서 확인할 계약·실패 경로. 하나 이상 |

`paths`에 절대 경로나 `..`를 넣을 수 없습니다. `backend/src/auth`는 해당 경로와 하위 파일을 뜻하며 glob 패턴이 아닙니다. `**/*.java` 대신 실제 디렉터리를 적습니다. 공통 코드 경로는 여러 사람에게 등록할 수 있습니다.

### 9-2. 사용할 팀원 등록하기

이 작업 맥락에 사용할 팀원을 1명 이상 등록합니다. 조직의 구성원 전원을 등록할 필요는 없습니다. MR 작성자는 등록된 팀원과 연결되어야 하며, 등록하지 않은 사람의 관점은 포함되지 않습니다. 아래 세 행은 분담 방식의 예시이며 필요한 인원수로 맞추는 기준이 아닙니다.

| 내부 ID 예시 | 담당 영역 예시 | 담당 경로 예시 |
|---|---|---|
| `member-a` | 인증·회원 | `backend/src/auth` |
| `member-b` | 웹 화면·상태 | `frontend/src` |
| `member-c` | 배포·운영 | `infra`, `.github/workflows` |

`team_member_list`에 사용할 팀원이 등록되어 있는지 확인합니다. 인원 상한은 없지만 중복 GitLab/Jira 계정과 잘못된 경로는 거부합니다. 같은 `id`로 다시 호출하면 수정되며 **부분 수정이 아니므로 모든 필드를 다시 전달**합니다.

Jira 계정을 교체하면 그 사람의 현재 작업 목록과 동기화 시각이 비워집니다. 변경 후 `team_sync`를 다시 호출하거나 리뷰 준비에서 갱신하세요. 기존 이슈 원본과 과거 주간 파일은 유지합니다. 동기화 중인 프로필 변경은 거부하거나 준비를 중단하여 계정 간 업무가 섞이지 않게 합니다.

**Mattermost 사람 등록과 이 프로필은 별개입니다.** `participant_create`만 호출하면 Jira 관점은 등록되지 않으며, `team_member_upsert`만 호출해도 Mattermost 멘션·DM 매핑은 생기지 않습니다.

## 10. Jira 동기화와 월요일 주간 요약

### 10-1. 첫 동기화

다음 순서로 도구를 호출합니다.

```text
team_member_list({})
team_sync({})
team_member_context({"member_id":"member-a","offset":0,"limit":20})
team_weekly_summary({})
```

`team_sync`의 전체/개인 상태가 `fresh`인지, 개인 조회의 `sync.lastSuccessAt`이 새 시각인지 확인합니다. 미연결 상태의 빈 목록은 작업이 없다는 증거가 아닙니다. `nextOffset`이 있으면 다음 페이지도 조회합니다.

주간 요약 반환값에는 개인별 파일 `path`가 포함됩니다. 이 파일은 공개 저장소 바깥의 데이터 폴더에 저장됩니다.

### 10-2. 자동 실행과 분류 기준

MCP 서버가 **1분마다** 월요일 **09:00 Asia/Seoul** 실행 시점을 확인합니다. PC 시간대와 관계없이 KST 기준입니다.

| 분류 | 기준 |
|---|---|
| 지난주 완료 | 지난 월요일 00:00 이상 이번 월요일 00:00 미만에 완료 category로 전환. 당시 담당자에게 집계 |
| 현재 진행 | 현재 담당자이며 진행 중 category |
| 현재 스프린트 예정 | 현재 담당자이며 시작 전 category + active sprint |
| 계획 미확정 | 시작 전이지만 Sprint 필드를 확인할 수 없음 |
| 완료일 미확인 | 현재 완료이나 완료 전환 이력을 확인할 수 없음 |
| 과거 상태 분류 미확인 | 과거 상태의 category를 확인할 수 없어 집계를 확정할 수 없음 |

완료 후 다시 열린 작업에는 재개 표시를 남깁니다. Jira 완료와 코드 머지·테스트 통과는 별개입니다.

- 등록된 팀원이 1명 이상이고 Jira 연결이 준비되어 있으며 MCP 프로세스가 살아 있을 때만 자동 실행합니다.
- 앱 종료·절전·서버 종료 중에는 실행되지 않습니다. 운영체제의 상시 서비스를 설치하지는 않습니다.
- 재시작하면 가장 최근 실행 대상 주를 한 번 보충합니다. 중단 기간의 모든 과거 주를 복원하지는 않습니다.
- 완료한 주의 자동 실행은 반복하지 않습니다. 다만 새 팀원 추가로 해당 주 요약이 없는 사람이 생기면 다음 확인 시 등록 팀원을 모두 갱신하고 요약을 보충합니다.
- 실패는 기존 요약을 보존하고 15분 뒤 다시 시도합니다. 종료된 실행의 선점은 최대 30분 뒤 복구됩니다.
- `team_weekly_summary`는 수동 생성/재생성 도구입니다. 같은 주 파일은 갱신하고 이전 주 파일은 유지합니다. 월요일 09시 전에는 직전 실행 대상 주를 사용합니다.

상세한 저장·이력 기준은 [팀 작업 맥락](docs/TEAM-CONTEXT.md)에 있습니다.

## 11. 작업 맥락을 사용해 MR 리뷰하기

### 11-1. 최신 맥락 준비

`review_context_prepare`:

```json
{
  "mr_url": "https://gitlab.example.com/group/repository/-/merge_requests/42"
}
```

도구는 다음 정보를 준비합니다.

1. GitLab의 현재 작성자·커밋 SHA·전체 변경 경로를 조회합니다. 파일 이름 변경 전/후 경로도 포함합니다.
2. MR 제목·설명·소스 브랜치에서 Jira키를 찾습니다.
3. 등록된 팀원들의 현재/과거 담당 작업과 연결 이슈를 새로 조회합니다.
4. 작성자 → 변경 경로 담당자 → 나머지 배경 관점 순으로 등록 팀원의 관점을 구성합니다.
5. 마지막에 MR SHA를 다시 확인합니다. 준비 중 새 커밋이 생기면 중단합니다.

반환값의 `status`, `headSha`, `preparedAt`, `teamMemberIds`, `relatedIssues`, `perspectives`, `warnings`와 맥락 파일 `path`를 확인합니다. `teamMemberIds`는 준비 당시 등록 팀원 ID 목록이며 관점에서 빠진 팀원이 없는지 확인하는 기준입니다. 작성자 계정이 등록되어 있지 않거나 Jira 갱신이 실패하면 준비되지 않습니다. 이전 주간 요약으로 최신화를 대신하지 않습니다.

### 11-2. 실제 리뷰 요청 예시

```text
이 MR을 리뷰해줘: https://gitlab.example.com/group/repository/-/merge_requests/42
먼저 review_context_prepare로 최신 작업 맥락을 준비하고,
등록된 팀원의 담당 영역과 Jira 작업을 확인해 코드·호출부·API 계약을 검토해줘.
리뷰의 '작업 맥락'에는 실제 사용한 Jira키나 담당 영역 근거를 적어줘.
```

MCP만 직접 등록했다면 이와 같이 최신화 도구 사용을 명시하세요. 도구 등록 자체가 모든 클라이언트의 리뷰 절차를 자동으로 강제하지는 않습니다. 스킬을 사용하는 기존 하네스는 준비·기록·게시 단계에서 맥락 검사를 수행합니다.

각 관점은 사람의 능력·성향을 흉내 내는 용도가 아닙니다. 등록된 업무와 담당 영역을 기준으로 검토 범위를 넓힙니다. 공개 댓글에는 관련 근거만 적고 개인별 전체 업무 내역·로컬 경로·내부 해시는 옮기지 않습니다.

### 11-3. 현재 한계

- `review_context_prepare`는 코드를 모두 읽거나 댓글을 게시하는 도구가 아닙니다. 반환 자료를 받은 대화가 실제 코드와 관련 계약을 검토해야 합니다.
- 연결 Jira가 없으면 완료 조건 판단은 미확인으로 표시하고 코드에서 확인되는 결함을 검토합니다.
- 개인별 목록은 작성자/영향 관점 최대 12건, 배경 관점 최대 3건입니다. 추가 작업은 `team_member_context`로 조회합니다.
- 설명은 개인별 2,000자/연결 이슈 8,000자, 변경 이력은 최근 20개를 전달하고 생략을 표시합니다. 전체 원본은 비공개 이슈 파일과 Jira에서 확인합니다.
- 개인별 검색 상한은 500개, 검색/이력 각 50페이지입니다. 한도를 넘으면 성공으로 처리하지 않습니다. 초기 전체 이력 조회는 300초를 넘을 수도 있습니다.
- 같은 SHA에서 MR 설명만 바뀐 경우를 마지막에 재확인하지는 않습니다. 권한 때문에 Jira 검색에서 제외된 작업도 API 결과만으로 알아낼 수 없습니다.
- GitLab 승인·머지 버튼을 자동으로 누르지 않습니다.

## 12. GitLab 웹훅 수신기 연결

이 절은 요청을 **수집**하기 위한 설정입니다. 수신 후 자동 리뷰·게시까지 이어지는 기능은 현재 없습니다.

### 12-1. 로컬 실행

`.env`에 감지 사용자명·사용자 ID·허용 프로젝트·수신 비밀값을 채우고 소스 루트에서 실행합니다.

```sh
node --env-file=.env bin/gitlab-webhook.mjs
```

환경변수를 이미 프로세스에 전달했다면 `npm run webhook:serve`도 사용할 수 있습니다. MCP 연결과 별개로 이 프로세스를 계속 실행해야 합니다.

다른 터미널에서 확인합니다.

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:8765/health
```

macOS·Linux는 `curl http://127.0.0.1:8765/health`를 사용합니다. `200`뿐 아니라 본문의 `configured: true`를 확인하세요. `configured: false`이면 POST가 `503`으로 거부됩니다.

| 경로 | 용도 |
|---|---|
| `GET /health` | 수신기 생존·필수 설정 확인. GitLab/Jira 인증 성공까지 검사하지 않음 |
| `POST /webhooks/gitlab` | 인증된 GitLab JSON 이벤트 수신 |

### 12-2. 공개 HTTPS 경로 준비

수신기는 `127.0.0.1`에만 바인딩됩니다. GitLab 서버가 다른 컴퓨터에 있다면 이 주소에 직접 도달할 수 없습니다. 자신이 관리하는 HTTPS 리버스 프록시 또는 터널을 준비하고 다음처럼 전달합니다.

```text
https://reviewbot.example.com/webhooks/gitlab
  → http://127.0.0.1:8765/webhooks/gitlab
```

프록시는 본문과 GitLab 인증/이벤트 헤더를 보존해야 합니다. 터널·인증서·방화벽·상시 호스팅은 자동 구성하지 않습니다. 다른 호스트에 수신기만 배포하면 로컬 MCP와 SQLite가 자동 공유되지 않으므로 현재는 같은 데이터 디렉터리에 접근하는 실행 환경을 사용해야 합니다. SQLite를 여러 서버의 네트워크 공유 파일로 묶는 구성은 검증하지 않았습니다.

### 12-3. GitLab 프로젝트에 등록

프로젝트의 `Settings → Webhooks`에서 접근 가능한 HTTPS URL을 등록하고 **Merge request events**와 **Comments**를 선택합니다. Custom webhook template로 원본 payload를 바꾸지 않습니다.

현재 수신기는 `X-Gitlab-Token`과 `.env`의 `REVIEWBOT_WEBHOOK_SECRET`을 비교합니다. 해당 값은 GitLab의 **Secret token**에 동일하게 등록합니다. 최신 **Signing token / HMAC 서명 검증은 아직 지원하지 않습니다.** 조직이 서명 검증만 허용하면 현재 수신기를 그대로 연결할 수 없습니다. [GitLab 웹훅 인증 안내](https://docs.gitlab.com/user/project/integrations/webhooks/).

비밀값은 `node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"`처럼 로컬에서 만들 수 있습니다. 결과는 비공개 설정과 GitLab 설정에만 넣습니다. 프로젝트 웹훅 설정 권한이 없으면 관리자에게 설정을 요청하세요.

### 12-4. 동작 확인

등록한 계정을 대상으로 실제 MR에서 다음 중 하나를 발생시킨 뒤 `review_pending_list({"limit":20})`를 조회합니다.

1. MR 설명에 `@사용자명`을 적습니다.
2. MR 댓글에 같은 계정을 멘션합니다.
3. 해당 계정을 리뷰어로 지정합니다.

최초 추적된 열린 MR은 이후 새 커밋 이벤트로 요청을 갱신합니다. Draft는 보류하고 닫힘·머지는 대기 요청을 취소합니다. 코드 블록·인용·이메일·URL 속 멘션은 제외합니다. 봇 자신의 댓글 제외는 `REVIEWBOT_GITLAB_BOT_USER_ID`를 설정했을 때 적용됩니다. 같은 이벤트를 다시 보내도 중복 요청은 생기지 않습니다. 웹훅이 누락되면 현재 5분 폴링으로 보충되지는 않습니다.

| 응답 코드 | 의미 |
|---|---|
| `202` | 이벤트 처리 완료. 본문의 status가 queued/ignored/held 등인지 별도 확인 |
| `200` | 중복 이벤트 또는 정상 health 조회 |
| `400` | 잘못된 JSON/payload/필수 헤더 |
| `401` | Secret token 불일치 |
| `413` | 본문 제한 1MiB 초과 |
| `415` | JSON 이외 Content-Type |
| `503` | 감지 계정·허용 프로젝트·비밀값 설정 미완료 |

가상 이벤트 검증은 `npm run smoke:review`로 반복할 수 있습니다. 실제 GitLab 도달 여부는 HTTPS 경로를 만든 뒤 별도로 확인합니다. [이벤트 형식](https://docs.gitlab.com/user/project/integrations/webhook_events/), [수신함 상세](docs/LOCAL-REVIEW.md).

## 13. Mattermost 설정

Mattermost는 Jira 기능과 독립적으로 설정합니다. 웹훅 발급 → 로컬 등록 → 논리 채널 → 사람 매핑 → 템플릿 → 미리보기 → 첫 전송 순서입니다.

### 13-1. Incoming Webhook 발급과 등록

Mattermost의 Integrations에서 Incoming Webhook을 만들고 수신 채널을 선택합니다. 조직에서 기능을 제한했다면 관리자 설정이 필요합니다. 다른 채널/DM으로 보낼 때는 웹훅 목적지 제한과 서버 정책도 확인하세요. [공식 Incoming Webhook 안내](https://developers.mattermost.com/integrate/webhooks/incoming/).

`webhook_create` 입력 형식입니다. 실제 URL은 비밀값이므로 README·이슈·공유 대화에 붙여 넣지 않습니다.

```json
{
  "name": "team-webhook",
  "webhook_url": "https://mattermost.example.com/hooks/REPLACE_ME"
}
```

URL을 대화에 넣지 않고 로컬에서 한 번 등록하려면 `.env`에 아래 **등록용 선택 변수**를 추가할 수 있습니다. 서버가 자동 등록하는 변수는 아니며 다음 명령만 읽습니다.

```dotenv
REVIEWBOT_SETUP_MM_WEBHOOK_URL="https://mattermost.example.com/hooks/REPLACE_ME"
```

소스 루트에서 실행합니다. 이미 등록한 이름이면 MCP의 `webhook_update`를 사용하거나 서비스의 `updateWebhook`을 호출하세요.

```sh
node --env-file=.env --input-type=module -e "import { MattermostService } from './src/core.js'; const s = new MattermostService(); try { console.log(s.createWebhook({ name: 'team-webhook', webhookUrl: process.env.REVIEWBOT_SETUP_MM_WEBHOOK_URL })); } finally { s.close(); }"
```

등록 후 `webhook_list({})`는 이름과 가린 주소만 반환합니다. 등록용 변수는 `.env`에서 제거해도 저장한 설정은 유지됩니다. 실제 URL은 로컬 DB에 저장되며 암호화되지는 않습니다.

### 13-2. 논리 채널 등록

`channel_create`:

```json
{
  "name": "team-reviews",
  "webhook_name": "team-webhook",
  "mattermost_channel": "code-reviews",
  "enabled": true
}
```

`name`은 로컬 별칭입니다. `mattermost_channel`은 `https://서버/팀/channels/code-reviews`의 마지막 부분이며 화면 표시 이름이나 전체 URL이 아닙니다. 생략하면 웹훅의 기본 채널을 사용합니다. 실제 Mattermost 채널을 만드는 도구는 아닙니다.

### 13-3. 멘션·DM용 사람 등록

`participant_create`:

```json
{
  "display_name": "팀원 A",
  "mattermost_username": "member.a",
  "gitlab_username": "member.a.gitlab",
  "is_self": false
}
```

자신의 계정에만 `is_self: true`를 사용합니다. 서비스별 사용자명은 다를 수 있고 `@`는 제외합니다. 반환된 `id`가 로컬 participant ID입니다. GitLab 숫자 ID와 혼동하지 마세요.

채널 참여자 목록도 필요하면 `channel_member_add`를 사용합니다.

```json
{
  "channel_name": "team-reviews",
  "mattermost_username": "member.a"
}
```

이 목록은 로컬 기록이며 실제 Mattermost 멤버십을 조회·변경하지 않습니다.

### 13-4. 리뷰 템플릿과 미리보기

다음 세 이름에는 리뷰 메시지 형식 검증이 적용됩니다. 각 행을 `convention_create`의 `name`, `template`으로 등록합니다.

| 이름 | 템플릿 |
|---|---|
| `review-request` | `{{mention}} :merge_please: !{{mr_number}} \| [{{jira_key}}] {{message}}` |
| `review-request-multi` | `{{mentions}} :merge_please: !{{mr_number}} \| [{{jira_key}}] {{message}}` |
| `review-complete` | `{{mention}} :review_complete_shake: !{{mr_number}} \| [{{jira_key}}] {{message}}` |

표의 `\|`는 Markdown 표시용이며 실제 템플릿에는 `|`만 적습니다. 커스텀 이모지 표시는 Mattermost 서버 설정에 따릅니다.

`message_preview`:

```json
{
  "convention_name": "review-complete",
  "variables": {
    "mention": "@member.a",
    "mr_number": 42,
    "jira_key": "TEAM-123",
    "message": "리뷰 완료"
  }
}
```

미리보기만으로는 전송되지 않습니다. 확인 후 `message_send`에 같은 `convention_name`, `variables`와 `channel_names: ["team-reviews"]`를 전달합니다. DM은 `message_send_dm`의 `participant_id`, `via_channel_name`을 사용합니다. 리뷰 DM 본문 멘션도 실제 수신자와 일치해야 합니다.

리뷰 요청/완료를 자유문으로 보내 형식 검사를 우회할 수는 없습니다. 템플릿에는 멘션·상태 이모지·MR 번호·Jira키·한 줄 메시지가 필요합니다. 서버의 DM 정책에 따라 실패할 수 있으므로 첫 연결 때 실제 수신자를 정해 확인하세요.

## 14. 기존 Claude Code 리뷰 흐름

원본에서 이어받은 스킬·하네스입니다. **새 웹훅 수신함을 자동 처리하는 실행기가 아닙니다.**

### 플러그인 설치

확장 소스 루트에서 로컬 marketplace를 설치합니다. 원본 GitHub 주소를 직접 설치하는 명령으로 바꾸지 마세요.

```sh
claude plugin marketplace add ./ --scope user
claude plugin install mmp@mmp-local --scope user
claude plugin list
```

플러그인은 `claude-mcp.json`을 사용합니다. 기본 파일은 `.env`를 자동 로드하지 않으므로 실행 프로세스에 환경변수를 전달하거나, **자신의 로컬 복사본**의 `args`를 Node `--env-file` 절대 경로 방식으로 설정해야 합니다. CLI 하네스에도 같은 환경변수를 전달해야 합니다. 실제 토큰·사용자 경로가 든 변경은 커밋하지 않습니다. 직접 등록한 MCP와 플러그인 MCP가 중복되지 않게 한 방식을 선택하세요. [플러그인 공식 안내](https://code.claude.com/docs/en/plugins).

기존 Windows용 `scripts/install-codex-plugin.ps1`은 최초 설치용 복사 스크립트입니다. 기존 설치 경로가 있으면 중단하고 소스를 수정해도 복사본은 자동 갱신되지 않습니다. 처음 설정한다면 [6절](#6-mcp-클라이언트에-연결)의 직접 연결이 간단합니다. 훅·자동 감시는 클라이언트마다 다르므로 동일하게 작동한다고 가정하지 마세요.

### MR 한 건 리뷰

준비물은 GitLab 로그인·검토 대상 로컬 저장소·**1명 이상의 팀원 프로필과 Jira Cloud 설정**입니다. Mattermost 완료 DM까지 사용할 때는 13절 설정도 필요합니다.

```text
/mmp:mr-review https://gitlab.example.com/group/repository/-/merge_requests/42
```

`prepare → 코드 리뷰 → record → post → notify` 순서로 진행합니다. `prepare`는 전용 워크트리·최신 Jira 맥락을 준비합니다. 새 리뷰 본문은 `### 작업 맥락`과 실제 Jira키/담당 영역 근거를 요구하고 `post`는 GitLab SHA가 바뀌면 중단합니다. `approve`/`hold`는 댓글 판정이며 GitLab 승인 버튼 조작이 아닙니다.

CLI를 직접 호출할 때 `prepare`가 반환한 `worktreePath`로 이동한 뒤 `record`, `post`, `notify`를 실행합니다. `.env`는 절대 경로로 전달합니다. 단계와 옵션은 [리뷰 하네스](docs/review-harness.md)와 [리뷰 스킬](skills/mr-review/SKILL.md)을 참고하세요.

### 기존 감시와 bypass

기존 감시를 사용할 때는 `<MATTERMOST_MCP_DATA_DIR>/watch.json`을 준비합니다. 데이터 경로를 생략했다면 `~/.mmp/watch.json`입니다. 인증 토큰은 이 파일에 넣지 않습니다.

```json
{
  "host": "gitlab.example.com",
  "projects": {
    "group/repository": {
      "workdir": "C:/work/target-repository",
      "jiraBaseUrl": "https://your-team.atlassian.net/browse"
    }
  }
}
```

`workdir`는 리뷰봇 소스가 아닌 **검토 대상 프로젝트의 로컬 클론**입니다. `projects`의 키는 GitLab 프로젝트 경로이며 각 값을 자신의 환경으로 바꿉니다. 자세한 실행·중단 절차는 [기존 감시 스킬](skills/auto-review/SKILL.md)을 참고하세요.

- `/mmp:auto-review`: GitLab todos를 60초마다 확인하는 별도 흐름입니다. 새 수신함과 연동되지 않습니다. 현재 첫 100건 조회이며 새 커밋 자동 재리뷰나 전체 누락 복구를 보장하지 않습니다.
- `watch.json`의 `jiraBaseUrl`은 링크 설정입니다. 새 Jira API 인증 설정을 대신하지 않습니다.
- `/mmp:bypass-review on|off`: 댓글 게시 전 확인 정책입니다. 감시를 켜는 명령이 아닙니다. 사용할 때는 `node bin/bypass-review.mjs channel <논리채널명>`으로 자신의 기본 채널을 먼저 설정합니다.
- 승인·머지 명령을 막는 원본 훅은 Claude Code 전용입니다. MCP만 등록한 다른 클라이언트에 같은 보호가 설치된 것은 아닙니다.

## 15. 전체 MCP 도구

현재 총 30개입니다. 아래는 도구 이름이며 CLI 명령은 아닙니다.

| 영역 | 도구 |
|---|---|
| 데이터 위치 | `storage_info` |
| GitLab 수신함 | `review_inbox_status`, `review_pending_list` |
| 팀 프로필 | `team_member_upsert`, `team_member_list` |
| Jira·주간 요약 | `team_sync`, `team_member_context`, `team_weekly_summary` |
| MR 최신 맥락 | `review_context_prepare` |
| Mattermost 웹훅 | `webhook_create`, `webhook_list`, `webhook_update`, `webhook_delete` |
| 논리 채널 | `channel_create`, `channel_list`, `channel_update`, `channel_delete` |
| Mattermost 사람 | `participant_create`, `participant_list`, `participant_update`, `participant_delete` |
| 채널 참여자 | `channel_member_add`, `channel_member_remove` |
| 메시지 템플릿 | `convention_create`, `convention_list`, `convention_update`, `convention_delete` |
| 미리보기·전송 | `message_preview`, `message_send`, `message_send_dm` |

`team_sync`, `team_weekly_summary`, `review_context_prepare`는 외부 자료를 읽고 로컬 파일을 갱신합니다. `message_send`, `message_send_dm`은 실제 외부 메시지를 보냅니다. 수신함 조회 도구는 대기 작업을 실행하거나 완료로 처리하지 않습니다.

## 16. 저장 위치와 백업

기본 위치는 사용자 홈의 `.mmp`, 권장 설정은 설치 경로 바깥의 비공개 데이터 디렉터리입니다. 서로 다른 팀은 다른 `MATTERMOST_MCP_DATA_DIR`를 사용하세요.

```text
데이터 디렉터리/
  mattermost.sqlite3                  # Mattermost 설정과 비밀 URL
  reviews.sqlite3                     # GitLab 수신·추적·대기 요청
  team-context.sqlite3                # 등록 팀원 프로필·Jira·요약·실행 선점
  people/<id>/profile.md
  people/<id>/weeks/<월요일>.md
  issues/<Jira키>/context.md
  reviews/<MR-URL-해시>/<SHA>.md
  bypass-review.json                  # 기존 하네스, 사용할 때 생성
  watch.json                         # 기존 todos 감시 설정
  watch-state.json                   # 기존 todos 감시 기록
```

SQLite가 원본이고 Markdown은 읽기 위한 자료입니다. 각 리뷰 워크트리의 Git 디렉터리에는 별도로 `mmp-mr-review.json`이 생깁니다. 수신함에 저장하지 않는 원문도 팀 맥락 파일에는 업무 설명으로 포함될 수 있으므로 데이터 폴더 전체를 비공개로 취급합니다.

경로가 다르면 두 클라이언트의 목록도 다릅니다. `storage_info`로 실제 `dataDir`를 비교하세요. 기존 counts는 Mattermost 항목이며 팀원 수는 `team_member_list`, 수신함 건수는 `review_inbox_status`에서 확인합니다.

백업할 때는 MCP·수신기·기존 감시를 종료한 뒤 데이터 디렉터리 전체와 비공개 `.env`를 보관합니다. 실행 중 SQLite 주 파일만 복사하면 WAL에 남은 변경을 빠뜨릴 수 있습니다. 복원할 때도 관련 프로세스를 먼저 멈추고 복원 후 설정 경로를 확인합니다. 백업에도 실제 웹훅 URL과 업무 정보가 들어 있습니다.

## 17. 문제 해결

| 증상 | 확인할 것 |
|---|---|
| MCP 도구가 보이지 않음 | Node 절대 경로, `npm ci`, server 경로, 클라이언트 재연결/새 작업 확인 |
| `node:sqlite` 또는 JSON import 오류 | Node 22.13 이상 확인. 검증 기준은 24 |
| `.env`를 수정했지만 미설정 | `--env-file` 경로·재시작·기존 셸 환경변수 확인 |
| `Configure REVIEWBOT_JIRA_...` | Jira 주소·이메일·토큰·프로젝트 키 네 항목 모두 설정 |
| Jira `401` | 토큰 계정 이메일·만료·인증 방식·호출 경로 확인 |
| Jira `403` 또는 작업 일부 누락 | 프로젝트/이슈/필드 권한과 이슈 보안 확인. 실패와 작업 없음은 다름 |
| 등록된 팀원이 없다는 오류 | `participant_list`가 아닌 `team_member_list`에 사용할 팀원을 1명 이상 등록했는지 확인 |
| MR 작성자 매핑 실패 | 작성자의 숫자 GitLab ID/정확한 사용자명 확인. 다른 인스턴스 계정을 섞지 않음 |
| 담당 경로가 영향 관점에 안 잡힘 | 저장소 루트 기준 실제 경로인지 확인. 절대 경로·glob 금지 |
| 첫 Jira 동기화 시간 초과 | 클라이언트 300초 제한, 이슈/이력 양·네트워크 확인. 마지막 성공 시각 조회 |
| 월요일 파일이 없음 | 1명 이상 등록·Jira 설정·MCP 생존·KST 09시 확인. `team_weekly_summary`로 수동 진단 |
| 일부 작업이 목록에 안 보임 | `omittedIssueCount`, `nextOffset`, 권한·조회 상한 확인 |
| `glab` 조회 실패 | 같은 OS 사용자·실행 환경에서 호스트 로그인. MCP의 PATH 확인 |
| 새 커밋 때문에 준비/게시 중단 | 이전 결과를 게시하지 않고 최신 SHA로 다시 준비 |
| health 200인데 웹훅 503 | `configured` 확인. 감지 계정·허용 프로젝트·Secret token 필요 |
| GitLab 웹훅 접속 실패 | 외부 HTTPS·프록시·수신기·방화벽 확인. 외부에서 localhost 접속 불가 |
| 웹훅 401 | Secret token·프록시 헤더 확인. Signing token만으로는 인증 불가 |
| 웹훅 202인데 수신함이 비어 있음 | 응답 status/reason, 감지 계정·프로젝트·Draft/닫힘·멘션 제외 규칙 확인 |
| 웹훅 수신 후 댓글이 안 달림 | 현재 자동 리뷰·게시 연결은 미구현. 수동 MR 맥락 준비부터 사용 |
| Mattermost 채널/DM 실패 | 채널 slug·접근 권한·웹훅 목적지 제한·수신자 매핑 확인 |
| 리뷰 메시지 형식 오류 | 컨벤션 이름·멘션·MR 번호·Jira키·이모지·한 줄 message 확인 |
| 두 클라이언트 설정이 다름 | `storage_info`의 `dataDir`, 설치 복사본/소스 경로 비교 |
| 설치 스크립트 재실행 거부 | 최초 설치용이며 기존 경로/marketplace 중복을 덮어쓰지 않음 |

문제를 공유할 때 `.env`, 실제 웹훅 URL, SQLite·개인별 업무 원문을 제외합니다. OS·Node 버전·사용한 도구·가려진 오류·재현 절차를 적어 주세요.

## 18. 업데이트와 제거

직접 연결 방식은 소스 위치를 유지한 채 변경 내용을 받고 의존성을 설치한 다음 검증하고 MCP·수신기를 재시작합니다. 커스텀 변경이 있으면 먼저 Git 상태를 확인하세요.

```sh
git status
git pull --ff-only
npm ci
npm test
npm run smoke
npm run smoke:review
```

설치 복사본을 쓰는 플러그인은 소스 갱신만으로 업데이트되지 않습니다. 클라이언트의 업데이트 절차와 실제 설치 경로를 확인하세요. 이미 열린 작업/세션에는 이전 코드가 남을 수 있습니다.

직접 연결 제거:

```sh
codex mcp remove reviewbot
claude mcp remove reviewbot --scope user
```

플러그인으로 설치했다면 해당 플러그인도 제거하고 별도로 실행한 수신기·감시를 종료합니다. 제거해도 `.env`, 데이터 폴더, 리뷰 워크트리는 남습니다. 필요한 자료를 백업한 뒤 직접 정리하세요. 워크트리는 해당 저장소의 `git worktree list`로 확인하고 `git worktree remove <경로>`로 정리합니다.

## 19. 개발과 공개 저장소 준비

### 소스 위치

| 경로 | 내용 |
|---|---|
| `src/server.js` | MCP 도구 스키마·등록 |
| `src/core.js` | 기존 Mattermost 서비스·저장 |
| `src/review-config.js`, `src/review-inbox.js` | 수신 설정·이벤트 필터·수신함 |
| `bin/gitlab-webhook.mjs` | 로컬 HTTP 수신기 |
| `src/jira-client.js` | Jira Cloud 조회·페이지 순회·이력 정규화 |
| `src/team-context-store.js`, `src/team-context.js` | 팀 저장·관점 구성·주간 요약 |
| `src/gitlab-context.js` | MR 조회·준비 전후 SHA 확인 |
| `bin/mr-review.mjs`, `bin/mr-watch.mjs` | 기존 리뷰 하네스·todos 감시 |
| `skills/`, `hooks/` | 리뷰 절차·원본 클라이언트 훅 |
| `test/`, `scripts/` | 테스트·검증·설치 |

동작을 바꾸면 `npm test`, `npm run smoke`, `npm run smoke:review`를 실행합니다. 운영 계정·MR·채널을 테스트 fixture로 사용하지 않습니다. 운영용 5분 예약은 현재 포함하지 않습니다.

### 공개 전에 저장소 소유자가 정할 값

| 위치 | 정리할 항목 |
|---|---|
| README의 clone URL | 현재 공개 주소를 유지하고 저장소 이전 시 함께 변경 |
| `package.json`, 플러그인 manifest | 확장 저장소 주소·설명·버전을 릴리스와 함께 유지 |
| `.env.example` | 빈 값/형식 예시만 유지. 실제 팀 계정·프로젝트·토큰 금지 |
| Git 추적 파일과 과거 커밋 | `.env`, 개인별 파일, SQLite, 실제 URL·토큰 포함 여부 확인 |
| 루트 `LICENSE` | 프로젝트 전체 배포 조건 정리. 현재 루트 라이선스 파일 없음 |

원본 출처는 위 MMP 링크를 유지합니다. `skills/mr-review/checklists/LICENSE-open-code-review.txt`는 가져온 체크리스트의 별도 Apache 2.0 라이선스이며 저장소 전체의 라이선스를 뜻하지 않습니다. 루트 라이선스와 원본 사용 조건을 확인하기 전에는 전체 프로젝트에 MIT 등의 배지를 임의로 붙이지 않습니다.

추가 기록은 [팀 작업 맥락](docs/TEAM-CONTEXT.md), [로컬 수신함](docs/LOCAL-REVIEW.md), [설계 기록](docs/CONTEXT.md), [기존 하네스](docs/review-harness.md)에 있습니다. 실제 계정 연결·HTTPS 수신·댓글 게시·Mattermost 도착·운영 환경의 최초 동기화 시간은 각 설치 환경에서 검증해야 합니다.
