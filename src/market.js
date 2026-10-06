// 시장 상태 — 실제 시세를 원화로 보관하고 장 운영 여부를 판단 (차트는 GitHub Pages 이미지 사용)

const { ASSETS, findAsset } = require('./assets');

const STALE_MS = 45 * 60 * 1000;      // 이보다 오래된 시세는 '장 마감'으로 표시 (Pages 시세는 15분 주기)
const CRYPTO_STALE_MS = 5 * 60 * 1000;

function kstDayKey(now) {
  return new Date(now + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function emptyQuote() {
  return { price: null, prevClose: null, raw: null, updatedAt: 0, period: null };
}

function createMarket(now = Date.now()) {
  const assets = {};
  for (const a of ASSETS) assets[a.id] = emptyQuote();
  return { version: 3, assets, fx: {}, lastTick: now };
}

// 저장된 시장에 새로 추가된 상품을 채우고, 빠진 상품은 지운다
function syncMarket(market) {
  market.fx = market.fx || (market.usdKrw ? { USD: market.usdKrw } : {});
  delete market.usdKrw;
  delete market.lastYahoo;
  for (const a of ASSETS) if (!market.assets[a.id]) market.assets[a.id] = emptyQuote();
  for (const q of Object.values(market.assets)) delete q.history; // 예전 버전의 차트 기록은 더 이상 쓰지 않음
  for (const id of Object.keys(market.assets)) if (!findAsset(id)) delete market.assets[id];
  return market;
}

function quote(market, id) {
  return market.assets[id] || null;
}

function price(market, id) {
  const q = quote(market, id);
  return q ? q.price : null;
}

// 실제 거래소가 지금 열려 있는지 (표시용 — 게임 거래는 24시간 가능)
function isOpen(market, id, now = Date.now()) {
  const a = findAsset(id);
  const q = quote(market, id);
  if (!a || !q || q.price == null) return false;
  if (a.category === 'crypto') return now - q.updatedAt < CRYPTO_STALE_MS;
  if (now - q.updatedAt > STALE_MS) return false;
  if (q.period) return now >= q.period.start && now < q.period.end;
  return true;
}

function marketStatus(market, id, now = Date.now()) {
  const q = quote(market, id);
  if (!q || q.price == null) return '시세 준비 중';
  return isOpen(market, id, now) ? '실시간' : '장 마감 (종가 기준)';
}

module.exports = {
  createMarket, syncMarket, quote, price, isOpen, marketStatus, kstDayKey,
};
