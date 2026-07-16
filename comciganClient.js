/**
 * 컴시간 서버(comci.net)와 통신하는 저수준 클라이언트.
 * 학교 검색, 시간표 원본 JSON 조회, 코드 디코딩(교사/과목/변동여부)을 담당한다.
 */
const iconv = require('iconv-lite');

const BASE_URL = 'http://comci.net:4082';
const ENTRY_PATH = '/st';

let initState = null; // { extractCode, scPrefix }
let initPromise = null;

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function ensureInit() {
  if (initState) return initState;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const res = await fetchWithTimeout(BASE_URL + ENTRY_PATH);
    const buf = Buffer.from(await res.arrayBuffer());
    const html = iconv.decode(buf, 'euc-kr');

    const raIdx = html.indexOf('school_ra(sc)');
    const scIdx = html.indexOf("sc_data('");
    if (raIdx === -1 || scIdx === -1) {
      throw new Error('컴시간 서버 응답 구조를 해석할 수 없습니다.');
    }

    const raMatch = html.substr(raIdx, 60).match(/url:'\.(.*?)'/);
    const scMatch = html.substr(scIdx, 40).match(/\(.*?\)/);
    if (!raMatch || !scMatch) {
      throw new Error('컴시간 서버 파라미터 추출에 실패했습니다.');
    }

    const extractCode = raMatch[1]; // 예: /36179?17384l
    const scParts = scMatch[0].replace(/[()]/g, '').replace(/'/g, '').split(',');

    initState = {
      extractCode,
      scPrefix: scParts[0], // 예: 73629_
    };
    return initState;
  })();

  try {
    return await initPromise;
  } finally {
    initPromise = null;
  }
}

function toEucKrHex(text) {
  let hex = '';
  for (const byte of iconv.encode(text, 'euc-kr')) {
    hex += '%' + byte.toString(16);
  }
  return hex;
}

async function fetchJson(path) {
  const res = await fetchWithTimeout(BASE_URL + path);
  const text = await res.text();
  const trimmed = text.substring(0, text.lastIndexOf('}') + 1);
  if (!trimmed) {
    throw new Error('컴시간 서버로부터 빈 응답을 받았습니다.');
  }
  return JSON.parse(trimmed);
}

/**
 * 학교 이름으로 검색한다.
 * @returns {Promise<Array<{region:string, name:string, code:number}>>}
 */
async function searchSchools(keyword) {
  const { extractCode } = await ensureInit();
  const hex = toEucKrHex(keyword);
  const json = await fetchJson(extractCode + hex);
  const list = json['학교검색'] || [];
  return list.map(([, region, name, code]) => ({ region, name, code }));
}

/**
 * 학교의 시간표 원본 데이터를 조회한다.
 * @param {number} schoolCode
 * @param {number} week 1 = 이번주, 2 = 다음주 (컴시간 서버 기준)
 */
async function fetchRawTimetable(schoolCode, week) {
  const { extractCode, scPrefix } = await ensureInit();
  const payload = `${scPrefix}${schoolCode}_0_${week}`;
  const b64 = Buffer.from(payload).toString('base64');
  const path = extractCode.split('?')[0] + '?' + b64;
  return fetchJson(path);
}

/**
 * 컴시간 특유의 결합 코드(예: 29043)를 [teacherIndex, subjectIndex]로 분해한다.
 * 3자리씩 오른쪽부터 끊어서 읽는 방식.
 */
function splitCode(code) {
  const matched = String(code).match(/\d{1,3}(?=(\d{3})+(?!\d))|\d{1,3}$/g);
  if (!matched) return [0, 0];
  const [teacherIdx, subjectIdx] = matched.reverse().map(Number);
  return [teacherIdx, subjectIdx];
}

const WEEKDAY_NAMES = ['', '월', '화', '수', '목', '금'];

/**
 * 원본 JSON에서 특정 학년/반의 1주일 시간표를 사람이 읽을 수 있는 형태로 뽑아낸다.
 * 변동수업 여부는 컴시간 사이트 자체 로직(baSplit)을 그대로 재현했다:
 *  - 변경알림 === 1 인 학교: 실제 데이터 코드가 '>'로 시작하면 변동
 *  - 그 외 학교: 기준표(자료481) 코드와 실제표(자료147) 코드가 다르면 변동
 */
function buildClassTimetable(raw, grade, classNum) {
  const separator = raw['분리'] || 100;
  const changeAlert = raw['변경알림'];
  const teachers = raw['자료446'] || [];
  const subjects = raw['자료492'] || [];
  const baseline = raw['자료481'];
  const actual = raw['자료147'];
  const periodTimes = raw['일과시간'] || [];
  const maxPeriods = periodTimes.length || 8;

  const days = [];

  for (let weekday = 1; weekday <= 5; weekday++) {
    const periods = [];

    for (let period = 1; period <= maxPeriods; period++) {
      const actualCell = actual?.[grade]?.[classNum]?.[weekday]?.[period];
      if (actualCell === undefined || actualCell === 0) continue;

      const baseCell = baseline?.[grade]?.[classNum]?.[weekday]?.[period];

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
      const teacherName = String(teachers[teacherIdx] || '').replace(/\*/g, '');
      const subjectName = subjects[subjectIdx] || '';

      if (!subjectName && !teacherName) continue;

      periods.push({ period, subject: subjectName, teacher: teacherName, changed });
    }

    days.push({ weekday, weekdayName: WEEKDAY_NAMES[weekday], periods });
  }

  return days;
}

async function getSchoolMeta(schoolCode) {
  const raw = await fetchRawTimetable(schoolCode, 1);
  return {
    schoolName: raw['학교명'],
    region: raw['지역명'],
    classCounts: raw['학급수'] || [],
    weekOptions: (raw['일자자료'] || []).map(([index, label]) => ({ index, label })),
    currentWeekIndex: raw['오늘r'],
    periodTimes: raw['일과시간'] || [],
  };
}

async function getClassTimetable(schoolCode, grade, classNum, week) {
  const raw = await fetchRawTimetable(schoolCode, week);
  return {
    schoolName: raw['학교명'],
    region: raw['지역명'],
    weekOptions: (raw['일자자료'] || []).map(([index, label]) => ({ index, label })),
    currentWeekIndex: raw['오늘r'],
    grade,
    class: classNum,
    days: buildClassTimetable(raw, grade, classNum),
  };
}

module.exports = { searchSchools, getSchoolMeta, getClassTimetable };
