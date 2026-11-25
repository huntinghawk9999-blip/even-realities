# Cyber HUD KR — 내 PC 중계 서버

> 이 저장소는 Even Realities 사의 공식 저장소가 아닌 개인 프로젝트입니다. Even Realities와 관계없습니다.

Even G2 글래스 플러그인 **Cyber HUD KR**에서 네이버(정확한 도로명·장소 검색·자동차 실시간 길안내)와
음성 목적지(Gemini)를 쓰기 위해 **본인 PC에서 켜는 작은 프로그램**입니다.

- 키는 **본인 PC에만** 저장됩니다. 키와 요금은 각자 본인 것입니다.
- 폰(Even 앱)은 **Tailscale**로 본인 PC에 연결합니다. 다른 사람은 이 PC에 닿을 수 없습니다.
- 이 프로그램 없이도 플러그인은 OpenStreetMap으로 동작합니다. 아래는 선택 기능입니다.

> 왜 PC가 필요한가요? 네이버 API는 폰 앱 안에서 직접 부르는 것을 막아 두어서, 본인 PC가 대신 요청해 줘야 합니다.

---

## 준비 (처음 한 번)

### 1. 네이버 클라우드 키 만들기
1. https://console.ncloud.com 로그인
2. Services → Application Services → **Maps** → **Application 등록**
3. API 선택에서 **Reverse Geocoding**, **Geocoding**, **Directions 5** 체크 → 저장
4. "한도 및 알림 설정"에서 월 한도를 걸고 **한도 초과 사용: 허용안함** (요금 방지)
5. Application의 **인증 정보**에서 Client ID / Client Secret 확인
6. (선택) 장소 이름 검색: 콘솔 → **NAVER API HUB** → 검색 API Application을 하나 더 만들어 그 Client ID / Secret

### 2. (선택) 음성 목적지용 Gemini 키
1. https://aistudio.google.com → **Get API key** → **Create API key** (무료, 카드 필요 없음)
2. 무료 사용분은 Google이 입력을 서비스 개선에 쓸 수 있습니다. 사용자가 몰리면 가끔 "붐빔"으로 실패할 수 있습니다.

### 3. PC에 중계 서버 켜기 (Windows)
1. **Node.js LTS** 설치: https://nodejs.org
2. 이 저장소를 받습니다: 위쪽 초록색 **Code → Download ZIP** → 압축 풀기
3. 폴더 안의 **`start.cmd`** 더블클릭
   - Windows 방화벽이 물으면 **허용**
   - 브라우저에 `http://localhost:8790` 화면이 열리면 1~2번의 키를 넣고 **저장** → **시험(서울시청)**이 "성공"이면 됩니다
4. 이 창(검은 창)이 켜져 있는 동안만 동작합니다

> macOS·Linux: Node.js 설치 후 이 폴더에서 `node --env-file-if-exists=.env server.mjs`

### 4. Tailscale로 폰과 PC 연결
1. https://tailscale.com 에서 **PC와 폰 모두** 설치하고 **같은 계정**으로 로그인
2. https://login.tailscale.com → **Machines** → 중계 서버를 켠 PC → **Edit machine IPv4** → **`100.86.86.86`** 으로 변경
   - Even 앱은 미리 정해진 주소로만 연결할 수 있어서, 모든 사용자가 이 주소로 맞춥니다
   - Tailscale 네트워크는 사람마다 따로라서 같은 주소를 써도 부딪히지 않습니다
   - 내 Tailscale 안에서 이 주소는 한 기기에만 줄 수 있습니다(중계 서버 PC 한 대만)
3. 폰에서 Tailscale을 켜 둡니다

### 5. 플러그인에서 확인
1. 폰 Even 앱에서 Cyber HUD KR을 엽니다
2. 폰 화면 아래 **"내 PC로 네이버 쓰기"** → **내 PC 중계 서버 쓰기**가 체크돼 있는지 확인 → **연결 시험**
3. "성공: 세종대로 / 명동"이 나오면 끝
   - 키는 폰 화면의 키 칸에서 넣어도 됩니다(**PC에 키 저장**). 저장된 키는 화면에 다시 보이지 않고 "저장됨"으로만 표시됩니다

---

## 쓰는 법

- **목적지**: 폰 화면에서 검색해 후보 중 고르기, 또는 글래스를 **길게 누른 채 목적지를 말하고 손을 떼기**(최대 10초)
- 목적지를 정하면 자동차 실시간 길안내(네이버 실시간 빠른길): 미니맵에 경로 선, 다음 안내, 남은 거리·도착 시각
- PC가 꺼져 있거나 연결이 안 되면 플러그인은 자동으로 OpenStreetMap으로 동작

운전 중에는 화면을 보지 마세요.

---

## 문제 해결

| 증상 | 확인할 것 |
|---|---|
| 연결 시험이 "닿지 않음" | PC의 검은 창이 켜져 있는지, 폰과 PC의 Tailscale이 켜져 있는지, PC 주소가 100.86.86.86인지 |
| "네이버가 거절" | 키가 맞는지, Maps Application에서 Reverse Geocoding·Geocoding·Directions 5를 체크했는지 |
| "Gemini가 붐빔" | 구글 쪽 사용량이 몰린 것. 잠시 뒤 다시 |
| 처음 가는 곳에서 미니맵이 늦게 뜸 | 처음 지역은 공용 지도 서버에서 받느라 30~60초. 한 번 받으면 7일 동안 바로 뜸 |

---

## 이 프로그램이 하는 일

| 주소 | 하는 일 |
|---|---|
| `/health` | 상태 확인(키는 있음/없음만, 값은 안 보여 줌) |
| `/revgeo` | 좌표 → 도로명·동 (네이버 Reverse Geocoding) |
| `/search` | 장소 검색(네이버 장소 검색 → 주소 검색) |
| `/route` | 자동차 길찾기(네이버 Directions 5 실시간 빠른길) |
| `/stt` | 음성 → 목적지 이름(Gemini) |
| `/osm` | 미니맵용 OpenStreetMap 도로 자료(받아서 7일 저장) |
| `/` | 키 입력 화면(이 PC에서만 열림) |

- 이 PC 자신과 Tailscale 기기(100.64.0.0/10)에서 온 요청만 받습니다
- 키는 이 폴더의 `.env`에만 저장되고, 어떤 응답으로도 다시 보내지 않습니다
- 결과는 `cache/` 폴더에 저장합니다(도로명 30일, 검색·지도 7일). 좌표는 약 10m 단위로 뭉개서 네이버에 보냅니다

외부 라이브러리 없이 Node.js 기본 기능만 씁니다. 설치할 것이 없습니다.

---

- 개인정보처리방침: [privacy.html](privacy.html)
- 문의: 이 저장소의 **Issues**
- Cyber HUD KR은 [Cyberpunk HUD for Even G2](https://github.com/MSPKS/Cyberpunk-HUD-for-EvenG2)(MIT)를 바탕으로 한 한국판입니다. CD PROJEKT RED와 관계없습니다. 지도 © OpenStreetMap contributors.
