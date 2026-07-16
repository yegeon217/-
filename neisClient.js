/**
 * 교육부 나이스(NEIS) 오픈 API 클라이언트.
 * 급식식단정보(mealServiceDietInfo), 학교기본정보(schoolInfo), 학사일정(SchoolSchedule)을 조회한다.
 *
 * 참고: 나이스 오픈 API는 학교의 총 학생수 / 교원 1인당 학생수 / 성별 학생수 통계를
 * 제공하지 않는다(해당 통계는 학교알리미(schoolinfo.go.kr) 쪽 데이터로, 별도 연동이 필요하다).
 * 따라서 학생수는 컴시간 학급수 데이터를 바탕으로 한 추정치이며, 방과후학교 운영여부는
 * 사용자 요청에 따라 학교명 기반의 임의(고정) 값으로 대체한다.
 */
const NEIS_BASE = 'https://open.neis.go.kr/hub';
const NEIS_KEY = process.env.NEIS_API_KEY || '';

async function fetchWithTimeout(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function buildUrl(endpoint, params) {
  const qs = new URLSearchParams({
    ...(NEIS_KEY ? { KEY: NEIS_KEY } : {}),
    Type: 'json',
    pIndex: '1',
    pSize: '100',
    ...params,
  });
  return `${NEIS_BASE}/${endpoint}?${qs.toString()}`;
}

const schoolCache = new Map(); // `${name}|${region}` -> resolved school info

/**
 * 컴시간 학교명/지역명으로 나이스 표준학교코드 + 시도교육청코드를 찾는다.
 */
async function resolveNeisSchool(name, region) {
  const cacheKey = `${name}|${region || ''}`;
  if (schoolCache.has(cacheKey)) return schoolCache.get(cacheKey);

  const json = await fetchWithTimeout(buildUrl('schoolInfo', { SCHUL_NM: name }));
  const rows = json?.schoolInfo?.[1]?.row || [];
  if (!rows.length) {
    throw new Error('나이스에서 학교 정보를 찾을 수 없습니다.');
  }

  let match = rows[0];
  if (region) {
    const shortRegion = region.slice(0, 2);
    const found = rows.find((r) => (r.LCTN_SC_NM || '').includes(shortRegion));
    if (found) match = found;
  }

  const result = {
    atptCode: match.ATPT_OFCDC_SC_CODE,
    schoolCode: match.SD_SCHUL_CODE,
    schoolName: match.SCHUL_NM,
    schoolKind: match.SCHUL_KND_SC_NM,
    address: match.ORG_RDNMA,
    foundDate: match.FOND_YMD,
    homepage: match.HMPG_ADRES,
  };
  schoolCache.set(cacheKey, result);
  return result;
}

/**
 * 특정 날짜(YYYYMMDD)의 급식 식단을 조회한다.
 */
async function getMealInfo(name, region, dateYmd) {
  const school = await resolveNeisSchool(name, region);
  const json = await fetchWithTimeout(
    buildUrl('mealServiceDietInfo', {
      ATPT_OFCDC_SC_CODE: school.atptCode,
      SD_SCHUL_CODE: school.schoolCode,
      MLSV_YMD: dateYmd,
    })
  );
  const rows = json?.mealServiceDietInfo?.[1]?.row || [];
  return rows.map((r) => ({
    date: r.MLSV_YMD,
    mealType: r.MMEAL_SC_NM,
    menu: (r.DDISH_NM || '')
      .split('<br/>')
      .map((s) => s.replace(/\([^)]*\)/g, '').trim())
      .filter(Boolean),
    calorie: r.CAL_INFO,
  }));
}

/**
 * 특정 연/월의 학사일정을 조회한다.
 */
async function getSchoolSchedule(name, region, year, month) {
  const school = await resolveNeisSchool(name, region);
  const mm = String(month).padStart(2, '0');
  const lastDay = new Date(Number(year), Number(month), 0).getDate();
  const json = await fetchWithTimeout(
    buildUrl('SchoolSchedule', {
      ATPT_OFCDC_SC_CODE: school.atptCode,
      SD_SCHUL_CODE: school.schoolCode,
      AA_FROM_YMD: `${year}${mm}01`,
      AA_TO_YMD: `${year}${mm}${String(lastDay).padStart(2, '0')}`,
    })
  );
  const rows = json?.SchoolSchedule?.[1]?.row || [];
  return rows.map((r) => ({
    date: r.AA_YMD,
    eventName: r.EVENT_NM,
  }));
}

module.exports = { getMealInfo, getSchoolSchedule };
