// /주식 GUI 화면 — 버튼·선택 메뉴·팝업(모달)으로 모든 기능을 조작한다.
// 화면 그리기는 디스코드가, 차트 이미지는 GitHub Pages가 맡아서 Railway는 상태 계산만 한다.
//
// custom_id 형식: "stk|동작|인자1|인자2…"  (100자 이하)

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ModalBuilder, LabelBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const game = require('./game');
const { ASSETS, CATEGORIES, findAsset, unitOf, BOARD_PAGE_SIZE, HOME_HEATMAP } = require('./assets');
const v2 = require('./v2');
const { quote, isOpen, marketStatus } = require('./market');
const { PAGES_URL } = require('./prices');

const { won, fmtQty } = game;
const COLOR_UP = 0xe03131;   // 한국 증시 관례: 상승 빨강
const COLOR_DOWN = 0x1c7ed6; // 하락 파랑
const COLOR_INFO = 0xf59f00;
const COLOR_OK = 0x2f9e44;
const COLOR_ERR = 0xc92a2a;
const PAGE_SIZE = BOARD_PAGE_SIZE;
const RANGES = { '1d': '1일', '1w': '1주', '1m': '1달', '1y': '1년' };

const id = (...parts) => ['stk', ...parts].join('|');

// ── 서식 ─────────────────────────────────────────────────────

function pct(from, to) {
  return from ? ((to - from) / from) * 100 : 0;
}

function fmtPct(p) {
  const arrow = p > 0 ? '🔺' : p < 0 ? '🔻' : '➖';
  return `${arrow} ${p > 0 ? '+' : ''}${p.toFixed(2)}%`;
}

function signedWon(n) {
  return `${n > 0 ? '+' : n < 0 ? '-' : ''}${won(Math.abs(n))}`;
}

function rel(ms) {
  return `<t:${Math.floor(ms / 1000)}:R>`;
}

function clip(text, max = 1024) {
  return text.length <= max ? text : `${text.slice(0, max - 2)}…`;
}

function clipLabel(text, max = 100) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function changeOf(state, assetId) {
  const q = quote(state.market, assetId);
  return q && q.prevClose && q.price != null ? pct(q.prevClose, q.price) : null;
}

function priceLine(state, a, now) {
  const q = quote(state.market, a.id);
  if (!q || q.price == null) return `**${a.name}** · 시세 준비 중`;
  const ch = changeOf(state, a.id);
  return `**${a.name}** ${won(q.price)} ${ch != null ? fmtPct(ch) : ''}${isOpen(state.market, a.id, now) ? '' : ' 💤'}`;
}

function rawPrice(asset, q) {
  if (!q || q.raw == null || asset.currency === 'KRW') return null;
  const v = q.raw * (asset.factor || 1);
  const s = v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return asset.currency === 'USD' ? `$${s}` : asset.currency === 'JPY' ? `¥${s}` : s;
}

function chartUrl(state, assetId, range) {
  const v = state.market.chartsVersion;
  return v ? `${PAGES_URL}/charts/${encodeURIComponent(assetId)}_${range}.png?v=${v}` : null;
}

// 알림 줄 (체결 결과, 오류 등)
function noticeEmbed(notice) {
  if (!notice) return null;
  return new EmbedBuilder().setColor(notice.error ? COLOR_ERR : COLOR_OK).setDescription(notice.text);
}

function withNotice(notice, embeds) {
  const n = noticeEmbed(notice);
  return n ? [n, ...embeds] : embeds;
}

const btn = (customId, label, style = ButtonStyle.Secondary, opts = {}) => {
  const b = new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style);
  if (opts.emoji) b.setEmoji(opts.emoji);
  if (opts.disabled) b.setDisabled(true);
  return b;
};
const row = (...components) => new ActionRowBuilder().addComponents(...components);
const homeBtn = () => btn(id('home'), '홈', ButtonStyle.Secondary, { emoji: '🏠' });

function categorySelect(selected) {
  return new StringSelectMenuBuilder()
    .setCustomId(id('cat'))
    .setPlaceholder('📂 분류를 골라 시세 보기')
    .addOptions(Object.entries(CATEGORIES).map(([value, label]) => ({
      label: `${label} (${ASSETS.filter((a) => a.category === value).length})`,
      value,
      default: value === selected,
    })));
}

// ── 홈 ───────────────────────────────────────────────────────

function homeView(state, user, now, notice) {
  const acc = game.getUser(state, user.id, null, now);
  const v = game.portfolioValue(state, acc, now);
  const profit = v.total - game.START_CASH;
  const heat = v2.pagesImage(state, 'heat_home');
  const market = heat
    ? v2.gallery(heat)
    : v2.text(HOME_HEATMAP.slice(0, 6).map(findAsset).filter(Boolean).map((a) => priceLine(state, a, now)).join('\n') || '시세 준비 중');
  return {
    v2: [
      v2.noticeContainer(notice),
      v2.container(profit >= 0 ? COLOR_UP : COLOR_DOWN, [
        v2.section(
          `-# 💼 ${user.displayName ?? user.username}님의 주식 터미널\n` +
          `# ${won(v.total)}\n` +
          `${fmtPct(pct(game.START_CASH, v.total))} (${signedWon(profit)}) · 시작 자금 ${won(game.START_CASH)} 대비`,
          { thumbnail: user.displayAvatarURL() },
        ),
        v2.text(`💰 현금 **${won(v.cash)}**　📊 투자 **${won(v.stock + v.futures + v.options)}**　💳 대출 **${won(v.loans)}**`),
        v2.sep(),
        market,
        row(categorySelect()),
        row(
          btn(id('search'), '종목 검색', ButtonStyle.Primary, { emoji: '🔍' }),
          btn(id('pf'), '내 자산', ButtonStyle.Secondary, { emoji: '💼' }),
          btn(id('pos'), '포지션', ButtonStyle.Secondary, { emoji: '📋' }),
          btn(id('rank', 'all'), '랭킹', ButtonStyle.Secondary, { emoji: '🏆' }),
        ),
        row(
          btn(id('daily'), '출석 보상', ButtonStyle.Success, { emoji: '🎁' }),
          btn(id('help'), '도움말', ButtonStyle.Secondary, { emoji: '❓' }),
          btn(id('home'), '새로고침', ButtonStyle.Secondary, { emoji: '🔄' }),
        ),
        v2.text(`-# ${ASSETS.length}종목 · 24시간 거래 (💤 장 마감 종목은 종가 기준) · 이 화면은 나만 보여요`),
      ]),
    ],
  };
}

// ── 종목 목록 ────────────────────────────────────────────────

function listView(state, cat, page, now, notice) {
  const list = ASSETS.filter((a) => a.category === cat);
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const p = Math.min(Math.max(0, Number(page) || 0), pages - 1);
  const items = list.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);
  const board = v2.pagesImage(state, `board_${cat}_${p}`);
  const pick = new StringSelectMenuBuilder()
    .setCustomId(id('pick', cat))
    .setPlaceholder('📈 종목 선택 → 차트·주문')
    .addOptions(items.map((a) => {
      const q = quote(state.market, a.id);
      const ch = changeOf(state, a.id);
      return {
        label: clipLabel(a.name),
        value: a.id,
        description: clipLabel(q && q.price != null ? `${won(q.price)}${ch != null ? ` (${ch >= 0 ? '+' : ''}${ch.toFixed(2)}%)` : ''} · ${a.id}` : `시세 준비 중 · ${a.id}`),
      };
    }));
  return {
    v2: [
      v2.noticeContainer(notice),
      v2.container(COLOR_INFO, [
        v2.text(`## 📂 ${CATEGORIES[cat]}\n-# ${list.length}종목 · ${p + 1}/${pages} 페이지`),
        board ? v2.gallery(board) : v2.text(clip(items.map((a) => priceLine(state, a, now)).join('\n'), 3000)),
        row(pick),
        row(categorySelect(cat)),
        row(
          btn(id('list', cat, p - 1), '이전', ButtonStyle.Secondary, { emoji: '◀️', disabled: p === 0 }),
          btn(id('noop'), `${p + 1} / ${pages}`, ButtonStyle.Secondary, { disabled: true }),
          btn(id('list', cat, p + 1), '다음', ButtonStyle.Secondary, { emoji: '▶️', disabled: p >= pages - 1 }),
          btn(id('search'), '검색', ButtonStyle.Primary, { emoji: '🔍' }),
          homeBtn(),
        ),
        v2.text(`-# ${board ? '시세판은 15분마다 갱신 · ' : ''}메뉴에서 종목을 고르면 차트와 주문 화면이 열려요`),
      ]),
    ],
  };
}

// ── 종목 상세 (차트 + 주문) ───────────────────────────────────

function assetEmbed(state, asset, range, now, userId) {
  const q = quote(state.market, asset.id);
  const ch = changeOf(state, asset.id);
  const e = new EmbedBuilder()
    .setColor(ch == null ? COLOR_INFO : ch >= 0 ? COLOR_UP : COLOR_DOWN)
    .setTitle(`${asset.name} (${asset.id})`)
    .setDescription(q && q.price != null
      ? `## ${won(q.price)}\n${ch != null ? `${fmtPct(ch)} 전일 대비 · ` : ''}${marketStatus(state.market, asset.id, now)}`
      : '시세를 받아오는 중이에요. 잠시 후 새로고침해 주세요.');
  const raw = rawPrice(asset, q);
  const fields = [{ name: '분류', value: CATEGORIES[asset.category], inline: true }];
  if (raw) fields.push({ name: '원본 시세', value: raw, inline: true });
  fields.push({ name: '거래 단위', value: `${asset.decimals ? `0.${'0'.repeat(asset.decimals - 1)}1` : '1'}${unitOf(asset)}`, inline: true });
  if (userId) {
    const acc = state.users[userId];
    const h = acc && acc.holdings[asset.id];
    if (h && q && q.price != null) {
      fields.push({
        name: '💼 내 보유',
        value: `${fmtQty(asset, h.qty)} · 평단 ${won(h.avgPrice)}\n평가 ${won(h.qty * q.price)} (${signedWon((q.price - h.avgPrice) * h.qty)}, ${fmtPct(pct(h.avgPrice, q.price))})`,
      });
    }
    const futs = (acc?.futures || []).filter((f) => f.asset === asset.id).length;
    const opts = (acc?.options || []).filter((o) => o.asset === asset.id).length;
    if (futs || opts) fields.push({ name: '📋 이 종목 포지션', value: `선물 ${futs}건 · 옵션 ${opts}건 (포지션 화면에서 정리)` });
  }
  e.addFields(fields);
  const url = chartUrl(state, asset.id, range);
  if (url) e.setImage(url).setFooter({ text: `차트: ${RANGES[range]} · 15분마다 갱신` });
  return e;
}

function assetView(state, user, assetId, range = '1d', now, notice) {
  const asset = findAsset(assetId);
  if (!asset) return homeView(state, user, now, { error: true, text: '종목을 찾을 수 없어요.' });
  const r = RANGES[range] ? range : '1d';
  const q = quote(state.market, asset.id);
  const ch = changeOf(state, asset.id);
  const acc = state.users[user.id];
  const h = acc && acc.holdings[asset.id];
  const chart = chartUrl(state, asset.id, r);
  const icon = v2.pagesImage(state, `icon_${asset.id}`);
  const raw = rawPrice(asset, q);
  const head = `-# ${CATEGORIES[asset.category]} · ${asset.id}${raw ? ` · 원본 ${raw}` : ''}\n` +
    `## ${asset.name}\n` +
    (q && q.price != null
      ? `# ${won(q.price)}\n${ch != null ? `${fmtPct(ch)} 전일 대비 · ` : ''}${marketStatus(state.market, asset.id, now)}`
      : '시세를 받아오는 중이에요. 잠시 후 새로고침해 주세요.');

  let holding;
  if (h && q && q.price != null) {
    const pnl = (q.price - h.avgPrice) * h.qty;
    holding = v2.section(
      `**💼 내 보유** ${fmtQty(asset, h.qty)} · ${won(h.qty * q.price)}\n` +
      `-# 평단 ${won(h.avgPrice)} · 평가손익 ${signedWon(pnl)} (${fmtPct(pct(h.avgPrice, q.price))})`,
      { button: btn(id('ts', asset.id, '0', 'o'), '매도', ButtonStyle.Primary, { emoji: '💸' }) },
    );
  } else {
    holding = v2.text('-# 💼 아직 보유하지 않은 종목이에요');
  }
  const futs = (acc?.futures || []).filter((f) => f.asset === asset.id).length;
  const opts = (acc?.options || []).filter((o) => o.asset === asset.id).length;
  const derivs = futs || opts
    ? v2.section(`**📋 이 종목 포지션** 선물 ${futs}건 · 옵션 ${opts}건`, { button: btn(id('pos'), '포지션', ButtonStyle.Secondary) })
    : null;

  return {
    v2: [
      v2.noticeContainer(notice),
      v2.container(ch == null ? COLOR_INFO : ch >= 0 ? COLOR_UP : COLOR_DOWN, [
        icon ? v2.section(head, { thumbnail: icon }) : v2.text(head),
        chart ? v2.gallery(chart) : null,
        row(
          ...Object.entries(RANGES).map(([k, label]) =>
            btn(id('a', asset.id, k), label, k === r ? ButtonStyle.Primary : ButtonStyle.Secondary)),
          btn(id('a', asset.id, r, 'refresh'), '새로고침', ButtonStyle.Secondary, { emoji: '🔄' }),
        ),
        v2.sep(),
        holding,
        derivs,
        v2.sep(),
        row(
          btn(id('tb', asset.id, 'cash', '0', 'o'), '매수', ButtonStyle.Danger, { emoji: '🛒' }),
          btn(id('tf', asset.id, 'long', '5', '0', 'o'), '롱 (상승)', ButtonStyle.Secondary, { emoji: '⚡' }),
          btn(id('tf', asset.id, 'short', '5', '0', 'o'), '숏 (하락)', ButtonStyle.Secondary, { emoji: '⚡' }),
          btn(id('to', asset.id, 'call', '1d', '0', '0', 'o'), '옵션', ButtonStyle.Secondary, { emoji: '🎯' }),
        ),
        row(
          btn(id('list', asset.category, Math.floor(ASSETS.filter((a) => a.category === asset.category).indexOf(asset) / PAGE_SIZE)), '목록', ButtonStyle.Secondary, { emoji: '⬅️' }),
          homeBtn(),
          btn(id('share', 'a', asset.id, r), '채널에 공유', ButtonStyle.Success, { emoji: '📢' }),
        ),
        v2.text(`-# 거래 단위 ${asset.decimals ? `0.${'0'.repeat(asset.decimals - 1)}1` : '1'}${unitOf(asset)} · 차트 ${RANGES[r]} · 차트·시세는 15분마다 갱신${asset.category === 'crypto' ? ' (코인 시세는 1분마다)' : ''}`),
      ]),
    ],
  };
}

// ── 내 자산 ──────────────────────────────────────────────────

function portfolioEmbed(state, user, now) {
  const acc = game.getUser(state, user.id, null, now);
  const v = game.portfolioValue(state, acc, now);
  const profit = v.total - game.START_CASH;
  const holdings = Object.entries(acc.holdings)
    .map(([hid, h]) => {
      const a = findAsset(hid);
      const p = quote(state.market, hid)?.price ?? h.avgPrice;
      return { a, h, p, value: h.qty * p };
    })
    .sort((x, y) => y.value - x.value)
    .map(({ a, h, p }) => `**${a ? a.name : '?'}** ${fmtQty(a, h.qty)} · ${won(h.qty * p)} (${fmtPct(pct(h.avgPrice, p))})`);
  return new EmbedBuilder()
    .setAuthor({ name: `${user.displayName ?? user.username}님의 자산`, iconURL: user.displayAvatarURL() })
    .setColor(profit >= 0 ? COLOR_UP : COLOR_DOWN)
    .addFields(
      { name: '🏦 순자산', value: won(v.total), inline: true },
      { name: '📈 누적 수익', value: `${signedWon(profit)}\n${fmtPct(pct(game.START_CASH, v.total))}`, inline: true },
      { name: '✅ 실현 손익', value: signedWon(acc.realized), inline: true },
      { name: '💰 현금', value: won(v.cash), inline: true },
      { name: '📊 현물', value: won(v.stock), inline: true },
      { name: '💳 대출', value: won(v.loans), inline: true },
      { name: '⚡ 선물', value: `${won(v.futures)} (${acc.futures.length}건)`, inline: true },
      { name: '🎯 옵션', value: `${won(v.options)} (${acc.options.length}건)`, inline: true },
      { name: '​', value: '​', inline: true },
      { name: `보유 현물 (${holdings.length})`, value: clip(holdings.join('\n') || '아직 없어요. 홈에서 종목을 골라 매수해 보세요!') },
    );
}

function portfolioView(state, user, now, notice) {
  const acc = game.getUser(state, user.id, null, now);
  const v = game.portfolioValue(state, acc, now);
  const profit = v.total - game.START_CASH;
  const gross = Math.max(1, v.cash + v.stock + v.futures + v.options);
  const parts = [
    ['💰 현금', v.cash], ['📊 현물', v.stock], ['⚡ 선물', v.futures], ['🎯 옵션', v.options],
  ].filter(([, x]) => x > 0 || x === v.cash);
  const mix = parts.map(([name, x]) => `${name} ${v2.bar(x / gross)} ${((x / gross) * 100).toFixed(0).padStart(3)}% · ${won(x)}`);
  if (v.loans > 0) mix.push(`💳 대출 ${won(v.loans)} (순자산에서 빠져요)`);

  const holdings = Object.entries(acc.holdings)
    .map(([hid, h]) => {
      const a = findAsset(hid);
      const p = quote(state.market, hid)?.price ?? h.avgPrice;
      return { hid, a, h, p, value: h.qty * p };
    })
    .sort((x, y) => y.value - x.value);
  const shown = holdings.slice(0, 5);
  const rows = shown.map(({ hid, a, h, p, value }) => v2.section(
    `**${a ? a.name : hid}** ${fmtQty(a, h.qty)} · ${won(value)}\n` +
    `-# 평단 ${won(h.avgPrice)} · ${fmtPct(pct(h.avgPrice, p))} (${signedWon((p - h.avgPrice) * h.qty)})`,
    { button: btn(id('a', hid, '1d', 'pf'), '보기', ButtonStyle.Secondary, { emoji: '📈' }) },
  ));
  const rest = holdings.slice(5, 30);
  const buttons = [
    btn(id('pos'), '포지션', ButtonStyle.Secondary, { emoji: '📋' }),
    btn(id('rank', 'all'), '랭킹', ButtonStyle.Secondary, { emoji: '🏆' }),
    homeBtn(),
    btn(id('share', 'pf'), '채널에 공유', ButtonStyle.Success, { emoji: '📢' }),
  ];
  if (v.total < game.BANKRUPT_LIMIT) buttons.push(btn(id('bankrupt'), '파산 신청', ButtonStyle.Danger, { emoji: '💀' }));

  return {
    v2: [
      v2.noticeContainer(notice),
      v2.container(profit >= 0 ? COLOR_UP : COLOR_DOWN, [
        v2.section(
          `-# 💼 ${user.displayName ?? user.username}님의 자산\n# ${won(v.total)}\n` +
          `${fmtPct(pct(game.START_CASH, v.total))} (${signedWon(profit)}) · 실현 손익 ${signedWon(acc.realized)}`,
          { thumbnail: user.displayAvatarURL() },
        ),
        v2.sep(),
        v2.text(`### 자산 구성\n${mix.join('\n')}`),
        v2.sep(),
        v2.text(`### 보유 종목 (${holdings.length})${holdings.length ? '' : '\n-# 아직 없어요. 홈에서 종목을 골라 매수해 보세요!'}`),
        ...rows,
        rest.length ? row(new StringSelectMenuBuilder()
          .setCustomId(id('pick', 'pf'))
          .setPlaceholder(`나머지 ${rest.length}종목 보기`)
          .addOptions(rest.map(({ hid, a, h }) => ({ label: clipLabel(a ? a.name : hid), value: hid, description: fmtQty(a, h.qty) })))) : null,
        v2.sep(),
        row(...buttons),
      ]),
    ],
  };
}

// ── 포지션 (선물·옵션·대출) ───────────────────────────────────

function futuresLine(state, pos) {
  const a = findAsset(pos.asset);
  const p = quote(state.market, pos.asset)?.price ?? pos.entry;
  const pnl = game.futuresPnl(pos, p);
  return `\`#${pos.id}\` **${a ? a.name : pos.asset}** ${pos.side > 0 ? '롱' : '숏'} ${pos.leverage}배 · 증거금 ${won(pos.margin)}\n` +
    `　${won(pos.entry)} → ${won(p)} · ${signedWon(pnl)} (${fmtPct((pnl / pos.margin) * 100)}) · 청산가 ${won(game.liquidationPrice(pos))}`;
}

function optionLine(state, opt, now) {
  const a = findAsset(opt.asset);
  const value = game.optionValue(state, opt, now);
  const cost = opt.premium * opt.qty;
  return `\`#${opt.id}\` **${a ? a.name : opt.asset}** ${opt.kind === 'call' ? '콜' : '풋'} 행사가 ${won(opt.strike)} · ${fmtQty(a, opt.qty)}분 · 만기 ${rel(opt.expiry)}\n` +
    `　평가 ${won(value)} (매수 ${won(cost)}, ${fmtPct(pct(cost, value))})`;
}

function loanLine(l) {
  return l.type === 'misu'
    ? `\`#${l.id}\` 미수 ${won(l.amount)} · 결제일 ${rel(l.dueAt)} (못 갚으면 반대매매)`
    : `\`#${l.id}\` 신용 ${won(l.amount)} · 연 ${game.CREDIT_RATE * 100}% 이자`;
}

function positionsView(state, user, now, notice, selected) {
  const acc = game.getUser(state, user.id, null, now);
  const v = game.portfolioValue(state, acc, now);
  const ratio = v.loans > 0 ? `\n담보비율 **${((v.assets / v.loans) * 100).toFixed(0)}%** (${game.MAINTENANCE_RATIO * 100}% 미만이면 반대매매)` : '';
  const e = new EmbedBuilder()
    .setTitle('📋 내 포지션')
    .setColor(COLOR_INFO)
    .addFields(
      { name: `⚡ 선물 (${acc.futures.length})`, value: clip(acc.futures.map((p) => futuresLine(state, p)).join('\n') || '없음') },
      { name: `🎯 옵션 (${acc.options.length})`, value: clip(acc.options.map((o) => optionLine(state, o, now)).join('\n') || '없음') },
      { name: `💳 대출 (${won(v.loans)})`, value: clip((acc.loans.map(loanLine).join('\n') || '없음') + ratio) },
    );
  const components = [];
  const choices = [
    ...acc.futures.map((p) => ({
      label: clipLabel(`#${p.id} 선물 ${findAsset(p.asset)?.name || p.asset} ${p.side > 0 ? '롱' : '숏'} ${p.leverage}배`),
      value: `f:${p.id}`,
      description: `증거금 ${won(p.margin)}`,
    })),
    ...acc.options.map((o) => ({
      label: clipLabel(`#${o.id} 옵션 ${findAsset(o.asset)?.name || o.asset} ${o.kind === 'call' ? '콜' : '풋'}`),
      value: `o:${o.id}`,
      description: `행사가 ${won(o.strike)}`,
    })),
  ].slice(0, 25);
  if (selected) {
    const [kind, pid] = selected.split(':');
    const label = choices.find((c) => c.value === selected)?.label || `#${pid}`;
    e.setFooter({ text: `선택: ${label} — 정리하려면 확인을 눌러 주세요` });
    components.push(row(
      btn(id('closeok', selected), kind === 'f' ? '선물 청산 확인' : '옵션 매도 확인', ButtonStyle.Danger, { emoji: '✅' }),
      btn(id('pos'), '취소', ButtonStyle.Secondary),
    ));
  } else if (choices.length) {
    components.push(row(new StringSelectMenuBuilder()
      .setCustomId(id('close'))
      .setPlaceholder('정리할 선물·옵션 선택')
      .addOptions(choices)));
  }
  components.push(row(
    btn(id('repay'), '대출 상환', ButtonStyle.Primary, { emoji: '💳', disabled: v.loans <= 0 }),
    btn(id('pf'), '내 자산', ButtonStyle.Secondary, { emoji: '💼' }),
    homeBtn(),
  ));
  return { embeds: withNotice(notice, [e]), components };
}

// ── 랭킹 ─────────────────────────────────────────────────────

function rankingEmbed(state, scope, guildId, now) {
  const medals = ['🥇', '🥈', '🥉'];
  const rows = game.ranking(state, scope === 'guild' ? guildId : null, 10, now).map((r, i) =>
    `${medals[i] || `**${i + 1}.**`} <@${r.userId}> — ${won(r.total)} (${fmtPct(pct(game.START_CASH, r.total))})`);
  return new EmbedBuilder()
    .setTitle(scope === 'guild' ? '🏆 이 서버 순자산 랭킹' : '🏆 전체 서버 순자산 랭킹')
    .setColor(COLOR_INFO)
    .setDescription(rows.length ? rows.join('\n') : '아직 참가자가 없어요.');
}

function rankingView(state, scope, guildId, now, notice) {
  return {
    embeds: withNotice(notice, [rankingEmbed(state, scope, guildId, now)]),
    components: [row(
      btn(id('rank', 'all'), '전체 서버', scope === 'guild' ? ButtonStyle.Secondary : ButtonStyle.Primary),
      btn(id('rank', 'guild'), '이 서버', scope === 'guild' ? ButtonStyle.Primary : ButtonStyle.Secondary),
      homeBtn(),
      btn(id('share', 'rank', scope), '채널에 공유', ButtonStyle.Success, { emoji: '📢' }),
    )],
    allowedMentions: { parse: [] },
  };
}

// ── 도움말 ───────────────────────────────────────────────────

function helpView() {
  const e = new EmbedBuilder()
    .setTitle('📘 주식 게임 도움말')
    .setColor(COLOR_INFO)
    .setDescription(
      `처음 쓰면 **${won(game.START_CASH)}**으로 계좌가 열려요. 계좌는 봇이 있는 **모든 서버에서 공용**이에요.\n` +
      `실제 시세 ${ASSETS.length}종목을 **24시간** 거래할 수 있어요. 장이 닫힌 종목(💤)은 마지막 종가로 거래돼요.\n​`)
    .addFields(
      { name: '🧭 사용법', value: '홈 → 분류 선택 또는 🔍 검색 → 종목 화면 → 주문창에서 버튼으로 수량을 고르면 결과를 미리 보여 줘요 → [실행]을 눌러야 체결돼요' },
      { name: '🛒 현물', value: '버튼으로 수량 조절 · ✏️ 직접 입력: `10`, `0.01`, `전부`, `절반`, `30%`, `10만원`(그 금액만큼)' },
      {
        name: '💳 신용·미수',
        value: `**신용**: 본인 ${game.CREDIT_MARGIN * 100}% + 대출, 연 ${game.CREDIT_RATE * 100}% 이자\n` +
          `**미수**: 증거금 ${game.MISU_MARGIN * 100}%, ${game.MISU_DAYS}일 안에 결제 (못 하면 반대매매)\n` +
          `대출 한도 순자산 ×${game.LOAN_LIMIT_RATIO} · 담보비율 ${game.MAINTENANCE_RATIO * 100}% 미만이면 반대매매`,
      },
      { name: '⚡ 선물', value: `롱=상승, 숏=하락 베팅 · 최대 ${game.MAX_LEVERAGE}배 · 손실이 증거금 ${game.LIQUIDATION_LOSS * 100}%에 닿으면 강제청산` },
      { name: '🎯 옵션', value: '콜=오를수록, 풋=내릴수록 이익 · 손실은 산 가격까지만 · 만기(1시간/1일/1주)에 자동 정산' },
      { name: '🔔 알림', value: '반대매매·강제청산·옵션 만기는 DM으로 알려 드려요 (서버 DM 허용 필요)' },
    );
  return { embeds: [e], components: [row(homeBtn())] };
}

// ── 팝업 입력창 (모달) ────────────────────────────────────────

const textInput = (customId, placeholder, { required = true, value } = {}) => {
  const t = new TextInputBuilder().setCustomId(customId).setStyle(TextInputStyle.Short).setPlaceholder(placeholder).setRequired(required);
  if (value) t.setValue(value);
  return t;
};
const label = (text, desc, component) => {
  const l = new LabelBuilder().setLabel(text);
  if (desc) l.setDescription(desc);
  return l.setTextInputComponent(component);
};

function searchModal() {
  return new ModalBuilder().setCustomId(id('m_search')).setTitle('🔍 종목 검색')
    .addLabelComponents(label('종목 이름 또는 코드', '예: 삼성, 애플, AAPL, 비트, 코덱스, 원유', textInput('q', '검색어')));
}

function repayModal() {
  return new ModalBuilder().setCustomId(id('m_repay')).setTitle('💳 대출 상환')
    .addLabelComponents(label('금액', '예: 50만, 절반, 전부', textInput('amount', '전부', { value: '전부' })));
}

// ── 검색 결과 ────────────────────────────────────────────────

function searchResultView(state, query, hits, now) {
  const e = new EmbedBuilder()
    .setColor(COLOR_INFO)
    .setTitle(`🔍 "${clipLabel(query, 50)}" 검색 결과 (${hits.length})`)
    .setDescription(hits.length ? hits.map((a) => priceLine(state, a, now)).join('\n') : '찾는 종목이 없어요. 다른 이름으로 검색해 보세요.');
  const components = [];
  if (hits.length) {
    components.push(row(new StringSelectMenuBuilder()
      .setCustomId(id('pick', 'search'))
      .setPlaceholder('📈 종목 선택 → 차트·주문')
      .addOptions(hits.map((a) => ({ label: clipLabel(a.name), value: a.id, description: `${CATEGORIES[a.category]} · ${a.id}` })))));
  }
  components.push(row(btn(id('search'), '다시 검색', ButtonStyle.Primary, { emoji: '🔍' }), homeBtn()));
  return { embeds: [e], components };
}

module.exports = {
  id, homeView, listView, assetView, assetEmbed, portfolioView, portfolioEmbed, positionsView, rankingView, rankingEmbed,
  helpView, searchModal, repayModal, searchResultView, chartUrl, RANGES,
};
