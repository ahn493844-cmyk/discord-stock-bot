const test = require('node:test');
const assert = require('node:assert');
const game = require('../src/game');

// 출신·직업 뽑기를 고정: 동수저 · 회사원(일급 10만) · 시작 자금 100만원
game.setLifeRoller(() => ({ origin: 'bronze', job: 'office', startCash: 1_000_000 }));
const { isOpen } = require('../src/market');

const NOW = Date.UTC(2026, 0, 5, 3); // 월요일 KST 12:00

function setPrice(s, id, price, { now = NOW, period = null, prevClose = price } = {}) {
  Object.assign(s.market.assets[id], { price, prevClose, updatedAt: now, period });
}

function fresh() {
  const s = game.createState(NOW);
  setPrice(s, '005930', 70000);
  setPrice(s, 'BTC', 100_000_000);
  setPrice(s, 'AAPL', 300_000);
  return s;
}

test('신규 유저는 초기 자금으로 시작한다', () => {
  const s = fresh();
  assert.strictEqual(game.getUser(s, 'u', 'g').cash, game.START_CASH);
});

test('현금 매수 후 전량 매도하면 수수료만큼만 줄어든다', () => {
  const s = fresh();
  const b = game.buy(s, 'u', 'g', '005930', '10', 'cash', NOW);
  assert.strictEqual(b.qty, 10);
  const r = game.sell(s, 'u', 'g', '005930', '전부', NOW);
  const u = game.getUser(s, 'u');
  assert.strictEqual(u.cash, game.START_CASH - b.fee - r.fee);
  assert.deepStrictEqual(u.holdings, {});
});

test('코인은 소수 수량과 금액 단위 매수가 된다', () => {
  const s = fresh();
  const b = game.buy(s, 'u', 'g', 'BTC', '10만원', 'cash', NOW);
  assert.strictEqual(b.qty, 0.001);
  assert.throws(() => game.buy(s, 'u', 'g', '005930', '0.5', 'cash', NOW), game.GameError);
});

test('전부 매수는 잔고를 넘지 않는다', () => {
  const s = fresh();
  const b = game.buy(s, 'u', 'g', '005930', '전부', 'cash', NOW);
  assert.ok(b.cash >= 0 && b.cash < 70000 * 1.0015);
});

test('장이 닫혀 있어도 마지막 종가로 24시간 거래되고, 시세가 없을 때만 막힌다', () => {
  const s = fresh();
  setPrice(s, '005930', 70000, { period: { start: NOW + 3600e3, end: NOW + 7200e3 } });
  assert.ok(!isOpen(s.market, '005930', NOW));
  const b = game.buy(s, 'u', 'g', '005930', '1', 'cash', NOW);
  assert.strictEqual(b.price, 70000);
  setPrice(s, 'AAPL', 300000, { now: NOW - 10 * 3600e3 }); // 10시간 전 종가
  assert.strictEqual(game.sell(s, 'u', 'g', '005930', '1', NOW).price, 70000);
  game.openFuture(s, 'u', 'g', 'AAPL', 'short', '5만', 2, NOW);
  assert.throws(() => game.buy(s, 'u', 'g', 'TSLA', '1', 'cash', NOW), /시세/);
});

test('신용매수는 절반만 내고 나머지는 대출, 매도하면 자동 상환', () => {
  const s = fresh();
  const b = game.buy(s, 'u', 'g', '005930', '20', 'credit', NOW);
  assert.strictEqual(b.loan.amount, 700000);
  const u = game.getUser(s, 'u');
  assert.strictEqual(game.loanTotal(u), 700000);
  const r = game.sell(s, 'u', 'g', '005930', '전부', NOW);
  assert.strictEqual(r.repaid, 700000);
  assert.strictEqual(game.loanTotal(u), 0);
});

test('대출 한도는 순자산의 1.5배', () => {
  const s = fresh();
  const b = game.buy(s, 'u', 'g', '005930', '전부', 'misu', NOW);
  assert.ok(b.loan.amount <= game.START_CASH * game.LOAN_LIMIT_RATIO + 1);
});

test('미수 결제일에 현금이 없으면 반대매매된다', () => {
  const s = fresh();
  game.buy(s, 'u', 'g', '005930', '30', 'misu', NOW); // 210만원 중 84만원 + 수수료 지불, 126만원 미수
  const u = game.getUser(s, 'u');
  assert.strictEqual(game.loanTotal(u), 1_260_000);
  const later = NOW + 2 * 86400e3 + 1;
  setPrice(s, '005930', 70000, { now: later });
  const ev = game.processRisk(s, later);
  assert.ok(ev.some((e) => /반대매매/.test(e.text)));
  assert.strictEqual(game.loanTotal(u), 0);
  assert.deepStrictEqual(u.holdings, {});
});

test('주가가 떨어져 담보비율이 140% 아래면 반대매매된다', () => {
  const s = fresh();
  game.buy(s, 'u', 'g', '005930', '28', 'credit', NOW); // 98만원 대출
  const u = game.getUser(s, 'u');
  setPrice(s, '005930', 40000); // 자산 ≈ 1.6만 + 112만 = 114만 / 대출 98만 ≈ 116%
  const ev = game.processRisk(s, NOW + 1000);
  assert.ok(ev.some((e) => /담보비율/.test(e.text)), JSON.stringify(ev));
  const v = game.portfolioValue(s, u, NOW + 1000);
  assert.ok(v.loans === 0 || v.assets / v.loans >= game.MAINTENANCE_RATIO);
});

test('선물 롱은 오르면 레버리지만큼 벌고 청산하면 정산된다', () => {
  const s = fresh();
  const o = game.openFuture(s, 'u', 'g', 'BTC', 'long', '10만', 10, NOW);
  assert.strictEqual(o.pos.margin, 100000);
  setPrice(s, 'BTC', 105_000_000); // +5% × 10배 = +50%
  const c = game.closeFuture(s, 'u', 'g', o.pos.id, NOW);
  assert.ok(Math.abs(c.pnl - 50000) < 1);
  assert.ok(Math.abs(c.payout - (150000 - c.fee)) < 1);
});

test('선물 숏은 손실이 증거금 90%에 닿으면 강제청산된다', () => {
  const s = fresh();
  const o = game.openFuture(s, 'u', 'g', 'BTC', 'short', '10만', 20, NOW);
  assert.ok(Math.abs(o.liqPrice - 104_500_000) < 1);
  setPrice(s, 'BTC', 104_000_000);
  assert.strictEqual(game.processRisk(s, NOW + 1).length, 0);
  setPrice(s, 'BTC', 104_600_000);
  const ev = game.processRisk(s, NOW + 2);
  assert.ok(/강제청산/.test(ev[0].text));
  assert.strictEqual(game.getUser(s, 'u').futures.length, 0);
});

test('콜옵션: 블랙숄즈 가격으로 사고, 만기에 내재가치로 정산', () => {
  const s = fresh();
  const q = game.quoteOption(s, '005930', 'call', '현재가', '1d', NOW);
  assert.strictEqual(q.strike, 70000);
  assert.ok(q.premium > 0 && q.premium < 3000, String(q.premium));
  const b = game.buyOption(s, 'u', 'g', '005930', 'call', '현재가', '1d', '10', NOW);
  const later = b.opt.expiry + 1;
  setPrice(s, '005930', 75000, { now: later });
  const before = game.getUser(s, 'u').cash;
  const ev = game.processRisk(s, later);
  assert.ok(/만기/.test(ev[0].text));
  assert.strictEqual(game.getUser(s, 'u').cash - before, 50000);
});

test('풋옵션 행사가 퍼센트 입력과 중도 매도', () => {
  const s = fresh();
  const b = game.buyOption(s, 'u', 'g', 'BTC', 'put', '-5%', '1w', '0.01', NOW);
  assert.strictEqual(b.strike, 95_000_000);
  setPrice(s, 'BTC', 80_000_000);
  const r = game.sellOption(s, 'u', 'g', b.opt.id, NOW + 1000);
  assert.ok(r.value > 0.01 * 14_000_000, String(r.value));
});

test('순자산 = 현금 + 현물 + 선물 + 옵션 - 대출', () => {
  const s = fresh();
  game.buy(s, 'u', 'g', '005930', '10', 'credit', NOW);
  game.openFuture(s, 'u', 'g', 'BTC', 'long', '5만', 5, NOW);
  game.buyOption(s, 'u', 'g', 'AAPL', 'call', '현재가', '1w', '1', NOW);
  const v = game.portfolioValue(s, game.getUser(s, 'u'), NOW);
  assert.ok(Math.abs(v.total - (v.cash + v.stock + v.futures + v.options - v.loans)) < 1e-6);
  assert.ok(v.total < game.START_CASH && v.total > game.START_CASH * 0.98);
});

test('수량·금액 파싱', () => {
  const asset = { decimals: 0 };
  assert.strictEqual(game.parseQuantity('절반', { max: 11, asset }), 5);
  assert.strictEqual(game.parseQuantity('50%', { max: 10, asset }), 5);
  assert.strictEqual(game.parseQuantity('1,000주', { max: 5, asset }), 1000);
  assert.strictEqual(game.parseAmount('5만', 1e9), 50000);
  assert.strictEqual(game.parseAmount('1.5억', 1e9), 150_000_000);
  assert.throws(() => game.parseAmount('abc', 100), game.GameError);
});

test('출석은 하루 한 번', () => {
  const s = fresh();
  game.claimDaily(s, 'u', 'g', NOW);
  assert.throws(() => game.claimDaily(s, 'u', 'g', NOW + 1000), game.GameError);
  game.claimDaily(s, 'u', 'g', NOW + 86400000);
  assert.strictEqual(game.getUser(s, 'u').cash, game.START_CASH + 2 * 1_000_000);
});

test('파산은 순자산이 적을 때만 가능하고 모든 포지션을 초기화한다', () => {
  const s = fresh();
  assert.throws(() => game.bankrupt(s, 'u', 'g', NOW), game.GameError);
  const u = game.getUser(s, 'u');
  u.cash = 500;
  u.loans.push({ id: 99, type: 'credit', amount: 100, createdAt: NOW, dueAt: null });
  assert.strictEqual(game.bankrupt(s, 'u', 'g', NOW).cash, game.START_CASH);
  assert.strictEqual(game.getUser(s, 'u').loans.length, 0);
});

test('계좌는 모든 서버 공용이고, 랭킹은 전체/서버별로 볼 수 있다', () => {
  const s = fresh();
  game.getUser(s, 'a', 'g1').cash = 10;
  game.getUser(s, 'b', 'g1').cash = 20;
  game.getUser(s, 'c', 'g2').cash = 30;
  assert.strictEqual(game.getUser(s, 'a', 'g2').cash, 10);
  assert.deepStrictEqual(game.ranking(s).map((x) => x.userId), ['c', 'b', 'a']);
  assert.deepStrictEqual(game.ranking(s, 'g1').map((x) => x.userId), ['b', 'a']);
});

test('가상 종목 시절 데이터는 보유 주식을 현금으로 정산하고 실제 시장으로 바뀐다', () => {
  const acc = (cash, holdings = {}) => ({ cash, holdings, realized: 0, lastDaily: null, createdAt: 0 });
  const old = {
    version: 1,
    market: { stocks: { DCE: { price: 70000 }, MMB: { price: 20000 } }, dayKey: 'x', lastTick: 0 },
    guilds: {
      g1: { newsChannelId: 'c', users: { a: acc(500_000, { DCE: { qty: 5, avgPrice: 72000 } }), b: acc(700) } },
      g2: { newsChannelId: null, users: { a: acc(900_000) } },
    },
  };
  const s = game.normalizeState(old, NOW);
  assert.strictEqual(s.users.a.cash, 900_000); // g1: 50만 + 5×7만 = 85만 < g2: 90만
  assert.deepStrictEqual(s.users.a.holdings, {});
  assert.deepStrictEqual(s.users.a.guilds.sort(), ['g1', 'g2']);
  assert.ok(s.market.assets['005930']);
  assert.strictEqual(s.market.stocks, undefined);
  assert.deepStrictEqual(s.users.a.futures, []);
});

test('v2 공용 계좌 + 가상 종목 데이터도 정산된다', () => {
  const s = game.normalizeState({
    version: 2,
    market: { stocks: { DCE: { price: 1000 } } },
    users: { a: { cash: 100, holdings: { DCE: { qty: 3, avgPrice: 1 } }, realized: 0, guilds: ['g'] } },
    guilds: { g: { newsChannelId: null } },
  }, NOW);
  assert.strictEqual(s.users.a.cash, 3100);
});

test('반대매매할 것이 없으면 매 틱 같은 알림을 반복하지 않는다', () => {
  const s = fresh();
  const u = game.getUser(s, 'u', 'g');
  u.cash = 0;
  u.loans.push({ id: 1, type: 'credit', amount: 1000, createdAt: NOW, dueAt: null });
  assert.strictEqual(game.processRisk(s, NOW + 1).length, 0);
  assert.strictEqual(game.processRisk(s, NOW + 2).length, 0);
});

const life = require('../src/life');

test('출신·직업 확률표 합계는 100%, 뽑기는 확률대로 나온다', () => {
  assert.strictEqual(life.ORIGINS.reduce((s, o) => s + o.weight, 0), 100);
  assert.strictEqual(life.JOBS.reduce((s, j) => s + j.weight, 0), 100);
  let seed = 7;
  const rng = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const count = {};
  for (let i = 0; i < 20000; i++) {
    const r = life.rollLife(rng);
    count[r.origin] = (count[r.origin] || 0) + 1;
    const o = life.originOf(r.origin);
    assert.ok(r.startCash >= o.min && r.startCash <= o.max && r.startCash % 100000 === 0);
  }
  assert.ok(Math.abs(count.dirt / 20000 - 0.40) < 0.02, JSON.stringify(count));
  assert.ok(Math.abs(count.orphan / 20000 - 0.09) < 0.01, JSON.stringify(count));
  assert.ok(count.gold > 120 && count.gold < 280, JSON.stringify(count));
  assert.ok((count.chaebol || 0) < 15, JSON.stringify(count));
});

test('기존 계좌는 자산 그대로 1세대 투자자가 되고 바로 환생할 수 있다', () => {
  const s = game.normalizeState({
    version: 3, market: { assets: {}, fx: {} },
    users: { old: { cash: 777, holdings: {}, realized: 0, guilds: ['g'], createdAt: 0 } }, guilds: {},
  }, NOW);
  const u = s.users.old;
  assert.strictEqual(u.cash, 777);
  assert.strictEqual(u.origin, 'legacy');
  assert.strictEqual(u.startCash, game.START_CASH);
  assert.ok(life.JOBS.some((j) => j.key === u.job));
  assert.ok(game.rebirthStatus(u, NOW).ready);
});

test('파산은 출신·직업을 유지하고 원래 시작 자금으로', () => {
  const s = fresh();
  const u = game.getUser(s, 'u', 'g');
  Object.assign(u, { origin: 'silver', job: 'dev', startCash: 50_000_000, cash: 10 });
  game.bankrupt(s, 'u', 'g', NOW);
  const n = game.getUser(s, 'u');
  assert.strictEqual(n.cash, 50_000_000);
  assert.strictEqual(n.origin, 'silver');
  assert.strictEqual(game.claimDaily(s, 'u', 'g', NOW + 86400e3).bonus, 1_500_000);
});

test('직업 다시 뽑기는 하루 한 번, 자산·출신은 그대로', () => {
  const s = fresh();
  const u = game.getUser(s, 'u', 'g');
  u.cash = 1234;
  game.setLifeRoller(() => ({ origin: 'bronze', job: 'office', startCash: 1_000_000 }), () => 'idol');
  try {
    const r = game.rerollJob(s, 'u', 'g', NOW);
    assert.strictEqual(r.before.key, 'office');
    assert.strictEqual(r.after.key, 'idol');
    assert.strictEqual(u.cash, 1234);
    assert.throws(() => game.rerollJob(s, 'u', 'g', NOW + 3600e3), /하루에 한 번/);
    assert.ok(game.jobRollStatus(u, NOW + 86400e3).ready);
    assert.strictEqual(game.claimDaily(s, 'u', 'g', NOW).bonus, 10_000_000);
  } finally {
    game.setLifeRoller(() => ({ origin: 'bronze', job: 'office', startCash: 1_000_000 }));
  }
});
