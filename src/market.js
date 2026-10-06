// 시장 시뮬레이션 — 종목 정의, 가격 변동(랜덤워크 + 평균회귀), 뉴스 이벤트

const STOCKS = [
  { symbol: 'DCE', name: '디코전자',     sector: '반도체', base: 72000,  vol: 0.008 },
  { symbol: 'MMB', name: '멍멍바이오',   sector: '바이오', base: 18500,  vol: 0.018 },
  { symbol: 'CAT', name: '냥냥엔터',     sector: '엔터',   base: 41000,  vol: 0.012 },
  { symbol: 'SPC', name: '우주항공',     sector: '항공우주', base: 125000, vol: 0.010 },
  { symbol: 'HGC', name: '한강건설',     sector: '건설',   base: 9800,   vol: 0.007 },
  { symbol: 'KMC', name: '김치푸드',     sector: '식품',   base: 33000,  vol: 0.005 },
  { symbol: 'CDG', name: '코드게임즈',   sector: '게임',   base: 56000,  vol: 0.014 },
  { symbol: 'GRN', name: '그린에너지',   sector: '에너지', base: 21000,  vol: 0.011 },
  { symbol: 'DOG', name: '도지코인즈',   sector: '가상자산', base: 1200, vol: 0.030 },
];

const HISTORY_LEN = 120;      // 차트용 가격 기록 개수
const MAX_TICK_MOVE = 0.10;   // 일반 틱의 최대 변동폭 (±10%)
const MEAN_REVERSION = 0.003; // 기준가로 끌어당기는 힘
const MIN_PRICE = 100;
const NEWS_CHANCE = 0.04;     // 틱당 뉴스 발생 확률

const GOOD_NEWS = [
  '{name}, 신제품 대박 예감! 사전 주문 폭주',
  '{name} 분기 실적 어닝 서프라이즈',
  '외국인 투자자, {name} 대량 매수',
  '{name}, 대형 해외 수주 계약 체결',
  '{name} 신기술 특허 획득… 업계 판도 바뀌나',
];
const BAD_NEWS = [
  '{name} 경영진 횡령 의혹… 압수수색 진행',
  '{name} 주력 제품 대규모 리콜 사태',
  '{name} 실적 쇼크, 적자 전환',
  '공매도 세력, {name} 집중 공략',
  '{name} 공장 화재로 생산 중단',
];

function kstDayKey(now) {
  return new Date(now + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function gaussian(rng) {
  let u = 0;
  while (u === 0) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

function createMarket(now = Date.now()) {
  const stocks = {};
  for (const s of STOCKS) {
    stocks[s.symbol] = { price: s.base, prevPrice: s.base, open: s.base, history: [s.base] };
  }
  return { stocks, dayKey: kstDayKey(now), lastTick: now };
}

// 저장된 시장에 새로 추가된 종목이 있으면 채워 넣는다
function syncMarket(market) {
  for (const s of STOCKS) {
    if (!market.stocks[s.symbol]) {
      market.stocks[s.symbol] = { price: s.base, prevPrice: s.base, open: s.base, history: [s.base] };
    }
  }
  return market;
}

function applyMove(st, pct) {
  st.price = Math.max(MIN_PRICE, Math.round(st.price * (1 + pct)));
}

// 한 틱 진행. 발생한 뉴스 목록을 반환한다.
function tick(market, rng = Math.random, now = Date.now()) {
  const day = kstDayKey(now);
  const newDay = day !== market.dayKey;

  for (const s of STOCKS) {
    const st = market.stocks[s.symbol];
    if (newDay) st.open = st.price;
    st.prevPrice = st.price;
    const reversion = MEAN_REVERSION * Math.log(s.base / st.price);
    const pct = clamp(reversion + s.vol * gaussian(rng), -MAX_TICK_MOVE, MAX_TICK_MOVE);
    applyMove(st, pct);
  }

  const news = [];
  if (rng() < NEWS_CHANCE) {
    const s = STOCKS[Math.floor(rng() * STOCKS.length)];
    const st = market.stocks[s.symbol];
    const good = rng() < 0.5;
    const size = 0.05 + rng() * 0.15; // 5% ~ 20%
    const pct = good ? size : -size;
    const pool = good ? GOOD_NEWS : BAD_NEWS;
    const headline = pool[Math.floor(rng() * pool.length)].replace('{name}', s.name);
    applyMove(st, pct);
    news.push({ symbol: s.symbol, name: s.name, headline, pct, price: st.price });
  }

  for (const s of STOCKS) {
    const st = market.stocks[s.symbol];
    st.history.push(st.price);
    if (st.history.length > HISTORY_LEN) st.history.splice(0, st.history.length - HISTORY_LEN);
  }

  market.dayKey = day;
  market.lastTick = now;
  return news;
}

function findStock(symbol) {
  return STOCKS.find((s) => s.symbol === symbol) || null;
}

module.exports = { STOCKS, createMarket, syncMarket, tick, findStock, kstDayKey, gaussian };
