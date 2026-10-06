// GitHub Actions에서 실행: 실제 시세·차트 데이터를 받아
//  site/data/quotes.json  — 봇(Railway)이 읽는 시세 파일
//  site/charts/{종목}_{1d|1w|1m|1y}.png — 디스코드에 띄울 차트 이미지
// 를 만든다. Railway는 이 결과물을 GitHub Pages에서 가져다 쓰기만 한다.
//
//   node build.js            실제 데이터로 생성
//   node build.js --sample   네트워크 없이 가짜 데이터로 몇 종목만 생성 (모양 확인용)

const fs = require('fs');
const path = require('path');
const { ASSETS } = require('../../src/assets');
const { renderChart, renderIcon } = require('./render');

const OUT = path.join(__dirname, 'site');
const CACHE = path.join(__dirname, '.cache');
const DAILY_TTL_MS = 6 * 3600 * 1000;      // 일봉·주봉은 6시간마다만 새로 받음
const TIME_BUDGET_MS = 9 * 60 * 1000;      // 한 번 실행에 최대 9분
const CONCURRENCY = 3;
const UA = 'Mozilla/5.0 (compatible; discord-stock-bot-charts/1.0)';
const SAMPLE = process.argv.includes('--sample');
const started = Date.now();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (res.ok) return res.json();
    if (res.status === 429 || res.status >= 500) {
      await sleep(3000 * (attempt + 1));
      continue;
    }
    throw new Error(`HTTP ${res.status}`);
  }
  throw new Error('재시도 초과');
}

// ── 야후 ─────────────────────────────────────────────────────

async function yahooChart(ticker, range, interval) {
  let lastErr;
  for (const host of ['query1', 'query2']) {
    try {
      const data = await getJson(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${range}&interval=${interval}`);
      const r = data.chart.result[0];
      const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
      const points = (r.timestamp || []).map((t, i) => ({
        t: t * 1000, o: q.open?.[i], h: q.high?.[i], l: q.low?.[i], c: q.close?.[i],
      })).filter((p) => Number.isFinite(p.c));
      return { meta: r.meta, points };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// 직전 거래일 종가: 마지막 봉이 속한 날(거래소 현지 날짜) 바로 전 거래일의 마지막 봉.
// 장 중이든 장 마감 후든 "그날 등락"이 나온다. (거래 세션 기준으로 자르면 장 마감 후에
// 다음 세션이 기준이 되어 오늘 종가를 전일 종가로 잡아 0.00%가 되는 문제가 있었다)
function previousClose(meta, points) {
  if (points.length) {
    const offset = (meta.gmtoffset || 0) * 1000;
    const day = (t) => new Date(t + offset).toISOString().slice(0, 10);
    const lastDay = day(points[points.length - 1].t);
    for (let i = points.length - 1; i >= 0; i--) {
      if (day(points[i].t) !== lastDay) return points[i].c;
    }
  }
  return meta.previousClose ?? meta.chartPreviousClose ?? null;
}

// ── 업비트 ───────────────────────────────────────────────────

async function upbitCandles(market, kind, count) {
  const data = await getJson(`https://api.upbit.com/v1/candles/${kind}?market=${market}&count=${count}`);
  return data.reverse().map((c) => ({
    t: Date.parse(`${c.candle_date_time_utc}Z`), o: c.opening_price, h: c.high_price, l: c.low_price, c: c.trade_price,
  }));
}

// ── 캐시 ─────────────────────────────────────────────────────

function readCache(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(CACHE, `${id}.json`), 'utf-8'));
  } catch {
    return {};
  }
}

function writeCache(id, data) {
  fs.writeFileSync(path.join(CACHE, `${id}.json`), JSON.stringify(data));
}

// ── 종목 하나 처리 ───────────────────────────────────────────

const scale = (asset, pts) => pts.map((p) => {
  const f = asset.factor || 1;
  return { t: p.t, o: p.o * f, h: p.h * f, l: p.l * f, c: p.c * f };
});

async function collect(asset, now) {
  const cache = readCache(asset.id);
  const dailyFresh = cache.daily && now - cache.daily.at < DAILY_TTL_MS;
  let quote = null;
  let intraday;
  let hourly;

  if (asset.source === 'upbit') {
    intraday = await upbitCandles(asset.ticker, 'minutes/15', 96);
    hourly = await upbitCandles(asset.ticker, 'minutes/60', 168);
    if (!dailyFresh) {
      cache.daily = { at: now, points: await upbitCandles(asset.ticker, 'days', 31) };
      cache.weekly = { at: now, points: await upbitCandles(asset.ticker, 'weeks', 52) };
    }
    const last = intraday[intraday.length - 1];
    const days = (cache.daily && cache.daily.points) || [];
    const prev = days.length >= 2 ? days[days.length - 2].c : null; // 마지막 일봉은 오늘 진행 중
    if (last) quote = { raw: last.c, prevCloseRaw: prev, time: last.t, period: null };
  } else {
    const r = await yahooChart(asset.ticker, '5d', '15m');
    intraday = r.points;
    hourly = r.points;
    const reg = r.meta.currentTradingPeriod && r.meta.currentTradingPeriod.regular;
    quote = {
      raw: r.meta.regularMarketPrice,
      prevCloseRaw: previousClose(r.meta, r.points),
      time: (r.meta.regularMarketTime || 0) * 1000 || now,
      period: reg && reg.start && reg.end ? { start: reg.start * 1000, end: reg.end * 1000 } : null,
    };
    if (!dailyFresh) {
      const d = await yahooChart(asset.ticker, '1y', '1d');
      cache.daily = { at: now, points: d.points };
    }
  }
  writeCache(asset.id, cache);

  const lastT = intraday.length ? intraday[intraday.length - 1].t : now;
  const daily = (cache.daily && cache.daily.points) || [];
  return {
    quote,
    series: {
      '1d': intraday.filter((p) => p.t > lastT - 24 * 3600 * 1000),
      '1w': hourly,
      '1m': daily.slice(-22),
      '1y': asset.source === 'upbit' ? ((cache.weekly && cache.weekly.points) || []) : daily,
    },
  };
}

// ── 가짜 데이터 (모양 확인용) ─────────────────────────────────

function sampleSeries(seed, base, n, stepMs, now) {
  let x = seed;
  const rnd = () => ((x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296);
  let p = base;
  return Array.from({ length: n }, (_, i) => {
    const o = p;
    const c = o * (1 + (rnd() - 0.48) * 0.02);
    const h = Math.max(o, c) * (1 + rnd() * 0.006);
    const l = Math.min(o, c) * (1 - rnd() * 0.006);
    p = c;
    return { t: now - (n - i) * stepMs, o, h, l, c };
  });
}

async function collectSample(asset, now, i) {
  const base = { USD: 1400, JPY: 9.5, EUR: 1600 }[asset.id] ?? ({ USD: 200, JPY: 40000 }[asset.currency] || 70000);
  const series = {
    '1d': sampleSeries(i + 1, base, 26, 15 * 60e3, now),
    '1w': sampleSeries(i + 2, base, 130, 60 * 60e3, now),
    '1m': sampleSeries(i + 3, base, 22, 86400e3, now),
    '1y': sampleSeries(i + 4, base, 250, 86400e3, now),
  };
  const last = series['1d'][series['1d'].length - 1];
  return { quote: { raw: last.c, prevCloseRaw: series['1d'][0].o, time: now, period: null }, series };
}

// ── 실행 ─────────────────────────────────────────────────────

async function main() {
  const now = Date.now();
  fs.mkdirSync(path.join(OUT, 'charts'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'data'), { recursive: true });
  fs.mkdirSync(CACHE, { recursive: true });

  const targets = ASSETS;
  const SAMPLE_CHARTS = new Set(['005930', 'AAPL', 'BTC', 'CL', 'N225', 'GOLD']);
  const quotes = {};
  const errors = [];
  let charts = 0;
  let idx = 0;

  const worker = async () => {
    while (idx < targets.length) {
      const i = idx++;
      const asset = targets[i];
      if (Date.now() - started > TIME_BUDGET_MS) {
        errors.push(`${asset.id}: 시간 초과로 건너뜀`);
        continue;
      }
      try {
        const r = SAMPLE ? await collectSample(asset, now, i) : await collect(asset, now);
        if (r.quote && r.quote.raw > 0) quotes[asset.id] = r.quote;
        if (SAMPLE && !SAMPLE_CHARTS.has(asset.id)) continue;
        for (const [range, pts] of Object.entries(r.series)) {
          const png = renderChart({
            name: asset.name, id: asset.id, currency: asset.currency, range, points: SAMPLE ? pts : scale(asset, pts),
          });
          fs.writeFileSync(path.join(OUT, 'charts', `${asset.id}_${range}.png`), png);
          charts++;
        }
      } catch (err) {
        errors.push(`${asset.id}(${asset.ticker}): ${err.message}`);
      }
      if (!SAMPLE) await sleep(200);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // 환율: 봇이 달러·엔화 상품을 원화로 바꿀 때 사용
  const fx = {};
  if (quotes.USD) fx.USD = quotes.USD.raw;
  if (quotes.JPY) fx.JPY = quotes.JPY.raw;

  // 종목 아이콘
  let extras = 0;
  for (const a of targets) {
    fs.writeFileSync(path.join(OUT, 'charts', `icon_${a.id}.png`), renderIcon(a));
    extras++;
  }
  const generatedAt = Date.now();
  fs.writeFileSync(path.join(OUT, 'data', 'quotes.json'), JSON.stringify({ generatedAt, fx, quotes }));
  fs.writeFileSync(path.join(OUT, 'index.html'), `<!doctype html><meta charset="utf-8"><title>주식봇 시세</title>
<body style="background:#1e1f22;color:#dbdee1;font-family:sans-serif">
<h1>디스코드 주식봇 시세·차트</h1><p>생성: ${new Date(generatedAt).toISOString()} · 시세 ${Object.keys(quotes).length}종목 · 차트 ${charts}장</p>
${targets.map((a) => `<p>${a.name} (${a.id}) <a href="charts/${a.id}_1d.png">1일</a> <a href="charts/${a.id}_1w.png">1주</a> <a href="charts/${a.id}_1m.png">1달</a> <a href="charts/${a.id}_1y.png">1년</a></p>`).join('\n')}
</body>`);

  console.log(`시세 ${Object.keys(quotes).length}/${targets.length} · 차트 ${charts}장 · 그래픽 ${extras}장 · 실패 ${errors.length} · ${((Date.now() - started) / 1000).toFixed(0)}초`);
  if (errors.length) console.log(errors.slice(0, 30).join('\n'));
  // 절반 넘게 실패하면 배포하지 않도록 실패 처리 (기존 Pages가 유지됨)
  if (Object.keys(quotes).length < targets.length / 2) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
