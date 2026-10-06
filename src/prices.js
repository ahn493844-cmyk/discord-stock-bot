// 실제 시세 가져오기 — Railway 부하를 최소화하는 순서로:
//  1) 코인: 업비트에서 매 틱 한 번에 (요청 1건)
//  2) 나머지: GitHub Actions가 15분마다 만들어 GitHub Pages에 올린 quotes.json (3분마다 요청 1건)
//  3) Pages 시세가 오래됐거나 못 받으면 그때만 야후에서 직접 받는다 (순환 방식, 틱당 최대 YAHOO_PER_TICK개)

const { ASSETS } = require('./assets');

const UA = 'Mozilla/5.0 (compatible; discord-stock-bot/1.0)';
const TIMEOUT_MS = 10_000;
const OPEN_INTERVAL_MS = (Number(process.env.YAHOO_REFRESH_SECONDS) || 180) * 1000; // 장중 종목 갱신 주기
const CLOSED_INTERVAL_MS = 30 * 60 * 1000;                                           // 장 마감 종목 갱신 주기
const PER_TICK = Number(process.env.YAHOO_PER_TICK) || 20;
const CONCURRENCY = 4;
const PAGES_URL = (process.env.PAGES_URL || 'https://ahn493844-cmyk.github.io/discord-stock-bot').replace(/\/$/, '');
const PAGES_INTERVAL_MS = 3 * 60 * 1000;
const PAGES_STALE_MS = 45 * 60 * 1000; // 이보다 오래된 Pages 시세면 야후 직접 조회로 대신한다

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

function apply(market, asset, r, at) {
  const q = market.assets[asset.id];
  const price = toKrw(asset, r.raw, market.fx);
  if (price == null || !(price > 0)) return false;
  q.price = price;
  q.raw = r.raw;
  q.prevClose = toKrw(asset, r.prevCloseRaw, market.fx);
  q.period = r.period;
  q.updatedAt = at;
  return true;
}

// GitHub Pages의 quotes.json 반영. 성공하면 true
async function refreshFromPages(market, fetchImpl, now, summary, force) {
  if (!force && now - (market.pagesFetchedAt || 0) < PAGES_INTERVAL_MS) return now - (market.pagesOkAt || 0) < PAGES_STALE_MS;
  market.pagesFetchedAt = now;
  try {
    const data = await getJson(`${PAGES_URL}/data/quotes.json?t=${now}`, fetchImpl);
    if (!data || !data.quotes || !(now - data.generatedAt < PAGES_STALE_MS)) {
      summary.errors.push(`Pages 시세가 오래됨 (${data && data.generatedAt ? new Date(data.generatedAt).toISOString() : '없음'})`);
      return false;
    }
    market.fx = { ...market.fx, ...data.fx };
    for (const a of ASSETS) {
      const r = data.quotes[a.id];
      if (a.source !== 'yahoo' || !r) continue;
      if (apply(market, a, r, data.generatedAt)) summary.ok++;
      else summary.fail++;
    }
    market.chartsVersion = data.generatedAt;
    market.pagesOkAt = now;
    summary.source = 'pages';
    return true;
  } catch (err) {
    summary.errors.push(`Pages: ${err.message}`);
    return now - (market.pagesOkAt || 0) < PAGES_STALE_MS;
  }
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
  const summary = { ok: 0, fail: 0, errors: [], source: null };
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

  // 2) GitHub Pages 시세 (정상이면 야후 직접 조회는 하지 않는다)
  if (await refreshFromPages(market, fetchImpl, now, summary, force)) return summary;
  summary.source = 'yahoo';

  // 3) 대체 경로: 야후 직접 조회. 환율 먼저 (달러·엔화 상품 환산에 필요)
  for (const [cur, ticker] of Object.entries(FX_TICKERS)) {
    const a = ASSETS.find((x) => x.ticker === ticker);
    const q = a && market.assets[a.id];
    if (!a || (!force && market.fx[cur] && !isDue(q, now))) continue;
    const r = await fetchOne(a);
    if (r && r.raw > 0) market.fx[cur] = r.raw;
  }

  // 나머지 야후 종목: 갱신할 때가 된 것 중 오래된 순서로
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

module.exports = { refreshPrices, fetchYahoo, fetchUpbit, toKrw, FX_TICKERS, PAGES_URL };
