// /주식 GUI 화면 — 버튼·선택 메뉴·팝업(모달)으로 모든 기능을 조작한다.
// 화면 그리기는 디스코드가, 차트 이미지는 GitHub Pages가 맡아서 Railway는 상태 계산만 한다.
//
// custom_id 형식: "stk|동작|인자1|인자2…"  (100자 이하)

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ModalBuilder, LabelBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const game = require('./game');
const { ASSETS, CATEGORIES, findAsset, unitOf, HOME_HEATMAP } = require('./assets');
const v2 = require('./v2');
const life = require('./life');
const { quote, isOpen, marketStatus } = require('./market');
const { PAGES_URL } = require('./prices');

const { won, fmtQty } = game;
const COLOR_UP = 0xe03131;   // 한국 증시 관례: 상승 빨강
const COLOR_DOWN = 0x1c7ed6; // 하락 파랑
const COLOR_INFO = 0xf59f00;
const COLOR_OK = 0x2f9e44;
const COLOR_ERR = 0xc92a2a;
const PAGE_SIZE = 8; // 목록 한 페이지 종목 수 (줄마다 버튼이 있어 디스코드 요소 수 제한 40개에 맞춤)
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

// 1500000000 → "15억", 3500000 → "350만"
function shortWon(n) {
  const eok = Math.floor(n / 1e8);
  const man = Math.round((n % 1e8) / 1e4);
  return `${eok ? `${eok}억` : ''}${man ? `${eok ? ' ' : ''}${man.toLocaleString('ko-KR')}만` : ''}원` || '0원';
}

// "🪵 흙수저 · 💼 회사원" 같은 한 줄
function identity(acc) {
  const o = life.originOf(acc && acc.origin);
  const j = life.jobOf(acc && acc.job);
  return `${o.emoji} ${o.name} · ${j.emoji} ${j.name}`;
}

// 출신·직업 뽑기 결과 카드 내용
function lifeCardText(acc) {
  const o = life.originOf(acc.origin);
  const j = life.jobOf(acc.job);
  return `${o.emoji} **${o.name}**${o.weight ? ` (확률 ${o.weight}%)` : ''} — ${o.desc}\n` +
    `　시작 자금 **${won(game.startCashOf(acc))}**\n` +
    `${j.emoji} **${j.name}** (확률 ${j.weight}%)\n` +
    `　매일 출석 보상 **${won(j.pay)}**`;
}

function birthNotice(acc) {
  return { text: `## 🎲 운명이 정해졌어요!\n${lifeCardText(acc)}` };
}

// 환생 확인 화면 (경고)
function rebirthConfirmView(state, user, now, notice) {
  const acc = game.getUser(state, user.id, null, now);
  const v = game.portfolioValue(state, acc, now);
  const st = game.rebirthStatus(acc, now);
  const lose = [
    `현금 ${won(v.cash)}`,
    Object.keys(acc.holdings).length ? `보유 종목 ${Object.keys(acc.holdings).length}개 (${won(v.stock)})` : null,
    acc.futures.length ? `선물 ${acc.futures.length}건` : null,
    acc.options.length ? `옵션 ${acc.options.length}건` : null,
    acc.loans.length ? `대출 ${won(v.loans)}` : null,
  ].filter(Boolean).join(' · ');
  const odds = life.ORIGINS.map((o) => `${o.emoji} ${o.name} ${o.weight}% · ${o.min === o.max ? shortWon(o.min) : `${shortWon(o.min)}~${shortWon(o.max)}`}`).join('\n');
  return {
    v2: [
      v2.noticeContainer(notice),
      v2.container(COLOR_ERR, [
        v2.text('## ⚠️ 정말 환생하시겠어요?\n지금의 인생을 **모두 버리고** 출신과 직업을 처음부터 다시 뽑아요.\n**되돌릴 수 없어요.**'),
        v2.sep(),
        v2.text(`### 사라지는 것\n${identity(acc)}\n순자산 **${won(v.total)}**\n-# ${lose}`),
        v2.sep(),
        v2.text(`### 새로 뽑을 확률\n-# ${odds.replace(/\n/g, '\n-# ')}\n-# 직업은 백수(출석 ${shortWon(life.JOBS[0].pay)})부터 ${life.JOBS[life.JOBS.length - 1].name}(출석 ${shortWon(life.JOBS[life.JOBS.length - 1].pay)})까지`),
        v2.sep(),
        st.ready
          ? v2.text('-# 환생하면 24시간 동안 다시 환생할 수 없어요. 오늘 출석 보상은 이미 받았다면 새 인생에서도 내일부터 받을 수 있어요.')
          : v2.text(`⏳ 아직 환생할 수 없어요. <t:${Math.floor(st.readyAt / 1000)}:R>에 가능해요.`),
        row(
          btn(id('rbok'), '모두 버리고 환생하기', ButtonStyle.Danger, { emoji: '💀', disabled: !st.ready }),
          btn(id('home'), '취소', ButtonStyle.Secondary),
        ),
      ]),
    ],
  };
}

// 직업 다시 뽑기 확인 화면
function jobRollConfirmView(state, user, now, notice) {
  const acc = game.getUser(state, user.id, null, now);
  const cur = life.jobOf(acc.job);
  const ready = game.jobRollStatus(acc, now).ready;
  const odds = life.JOBS.map((j) => `${j.emoji} ${j.name} ${j.weight}% · 출석 ${shortWon(j.pay)}`).join('\n-# ');
  return {
    v2: [
      v2.noticeContainer(notice),
      v2.container(COLOR_INFO, [
        v2.text(`## 🎲 직업 다시 뽑기\n지금 직업: ${cur.emoji} **${cur.name}** · 매일 출석 **${won(cur.pay)}**\n` +
          '새로 뽑으면 **지금 직업은 사라져요.** 더 좋아질 수도, 나빠질 수도 있어요.'),
        v2.sep(),
        v2.text(`### 직업 확률\n-# ${odds}`),
        v2.sep(),
        ready
          ? v2.text('-# 하루에 한 번 뽑을 수 있어요 (자정 KST 초기화). 자산과 출신은 그대로예요.')
          : v2.text('⏳ 오늘은 이미 뽑았어요. 내일(자정 KST) 다시 뽑을 수 있어요.'),
        row(
          btn(id('jrok'), '직업 뽑기', ButtonStyle.Danger, { emoji: '🎲', disabled: !ready }),
          btn(id('home'), '취소', ButtonStyle.Secondary),
        ),
      ]),
    ],
  };
}

function jobRollResultView(state, user, r, now) {
  const up = r.after.pay - r.before.pay;
  return {
    v2: [
      v2.container(up > 0 ? COLOR_OK : up < 0 ? COLOR_ERR : COLOR_INFO, [
        v2.text(`## 🎲 새 직업: ${r.after.emoji} ${r.after.name}!\n` +
          `${r.before.emoji} ${r.before.name} → ${r.after.emoji} **${r.after.name}** (확률 ${r.after.weight}%)\n` +
          `매일 출석 **${won(r.before.pay)}** → **${won(r.after.pay)}** ${up > 0 ? '🎉' : up < 0 ? '😢' : ''}`),
        v2.text('-# 내일(자정 KST) 다시 뽑을 수 있어요.'),
        row(
          btn(id('daily', 'jr'), `출석 +${won(r.after.pay)}`, ButtonStyle.Success, { emoji: '🎁' }),
          btn(id('home'), '홈', ButtonStyle.Secondary, { emoji: '🏠' }),
        ),
      ]),
    ],
  };
}

// 환생 결과 화면
function rebirthResultView(state, user, result, now) {
  const before = life.originOf(result.before.origin);
  const bjob = life.jobOf(result.before.job);
  const next = game.rebirthStatus(result.after, now);
  return {
    v2: [
      v2.container(COLOR_OK, [
        v2.text(`## 🌱 새로운 인생이 시작됐어요!\n-# 이전 인생: ${before.emoji} ${before.name} · ${bjob.emoji} ${bjob.name} · 순자산 ${won(result.before.total)}`),
        v2.sep(),
        v2.text(lifeCardText(result.after)),
        v2.sep(),
        v2.text(`-# 다음 환생은 <t:${Math.floor(next.readyAt / 1000)}:R>에 할 수 있어요.`),
        row(
          btn(id('home'), '새 인생 시작하기', ButtonStyle.Success, { emoji: '🏠' }),
          btn(id('pf'), '내 자산', ButtonStyle.Secondary, { emoji: '💼' }),
        ),
      ]),
    ],
  };
}

// 등락률 → 버튼 색 (한국 증시 관례: 상승 빨강, 하락 파랑, 보합 회색)
function changeStyle(ch) {
  if (ch == null || Math.abs(ch) < 0.005) return ButtonStyle.Secondary;
  return ch > 0 ? ButtonStyle.Danger : ButtonStyle.Primary;
}

function changeLabel(ch) {
  if (ch == null) return '-';
  return `${ch > 0 ? '▲' : ch < 0 ? '▼' : ''} ${Math.abs(ch).toFixed(2)}%`.trim();
}

// 누를 수 있는 히트맵: 종목 버튼을 5개씩 줄로
function heatmapRows(state, ids, key) {
  const assets = ids.map(findAsset).filter(Boolean);
  const rows = [];
  for (let i = 0; i < assets.length; i += 5) {
    rows.push(row(...assets.slice(i, i + 5).map((a) => {
      const ch = changeOf(state, a.id);
      return btn(id('a', a.id, '1d', key), clipLabel(`${a.name.replace(/ \(.*\)$/, '')} ${changeLabel(ch)}`, 80), changeStyle(ch));
    })));
  }
  return rows;
}

// 종목 한 줄 = 이름·가격 + 오른쪽에 누를 수 있는 등락률 버튼
function assetRow(state, a, now, key) {
  const q = quote(state.market, a.id);
  const ch = changeOf(state, a.id);
  const price = q && q.price != null ? won(q.price) : '시세 준비 중';
  const closed = q && q.price != null && !isOpen(state.market, a.id, now) ? ' 💤' : '';
  return v2.section(`**${a.name}**　${price}${closed}\n-# ${a.id} · ${CATEGORIES[a.category]}`,
    { button: btn(id('a', a.id, '1d', key), changeLabel(ch), changeStyle(ch)) });
}

function homeView(state, user, now, notice) {
  const acc = game.getUser(state, user.id, null, now);
  const v = game.portfolioValue(state, acc, now);
  const start = game.startCashOf(acc);
  const profit = v.total - start;
  return {
    v2: [
      v2.noticeContainer(notice),
      v2.container(profit >= 0 ? COLOR_UP : COLOR_DOWN, [
        v2.section(
          `-# 💼 ${user.displayName ?? user.username}님의 주식 터미널 · ${identity(acc)}\n` +
          `# ${won(v.total)}\n` +
          `${fmtPct(pct(start, v.total))} (${signedWon(profit)}) · 시작 자금 ${won(start)} 대비`,
          { thumbnail: user.displayAvatarURL() },
        ),
        v2.text(`💰 현금 **${won(v.cash)}**　📊 투자 **${won(v.stock + v.futures + v.options)}**　💳 대출 **${won(v.loans)}**`),
        v2.sep(),
        v2.text('### 🌐 오늘의 시장\n-# 종목을 누르면 차트·주문 화면으로 가요'),
        ...heatmapRows(state, HOME_HEATMAP, 'h'),
        row(categorySelect()),
        row(
          btn(id('search'), '종목 검색', ButtonStyle.Primary, { emoji: '🔍' }),
          btn(id('pf'), '내 자산', ButtonStyle.Secondary, { emoji: '💼' }),
          btn(id('pos'), '포지션', ButtonStyle.Secondary, { emoji: '📋' }),
          btn(id('rank', 'all'), '랭킹', ButtonStyle.Secondary, { emoji: '🏆' }),
        ),
        row(
          btn(id('daily'), `출석 +${won(life.jobOf(acc.job).pay)}`, ButtonStyle.Success, { emoji: '🎁' }),
          btn(id('help'), '도움말', ButtonStyle.Secondary, { emoji: '❓' }),
          btn(id('home'), '새로고침', ButtonStyle.Secondary, { emoji: '🔄' }),
          btn(id('rb'), '환생', ButtonStyle.Secondary, { emoji: '🌱' }),
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
  // 종목 한 줄 = 이름·가격 + 오른쪽에 누를 수 있는 등락률 버튼
  const rows = items.map((a) => assetRow(state, a, now, 'l'));
  return {
    v2: [
      v2.noticeContainer(notice),
      v2.container(COLOR_INFO, [
        v2.text(`## 📂 ${CATEGORIES[cat]}\n-# ${list.length}종목 · ${p + 1}/${pages} 페이지 · 오른쪽 버튼을 누르면 차트·주문 화면`),
        ...rows,
        row(categorySelect(cat)),
        row(
          btn(id('list', cat, p - 1), '이전', ButtonStyle.Secondary, { emoji: '◀️', disabled: p === 0 }),
          btn(id('noop'), `${p + 1} / ${pages}`, ButtonStyle.Secondary, { disabled: true }),
          btn(id('list', cat, p + 1), '다음', ButtonStyle.Secondary, { emoji: '▶️', disabled: p >= pages - 1 }),
          btn(id('search'), '검색', ButtonStyle.Primary, { emoji: '🔍' }),
          homeBtn(),
        ),
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
  const start = game.startCashOf(acc);
  const profit = v.total - start;
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
      { name: '📈 누적 수익', value: `${signedWon(profit)}\n${fmtPct(pct(start, v.total))}`, inline: true },
      { name: '🏷️ 출신·직업', value: identity(acc), inline: true },
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

// target: 볼 사람 ({ id, displayName?, displayAvatarURL? }), viewerId: 보는 사람
function portfolioView(state, target, now, notice, viewerId = target.id) {
  const mine = target.id === viewerId;
  const acc = game.getUser(state, target.id, null, now);
  const v = game.portfolioValue(state, acc, now);
  const start = game.startCashOf(acc);
  const profit = v.total - start;
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
  const SHOW = 6;
  const rows = holdings.slice(0, SHOW).map(({ hid, a, h, p, value }) => {
    const ch = pct(h.avgPrice, p);
    return v2.section(
      `**${a ? a.name : hid}**　${won(value)}\n-# ${fmtQty(a, h.qty)} · 평단 ${won(h.avgPrice)} · ${signedWon((p - h.avgPrice) * h.qty)}`,
      { button: btn(id('a', hid, '1d', 'pf'), changeLabel(ch), changeStyle(ch)) },
    );
  });
  const rest = holdings.slice(SHOW, SHOW + 25);
  const name = mine ? `${target.displayName ?? target.username}님` : `<@${target.id}>님`;
  const avatar = typeof target.displayAvatarURL === 'function' ? target.displayAvatarURL() : null;
  const header = `-# 💼 ${name}의 자산 · ${identity(acc)}\n# ${won(v.total)}\n` +
    `${fmtPct(pct(start, v.total))} (${signedWon(profit)}) · 시작 자금 ${won(start)} · 실현 손익 ${signedWon(acc.realized)}`;

  const buttons = mine
    ? [
      btn(id('pos'), '포지션', ButtonStyle.Secondary, { emoji: '📋' }),
      btn(id('rank', 'all'), '랭킹', ButtonStyle.Secondary, { emoji: '🏆' }),
      homeBtn(),
      btn(id('share', 'pf'), '채널에 공유', ButtonStyle.Success, { emoji: '📢' }),
    ]
    : [btn(id('rank', 'all'), '랭킹으로', ButtonStyle.Secondary, { emoji: '⬅️' }), homeBtn()];
  // 인생 관련 버튼은 둘째 줄 (한 줄에 버튼 최대 5개)
  const lifeButtons = mine
    ? [
      btn(id('jr', 'pf'), '직업 뽑기', ButtonStyle.Secondary, { emoji: '🎲' }),
      btn(id('rb', 'pf'), '환생', ButtonStyle.Secondary, { emoji: '🌱' }),
    ]
    : [];
  if (mine && v.total < game.BANKRUPT_LIMIT) lifeButtons.push(btn(id('bankrupt'), '파산 신청', ButtonStyle.Danger, { emoji: '💀' }));

  return {
    v2: [
      v2.noticeContainer(notice),
      v2.container(profit >= 0 ? COLOR_UP : COLOR_DOWN, [
        avatar ? v2.section(header, { thumbnail: avatar }) : v2.text(header),
        v2.sep(),
        v2.text(`### 자산 구성\n${mix.join('\n')}`),
        v2.sep(),
        v2.text(`### 보유 종목 (${holdings.length})\n-# ${holdings.length ? '오른쪽 버튼(평단 대비 수익률)을 누르면 차트·매도 화면' : '아직 없어요. 홈에서 종목을 골라 매수해 보세요!'}`),
        ...rows,
        rest.length ? row(new StringSelectMenuBuilder()
          .setCustomId(id('pick', 'pf'))
          .setPlaceholder(`나머지 ${rest.length}종목 보기`)
          .addOptions(rest.map(({ hid, a, h }) => ({ label: clipLabel(a ? a.name : hid), value: hid, description: fmtQty(a, h.qty) })))) : null,
        row(...buttons),
        lifeButtons.length ? row(...lifeButtons) : null,
      ]),
    ],
    allowedMentions: { parse: [] },
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
  const ratio = v.loans > 0 ? v.assets / v.loans : null;

  // 정리 확인 화면
  if (selected) {
    const [kind, pid] = String(selected).split(':');
    const item = kind === 'f' ? acc.futures.find((x) => String(x.id) === pid) : acc.options.find((x) => String(x.id) === pid);
    if (item) {
      const detail = kind === 'f' ? futuresLine(state, item) : optionLine(state, item, now);
      const value = kind === 'f' ? game.futuresEquity(state, item) : game.optionValue(state, item, now);
      return {
        v2: [
          v2.noticeContainer(notice),
          v2.container(COLOR_ERR, [
            v2.text(`## ${kind === 'f' ? '⚡ 선물 청산' : '🎯 옵션 매도'} 확인\n${detail}\n\n지금 정리하면 약 **${won(value)}**을 돌려받아요 (수수료 별도).`),
            row(
              btn(id('closeok', selected), kind === 'f' ? '청산하기' : '매도하기', ButtonStyle.Danger, { emoji: '✅' }),
              btn(id('pos'), '취소', ButtonStyle.Secondary),
            ),
          ]),
        ],
      };
    }
  }

  const items = [
    ...acc.futures.map((p) => {
      const price = quote(state.market, p.asset)?.price ?? p.entry;
      const pnl = game.futuresPnl(p, price);
      return v2.section(futuresLine(state, p).replace('\n　', '\n-# '),
        { button: btn(id('closeb', `f:${p.id}`), `${signedWon(pnl)} · 청산`, changeStyle(pnl)) });
    }),
    ...acc.options.map((o) => {
      const val = game.optionValue(state, o, now);
      const pnl = val - o.premium * o.qty;
      return v2.section(optionLine(state, o, now).replace('\n　', '\n-# '),
        { button: btn(id('closeb', `o:${o.id}`), `${signedWon(pnl)} · 매도`, changeStyle(pnl)) });
    }),
  ];
  const SHOW = 7;
  const restChoices = [
    ...acc.futures.map((p) => ({ label: clipLabel(`#${p.id} 선물 ${findAsset(p.asset)?.name || p.asset} ${p.side > 0 ? '롱' : '숏'} ${p.leverage}배`), value: `f:${p.id}` })),
    ...acc.options.map((o) => ({ label: clipLabel(`#${o.id} 옵션 ${findAsset(o.asset)?.name || o.asset} ${o.kind === 'call' ? '콜' : '풋'}`), value: `o:${o.id}` })),
  ].slice(SHOW, SHOW + 25);

  const loanText = acc.loans.length
    ? `**💳 대출 ${won(v.loans)}**\n-# ${acc.loans.map((l) => (l.type === 'misu' ? `미수 ${won(l.amount)} (결제 ${rel(l.dueAt)})` : `신용 ${won(l.amount)}`)).join(' · ')}` +
      (ratio ? `\n담보비율 ${v2.bar(Math.min(1, ratio / 3))} **${(ratio * 100).toFixed(0)}%** ${ratio < game.MAINTENANCE_RATIO * 1.15 ? '⚠️ 반대매매 주의' : ''}\n-# ${game.MAINTENANCE_RATIO * 100}% 미만이면 반대매매` : '')
    : '**💳 대출** 없음';

  return {
    v2: [
      v2.noticeContainer(notice),
      v2.container(COLOR_INFO, [
        v2.text(`## 📋 내 포지션\n⚡ 선물 **${acc.futures.length}건** ${won(v.futures)}　🎯 옵션 **${acc.options.length}건** ${won(v.options)}\n` +
          `-# ${items.length ? '오른쪽 버튼(평가손익)을 누르면 정리 확인 화면이 나와요' : '선물·옵션은 종목 화면의 롱/숏/옵션 버튼으로 시작해요'}`),
        ...items.slice(0, SHOW),
        restChoices.length ? row(new StringSelectMenuBuilder().setCustomId(id('close')).setPlaceholder(`나머지 ${restChoices.length}건 정리하기`).addOptions(restChoices)) : null,
        v2.sep(),
        acc.loans.length
          ? v2.section(loanText, { button: btn(id('repay'), '상환', ButtonStyle.Primary, { emoji: '💳' }) })
          : v2.text(loanText),
        v2.sep(),
        row(
          btn(id('pf'), '내 자산', ButtonStyle.Secondary, { emoji: '💼' }),
          btn(id('pos'), '새로고침', ButtonStyle.Secondary, { emoji: '🔄' }),
          homeBtn(),
        ),
      ]),
    ],
  };
}

// ── 랭킹 ─────────────────────────────────────────────────────

function rankingEmbed(state, scope, guildId, now) {
  const medals = ['🥇', '🥈', '🥉'];
  const rows = game.ranking(state, scope === 'guild' ? guildId : null, 10, now).map((r, i) =>
    `${medals[i] || `**${i + 1}.**`} ${life.originOf(state.users[r.userId]?.origin).emoji} <@${r.userId}> — ${won(r.total)} (${fmtPct(pct(game.startCashOf(state.users[r.userId]), r.total))})`);
  return new EmbedBuilder()
    .setTitle(scope === 'guild' ? '🏆 이 서버 순자산 랭킹' : '🏆 전체 서버 순자산 랭킹')
    .setColor(COLOR_INFO)
    .setDescription(rows.length ? rows.join('\n') : '아직 참가자가 없어요.');
}

function rankingView(state, scope, guildId, now, notice, viewerId) {
  const g = scope === 'guild' ? guildId : null;
  const all = game.ranking(state, g, Infinity, now);
  const medals = ['🥇', '🥈', '🥉'];
  const rows = all.slice(0, 10).map((r, i) => {
    const acc = state.users[r.userId];
    const start = game.startCashOf(acc);
    const ret = pct(start, r.total);
    return v2.section(`${medals[i] || `**${i + 1}위**`} <@${r.userId}>${r.userId === viewerId ? ' (나)' : ''}\n-# ${identity(acc)} · 순자산 ${won(r.total)} · ${signedWon(r.total - start)}`,
      { button: btn(id('pfu', r.userId), changeLabel(ret), changeStyle(ret)) });
  });
  const myRank = all.findIndex((r) => r.userId === viewerId);
  const me = myRank >= 0 ? `내 순위 **${myRank + 1}위** / ${all.length}명 · ${won(all[myRank].total)}` : `참가자 ${all.length}명`;
  return {
    v2: [
      v2.noticeContainer(notice),
      v2.container(COLOR_INFO, [
        v2.text(`## 🏆 ${scope === 'guild' ? '이 서버' : '전체 서버'} 순자산 랭킹\n${me}\n-# 오른쪽 버튼(수익률)을 누르면 그 사람의 자산을 볼 수 있어요`),
        ...(rows.length ? rows : [v2.text('아직 참가자가 없어요.')]),
        row(
          btn(id('rank', 'all'), '전체 서버', scope === 'guild' ? ButtonStyle.Secondary : ButtonStyle.Primary),
          btn(id('rank', 'guild'), '이 서버', scope === 'guild' ? ButtonStyle.Primary : ButtonStyle.Secondary),
          homeBtn(),
          btn(id('share', 'rank', scope), '채널에 공유', ButtonStyle.Success, { emoji: '📢' }),
        ),
      ]),
    ],
    allowedMentions: { parse: [] },
  };
}

// ── 도움말 ───────────────────────────────────────────────────

function helpView() {
  const go = (cid, label, emoji) => btn(cid, label, ButtonStyle.Secondary, { emoji });
  return {
    v2: [
      v2.container(COLOR_INFO, [
        v2.text(`## 📘 주식 게임 도움말\n처음 쓰면 **출신**(시작 자금)과 **직업**(매일 출석 보상)을 랜덤으로 뽑아요. 계좌는 봇이 있는 **모든 서버에서 공용**이에요.\n` +
          `실제 시세 ${ASSETS.length}종목을 **24시간** 거래해요. 💤 장 마감 종목은 마지막 종가로 거래돼요.`),
        v2.sep(),
        v2.section('**📈 시세 보기**\n-# 분류별 목록 → 종목 → 차트·주문', { button: go(id('list', 'kr', 0), '한국 주식', '📂') }),
        v2.section('**🛒 현물 매수·매도**\n-# 주문창에서 버튼으로 수량을 고르면 결과를 미리 보여 주고, [실행]을 눌러야 체결돼요', { button: go(id('search'), '종목 검색', '🔍') }),
        v2.section(`**💳 신용·미수**\n-# 신용: 내 돈 ${game.CREDIT_MARGIN * 100}% + 대출(연 ${game.CREDIT_RATE * 100}%) · 미수: 증거금 ${game.MISU_MARGIN * 100}%, ${game.MISU_DAYS}일 내 결제 · 담보비율 ${game.MAINTENANCE_RATIO * 100}% 미만이면 반대매매`, { button: go(id('pos', 'loan'), '대출 보기', '💳') }),
        v2.section(`**⚡ 선물 (롱/숏)**\n-# 롱=상승, 숏=하락 베팅 · 최대 ${game.MAX_LEVERAGE}배 · 손실이 증거금 ${game.LIQUIDATION_LOSS * 100}%에 닿으면 강제청산`, { button: go(id('pos', 'fut'), '포지션', '📋') }),
        v2.section('**🎯 옵션 (콜/풋)**\n-# 콜=오를수록, 풋=내릴수록 이익 · 손실은 산 가격까지만 · 만기(1시간/1일/1주)에 자동 정산', { button: go(id('pos', 'opt'), '포지션', '🎯') }),
        v2.section('**🏆 랭킹 · 🎁 출석**\n-# 순자산 순위 · 출석 보상은 직업마다 달라요 (하루 한 번)', { button: go(id('rank', 'all'), '랭킹', '🏆') }),
        v2.section('**🎲 직업 다시 뽑기**\n-# 하루 한 번, 직업(출석 보상)만 다시 뽑아요 (`/직업랜덤뽑기`)', { button: go(id('jr', 'help'), '직업 뽑기', '🎲') }),
        v2.section('**🌱 환생**\n-# 24시간에 한 번, 모든 자산을 버리고 출신·직업을 다시 뽑아요 (`/환생`)', { button: go(id('rb', 'help'), '환생', '🌱') }),
        v2.text('-# 🔔 반대매매·강제청산·옵션 만기는 DM으로 알려 드려요 (서버 DM 허용 필요)'),
        row(homeBtn()),
      ]),
    ],
  };
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
  const shown = hits.slice(0, 8);
  return {
    v2: [
      v2.container(COLOR_INFO, [
        v2.text(`## 🔍 "${clipLabel(query, 50)}" 검색 결과 (${hits.length})\n-# ${hits.length ? '오른쪽 버튼을 누르면 차트·주문 화면' : '찾는 종목이 없어요. 다른 이름으로 검색해 보세요.'}`),
        ...shown.map((a) => assetRow(state, a, now, 's')),
        hits.length > shown.length ? row(new StringSelectMenuBuilder()
          .setCustomId(id('pick', 'search'))
          .setPlaceholder(`나머지 ${hits.length - shown.length}종목`)
          .addOptions(hits.slice(8, 33).map((a) => ({ label: clipLabel(a.name), value: a.id, description: `${CATEGORIES[a.category]} · ${a.id}` })))) : null,
        row(btn(id('search'), '다시 검색', ButtonStyle.Primary, { emoji: '🔍' }), homeBtn()),
      ]),
    ],
  };
}

module.exports = {
  id, homeView, listView, assetView, assetEmbed, portfolioView, portfolioEmbed, positionsView, rankingView, rankingEmbed,
  helpView, searchModal, repayModal, searchResultView, chartUrl, RANGES,
  rebirthConfirmView, rebirthResultView, birthNotice, identity, jobRollConfirmView, jobRollResultView,
};
