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
  assert.strictEqual(game.getUser(s, 'u', 'g').cash, game.START_CASH);
});

test('매수 후 매도하면 수수료만큼 손해', () => {
  const s = game.createState();
  const b = game.buy(s, 'u', 'g', 'DCE', '10');
  assert.strictEqual(b.qty, 10);
  const r = game.sell(s, 'u', 'g', 'DCE', '전부');
  assert.strictEqual(r.qty, 10);
  const u = game.getUser(s, 'u', 'g');
  assert.strictEqual(u.cash, game.START_CASH - b.fee - r.fee);
  assert.deepStrictEqual(u.holdings, {});
});

test('전부 매수는 잔고를 넘지 않는다', () => {
  const s = game.createState();
  const b = game.buy(s, 'u', 'g', 'HGC', '전부');
  assert.ok(b.cash >= 0);
  assert.throws(() => game.buy(s, 'u', 'g', 'HGC', '1'), game.GameError);
});

test('잔고 부족·미보유·잘못된 수량은 GameError', () => {
  const s = game.createState();
  assert.throws(() => game.buy(s, 'u', 'g', 'SPC', '1000'), game.GameError);
  assert.throws(() => game.sell(s, 'u', 'g', 'SPC', '1'), game.GameError);
  assert.throws(() => game.buy(s, 'u', 'g', 'SPC', 'abc'), game.GameError);
  assert.throws(() => game.buy(s, 'u', 'g', 'SPC', '0'), game.GameError);
});

test('수량 파싱', () => {
  assert.strictEqual(game.parseQuantity('절반', 11), 5);
  assert.strictEqual(game.parseQuantity('50%', 10), 5);
  assert.strictEqual(game.parseQuantity('1,000주', 5), 1000);
});

test('출석은 하루 한 번', () => {
  const s = game.createState();
  const now = Date.UTC(2026, 0, 1, 3);
  game.claimDaily(s, 'u', 'g', now);
  assert.throws(() => game.claimDaily(s, 'u', 'g', now + 1000), game.GameError);
  game.claimDaily(s, 'u', 'g', now + 86400000);
  assert.strictEqual(game.getUser(s, 'u', 'g').cash, game.START_CASH + 2 * game.DAILY_BONUS);
});

test('파산은 자산이 적을 때만 가능', () => {
  const s = game.createState();
  assert.throws(() => game.bankrupt(s, 'u', 'g'), game.GameError);
  game.getUser(s, 'u', 'g').cash = 500;
  assert.strictEqual(game.bankrupt(s, 'u', 'g').cash, game.START_CASH);
});

test('계좌는 모든 서버 공용이고, 랭킹은 전체/서버별로 볼 수 있다', () => {
  const s = game.createState();
  game.getUser(s, 'a', 'g1').cash = 10;
  game.getUser(s, 'b', 'g1').cash = 20;
  game.getUser(s, 'c', 'g2').cash = 30;
  assert.strictEqual(game.getUser(s, 'a', 'g2').cash, 10);
  assert.deepStrictEqual(game.ranking(s).map((x) => x.userId), ['c', 'b', 'a']);
  assert.deepStrictEqual(game.ranking(s, 'g1').map((x) => x.userId), ['b', 'a']);
  assert.deepStrictEqual(game.ranking(s, 'g2').map((x) => x.userId), ['c', 'a']);
});

test('예전 서버별 계좌 데이터는 공용 계좌로 옮겨진다 (총자산 큰 쪽 유지)', () => {
  const old = game.createState();
  delete old.users;
  old.version = 1;
  const acc = (cash) => ({ cash, holdings: {}, realized: 0, lastDaily: null, createdAt: 0 });
  old.guilds = {
    g1: { newsChannelId: 'ch1', users: { a: acc(500), b: acc(700) } },
    g2: { newsChannelId: null, users: { a: acc(900) } },
  };
  const s = game.normalizeState(old);
  assert.strictEqual(s.users.a.cash, 900);
  assert.deepStrictEqual(s.users.a.guilds.sort(), ['g1', 'g2']);
  assert.strictEqual(s.users.b.cash, 700);
  assert.strictEqual(s.guilds.g1.newsChannelId, 'ch1');
  assert.strictEqual(s.guilds.g1.users, undefined);
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
