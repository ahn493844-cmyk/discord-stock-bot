// 게임 규칙 — 계좌, 현물(현금·신용·미수), 선물(레버리지 롱/숏), 옵션(콜/풋), 반대매매·청산
// 디스코드와 무관한 순수 로직

const { ASSETS, findAsset, unitOf } = require('./assets');
const { createMarket, syncMarket, price: marketPrice, kstDayKey } = require('./market');
const { optionPrice, intrinsic, YEAR_MS } = require('./options');
const life = require('./life');

const START_CASH = 1_000_000;    // 출신 제도 이전 계좌의 기준 시작 자금
const FEE_RATE = 0.0015;          // 현물·옵션 수수료 0.15%
const FUTURES_FEE_RATE = 0.0005;  // 선물 수수료 0.05% (명목금액 기준)
const BANKRUPT_LIMIT = 10_000;

const CREDIT_MARGIN = 0.5;        // 신용매수: 본인 돈 50%, 나머지 대출
const CREDIT_RATE = 0.09;         // 신용 이자 연 9%
const MISU_MARGIN = 0.4;          // 미수매수: 증거금 40%, 나머지는 2일 안에 갚아야 함
const MISU_DAYS = 2;
const LOAN_LIMIT_RATIO = 1.5;     // 대출 한도 = 순자산 × 1.5
const MAINTENANCE_RATIO = 1.4;    // 담보유지비율 140% 미만이면 반대매매
const MAX_LEVERAGE = 50;
const LIQUIDATION_LOSS = 0.9;     // 선물 손실이 증거금의 90%에 닿으면 강제청산
const MIN_FUTURES_MARGIN = 1000;

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const OPTION_EXPIRIES = {
  '1h': { label: '1시간', ms: HOUR_MS },
  '1d': { label: '1일', ms: DAY_MS },
  '1w': { label: '1주', ms: 7 * DAY_MS },
};

class GameError extends Error {}

// ── 상태 ─────────────────────────────────────────────────────

function createState(now = Date.now()) {
  return { version: 3, market: createMarket(now), users: {}, guilds: {}, lastRiskAt: now };
}

// 출신·직업 뽑기 (테스트에서 고정값으로 바꿀 수 있게 분리)
let rollLife = () => life.rollLife(Math.random);
function setLifeRoller(fn) {
  rollLife = fn;
}

// 새 계좌: 출신·직업을 뽑아 시작 자금을 정한다. extra로 일부를 지정할 수 있다
function newAccount(now, extra = {}) {
  const rolled = extra.origin ? {} : rollLife();
  const acc = {
    holdings: {}, loans: [], futures: [], options: [], nextId: 1,
    realized: 0, lastDaily: null, createdAt: now, guilds: [],
    lastRebirthAt: now, rebirths: 0,
    ...rolled, ...extra,
  };
  if (acc.cash == null) acc.cash = acc.startCash;
  return acc;
}

function startCashOf(user) {
  return (user && user.startCash) || START_CASH;
}

function ensureAccountFields(u) {
  // 출신·직업 제도 이전 계좌: 자산은 그대로, 출신은 '1세대 투자자', 직업만 새로 뽑고 바로 환생 가능
  if (!u.origin) {
    u.origin = life.LEGACY_ORIGIN.key;
    u.startCash = u.startCash || START_CASH;
    u.job = u.job || rollLife().job;
    u.lastRebirthAt = null;
    u.rebirths = u.rebirths || 0;
  }
  u.holdings = u.holdings || {};
  u.loans = u.loans || [];
  u.futures = u.futures || [];
  u.options = u.options || [];
  u.nextId = u.nextId || 1;
  u.guilds = u.guilds || [];
  u.realized = u.realized || 0;
  return u;
}

// 서버별 계좌(v1)를 공용 계좌로 합친다. 여러 개면 valueOf가 가장 큰 계좌를 남긴다.
function mergeGuildAccounts(state, valueOf) {
  for (const [guildId, g] of Object.entries(state.guilds)) {
    if (!g.users) continue;
    for (const [userId, acc] of Object.entries(g.users)) {
      const cur = state.users[userId];
      const guilds = new Set([...(cur?.guilds || []), guildId]);
      const keep = !cur || valueOf(acc) > valueOf(cur) ? acc : cur;
      state.users[userId] = { ...keep, guilds: [...guilds] };
    }
    delete g.users;
  }
}

function normalizeState(state, now = Date.now()) {
  if (!state || !state.market) return createState(now);
  state.guilds = state.guilds || {};
  state.users = state.users || {};

  if (state.market.stocks) {
    // 가상 종목 시절 데이터: 보유 주식을 마지막 가격으로 현금 정산하고 실제 시장으로 교체
    const old = state.market.stocks;
    const legacyValue = (acc) => acc.cash +
      Object.entries(acc.holdings || {}).reduce((s, [sym, h]) => s + h.qty * (old[sym]?.price || 0), 0);
    mergeGuildAccounts(state, legacyValue);
    for (const u of Object.values(state.users)) {
      u.cash = Math.round(legacyValue(u));
      u.holdings = {};
    }
    state.market = createMarket(now);
  } else {
    syncMarket(state.market);
    mergeGuildAccounts(state, (acc) => acc.cash);
  }

  for (const u of Object.values(state.users)) ensureAccountFields(u);
  state.version = 3;
  state.lastRiskAt = state.lastRiskAt || now;
  return state;
}

function getGuild(state, guildId) {
  if (!state.guilds[guildId]) state.guilds[guildId] = {};
  return state.guilds[guildId];
}

// 계좌를 가져오고(없으면 개설), guildId가 주어지면 그 서버에서 활동했다고 기록한다
function getUser(state, userId, guildId = null, now = Date.now()) {
  if (!state.users[userId]) state.users[userId] = newAccount(now);
  const user = ensureAccountFields(state.users[userId]);
  if (guildId && !user.guilds.includes(guildId)) user.guilds.push(guildId);
  return user;
}

// ── 공통 도우미 ──────────────────────────────────────────────

function won(n) {
  const v = Number(n) || 0;
  const digits = Math.abs(v) < 100 && !Number.isInteger(v) ? 2 : 0;
  return `${v.toLocaleString('ko-KR', { maximumFractionDigits: digits, minimumFractionDigits: 0 })}원`;
}

function fmtQty(asset, q) {
  return `${Number(q).toLocaleString('ko-KR', { maximumFractionDigits: asset?.decimals || 0 })}${unitOf(asset)}`;
}

function assetOrThrow(id) {
  const a = findAsset(id);
  if (!a) throw new GameError('존재하지 않는 종목입니다. 목록에서 골라 주세요.');
  return a;
}

function priceOrThrow(state, id) {
  const p = marketPrice(state.market, id);
  if (p == null) throw new GameError('아직 시세를 받아오는 중이에요. 잠시 후 다시 시도해 주세요.');
  return p;
}

// 24시간 거래: 시세만 있으면 거래 가능. 장이 닫힌 상품은 마지막 종가로 체결된다
function requireOpen(state, asset) {
  priceOrThrow(state, asset.id);
}

function roundQty(asset, q) {
  const f = 10 ** (asset.decimals || 0);
  return Math.floor(q * f + 1e-9) / f;
}

function fee(amount, rate = FEE_RATE) {
  return Math.ceil(amount * rate);
}

// "5만", "120,000원", "1.5억" → 숫자. 해당 형식이 아니면 null
function parseWon(s) {
  const m = String(s).trim().replace(/,/g, '').match(/^(\d+(?:\.\d+)?)\s*(억|만|천)?\s*원?$/);
  if (!m) return null;
  const unit = { 억: 1e8, 만: 1e4, 천: 1e3 }[m[2]] || 1;
  return Number(m[1]) * unit;
}

function parseRatio(s, max) {
  const t = String(s).trim().toLowerCase();
  if (['전부', '전량', '올인', 'all', 'max', '풀매수', '풀매도'].includes(t)) return max;
  if (['절반', '반', 'half'].includes(t)) return max / 2;
  const pct = t.match(/^(\d+(?:\.\d+)?)%$/);
  if (pct) return (max * Math.min(100, Number(pct[1]))) / 100;
  return null;
}

// 수량 입력: "10", "0.5", "전부", "절반", "30%", "10만원"(금액만큼)
function parseQuantity(input, { max, asset, price }) {
  const s = String(input).trim().replace(/,/g, '').replace(/(주|개|g|달러|유로)$/, '');
  const r = parseRatio(s, max);
  if (r != null) return roundQty(asset, r);
  if (/[원만억천]$/.test(s)) {
    const amount = parseWon(s);
    if (amount == null) throw new GameError('금액 형식이 올바르지 않아요. 예: `10만원`, `50000원`');
    return roundQty(asset, amount / price);
  }
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new GameError('수량은 `10`, `0.5`, `전부`, `절반`, `30%`, `10만원` 형식으로 입력해 주세요.');
  }
  const q = Number(s);
  if (!asset.decimals && !Number.isInteger(q)) throw new GameError(`${asset.name}은(는) 1${unitOf(asset)} 단위로만 거래돼요.`);
  return roundQty(asset, q);
}

// 금액 입력: "50000", "5만", "전부", "절반", "30%"
function parseAmount(input, max) {
  const r = parseRatio(input, max);
  if (r != null) return Math.floor(r);
  const v = parseWon(input);
  if (v == null) throw new GameError('금액은 `50000`, `5만`, `전부`, `절반`, `30%` 형식으로 입력해 주세요.');
  return Math.floor(v);
}

// ── 평가 ─────────────────────────────────────────────────────

function priceOr(state, id, fallback) {
  const p = marketPrice(state.market, id);
  return p == null ? fallback : p;
}

function futuresPnl(pos, p) {
  return pos.side * (p - pos.entry) * pos.qty;
}

function futuresEquity(state, pos) {
  return Math.max(0, pos.margin + futuresPnl(pos, priceOr(state, pos.asset, pos.entry)));
}

function liquidationPrice(pos) {
  return pos.entry * (1 - (pos.side * LIQUIDATION_LOSS) / pos.leverage);
}

function optionValue(state, opt, now = Date.now()) {
  const a = findAsset(opt.asset);
  const s = marketPrice(state.market, opt.asset);
  if (s == null || !a) return opt.premium * opt.qty;
  return optionPrice(opt.kind, s, opt.strike, opt.expiry - now, a.vol) * opt.qty;
}

function loanTotal(user) {
  return user.loans.reduce((s, l) => s + l.amount, 0);
}

function portfolioValue(state, user, now = Date.now()) {
  ensureAccountFields(user);
  let stock = 0;
  for (const [id, h] of Object.entries(user.holdings)) stock += h.qty * priceOr(state, id, h.avgPrice);
  const futures = user.futures.reduce((s, p) => s + futuresEquity(state, p), 0);
  const options = user.options.reduce((s, o) => s + optionValue(state, o, now), 0);
  const loans = loanTotal(user);
  const assets = user.cash + stock + futures + options;
  return { cash: user.cash, stock, futures, options, loans, assets, total: assets - loans };
}

// ── 대출 ─────────────────────────────────────────────────────

// 현금으로 대출을 갚는다 (미수 먼저, 그다음 오래된 신용 순). 갚은 금액 반환
function repayLoans(user, maxAmount = Infinity) {
  let budget = Math.min(maxAmount, Math.max(0, user.cash));
  let paid = 0;
  const order = [...user.loans].sort((a, b) =>
    (a.type === 'misu' ? 0 : 1) - (b.type === 'misu' ? 0 : 1) || a.createdAt - b.createdAt);
  for (const loan of order) {
    if (budget <= 0) break;
    const pay = Math.min(budget, loan.amount);
    loan.amount -= pay;
    budget -= pay;
    paid += pay;
  }
  user.cash -= paid;
  user.loans = user.loans.filter((l) => l.amount > 0.5);
  return paid;
}

function repay(state, userId, guildId, input = '전부') {
  const user = getUser(state, userId, guildId);
  const total = loanTotal(user);
  if (total <= 0) throw new GameError('갚을 대출이 없어요.');
  const max = Math.min(user.cash, total);
  if (max <= 0) throw new GameError('갚을 현금이 없어요.');
  const amount = Math.min(parseAmount(input, max), max);
  if (amount <= 0) throw new GameError('상환할 금액이 없어요.');
  const paid = repayLoans(user, amount);
  return { paid, remaining: loanTotal(user), cash: user.cash };
}

// ── 현물 ─────────────────────────────────────────────────────

const BUY_MODES = { cash: 1, credit: CREDIT_MARGIN, misu: MISU_MARGIN };

// 이 방식으로 지금 살 수 있는 최대 수량과 남은 대출 한도
function buyLimits(state, user, asset, mode, now = Date.now()) {
  const m = BUY_MODES[mode];
  const p = marketPrice(state.market, asset.id);
  if (m == null || p == null) return { max: 0, loanRoom: 0, price: p };
  let loanRoom = Infinity;
  if (mode !== 'cash') {
    const { total } = portfolioValue(state, user, now);
    loanRoom = Math.max(0, total * LOAN_LIMIT_RATIO - loanTotal(user));
  }
  const maxByCash = user.cash / (p * (m + FEE_RATE));
  const maxByLoan = m < 1 ? loanRoom / ((1 - m) * p) : Infinity;
  let max = roundQty(asset, Math.max(0, Math.min(maxByCash, maxByLoan)));
  // 수수료 올림 때문에 한 단위 넘칠 수 있어 줄여 준다
  const step = 1 / 10 ** (asset.decimals || 0);
  while (max > 0 && max * p * (m + FEE_RATE) + 1 > user.cash) max = roundQty(asset, max - step);
  return { max, loanRoom, price: p };
}

function buy(state, userId, guildId, id, qtyInput, mode = 'cash', now = Date.now()) {
  const asset = assetOrThrow(id);
  const m = BUY_MODES[mode];
  if (m == null) throw new GameError('알 수 없는 매수 방식이에요.');
  requireOpen(state, asset, now);
  const user = getUser(state, userId, guildId, now);
  const p = priceOrThrow(state, asset.id);
  const { max, loanRoom } = buyLimits(state, user, asset, mode, now);

  const qty = parseQuantity(qtyInput, { max, asset, price: p });
  if (qty <= 0) throw new GameError('매수할 수 있는 수량이 없어요. 잔고나 대출 한도를 확인해 주세요.');
  const cost = qty * p;
  const f = fee(cost);
  const loanAmt = cost * (1 - m);
  const cashNeed = cost - loanAmt + f;
  if (cashNeed > user.cash + 1e-6) {
    throw new GameError(`잔고가 부족해요. 필요: ${won(cashNeed)} / 보유: ${won(user.cash)}`);
  }
  if (loanAmt > loanRoom + 1e-6) {
    throw new GameError(`대출 한도를 넘어요. 남은 한도: ${won(loanRoom)}`);
  }

  const h = user.holdings[asset.id] || { qty: 0, avgPrice: 0 };
  h.avgPrice = (h.avgPrice * h.qty + cost) / (h.qty + qty);
  h.qty = roundQty(asset, h.qty + qty);
  user.holdings[asset.id] = h;
  user.cash -= cashNeed;
  let loan = null;
  if (loanAmt > 0) {
    loan = {
      id: user.nextId++, type: mode, amount: loanAmt, createdAt: now,
      dueAt: mode === 'misu' ? now + MISU_DAYS * DAY_MS : null,
    };
    user.loans.push(loan);
  }
  return { asset, qty, price: p, cost, fee: f, loan, mode, cash: user.cash, holding: { ...h } };
}

function sell(state, userId, guildId, id, qtyInput, now = Date.now()) {
  const asset = assetOrThrow(id);
  const user = getUser(state, userId, guildId, now);
  const h = user.holdings[asset.id];
  if (!h || h.qty <= 0) throw new GameError('보유하지 않은 종목이에요.');
  requireOpen(state, asset, now);
  const p = priceOrThrow(state, asset.id);
  const qty = parseQuantity(qtyInput, { max: h.qty, asset, price: p });
  if (qty <= 0) throw new GameError('매도할 수량이 없어요.');
  if (qty > h.qty + 1e-9) throw new GameError(`보유 수량(${fmtQty(asset, h.qty)})보다 많이 팔 수 없어요.`);
  return sellHolding(user, asset, qty, p);
}

function sellHolding(user, asset, qty, p) {
  const h = user.holdings[asset.id];
  const revenue = qty * p;
  const f = fee(revenue);
  const profit = revenue - f - h.avgPrice * qty;
  user.cash += revenue - f;
  user.realized += profit;
  h.qty = roundQty(asset, h.qty - qty);
  if (h.qty <= 0) delete user.holdings[asset.id];
  const repaid = repayLoans(user, revenue - f); // 판 돈으로 대출부터 갚는다
  return { asset, qty, price: p, revenue, fee: f, profit, repaid, cash: user.cash, remaining: Math.max(0, h.qty) };
}

// ── 선물 ─────────────────────────────────────────────────────

function openFuture(state, userId, guildId, id, side, marginInput, leverage, now = Date.now()) {
  const asset = assetOrThrow(id);
  requireOpen(state, asset, now);
  const lev = Math.floor(Number(leverage));
  if (!(lev >= 1 && lev <= MAX_LEVERAGE)) throw new GameError(`레버리지는 1~${MAX_LEVERAGE}배 사이로 정해 주세요.`);
  const dir = side === 'short' ? -1 : 1;
  const user = getUser(state, userId, guildId, now);
  const p = priceOrThrow(state, asset.id);
  const max = Math.floor(user.cash / (1 + lev * FUTURES_FEE_RATE));
  const margin = Math.min(parseAmount(marginInput, max), max);
  if (margin < MIN_FUTURES_MARGIN) throw new GameError(`증거금은 최소 ${won(MIN_FUTURES_MARGIN)} 이상이어야 해요.`);
  const notional = margin * lev;
  const f = fee(notional, FUTURES_FEE_RATE);
  if (margin + f > user.cash + 1e-6) throw new GameError(`잔고가 부족해요. 필요: ${won(margin + f)} / 보유: ${won(user.cash)}`);
  const pos = {
    id: user.nextId++, asset: asset.id, side: dir, qty: notional / p, entry: p, margin, leverage: lev, openedAt: now,
  };
  user.futures.push(pos);
  user.cash -= margin + f;
  return { asset, pos: { ...pos }, fee: f, liqPrice: liquidationPrice(pos), cash: user.cash };
}

function closeFuture(state, userId, guildId, posId, now = Date.now()) {
  const user = getUser(state, userId, guildId, now);
  const pos = user.futures.find((x) => String(x.id) === String(posId));
  if (!pos) throw new GameError('해당 선물 포지션이 없어요. `/포지션`으로 번호를 확인해 주세요.');
  const asset = assetOrThrow(pos.asset);
  requireOpen(state, asset, now);
  const p = priceOrThrow(state, asset.id);
  const pnl = futuresPnl(pos, p);
  const f = fee(pos.qty * p, FUTURES_FEE_RATE);
  const payout = Math.max(0, pos.margin + pnl - f);
  user.cash += payout;
  user.realized += payout - pos.margin;
  user.futures = user.futures.filter((x) => x !== pos);
  return { asset, pos, price: p, pnl, fee: f, payout, cash: user.cash };
}

// ── 옵션 ─────────────────────────────────────────────────────

// 깔끔한 행사가: 유효숫자 3자리로 반올림
function niceStrike(x) {
  if (!(x > 0)) return x;
  const mag = 10 ** (Math.floor(Math.log10(x)) - 2);
  return Math.round(x / mag) * mag;
}

function parseStrike(input, spot) {
  const s = String(input ?? '').trim().replace(/,/g, '');
  if (!s || ['현재가', 'atm', '등가'].includes(s.toLowerCase())) return niceStrike(spot);
  const pct = s.match(/^([+-]?\d+(?:\.\d+)?)%$/);
  if (pct) return niceStrike(spot * (1 + Number(pct[1]) / 100));
  const v = parseWon(s);
  if (v == null || v <= 0) throw new GameError('행사가는 `현재가`, `+5%`, `-10%`, `75000`, `7.5만` 형식으로 입력해 주세요.');
  return v;
}

function quoteOption(state, id, kind, strikeInput, expiryKey, now = Date.now()) {
  const asset = assetOrThrow(id);
  if (kind !== 'call' && kind !== 'put') throw new GameError('옵션 종류는 콜 또는 풋이에요.');
  const exp = OPTION_EXPIRIES[expiryKey];
  if (!exp) throw new GameError('만기는 1시간, 1일, 1주 중에서 골라 주세요.');
  const spot = priceOrThrow(state, asset.id);
  const strike = parseStrike(strikeInput, spot);
  const expiry = now + exp.ms;
  const premium = optionPrice(kind, spot, strike, exp.ms, asset.vol);
  return { asset, kind, spot, strike, expiry, expiryLabel: exp.label, premium };
}

function buyOption(state, userId, guildId, id, kind, strikeInput, expiryKey, qtyInput, now = Date.now()) {
  const q = quoteOption(state, id, kind, strikeInput, expiryKey, now);
  requireOpen(state, q.asset, now);
  if (q.premium < q.spot * 0.0001) throw new GameError('이 옵션은 가치가 거의 없어서 살 수 없어요. 행사가를 현재가에 더 가깝게 해 보세요.');
  const user = getUser(state, userId, guildId, now);
  const max = roundQty(q.asset, user.cash / (q.premium * (1 + FEE_RATE)));
  const qty = parseQuantity(qtyInput, { max, asset: q.asset, price: q.premium });
  if (qty <= 0) throw new GameError('살 수 있는 수량이 없어요.');
  const cost = q.premium * qty;
  const f = fee(cost);
  if (cost + f > user.cash + 1e-6) throw new GameError(`잔고가 부족해요. 필요: ${won(cost + f)} / 보유: ${won(user.cash)}`);
  const opt = {
    id: user.nextId++, asset: q.asset.id, kind, strike: q.strike, expiry: q.expiry, qty, premium: q.premium, openedAt: now,
  };
  user.options.push(opt);
  user.cash -= cost + f;
  return { ...q, opt: { ...opt }, qty, cost, fee: f, cash: user.cash };
}

function sellOption(state, userId, guildId, posId, now = Date.now()) {
  const user = getUser(state, userId, guildId, now);
  const opt = user.options.find((x) => String(x.id) === String(posId));
  if (!opt) throw new GameError('해당 옵션이 없어요. `/포지션`으로 번호를 확인해 주세요.');
  const asset = assetOrThrow(opt.asset);
  requireOpen(state, asset, now);
  const value = optionValue(state, opt, now);
  const f = fee(value);
  const payout = Math.max(0, value - f);
  user.cash += payout;
  user.realized += payout - opt.premium * opt.qty;
  user.options = user.options.filter((x) => x !== opt);
  return { asset, opt, value, fee: f, payout, cash: user.cash };
}

// ── 위험 관리 (틱마다 실행) ──────────────────────────────────

// 보유 현물을 평가액 큰 순서로 팔아 대출을 갚는다. done()이 true가 되면 멈춘다
function forceSell(state, user, done) {
  const sold = [];
  const items = Object.entries(user.holdings)
    .map(([id, h]) => ({ asset: findAsset(id), h, p: marketPrice(state.market, id) }))
    .filter((x) => x.asset && x.p != null)
    .sort((a, b) => b.h.qty * b.p - a.h.qty * a.p);
  for (const x of items) {
    if (done()) break;
    const r = sellHolding(user, x.asset, x.h.qty, x.p);
    repayLoans(user);
    sold.push(`${x.asset.name} ${fmtQty(x.asset, r.qty)}`);
  }
  return sold;
}

function processRisk(state, now = Date.now()) {
  const events = [];
  const dt = Math.max(0, now - (state.lastRiskAt || now));
  state.lastRiskAt = now;

  for (const [userId, user] of Object.entries(state.users)) {
    ensureAccountFields(user);
    const say = (text) => events.push({ userId, text });

    // 1) 신용 이자
    for (const l of user.loans) if (l.type === 'credit') l.amount *= 1 + (CREDIT_RATE * dt) / YEAR_MS;

    // 2) 옵션 만기 정산
    for (const opt of [...user.options]) {
      if (now < opt.expiry) continue;
      const s = marketPrice(state.market, opt.asset);
      if (s == null) continue;
      const a = findAsset(opt.asset);
      const payoff = intrinsic(opt.kind, s, opt.strike) * opt.qty;
      user.cash += payoff;
      user.realized += payoff - opt.premium * opt.qty;
      user.options = user.options.filter((x) => x !== opt);
      say(`⏰ 옵션 #${opt.id} 만기: ${a ? a.name : opt.asset} ${opt.kind === 'call' ? '콜' : '풋'} ` +
        `행사가 ${won(opt.strike)} · 만기가 ${won(s)} → ${payoff > 0 ? `**${won(payoff)}** 지급` : '가치 없이 소멸'}`);
    }

    // 3) 선물 강제청산
    for (const pos of [...user.futures]) {
      const p = marketPrice(state.market, pos.asset);
      if (p == null) continue;
      const pnl = futuresPnl(pos, p);
      if (pnl > -pos.margin * LIQUIDATION_LOSS) continue;
      const payout = Math.max(0, pos.margin + pnl);
      user.cash += payout;
      user.realized += payout - pos.margin;
      user.futures = user.futures.filter((x) => x !== pos);
      const a = findAsset(pos.asset);
      say(`💥 선물 #${pos.id} 강제청산: ${a ? a.name : pos.asset} ${pos.side > 0 ? '롱' : '숏'} ${pos.leverage}배 · ` +
        `진입가 ${won(pos.entry)} → ${won(p)} · 증거금 ${won(pos.margin)} 중 ${won(payout)} 반환`);
    }

    // 4) 미수 만기: 현금으로 갚고, 모자라면 반대매매, 그래도 남으면 신용으로 전환
    const due = user.loans.filter((l) => l.type === 'misu' && l.dueAt <= now);
    if (due.length) {
      const dueTotal = due.reduce((s, l) => s + l.amount, 0);
      const misuLeft = () => user.loans.filter((l) => l.type === 'misu' && l.dueAt <= now).reduce((s, l) => s + l.amount, 0);
      repayLoans(user);
      const sold = misuLeft() > 0 ? forceSell(state, user, () => misuLeft() <= 0) : [];
      for (const l of user.loans) if (l.type === 'misu' && l.dueAt <= now) { l.type = 'credit'; l.dueAt = null; }
      const left = loanTotal(user);
      say(`📅 미수 ${won(dueTotal)} 결제일 도래 → ` +
        (sold.length ? `현금 부족으로 **반대매매**: ${sold.join(', ')}` : '현금으로 상환 완료') +
        (left > 0 ? ` · 남은 대출 ${won(left)}` : ''));
    }

    // 5) 담보유지비율 확인 → 반대매매
    if (loanTotal(user) > 0) {
      const ratio = () => {
        const v = portfolioValue(state, user, now);
        return v.loans > 0 ? v.assets / v.loans : Infinity;
      };
      const before = ratio();
      if (before < MAINTENANCE_RATIO) {
        const paid = repayLoans(user);
        const sold = ratio() < MAINTENANCE_RATIO ? forceSell(state, user, () => ratio() >= MAINTENANCE_RATIO) : [];
        // 팔 것도 갚을 현금도 없으면 매 틱 같은 알림을 보내지 않는다
        if (paid > 0 || sold.length) {
          say(`⚠️ 담보비율 ${(before * 100).toFixed(0)}% (기준 ${MAINTENANCE_RATIO * 100}%) 미달 → ` +
            `${sold.length ? `**반대매매**: ${sold.join(', ')}` : `현금으로 대출 ${won(paid)} 상환`} · 남은 대출 ${won(loanTotal(user))}`);
        }
      }
    }
  }
  return events;
}

// ── 미리보기 ─────────────────────────────────────────────────

// 계좌 복사본으로 동작을 미리 실행해 본다. 실제 계좌는 바뀌지 않는다.
// 반환: { result, before, after } 또는 { error }
function simulate(state, userId, fn, now = Date.now()) {
  const real = state.users[userId] ? ensureAccountFields(state.users[userId]) : newAccount(now);
  const copy = structuredClone(real);
  const sim = { market: state.market, users: { [userId]: copy }, guilds: {}, lastRiskAt: state.lastRiskAt };
  try {
    const result = fn(sim);
    return {
      result,
      before: { account: real, value: portfolioValue(state, real, now) },
      after: { account: sim.users[userId], value: portfolioValue(sim, sim.users[userId], now) },
    };
  } catch (err) {
    if (err instanceof GameError) return { error: err.message };
    throw err;
  }
}

function maxFuturesMargin(user, leverage) {
  return Math.max(0, Math.floor(user.cash / (1 + leverage * FUTURES_FEE_RATE)));
}

function maxOptionQty(user, asset, premium) {
  if (!(premium > 0)) return 0;
  let q = roundQty(asset, user.cash / (premium * (1 + FEE_RATE)));
  const step = 1 / 10 ** (asset.decimals || 0);
  while (q > 0 && q * premium + fee(q * premium) > user.cash) q = roundQty(asset, q - step);
  return q;
}

// ── 기타 ─────────────────────────────────────────────────────

function claimDaily(state, userId, guildId, now = Date.now()) {
  const user = getUser(state, userId, guildId, now);
  const today = kstDayKey(now);
  if (user.lastDaily === today) throw new GameError('오늘은 이미 출석했어요. 내일 다시 와 주세요! (자정 KST 초기화)');
  const job = life.jobOf(user.job);
  user.lastDaily = today;
  user.cash += job.pay;
  return { bonus: job.pay, job, cash: user.cash };
}

function bankrupt(state, userId, guildId, now = Date.now()) {
  const user = getUser(state, userId, guildId, now);
  const { total } = portfolioValue(state, user, now);
  if (total >= BANKRUPT_LIMIT) {
    throw new GameError(`순자산이 ${won(BANKRUPT_LIMIT)} 미만일 때만 파산 신청이 가능해요. (현재 ${won(total)})`);
  }
  // 파산: 출신·직업은 그대로, 처음 시작 자금으로 다시
  const bankruptcies = (user.bankruptcies || 0) + 1;
  const keep = {
    origin: user.origin, job: user.job, startCash: startCashOf(user), lastDaily: user.lastDaily, bankruptcies,
    guilds: user.guilds, lastRebirthAt: user.lastRebirthAt, rebirths: user.rebirths || 0,
  };
  state.users[userId] = newAccount(now, keep);
  return { cash: keep.startCash, bankruptcies };
}

// ── 환생 ─────────────────────────────────────────────────────

function rebirthStatus(user, now = Date.now()) {
  const readyAt = user.lastRebirthAt ? user.lastRebirthAt + life.REBIRTH_COOLDOWN_MS : 0;
  return { ready: now >= readyAt, readyAt };
}

// 모든 자산·포지션·대출을 없애고 출신·직업·시작 자금을 다시 뽑는다
function rebirth(state, userId, guildId, now = Date.now()) {
  const user = getUser(state, userId, guildId, now);
  const st = rebirthStatus(user, now);
  if (!st.ready) {
    throw new GameError(`환생은 24시간에 한 번만 할 수 있어요. <t:${Math.floor(st.readyAt / 1000)}:R>에 다시 할 수 있어요.`);
  }
  const before = { origin: user.origin, job: user.job, startCash: startCashOf(user), total: portfolioValue(state, user, now).total };
  const next = newAccount(now, { lastDaily: user.lastDaily, guilds: user.guilds, rebirths: (user.rebirths || 0) + 1 });
  // newAccount는 extra.origin이 없으면 새로 뽑는다 (위에서 origin을 넘기지 않음)
  state.users[userId] = next;
  return { before, after: next };
}

// guildId를 주면 그 서버에서 활동한 사람만, 없으면 전체 순위
function ranking(state, guildId = null, limit = 10, now = Date.now()) {
  return Object.entries(state.users)
    .filter(([, u]) => !guildId || (u.guilds || []).includes(guildId))
    .map(([userId, u]) => ({ userId, ...portfolioValue(state, u, now) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

module.exports = {
  START_CASH, FEE_RATE, FUTURES_FEE_RATE, BANKRUPT_LIMIT, CREDIT_MARGIN, CREDIT_RATE,
  MISU_MARGIN, MISU_DAYS, LOAN_LIMIT_RATIO, MAINTENANCE_RATIO, MAX_LEVERAGE, LIQUIDATION_LOSS,
  OPTION_EXPIRIES, ASSETS, BUY_MODES,
  GameError, createState, normalizeState, getGuild, getUser, portfolioValue, loanTotal,
  futuresPnl, futuresEquity, liquidationPrice, optionValue,
  parseQuantity, parseAmount, parseStrike, parseWon, buy, sell, repay, openFuture, closeFuture,
  quoteOption, buyOption, sellOption, processRisk, claimDaily, bankrupt, ranking, won, fmtQty,
  buyLimits, simulate, maxFuturesMargin, maxOptionQty, roundQty, fee,
  newAccount, startCashOf, setLifeRoller, rebirth, rebirthStatus,
};
