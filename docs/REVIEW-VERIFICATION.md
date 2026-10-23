# CI 확인과 격리 실행

자동 리뷰는 작성자의 테스트 통과 보고와 별도로 검토 SHA의 CI 결과를 조회하고, 운영자가 등록한 테스트·빌드·린트 명령을 Docker Linux 컨테이너에서 실행합니다. 모델에는 실행 권한을 주지 않습니다. 모델은 수집된 코드·요구사항과 검증 결과를 함께 읽습니다.

격리 실행은 CI 파이프라인·CI 아티팩트에 의존하지 않습니다. 파이프라인이 없거나 CI 조회에 실패해도 검토 SHA의 저장소 아카이브로 등록 명령을 실행합니다. 소스 확보 자체에 실패한 경우에는 실행하지 못한 원인과 확인 가능한 HTTP 상태를 따로 기록합니다.

## 처리 순서

1. MR의 최신 SHA와 변경 자료·팀 맥락을 고정합니다.
2. `validating` 단계에서 해당 SHA의 소스 아카이브를 받습니다. 호스트에서 추출하지 않습니다.
3. 운영자 설정에 있는 각 명령을 독립 컨테이너에서 실행합니다.
4. 실행이 끝나면 같은 SHA의 최신 GitLab 파이프라인·작업 상태·테스트 보고서를 조회합니다.
5. 비공개 검증 영수증을 저장하고 SHA가 여전히 최신인지 확인합니다.
6. 모델에 검증 결과와 제한된 진단 로그를 전달합니다.
7. 서버가 댓글의 `실행 검증 결과`와 누적 검증 기록을 추가하고, 최신 SHA 확인 후 게시합니다.

모델 실패 후 재시도할 때 같은 요청·SHA의 저장된 검증 결과는 재사용합니다. 작업 DB에는 실행 ID·SHA·영수증 해시만 넣고 진단 로그를 복제하지 않습니다. 재개 시 파일 해시와 MR·프로젝트·SHA를 확인하며 영수증이 없거나 변경됐으면 자동 재시도 없이 중단합니다. 새 커밋은 새로 검증합니다. 검증 명령만 다시 실행하려면 아래 검증 전용 CLI를 사용합니다. CLI는 MR 댓글·Mattermost·Jira를 변경하지 않습니다.

## GitLab CI에서 확인하는 것

- 허용 프로젝트의 `GET /projects/:id/pipelines?sha=<전체 SHA>`로 조회합니다. 다른 SHA나 프로젝트의 결과는 받지 않습니다.
- 동일 SHA에서 가장 최근 파이프라인의 실제 작업 상태를 조회합니다. 재시도 전의 작업은 제외합니다.
- `allow_failure`, `skipped`, `manual`, 대기·취소 상태를 유지합니다.
- 테스트 보고서의 성공·실패·오류·건너뜀 건수를 따로 기록합니다. 보고서가 없으면 테스트 실행을 증명하지 못한 것으로 남깁니다.
- 브리지 작업 상태는 별도로 수집합니다. 하위 파이프라인 전체의 테스트를 재귀적으로 검증하지는 않습니다.
- 파이프라인을 만들거나 재실행하거나 CI 설정을 변경하지 않습니다. CI 없음·접근 거부·조회 오류는 조회 불가나 미확인입니다.

파이프라인 성공은 모든 테스트 실행의 보장이 아닙니다. 자세한 API는 [Pipelines](https://docs.gitlab.com/api/pipelines/)와 [Jobs](https://docs.gitlab.com/api/jobs/) 문서를 참고하세요.

## 격리 조건

Docker Desktop 또는 Docker Engine이 Linux 컨테이너 모드로 실행 중이고 메모리·swap·CPU quota·프로세스 제한을 지원해야 합니다. 지원 여부를 확인하지 못하면 실행하지 않습니다.

- 네트워크 없음, 호스트 포트 공개 없음
- 호스트 폴더·Docker 소켓·운영 DB 연결 없음
- 호스트 `.env`·GitLab/Jira/Mattermost 인증값 전달 없음
- 읽기 전용 루트 파일 시스템, 비루트 UID/GID 1000, capability 제거
- CPU 2개, 메모리 3GiB, 프로세스 256개 제한
- 소스는 2GiB 임시 메모리 파일 시스템, 작업용 `/tmp`는 1GiB
- 명령별 기본 제한 시간 5분, 설정으로 최대 15분
- 출력 합계 256,000바이트 제한, 비공개 보고서에는 인증 패턴을 지운 마지막 약 8,000바이트
- 실행 시 이미지 자동 다운로드 없음. 미리 준비한 이미지를 ID로 고정해 실행
- Docker의 영구 로그와 이미지 healthcheck 비활성화
- 종료·시간 초과·취소 후 해당 컨테이너 정리

기존 서비스 이미지는 검증용으로 재사용하지 않습니다. 인증값 이름의 환경변수나 영구 볼륨 선언이 있는 이미지는 거부합니다. 컨테이너는 호스트 커널·Docker에 의존하므로 완전한 VM 보안 경계와 같지는 않습니다. 신뢰할 수 없는 외부 프로젝트를 운영한다면 전용 검증 호스트를 사용하세요. Docker 옵션은 [공식 실행 문서](https://docs.docker.com/reference/cli/docker/container/run/)를 참고하세요.

## 프로젝트별 명령 등록

기본 설정 파일은 비공개 데이터 폴더의 `validation-projects.json`입니다. 다른 위치를 쓰려면 `.env`에 절대 경로를 지정합니다.

```dotenv
REVIEWBOT_VALIDATION_CONFIG="C:/private/reviewbot/validation-projects.json"
```

[설정 예제](../config/validation-projects.example.json)를 복사하고 다음 값을 바꿉니다.

| 필드 | 의미 |
|---|---|
| `host` | 등록한 GitLab 호스트, 프로토콜 제외 |
| `projectId` | 숫자 프로젝트 ID |
| `checks[].name` | 영문 소문자로 시작하는 고유한 검사 ID |
| `kind` | `test`, `build`, `lint` |
| `directory` | 해당 SHA 소스에서 실행할 상대 경로, 루트는 `.` |
| `image` | 운영자가 준비한 로컬 이미지. 실제 실행은 조회한 불변 이미지 ID 사용 |
| `command` | 실행 파일과 인수 배열. 운영자가 명시적으로 셸을 선택할 수도 있음 |
| `timeoutMs` | 선택, 기본 300000, 최대 900000 |
| `reason` | 명령이 없을 때의 영문 사유 코드 |

명령이 없는 검사는 `command: null`과 사유를 적습니다. 예를 들어 프론트 `package.json`에 `test` 스크립트가 없으면 이를 미실행으로 남겨야 합니다. 빌드나 타입 검사 성공을 테스트 성공으로 바꾸지 마세요.

설정은 MR 소스·`.gitlab-ci.yml`에서 자동으로 가져오지 않습니다. 검토 대상이 이미지·호스트 경로·권한을 선택하지 못하도록 운영자 전용 파일을 사용합니다. 저장소의 예제는 배포용 문서이며 실제 설정·보고서는 Git에 넣지 않습니다.

## 네트워크 없이 실행할 이미지 준비

의존성 설치는 검토와 분리된 사전 준비 작업입니다. 운영자가 검토한 의존성 목록·잠금 파일만 새 빌드 폴더로 복사합니다. MR의 Dockerfile이나 설치 스크립트를 호스트에서 실행하지 마세요.

아래 예제는 소스 저장소 경로가 `C:/work/my-project`, 준비 폴더가 `C:/private/reviewbot-images`인 PowerShell 예제입니다. 경로는 자신의 환경으로 바꿉니다. 원본 `.env`, `.npmrc`, `gradle.properties`, 인증 디렉터리는 복사하지 않습니다.

### Node

```powershell
New-Item -ItemType Directory -Force C:/private/reviewbot-images/node
Copy-Item -LiteralPath config/validation-images/node.Dockerfile -Destination C:/private/reviewbot-images/node/Dockerfile
Copy-Item -LiteralPath C:/work/my-project/frontend/package.json -Destination C:/private/reviewbot-images/node/package.json
Copy-Item -LiteralPath C:/work/my-project/frontend/package-lock.json -Destination C:/private/reviewbot-images/node/package-lock.json
docker build -t reviewbot-node:local C:/private/reviewbot-images/node
```

이미지는 `npm ci --ignore-scripts`로 의존성을 준비합니다. 실행 예제는 잠금 파일 해시(줄바꿈 차이 정규화)와 의존성 정의가 같을 때만 준비된 `node_modules`를 사용합니다. 잠금 파일이 바뀌면 이미지를 새로 준비해야 합니다. 설치 스크립트가 반드시 필요한 패키지는 운영자가 별도 검토한 이미지 준비 절차가 필요합니다.

### Java / Gradle

운영자가 검토한 프로젝트의 Gradle 의존성과 wrapper 배포본이 미리 캐시돼 있어야 합니다. 다른 프로젝트에서 저장한 자격증명이 섞이지 않도록 전체 사용자 Gradle 폴더를 복사하지 않습니다.

```powershell
New-Item -ItemType Directory -Force C:/private/reviewbot-images/java/gradle-seed/caches
New-Item -ItemType Directory -Force C:/private/reviewbot-images/java/gradle-seed/wrapper
Copy-Item -LiteralPath config/validation-images/java.Dockerfile -Destination C:/private/reviewbot-images/java/Dockerfile
Copy-Item -LiteralPath "$env:USERPROFILE/.gradle/caches/modules-2" -Destination C:/private/reviewbot-images/java/gradle-seed/caches -Recurse
Copy-Item -LiteralPath "$env:USERPROFILE/.gradle/wrapper/dists" -Destination C:/private/reviewbot-images/java/gradle-seed/wrapper -Recurse
docker build -t reviewbot-java:local C:/private/reviewbot-images/java
```

예제 이미지의 JDK는 17입니다. 프로젝트의 toolchain에 맞게 운영자가 조정하세요. 예제 명령은 캐시를 컨테이너의 임시 폴더에 복사하고 `--offline`로 실행합니다. 새 의존성이나 다른 wrapper 버전이 필요하면 캐시와 이미지를 갱신해야 합니다. 기본 `test`가 통합 테스트를 제외하는 프로젝트는 해당 통합 범위를 검증한 것이 아닙니다.

### Python

```powershell
New-Item -ItemType Directory -Force C:/private/reviewbot-images/python
Copy-Item -LiteralPath config/validation-images/python.Dockerfile -Destination C:/private/reviewbot-images/python/Dockerfile
Copy-Item -LiteralPath C:/work/my-project/screening/requirements.txt -Destination C:/private/reviewbot-images/python/requirements.txt
docker build -t reviewbot-python:local C:/private/reviewbot-images/python
```

예제는 Python 3.12, binary wheel만 설치합니다. 요구 파일 해시(줄바꿈 차이 정규화)가 다르면 실행을 중단합니다. 테스트 의존성도 사전에 목록에 있어야 합니다. 소스 빌드가 필요한 패키지나 다른 Python 버전은 운영자가 별도 이미지를 준비하세요.

### 별도 데이터 스크립트 테스트

`screening/tests`와 `scripts/tests`는 서로 다른 검사입니다. 데이터 적재·다운로드 스크립트를 사용하는 프로젝트는 `scripts-test`도 등록하세요. 예제에는 `scripts/requirements.txt`와 pytest, rasterio 로딩에 필요한 `libexpat1`을 설치하는 별도 이미지가 포함돼 있습니다.

```powershell
New-Item -ItemType Directory -Force C:/private/reviewbot-images/scripts
Copy-Item -LiteralPath config/validation-images/scripts.Dockerfile -Destination C:/private/reviewbot-images/scripts/Dockerfile
Copy-Item -LiteralPath C:/work/my-project/scripts/requirements.txt -Destination C:/private/reviewbot-images/scripts/requirements.txt

docker build -t reviewbot-scripts:local C:/private/reviewbot-images/scripts
```

설정 예제의 `scripts-test`는 저장소 루트에서 `python -m pytest scripts/tests -q -rs`를 실행합니다. `-rs`로 건너뛴 검사 사유도 영수증 로그에 남깁니다. PostGIS 같은 별도 서비스가 없어 건너뛴 검사는 통과한 통합 테스트로 보고하지 않습니다. 프로젝트마다 의존성·pytest 버전과 경로를 확인하고, 해당 디렉터리가 없으면 예제 검사를 제거하세요.

## 실제 MR에서 검증만 실행

```powershell
node --env-file=.env bin/review-verify.mjs https://gitlab.example.com/team/project/-/merge_requests/7
```

이 명령은 실제 최신 MR 소스를 내려받아 등록된 검사를 수행하므로 시간과 Docker 자원을 사용합니다. 출력에는 SHA·CI 상태·검사별 결과·비공개 보고서 경로만 표시하고 로그 원문은 출력하지 않습니다. `stillCurrent: false`이면 실행 중 새 커밋이 올라온 것입니다. 이전 SHA의 검증 결과를 최신 코드의 결과로 사용하지 마세요.

## 결과 해석과 보관

| 결과 | 의미 |
|---|---|
| `passed` | 등록된 명령의 종료 코드가 0 |
| `failed` | 명령을 실행했으나 0이 아닌 코드로 종료. 로그·코드로 원인 확인 필요 |
| `unknown` | Docker·의존성·시간·메모리·출력 제한 등 환경 문제로 확인 불가 |
| `not_run` | 명령·이미지·설정·아카이브가 준비되지 않아 실행하지 못함 |

종료 코드 120·121은 아카이브/작업 경로 준비, 122는 예제 의존성 해시 불일치, 125~127은 컨테이너/명령 준비, 137은 자원 종료로 취급합니다. 애플리케이션 검증 명령에서 이 코드를 다른 뜻으로 사용하지 마세요. 명확한 Gradle 오프라인 캐시 부재도 환경 문제로 구분합니다. 전체 명령은 검사당 UTF-8 2,048바이트, CI 메타데이터는 32,000바이트로 제한합니다. CI가 이 범위를 초과하면 부분 결과를 성공으로 해석하지 않고 조회 불가로 남깁니다. 그 밖의 도구 오류는 종료 결과와 로그를 함께 검토해야 하며, `failed`가 곧바로 제품 결함·보류를 뜻하지는 않습니다.

전체 명령·이미지 ID·아카이브 해시·시간·종료 코드·제한된 진단 로그는 `<dataDir>/validation/<runId>.json`에 보관합니다. 공개 댓글에는 고정된 요약만 추가합니다. 누적 memory에는 해당 영수증을 가리키는 `kind=test` 근거가 들어갑니다. 작성자 보고는 `reported`, 실행기가 직접 확인한 결과는 검증 영수증과 결합한 `observed`, 미확인은 `unknown`입니다.

검증 성공은 등록 명령의 범위에 한정됩니다. 테스트 수·커버리지·통합 경로를 측정하지 않은 경우 임의로 보증하지 않습니다. 네트워크·실제 DB·Redis가 필요한 통합 검사는 현재 기본 격리 설정에서 실행되지 않습니다. 공용 자원을 연결해 우회하지 마세요.
