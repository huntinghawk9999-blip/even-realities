// Cyber HUD KR — 내 PC 중계 서버
//
// 각 사용자가 "자기 PC"에서 켜는 작은 서버입니다. 자기 네이버 API 키는 이 폴더의 .env 에만 있고,
// 자기 폰(Even 앱)은 Tailscale 로 이 PC 에 연결합니다. 다른 사람은 이 서버에 닿을 수 없습니다.
//
// 왜 필요한가: 네이버 API 는 폰 앱(WebView)에서 직접 부를 수 없음(CORS 없음).
//             공용 OpenStreetMap 지도 서버는 서울 도심에서 수십 초씩 걸림 → 여기서 받아 저장해 둠.
//
// 주소(앱이 부름):
//   GET /health
//   GET /revgeo?lat=&lng=      → { street, locality }   네이버 Reverse Geocoding
//   GET /search?q=&lat=&lng=   → { items:[{name,address,lat,lng}] }  네이버 장소 검색 → 주소 검색
//   GET /osm?iy=&ix=           → 격자 칸(≈670m)의 OSM 도로·물·공원 (앱 src/map/overpass.ts 와 같은 격자)
//
// 외부 라이브러리 없이 Node.js 20 이상 기본 기능만 씀. 실행: start.cmd 더블클릭 또는 `node --env-file-if-exists=.env server.mjs`

import http from 'node:http'
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 8790)
const CACHE_DIR = path.join(here, 'cache')
const NAVER = 'https://maps.apigw.ntruss.com'
const NAVER_SEARCH = 'https://naverapihub.apigw.ntruss.com/search/v1/local'

// 네이버 키: .env 에서 읽고, 키 입력 화면(폰 앱 또는 PC 의 http://localhost:8790)에서 저장하면 바로 바뀜.
// 키 값은 어떤 응답으로도 돌려주지 않음(있음/없음만).
const ENV_FILE = path.join(here, '.env')
let MAP_ID = process.env.NAVER_MAP_KEY_ID || ''
let MAP_KEY = process.env.NAVER_MAP_KEY || ''
let SEARCH_ID = process.env.NAVER_SEARCH_CLIENT_ID || ''
let SEARCH_SECRET = process.env.NAVER_SEARCH_CLIENT_SECRET || ''
// 음성 검색: Google AI Studio 의 Gemini API 키(사용자 본인 것)
let GEMINI_KEY = process.env.GEMINI_API_KEY || ''
const GEMINI_MODEL_FIXED = process.env.GEMINI_MODEL || '' // 비우면 키로 쓸 수 있는 최신 Flash 모델을 자동 선택

/** 입력 화면에서 받은 키를 .env 에 저장(빈 칸은 그대로 둠, clear 면 모두 지움) */
async function saveKeys(body) {
  const pick = v => (typeof v === 'string' ? v.trim().slice(0, 200) : '')
  const next = {
    NAVER_MAP_KEY_ID: body.clear ? '' : pick(body.mapId) || MAP_ID,
    NAVER_MAP_KEY: body.clear ? '' : pick(body.mapKey) || MAP_KEY,
    NAVER_SEARCH_CLIENT_ID: body.clear ? '' : pick(body.searchId) || SEARCH_ID,
    NAVER_SEARCH_CLIENT_SECRET: body.clear ? '' : pick(body.searchSecret) || SEARCH_SECRET,
    GEMINI_API_KEY: body.clear ? '' : pick(body.geminiKey) || GEMINI_KEY,
  }
  if (Object.values(next).some(v => /[\r\n]/.test(v))) throw new HttpError(400, '키에 줄바꿈이 있음')
  let lines = []
  try {
    lines = (await readFile(ENV_FILE, 'utf8')).replace(/^﻿/, '').split(/\r?\n/)
  } catch {
    /* .env 없음 → 새로 만듦 */
  }
  const done = new Set()
  lines = lines.map(l => {
    const m = l.match(/^\s*([A-Z_]+)\s*=/)
    if (m && m[1] in next) {
      done.add(m[1])
      return `${m[1]}=${next[m[1]]}`
    }
    return l
  })
  for (const [k, v] of Object.entries(next)) if (!done.has(k)) lines.push(`${k}=${v}`)
  await writeFile(ENV_FILE, lines.filter((l, i) => l !== '' || i < lines.length - 1).join('\n') + '\n')
  MAP_ID = next.NAVER_MAP_KEY_ID
  MAP_KEY = next.NAVER_MAP_KEY
  SEARCH_ID = next.NAVER_SEARCH_CLIENT_ID
  SEARCH_SECRET = next.NAVER_SEARCH_CLIENT_SECRET
  if (GEMINI_KEY !== next.GEMINI_API_KEY) {
    geminiModel = null
    geminiModels = null
    geminiCooldown.clear()
  }
  GEMINI_KEY = next.GEMINI_API_KEY
}

function readRaw(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', c => {
      size += c.length
      if (size > max) {
        reject(new HttpError(413, '너무 큼'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}
async function readBody(req) {
  const buf = await readRaw(req, 4096)
  try {
    return JSON.parse(buf.toString('utf8') || '{}')
  } catch {
    throw new HttpError(400, 'JSON 이 아님')
  }
}

// ── 음성 → 목적지 (Gemini) ─────────────────────────────
// 글래스 마이크 소리(16kHz, 16비트, 모노 PCM)를 WAV 로 감싸 Gemini 에 보내고,
// 받아쓰기(heard)와 목적지 이름(place)을 JSON 으로 받음. 예) "강남역 가자" → place "강남역"
// 모델 고르기(2026-11-25 측정): 최신 Flash 는 사용자가 몰리면 503(과부하)을 자주 내고, 같은 모델도 1초~수십 초로 들쑥날쑥.
// 받아쓰기에는 가벼운 Flash-Lite 가 가장 빠름 → Lite(정식판, 최신순) → Flash(정식판, 최신순) → 미리보기판 순으로
// 한 모델당 10초까지만 기다리고, 실패(503·429·500·404·시간 초과)하면 다음 모델로. 실패한 모델은 5분 쉼.
// 마지막으로 성공한 모델을 다음에 먼저 씀.
let geminiModels = null // 후보 목록(키가 바뀌면 다시 받음)
let geminiModel = null // 마지막으로 성공한 모델
const geminiCooldown = new Map() // 모델 → 다시 써도 되는 시각
async function geminiCandidates() {
  if (GEMINI_MODEL_FIXED) return [GEMINI_MODEL_FIXED]
  if (!geminiModels) {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': GEMINI_KEY } })
    if (r.status === 400 || r.status === 401 || r.status === 403) throw new HttpError(403, 'Gemini 키가 거절됨')
    if (!r.ok) throw new HttpError(502, `Gemini 모델 목록 실패 (${r.status})`)
    const j = await r.json()
    const ver = n => Number((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0)
    const names = (j.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.replace(/^models\//, ''))
      .filter(n => /^gemini-[\d.]+-flash/.test(n) && !/(image|tts|live|audio|thinking|exp)/.test(n))
    const rank = n => (n.includes('preview') ? 2 : 0) + (n.includes('lite') ? 0 : 1) // 정식 Lite → 정식 Flash → 미리보기
    geminiModels = names.sort((a, b) => rank(a) - rank(b) || ver(b) - ver(a)).slice(0, 6)
    if (!geminiModels.length) throw new HttpError(502, '쓸 수 있는 Gemini Flash 모델이 없음')
  }
  const now = Date.now()
  const ready = geminiModels.filter(m => (geminiCooldown.get(m) ?? 0) <= now)
  const list = ready.length ? ready : geminiModels // 모두 쉬는 중이면 그래도 시도
  return geminiModel && list.includes(geminiModel) ? [geminiModel, ...list.filter(m => m !== geminiModel)] : list
}

function wavFromPcm16(pcm) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + pcm.length, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20) // PCM
  h.writeUInt16LE(1, 22) // 모노
  h.writeUInt32LE(16000, 24)
  h.writeUInt32LE(32000, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

async function speechToPlace(pcm) {
  if (!GEMINI_KEY) throw new HttpError(503, '.env 에 Gemini 키가 없음')
  if (pcm.length < 16000) throw new HttpError(400, '소리가 너무 짧음')
  const prompt =
    '이 음성은 한국에서 길안내 목적지를 말한 것입니다. 들린 말을 그대로 받아쓰고(heard), ' +
    '지도에서 검색할 장소 이름이나 주소만 뽑아(place) 주세요. 예: "강남역 가자" → place "강남역". ' +
    '목적지가 없으면 place 는 빈 문자열.'
  const body = {
    contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: 'audio/wav', data: wavFromPcm16(pcm).toString('base64') } }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: { type: 'OBJECT', properties: { heard: { type: 'STRING' }, place: { type: 'STRING' } }, required: ['heard', 'place'] },
    },
  }
  const payload = JSON.stringify(body)
  const started = Date.now()
  const tried = []
  // 503(과부하)은 몇 초 만에 풀리는 일이 많음 → 후보를 두 바퀴 돌고, 실패 사이에 잠깐 쉼. 전체 25초 안에서
  const list = await geminiCandidates()
  const attempts = [...list, ...list]
  for (let a = 0; a < attempts.length; a++) {
    const model = attempts[a]
    if (Date.now() - started > 25000) break
    if (a > 0) await new Promise(res => setTimeout(res, a < list.length ? 400 : 1500))
    if ((geminiCooldown.get(model) ?? 0) > Date.now() && list.length > 1) continue
    let r
    try {
      r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
        body: payload,
        signal: AbortSignal.timeout(8000),
      })
    } catch {
      tried.push(`${model}: 시간 초과`)
      continue
    }
    if (r.status === 401 || r.status === 403) throw new HttpError(403, `Gemini 가 키를 거절함 (${r.status})`)
    if (!r.ok) {
      // 503 과부하·429 한도·500 오류 → 다음 시도. 404(없어진 모델)만 5분 쉬게 하고 목록을 다시 받음
      tried.push(`${model}: ${r.status}`)
      if (r.status === 404) {
        geminiCooldown.set(model, Date.now() + 5 * 60_000)
        geminiModels = null
      }
      continue
    }
    geminiModel = model
    const j = await r.json()
    const text = j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '{}'
    try {
      const o = JSON.parse(text)
      return { heard: String(o.heard || ''), place: String(o.place || ''), model }
    } catch {
      return { heard: text.slice(0, 200), place: '', model }
    }
  }
  console.error('[stt]', tried.join(' / '))
  throw new HttpError(502, 'Gemini 가 붐빔 — 잠시 뒤 다시 말해 주세요') // 자세한 내용은 PC 창(로그)에
}

// ── 길안내(자동차만) ──────────────────────────────────
// 네이버 Directions 5 "실시간 빠른길"(trafast, 실시간 교통 반영) — 콘솔 Maps 에서 Directions 5 체크 필요
// 응답 형식: { mode, distance(m), duration(s), path: [[위도,경도],...], steps: [{ i: path 위치, text, distance(m) }] }
async function routeDrive(slat, slng, glat, glng) {
  if (!MAP_ID || !MAP_KEY) throw new HttpError(503, '.env 에 네이버 지도 키가 없음')
  await spend('directions')
  const q = new URLSearchParams({ start: `${slng},${slat}`, goal: `${glng},${glat}`, option: 'trafast', lang: 'ko' })
  const r = await fetch(`${NAVER}/map-direction/v1/driving?${q}`, { headers: naverHeaders() })
  const j = await r.json().catch(() => ({}))
  if (r.status === 401 || r.status === 403) throw new HttpError(403, '네이버가 길찾기를 거절: 콘솔에서 Directions 5 를 체크하세요')
  if (!r.ok || j.code !== 0) {
    const why = { 1: '출발지와 도착지가 같음', 2: '출발지나 도착지가 도로 근처가 아님', 3: '자동차 길을 찾지 못함', 5: '거리가 너무 멂' }[j.code]
    throw new HttpError(422, why || `네이버 길찾기 실패 (${r.status})`)
  }
  const best = j.route?.trafast?.[0]
  if (!best) throw new HttpError(422, '길찾기 결과가 비어 있음')
  return {
    mode: 'drive',
    distance: best.summary.distance,
    duration: Math.round(best.summary.duration / 1000),
    path: best.path.map(([lng, lat]) => [lat, lng]),
    steps: (best.guide || []).map(g => ({ i: g.pointIndex, text: g.instructions, distance: g.distance })),
  }
}

const isLoopback = addr => ['127.0.0.1', '::1'].includes((addr || '').replace(/^::ffff:/, ''))

// PC 브라우저용 키 입력 화면(이 PC 에서 http://localhost:8790 으로 열 때만)
const SETUP_HTML = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cyber HUD KR 중계 서버</title><style>
body{margin:0;background:#0b0b0d;color:#e6e6ea;font:15px/1.5 system-ui,"Malgun Gothic",sans-serif}main{max-width:560px;margin:0 auto;padding:24px 16px}
h1{color:#fcee0a;font-size:20px;margin:0 0 4px}h2{color:#00f0ff;font-size:14px;margin:22px 0 8px}p,li{color:#8c8c96;font-size:13px}
label{display:block;margin:10px 0 4px;font-size:12px;color:#8c8c96}input{width:100%;box-sizing:border-box;padding:10px;background:#141418;color:#e6e6ea;border:1px solid #2a2a31;font:inherit}
button{margin:14px 8px 0 0;padding:10px 16px;background:#141418;color:#fcee0a;border:1px solid #fcee0a;font:inherit;cursor:pointer}button.s{color:#e6e6ea;border-color:#2a2a31}
#st{margin-top:12px;color:#e6e6ea}</style></head><body><main>
<h1>Cyber HUD KR 중계 서버</h1><p>이 PC 에서 돌아가는 내 중계 서버입니다. 키는 이 PC 의 <code>.env</code> 에만 저장되고, 다시 화면에 보여 주지 않습니다.</p>
<h2>지금 상태</h2><div id="now">확인 중…</div>
<h2>네이버 키 입력</h2>
<ol><li>console.ncloud.com → Services → Application Services → Maps → Application 등록</li>
<li><b>Reverse Geocoding</b>, <b>Geocoding</b> 체크 → 저장, "한도 및 알림 설정"에서 월 한도 + <b>한도 초과 사용: 허용안함</b></li>
<li>인증 정보의 Client ID / Client Secret 을 아래에. (선택) 장소 이름 검색은 NAVER API HUB 검색 API 키</li></ol>
<label>지도 Client ID</label><input id="mapId" type="password" autocomplete="off">
<label>지도 Client Secret</label><input id="mapKey" type="password" autocomplete="off">
<label>검색 Client ID (선택)</label><input id="searchId" type="password" autocomplete="off">
<label>검색 Client Secret (선택)</label><input id="searchSecret" type="password" autocomplete="off">
<h2>음성 검색 키 (선택)</h2>
<p>aistudio.google.com → Get API key → Create API key (무료, 카드 필요 없음). 무료 사용분은 Google 이 입력을 서비스 개선에 쓸 수 있습니다.</p>
<label>Gemini API key</label><input id="geminiKey" type="password" autocomplete="off">
<p>빈 칸은 기존 값을 그대로 둡니다. 자동차 길안내를 쓰려면 네이버 Maps Application 에서 <b>Directions 5</b> 도 체크하세요.</p>
<button id="save">저장</button><button id="test" class="s">시험 (서울시청)</button><button id="clear" class="s">키 모두 지우기</button>
<div id="st"></div></main><script>
const $=id=>document.getElementById(id);const st=t=>$('st').textContent=t;
async function now(){const j=await (await fetch('/health')).json();$('now').textContent='지도 키: '+(j.naverMap?'있음':'없음')+' / 검색 키: '+(j.naverSearch?'있음':'없음')+' / 음성(Gemini) 키: '+(j.gemini?'있음':'없음')}
async function post(b){const r=await fetch('/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});const j=await r.json();if(!r.ok)throw new Error(j.error||r.status);return j}
$('save').onclick=async()=>{try{await post({mapId:$('mapId').value,mapKey:$('mapKey').value,searchId:$('searchId').value,searchSecret:$('searchSecret').value,geminiKey:$('geminiKey').value});for(const i of ['mapId','mapKey','searchId','searchSecret','geminiKey'])$(i).value='';st('저장했습니다.');now()}catch(e){st('저장 실패: '+e.message)}};
$('clear').onclick=async()=>{if(!confirm('이 PC 에 저장된 네이버 키를 모두 지울까요?'))return;try{await post({clear:true});st('지웠습니다.');now()}catch(e){st('실패: '+e.message)}};
$('test').onclick=async()=>{st('시험 중…');const r=await fetch('/revgeo?lat=37.5663&lng=126.9779');const j=await r.json();st(r.ok?'성공: '+j.street+' / '+j.locality:(r.status===403?'네이버가 거절: 키가 틀렸거나 Reverse Geocoding 이 체크되지 않음':'실패: '+(j.error||r.status)))};
now();</script></body></html>`

// 월 한도(이 PC 가 이번 달 네이버를 부른 횟수). 네이버 콘솔 한도와 별개로 한 번 더 막음
const LIMITS = {
  revgeo: Number(process.env.REVGEO_MONTHLY_LIMIT || 3000),
  geocode: Number(process.env.GEOCODE_MONTHLY_LIMIT || 1000),
  search: Number(process.env.SEARCH_MONTHLY_LIMIT || 3000),
  directions: Number(process.env.DIRECTIONS_MONTHLY_LIMIT || 1000),
}

// ── 접속 허용: 이 PC 자신 + Tailscale 주소(100.64.0.0/10)만 ──
function allowed(addr = '') {
  const a = addr.replace(/^::ffff:/, '')
  if (a === '127.0.0.1' || a === '::1') return true
  const m = a.match(/^100\.(\d+)\.\d+\.\d+$/)
  return Boolean(m && Number(m[1]) >= 64 && Number(m[1]) <= 127)
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
  'Access-Control-Expose-Headers': 'X-Cache',
}
function send(res, status, body, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...cors, ...extra })
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
}
class HttpError extends Error {
  constructor(status, msg) {
    super(msg)
    this.status = status
  }
}

// ── 월 사용량 ─────────────────────────────────────
const monthKey = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 7) // 한국 시간 기준 달
const usageFile = api => path.join(CACHE_DIR, `usage-${api}-${monthKey()}.json`)
async function usage(api) {
  try {
    return JSON.parse(await readFile(usageFile(api), 'utf8')).calls || 0
  } catch {
    return 0
  }
}
async function spend(api) {
  const n = await usage(api)
  if (n >= LIMITS[api]) throw new HttpError(429, `이번 달 ${api} 한도(${LIMITS[api]}건) 도달`)
  await mkdir(CACHE_DIR, { recursive: true })
  await writeFile(usageFile(api), JSON.stringify({ calls: n + 1 }))
}

// ── 디스크 저장(같은 질문은 다시 묻지 않음) ──────────────
async function cached(name, ttlMs, make) {
  const file = path.join(CACHE_DIR, name)
  try {
    const st = await stat(file)
    if (Date.now() - st.mtimeMs < ttlMs) return { body: await readFile(file), cache: 'disk' }
  } catch {
    /* 없음 */
  }
  const body = Buffer.from(await make())
  await mkdir(CACHE_DIR, { recursive: true })
  await writeFile(file, body)
  return { body, cache: 'miss' }
}
const DAY = 24 * 3600 * 1000
const safe = s => Buffer.from(s).toString('base64url').slice(0, 120)

const naverHeaders = () => ({ 'x-ncp-apigw-api-key-id': MAP_ID, 'x-ncp-apigw-api-key': MAP_KEY, Accept: 'application/json' })
const naverStatus = s => (s === 401 || s === 403 ? 403 : s === 429 ? 429 : 502)

// ── 좌표 → 도로명·동 ─────────────────────────────────
async function revgeo(lat, lng) {
  if (!MAP_ID || !MAP_KEY) throw new HttpError(503, '.env 에 네이버 지도 키가 없음')
  const rl = lat.toFixed(4)
  const rg = lng.toFixed(4) // 약 10m 단위로 뭉갬
  return cached(`rg-${rl}_${rg}.json`, 30 * DAY, async () => {
    await spend('revgeo')
    const q = new URLSearchParams({ coords: `${rg},${rl}`, orders: 'roadaddr,admcode', output: 'json' })
    const r = await fetch(`${NAVER}/map-reversegeocode/v2/gc?${q}`, { headers: naverHeaders() })
    const j = await r.json().catch(() => ({}))
    const code = j.status?.code
    if (!r.ok || (code !== 0 && code !== 3)) throw new HttpError(naverStatus(r.status), `네이버 주소 변환 실패 (${r.status})`)
    const res = j.results || []
    const road = res.find(x => x.name === 'roadaddr')
    const adm = res.find(x => x.name === 'admcode')
    const area = (x, n) => x?.region?.[`area${n}`]?.name || ''
    const street = road?.land?.name || area(adm, 3) || area(road, 3) || null
    let locality = area(adm, 3) || area(road, 3) || null
    if (locality && locality === street) locality = area(adm, 2) || area(road, 2) || null
    return JSON.stringify({ street, locality })
  })
}

// ── 목적지 검색 ──────────────────────────────────────
async function search(query, lat, lng) {
  let items = []
  if (SEARCH_ID && SEARCH_SECRET) {
    const got = await cached(`sr-${safe(query)}.json`, 7 * DAY, async () => {
      await spend('search')
      const q = new URLSearchParams({ query, display: '5', format: 'json' })
      const r = await fetch(`${NAVER_SEARCH}?${q}`, { headers: { 'X-NCP-APIGW-API-KEY-ID': SEARCH_ID, 'X-NCP-APIGW-API-KEY': SEARCH_SECRET } })
      if (!r.ok) throw new HttpError(naverStatus(r.status), `네이버 장소 검색 실패 (${r.status})`)
      const j = await r.json()
      const out = []
      for (const it of j.items || []) {
        const x = Number(it.mapx)
        const y = Number(it.mapy)
        if (!(x > 1e8 && y > 1e7)) continue // 경도·위도 × 10^7
        out.push({ name: String(it.title || '').replace(/<[^>]+>/g, ''), address: it.roadAddress || it.address || '', lat: y / 1e7, lng: x / 1e7 })
      }
      return JSON.stringify(out)
    }).catch(e => {
      console.error('[search]', e.message)
      return null
    })
    if (got) items = JSON.parse(got.body.toString())
  }
  if (!items.length && MAP_ID && MAP_KEY) {
    await spend('geocode')
    const q = new URLSearchParams({ query, count: '5' })
    if (Number.isFinite(lat) && Number.isFinite(lng)) q.set('coordinate', `${lng},${lat}`)
    const r = await fetch(`${NAVER}/map-geocode/v2/geocode?${q}`, { headers: naverHeaders() })
    const j = await r.json().catch(() => ({}))
    if (!r.ok || j.status !== 'OK') throw new HttpError(naverStatus(r.status), `네이버 주소 검색 실패 (${r.status})`)
    items = (j.addresses || []).map(a => ({ name: a.roadAddress || a.jibunAddress, address: a.jibunAddress || '', lat: Number(a.y), lng: Number(a.x) }))
  }
  if (!MAP_ID && !SEARCH_ID) throw new HttpError(503, '.env 에 네이버 키가 없음')
  return { items }
}

// ── OSM 도로 자료(격자 칸) ────────────────────────────
const GRID_LAT = 0.006
const GRID_LON = 0.0075
const HALF_LAT = 0.0065
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
]
const ROADS =
  '^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|pedestrian|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$'
const osmInflight = new Map()

function osm(iy, ix) {
  const name = `osm-${iy}_${ix}.json`
  if (osmInflight.has(name)) return osmInflight.get(name)
  const job = cached(name, 7 * DAY, async () => {
    const lat = iy * GRID_LAT
    const lon = ix * GRID_LON
    const dLon = HALF_LAT / Math.max(0.2, Math.cos((lat * Math.PI) / 180))
    const b = `${(lat - HALF_LAT).toFixed(5)},${(lon - dLon).toFixed(5)},${(lat + HALF_LAT).toFixed(5)},${(lon + dLon).toFixed(5)}`
    const query = `[out:json][timeout:60];(way["highway"~"${ROADS}"](${b});way["natural"="water"](${b});way["leisure"="park"](${b});way["landuse"~"^(grass|park|recreation_ground)$"](${b}););out geom;`
    let last = ''
    for (const ep of OVERPASS) {
      try {
        const r = await fetch(ep, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'cyber-hud-kr-relay/0.2', Accept: 'application/json' },
          body: 'data=' + encodeURIComponent(query),
          signal: AbortSignal.timeout(70000),
        })
        if (!r.ok) throw new Error(`${new URL(ep).host} ${r.status}`)
        const j = await r.json()
        if (j.remark) throw new Error(`${new URL(ep).host} incomplete`)
        // 줄인 형식: k=종류(r 도로/w 물/p 공원), c=도로 등급, p=[위도,경도,...]
        const ways = []
        for (const el of j.elements || []) {
          if (el.type !== 'way' || !el.geometry || !el.tags) continue
          const p = []
          for (const g of el.geometry) p.push(Math.round(g.lat * 1e5) / 1e5, Math.round(g.lon * 1e5) / 1e5)
          ways.push({ k: el.tags.highway ? 'r' : el.tags.natural === 'water' ? 'w' : 'p', c: el.tags.highway || '', p })
        }
        return JSON.stringify({ lat, lon, ways })
      } catch (e) {
        last = e.message
      }
    }
    throw new HttpError(502, `OpenStreetMap 서버 모두 실패: ${last}`)
  }).finally(() => osmInflight.delete(name))
  osmInflight.set(name, job)
  return job
}

// ── 서버 ─────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (!allowed(req.socket.remoteAddress)) {
    res.writeHead(403)
    return res.end()
  }
  const u = new URL(req.url, 'http://x')
  if (req.method === 'OPTIONS') return send(res, 204, '')
  const n = k => Number(u.searchParams.get(k))
  try {
    // 키 입력 화면(이 PC 브라우저에서만)
    if (req.method === 'GET' && u.pathname === '/' && isLoopback(req.socket.remoteAddress)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(SETUP_HTML)
    }
    // 키 저장: 폰 앱(Tailscale) 또는 이 PC 의 입력 화면에서.
    // 이 PC 에서 연 다른 웹사이트가 몰래 바꾸지 못하도록, PC 에서 온 요청은 입력 화면 자신(localhost:포트)에서 온 것만 받음
    if (req.method === 'POST' && u.pathname === '/config') {
      const origin = req.headers.origin
      if (isLoopback(req.socket.remoteAddress) && origin && !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) {
        throw new HttpError(403, '다른 사이트에서 온 요청')
      }
      await saveKeys(await readBody(req))
      return send(res, 200, { ok: true, naverMap: Boolean(MAP_ID && MAP_KEY), naverSearch: Boolean(SEARCH_ID && SEARCH_SECRET), gemini: Boolean(GEMINI_KEY) })
    }
    // 음성 → 목적지: 본문은 16kHz 16비트 모노 PCM 그대로(최대 약 15초)
    if (req.method === 'POST' && u.pathname === '/stt') {
      const pcm = await readRaw(req, 16000 * 2 * 15)
      return send(res, 200, await speechToPlace(pcm))
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'GET 만 됩니다' })
    if (u.pathname === '/health') {
      // app: 앱이 "이 앱의 중계 서버가 맞는지" 확인하는 표식. 맞을 때만 좌표를 보냄
      return send(res, 200, {
        ok: true, app: 'cyber-hud-kr-relay', version: 3,
        naverMap: Boolean(MAP_ID && MAP_KEY), naverSearch: Boolean(SEARCH_ID && SEARCH_SECRET), gemini: Boolean(GEMINI_KEY),
      })
    }
    if (u.pathname === '/route') {
      const [slat, slng, glat, glng] = ['slat', 'slng', 'glat', 'glng'].map(n)
      if (![slat, slng, glat, glng].every(Number.isFinite)) throw new HttpError(400, '좌표가 없음')
      return send(res, 200, await routeDrive(slat, slng, glat, glng))
    }
    if (u.pathname === '/revgeo') {
      const lat = n('lat')
      const lng = n('lng')
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new HttpError(400, '좌표가 없음')
      const r = await revgeo(lat, lng)
      return send(res, 200, r.body, { 'X-Cache': r.cache })
    }
    if (u.pathname === '/search') {
      const q = (u.searchParams.get('q') || '').trim().slice(0, 100)
      if (!q) throw new HttpError(400, '검색어가 없음')
      return send(res, 200, await search(q, n('lat'), n('lng')))
    }
    if (u.pathname === '/osm') {
      const iy = n('iy')
      const ix = n('ix')
      if (!Number.isInteger(iy) || !Number.isInteger(ix) || Math.abs(iy) > 15000 || Math.abs(ix) > 24000) throw new HttpError(400, '칸 번호가 잘못됨')
      // 처음 받는 칸은 공용 지도 서버가 수십 초 걸림 → 폰 연결을 오래 붙잡지 않도록
      // 8초 안에 못 끝나면 "받는 중"(202)으로 바로 답하고, 받기는 PC 에서 계속함. 폰은 잠시 뒤 다시 물음
      const job = osm(iy, ix)
      job.catch(() => {}) // 202 로 답한 뒤 실패해도 서버가 죽지 않게
      const r = await Promise.race([job, new Promise(resolve => setTimeout(() => resolve(null), 8000))])
      if (!r) return send(res, 202, { pending: true })
      return send(res, 200, r.body, { 'X-Cache': r.cache })
    }
    return send(res, 404, { error: 'not found' })
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e)
    return send(res, e instanceof HttpError ? e.status : 502, { error: e.message })
  }
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Cyber HUD KR 중계 서버 시작: 포트 ${PORT}`)
  console.log(`  네이버 지도 키: ${MAP_ID && MAP_KEY ? '있음' : '없음(.env 확인)'} / 장소 검색 키: ${SEARCH_ID && SEARCH_SECRET ? '있음' : '없음(선택)'}`)
  console.log('  이 PC 와 Tailscale 기기(100.x)에서만 접속을 받습니다. 이 창을 닫으면 멈춥니다.')
  console.log(`  네이버 키 입력: 이 PC 브라우저에서 http://localhost:${PORT} 또는 폰 앱의 "내 PC로 네이버 쓰기"`)
})
