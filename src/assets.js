// 거래 가능한 실제 상품 목록
//  source: 'yahoo'(야후 파이낸스) | 'upbit'(업비트, 원화 마켓)
//  currency: 원본 시세 통화. USD·JPY는 실시간 환율로 원화 환산
//  factor: 원본 가격에 곱할 값 (금 1온스 → 1g, 엔화 1엔 → 100엔, 곡물 센트 → 달러)
//  decimals: 거래 수량 소수 자릿수 (코인·선물은 소수 단위 거래 가능)
//  vol: 옵션 가격 계산용 연 변동성
//  unit: 수량 단위 표시 (기본 '주')

const CATEGORIES = {
  kr: '한국 주식',
  us: '미국 주식',
  etf: 'ETF',
  futures: '선물·지수·원자재',
  crypto: '코인',
  macro: '금·환율',
};

const KR = (id, name, market = 'KS', vol = 0.35) =>
  ({ id, name, category: 'kr', source: 'yahoo', ticker: `${id}.${market}`, currency: 'KRW', vol });
const US = (id, name, vol = 0.4, ticker = id) =>
  ({ id, name, category: 'us', source: 'yahoo', ticker, currency: 'USD', vol });
const KR_ETF = (id, name, vol = 0.2) =>
  ({ id, name, category: 'etf', source: 'yahoo', ticker: `${id}.KS`, currency: 'KRW', vol });
const US_ETF = (id, name, vol = 0.2) =>
  ({ id, name: `${name} (${id})`, category: 'etf', source: 'yahoo', ticker: id, currency: 'USD', vol });
const FUT = (id, name, ticker, { currency = 'USD', unit = '계약', vol = 0.25, factor, decimals = 2 } = {}) =>
  ({ id, name, category: 'futures', source: 'yahoo', ticker, currency, unit, vol, factor, decimals });
const COIN = (id, name) =>
  ({ id, name, category: 'crypto', source: 'upbit', ticker: `KRW-${id}`, currency: 'KRW', vol: 0.7, decimals: 4, unit: '개' });

const ASSETS = [
  // ── 한국 주식: 코스피 ──
  KR('005930', '삼성전자'),
  KR('000660', 'SK하이닉스', 'KS', 0.45),
  KR('373220', 'LG에너지솔루션'),
  KR('207940', '삼성바이오로직스'),
  KR('005380', '현대차'),
  KR('000270', '기아'),
  KR('068270', '셀트리온'),
  KR('035420', 'NAVER'),
  KR('035720', '카카오'),
  KR('005490', 'POSCO홀딩스'),
  KR('051910', 'LG화학'),
  KR('006400', '삼성SDI'),
  KR('003670', '포스코퓨처엠', 'KS', 0.5),
  KR('012330', '현대모비스'),
  KR('028260', '삼성물산'),
  KR('066570', 'LG전자'),
  KR('003550', 'LG'),
  KR('096770', 'SK이노베이션'),
  KR('018260', '삼성에스디에스'),
  KR('105560', 'KB금융', 'KS', 0.3),
  KR('055550', '신한지주', 'KS', 0.3),
  KR('086790', '하나금융지주', 'KS', 0.3),
  KR('323410', '카카오뱅크'),
  KR('032830', '삼성생명', 'KS', 0.3),
  KR('000810', '삼성화재', 'KS', 0.3),
  KR('034020', '두산에너빌리티', 'KS', 0.5),
  KR('012450', '한화에어로스페이스', 'KS', 0.5),
  KR('064350', '현대로템', 'KS', 0.5),
  KR('329180', 'HD현대중공업', 'KS', 0.45),
  KR('009540', 'HD한국조선해양', 'KS', 0.45),
  KR('042700', '한미반도체', 'KS', 0.6),
  KR('010130', '고려아연'),
  KR('011200', 'HMM'),
  KR('015760', '한국전력', 'KS', 0.3),
  KR('017670', 'SK텔레콤', 'KS', 0.2),
  KR('030200', 'KT', 'KS', 0.2),
  KR('033780', 'KT&G', 'KS', 0.2),
  KR('097950', 'CJ제일제당', 'KS', 0.3),
  KR('090430', '아모레퍼시픽'),
  KR('259960', '크래프톤'),
  KR('036570', '엔씨소프트'),
  KR('352820', '하이브', 'KS', 0.45),
  // ── 한국 주식: 코스닥 ──
  KR('247540', '에코프로비엠', 'KQ', 0.6),
  KR('086520', '에코프로', 'KQ', 0.6),
  KR('196170', '알테오젠', 'KQ', 0.6),
  KR('028300', 'HLB', 'KQ', 0.6),
  KR('263750', '펄어비스', 'KQ', 0.5),
  KR('293490', '카카오게임즈', 'KQ', 0.5),
  KR('035900', 'JYP Ent.', 'KQ', 0.45),
  KR('041510', '에스엠', 'KQ', 0.45),

  // ── 미국 주식 ──
  US('AAPL', '애플', 0.3),
  US('MSFT', '마이크로소프트', 0.3),
  US('NVDA', '엔비디아', 0.5),
  US('GOOGL', '알파벳(구글)', 0.35),
  US('AMZN', '아마존', 0.35),
  US('META', '메타', 0.4),
  US('TSLA', '테슬라', 0.6),
  US('AVGO', '브로드컴', 0.45),
  US('TSM', 'TSMC', 0.4),
  US('AMD', 'AMD', 0.5),
  US('INTC', '인텔', 0.45),
  US('QCOM', '퀄컴', 0.4),
  US('MU', '마이크론', 0.5),
  US('ARM', 'ARM', 0.6),
  US('ASML', 'ASML', 0.4),
  US('ORCL', '오라클', 0.35),
  US('CRM', '세일즈포스', 0.35),
  US('ADBE', '어도비', 0.35),
  US('NFLX', '넷플릭스', 0.4),
  US('PLTR', '팔란티어', 0.7),
  US('UBER', '우버', 0.45),
  US('COIN', '코인베이스', 0.8),
  US('BABA', '알리바바', 0.45),
  US('BRK-B', '버크셔 해서웨이', 0.2, 'BRK-B'),
  US('JPM', 'JP모건', 0.25),
  US('V', '비자', 0.22),
  US('MA', '마스터카드', 0.22),
  US('PYPL', '페이팔', 0.4),
  US('UNH', '유나이티드헬스', 0.3),
  US('JNJ', '존슨앤드존슨', 0.18),
  US('LLY', '일라이릴리', 0.35),
  US('XOM', '엑슨모빌', 0.25),
  US('WMT', '월마트', 0.2),
  US('COST', '코스트코', 0.22),
  US('HD', '홈디포', 0.25),
  US('PG', 'P&G', 0.18),
  US('KO', '코카콜라', 0.16),
  US('PEP', '펩시코', 0.18),
  US('MCD', '맥도날드', 0.18),
  US('SBUX', '스타벅스', 0.3),
  US('NKE', '나이키', 0.35),
  US('DIS', '디즈니', 0.3),
  US('BA', '보잉', 0.4),

  // ── ETF: 국내 ──
  KR_ETF('069500', 'KODEX 200'),
  KR_ETF('122630', 'KODEX 레버리지', 0.4),
  KR_ETF('114800', 'KODEX 인버스'),
  KR_ETF('252670', 'KODEX 200선물인버스2X', 0.4),
  KR_ETF('229200', 'KODEX 코스닥150', 0.3),
  KR_ETF('091160', 'KODEX 반도체', 0.35),
  KR_ETF('305720', 'KODEX 2차전지산업', 0.45),
  KR_ETF('132030', 'KODEX 골드선물(H)', 0.15),
  KR_ETF('360750', 'TIGER 미국S&P500', 0.18),
  KR_ETF('133690', 'TIGER 미국나스닥100', 0.22),
  // ── ETF: 미국 ──
  US_ETF('SPY', 'S&P500', 0.18),
  US_ETF('QQQ', '나스닥100', 0.22),
  US_ETF('DIA', '다우존스', 0.16),
  US_ETF('IWM', '러셀2000', 0.25),
  US_ETF('VTI', '미국 전체시장', 0.18),
  US_ETF('SCHD', '미국 배당', 0.15),
  US_ETF('TQQQ', '나스닥100 3배', 0.65),
  US_ETF('SQQQ', '나스닥100 인버스 3배', 0.65),
  US_ETF('SOXX', '반도체', 0.35),
  US_ETF('SOXL', '반도체 3배', 1.0),
  US_ETF('ARKK', 'ARK 혁신', 0.5),
  US_ETF('XLE', '에너지', 0.25),
  US_ETF('XLK', '기술', 0.25),
  US_ETF('TLT', '미국 장기국채', 0.15),
  US_ETF('GLD', '금', 0.15),
  US_ETF('SLV', '은', 0.28),
  US_ETF('EEM', '신흥국', 0.2),
  US_ETF('EWY', '한국', 0.25),

  // ── 선물·지수·원자재 (실제 선물 시세, 소수 단위 거래) ──
  FUT('ES', 'S&P500 선물', 'ES=F', { vol: 0.18, decimals: 4 }),
  FUT('NQ', '나스닥100 선물', 'NQ=F', { vol: 0.22, decimals: 4 }),
  FUT('YM', '다우 선물', 'YM=F', { vol: 0.16, decimals: 4 }),
  FUT('RTY', '러셀2000 선물', 'RTY=F', { vol: 0.25, decimals: 4 }),
  FUT('KS200', '코스피200 지수', '^KS200', { currency: 'KRW', unit: '단위', vol: 0.2 }),
  FUT('KOSDAQ', '코스닥 지수', '^KQ11', { currency: 'KRW', unit: '단위', vol: 0.25 }),
  FUT('N225', '니케이225 지수', '^N225', { currency: 'JPY', unit: '단위', vol: 0.2, decimals: 4 }),
  FUT('CL', 'WTI 원유', 'CL=F', { unit: '배럴', vol: 0.35 }),
  FUT('BZ', '브렌트유', 'BZ=F', { unit: '배럴', vol: 0.33 }),
  FUT('NG', '천연가스', 'NG=F', { unit: 'MMBtu', vol: 0.6 }),
  FUT('SI', '은', 'SI=F', { unit: '온스', vol: 0.28 }),
  FUT('PL', '백금', 'PL=F', { unit: '온스', vol: 0.28 }),
  FUT('HG', '구리', 'HG=F', { unit: '파운드', vol: 0.25 }),
  FUT('ZC', '옥수수', 'ZC=F', { unit: '부셸', vol: 0.25, factor: 0.01 }),
  FUT('ZS', '대두', 'ZS=F', { unit: '부셸', vol: 0.2, factor: 0.01 }),
  FUT('ZW', '밀', 'ZW=F', { unit: '부셸', vol: 0.3, factor: 0.01 }),
  FUT('KC', '커피', 'KC=F', { unit: '파운드', vol: 0.35, factor: 0.01 }),
  FUT('ZN', '미국 10년 국채 선물', 'ZN=F', { unit: '계약', vol: 0.07 }),

  // ── 코인 ──
  COIN('BTC', '비트코인'),
  COIN('ETH', '이더리움'),
  COIN('XRP', '리플'),
  COIN('SOL', '솔라나'),
  COIN('DOGE', '도지코인'),

  // ── 금·환율 ──
  { id: 'GOLD', name: '금 (1g)', category: 'macro', source: 'yahoo', ticker: 'GC=F', currency: 'USD', factor: 1 / 31.1035, vol: 0.15, unit: 'g' },
  { id: 'USD', name: '미국 달러 ($1)', category: 'macro', source: 'yahoo', ticker: 'KRW=X', currency: 'KRW', vol: 0.08, unit: '달러' },
  { id: 'JPY', name: '일본 엔화 (100엔)', category: 'macro', source: 'yahoo', ticker: 'JPYKRW=X', currency: 'KRW', factor: 100, vol: 0.1, unit: '×100엔' },
  { id: 'EUR', name: '유로 (€1)', category: 'macro', source: 'yahoo', ticker: 'EURKRW=X', currency: 'KRW', vol: 0.08, unit: '유로' },
];

const BY_ID = new Map(ASSETS.map((a) => [a.id, a]));
if (BY_ID.size !== ASSETS.length) throw new Error('assets.js: 중복된 종목 id가 있습니다');

function findAsset(id) {
  return BY_ID.get(String(id).toUpperCase()) || null;
}

// 자동완성 검색: 이름·코드 일부로 찾기 (이름이 그 글자로 시작하면 앞쪽에)
function searchAssets(query, limit = 25) {
  const q = String(query || '').trim().toLowerCase().replace(/\s+/g, '');
  if (!q) return ASSETS.slice(0, limit);
  // KODEX·TIGER는 한글로 쳐도 찾히게
  const norm = (s) => s.toLowerCase().replace(/\s+/g, '');
  const alias = (s) => norm(s).replace('kodex', '코덱스').replace('tiger', '타이거');
  const hits = ASSETS.filter((a) => norm(a.name).includes(q) || alias(a.name).includes(q) || a.id.toLowerCase().includes(q));
  const starts = (a) => (norm(a.name).startsWith(q) || a.id.toLowerCase().startsWith(q) ? 0 : 1);
  return hits.sort((a, b) => starts(a) - starts(b)).slice(0, limit);
}

function unitOf(asset) {
  return (asset && asset.unit) || '주';
}

// 목록 화면 한 페이지 종목 수 (GitHub에서 그리는 시세판 이미지와 같아야 함)
const BOARD_PAGE_SIZE = 20;
// 홈 화면 히트맵에 나오는 주요 종목
const HOME_HEATMAP = ['KS200', 'KOSDAQ', 'ES', 'NQ', 'N225', '005930', '000660', 'AAPL', 'NVDA', 'TSLA', 'BTC', 'ETH', 'CL', 'GOLD', 'USD'];

function boardPages(category) {
  return Math.max(1, Math.ceil(ASSETS.filter((a) => a.category === category).length / BOARD_PAGE_SIZE));
}

module.exports = { ASSETS, CATEGORIES, findAsset, searchAssets, unitOf, BOARD_PAGE_SIZE, HOME_HEATMAP, boardPages };
