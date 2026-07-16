/**
 * 학교알리미(schoolinfo.go.kr) 공시 데이터 클라이언트.
 * 나이스 오픈 API가 제공하지 않는 총 학생수 / 성별 학생수 / 교원 1인당 학생수 /
 * 방과후학교 운영현황을 학교알리미 공시 페이지에서 직접 조회한다.
 * 이 사이트는 EUC-KR로 응답하며 정식 JSON API가 아닌 서버 렌더링 HTML 조각을
 * 반환하므로, 실제 공시 표 마크업을 정규식으로 파싱한다.
 */
const iconv = require('iconv-lite');

const BASE = 'https://www.schoolinfo.go.kr';

const SIDO_CODE = {
  '서울': '1100000000',
  '부산': '2600000000',
  '대구': '2700000000',
  '인천': '2800000000',
  '광주': '1200000000',
  '대전': '3000000000',
  '울산': '3100000000',
  '세종': '3611000000',
  '경기': '4100000000',
  '강원': '5100000000',
  '충북': '4300000000',
  '충남': '4400000000',
  '전북': '5200000000',
  '전남': '1200000000',
  '경북': '4700000000',
  '경남': '4800000000',
  '제주': '5000000000',
};

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function postForm(path, params) {
  return fetchWithTimeout(BASE + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': 'Mozilla/5.0',
    },
    body: new URLSearchParams(params).toString(),
  });
}

// 학교 검색용 *_json.do 엔드포인트는 UTF-8로 응답한다.
async function fetchJsonUtf8(path, params) {
  const res = await postForm(path, params);
  return res.text();
}

// 공시항목 HTML 조각(Pneipp_*)은 EUC-KR로 응답한다.
async function fetchFragmentEucKr(path, params) {
  const res = await postForm(path, params);
  const buf = Buffer.from(await res.arrayBuffer());
  return iconv.decode(buf, 'euc-kr');
}

function schoolKindCode(name) {
  if (name.includes('초등학교')) return '02';
  if (name.includes('중학교')) return '03';
  if (name.includes('고등학교')) return '04';
  return '05';
}

const schoolCache = new Map();

/**
 * 컴시간 학교명/지역명으로 학교알리미 학교식별코드(SHL_IDF_CD)를 찾는다.
 */
async function resolveSchool(name, region) {
  const cacheKey = `${name}|${region || ''}`;
  if (schoolCache.has(cacheKey)) return schoolCache.get(cacheKey);

  const sidoCode = SIDO_CODE[(region || '').slice(0, 2)];
  if (!sidoCode) {
    throw new Error('학교알리미에서 지역 코드를 찾을 수 없습니다.');
  }

  const text = await fetchJsonUtf8('/ei/ss/pneiss_a03_s0_school_json.do', {
    HG_JONGRYU_GB: schoolKindCode(name),
    SIDO_CODE: sidoCode,
    GUGUN_CODE: '',
  });
  const rows = JSON.parse(text);
  const match = rows.find((r) => r.SHL_NM === name) || rows.find((r) => r.SHL_NM.includes(name));
  if (!match) {
    throw new Error('학교알리미에서 학교 정보를 찾을 수 없습니다.');
  }

  const result = {
    shlIdfCd: match.SHL_IDF_CD,
    schoolName: match.SHL_NM,
    address: match.SHL_ROAD_NM_ADDR,
    homepage: match.HMPG_ADDR,
  };
  schoolCache.set(cacheKey, result);
  return result;
}

function currentDisclosureYear() {
  const now = new Date();
  // 학교알리미 공시연도는 학년도 기준(3월 시작)이라 1~2월은 전년도로 취급한다.
  return String(now.getMonth() >= 2 ? now.getFullYear() : now.getFullYear() - 1);
}

/**
 * 3-가-3. 학년별·학급별 학생수 조각에서 학년/특수/순회학급 합계를 합산한다.
 * 표는 (남,여,전체) 3열 x 5개 학급유형(1~3학년, 특수학급, 순회학급) 순서로 <td>가 나열된다.
 */
function parseStudentCounts(html) {
  const tableMatch = html.match(/<table class="box hidden_table">[\s\S]*?<\/table>/);
  if (!tableMatch) {
    throw new Error('학생수 데이터를 해석할 수 없습니다.');
  }
  const nums = [...tableMatch[0].matchAll(/<td>\s*(\d+)\s*<\/td>/g)].map((m) => Number(m[1]));
  let total = 0;
  let male = 0;
  let female = 0;
  for (let i = 0; i + 2 < nums.length; i += 3) {
    male += nums[i];
    female += nums[i + 1];
    total += nums[i + 2];
  }
  return { total, male, female };
}

/**
 * 6-가. 직위별 교원 현황 조각에서 "합계(A+B)" 행의 총계 값을 추출한다.
 */
function parseTeacherTotal(html) {
  const idx = html.indexOf('합계(A+B)');
  if (idx === -1) {
    throw new Error('교원 현황 데이터를 해석할 수 없습니다.');
  }
  const rowEnd = html.indexOf('</tr>', idx);
  const row = html.slice(idx, rowEnd === -1 ? undefined : rowEnd);
  const match = row.match(/title="총계"[^>]*>\s*(\d+)\s*<\/td>/);
  if (!match) {
    throw new Error('교원 총계를 찾을 수 없습니다.');
  }
  return Number(match[1]);
}

/**
 * 15-라. 방과후학교 운영 현황 조각에서 "프로그램수" 행(교과/특기적성/계)을 읽어
 * 실제로 운영 중인 프로그램이 1개 이상인지 판정한다.
 */
function parseAfterSchoolActive(html) {
  const idx = html.indexOf('프로그램수');
  if (idx === -1) return false;
  const rowEnd = html.indexOf('</tr>', idx);
  const row = html.slice(idx, rowEnd === -1 ? undefined : rowEnd);
  const nums = [...row.matchAll(/<td[^>]*>\s*(\d+)\s*<\/td>/g)].map((m) => Number(m[1]));
  if (!nums.length) return false;
  const total = nums.length >= 3 ? nums[2] : nums.reduce((a, b) => a + b, 0);
  return total > 0;
}

async function getSchoolDetail(name, region) {
  const school = await resolveSchool(name, region);
  const year = currentDisclosureYear();
  const common = {
    HG_NM: school.schoolName,
    SHL_IDF_CD: school.shlIdfCd,
    GS_TYPE: 'Y',
    JG_YEAR: year,
    JG_YEAR2: year,
    SORT: 'BR',
    CHOSEN_JG_YEAR: year,
    PRE_JG_YEAR: year,
    LOAD_TYPE: 'single',
  };

  const [studentsHtml, teachersHtml, afterSchoolHtml] = await Promise.all([
    fetchFragmentEucKr('/ei/pp/Pneipp_b03_s0p.do', {
      ...common,
      GS_HANGMOK_CD: '03',
      GS_HANGMOK_NO: '3-가-3',
      GS_HANGMOK_NM: '학년별·학급별 학생수',
      GS_BURYU_CD: 'JG010',
      JG_BURYU_CD: 'JG030',
      JG_HANGMOK_CD: '09',
      JG_GUBUN: '1',
    }),
    fetchFragmentEucKr('/ei/pp/Pneipp_b08_s0p.do', {
      ...common,
      GS_HANGMOK_CD: '08',
      GS_HANGMOK_NO: '6-가',
      GS_HANGMOK_NM: '직위별 교원 현황',
      GS_BURYU_CD: 'JG050',
      JG_BURYU_CD: 'JG060',
      JG_HANGMOK_CD: '22',
      JG_GUBUN: '1',
    }),
    fetchFragmentEucKr('/ei/pp/Pneipp_b73_s0p.do', {
      ...common,
      GS_HANGMOK_CD: '73',
      GS_HANGMOK_NO: '15-라',
      GS_HANGMOK_NM: '방과후학교 운영 계획 및 운영ㆍ지원현황',
      GS_BURYU_CD: 'JG130',
      JG_BURYU_CD: 'JG150',
      JG_HANGMOK_CD: '59',
      JG_GUBUN: '1',
    }),
  ]);

  const { total: totalStudents, male: maleStudents, female: femaleStudents } = parseStudentCounts(studentsHtml);
  const totalTeachers = parseTeacherTotal(teachersHtml);
  const afterSchoolActive = parseAfterSchoolActive(afterSchoolHtml);

  return {
    schoolName: school.schoolName,
    address: school.address,
    homepage: school.homepage,
    totalStudents,
    maleStudents,
    femaleStudents,
    totalTeachers,
    studentsPerTeacher: totalTeachers ? Math.round((totalStudents / totalTeachers) * 10) / 10 : null,
    afterSchoolActive,
  };
}

module.exports = { getSchoolDetail };
