// 게임 규칙 — 계좌, 매수/매도, 출석 보상, 랭킹 (디스코드와 무관한 순수 로직)

const { STOCKS, createMarket, syncMarket, kstDayKey } = require('./market');

const START_CASH = 1_000_000;
const FEE_RATE = 0.0015;     // 거래 수수료 0.15%
const DAILY_BONUS = 50_000;
const BANKRUPT_LIMIT = 10_000; // 총자산이 이보다 적으면 파산 신청 가능

class GameError extends Error {}

function createState(now = Date.now()) {
  return { version: 2, market: createMarket(now), users: {}, guilds: {} };
}

function normalizeState(state) {
  if (!state || !state.market) return createState();
  syncMarket(state.market);
  state.guilds = state.guilds || {};
  state.users = state.users || {};
  migrateGuildAccounts(state);
  state.version = 2;
  return state;
}

// v1(서버별 계좌) → v2(모든 서버 공용 계좌). 여러 서버에 계좌가 있으면 총자산이 가장 큰 계좌를 남긴다.
function migrateGuildAccounts(state) {
  for (const [guildId, g] of Object.entries(state.guilds)) {
    if (!g.users) continue;
    for (const [userId, acc] of Object.entries(g.users)) {
      const cur = state.users[userId];
      const guilds = new Set([...(cur?.guilds || []), guildId]);
      const keep = !cur || portfolioValue(state, acc).total > portfolioValue(state, cur).total ? acc : cur;
      state.users[userId] = { ...keep, guilds: [...guilds] };
    }
    delete g.users;
  }
}

function getGuild(state, guildId) {
  if (!state.guilds[guildId]) state.guilds[guildId] = { newsChannelId: null };
  return state.guilds[guildId];
}

// 계좌를 가져오고(없으면 개설), guildId가 주어지면 그 서버에서 활동했다고 기록한다
function getUser(state, userId, guildId = null, now = Date.now()) {
  if (!state.users[userId]) {
    state.users[userId] = {
      cash: START_CASH, holdings: {}, realized: 0, lastDaily: null, createdAt: now, guilds: [],
    };
  }
  const user = state.users[userId];
  if (!user.guilds) user.guilds = [];
  if (guildId && !user.guilds.includes(guildId)) user.guilds.push(guildId);
  return user;
}

function price(state, symbol) {
  return state.market.stocks[symbol].price;
}

function fee(amount) {
  return Math.ceil(amount * FEE_RATE);
}

function portfolioValue(state, user) {
  let stock = 0;
  for (const [sym, h] of Object.entries(user.holdings)) stock += h.qty * price(state, sym);
  return { cash: user.cash, stock, total: user.cash + stock };
}

// "10", "전부", "절반" 등을 수량으로 변환. maxQty는 가능한 최대 수량
function parseQuantity(input, maxQty) {
  const s = String(input).trim().toLowerCase().replace(/,/g, '').replace(/주$/, '');
  if (['전부', '전량', '올인', 'all', 'max', '풀매수', '풀매도'].includes(s)) return maxQty;
  if (['절반', '반', 'half'].includes(s)) return Math.floor(maxQty / 2);
  const pctMatch = s.match(/^(\d+(?:\.\d+)?)%$/);
  if (pctMatch) return Math.floor((maxQty * Math.min(100, Number(pctMatch[1]))) / 100);
  if (!/^\d+$/.test(s)) throw new GameError('수량은 숫자, `전부`, `절반`, `50%` 형식으로 입력해 주세요.');
  return Number(s);
}

function maxBuyable(cash, p) {
  let q = Math.floor(cash / (p * (1 + FEE_RATE)));
  while (q > 0 && q * p + fee(q * p) > cash) q--;
  return q;
}

function buy(state, userId, guildId, symbol, qtyInput) {
  if (!state.market.stocks[symbol]) throw new GameError('존재하지 않는 종목입니다.');
  const user = getUser(state, userId, guildId);
  const p = price(state, symbol);
  const qty = parseQuantity(qtyInput, maxBuyable(user.cash, p));
  if (qty <= 0) throw new GameError('매수할 수 있는 수량이 없습니다. 잔고를 확인해 주세요.');
  const cost = qty * p;
  const f = fee(cost);
  if (cost + f > user.cash) {
    throw new GameError(`잔고가 부족합니다. 필요: ${won(cost + f)} / 보유: ${won(user.cash)}`);
  }
  const h = user.holdings[symbol] || { qty: 0, avgPrice: 0 };
  h.avgPrice = (h.avgPrice * h.qty + cost) / (h.qty + qty);
  h.qty += qty;
  user.holdings[symbol] = h;
  user.cash -= cost + f;
  return { symbol, qty, price: p, cost, fee: f, cash: user.cash, holding: { ...h } };
}

function sell(state, userId, guildId, symbol, qtyInput) {
  if (!state.market.stocks[symbol]) throw new GameError('존재하지 않는 종목입니다.');
  const user = getUser(state, userId, guildId);
  const h = user.holdings[symbol];
  if (!h || h.qty <= 0) throw new GameError('보유하지 않은 종목입니다.');
  const qty = parseQuantity(qtyInput, h.qty);
  if (qty <= 0) throw new GameError('매도할 수량이 없습니다.');
  if (qty > h.qty) throw new GameError(`보유 수량(${h.qty}주)보다 많이 팔 수 없습니다.`);
  const p = price(state, symbol);
  const revenue = qty * p;
  const f = fee(revenue);
  const profit = revenue - f - h.avgPrice * qty;
  user.cash += revenue - f;
  user.realized += profit;
  h.qty -= qty;
  if (h.qty === 0) delete user.holdings[symbol];
  return { symbol, qty, price: p, revenue, fee: f, profit, cash: user.cash, remaining: h.qty };
}

function claimDaily(state, userId, guildId, now = Date.now()) {
  const user = getUser(state, userId, guildId, now);
  const today = kstDayKey(now);
  if (user.lastDaily === today) throw new GameError('오늘은 이미 출석했습니다. 내일 다시 와 주세요! (자정 KST 초기화)');
  user.lastDaily = today;
  user.cash += DAILY_BONUS;
  return { bonus: DAILY_BONUS, cash: user.cash };
}

function bankrupt(state, userId, guildId, now = Date.now()) {
  const user = getUser(state, userId, guildId, now);
  const { total } = portfolioValue(state, user);
  if (total >= BANKRUPT_LIMIT) {
    throw new GameError(`총자산이 ${won(BANKRUPT_LIMIT)} 미만일 때만 파산 신청이 가능합니다. (현재 ${won(total)})`);
  }
  const bankruptcies = (user.bankruptcies || 0) + 1;
  state.users[userId] = {
    cash: START_CASH, holdings: {}, realized: 0, lastDaily: user.lastDaily, createdAt: now, bankruptcies,
    guilds: user.guilds,
  };
  return { cash: START_CASH, bankruptcies };
}

// guildId를 주면 그 서버에서 활동한 사람만, 없으면 전체 순위
function ranking(state, guildId = null, limit = 10) {
  return Object.entries(state.users)
    .filter(([, u]) => !guildId || (u.guilds || []).includes(guildId))
    .map(([userId, u]) => ({ userId, ...portfolioValue(state, u) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

function won(n) {
  return `${Math.round(n).toLocaleString('ko-KR')}원`;
}

module.exports = {
  START_CASH, FEE_RATE, DAILY_BONUS, BANKRUPT_LIMIT, STOCKS,
  GameError, createState, normalizeState, getGuild, getUser, portfolioValue,
  parseQuantity, maxBuyable, buy, sell, claimDaily, bankrupt, ranking, won,
};
