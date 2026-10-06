// 실제 시세 가져오기 — 업비트(코인), 야후 파이낸스(주식·ETF·선물·금·환율)
//
// 야후는 종목마다 한 번씩 요청해야 해서, 매 틱마다 "갱신할 때가 된" 종목 중
// 오래된 것부터 최대 YAHOO_PER_TICK개만 요청한다 (요청이 몰려 차단되는 것을 막기 위함).

const { ASSETS } = require('./assets');

const UA = 'Mozilla/5.0 (compatible; discord-stock-bot/1.0)';
const TIMEOUT_MS = 10_000;
const OPEN_INTERVAL_MS = (Number(process.env.YAHOO_REFRESH_SECONDS) || 180) * 1000; // 장중 종목 갱신 주기
const CLOSED_INTERVAL_MS = 30 * 60 * 1000;                                           // 장 마감 종목 갱신 주기
const PER_TICK = Number(process.env.YAHOO_PER_TICK) || 20;
const CONCURRENCY = 4;

// 환율: 달러·엔화 상품을 원화로 바꿀 때 쓴다 (KRW 기준 1단위 가격)
const FX_TICKERS = { USD: 'KRW=X', JPY: 'JPYKRW=X' };

async function getJson(url, fetchImpl) {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// 업비트: 원화 마켓 시세를 한 번에 조회
async function fetchUpbit(tickers, fetchImpl) {
  const data = await getJson(`https://api.upbit.com/v1/ticker?markets=${tickers.join(',')}`, fetchImpl);
  const out = {};
  for (const t of data) {
    out[t.market] = {
      raw: t.trade_price,
      prevCloseRaw: t.prev_closing_price,
      time: t.trade_timestamp || t.timestamp || Date.now(),
      period: null,
    };
  }
  return out;
}

// 야후 파이낸스 차트 API: 종목 하나 조회
async function fetchYahoo(ticker, fetchImpl) {
  let lastErr;
  for (const host of ['query1', 'query2']) {
    try {
      const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
      const data = await getJson(url, fetchImpl);
      const meta = data && data.chart && data.chart.result && data.chart.result[0] && data.chart.result[0].meta;
      if (!meta || typeof meta.regularMarketPrice !== 'number') throw new Error('시세 없음');
      const reg = meta.currentTradingPeriod && meta.currentTradingPeriod.regular;
      return {
        raw: meta.regularMarketPrice,
        prevCloseRaw: meta.chartPreviousClose ?? meta.previousClose ?? null,
        time: (meta.regularMarketTime || 0) * 1000 || Date.now(),
        period: reg && reg.start && reg.end ? { start: reg.start * 1000, end: reg.end * 1000 } : null,
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function mapLimit(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}

function toKrw(asset, raw, fx) {
  if (raw == null) return null;
  let v = raw * (asset.factor || 1);
  if (asset.currency !== 'KRW') {
    const rate = fx && fx[asset.currency];
    if (!rate) return null;
    v *= rate;
  }
  return v;
}

function apply(market, asset, r, now) {
  const q = market.assets[asset.id];
  const price = toKrw(asset, r.raw, market.fx);
  if (price == null || !(price > 0)) return false;
  q.price = price;
  q.raw = r.raw;
  q.prevClose = toKrw(asset, r.prevCloseRaw, market.fx);
  q.period = r.period;
  q.updatedAt = now;
  return true;
}

function isDue(q, now) {
  if (q.price == null) return now - (q.attemptedAt || 0) >= 60 * 1000; // 아직 시세가 없으면 1분마다 재시도
  const closed = q.period && (now < q.period.start || now >= q.period.end);
  return now - (q.attemptedAt || 0) >= (closed ? CLOSED_INTERVAL_MS : OPEN_INTERVAL_MS);
}

// 시세 갱신. 실패한 상품은 이전 가격을 그대로 둔다. 결과 요약을 반환한다.
// force: 봇 시작 시 — 환율과 시세가 없는 종목을 제한 없이 요청
async function refreshPrices(market, { fetchImpl = fetch, now = Date.now(), force = false } = {}) {
  market.fx = market.fx || {};
  const summary = { ok: 0, fail: 0, errors: [] };
  const fetchOne = async (a) => {
    const q = market.assets[a.id];
    q.attemptedAt = now;
    try {
      const r = await fetchYahoo(a.ticker, fetchImpl);
      if (apply(market, a, r, now)) summary.ok++;
      else summary.fail++;
      return r;
    } catch (err) {
      summary.fail++;
      summary.errors.push(`${a.name}(${a.ticker}): ${err.message}`);
      return null;
    }
  };

  // 1) 코인 (매 틱, 한 번에)
  const coins = ASSETS.filter((a) => a.source === 'upbit');
  try {
    const res = await fetchUpbit(coins.map((a) => a.ticker), fetchImpl);
    for (const a of coins) {
      if (res[a.ticker] && apply(market, a, res[a.ticker], now)) summary.ok++;
      else summary.fail++;
    }
  } catch (err) {
    summary.fail += coins.length;
    summary.errors.push(`업비트: ${err.message}`);
  }

  // 2) 환율 먼저 (달러·엔화 상품 환산에 필요)
  for (const [cur, ticker] of Object.entries(FX_TICKERS)) {
    const a = ASSETS.find((x) => x.ticker === ticker);
    const q = a && market.assets[a.id];
    if (!a || (!force && market.fx[cur] && !isDue(q, now))) continue;
    const r = await fetchOne(a);
    if (r && r.raw > 0) market.fx[cur] = r.raw;
  }

  // 3) 나머지 야후 종목: 갱신할 때가 된 것 중 오래된 순서로
  const fxTickers = new Set(Object.values(FX_TICKERS));
  const due = ASSETS
    .filter((a) => a.source === 'yahoo' && !fxTickers.has(a.ticker))
    .filter((a) => isDue(market.assets[a.id], now) || (force && market.assets[a.id].price == null))
    .sort((a, b) => (market.assets[a.id].attemptedAt || 0) - (market.assets[b.id].attemptedAt || 0));
  // 봇 시작 시(force)에는 시세가 아직 없는 종목은 개수 제한 없이 한 번에 받는다
  const missing = force ? due.filter((a) => market.assets[a.id].price == null) : [];
  const rest = due.filter((a) => !missing.includes(a)).slice(0, PER_TICK);
  await mapLimit([...missing, ...rest], CONCURRENCY, fetchOne);
  return summary;
}

module.exports = { refreshPrices, fetchYahoo, fetchUpbit, toKrw, FX_TICKERS };
