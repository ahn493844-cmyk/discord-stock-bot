const test = require('node:test');
const assert = require('node:assert');
const game = require('../src/game');
const { tick, STOCKS, kstDayKey } = require('../src/market');

function seeded(seed = 42) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

test('신규 유저는 초기 자금으로 시작한다', () => {
  const s = game.createState();
  assert.strictEqual(game.getUser(s, 'g', 'u').cash, game.START_CASH);
});

test('매수 후 매도하면 수수료만큼 손해', () => {
  const s = game.createState();
  const b = game.buy(s, 'g', 'u', 'DCE', '10');
  assert.strictEqual(b.qty, 10);
  const r = game.sell(s, 'g', 'u', 'DCE', '전부');
  assert.strictEqual(r.qty, 10);
  const u = game.getUser(s, 'g', 'u');
  assert.strictEqual(u.cash, game.START_CASH - b.fee - r.fee);
  assert.deepStrictEqual(u.holdings, {});
});

test('전부 매수는 잔고를 넘지 않는다', () => {
  const s = game.createState();
  const b = game.buy(s, 'g', 'u', 'HGC', '전부');
  assert.ok(b.cash >= 0);
  assert.throws(() => game.buy(s, 'g', 'u', 'HGC', '1'), game.GameError);
});

test('잔고 부족·미보유·잘못된 수량은 GameError', () => {
  const s = game.createState();
  assert.throws(() => game.buy(s, 'g', 'u', 'SPC', '1000'), game.GameError);
  assert.throws(() => game.sell(s, 'g', 'u', 'SPC', '1'), game.GameError);
  assert.throws(() => game.buy(s, 'g', 'u', 'SPC', 'abc'), game.GameError);
  assert.throws(() => game.buy(s, 'g', 'u', 'SPC', '0'), game.GameError);
});

test('수량 파싱', () => {
  assert.strictEqual(game.parseQuantity('절반', 11), 5);
  assert.strictEqual(game.parseQuantity('50%', 10), 5);
  assert.strictEqual(game.parseQuantity('1,000주', 5), 1000);
});

test('출석은 하루 한 번', () => {
  const s = game.createState();
  const now = Date.UTC(2026, 0, 1, 3);
  game.claimDaily(s, 'g', 'u', now);
  assert.throws(() => game.claimDaily(s, 'g', 'u', now + 1000), game.GameError);
  game.claimDaily(s, 'g', 'u', now + 86400000);
  assert.strictEqual(game.getUser(s, 'g', 'u').cash, game.START_CASH + 2 * game.DAILY_BONUS);
});

test('파산은 자산이 적을 때만 가능', () => {
  const s = game.createState();
  assert.throws(() => game.bankrupt(s, 'g', 'u'), game.GameError);
  game.getUser(s, 'g', 'u').cash = 500;
  assert.strictEqual(game.bankrupt(s, 'g', 'u').cash, game.START_CASH);
});

test('서버별로 계좌가 분리되고 랭킹이 정렬된다', () => {
  const s = game.createState();
  game.getUser(s, 'g1', 'a').cash = 10;
  game.getUser(s, 'g1', 'b').cash = 20;
  game.getUser(s, 'g2', 'a');
  const r = game.ranking(s, 'g1');
  assert.deepStrictEqual(r.map((x) => x.userId), ['b', 'a']);
  assert.strictEqual(game.getUser(s, 'g2', 'a').cash, game.START_CASH);
});

test('시세는 장시간 틱 후에도 양수이고 기준가에서 크게 벗어나지 않는다', () => {
  const s = game.createState(0);
  const rng = seeded();
  for (let i = 0; i < 20000; i++) tick(s.market, rng, i * 60000);
  for (const st of STOCKS) {
    const p = s.market.stocks[st.symbol].price;
    assert.ok(p >= 100, `${st.symbol} ${p}`);
    assert.ok(p < st.base * 20 && p > st.base / 20, `${st.symbol} ${p} vs ${st.base}`);
    assert.ok(s.market.stocks[st.symbol].history.length <= 120);
  }
});

test('KST 날짜가 바뀌면 시가가 갱신된다', () => {
  const start = Date.UTC(2026, 0, 1, 14, 59); // KST 23:59
  const s = game.createState(start);
  tick(s.market, seeded(), start + 120000); // KST 다음날 00:01
  assert.strictEqual(s.market.dayKey, kstDayKey(start + 120000));
  const st = s.market.stocks.DCE;
  assert.strictEqual(st.open, st.prevPrice);
});
