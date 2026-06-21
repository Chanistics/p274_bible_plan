// app.js

const STATE_KEY = 'parashat_tracker_state';
const PLAN_KEY_PREFIX = 'parashat_plan_v7_'; // 캐시 갱신 및 순차 배분(구약 완료 후 신약) 수정을 반영한 v7 접두사

let appState = {
  progress: {}, // { 'YYYY-MM-DD': { torah: true, megillah: false, ot: false... } }
  familyName: "P274 Bible Reading Plan",
  theme: "dark",
  overrideToday: null // 테스트용 임의 오늘 날짜 (YYYY-MM-DD)
};

let currentPlan = null;
let activeDateStr = null; // 선택된 날짜 (기본: 오늘)

// 성경 약어 사전 (대시보드 일정 표시용)
const BIBLE_ABBR_MAP = {
  '창세기': '창', '출애굽기': '출', '레위기': '레', '민수기': '민', '신명기': '신',
  '여호수아': '수', '사사기': '삿', '룻기': '룻', '사무엘상': '삼상', '사무엘하': '삼하',
  '열왕기상': '왕상', '열왕기하': '왕하', '역대상': '대상', '역대하': '대하',
  '에스라': '스', '느헤미야': '느', '에스더': '에', '욥기': '욥', '시편': '시',
  '잠언': '잠', '전도서': '전', '아가': '아', '이사야': '사', '예레미야': '렘',
  '예레미야 애가': '애', '에스겔': '겔', '다니엘': '단', '호세아': '호', '요엘': '욜',
  '아모스': '암', '오바댜': '옵', '요나': '욘', '미가': '미', '나훔': '나',
  '하박국': '합', '스바냐': '습', '학개': '학', '스가랴': '슥', '말라기': '말',
  '마태복음': '마', '마가복음': '막', '누가복음': '눅', '요한복음': '요', '사도행전': '행',
  '로마서': '롬', '고린도전서': '고전', '고린도후서': '고후', '갈라디아서': '갈',
  '에베소서': '엡', '빌립보서': '빌', '골로새서': '골', '데살로니가전서': '살전',
  '데살로니가후서': '살후', '디모데전서': '딤전', '디모데후서': '딤후', '디도서': '딛',
  '빌레몬서': '몬', '히브리서': '히', '야고보서': '야', '베드로전서': '벧전',
  '베드로후서': '벧후', '요한1서': '요일', '요한2서': '요이', '요한3서': '요삼',
  '유다서': '유', '요한계시록': '계'
};

function abbreviateReading(str) {
  if (!str) return '';
  let result = str;
  for (const [fullName, abbr] of Object.entries(BIBLE_ABBR_MAP)) {
    result = result.replace(new RegExp(fullName, 'g'), abbr);
  }
  result = result.replace(/장\s*~\s*/g, '-');
  result = result.replace(/장/g, '');
  return result;
}

// 성경에 기록된 절기 (레위기 23장 절기 + 에스더 부림절 + 심하트 토라)
const BIBLICAL_HOLIDAYS_MAP = {
  'rosh hashana': '나팔절 (Rosh Hashana)',
  'yom kippur': '대속죄일 (Yom Kippur)',
  'sukkot': '초막절 (Sukkot)',
  'shmini atzeret': '쉐미니 아쩨렛 (Shmini Atzeret)',
  'simchat torah': '심하트 토라 (Simchat Torah)',
  'purim': '부림절 (Purim)',
  'pesach': '유월절 (Pesach)',
  'passover': '유월절 (Pesach)',
  'shavuot': '칠칠절 (Shavuot)'
};

function getBiblicalHolidayName(name) {
  if (!name) return null;
  const lower = name.toLowerCase();
  if (lower.includes('rosh chodesh') || lower.includes('shabbat')) return null;
  if (lower.includes('erev') && !lower.includes('erev purim')) return null;
  
  for (const [key, value] of Object.entries(BIBLICAL_HOLIDAYS_MAP)) {
    if (lower.includes(key)) {
      return value;
    }
  }
  return null;
}

// 상세 파라샤 설명 매핑 및 더블 포션 처리 지원
function getParashaDetail(name) {
  if (!name) return null;
  const cleanName = name.replace(/^Parashat\s+|^Parashas\s+/i, '').trim();
  
  // 스펠링 예외 매핑
  const lookupName = cleanName === "Sh'lach" ? "Shelach" :
                     (cleanName === "V'Zot HaBerachah" || cleanName === "Vezot Haberakhah") ? "Vezot Haberakhah" :
                     cleanName;

  if (window.PARASHA_DETAILS && window.PARASHA_DETAILS[lookupName]) {
    return window.PARASHA_DETAILS[lookupName];
  }

  // 더블 포션인 경우 하이픈(-)으로 나누어 각각의 배경 설명을 합산
  if (lookupName.includes('-')) {
    const parts = lookupName.split('-');
    const details = [];
    for (const part of parts) {
      const pDetail = getParashaDetail(part.trim());
      if (pDetail) {
        details.push(`<div style="margin-bottom: 0.5rem;"><strong>${part.trim()}:</strong> ${pDetail}</div>`);
      }
    }
    return details.length > 0 ? details.join('') : null;
  }

  return null;
}

// 유틸: 오늘 날짜 YYYY-MM-DD
function getTodayStr() {
  if (appState && appState.overrideToday) {
    return appState.overrideToday;
  }
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().split('T')[0];
}

// 오늘 기준 현재 유대력 연도(hy)를 API로 구합니다.
async function getCurrentHebrewYear() {
  const todayStr = getTodayStr();
  const res = await fetch(`https://www.hebcal.com/converter?cfg=json&date=${todayStr}&g2h=1`);
  const data = await res.json();
  return data.hy.toString();
}

// 주어진 유대력 연도 기준, 창조의 첫째 주(Bereshit / 창세기 1주차)의 시작 일요일(Gregorian) 날짜를 찾습니다.
async function findBereshitSunday(hYear) {
  const gYear = Number(hYear) - 3761; // 예: 5786 -> 2025
  const items = await window.HebcalAPI.fetchHebcalYearData(gYear.toString());
  const bereshitItem = items.find(item => item.category === 'parashat' && item.title === 'Parashat Bereshit');
  if (bereshitItem) {
    const satParts = bereshitItem.date.split('-');
    const satDate = new Date(Date.UTC(parseInt(satParts[0]), parseInt(satParts[1])-1, parseInt(satParts[2])));
    const sunDate = new Date(satDate);
    sunDate.setUTCDate(satDate.getUTCDate() - 6); // 토요일에서 6일 전 = 일요일
    return sunDate.toISOString().split('T')[0];
  }
  return `${gYear}-10-12`; // fallback 기본값
}

// 유대력 첫날(플랜 시작일)로부터 경과 일수 구하기 (1 ~ 365) - 타임존 영향 없음
function getPlanDayNumber(dateStr) {
  const dates = Object.keys(currentPlan).sort();
  const idx = dates.indexOf(dateStr);
  return idx !== -1 ? idx + 1 : 1;
}

// 1년 플랜 중 몇 주차(1~52)인지 계산 (타임존 영향 최소화된 UTC 기준 계산)
function getPlanWeekNumber(dateStr) {
  const dates = Object.keys(currentPlan).sort();
  if (dates.length === 0) return 1;
  const firstDate = dates[0];
  
  const p1 = firstDate.split('-');
  const dFirst = new Date(Date.UTC(parseInt(p1[0]), parseInt(p1[1])-1, parseInt(p1[2])));
  
  const p2 = dateStr.split('-');
  const dCurrent = new Date(Date.UTC(parseInt(p2[0]), parseInt(p2[1])-1, parseInt(p2[2])));
  
  const firstSunday = new Date(dFirst);
  firstSunday.setUTCDate(dFirst.getUTCDate() - dFirst.getUTCDay());
  
  const currentSunday = new Date(dCurrent);
  currentSunday.setUTCDate(dCurrent.getUTCDate() - dCurrent.getUTCDay());
  
  const diffMs = currentSunday - firstSunday;
  const diffWeeks = Math.round(diffMs / (1000 * 60 * 60 * 24 * 7));
  return diffWeeks + 1;
}

// 선택한 날짜가 포함된 주(일~토)의 7일간의 날짜 스트링 구하기 (타임존 영향 없는 UTC 기준 계산)
function getWeekDates(dateStr) {
  const p = dateStr.split('-');
  const d = new Date(Date.UTC(parseInt(p[0]), parseInt(p[1])-1, parseInt(p[2])));
  const day = d.getUTCDay(); // 0: Sun, 6: Sat
  
  const sunday = new Date(d);
  sunday.setUTCDate(d.getUTCDate() - day);
  
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const temp = new Date(sunday);
    temp.setUTCDate(sunday.getUTCDate() + i);
    const tempStr = temp.toISOString().split('T')[0];
    dates.push(tempStr);
  }
  return dates;
}

// 하루치 일정이 전부 다 읽었는지 체크
function isDayCompleted(dayData, progressDay) {
  if (dayData.torah && !progressDay.torah) return false;
  if (dayData.megillah && !progressDay.megillah) return false;
  if (dayData.ot && dayData.ot.length > 0 && !progressDay.ot) return false;
  if (dayData.nt && dayData.nt.length > 0 && !progressDay.nt) return false;
  return true;
}

// 전체 통계 계산 (전체 체크항목 개수 기준 진율 + 완료 일수)
function calculateStats() {
  let totalReadings = 0;
  let completedReadings = 0;
  let completedDays = 0;
  let totalDays = 0;

  Object.keys(currentPlan).forEach(date => {
    const dayData = currentPlan[date];
    const progressDay = appState.progress[date] || {};
    
    let dayReadingsCount = 0;
    let dayCompletedCount = 0;

    if (dayData.torah) {
      totalReadings++;
      dayReadingsCount++;
      if (progressDay.torah) {
        completedReadings++;
        dayCompletedCount++;
      }
    }
    if (dayData.megillah) {
      totalReadings++;
      dayReadingsCount++;
      if (progressDay.megillah) {
        completedReadings++;
        dayCompletedCount++;
      }
    }
    if (dayData.ot && dayData.ot.length > 0) {
      totalReadings++;
      dayReadingsCount++;
      if (progressDay.ot) {
        completedReadings++;
        dayCompletedCount++;
      }
    }
    if (dayData.nt && dayData.nt.length > 0) {
      totalReadings++;
      dayReadingsCount++;
      if (progressDay.nt) {
        completedReadings++;
        dayCompletedCount++;
      }
    }

    if (dayReadingsCount > 0) {
      totalDays++;
      if (dayReadingsCount === dayCompletedCount) {
        completedDays++;
      }
    }
  });

  const percentage = totalReadings ? Math.round((completedReadings / totalReadings) * 100) : 0;
  return {
    percentage,
    completedDays,
    totalDays
  };
}

// 1. 초기화
async function initApp() {
  // 상태 로드
  const savedState = localStorage.getItem(STATE_KEY);
  if (savedState) {
    appState = JSON.parse(savedState);
    if (!appState.familyName) {
      appState.familyName = "P274 Bible Reading Plan";
    }
  } else {
    appState = {
      progress: {},
      familyName: "P274 Bible Reading Plan",
      theme: "dark"
    };
  }

  // 테마 적용
  const savedMode = appState.theme || 'dark';
  document.body.classList.toggle('light-mode', savedMode === 'light');

  // 현재 유대력 연도 기준 365일 플랜 생성
  let hYear = "5786";
  try {
    hYear = await getCurrentHebrewYear();
  } catch (e) {
    console.error("Failed to get Hebrew year dynamically, fallback to 5786", e);
  }

  const planKey = PLAN_KEY_PREFIX + hYear;
  let plan = localStorage.getItem(planKey);

  if (!plan) {
    document.getElementById('generating-overlay').classList.remove('hidden');
    
    // 유대력 첫날(Bereshit 주간 일요일) 산출
    let startDateStr = "2025-10-12";
    try {
      startDateStr = await findBereshitSunday(hYear);
    } catch (e) {
      console.error("Failed to find Bereshit Sunday, using fallback", e);
    }
    
    // 유대력 사이클에 걸쳐있는 양력 연도 2년분 Hebcal 데이터 획득
    const startGYear = new Date(startDateStr).getFullYear();
    const endGYear = startGYear + 1;
    
    const items1 = await window.HebcalAPI.fetchHebcalYearData(startGYear.toString());
    const items2 = await window.HebcalAPI.fetchHebcalYearData(endGYear.toString());
    const hebcalItems = [...items1, ...items2];
    
    const newPlan = window.Generator.generateHebrewYearPlan(hebcalItems, startDateStr);
    localStorage.setItem(planKey, JSON.stringify(newPlan));
    plan = newPlan;
    document.getElementById('generating-overlay').classList.add('hidden');
  } else {
    plan = JSON.parse(plan);
  }
  
  currentPlan = plan;

  // 오늘 날짜가 플랜 범위 내에 있으면 오늘을 선택, 없으면 플랜 첫날 선택
  const todayStr = getTodayStr();
  if (currentPlan[todayStr]) {
    activeDateStr = todayStr;
  } else {
    activeDateStr = Object.keys(currentPlan).sort()[0];
  }

  // Tab Setup
  setupTabs();

  // 화면 렌더링
  await renderDashboard();
}

// 탭 전환 핸들러 설정
function setupTabs() {
  document.querySelectorAll('.tab-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTab = btn.getAttribute('data-tab');
      
      document.querySelectorAll('.tab-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      
      document.querySelectorAll('.tab-pane').forEach(pane => pane.classList.remove('active'));
      const pane = document.getElementById(`tab-content-${targetTab}`);
      if (pane) {
        pane.classList.add('active');
      }
      
      if (targetTab === 'dashboard' || targetTab === 'reading' || targetTab === 'weekly') {
        renderDashboard();
      } else if (targetTab === 'annual') {
        renderAnnualView();
      } else if (targetTab === 'settings') {
        renderSettingsView();
      }
    });
  });

  // 캘린더 월 이동 버튼 리스너
  document.getElementById('btn-cal-prev').addEventListener('click', () => {
    if (calendarCurrentDate) {
      calendarCurrentDate.setUTCMonth(calendarCurrentDate.getUTCMonth() - 1);
      renderCalendar();
    }
  });

  document.getElementById('btn-cal-next').addEventListener('click', () => {
    if (calendarCurrentDate) {
      calendarCurrentDate.setUTCMonth(calendarCurrentDate.getUTCMonth() + 1);
      renderCalendar();
    }
  });

  // 설정 저장 버튼
  document.getElementById('btn-save-family-name').addEventListener('click', () => {
    const val = document.getElementById('input-family-name').value.trim();
    appState.familyName = val || "P274 Bible Reading Plan";
    localStorage.setItem(STATE_KEY, JSON.stringify(appState));
    alert('성경읽기표 이름이 저장되었습니다.');
    renderDashboard();
  });

  // 테마 설정 변경 리스너
  document.querySelectorAll('input[name="theme-mode"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      const mode = e.target.value;
      appState.theme = mode;
      localStorage.setItem(STATE_KEY, JSON.stringify(appState));
      document.body.classList.toggle('light-mode', mode === 'light');
    });
  });

  // 데이터 초기화 버튼
  document.getElementById('btn-reset-data').addEventListener('click', () => {
    if (confirm('모든 통독 진행 상황을 초기화하고 새로 시작하겠습니까? 이 작업은 되돌릴 수 없습니다.')) {
      appState.progress = {};
      localStorage.setItem(STATE_KEY, JSON.stringify(appState));
      alert('초기화되었습니다.');
      renderDashboard();
    }
  });

  // 날짜 설정 버튼 리스너
  document.getElementById('btn-save-override-date').addEventListener('click', () => {
    const val = document.getElementById('input-override-date').value;
    if (val) {
      appState.overrideToday = val;
      activeDateStr = val; // 대시보드 활성 날짜도 변경
      calendarCurrentDate = null; // 달력 월 초기화
      localStorage.setItem(STATE_KEY, JSON.stringify(appState));
      alert(`오늘 날짜가 ${val}로 지정되었습니다.`);
      renderDashboard();
    }
  });

  document.getElementById('btn-reset-override-date').addEventListener('click', () => {
    appState.overrideToday = null;
    calendarCurrentDate = null; // 달력 월 초기화
    
    // 실제 오늘 날짜 구하기
    const d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    const realToday = d.toISOString().split('T')[0];
    
    activeDateStr = realToday;
    localStorage.setItem(STATE_KEY, JSON.stringify(appState));
    
    document.getElementById('input-override-date').value = realToday;
    alert(`실제 오늘 날짜(${realToday})로 리셋되었습니다.`);
    renderDashboard();
  });

  // Ticker 일괄 완료 체크 버튼
  document.getElementById('btn-ticker-check').addEventListener('click', () => {
    const todayStr = getTodayStr();
    const todayData = currentPlan[todayStr];
    if (!todayData) return;
    const progressDay = appState.progress[todayStr] || {};
    const isCompleted = isDayCompleted(todayData, progressDay);
    toggleDayCompletion(todayStr, !isCompleted);
  });

  // 파라샤 의미 아코디언 토글 (대시보드 내)
  document.getElementById('btn-toggle-meaning-new').addEventListener('click', (e) => {
    const box = document.getElementById('parasha-meaning-box-new');
    const btn = e.currentTarget;
    if (box.style.display === 'none') {
      box.style.display = 'block';
      btn.textContent = '▲';
    } else {
      box.style.display = 'none';
      btn.textContent = '▼';
    }
  });

  // 본문 읽기 창 닫기 버튼 리스너
  document.getElementById('btn-close-reader').addEventListener('click', () => {
    document.getElementById('bible-reader-modal').classList.add('hidden');
  });

  // 본문 읽기 창 바깥 클릭 시 닫기
  document.getElementById('bible-reader-modal').addEventListener('click', (e) => {
    if (e.target.id === 'bible-reader-modal') {
      document.getElementById('bible-reader-modal').classList.add('hidden');
    }
  });
}

// 특정 일자의 모든 통독 항목 일괄 토글
function toggleDayCompletion(dateStr, markComplete) {
  const dayData = currentPlan[dateStr];
  if (!dayData) return;
  
  if (!appState.progress[dateStr]) appState.progress[dateStr] = {};
  
  if (markComplete) {
    if (dayData.torah) appState.progress[dateStr].torah = true;
    if (dayData.megillah) appState.progress[dateStr].megillah = true;
    if (dayData.ot && dayData.ot.length > 0) appState.progress[dateStr].ot = true;
    if (dayData.nt && dayData.nt.length > 0) appState.progress[dateStr].nt = true;
  } else {
    if (dayData.torah) appState.progress[dateStr].torah = false;
    if (dayData.megillah) appState.progress[dateStr].megillah = false;
    if (dayData.ot && dayData.ot.length > 0) appState.progress[dateStr].ot = false;
    if (dayData.nt && dayData.nt.length > 0) appState.progress[dateStr].nt = false;
  }
  
  localStorage.setItem(STATE_KEY, JSON.stringify(appState));
  renderDashboard();
}

// 2. 대시보드 (오늘 읽기) 렌더링
async function renderDashboard() {
  const todayStr = getTodayStr();
  
  if (!activeDateStr || !currentPlan[activeDateStr]) {
    activeDateStr = todayStr;
  }
  
  const todayData = currentPlan[activeDateStr];
  const gParts = activeDateStr.split('-');
  const gDate = new Date(Date.UTC(parseInt(gParts[0]), parseInt(gParts[1])-1, parseInt(gParts[2])));
  const days = ['일','월','화','수','목','금','토'];
  const dayStr = days[gDate.getUTCDay()];
  const dayOfYear = getPlanDayNumber(activeDateStr); // 유대력 첫날 기준 카운팅

  // 1. 헤더 유저 정보
  document.getElementById('family-title-text').textContent = appState.familyName || "P274 Bible Reading Plan";

  // 2. Stat Box 데이터 계산
  const todayPlan = currentPlan[todayStr];
  const nowDayOfYear = todayPlan ? getPlanDayNumber(todayStr) : getPlanDayNumber(activeDateStr);
  
  // 오늘 날짜 뱃지 (UTC 기준으로 파싱하여 표시)
  let todayDisplayDate = gDate;
  if (todayPlan) {
    const tParts = todayStr.split('-');
    todayDisplayDate = new Date(Date.UTC(parseInt(tParts[0]), parseInt(tParts[1])-1, parseInt(tParts[2])));
  }
  document.getElementById('stat-today-val').textContent = `${nowDayOfYear}일차`;

  const stats = calculateStats();
  document.getElementById('stat-progress-val').textContent = `${stats.percentage}%`;
  document.getElementById('stat-completed-val').textContent = `${stats.completedDays} / 365`;

  // 3. 유대력 및 절기 정보 헤더 영역 동적 로드
  const hebDateObj = await window.HebcalAPI.convertToHebrewDate(todayStr);
  const tParts = todayStr.split('-');
  const gYr = parseInt(tParts[0], 10);
  const gMon = parseInt(tParts[1], 10);
  const gDay = parseInt(tParts[2], 10);
  const gregorianKOR = `${gYr}년 ${gMon}월 ${gDay}일`;

  let bannerText = `${gregorianKOR}`;
  if (hebDateObj && hebDateObj.hm) {
    bannerText += ` | ${hebDateObj.hd} ${hebDateObj.hm} ${hebDateObj.hy} / ${hebDateObj.hebrew}`;
  }
  if (todayPlan && todayPlan.holidays && todayPlan.holidays.length > 0) {
    let biblicalHol = null;
    for (const h of todayPlan.holidays) {
      const name = getBiblicalHolidayName(h.name);
      if (name) {
        biblicalHol = name;
        break;
      }
    }
    if (biblicalHol) {
      bannerText += ` | ✨ ${biblicalHol}`;
    }
  }
  document.getElementById('header-hebcal-banner').textContent = bannerText;

  // 4. Ticker Bar 정보 (오늘 기준)
  if (todayPlan) {
    const rawPName = todayPlan.parasha || "Special Week";
    const pName = rawPName.replace(/^Parashat\s+|^Parashas\s+/i, '');
    const meta = window.getParashaMeta(pName);
    const weekNum = getPlanWeekNumber(todayStr);
    const torahTranslated = window.BIBLE_DATA.translateTorahReading(todayPlan.torah);
    const megillahText = todayPlan.megillah ? ` | ${todayPlan.megillah}` : '';
    let otText = '';
    if (todayPlan.ot && todayPlan.ot.length > 0) {
      otText = ` | 구약: ${todayPlan.ot[0].book} ${todayPlan.ot[0].chapter}장` + 
               (todayPlan.ot.length > 1 ? `~${todayPlan.ot[todayPlan.ot.length-1].chapter}장` : '');
    }
    let ntText = '';
    if (todayPlan.nt && todayPlan.nt.length > 0) {
      ntText = ` | 신약: ${todayPlan.nt[0].book} ${todayPlan.nt[0].chapter}장` + 
               (todayPlan.nt.length > 1 ? `~${todayPlan.nt[todayPlan.nt.length-1].chapter}장` : '');
    }
    document.getElementById('ticker-reading-text').textContent = 
      pName === "Special Week" 
        ? `절기 주간 — ${torahTranslated || '절기 본문'}${megillahText}${otText}${ntText}`
        : `${weekNum}주차 ${pName} (${meta.ko}) — ${torahTranslated || '일정 없음'}${megillahText}${otText}${ntText}`;
  }

  // 5. 왼쪽 카드: 금주의 파라샤 정보
  if (todayPlan) {
    const rawPName = todayPlan.parasha || "Special Week";
    const pName = rawPName.replace(/^Parashat\s+|^Parashas\s+/i, '');
    const meta = window.getParashaMeta(pName);
    const weekNum = getPlanWeekNumber(todayStr);

    const torahTranslated = window.BIBLE_DATA.translateTorahReading(todayPlan.torah);
    let bookName = '토라';
    if (torahTranslated) {
      const match = torahTranslated.match(/^([가-힣a-zA-Z0-9\s]+?)\s+\d+/);
      if (match) {
        bookName = match[1].trim();
      }
    }
    const TORAH_BOOK_HEB_MAP = {
      '창세기': '베레시트',
      '출애굽기': '쉐모트',
      '레위기': '바이크라',
      '민수기': '바미드바르',
      '신명기': '데바림'
    };
    const bookHeb = TORAH_BOOK_HEB_MAP[bookName] || '토라';
    
    document.getElementById('parasha-badge-text').textContent = 
      pName === "Special Week" ? "절기 주간" : `${weekNum}주차 ㆍ ${bookName} (${bookHeb})`;
    document.getElementById('parasha-title-text').textContent = pName;
    document.getElementById('parasha-meaning-text-dashboard').textContent = pName === "Special Week" ? "절기 특별 본문" : meta.meaning;
    
    // 상세 문화/성경 설명 바인딩
    const detailBox = document.getElementById('parasha-meaning-box-new');
    let detailHtml = '';

    detailHtml += `<div style="margin-bottom: 0.75rem;">
      <strong style="color: var(--gold);">히브리어: </strong>
      <span style="font-size: 1.1rem; font-family: 'Noto Sans KR', sans-serif; font-weight: 500;">${meta.he || '-'}</span>
    </div>`;

    const pDetail = getParashaDetail(pName);
    if (pDetail) {
      detailHtml += `<div style="margin-bottom: 1rem; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 0.75rem;">
        <strong style="color: var(--gold); display: block; margin-bottom: 0.25rem;">📖 파라샤 배경과 의미</strong>
        <div style="font-size: 0.9rem; line-height: 1.5; color: var(--text-muted); margin: 0; word-break: keep-all;">${pDetail}</div>
      </div>`;
    }

    let activeBiblicalHoliday = null;
    if (todayPlan.holidays && todayPlan.holidays.length > 0) {
      for (const h of todayPlan.holidays) {
        if (getBiblicalHolidayName(h.name)) {
          activeBiblicalHoliday = h.name;
          break;
        }
      }
    }

    if (activeBiblicalHoliday) {
      const lower = activeBiblicalHoliday.toLowerCase();
      let holidayKey = null;
      if (lower.includes('pesach') || lower.includes('passover')) holidayKey = 'Pesach';
      else if (lower.includes('shavuot')) holidayKey = 'Shavuot';
      else if (lower.includes('rosh hashana')) holidayKey = 'Rosh Hashana';
      else if (lower.includes('yom kippur')) holidayKey = 'Yom Kippur';
      else if (lower.includes('sukkot')) holidayKey = 'Sukkot';
      else if (lower.includes('shmini atzeret')) holidayKey = 'Shmini Atzeret';
      else if (lower.includes('simchat torah')) holidayKey = 'Simchat Torah';
      else if (lower.includes('purim')) holidayKey = 'Purim';

      const BIBLICAL_HOLIDAYS_DETAIL = {
        'Pesach': {
          name: '유월절 (Pesach / Passover)',
          desc: '<strong>성경적 배경:</strong> 애굽의 종살이에서 이스라엘을 구원하기 위해 열 번째 재앙(장자의 죽음)을 내리실 때, 어린 양의 피를 문설주에 바른 집은 죽음의 재앙이 "넘어갔던(Passover)" 것에서 유래합니다(출 12장).<br><br><strong>문화와 의미:</strong> 누룩 없는 빵인 무교병을 먹으며 고난을 기억하고 자유의 기쁨을 선포합니다. 신약 성경에서는 예수 그리스도를 세상 죄를 지고 가는 유월절 어린 양의 실체로 해석합니다(고전 5:7).'
        },
        'Shavuot': {
          name: '칠칠절 / 오순절 (Shavuot / Pentecost)',
          desc: '<strong>성경적 배경:</strong> 유월절 다음 날부터 7주를 센 후(49일) 50일째 되는 날에 드리는 절기입니다(레 23:15-21). 시내산에서 모세가 토라(율법)를 받은 날로 전통적으로 기억됩니다.<br><br><strong>문화와 의미:</strong> 첫 열매를 바치는 수확의 기쁨과 토라의 계시를 축하합니다. 신약 시대에는 바로 이 날에 사도들에게 성령이 임하여(행 2장) 신약 교회의 탄생을 알리는 성령 강림의 날로 완성되었습니다.'
        },
        'Rosh Hashana': {
          name: '나팔절 (Rosh Hashana / Yom Teruah)',
          desc: '<strong>성경적 배경:</strong> 유대 종교력 7월 1일에 숫양의 뿔나팔(쇼파르)을 크게 불어 회중을 소집하는 날입니다(레 23:23-25).<br><br><strong>문화와 의미:</strong> 창조주 하나님의 왕권을 선포하고 한 해 동안 지은 죄를 돌아보는 회개의 10일을 시작하는 신호입니다. 영적으로는 마지막 날 주님의 재림과 심판, 그리고 성도의 부활을 알리는 나팔 소리를 예표합니다.'
        },
        'Yom Kippur': {
          name: '대속죄일 (Yom Kippur / Day of Atonement)',
          desc: '<strong>성경적 배경:</strong> 일 년 중 단 하루, 대제사장이 이스라엘 온 회중의 죄를 속하기 위해 지성소에 들어가는 날입니다(레 16장, 23:26-32).<br><br><strong>문화와 의미:</strong> 하루 동안 금식하며 스스로를 괴롭게 하여 온전한 회개와 죄 사함을 간구합니다. 히브리서에서는 단번에 자기 피로 하늘의 참 지성소에 들어가 영원한 속죄를 이루신 예수 그리스도의 구속 사역으로 설명합니다.'
        },
        'Sukkot': {
          name: '초막절 / 장막절 (Sukkot / Tabernacles)',
          desc: '<strong>성경적 배경:</strong> 출애굽 후 40년간 광야 생활을 하는 동안 하나님께서 이스라엘을 초막 속에서 보호하시고 인도하셨음을 기억하며 지키는 가을 절기입니다(레 23:33-43).<br><br><strong>문화와 의미:</strong> 나뭇가지로 야외에 초막을 지어 거주하며 수확물(수장절)을 주신 하나님께 감사하고, 장차 하나님의 장막이 이 땅에 임하여 만국이 주님과 함께 영원히 거하게 될 메시아 왕국의 완성(계 21:3)을 상징합니다.'
        },
        'Shmini Atzeret': {
          name: '쉐미니 아쩨렛 (Shmini Atzeret)',
          desc: '<strong>성경적 배경:</strong> 초막절 7일 축제가 끝난 바로 다음 날인 8일째에 따로 모이는 거룩한 성회입니다(레 23:36).<br><br><strong>문화와 의미:</strong> 랍비들은 7일간의 초막절이 온 인류를 위한 축제라면, 8일째의 쉐미니 아쩨렛은 하나님께서 이스라엘 자녀들만 따로 조용히 머무르도록 독대하시는 친밀한 시간이라고 설명합니다.'
        },
        'Simchat Torah': {
          name: '심하트 토라 (Simchat Torah)',
          desc: '<strong>성경적 배경:</strong> 모세오경(토라)의 마지막 신명기 구절을 완독하고, 즉시 다시 창세기 1장 1절을 읽어 새 주기를 시작하는 절기입니다.<br><br><strong>문화와 의미:</strong> 회당에서 모든 토라 두루마리를 꺼내 들고 원을 그리며 춤을 추고(하카포트), 말씀 주신 하나님을 향한 무한한 감사와 기쁨을 선포하며 메시아 그리스도의 영접을 노래합니다.'
        },
        'Purim': {
          name: '부림절 (Purim)',
          desc: '<strong>성경적 배경:</strong> 페르시아 제국 시절, 유대 민족을 말살하려던 악한 하만의 음모에 맞서 에스더 왕비의 믿음의 결단과 모르드개의 지혜로 인해 구원을 얻은 날을 기념합니다(에스더 9장).<br><br><strong>문화와 의미:</strong> 하만이 제비(부르)를 던졌던 것에서 이름이 유래했습니다. 에스더서를 낭독하며 하만의 이름이 나올 때마다 소리를 지르고, 가난한 자들을 구제하며 기쁨을 나눕니다.'
        }
      };

      const holDetail = BIBLICAL_HOLIDAYS_DETAIL[holidayKey];
      if (holDetail) {
        detailHtml += `<div style="margin-top: 1rem; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 0.75rem;">
          <strong style="color: var(--gold); display: block; margin-bottom: 0.25rem;">✨ 절기 배경: ${holDetail.name}</strong>
          <p style="font-size: 0.9rem; line-height: 1.5; color: var(--text-muted); margin: 0; word-break: keep-all;">${holDetail.desc}</p>
        </div>`;
      }
    }

    detailBox.innerHTML = detailHtml;
  }

  // 6. 왼쪽 카드: 오늘의 통독 목록
  const realTodayDayOfYear = getPlanDayNumber(todayStr);
  document.getElementById('checklist-date-title').textContent = `오늘의 통독 (${realTodayDayOfYear}일차)`;

  const checklistContainer = document.getElementById('reading-checklist-container');
  checklistContainer.innerHTML = '';

  if (todayPlan) {
    const progressToday = appState.progress[todayStr] || {};
    
    if (todayPlan.torah) {
      const title = window.BIBLE_DATA.translateTorahReading(todayPlan.torah);
      checklistContainer.appendChild(createChecklistItem('torah', '토라포션', title, progressToday.torah, todayStr));
    }
    if (todayPlan.megillah) {
      checklistContainer.appendChild(createChecklistItem('megillah', '메길롯', todayPlan.megillah, progressToday.megillah, todayStr));
    }
    if (todayPlan.ot && todayPlan.ot.length > 0) {
      const title = `${todayPlan.ot[0].book} ${todayPlan.ot[0].chapter}장` + 
                    (todayPlan.ot.length > 1 ? ` ~ ${todayPlan.ot[todayPlan.ot.length-1].chapter}장` : '');
      checklistContainer.appendChild(createChecklistItem('ot', '구약 성경', title, progressToday.ot, todayStr));
    }
    if (todayPlan.nt && todayPlan.nt.length > 0) {
      const title = `${todayPlan.nt[0].book} ${todayPlan.nt[0].chapter}장` + 
                    (todayPlan.nt.length > 1 ? ` ~ ${todayPlan.nt[todayPlan.nt.length-1].chapter}장` : '');
      checklistContainer.appendChild(createChecklistItem('nt', '신약 성경', title, progressToday.nt, todayStr));
    }
  }

  // 7. 오른쪽 카드: 이번 주 (7일) 일정
  const scheduleContainer = document.getElementById('weekly-schedule-container');
  scheduleContainer.innerHTML = '';
  const weekDates = getWeekDates(activeDateStr);

  weekDates.forEach(dateStr => {
    const dayData = currentPlan[dateStr];
    if (!dayData) return;

    const dParts = dateStr.split('-');
    const d = new Date(Date.UTC(parseInt(dParts[0]), parseInt(dParts[1])-1, parseInt(dParts[2])));
    const dayName = days[d.getUTCDay()];
    const dOfYear = getPlanDayNumber(dateStr);

    const isToday = dateStr === todayStr;
    const isActive = dateStr === activeDateStr;
    
    const progressDay = appState.progress[dateStr] || {};
    const isCompleted = isDayCompleted(dayData, progressDay);

    const readings = [];
    if (dayData.torah) {
      readings.push(`<span class="sched-tag torah">${abbreviateReading(window.BIBLE_DATA.translateTorahReading(dayData.torah))}</span>`);
    }
    if (dayData.megillah) {
      readings.push(`<span class="sched-tag megillah">${abbreviateReading(dayData.megillah)}</span>`);
    }
    if (dayData.ot && dayData.ot.length > 0) {
      const title = `${dayData.ot[0].book} ${dayData.ot[0].chapter}장` + 
                    (dayData.ot.length > 1 ? `~${dayData.ot[dayData.ot.length-1].chapter}장` : '');
      readings.push(`<span class="sched-tag ot">${abbreviateReading(title)}</span>`);
    }
    if (dayData.nt && dayData.nt.length > 0) {
      const title = `${dayData.nt[0].book} ${dayData.nt[0].chapter}장` + 
                    (dayData.nt.length > 1 ? `~${dayData.nt[dayData.nt.length-1].chapter}장` : '');
      readings.push(`<span class="sched-tag nt">${abbreviateReading(title)}</span>`);
    }

    const row = document.createElement('div');
    row.className = `schedule-day-row ${isActive ? 'active' : ''} ${isCompleted ? 'completed' : ''}`;
    row.innerHTML = `
      <div class="sched-chk-box"></div>
      <div class="sched-info">
        <div class="sched-day-title">
          <span>${dOfYear}일차 - ${d.getUTCMonth()+1}/${d.getUTCDate()}(${dayName})</span>
          ${isToday ? '<span class="sched-day-badge">오늘</span>' : ''}
        </div>
        <div class="sched-day-readings">
          ${readings.join(' ')}
        </div>
      </div>
    `;

    row.addEventListener('click', (e) => {
      if (e.target.classList.contains('sched-chk-box')) {
        e.stopPropagation();
        toggleDayCompletion(dateStr, !isCompleted);
      } else {
        activeDateStr = dateStr;
        renderDashboard();
      }
    });

    scheduleContainer.appendChild(row);
  });

  // 캘린더 및 다가오는 절기 업데이트
  renderCalendar();
  renderUpcomingHolidays();
}

function createChecklistItem(type, label, title, isDone, dateStr) {
  const div = document.createElement('div');
  div.className = `reading-item ${isDone ? 'done' : ''}`;
  div.innerHTML = `
    <div class="chk-box"></div>
    <div class="rd-info">
      <div class="rd-type type-${type}">${label}</div>
      <div class="rd-title">${title}</div>
    </div>
    <button class="btn-read-passage" title="본문 읽기">
      📖 본문 읽기
    </button>
  `;
  
  // 체크박스 클릭 시 통독 완료 토글
  div.querySelector('.chk-box').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!appState.progress[dateStr]) appState.progress[dateStr] = {};
    appState.progress[dateStr][type] = !appState.progress[dateStr][type];
    localStorage.setItem(STATE_KEY, JSON.stringify(appState));
    renderDashboard();
  });
  
  // 본문 읽기 버튼 클릭 시 getBible API 본문 읽기 열기
  div.querySelector('.btn-read-passage').addEventListener('click', (e) => {
    e.stopPropagation();
    openBibleReader(title);
  });
  
  return div;
}

// 랜딩 페이지 -> 진입
document.getElementById('btn-enter').addEventListener('click', () => {
  document.getElementById('landing-page').classList.remove('active');
  document.getElementById('dashboard-page').classList.add('active');
  initApp();
});

// 3. 연간 뷰 렌더링 (주별 보기 탭) - 연간 주차(1~53주차)별 정렬
function renderAnnualView() {
  const container = document.getElementById('annual-container');
  container.innerHTML = '';
  
  const dates = Object.keys(currentPlan).sort();
  
  // 주차별로 날짜 그룹핑 (1~53주차)
  const groups = {}; // { weekNum: [dateStr, ...] }
  dates.forEach(dateStr => {
    const weekNum = getPlanWeekNumber(dateStr);
    if (!groups[weekNum]) {
      groups[weekNum] = [];
    }
    groups[weekNum].push(dateStr);
  });

  // 주차 오름차순 정렬
  const sortedWeeks = Object.keys(groups).sort((a, b) => Number(a) - Number(b));
  
  const daysOfWeekKOR = ['일','월','화','수','목','금','토'];
  let html = '';

  sortedWeeks.forEach(weekNum => {
    const groupDates = groups[weekNum].sort();
    
    // 이 주간의 파라샤 및 절기 정보 수집
    let weekParasha = null;
    const holidaysInWeek = [];

    groupDates.forEach(dateStr => {
      const data = currentPlan[dateStr];
      if (data.parasha && !weekParasha) {
        weekParasha = data.parasha;
      }
      if (data.holidays && data.holidays.length > 0) {
        data.holidays.forEach(h => {
          const rawName = h.name.replace(/^Holiday:\s*/i, '');
          const normName = getBiblicalHolidayName(rawName);
          if (normName && !holidaysInWeek.includes(normName)) {
            holidaysInWeek.push(normName);
          }
        });
      }
    });

    let displayTitle = '';
    let meaningText = '';
    
    if (weekParasha) {
      const meta = window.getParashaMeta(weekParasha);
      displayTitle = `${weekNum}주차: ${weekParasha} (${meta.ko})`;
      if (holidaysInWeek.length > 0) {
        displayTitle += ` [절기: ${holidaysInWeek.join(', ')}]`;
      }
      meaningText = `<div class="annual-week-meaning">의미: ${meta.meaning}</div>`;
    } else {
      displayTitle = `${weekNum}주차: 절기 주간 / Special Week`;
      if (holidaysInWeek.length > 0) {
        displayTitle = `${weekNum}주차: 절기 주간 (${holidaysInWeek.join(', ')})`;
      }
      meaningText = `<div class="annual-week-meaning">의미: 유대력 절기 특별 주간</div>`;
    }

    html += `
      <div class="annual-week-card">
        <div class="annual-week-header" onclick="this.parentElement.classList.toggle('expanded')">
          <div>
            <div class="annual-week-title">${displayTitle}</div>
            ${meaningText}
          </div>
          <div class="annual-week-icon">▼</div>
        </div>
        <div class="annual-week-body">
    `;

    groupDates.forEach(dateStr => {
      const data = currentPlan[dateStr];
      const dParts = dateStr.split('-');
      const d = new Date(Date.UTC(parseInt(dParts[0]), parseInt(dParts[1])-1, parseInt(dParts[2])));
      const dayName = daysOfWeekKOR[d.getUTCDay()];
      const prog = appState.progress[dateStr] || {};
      
      html += `<div class="annual-day-row">
                 <div class="annual-day-date">${dateStr} (${dayName})</div>
                 <div class="annual-day-content">`;
      
      if (data.torah) {
        const torahTitle = window.BIBLE_DATA.translateTorahReading(data.torah);
        html += `<div class="rd-tag type-torah ${prog.torah?'done':''}">${torahTitle}</div>`;
      }
      if (data.megillah) {
        html += `<div class="rd-tag type-megillah ${prog.megillah?'done':''}">${data.megillah}</div>`;
      }
      if (data.ot && data.ot.length > 0) {
        const title = `${data.ot[0].book} ${data.ot[0].chapter}` + 
                      (data.ot.length > 1 ? `-${data.ot[data.ot.length-1].chapter}` : '');
        html += `<div class="rd-tag type-ot ${prog.ot?'done':''}">${title}</div>`;
      }
      if (data.nt && data.nt.length > 0) {
        const title = `${data.nt[0].book} ${data.nt[0].chapter}` + 
                      (data.nt.length > 1 ? `-${data.nt[data.nt.length-1].chapter}` : '');
        html += `<div class="rd-tag type-nt ${prog.nt?'done':''}">${title}</div>`;
      }
      
      html += `</div></div>`;
    });

    html += `</div></div>`;
  });
  
  container.innerHTML = html;
}

// 6. 설정 탭 렌더링
function renderSettingsView() {
  document.getElementById('input-family-name').value = appState.familyName || "P274 Bible Reading Plan";
  // 라디오 상태 업데이트
  const savedMode = appState.theme || 'dark';
  const radio = document.querySelector(`input[name="theme-mode"][value="${savedMode}"]`);
  if (radio) {
    radio.checked = true;
  }
  // 기준일 인풋값 로드
  const todayVal = appState.overrideToday || getTodayStr();
  document.getElementById('input-override-date').value = todayVal;
}

// 브라우저 내장 Intl API를 이용한 유대력 날짜 변환 (캘린더 셀 렌더링용)
function getHebrewDateNatively(dateStr) {
  try {
    const parts = dateStr.split('-');
    const dateObj = new Date(Date.UTC(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10)));
    
    // 일자 숫자
    const dayFormatter = new Intl.DateTimeFormat('en-u-ca-hebrew', { day: 'numeric', timeZone: 'UTC' });
    const dayVal = dayFormatter.format(dateObj);
    
    // 월 영어 표기
    const monthFormatter = new Intl.DateTimeFormat('en-u-ca-hebrew', { month: 'short', timeZone: 'UTC' });
    const monthVal = monthFormatter.format(dateObj);
    
    // 히브리어 표기
    const hebFormatter = new Intl.DateTimeFormat('he-u-ca-hebrew', { day: 'numeric', month: 'numeric', timeZone: 'UTC' });
    const hebVal = hebFormatter.format(dateObj);
    
    return {
      hd: dayVal,
      hm: monthVal,
      hebrew: hebVal
    };
  } catch (e) {
    console.error("Intl Hebrew translation failed, fallback", e);
    return { hd: '', hm: '', hebrew: '' };
  }
}

let calendarCurrentDate = null; // 캘린더에서 보고 있는 현재 월 기준일

// 대시보드 캘린더 렌더링
function renderCalendar() {
  if (!calendarCurrentDate) {
    const p = activeDateStr.split('-');
    calendarCurrentDate = new Date(Date.UTC(parseInt(p[0], 10), parseInt(p[1], 10) - 1, 1));
  }
  
  const year = calendarCurrentDate.getUTCFullYear();
  const month = calendarCurrentDate.getUTCMonth();
  
  document.getElementById('calendar-month-title').textContent = `${year}년 ${month + 1}월`;
  
  const gridCells = document.getElementById('calendar-grid-cells');
  gridCells.innerHTML = '';
  
  const firstDay = new Date(Date.UTC(year, month, 1));
  const startDayOfWeek = firstDay.getUTCDay();
  const numDays = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  
  // 첫 주 빈칸 패딩
  for (let i = 0; i < startDayOfWeek; i++) {
    const emptyCell = document.createElement('div');
    emptyCell.className = 'calendar-cell empty';
    gridCells.appendChild(emptyCell);
  }
  
  const todayStr = getTodayStr();
  
  for (let d = 1; d <= numDays; d++) {
    const dayStr = String(d).padStart(2, '0');
    const monthStr = String(month + 1).padStart(2, '0');
    const dateStr = `${year}-${monthStr}-${dayStr}`;
    
    const cell = document.createElement('div');
    cell.className = 'calendar-cell';
    
    const dayPlan = currentPlan[dateStr];
    let isCompleted = false;
    let holidayName = '';
    
    if (dayPlan) {
      const progressDay = appState.progress[dateStr] || {};
      isCompleted = isDayCompleted(dayPlan, progressDay);
      
      if (dayPlan.holidays && dayPlan.holidays.length > 0) {
        for (const h of dayPlan.holidays) {
          const name = getBiblicalHolidayName(h.name);
          if (name) {
            const match = name.match(/^([가-힣a-zA-Z0-9\s]+?)\s*\(/);
            holidayName = match ? match[1].trim() : name;
            break;
          }
        }
      }
    }
    
    if (isCompleted) cell.classList.add('completed');
    if (dateStr === todayStr) cell.classList.add('today-highlight');
    if (dateStr === activeDateStr) cell.classList.add('active-highlight');
    
    const hebDate = getHebrewDateNatively(dateStr);
    
    cell.innerHTML = `
      <span class="calendar-cell-greg">${d}</span>
      ${holidayName ? `<span class="calendar-cell-holiday" title="${holidayName}">${holidayName}</span>` : ''}
      <span class="calendar-cell-heb">${hebDate.hd || ''}</span>
    `;
    
    cell.addEventListener('click', () => {
      activeDateStr = dateStr;
      document.querySelectorAll('.calendar-cell').forEach(c => c.classList.remove('active-highlight'));
      cell.classList.add('active-highlight');
      
      // 주간 보기 탭으로 스위칭
      const weeklyTabBtn = document.querySelector('.tab-item[data-tab="weekly"]');
      if (weeklyTabBtn) {
        weeklyTabBtn.click();
      } else {
        renderDashboard();
      }
    });
    
    gridCells.appendChild(cell);
  }
}

// 다가오는 절기 리스트 렌더링
function renderUpcomingHolidays() {
  const container = document.getElementById('upcoming-holidays-container');
  container.innerHTML = '';
  
  const todayStr = getTodayStr();
  const dates = Object.keys(currentPlan).sort();
  const todayIdx = dates.indexOf(todayStr);
  const startIdx = todayIdx !== -1 ? todayIdx : 0;
  
  const upcomingHols = [];
  
  for (let i = startIdx; i < dates.length; i++) {
    const dateStr = dates[i];
    const dayData = currentPlan[dateStr];
    if (dayData.holidays && dayData.holidays.length > 0) {
      for (const h of dayData.holidays) {
        const normName = getBiblicalHolidayName(h.name);
        if (normName) {
          const alreadyAdded = upcomingHols.some(item => item.name === normName);
          if (!alreadyAdded) {
            const d1 = new Date(todayStr);
            const d2 = new Date(dateStr);
            const diffTime = d2 - d1;
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            
            upcomingHols.push({
              name: normName,
              dateStr: dateStr,
              dday: diffDays
            });
            break;
          }
        }
      }
    }
    
    if (upcomingHols.length >= 4) break;
  }
  
  if (upcomingHols.length === 0) {
    container.innerHTML = '<div style="color: var(--text-dim); font-size: 0.9rem; text-align: center; padding: 1rem;">다가오는 절기가 없습니다.</div>';
    return;
  }
  
  upcomingHols.forEach(item => {
    const parts = item.dateStr.split('-');
    const gDate = new Date(Date.UTC(parseInt(parts[0], 10), parseInt(parts[1], 10)-1, parseInt(parts[2], 10)));
    const daysName = ['일','월','화','수','목','금','토'];
    const gDayOfWeek = daysName[gDate.getUTCDay()];
    
    const formattedGregorian = `${parts[0]}년 ${parseInt(parts[1], 10)}월 ${parseInt(parts[2], 10)}일(${gDayOfWeek})`;
    
    const hebDate = getHebrewDateNatively(item.dateStr);
    const formattedHebrew = hebDate.hm ? `${hebDate.hd} ${hebDate.hm} / ${hebDate.hebrew}` : '';
    
    let ddayText = '';
    if (item.dday === 0) {
      ddayText = '오늘!';
    } else if (item.dday > 0) {
      ddayText = `D-${item.dday}`;
    } else {
      ddayText = `D+${Math.abs(item.dday)}`;
    }
    
    const row = document.createElement('div');
    row.className = 'holiday-item-row';
    row.innerHTML = `
      <div class="holiday-item-left">
        <div class="holiday-item-title">${item.name}</div>
        <div class="holiday-item-date">${formattedGregorian} ㆍ ${formattedHebrew}</div>
      </div>
      <div class="holiday-item-dday">${ddayText}</div>
    `;
    
    row.addEventListener('click', () => {
      activeDateStr = item.dateStr;
      const p = item.dateStr.split('-');
      calendarCurrentDate = new Date(Date.UTC(parseInt(p[0], 10), parseInt(p[1], 10) - 1, 1));
      
      // 주간 보기 탭으로 스위칭
      const weeklyTabBtn = document.querySelector('.tab-item[data-tab="weekly"]');
      if (weeklyTabBtn) {
        weeklyTabBtn.click();
      } else {
        renderDashboard();
      }
    });
    
    container.appendChild(row);
  });
}

// 한글 성경책 이름 순서 정의 (getBible API v2 대응용 1-based 인덱스 계산)
const BIBLE_BOOKS_ORDER = [
  '창세기', '출애굽기', '레위기', '민수기', '신명기',
  '여호수아', '사사기', '룻기', '사무엘상', '사무엘하',
  '열왕기상', '열왕기하', '역대상', '역대하',
  '에스라', '느헤미야', '에스더', '욥기', '시편',
  '잠언', '전도서', '아가', '이사야', '예레미야',
  '예레미야 애가', '에스겔', '다니엘', '호세아', '요엘',
  '아모스', '오바댜', '요나', '미가', '나훔',
  '하박국', '스바냐', '학개', '스가랴', '말라기',
  '마태복음', '마가복음', '누가복음', '요한복음', '사도행전',
  '로마서', '고린도전서', '고린도후서', '갈라디아서',
  '에베소서', '빌립보서', '골로새서', '데살로니가전서',
  '데살로니가후서', '디모데전서', '디모데후서', '디도서',
  '빌레몬서', '히브리서', '야고보서', '베드로전서',
  '베드로후서', '요한1서', '요한2서', '요한3서',
  '유다서', '요한계시록'
];

function getBookNumber(bookNameKOR) {
  const idx = BIBLE_BOOKS_ORDER.indexOf(bookNameKOR);
  return idx !== -1 ? idx + 1 : null;
}

// 한글 본문 구절 파싱 함수
function parseKoreanReference(korRef) {
  if (!korRef) return null;
  
  // 공백 및 물결표 정규화
  let clean = korRef.replace(/\s+/g, ' ').trim();
  
  // 긴 도서명부터 매칭
  const sortedKorBooks = [...BIBLE_BOOKS_ORDER].sort((a, b) => b.length - a.length);
  let foundKorBook = null;
  for (const korBook of sortedKorBooks) {
    if (clean.startsWith(korBook)) {
      foundKorBook = korBook;
      break;
    }
  }
  
  if (!foundKorBook) return null;
  
  const bookNum = getBookNumber(foundKorBook);
  if (!bookNum) return null;
  
  let rest = clean.substring(foundKorBook.length).trim();
  
  // Case 1: 절 범위가 포함된 경우 (콜론 ':' 이 있는 경우)
  // 예: "1:1 ~ 2:3", "33:12-33:16", "33:12-16"
  if (rest.includes(':')) {
    let parts = rest.replace(/~/g, '-').split('-').map(s => s.trim());
    let startCh, startVs, endCh, endVs;
    
    let startMatch = parts[0].match(/(\d+)\s*:\s*(\d+)/);
    if (startMatch) {
      startCh = parseInt(startMatch[1], 10);
      startVs = parseInt(startMatch[2], 10);
    }
    
    if (parts.length > 1) {
      let endMatch = parts[1].match(/(\d+)\s*:\s*(\d+)/);
      if (endMatch) {
        endCh = parseInt(endMatch[1], 10);
        endVs = parseInt(endMatch[2], 10);
      } else {
        let onlyVerseMatch = parts[1].match(/(\d+)/);
        if (onlyVerseMatch) {
          endCh = startCh;
          endVs = parseInt(onlyVerseMatch[1], 10);
        }
      }
    } else {
      endCh = startCh;
      endVs = startVs;
    }
    
    return {
      bookName: foundKorBook,
      bookNumber: bookNum,
      startCh,
      startVs,
      endCh,
      endVs
    };
  }
  
  // Case 2: 장 범위만 있는 경우 (콜론 ':' 이 없는 경우)
  // 예: "1장", "1-2장", "1장 ~ 3장"
  let cleanRest = rest.replace(/장/g, '').replace(/편/g, '').replace(/~/g, '-').trim();
  let parts = cleanRest.split('-').map(s => s.trim());
  let startCh = parseInt(parts[0], 10);
  let endCh = parts.length > 1 ? parseInt(parts[1], 10) : startCh;
  
  if (isNaN(startCh)) return null;
  
  return {
    bookName: foundKorBook,
    bookNumber: bookNum,
    startCh,
    startVs: undefined,
    endCh,
    endVs: undefined
  };
}

// getBible API v2를 호출하여 성경 구절을 가져온 뒤 모달 창에 시각화
async function openBibleReader(title) {
  const modal = document.getElementById('bible-reader-modal');
  const modalTitle = document.getElementById('bible-reader-title');
  const loading = modal.querySelector('.bible-loading');
  const textContainer = document.getElementById('bible-text-container');
  const errorContainer = document.getElementById('bible-error-container');
  
  // 모달 타이틀 설정
  modalTitle.innerHTML = `${title} <span style="font-size: 0.8rem; font-weight: normal; color: var(--text-muted); margin-left: 0.5rem; vertical-align: middle;">(개역한글)</span>`;
  
  // 모달을 표시하고 로딩 상태 시작
  modal.classList.remove('hidden');
  loading.classList.remove('hidden');
  textContainer.classList.add('hidden');
  errorContainer.classList.add('hidden');
  textContainer.innerHTML = '';
  
  const parsedRef = parseKoreanReference(title);
  if (!parsedRef) {
    loading.classList.add('hidden');
    errorContainer.textContent = "본문 구절을 파싱할 수 없습니다. (지원되지 않는 형식)";
    errorContainer.classList.remove('hidden');
    return;
  }
  
  try {
    const fetchPromises = [];
    for (let ch = parsedRef.startCh; ch <= parsedRef.endCh; ch++) {
      const url = `https://api.getbible.net/v2/korean/${parsedRef.bookNumber}/${ch}.json`;
      fetchPromises.push(
        fetch(url)
          .then(res => {
            if (!res.ok) throw new Error(`API returned status ${res.status}`);
            return res.json();
          })
      );
    }
    
    const chaptersData = await Promise.all(fetchPromises);
    
    loading.classList.add('hidden');
    
    let html = '';
    chaptersData.forEach(chapterData => {
      const chNum = chapterData.chapter;
      const bookNameKOR = chapterData.book_name || parsedRef.bookName;
      
      let versesToShow = chapterData.verses || [];
      
      // 구절 범위가 지정된 경우 필터링
      if (parsedRef.startVs !== undefined) {
        versesToShow = versesToShow.filter(v => {
          const vNum = v.verse;
          if (chNum === parsedRef.startCh && chNum === parsedRef.endCh) {
            return vNum >= parsedRef.startVs && vNum <= parsedRef.endVs;
          } else if (chNum === parsedRef.startCh) {
            return vNum >= parsedRef.startVs;
          } else if (chNum === parsedRef.endCh) {
            return vNum <= parsedRef.endVs;
          }
          return true;
        });
      }
      
      html += `<h4 style="color: var(--gold); font-size: 1.15rem; margin-top: 1.5rem; margin-bottom: 0.75rem; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 0.35rem; font-family: 'Noto Serif KR', serif; font-weight: 700;">${bookNameKOR} ${chNum}장</h4>`;
      
      if (versesToShow.length > 0) {
        versesToShow.forEach(v => {
          html += `
            <div class="bible-verse-row" style="margin-bottom: 0.85rem; display: flex; align-items: flex-start; gap: 0.75rem;">
              <span class="bible-verse-num" style="font-size: 0.85rem; font-weight: 700; color: var(--gold); width: 24px; text-align: right; flex-shrink: 0; margin-top: 0.15rem;">${v.verse}</span>
              <span class="bible-verse-text" style="flex: 1; font-size: 1.05rem; line-height: 1.8; color: var(--text-main); word-break: keep-all;">${v.text}</span>
            </div>
          `;
        });
      } else {
        html += `<div style="color: var(--text-muted); padding: 0.5rem 0; font-size: 0.95rem;">본문 구절이 없습니다.</div>`;
      }
    });
    
    textContainer.innerHTML = html;
    textContainer.classList.remove('hidden');
    
  } catch (err) {
    console.error("Error loading scripture: ", err);
    loading.classList.add('hidden');
    errorContainer.textContent = "본문을 불러오는 데 실패했습니다. 네트워크 연결을 확인하거나 나중에 다시 시도해주세요.";
    errorContainer.classList.remove('hidden');
  }
}
