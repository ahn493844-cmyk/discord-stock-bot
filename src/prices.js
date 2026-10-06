// 실제 시세 가져오기 — 업비트(코인), 야후 파이낸스(주식·ETF·금·환율)

const { ASSETS } = require('./assets');

const UA = 'Mozilla/5.0 (compatible; discord-stock-bot/1.0)';
const TIMEOUT_MS = 10_000;
const YAHOO_INTERVAL_MS = (Number(process.env.YAHOO_REFRESH_SECONDS) || 120) * 1000;
const YAHOO_CLOSED_INTERVAL_MS = 15 * 60 * 1000; // 장 마감 상품은 15분마다만 확인
const YAHOO_CONCURRENCY = 4;

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

// 야후 파이낸스 차트 API: 종목 하나씩 조회
async function fetchYahoo(ticker, fetchImpl) {
  const hosts = ['query1', 'query2'];
  let lastErr;
  for (const h of hosts) {
    try {
      const url = `https://${h}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
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
  const results = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

function toKrw(asset, raw, usdKrw) {
  if (raw == null) return null;
  let v = raw * (asset.factor || 1);
  if (asset.currency === 'USD') {
    if (!usdKrw) return null;
    v *= usdKrw;
  }
  return v;
}

function apply(market, asset, r, usdKrw, now) {
  const q = market.assets[asset.id];
  const price = toKrw(asset, r.raw, usdKrw);
  if (price == null || !(price > 0)) return false;
  q.price = price;
  q.raw = r.raw;
  q.prevClose = toKrw(asset, r.prevCloseRaw, usdKrw);
  q.period = r.period;
  q.updatedAt = now;
  return true;
}

// 시세 갱신. 실패한 상품은 이전 가격을 그대로 둔다. 결과 요약을 반환한다.
async function refreshPrices(market, { fetchImpl = fetch, now = Date.now(), force = false } = {}) {
  const summary = { ok: 0, fail: 0, errors: [] };

  // 코인 (매 틱)
  const coins = ASSETS.filter((a) => a.source === 'upbit');
  try {
    const res = await fetchUpbit(coins.map((a) => a.ticker), fetchImpl);
    for (const a of coins) {
      if (res[a.ticker] && apply(market, a, res[a.ticker], market.usdKrw, now)) summary.ok++;
      else summary.fail++;
    }
  } catch (err) {
    summary.fail += coins.length;
    summary.errors.push(`업비트: ${err.message}`);
  }

  // 야후 (주기적으로)
  if (!force && now - (market.lastYahoo || 0) < YAHOO_INTERVAL_MS) return summary;
  market.lastYahoo = now;

  const yahoo = ASSETS.filter((a) => a.source === 'yahoo').filter((a) => {
    if (force) return true;
    const q = market.assets[a.id];
    const closed = q.period && (now < q.period.start || now >= q.period.end);
    return !closed || now - q.updatedAt > YAHOO_CLOSED_INTERVAL_MS;
  });

  // 달러 환율을 먼저 갱신해야 미국 상품을 원화로 바꿀 수 있다
  const fxTicker = 'KRW=X';
  try {
    const fx = await fetchYahoo(fxTicker, fetchImpl);
    if (fx.raw > 0) market.usdKrw = fx.raw;
    const usdAsset = ASSETS.find((a) => a.ticker === fxTicker);
    if (usdAsset && yahoo.includes(usdAsset) && apply(market, usdAsset, fx, market.usdKrw, now)) summary.ok++;
  } catch (err) {
    summary.errors.push(`환율(${fxTicker}): ${err.message}`);
  }

  const rest = yahoo.filter((a) => a.ticker !== fxTicker);
  await mapLimit(rest, YAHOO_CONCURRENCY, async (a) => {
    try {
      const r = await fetchYahoo(a.ticker, fetchImpl);
      if (apply(market, a, r, market.usdKrw, now)) summary.ok++;
      else summary.fail++;
    } catch (err) {
      summary.fail++;
      summary.errors.push(`${a.name}(${a.ticker}): ${err.message}`);
    }
  });
  return summary;
}

module.exports = { refreshPrices, fetchYahoo, fetchUpbit, toKrw };
