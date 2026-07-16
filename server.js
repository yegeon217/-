const express = require('express');
const path = require('path');
const { searchSchools, getSchoolMeta, getClassTimetable } = require('./comciganClient');
const { getMealInfo, getSchoolSchedule } = require('./neisClient');
const { getSchoolDetail } = require('./schoolinfoClient');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/schools', async (req, res) => {
  const keyword = String(req.query.keyword || '').trim();
  if (!keyword) {
    return res.status(400).json({ error: '학교 이름을 입력해주세요.' });
  }
  try {
    const schools = await searchSchools(keyword);
    res.json({ schools });
  } catch (err) {
    res.status(502).json({ error: '학교 검색에 실패했습니다.', detail: err.message });
  }
});

app.get('/api/school-meta', async (req, res) => {
  const code = Number(req.query.code);
  if (!code) {
    return res.status(400).json({ error: '학교 코드가 필요합니다.' });
  }
  try {
    const meta = await getSchoolMeta(code);
    res.json(meta);
  } catch (err) {
    res.status(502).json({ error: '학교 정보를 불러오지 못했습니다.', detail: err.message });
  }
});

app.get('/api/timetable', async (req, res) => {
  const code = Number(req.query.code);
  const grade = Number(req.query.grade);
  const classNum = Number(req.query.class);
  const week = Number(req.query.week) || 1;

  if (!code || !grade || !classNum) {
    return res.status(400).json({ error: '학교 코드, 학년, 반이 모두 필요합니다.' });
  }

  try {
    const timetable = await getClassTimetable(code, grade, classNum, week);
    res.json(timetable);
  } catch (err) {
    res.status(502).json({ error: '시간표를 불러오지 못했습니다.', detail: err.message });
  }
});

app.get('/api/meal', async (req, res) => {
  const name = String(req.query.name || '').trim();
  const region = String(req.query.region || '').trim();
  const date = String(req.query.date || '').trim();

  if (!name || !date) {
    return res.status(400).json({ error: '학교 이름과 날짜가 필요합니다.' });
  }
  try {
    const meals = await getMealInfo(name, region, date);
    res.json({ meals });
  } catch (err) {
    res.status(502).json({ error: '급식 정보를 불러오지 못했습니다.', detail: err.message });
  }
});

app.get('/api/school-detail', async (req, res) => {
  const name = String(req.query.name || '').trim();
  const region = String(req.query.region || '').trim();

  if (!name) {
    return res.status(400).json({ error: '학교 이름이 필요합니다.' });
  }
  try {
    const detail = await getSchoolDetail(name, region);
    res.json(detail);
  } catch (err) {
    res.status(502).json({ error: '학교 상세 정보를 불러오지 못했습니다.', detail: err.message });
  }
});

app.get('/api/calendar', async (req, res) => {
  const name = String(req.query.name || '').trim();
  const region = String(req.query.region || '').trim();
  const year = Number(req.query.year);
  const month = Number(req.query.month);

  if (!name || !year || !month) {
    return res.status(400).json({ error: '학교 이름, 연도, 월이 필요합니다.' });
  }
  try {
    const events = await getSchoolSchedule(name, region, year, month);
    res.json({ events });
  } catch (err) {
    res.status(502).json({ error: '학사일정을 불러오지 못했습니다.', detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});
