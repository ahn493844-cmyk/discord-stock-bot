// 거래 가능한 실제 상품 목록
//  source: 'yahoo'(야후 파이낸스) | 'upbit'(업비트, 원화 마켓)
//  currency: 원본 시세 통화. USD는 달러/원 환율로 원화 환산
//  factor: 원본 가격에 곱할 값 (금 1온스 → 1g, 엔화 1엔 → 100엔)
//  decimals: 현물 거래 수량 소수 자릿수 (코인은 0.0001개 단위)
//  vol: 옵션 가격 계산용 연 변동성
//  unit: 수량 단위 표시 (기본 '주')

const CATEGORIES = {
  kr: '한국 주식',
  us: '미국 주식',
  crypto: '코인',
  etf: 'ETF',
  macro: '금·환율',
};

const KR = (id, name) => ({ id, name, category: 'kr', source: 'yahoo', ticker: `${id}.KS`, currency: 'KRW', vol: 0.35 });
const US = (id, name) => ({ id, name, category: 'us', source: 'yahoo', ticker: id, currency: 'USD', vol: 0.4 });
const COIN = (id, name) => ({ id, name, category: 'crypto', source: 'upbit', ticker: `KRW-${id}`, currency: 'KRW', vol: 0.7, decimals: 4, unit: '개' });

const ASSETS = [
  KR('005930', '삼성전자'),
  KR('000660', 'SK하이닉스'),
  KR('373220', 'LG에너지솔루션'),
  KR('207940', '삼성바이오로직스'),
  KR('005380', '현대차'),
  KR('000270', '기아'),
  KR('035420', 'NAVER'),
  KR('035720', '카카오'),
  KR('068270', '셀트리온'),

  US('AAPL', '애플'),
  US('NVDA', '엔비디아'),
  US('TSLA', '테슬라'),
  US('MSFT', '마이크로소프트'),
  US('GOOGL', '알파벳(구글)'),
  US('AMZN', '아마존'),
  US('META', '메타'),

  COIN('BTC', '비트코인'),
  COIN('ETH', '이더리움'),
  COIN('XRP', '리플'),
  COIN('SOL', '솔라나'),
  COIN('DOGE', '도지코인'),

  { id: 'SPY', name: 'S&P500 ETF (SPY)', category: 'etf', source: 'yahoo', ticker: 'SPY', currency: 'USD', vol: 0.18 },
  { id: 'QQQ', name: '나스닥100 ETF (QQQ)', category: 'etf', source: 'yahoo', ticker: 'QQQ', currency: 'USD', vol: 0.22 },
  { id: '069500', name: 'KODEX 200', category: 'etf', source: 'yahoo', ticker: '069500.KS', currency: 'KRW', vol: 0.2 },
  { id: '122630', name: 'KODEX 레버리지', category: 'etf', source: 'yahoo', ticker: '122630.KS', currency: 'KRW', vol: 0.4 },

  { id: 'GOLD', name: '금 (1g)', category: 'macro', source: 'yahoo', ticker: 'GC=F', currency: 'USD', factor: 1 / 31.1035, vol: 0.15, unit: 'g' },
  { id: 'USD', name: '미국 달러 ($1)', category: 'macro', source: 'yahoo', ticker: 'KRW=X', currency: 'KRW', vol: 0.08, unit: '달러' },
  { id: 'JPY', name: '일본 엔화 (100엔)', category: 'macro', source: 'yahoo', ticker: 'JPYKRW=X', currency: 'KRW', factor: 100, vol: 0.1, unit: '×100엔' },
  { id: 'EUR', name: '유로 (€1)', category: 'macro', source: 'yahoo', ticker: 'EURKRW=X', currency: 'KRW', vol: 0.08, unit: '유로' },
];

const BY_ID = new Map(ASSETS.map((a) => [a.id, a]));

function findAsset(id) {
  return BY_ID.get(String(id).toUpperCase()) || null;
}

// 자동완성 검색: 이름·코드 일부로 찾기
function searchAssets(query, limit = 25) {
  const q = String(query || '').trim().toLowerCase();
  const hits = q
    ? ASSETS.filter((a) => a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q))
    : ASSETS;
  return hits.slice(0, limit);
}

function unitOf(asset) {
  return (asset && asset.unit) || '주';
}

module.exports = { ASSETS, CATEGORIES, findAsset, searchAssets, unitOf };
