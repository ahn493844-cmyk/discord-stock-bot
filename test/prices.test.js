const test = require('node:test');
const assert = require('node:assert');
const { createMarket, isOpen } = require('../src/market');
const { refreshPrices } = require('../src/prices');

const NOW = Date.UTC(2026, 0, 5, 3);

function yahooBody(price, prev, period) {
  return {
    chart: {
      result: [{
        meta: {
          regularMarketPrice: price, chartPreviousClose: prev, regularMarketTime: NOW / 1000,
          currentTradingPeriod: { regular: period },
        },
      }],
    },
  };
}

function fakeFetch({ failYahoo = new Set() } = {}) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const json = (body) => ({ ok: true, status: 200, json: async () => body });
    if (url.includes('api.upbit.com')) {
      const markets = new URL(url).searchParams.get('markets').split(',');
      return json(markets.map((m) => ({ market: m, trade_price: m === 'KRW-BTC' ? 100_000_000 : 1000, prev_closing_price: 900, trade_timestamp: NOW })));
    }
    const ticker = decodeURIComponent(url.split('/chart/')[1].split('?')[0]);
    if (failYahoo.has(ticker)) return { ok: false, status: 429, json: async () => ({}) };
    const open = { start: NOW / 1000 - 3600, end: NOW / 1000 + 3600 };
    const prices = { 'KRW=X': 1400, AAPL: 200, 'GC=F': 3110.35, '005930.KS': 70000, 'JPYKRW=X': 9.5 };
    return json(yahooBody(prices[ticker] ?? 100, 99, open));
  };
  fn.calls = calls;
  return fn;
}

test('업비트·야후 시세를 원화로 환산해 반영한다', async () => {
  const m = createMarket(NOW);
  const f = fakeFetch();
  const r = await refreshPrices(m, { fetchImpl: f, now: NOW, force: true });
  assert.strictEqual(r.fail, 0, r.errors.join());
  assert.strictEqual(m.assets.BTC.price, 100_000_000);
  assert.strictEqual(m.usdKrw, 1400);
  assert.strictEqual(m.assets.USD.price, 1400);
  assert.strictEqual(m.assets.AAPL.price, 280_000);           // $200 × 1400
  assert.ok(Math.abs(m.assets.GOLD.price - 140_000) < 1);      // $3110.35/oz ÷ 31.1035 × 1400
  assert.strictEqual(m.assets.JPY.price, 950);                 // 100엔
  assert.strictEqual(m.assets['005930'].price, 70000);
  assert.ok(isOpen(m, '005930', NOW));
});

test('일부 실패해도 나머지는 갱신되고 이전 가격은 유지된다', async () => {
  const m = createMarket(NOW);
  m.assets.TSLA.price = 123;
  const r = await refreshPrices(m, { fetchImpl: fakeFetch({ failYahoo: new Set(['TSLA']) }), now: NOW, force: true });
  assert.strictEqual(r.fail, 1);
  assert.match(r.errors[0], /테슬라/);
  assert.strictEqual(m.assets.TSLA.price, 123);
  assert.strictEqual(m.assets.AAPL.price, 280_000);
});

test('야후는 주기마다만 호출하고 코인은 매번 갱신한다', async () => {
  const m = createMarket(NOW);
  const f = fakeFetch();
  await refreshPrices(m, { fetchImpl: f, now: NOW, force: true });
  const n = f.calls.length;
  await refreshPrices(m, { fetchImpl: f, now: NOW + 60_000 });
  assert.strictEqual(f.calls.length, n + 1); // 업비트 1회만
});
