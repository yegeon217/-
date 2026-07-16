const SUBJECT_PALETTE = [
  '#ffd6e0', '#ffe3d6', '#fff2c9', '#e3f5cf', '#cdeee0',
  '#cdeffb', '#d6e2ff', '#e0d6ff', '#f3d6ff', '#ffd6f0',
  '#e8e3d6', '#d6ffe9',
];

function colorForSubject(name) {
  if (!name) return '#f4f1fb';
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) % 1000000007;
  }
  return SUBJECT_PALETTE[hash % SUBJECT_PALETTE.length];
}

const el = (id) => document.getElementById(id);

const schoolInput = el('school-input');
const searchBtn = el('search-btn');
const schoolList = el('school-list');
const statusMsg = el('status-msg');

const searchView = el('search-view');
const timetableView = el('timetable-view');
const timetableLayout = el('timetable-layout');
const backBtn = el('back-btn');

const schoolTitleBtn = el('school-title-btn');
const ttSchoolName = el('tt-school-name');
const ttClassName = el('tt-class-name');

const gradeSelect = el('grade-select');
const classSelect = el('class-select');
const weekThisBtn = el('week-this');
const weekNextBtn = el('week-next');
const weekLabel = el('week-label');
const timetableBody = el('timetable-body');
const ttStatusMsg = el('tt-status-msg');
const weekdayHeaders = document.querySelectorAll('.weekday-col');

const mealInfo = el('meal-info');
const mealDateLabel = el('meal-date-label');
const mealClose = el('meal-close');
const mealContent = el('meal-content');

const infoSidebar = el('info-sidebar');
const sidebarClose = el('sidebar-close');
const sidebarSchoolName = el('sidebar-school-name');
const statStudents = el('stat-students');
const statRatio = el('stat-ratio');
const statGender = el('stat-gender');
const statAfterschool = el('stat-afterschool');
const calPrevBtn = el('cal-prev');
const calNextBtn = el('cal-next');
const calMonthLabel = el('cal-month-label');
const calendarGrid = el('calendar-grid');
const calendarNote = document.querySelector('.calendar-note');

let selectedSchool = null;
let classCounts = [];
let weekOptions = [];
let currentWeek = 1;
let calDate = new Date();
let calendarEvents = [];

function setStatus(msg, isError) {
  statusMsg.textContent = msg || '';
  statusMsg.classList.toggle('error', Boolean(isError));
}

function setTtStatus(msg, isError) {
  ttStatusMsg.textContent = msg || '';
  ttStatusMsg.classList.toggle('error', Boolean(isError));
}

async function apiGet(url) {
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '요청에 실패했습니다.');
  return data;
}

async function doSearch() {
  const keyword = schoolInput.value.trim();
  if (!keyword) {
    setStatus('학교 이름을 입력해주세요.', true);
    return;
  }
  setStatus('검색 중...');
  schoolList.innerHTML = '';
  schoolList.classList.add('hidden');

  try {
    const { schools } = await apiGet('/api/schools?keyword=' + encodeURIComponent(keyword));
    if (!schools.length) {
      setStatus('검색 결과가 없습니다.', true);
      return;
    }
    renderSchoolList(schools);
    setStatus('');
  } catch (err) {
    setStatus(err.message, true);
  }
}

function renderSchoolList(schools) {
  schoolList.innerHTML = '';
  schools.forEach((school) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${school.name}</span><span class="region">${school.region}</span>`;
    li.addEventListener('click', () => selectSchool(school));
    schoolList.appendChild(li);
  });
  schoolList.classList.remove('hidden');
}

async function selectSchool(school) {
  selectedSchool = school;
  setStatus('학년/반 정보를 불러오는 중...');
  try {
    const meta = await apiGet('/api/school-meta?code=' + school.code);
    classCounts = meta.classCounts || [];
    weekOptions = meta.weekOptions || [];
    currentWeek = meta.currentWeekIndex || 1;
    populateGradeSelect();
    setStatus('');
    await loadTimetable(currentWeek);
  } catch (err) {
    setStatus(err.message, true);
  }
}

function populateGradeSelect() {
  gradeSelect.innerHTML = '';
  for (let g = 1; g < classCounts.length; g++) {
    if (!classCounts[g]) continue;
    const opt = document.createElement('option');
    opt.value = g;
    opt.textContent = g + '학년';
    gradeSelect.appendChild(opt);
  }
  populateClassSelect();
}

function populateClassSelect() {
  const grade = Number(gradeSelect.value) || Number(gradeSelect.options[0]?.value);
  const count = classCounts[grade] || 0;
  classSelect.innerHTML = '';
  for (let c = 1; c <= count; c++) {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c + '반';
    classSelect.appendChild(opt);
  }
}

gradeSelect.addEventListener('change', () => {
  populateClassSelect();
  loadTimetable(currentWeek);
});
classSelect.addEventListener('change', () => loadTimetable(currentWeek));

async function loadTimetable(week) {
  const grade = Number(gradeSelect.value);
  const classNum = Number(classSelect.value);
  if (!selectedSchool || !grade || !classNum) return;

  setTtStatus('시간표를 불러오는 중...');
  mealInfo.classList.add('hidden');
  try {
    const data = await apiGet(
      `/api/timetable?code=${selectedSchool.code}&grade=${grade}&class=${classNum}&week=${week}`
    );
    currentWeek = week;
    weekOptions = data.weekOptions || weekOptions;
    renderTimetable(data);
    showTimetableView();
    setTtStatus('');
  } catch (err) {
    setTtStatus(err.message, true);
  }
}

function renderTimetable(data) {
  ttSchoolName.textContent = selectedSchool.name;
  ttClassName.textContent = `${data.grade}학년 ${data.class}반`;
  sidebarSchoolName.textContent = selectedSchool.name;

  weekThisBtn.classList.toggle('active', currentWeek === 1);
  weekNextBtn.classList.toggle('active', currentWeek === 2);

  const label = weekOptions.find((w) => w.index === currentWeek);
  weekLabel.textContent = label ? label.label : '';

  const maxPeriod = Math.max(1, ...data.days.flatMap((d) => d.periods.map((p) => p.period)), 1);

  const cellMap = {};
  data.days.forEach((day) => {
    day.periods.forEach((p) => {
      cellMap[`${day.weekday}-${p.period}`] = p;
    });
  });

  timetableBody.innerHTML = '';
  for (let period = 1; period <= maxPeriod; period++) {
    const tr = document.createElement('tr');
    const periodTd = document.createElement('td');
    periodTd.textContent = period;
    tr.appendChild(periodTd);

    for (let weekday = 1; weekday <= 5; weekday++) {
      const td = document.createElement('td');
      const cell = cellMap[`${weekday}-${period}`];

      if (cell) {
        const box = document.createElement('div');
        box.className = 'cell-subject' + (cell.changed ? ' changed' : '');
        if (!cell.changed) {
          box.style.background = colorForSubject(cell.subject);
        }
        const subjectSpan = document.createElement('span');
        subjectSpan.className = 'subject-name';
        subjectSpan.textContent = cell.subject;
        const teacherSpan = document.createElement('span');
        teacherSpan.className = 'teacher-name';
        teacherSpan.textContent = cell.teacher;
        box.appendChild(subjectSpan);
        box.appendChild(teacherSpan);
        td.appendChild(box);
      }
      tr.appendChild(td);
    }
    timetableBody.appendChild(tr);
  }
}

function showTimetableView() {
  searchView.classList.add('hidden');
  timetableView.classList.remove('hidden');
}

function showSearchView() {
  timetableView.classList.add('hidden');
  timetableLayout.classList.remove('sidebar-open');
  mealInfo.classList.add('hidden');
  searchView.classList.remove('hidden');
}

/* ===== Meal info (NEIS mealServiceDietInfo) ===== */

function weekdayDate(weekday) {
  const today = new Date();
  const day = today.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() + mondayOffset);
  if (currentWeek === 2) monday.setDate(monday.getDate() + 7);
  const target = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + (weekday - 1));
  const y = target.getFullYear();
  const m = String(target.getMonth() + 1).padStart(2, '0');
  const d = String(target.getDate()).padStart(2, '0');
  return { ymd: `${y}${m}${d}`, label: `${y}.${m}.${d}` };
}

async function showMealInfo(weekday) {
  if (!selectedSchool) return;
  const { ymd, label } = weekdayDate(weekday);
  mealDateLabel.textContent = `${label} 급식 정보`;
  mealContent.innerHTML = '<p class="meal-empty">불러오는 중...</p>';
  mealInfo.classList.remove('hidden');

  try {
    const { meals } = await apiGet(
      `/api/meal?name=${encodeURIComponent(selectedSchool.name)}&region=${encodeURIComponent(selectedSchool.region || '')}&date=${ymd}`
    );
    if (!meals.length) {
      mealContent.innerHTML = '<p class="meal-empty">해당 날짜의 급식 정보가 없습니다.</p>';
      return;
    }
    mealContent.innerHTML = '';
    meals.forEach((meal) => {
      const block = document.createElement('div');
      block.className = 'meal-block';
      const title = document.createElement('div');
      title.className = 'meal-block-title';
      title.textContent = meal.mealType;
      const list = document.createElement('ul');
      list.className = 'meal-menu-list';
      meal.menu.forEach((item) => {
        const li = document.createElement('li');
        li.textContent = item;
        list.appendChild(li);
      });
      block.appendChild(title);
      block.appendChild(list);
      mealContent.appendChild(block);
    });
  } catch (err) {
    mealContent.innerHTML = `<p class="meal-empty">${err.message}</p>`;
  }
}

weekdayHeaders.forEach((th) => {
  th.addEventListener('click', () => showMealInfo(Number(th.dataset.weekday)));
});
mealClose.addEventListener('click', () => mealInfo.classList.add('hidden'));

/* ===== Info sidebar toggle ===== */

function openSidebar() {
  timetableLayout.classList.add('sidebar-open');
  loadSchoolDetail();
  renderCalendar();
}

function closeSidebar() {
  timetableLayout.classList.remove('sidebar-open');
}

schoolTitleBtn.addEventListener('click', () => {
  timetableLayout.classList.contains('sidebar-open') ? closeSidebar() : openSidebar();
});
sidebarClose.addEventListener('click', closeSidebar);

/* ===== School detail (학교알리미 공시데이터) ===== */

async function loadSchoolDetail() {
  if (!selectedSchool) return;
  statStudents.textContent = '불러오는 중...';
  statRatio.textContent = '-';
  statGender.textContent = '-';
  statAfterschool.textContent = '-';
  [statStudents, statRatio, statGender, statAfterschool].forEach((el2) => el2.classList.remove('muted'));

  try {
    const detail = await apiGet(
      `/api/school-detail?name=${encodeURIComponent(selectedSchool.name)}&region=${encodeURIComponent(selectedSchool.region || '')}`
    );
    statStudents.textContent = `${detail.totalStudents.toLocaleString()}명`;
    statRatio.textContent = detail.studentsPerTeacher != null ? `${detail.studentsPerTeacher}명` : '정보 없음';
    statGender.textContent = `남 ${detail.maleStudents.toLocaleString()} · 여 ${detail.femaleStudents.toLocaleString()}`;
    statAfterschool.textContent = detail.afterSchoolActive ? 'O' : 'X';
  } catch (err) {
    statStudents.textContent = '불러오기 실패';
    statRatio.textContent = '-';
    statGender.textContent = '-';
    statAfterschool.textContent = '-';
    [statStudents, statRatio, statGender, statAfterschool].forEach((el2) => el2.classList.add('muted'));
  }
}

/* ===== Calendar (NEIS SchoolSchedule) ===== */

async function renderCalendar() {
  const year = calDate.getFullYear();
  const month = calDate.getMonth();
  calMonthLabel.textContent = `${year}년 ${month + 1}월`;
  calendarNote.textContent = '학사일정 불러오는 중...';

  if (selectedSchool) {
    try {
      const { events } = await apiGet(
        `/api/calendar?name=${encodeURIComponent(selectedSchool.name)}&region=${encodeURIComponent(selectedSchool.region || '')}&year=${year}&month=${month + 1}`
      );
      calendarEvents = events;
      calendarNote.textContent = events.length ? '' : '해당 월 학사일정이 없습니다.';
    } catch (err) {
      calendarEvents = [];
      calendarNote.textContent = '학사일정을 불러오지 못했습니다.';
    }
  }

  const eventsByDay = {};
  calendarEvents.forEach((e) => {
    eventsByDay[e.date] = eventsByDay[e.date] ? `${eventsByDay[e.date]}, ${e.eventName}` : e.eventName;
  });

  const today = new Date();
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  calendarGrid.innerHTML = '';

  for (let i = 0; i < firstWeekday; i++) {
    const empty = document.createElement('span');
    empty.className = 'cal-day empty';
    calendarGrid.appendChild(empty);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const cell = document.createElement('span');
    cell.className = 'cal-day';
    if (
      d === today.getDate() &&
      month === today.getMonth() &&
      year === today.getFullYear()
    ) {
      cell.classList.add('today');
    }

    const numSpan = document.createElement('span');
    numSpan.className = 'cal-day-num';
    numSpan.textContent = d;
    cell.appendChild(numSpan);

    const ymd = `${year}${String(month + 1).padStart(2, '0')}${String(d).padStart(2, '0')}`;
    const eventText = eventsByDay[ymd];
    if (eventText) {
      cell.classList.add('has-event');
      cell.title = eventText;
      const eventSpan = document.createElement('span');
      eventSpan.className = 'cal-day-event';
      eventSpan.textContent = eventText;
      cell.appendChild(eventSpan);
    }

    calendarGrid.appendChild(cell);
  }
}

calPrevBtn.addEventListener('click', () => {
  calDate = new Date(calDate.getFullYear(), calDate.getMonth() - 1, 1);
  renderCalendar();
});
calNextBtn.addEventListener('click', () => {
  calDate = new Date(calDate.getFullYear(), calDate.getMonth() + 1, 1);
  renderCalendar();
});

searchBtn.addEventListener('click', doSearch);
schoolInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doSearch();
});
backBtn.addEventListener('click', showSearchView);
weekThisBtn.addEventListener('click', () => loadTimetable(1));
weekNextBtn.addEventListener('click', () => loadTimetable(2));
