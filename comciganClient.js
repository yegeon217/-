/**
 * 컴시간 서버(comci.net)와 통신하는 저수준 클라이언트.
 * 학교 검색, 시간표 원본 JSON 조회, 코드 디코딩(교사/과목/변동여부)을 담당한다.
 *
 * 컴시간 서버는 다음과 같은 보호 장치를 사용한다.
 *  - /st 페이지의 스크립트가 XOR 방식으로 난독화되어 있다(중첩 가능).
 *  - API 호출에는 세션 쿠키 + X-Hour-Token 헤더가 필요하다.
 *  - 응답은 `enc5:<iv>:<암호문>:<HMAC>` 형태의 AES-256-CBC 암호문이다.
 *  - 학교명/교사명/과목명 등 문자열은 base64 + XOR(EUC-KR)로 한 번 더 인코딩된다.
 * 경로·키·필드명은 바뀔 수 있으므로 매 세션마다 페이지 스크립트에서 직접 추출한다.
 */
const crypto = require('crypto');
const iconv = require('iconv-lite');

const BASE_URL = 'http://comci.net:4082';
const ENTRY_PATH = '/st';
const SESSION_TTL_MS = 10 * 60 * 1000;
const RAW_CACHE_TTL_MS = 2 * 60 * 1000;

// 필드명을 스크립트에서 찾지 못했을 때 쓰는 기본값(2026-11 기준).
const DEFAULT_FIELDS = {
  baseline: '자료153', // 기준 시간표(원자료)
  actual: '자료178', // 실제 시간표(일일자료)
  teachers: '자료109',
  subjects: '자료126',
  periodTimes: '자료130',
  weekOptions: '자료166',
};

let session = null; // { cookie, token, createdAt, config }
let sessionPromise = null;

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/* ===== 난독화 해제 ===== */

const OBFUSCATED_RE =
  /\/\* hour-(?:ajax-)?obfuscated-v\d+ \*\/\(function\(a,k\)\{[\s\S]*?\}\)\((\[\[[\s\S]*?\]\]),(\d+)\);/g;

function decodeChunks(chunks, k) {
  let out = '';
  for (const [plain, body] of chunks) {
    if (plain) {
      out += body;
      continue;
    }
    for (let j = 0; j < body.length; j += 4) {
      out += String.fromCharCode(parseInt(body.substr(j, 4), 16) ^ ((k + (j / 4) * 13) & 255));
    }
  }
  return out;
}

function deobfuscate(src) {
  return src.replace(OBFUSCATED_RE, (_, arr, k) => deobfuscate(decodeChunks(JSON.parse(arr), Number(k))));
}

/* ===== 페이지 스크립트에서 접속 파라미터 추출 ===== */

function mustMatch(src, re, name) {
  const m = src.match(re);
  if (!m) throw new Error(`컴시간 서버 파라미터(${name}) 추출에 실패했습니다.`);
  return m;
}

function extractConfig(html) {
  const src = deobfuscate(html);

  const search = mustMatch(
    src,
    /function QAjaxSchool[\s\S]*?url:'\.\/(\d+)\?'\+encodeURIComponent\(btoa\('([^']*)'\+encodeURIComponent\(sc\)\+'([^']*)'\)\)/,
    '학교검색 경로'
  );
  const timetable = mustMatch(
    src,
    /function QAjaxTimetable[\s\S]*?url:'\.\/(\d+)\?'\+btoa\(s7\+'_'\+da1\+'_'\+r\+'([^']*)'\)/,
    '시간표 경로'
  );
  const scPrefix = mustMatch(src, /sc_data\('([^']*)'/, '학교 접두어')[1];

  const xorMatch = mustMatch(src, /function QnmsbChange[\s\S]*?String\.fromCharCode\(([\d,\s]+)\)/, '문자열 키');
  const xorKey = xorMatch[1].split(',').map((n) => Number(n.trim()));

  const keyMatch = mustMatch(
    src,
    /CryptoJS\.enc\.Hex\.parse\(\(function\(a\)\{return ([^;}]+);?\}\)\((\[[^\]]+\])\)\)/,
    '복호화 키'
  );
  const keyParts = [...keyMatch[2].matchAll(/'([0-9a-fA-F]+)'/g)].map((m) => m[1]);
  const keyHex = [...keyMatch[1].matchAll(/a\[(\d+)\]/g)].map((m) => keyParts[Number(m[1])]).join('');
  const aesKey = Buffer.from(keyHex, 'hex');
  if (![16, 24, 32].includes(aesKey.length)) {
    throw new Error('컴시간 복호화 키 형식을 해석할 수 없습니다.');
  }

  const field = (re, name) => src.match(re)?.[1] || DEFAULT_FIELDS[name];
  const fields = {
    baseline: field(/원자료=Q자료\(자료\.(자료\d+)\[/, 'baseline'),
    actual: field(/일일자료=Q자료\(자료\.(자료\d+)\[/, 'actual'),
    teachers: field(/성명=Q성명\(자료\.(자료\d+)\[/, 'teachers'),
    subjects: field(/과목명=Q과목명\(자료\.(자료\d+)\[/, 'subjects'),
    periodTimes: field(/class='교시'>"\+자료\.(자료\d+)\[/, 'periodTimes'),
    weekOptions: field(/일자설정하기\(H시간표\.(자료\d+)/, 'weekOptions'),
  };

  return {
    searchPath: search[1],
    searchPrefix: search[2],
    searchSuffix: search[3],
    timetablePath: timetable[1],
    timetableSuffix: timetable[2],
    scPrefix,
    xorKey,
    aesKey,
    hmacKey: crypto.createHash('sha256').update(aesKey).digest(),
    fields,
  };
}

/* ===== 세션 ===== */

function readSessionCookie(res) {
  const list = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie') || ''];
  return list
    .map((c) => c.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

async function ensureSession() {
  if (session && Date.now() - session.createdAt < SESSION_TTL_MS) return session;
  if (sessionPromise) return sessionPromise;

  sessionPromise = (async () => {
    const res = await fetchWithTimeout(BASE_URL + ENTRY_PATH, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) throw new Error(`컴시간 서버에 접속할 수 없습니다. (HTTP ${res.status})`);

    const cookie = readSessionCookie(res);
    const html = iconv.decode(Buffer.from(await res.arrayBuffer()), 'euc-kr');
    const token = html.match(/__HourRequestToken\s*=\s*'([^']*)'/)?.[1];
    if (!token) throw new Error('컴시간 서버 응답 구조를 해석할 수 없습니다.');

    session = { cookie, token, createdAt: Date.now(), config: extractConfig(html) };
    return session;
  })();

  try {
    return await sessionPromise;
  } finally {
    sessionPromise = null;
  }
}

/* ===== 응답 복호화 ===== */

function decryptPayload(text, config) {
  const data = text.replace(/\x00+$/, '');
  if (!data.startsWith('enc1:') && !data.startsWith('enc5:')) return data;

  const parts = data.split(':');
  if (parts.length !== 4) throw new Error('컴시간 응답 형식이 올바르지 않습니다.');

  const encoding = parts[0] === 'enc5' ? 'base64' : 'hex';
  const tag = crypto
    .createHmac('sha256', config.hmacKey)
    .update(parts.slice(0, 3).join(':'))
    .digest(encoding);
  if (tag !== parts[3]) throw new Error('컴시간 응답 검증에 실패했습니다.');

  const cipherName = `aes-${config.aesKey.length * 8}-cbc`;
  const decipher = crypto.createDecipheriv(cipherName, config.aesKey, Buffer.from(parts[1], encoding));
  const plain = Buffer.concat([decipher.update(Buffer.from(parts[2], encoding)), decipher.final()]);
  return plain.toString('utf8').replace(/\x00+$/, '');
}

/** base64 + XOR 로 인코딩된 문자열(학교명, 교사명, 과목명 등)을 푼다. */
function decodeText(value, config) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') return String(value);
  const bytes = Buffer.from(value, 'base64');
  const key = config.xorKey;
  for (let i = 0; i < bytes.length; i++) bytes[i] ^= key[i % key.length];
  return iconv.decode(bytes, 'euc-kr');
}

async function hourGet(pathAndQuery, retried = false) {
  const { cookie, token, config } = await ensureSession();
  const res = await fetchWithTimeout(BASE_URL + pathAndQuery, {
    headers: {
      Cookie: cookie,
      'X-Hour-Token': token,
      Referer: BASE_URL + ENTRY_PATH,
      'User-Agent': 'Mozilla/5.0',
    },
  });
  const text = await res.text();

  if (res.status === 403 && !retried) {
    // 세션/토큰 만료 → 새 세션으로 한 번 재시도
    session = null;
    return hourGet(pathAndQuery, true);
  }
  if (res.status === 429) throw new Error('컴시간 서버 요청 한도를 초과했습니다. 1분 후 다시 시도해주세요.');
  if (res.status === 503) throw new Error('컴시간 서버가 혼잡합니다. 잠시 후 다시 시도해주세요.');
  if (!res.ok) throw new Error(`컴시간 서버 오류 (HTTP ${res.status})`);

  const decrypted = decryptPayload(text, config);
  const trimmed = decrypted.substring(0, decrypted.lastIndexOf('}') + 1);
  if (!trimmed) {
    throw new Error('컴시간 서버로부터 빈 응답을 받았습니다.');
  }
  return { json: JSON.parse(trimmed), config };
}

/* ===== 공개 API ===== */

/**
 * 학교 이름으로 검색한다. 일과진행을 사용하지 않아 시간표를 열람할 수 없는 학교는 제외된다.
 * @returns {Promise<Array<{region:string, name:string, code:number}>>}
 */
async function searchSchools(keyword) {
  const { config } = await ensureSession();
  const payload = config.searchPrefix + encodeURIComponent(keyword) + config.searchSuffix;
  const query = encodeURIComponent(Buffer.from(payload).toString('base64'));
  const { json } = await hourGet(`/${config.searchPath}?${query}`);

  const list = json['학교검색'] || [];
  return list
    .filter((entry) => entry[0] !== 0)
    .map((entry) => {
      const codeIdx = Math.floor(entry[0] / 6347) + 2;
      return {
        region: decodeText(entry[1], config),
        name: decodeText(entry[2], config),
        code: Number(decodeText(entry[codeIdx], config)),
      };
    })
    .filter((school) => school.code);
}

const rawCache = new Map(); // `${schoolCode}_${week}` -> { at, promise }

/**
 * 학교의 시간표 원본 데이터를 조회한다. (짧은 시간 캐시하여 요청 한도 초과를 방지)
 * @param {number} schoolCode
 * @param {number} week 컴시간 서버의 일자 인덱스 (1 = 이번주, 2 = 다음주)
 */
async function fetchRawTimetable(schoolCode, week) {
  const cacheKey = `${schoolCode}_${week}`;
  const cached = rawCache.get(cacheKey);
  if (cached && Date.now() - cached.at < RAW_CACHE_TTL_MS) return cached.promise;

  const promise = (async () => {
    const { config } = await ensureSession();
    const payload = `${config.scPrefix}${schoolCode}_0_${week}${config.timetableSuffix}`;
    const query = Buffer.from(payload).toString('base64');
    return hourGet(`/${config.timetablePath}?${query}`);
  })();

  rawCache.set(cacheKey, { at: Date.now(), promise });
  promise.catch(() => rawCache.delete(cacheKey));
  return promise;
}

/**
 * 컴시간 특유의 결합 코드(예: 22032)를 [teacherIndex, subjectIndex]로 분해한다.
 * 3자리씩 오른쪽부터 끊어서 읽고, 4번째 이상 자리는 과목 번호의 천 단위로 붙는다.
 */
function splitCode(code) {
  const matched = String(code).match(/\d{1,3}(?=(\d{3})+(?!\d))|\d{1,3}$/g);
  if (!matched) return [0, 0];
  const [teacherIdx, subjectIdx = 0, extra = 0] = matched.reverse().map(Number);
  return [teacherIdx, subjectIdx + extra * 1000];
}

/** 컴시간 사이트의 Q성명 로직: 이름 중간의 '*'는 유지하고 앞/뒤의 '*' 하나만 제거한다. */
function cleanTeacherName(name) {
  if ((name.includes('*') && !name.startsWith('*') && !name.endsWith('*')) || (name.length === 2 && name[1] === '*')) {
    return name;
  }
  return name.replace('*', '');
}

const WEEKDAY_NAMES = ['', '월', '화', '수', '목', '금'];

/**
 * 원본 JSON에서 특정 학년/반의 1주일 시간표를 사람이 읽을 수 있는 형태로 뽑아낸다.
 * 변동수업 여부는 컴시간 사이트 자체 로직(baSplit)을 그대로 재현했다:
 *  - 변경알림 === 1 인 학교: 실제 데이터 코드가 '>'로 시작하면 변동
 *  - 그 외 학교: 기준표 코드와 실제표 코드가 다르면 변동
 */
function buildClassTimetable(raw, config, grade, classNum) {
  const { fields } = config;
  const separator = raw['분리'] || 100;
  const changeAlert = raw['변경알림'];
  const teachers = raw[fields.teachers] || [];
  const subjects = raw[fields.subjects] || [];
  const baseline = raw[fields.baseline];
  const actual = raw[fields.actual];
  const periodTimes = raw[fields.periodTimes] || [];
  const maxPeriods = periodTimes.length || 8;

  const days = [];

  for (let weekday = 1; weekday <= 5; weekday++) {
    const periods = [];

    for (let period = 1; period <= maxPeriods; period++) {
      const actualCell = actual?.[grade]?.[classNum]?.[weekday]?.[period];
      if (actualCell === undefined || actualCell === 0) continue;

      const baseCell = baseline?.[grade]?.[classNum]?.[weekday]?.[period] ?? 0;

      let changed = false;
      let codeToDecode = actualCell;

      if (changeAlert === 1) {
        if (String(actualCell).startsWith('>')) {
          changed = true;
          codeToDecode = String(actualCell).substring(1);
        }
      } else if (String(baseCell) !== String(actualCell)) {
        changed = true;
      }

      const [teacherIdx, subjectIdxRaw] = splitCode(codeToDecode);
      if (!teacherIdx) continue; // 빈 교시

      const subjectIdx = subjectIdxRaw % separator;
      const teacherName = cleanTeacherName(decodeText(teachers[teacherIdx], config));
      const subjectName = decodeText(subjects[subjectIdx], config);

      if (!subjectName && !teacherName) continue;

      periods.push({ period, subject: subjectName, teacher: teacherName, changed });
    }

    days.push({ weekday, weekdayName: WEEKDAY_NAMES[weekday], periods });
  }

  return days;
}

function weekOptionsOf(raw, config) {
  return (raw[config.fields.weekOptions] || []).map(([index, label]) => ({
    index,
    label: decodeText(label, config),
  }));
}

/** 실제 열람 가능한 학급수(학급수 - 가상학급수). index 0은 전체 합계. */
function classCountsOf(raw) {
  const counts = raw['학급수'] || [];
  const virtual = raw['가상학급수'] || [];
  return counts.map((n, i) => (i === 0 ? n : Math.max(0, n - (virtual[i] || 0))));
}

async function getSchoolMeta(schoolCode) {
  const { json: raw, config } = await fetchRawTimetable(schoolCode, 1);
  return {
    schoolName: decodeText(raw['학교명'], config),
    region: decodeText(raw['지역명'], config),
    classCounts: classCountsOf(raw),
    weekOptions: weekOptionsOf(raw, config),
    currentWeekIndex: raw['오늘r'],
    periodTimes: raw[config.fields.periodTimes] || [],
  };
}

async function getClassTimetable(schoolCode, grade, classNum, week) {
  const { json: raw, config } = await fetchRawTimetable(schoolCode, week);
  return {
    schoolName: decodeText(raw['학교명'], config),
    region: decodeText(raw['지역명'], config),
    weekOptions: weekOptionsOf(raw, config),
    currentWeekIndex: raw['오늘r'],
    grade,
    class: classNum,
    days: buildClassTimetable(raw, config, grade, classNum),
  };
}

module.exports = { searchSchools, getSchoolMeta, getClassTimetable };
