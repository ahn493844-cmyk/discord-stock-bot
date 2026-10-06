// 주문창 — 버튼으로 수량을 고르면 결과를 미리 보여 주고, [실행]을 눌러야 체결된다.
// 주문 상태(종목·방식·수량 등)는 모두 버튼의 custom_id 안에 들어 있어서 서버에 따로 저장하지 않는다.

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ModalBuilder, LabelBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const game = require('./game');
const { findAsset, unitOf } = require('./assets');
const { quote } = require('./market');

const { won, fmtQty } = game;
const COLOR_BUY = 0xe03131;
const COLOR_SELL = 0x1c7ed6;
const COLOR_FUT = 0xf08c00;
const COLOR_OPT = 0x9c36b5;
const COLOR_OK = 0x2f9e44;
const COLOR_ERR = 0xc92a2a;
const MODE_LABEL = { cash: '현금', credit: '신용', misu: '미수' };
const MODE_DESC = {
  cash: '내 돈으로만 사요.',
  credit: `내 돈 ${game.CREDIT_MARGIN * 100}% + 대출 ${100 - game.CREDIT_MARGIN * 100}%. 대출에 연 ${game.CREDIT_RATE * 100}% 이자가 붙어요.`,
  misu: `내 돈 ${game.MISU_MARGIN * 100}%만 내고, 나머지는 ${game.MISU_DAYS}일 안에 갚아야 해요. 못 갚으면 반대매매돼요.`,
};
const LEVERAGES = [1, 2, 3, 5, 10, 20, 30, 50].filter((x) => x <= game.MAX_LEVERAGE);
const STRIKE_STEP = 5;
const STRIKE_LIMIT = 50;

const id = (...parts) => ['stk', ...parts].join('|');
const row = (...c) => new ActionRowBuilder().addComponents(...c);
const btn = (customId, label, style = ButtonStyle.Secondary, { emoji, disabled } = {}) => {
  const b = new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style);
  if (emoji) b.setEmoji(emoji);
  if (disabled) b.setDisabled(true);
  return b;
};

// ── 서식 ─────────────────────────────────────────────────────

function signedWon(n) {
  return `${n > 0 ? '+' : n < 0 ? '-' : ''}${won(Math.abs(n))}`;
}

function signedPct(p) {
  return `${p > 0 ? '+' : ''}${p.toFixed(2)}%`;
}

function rel(ms) {
  return `<t:${Math.floor(ms / 1000)}:R>`;
}

function arrow(before, after) {
  return before === after ? after : `${before} → **${after}**`;
}

// custom_id에 넣을 수량 문자열 (지수 표기 방지)
function qtyStr(asset, q) {
  return String(Number((Number(q) || 0).toFixed(asset.decimals || 0)));
}

// 버튼 한 번에 늘리고 줄일 수량: 1단위가 20만원 이하면 1·10단위,
// 비싼 소수 단위 상품(코인·지수선물 등)은 약 1만원·10만원어치를 1·2·5 단위로 반올림
function stepSizes(asset, unitCost) {
  if (!asset.decimals || unitCost <= 200000) return [1, 10];
  const minStep = 10 ** -asset.decimals;
  const nice = (x) => {
    if (!(x > 0) || !Number.isFinite(x)) return minStep;
    const mag = 10 ** Math.floor(Math.log10(x));
    const m = [1, 2, 5, 10].find((k) => k * mag >= x * 0.75) || 10;
    return Math.max(minStep, Number((m * mag).toFixed(asset.decimals)));
  };
  return [nice(10000 / unitCost), nice(100000 / unitCost)];
}

function fmtStep(asset, s) {
  return `${Number(s).toLocaleString('ko-KR', { maximumFractionDigits: asset.decimals || 0 })}${unitOf(asset)}`;
}

function noticeEmbed(notice) {
  return notice ? new EmbedBuilder().setColor(notice.error ? COLOR_ERR : COLOR_OK).setDescription(notice.text) : null;
}

function pack(notice, embed, components) {
  const n = noticeEmbed(notice);
  return { embeds: n ? [n, embed] : [embed], components };
}

// 수량 조절 버튼 두 줄: [−큰][−작은][+작은][+큰][직접 입력] / [비율…][초기화]
function qtyRows(asset, qty, steps, max, makeId, inputId, ratios = [0.1, 0.25, 0.5, 1]) {
  const [s, b] = steps;
  const set = (v, key) => makeId(qtyStr(asset, Math.max(0, game.roundQty(asset, v))), key);
  const stepRow = row(
    btn(set(qty - b, 'mb'), `-${fmtStep(asset, b)}`, ButtonStyle.Secondary, { disabled: qty <= 0 }),
    btn(set(qty - s, 'ms'), `-${fmtStep(asset, s)}`, ButtonStyle.Secondary, { disabled: qty <= 0 }),
    btn(set(qty + s, 'ps'), `+${fmtStep(asset, s)}`, ButtonStyle.Secondary),
    btn(set(qty + b, 'pb'), `+${fmtStep(asset, b)}`, ButtonStyle.Secondary),
    btn(inputId, '직접 입력', ButtonStyle.Primary, { emoji: '✏️' }),
  );
  const ratioRow = row(
    ...ratios.map((r, i) => btn(set(max * r, `r${i}`), r === 1 ? (ratios.length === 4 && ratios[2] === 0.75 ? '전부' : '최대') : `${r * 100}%`,
      ButtonStyle.Secondary, { disabled: max <= 0 })),
    btn(set(0, 'z'), '초기화', ButtonStyle.Secondary, { emoji: '🔄', disabled: qty <= 0 }),
  );
  return [stepRow, ratioRow];
}

function headerLine(state, asset, user) {
  const p = quote(state.market, asset.id)?.price;
  const cash = state.users[user.id]?.cash ?? game.START_CASH;
  return `현재가 **${p != null ? won(p) : '시세 준비 중'}** · 내 현금 **${won(cash)}**`;
}

function backBtn(asset) {
  return btn(id('a', asset.id, '1d'), '종목 화면', ButtonStyle.Secondary, { emoji: '⬅️' });
}

// ── 매수 주문창 ──────────────────────────────────────────────

function buyTicket(state, user, assetId, mode = 'cash', qtyIn = 0, now = Date.now(), notice = null) {
  const asset = findAsset(assetId);
  const m = game.BUY_MODES[mode] != null ? mode : 'cash';
  const acc = state.users[user.id] || game.getUser(state, user.id, null, now);
  const { max, loanRoom, price } = game.buyLimits(state, acc, asset, m, now);
  const qty = game.roundQty(asset, Math.max(0, Number(qtyIn) || 0));
  const e = new EmbedBuilder()
    .setColor(COLOR_BUY)
    .setTitle(`🛒 ${asset.name} 매수 주문`)
    .setDescription(`${headerLine(state, asset, user)}\n**${MODE_LABEL[m]}** 매수 · ${MODE_DESC[m]}\n` +
      `지금 최대 **${fmtQty(asset, max)}** 살 수 있어요${m !== 'cash' ? ` (남은 대출 한도 ${won(loanRoom)})` : ''}.`);

  let canRun = false;
  if (price == null) {
    e.addFields({ name: '⏳ 시세 준비 중', value: '잠시 후 다시 시도해 주세요.' });
  } else if (qty <= 0) {
    e.addFields({ name: '수량을 정해 주세요', value: '아래 버튼으로 수량을 고르면 결제 금액과 거래 후 모습을 미리 보여 드려요.' });
  } else {
    const sim = game.simulate(state, user.id, (s) => game.buy(s, user.id, null, asset.id, qtyStr(asset, qty), m, now), now);
    if (sim.error) {
      e.addFields({ name: `⚠️ ${fmtQty(asset, qty)} 주문 불가`, value: sim.error });
    } else {
      canRun = true;
      const r = sim.result;
      const hb = sim.before.account.holdings[asset.id];
      const ha = sim.after.account.holdings[asset.id];
      const myMoney = r.cost - (r.loan ? r.loan.amount : 0) + r.fee;
      e.addFields(
        { name: '📝 주문', value: `${fmtQty(asset, qty)} × ${won(price)}\n= **${won(r.cost)}**`, inline: true },
        { name: '💸 내 돈 지출', value: `**${won(myMoney)}**\n(수수료 ${won(r.fee)} 포함)`, inline: true },
        {
          name: '💳 대출',
          value: r.loan
            ? `**${won(r.loan.amount)}**\n${r.loan.type === 'misu' ? `결제일 ${rel(r.loan.dueAt)}` : `연 ${game.CREDIT_RATE * 100}% 이자`}`
            : '없음',
          inline: true,
        },
        {
          name: '📊 거래 후 모습',
          value: `현금: ${arrow(won(sim.before.value.cash), won(sim.after.value.cash))}\n` +
            `보유: ${arrow(fmtQty(asset, hb ? hb.qty : 0), fmtQty(asset, ha.qty))} (평단 ${won(ha.avgPrice)})\n` +
            `대출: ${arrow(won(sim.before.value.loans), won(sim.after.value.loans))}\n` +
            `순자산: ${arrow(won(sim.before.value.total), won(sim.after.value.total))} (수수료만큼 줄어요)`,
        },
        {
          name: '📈 가격이 움직이면',
          value: [10, -10].map((p) => `${signedPct(p)} → 이 매수분 ${signedWon(r.cost * p / 100)}`).join(' · '),
        },
      );
    }
  }
  e.setFooter({ text: '아직 체결 전이에요. 아래 [매수 실행]을 눌러야 주문돼요.' });

  const modeSelect = new StringSelectMenuBuilder()
    .setCustomId(id('tbm', asset.id, qtyStr(asset, qty)))
    .addOptions(Object.keys(game.BUY_MODES).map((k) => ({
      label: `${MODE_LABEL[k]} 매수`, value: k, description: MODE_DESC[k].slice(0, 100), default: k === m,
    })));
  const make = (q, key) => id('tb', asset.id, m, q, key);
  return pack(notice, e, [
    row(modeSelect),
    ...qtyRows(asset, qty, stepSizes(asset, price || 1), max, make, id('qi', 'b', asset.id, m)),
    row(
      btn(id('xb', asset.id, m, qtyStr(asset, qty)), canRun ? `${fmtQty(asset, qty)} 매수 실행` : '매수 실행', ButtonStyle.Danger, { emoji: '✅', disabled: !canRun }),
      backBtn(asset),
    ),
  ]);
}

// ── 매도 주문창 ──────────────────────────────────────────────

function sellTicket(state, user, assetId, qtyIn = 0, now = Date.now(), notice = null) {
  const asset = findAsset(assetId);
  const acc = state.users[user.id] || game.getUser(state, user.id, null, now);
  const h = acc.holdings[asset.id];
  const held = h ? h.qty : 0;
  const price = quote(state.market, asset.id)?.price;
  const qty = game.roundQty(asset, Math.min(held, Math.max(0, Number(qtyIn) || 0)));
  const e = new EmbedBuilder()
    .setColor(COLOR_SELL)
    .setTitle(`💸 ${asset.name} 매도 주문`)
    .setDescription(`${headerLine(state, asset, user)}\n` +
      (h ? `보유 **${fmtQty(asset, held)}** · 평단 ${won(h.avgPrice)}${price != null ? ` · 평가손익 ${signedWon((price - h.avgPrice) * held)}` : ''}` : '이 종목을 갖고 있지 않아요.'));

  let canRun = false;
  if (!h) {
    e.addFields({ name: '보유 없음', value: '매도할 수량이 없어요.' });
  } else if (qty <= 0) {
    e.addFields({ name: '수량을 정해 주세요', value: '아래 버튼으로 팔 수량을 고르면 받을 돈과 손익을 미리 보여 드려요.' });
  } else {
    const sim = game.simulate(state, user.id, (s) => game.sell(s, user.id, null, asset.id, qtyStr(asset, qty), now), now);
    if (sim.error) {
      e.addFields({ name: '⚠️ 주문 불가', value: sim.error });
    } else {
      canRun = true;
      const r = sim.result;
      const ha = sim.after.account.holdings[asset.id];
      e.addFields(
        { name: '📝 주문', value: `${fmtQty(asset, qty)} × ${won(r.price)}\n= ${won(r.revenue)}`, inline: true },
        { name: '💰 받을 돈', value: `**${won(r.revenue - r.fee)}**\n(수수료 ${won(r.fee)} 제외)`, inline: true },
        { name: r.profit >= 0 ? '🟥 실현 이익' : '🟦 실현 손실', value: `**${signedWon(r.profit)}**\n(${signedPct((r.profit / (h.avgPrice * qty)) * 100)})`, inline: true },
        {
          name: '📊 거래 후 모습',
          value: `현금: ${arrow(won(sim.before.value.cash), won(sim.after.value.cash))}\n` +
            `보유: ${arrow(fmtQty(asset, held), fmtQty(asset, ha ? ha.qty : 0))}\n` +
            (r.repaid > 0 ? `대출 자동 상환: **${won(r.repaid)}** (${arrow(won(sim.before.value.loans), won(sim.after.value.loans))})\n` : '') +
            `순자산: ${arrow(won(sim.before.value.total), won(sim.after.value.total))} (수수료만큼 줄어요)`,
        },
      );
    }
  }
  e.setFooter({ text: '아직 체결 전이에요. 아래 [매도 실행]을 눌러야 주문돼요.' });
  const make = (q, key) => id('ts', asset.id, q, key);
  return pack(notice, e, [
    ...qtyRows(asset, qty, stepSizes(asset, price || 1), held, make, id('qi', 's', asset.id), [0.25, 0.5, 0.75, 1]),
    row(
      btn(id('xs', asset.id, qtyStr(asset, qty)), canRun ? `${fmtQty(asset, qty)} 매도 실행` : '매도 실행', ButtonStyle.Primary, { emoji: '✅', disabled: !canRun }),
      backBtn(asset),
    ),
  ]);
}

// ── 선물 주문창 ──────────────────────────────────────────────

function futuresTicket(state, user, assetId, side = 'long', levIn = 5, marginIn = 0, now = Date.now(), notice = null) {
  const asset = findAsset(assetId);
  const acc = state.users[user.id] || game.getUser(state, user.id, null, now);
  const s = side === 'short' ? 'short' : 'long';
  const lev = LEVERAGES.includes(Number(levIn)) ? Number(levIn) : 5;
  const max = game.maxFuturesMargin(acc, lev);
  const margin = Math.max(0, Math.floor(Number(marginIn) || 0));
  const price = quote(state.market, asset.id)?.price;
  const e = new EmbedBuilder()
    .setColor(COLOR_FUT)
    .setTitle(`⚡ ${asset.name} 선물 ${s === 'long' ? '롱 (상승 베팅)' : '숏 (하락 베팅)'} · ${lev}배`)
    .setDescription(`${headerLine(state, asset, user)}\n` +
      `${s === 'long' ? '가격이 **오르면** 이익, 내리면 손해예요.' : '가격이 **내리면** 이익, 오르면 손해예요.'} ` +
      `손익은 증거금의 ${lev}배로 커져요. 최대 증거금 ${won(max)}.`);

  let canRun = false;
  if (price == null) {
    e.addFields({ name: '⏳ 시세 준비 중', value: '잠시 후 다시 시도해 주세요.' });
  } else if (margin <= 0) {
    e.addFields({ name: '증거금을 정해 주세요', value: '넣을 돈(증거금)을 고르면 포지션 크기와 청산가를 미리 보여 드려요.' });
  } else {
    const sim = game.simulate(state, user.id, (st) => game.openFuture(st, user.id, null, asset.id, s, String(margin), lev, now), now);
    if (sim.error) {
      e.addFields({ name: '⚠️ 주문 불가', value: sim.error });
    } else {
      canRun = true;
      const r = sim.result;
      const size = r.pos.margin * lev;
      const liqPct = ((r.liqPrice - price) / price) * 100;
      e.addFields(
        { name: '💵 증거금 (넣는 돈)', value: `**${won(r.pos.margin)}**\n+ 수수료 ${won(r.fee)}`, inline: true },
        { name: '📦 포지션 규모', value: `**${won(size)}**\n(${fmtQty({ ...asset, decimals: 4 }, r.pos.qty)}분)`, inline: true },
        { name: '💥 강제청산 가격', value: `**${won(r.liqPrice)}**\n(현재가 대비 ${signedPct(liqPct)})`, inline: true },
        {
          name: '📈 가격이 움직이면',
          value: [1, 5, -1, -5].map((p) => {
            const pnl = (s === 'long' ? 1 : -1) * size * p / 100;
            return `${signedPct(p)} → ${signedWon(pnl)} (증거금의 ${signedPct((pnl / r.pos.margin) * 100)})`;
          }).join('\n') + `\n손실은 넣은 증거금 ${won(r.pos.margin)}까지예요.`,
        },
        { name: '📊 거래 후 현금', value: arrow(won(sim.before.value.cash), won(sim.after.value.cash)) },
      );
    }
  }
  e.setFooter({ text: '아직 체결 전이에요. 아래 [진입 실행]을 눌러야 주문돼요.' });

  const levSelect = new StringSelectMenuBuilder()
    .setCustomId(id('tfl', asset.id, s, String(margin)))
    .addOptions(LEVERAGES.map((x) => ({
      label: `레버리지 ${x}배`, value: String(x), default: x === lev,
      description: `청산까지 약 ${((game.LIQUIDATION_LOSS / x) * 100).toFixed(1)}% 여유`,
    })));
  const make = (m, key) => id('tf', asset.id, s, String(lev), m, key);
  const won1 = 10000;
  const won10 = 100000;
  const set = (v, key) => make(String(Math.max(0, Math.min(max, Math.floor(v)))), key);
  return pack(notice, e, [
    row(levSelect),
    row(
      btn(id('tf', asset.id, 'long', String(lev), String(margin), 'L'), '롱 (상승)', s === 'long' ? ButtonStyle.Danger : ButtonStyle.Secondary, { emoji: '🔺' }),
      btn(id('tf', asset.id, 'short', String(lev), String(margin), 'S'), '숏 (하락)', s === 'short' ? ButtonStyle.Primary : ButtonStyle.Secondary, { emoji: '🔻' }),
    ),
    row(
      btn(set(margin - won10, 'mb'), '-10만원', ButtonStyle.Secondary, { disabled: margin <= 0 }),
      btn(set(margin - won1, 'ms'), '-1만원', ButtonStyle.Secondary, { disabled: margin <= 0 }),
      btn(set(margin + won1, 'ps'), '+1만원', ButtonStyle.Secondary, { disabled: margin >= max }),
      btn(set(margin + won10, 'pb'), '+10만원', ButtonStyle.Secondary, { disabled: margin >= max }),
      btn(id('qi', 'f', asset.id, s, String(lev)), '직접 입력', ButtonStyle.Primary, { emoji: '✏️' }),
    ),
    row(
      ...[0.1, 0.25, 0.5, 1].map((r, i) => btn(set(max * r, `r${i}`), r === 1 ? '최대' : `${r * 100}%`, ButtonStyle.Secondary, { disabled: max <= 0 })),
      btn(set(0, 'z'), '초기화', ButtonStyle.Secondary, { emoji: '🔄', disabled: margin <= 0 }),
    ),
    row(
      btn(id('xf', asset.id, s, String(lev), String(margin)), canRun ? `${won(margin)} ${s === 'long' ? '롱' : '숏'} 진입 실행` : '진입 실행', ButtonStyle.Danger, { emoji: '✅', disabled: !canRun }),
      backBtn(asset),
    ),
  ]);
}

// ── 옵션 주문창 ──────────────────────────────────────────────

function optionTicket(state, user, assetId, kind = 'call', expiry = '1d', offIn = 0, qtyIn = 0, now = Date.now(), notice = null) {
  const asset = findAsset(assetId);
  const acc = state.users[user.id] || game.getUser(state, user.id, null, now);
  const k = kind === 'put' ? 'put' : 'call';
  const exp = game.OPTION_EXPIRIES[expiry] ? expiry : '1d';
  const off = Math.max(-STRIKE_LIMIT, Math.min(STRIKE_LIMIT, Math.round((Number(offIn) || 0) / STRIKE_STEP) * STRIKE_STEP));
  const qty = game.roundQty(asset, Math.max(0, Number(qtyIn) || 0));
  const strikeInput = off === 0 ? '현재가' : `${off}%`;
  let q = null;
  try {
    q = game.quoteOption(state, asset.id, k, strikeInput, exp, now);
  } catch {
    q = null;
  }
  const max = q ? game.maxOptionQty(acc, asset, q.premium) : 0;
  const e = new EmbedBuilder()
    .setColor(COLOR_OPT)
    .setTitle(`🎯 ${asset.name} ${k === 'call' ? '콜옵션 (상승 베팅)' : '풋옵션 (하락 베팅)'}`)
    .setDescription(`${headerLine(state, asset, user)}\n` +
      (k === 'call'
        ? '만기 때 가격이 **행사가보다 높으면** 그 차이만큼 받아요.'
        : '만기 때 가격이 **행사가보다 낮으면** 그 차이만큼 받아요.') +
      ' 손실은 옵션을 산 돈까지만이에요.');

  let canRun = false;
  if (!q) {
    e.addFields({ name: '⏳ 시세 준비 중', value: '잠시 후 다시 시도해 주세요.' });
  } else {
    e.addFields(
      { name: '🎯 행사가', value: `**${won(q.strike)}**\n(현재가 ${signedPct(off)})`, inline: true },
      { name: '⏰ 만기', value: `**${q.expiryLabel}** 후\n${rel(q.expiry)}`, inline: true },
      { name: `💎 1${unitOf(asset)}분 가격`, value: `**${won(q.premium)}**\n최대 ${fmtQty(asset, max)}`, inline: true },
    );
    if (qty <= 0) {
      e.addFields({ name: '수량을 정해 주세요', value: '수량을 고르면 총비용과 만기 때 가격별 손익을 미리 보여 드려요.' });
    } else {
      const sim = game.simulate(state, user.id, (st) => game.buyOption(st, user.id, null, asset.id, k, strikeInput, exp, qtyStr(asset, qty), now), now);
      if (sim.error) {
        e.addFields({ name: '⚠️ 주문 불가', value: sim.error });
      } else {
        canRun = true;
        const r = sim.result;
        const total = r.cost + r.fee;
        const be = k === 'call' ? q.strike + q.premium : q.strike - q.premium;
        const scenarios = [-10, -5, 0, 5, 10].map((p) => {
          const sp = q.spot * (1 + p / 100);
          const payoff = (k === 'call' ? Math.max(0, sp - q.strike) : Math.max(0, q.strike - sp)) * qty;
          return `가격 ${signedPct(p).padStart(7)} (${won(sp)}) → ${signedWon(payoff - total)}`;
        });
        e.addFields(
          { name: '💸 총비용 = 최대 손실', value: `**${won(total)}**\n(${fmtQty(asset, qty)}분, 수수료 포함)`, inline: true },
          { name: '⚖️ 손익분기점', value: `**${won(be)}**\n(현재가 ${signedPct(((be - q.spot) / q.spot) * 100)})`, inline: true },
          { name: '💰 거래 후 현금', value: won(sim.after.value.cash), inline: true },
          { name: '📈 만기 때 가격별 손익', value: `\`\`\`\n${scenarios.join('\n')}\n\`\`\`` },
        );
      }
    }
  }
  e.setFooter({ text: '아직 체결 전이에요. 아래 [옵션 매수 실행]을 눌러야 주문돼요.' });

  const expSelect = new StringSelectMenuBuilder()
    .setCustomId(id('toe', asset.id, k, String(off), qtyStr(asset, qty)))
    .addOptions(Object.entries(game.OPTION_EXPIRIES).map(([v, x]) => ({ label: `만기 ${x.label}`, value: v, default: v === exp })));
  const make = (qv, key) => id('to', asset.id, k, exp, String(off), qv, key);
  const qs = qtyStr(asset, qty);
  return pack(notice, e, [
    row(expSelect),
    row(
      btn(id('to', asset.id, 'call', exp, String(off), qs, 'C'), '콜 (상승)', k === 'call' ? ButtonStyle.Danger : ButtonStyle.Secondary, { emoji: '📈' }),
      btn(id('to', asset.id, 'put', exp, String(off), qs, 'P'), '풋 (하락)', k === 'put' ? ButtonStyle.Primary : ButtonStyle.Secondary, { emoji: '📉' }),
      btn(id('to', asset.id, k, exp, String(off - STRIKE_STEP), qs, 'D'), `행사가 -${STRIKE_STEP}%`, ButtonStyle.Secondary, { emoji: '◀️', disabled: off <= -STRIKE_LIMIT }),
      btn(id('to', asset.id, k, exp, String(off + STRIKE_STEP), qs, 'U'), `행사가 +${STRIKE_STEP}%`, ButtonStyle.Secondary, { emoji: '▶️', disabled: off >= STRIKE_LIMIT }),
    ),
    ...qtyRows(asset, qty, stepSizes(asset, q ? q.premium : 1), max, make, id('qi', 'o', asset.id, k, exp, String(off))),
    row(
      btn(id('xo', asset.id, k, exp, String(off), qs), canRun ? `${fmtQty(asset, qty)}분 옵션 매수 실행` : '옵션 매수 실행', ButtonStyle.Danger, { emoji: '✅', disabled: !canRun }),
      backBtn(asset),
    ),
  ]);
}

// ── 직접 입력 팝업 ───────────────────────────────────────────

function inputModal(state, user, kind, args, now = Date.now()) {
  const asset = findAsset(args[0]);
  const acc = state.users[user.id] || game.getUser(state, user.id, null, now);
  let title;
  let label;
  let hint;
  if (kind === 'b') {
    const { max } = game.buyLimits(state, acc, asset, args[1], now);
    title = `${asset.name} 매수 수량`;
    label = '수량';
    hint = `최대 ${fmtQty(asset, max)} · 예: 10, 절반, 30%, 10만원(그 금액만큼)`;
  } else if (kind === 's') {
    title = `${asset.name} 매도 수량`;
    label = '수량';
    hint = `보유 ${fmtQty(asset, acc.holdings[asset.id]?.qty || 0)} · 예: 10, 절반, 전부`;
  } else if (kind === 'f') {
    title = `${asset.name} 선물 증거금`;
    label = '증거금 (넣을 돈)';
    hint = `최대 ${won(game.maxFuturesMargin(acc, Number(args[2]) || 5))} · 예: 50000, 5만, 절반, 30%`;
  } else {
    title = `${asset.name} 옵션 수량`;
    label = '수량';
    hint = `기초자산 몇 ${unitOf(asset)}분인지 · 예: 10, 절반, 10만원(그 금액만큼)`;
  }
  return new ModalBuilder()
    .setCustomId(id('mq', kind, ...args))
    .setTitle(title.length > 45 ? `${title.slice(0, 44)}…` : title)
    .addLabelComponents(new LabelBuilder().setLabel(label).setDescription(hint.slice(0, 100))
      .setTextInputComponent(new TextInputBuilder().setCustomId('v').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('숫자 또는 전부·절반·30%')));
}

// 직접 입력 값 → 주문창 (체결하지 않고 미리보기만)
function fromInput(state, user, kind, args, text, now = Date.now()) {
  const asset = findAsset(args[0]);
  const acc = state.users[user.id] || game.getUser(state, user.id, null, now);
  const price = quote(state.market, asset.id)?.price || 1;
  try {
    if (kind === 'b') {
      const { max } = game.buyLimits(state, acc, asset, args[1], now);
      return buyTicket(state, user, asset.id, args[1], game.parseQuantity(text, { max, asset, price }), now);
    }
    if (kind === 's') {
      const max = acc.holdings[asset.id]?.qty || 0;
      return sellTicket(state, user, asset.id, game.parseQuantity(text, { max, asset, price }), now);
    }
    if (kind === 'f') {
      const lev = Number(args[2]) || 5;
      return futuresTicket(state, user, asset.id, args[1], lev, game.parseAmount(text, game.maxFuturesMargin(acc, lev)), now);
    }
    const q = game.quoteOption(state, asset.id, args[1], Number(args[3]) === 0 ? '현재가' : `${args[3]}%`, args[2], now);
    const max = game.maxOptionQty(acc, asset, q.premium);
    return optionTicket(state, user, asset.id, args[1], args[2], args[3], game.parseQuantity(text, { max, asset, price: q.premium }), now);
  } catch (err) {
    if (!(err instanceof game.GameError)) throw err;
    const n = { error: true, text: `⚠️ ${err.message}` };
    if (kind === 'b') return buyTicket(state, user, asset.id, args[1], 0, now, n);
    if (kind === 's') return sellTicket(state, user, asset.id, 0, now, n);
    if (kind === 'f') return futuresTicket(state, user, asset.id, args[1], args[2], 0, now, n);
    return optionTicket(state, user, asset.id, args[1], args[2], args[3], 0, now, n);
  }
}

// ── 실행 + 체결 영수증 ───────────────────────────────────────

function snapshot(state, userId, assetId, now) {
  const acc = game.getUser(state, userId, null, now);
  return { value: game.portfolioValue(state, acc, now), held: acc.holdings[assetId]?.qty || 0 };
}

function receipt(state, user, asset, { title, color, lines, before, after, again }) {
  const e = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(lines.join('\n'))
    .addFields(
      { name: '💰 현금', value: arrow(won(before.value.cash), won(after.value.cash)), inline: true },
      { name: `📦 ${asset.name} 보유`, value: arrow(fmtQty(asset, before.held), fmtQty(asset, after.held)), inline: true },
      { name: '💳 대출', value: arrow(won(before.value.loans), won(after.value.loans)), inline: true },
      { name: '🏦 순자산', value: arrow(won(before.value.total), won(after.value.total)), inline: true },
    )
    .setFooter({ text: '체결 완료 · 선물·옵션은 포지션 화면에서 확인·정리할 수 있어요' })
    .setTimestamp();
  return {
    embeds: [e],
    components: [row(
      btn(id('a', asset.id, '1d'), '종목 화면', ButtonStyle.Secondary, { emoji: '📈' }),
      btn(again, '한 번 더 주문', ButtonStyle.Primary, { emoji: '🔁' }),
      btn(id('pos'), '포지션', ButtonStyle.Secondary, { emoji: '📋' }),
      btn(id('pf'), '내 자산', ButtonStyle.Secondary, { emoji: '💼' }),
      btn(id('home'), '홈', ButtonStyle.Secondary, { emoji: '🏠' }),
    )],
  };
}

// 실행 버튼 처리. 실패하면 주문창으로 돌아가 이유를 보여 준다.
function execute(state, user, gid, action, args, now = Date.now()) {
  const asset = findAsset(args[0]);
  const before = snapshot(state, user.id, asset.id, now);
  const fail = (err) => ({ error: true, text: `⚠️ 주문이 체결되지 않았어요: ${err.message}` });
  try {
    if (action === 'xb') {
      const r = game.buy(state, user.id, gid, asset.id, args[2], args[1], now);
      const lines = [
        `**${fmtQty(asset, r.qty)}** × ${won(r.price)} = **${won(r.cost)}** (수수료 ${won(r.fee)})`,
        r.loan ? (r.loan.type === 'misu' ? `📝 미수 ${won(r.loan.amount)} — ${rel(r.loan.dueAt)}까지 갚아야 해요` : `💳 신용 대출 ${won(r.loan.amount)} (연 ${game.CREDIT_RATE * 100}%)`) : null,
      ].filter(Boolean);
      return { changed: true, view: receipt(state, user, asset, { title: `✅ ${asset.name} ${MODE_LABEL[r.mode]} 매수 체결`, color: COLOR_BUY, lines, before, after: snapshot(state, user.id, asset.id, now), again: id('tb', asset.id, r.mode, '0', 'n') }) };
    }
    if (action === 'xs') {
      const r = game.sell(state, user.id, gid, asset.id, args[1], now);
      const lines = [
        `**${fmtQty(asset, r.qty)}** × ${won(r.price)} = **${won(r.revenue - r.fee)}** 받음 (수수료 ${won(r.fee)})`,
        `실현 손익 **${signedWon(r.profit)}**`,
        r.repaid > 0 ? `💳 대출 ${won(r.repaid)} 자동 상환` : null,
      ].filter(Boolean);
      return { changed: true, view: receipt(state, user, asset, { title: `✅ ${asset.name} 매도 체결`, color: COLOR_SELL, lines, before, after: snapshot(state, user.id, asset.id, now), again: id('ts', asset.id, '0', 'n') }) };
    }
    if (action === 'xf') {
      const r = game.openFuture(state, user.id, gid, asset.id, args[1], args[3], Number(args[2]), now);
      const lines = [
        `\`#${r.pos.id}\` **${r.pos.side > 0 ? '롱' : '숏'} ${r.pos.leverage}배** · 진입가 ${won(r.pos.entry)}`,
        `증거금 ${won(r.pos.margin)} · 포지션 규모 ${won(r.pos.margin * r.pos.leverage)} · 수수료 ${won(r.fee)}`,
        `💥 강제청산 가격 **${won(r.liqPrice)}**`,
      ];
      return { changed: true, view: receipt(state, user, asset, { title: `✅ ${asset.name} 선물 진입`, color: COLOR_FUT, lines, before, after: snapshot(state, user.id, asset.id, now), again: id('tf', asset.id, args[1], args[2], '0', 'n') }) };
    }
    const off = Number(args[3]) || 0;
    const r = game.buyOption(state, user.id, gid, asset.id, args[1], off === 0 ? '현재가' : `${off}%`, args[2], args[4], now);
    const lines = [
      `\`#${r.opt.id}\` **${r.kind === 'call' ? '콜' : '풋'}** 행사가 ${won(r.strike)} · 만기 ${rel(r.expiry)}`,
      `${fmtQty(asset, r.qty)}분 × ${won(r.premium)} = **${won(r.cost + r.fee)}** (수수료 포함, 최대 손실)`,
    ];
    return { changed: true, view: receipt(state, user, asset, { title: `✅ ${asset.name} 옵션 매수`, color: COLOR_OPT, lines, before, after: snapshot(state, user.id, asset.id, now), again: id('to', asset.id, args[1], args[2], args[3], '0', 'n') }) };
  } catch (err) {
    if (!(err instanceof game.GameError)) throw err;
    const n = fail(err);
    const view = action === 'xb' ? buyTicket(state, user, asset.id, args[1], args[2], now, n)
      : action === 'xs' ? sellTicket(state, user, asset.id, args[1], now, n)
        : action === 'xf' ? futuresTicket(state, user, asset.id, args[1], args[2], args[3], now, n)
          : optionTicket(state, user, asset.id, args[1], args[2], args[3], args[4], now, n);
    return { changed: false, view };
  }
}

module.exports = { buyTicket, sellTicket, futuresTicket, optionTicket, inputModal, fromInput, execute, stepSizes, qtyStr };
