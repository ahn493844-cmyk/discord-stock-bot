// 슬래시 명령어 정의와 처리

const {
  SlashCommandBuilder, EmbedBuilder, MessageFlags, InteractionContextType,
} = require('discord.js');
const game = require('./game');
const { ASSETS, CATEGORIES, findAsset, searchAssets, unitOf } = require('./assets');
const { quote, marketStatus } = require('./market');

const { won, fmtQty } = game;
const COLOR_UP = 0xe03131;   // 한국 증시 관례: 상승 빨강
const COLOR_DOWN = 0x1c7ed6; // 하락 파랑
const COLOR_INFO = 0xf59f00;

const MODE_LABEL = { cash: '현금', credit: '신용', misu: '미수' };

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

function sparkline(values) {
  const bars = '▁▂▃▄▅▆▇█';
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return bars[3].repeat(values.length);
  return values.map((v) => bars[Math.round(((v - min) / (max - min)) * (bars.length - 1))]).join('');
}

function clip(text, max = 1024) {
  return text.length <= max ? text : `${text.slice(0, max - 2)}…`;
}

// ── 명령어 정의 ──────────────────────────────────────────────

const assetOpt = (o) => o.setName('종목').setDescription('종목 이름이나 코드 (예: 삼성전자, AAPL, 비트코인)')
  .setRequired(true).setAutocomplete(true);
const qtyOpt = (o) => o.setName('수량').setDescription('10, 0.5, 전부, 절반, 30%, 10만원(금액만큼)').setRequired(true);
const posOpt = (o) => o.setName('포지션').setDescription('포지션 번호 (/포지션 에서 확인)').setRequired(true).setAutocomplete(true);
const kindOpt = (o) => o.setName('종류').setDescription('콜: 오를 때 이익 / 풋: 내릴 때 이익').setRequired(true)
  .addChoices({ name: '콜 (상승 베팅)', value: 'call' }, { name: '풋 (하락 베팅)', value: 'put' });
const expiryOpt = (o) => o.setName('만기').setDescription('만기까지 남은 시간').setRequired(true)
  .addChoices(...Object.entries(game.OPTION_EXPIRIES).map(([value, e]) => ({ name: e.label, value })));
const strikeOpt = (o) => o.setName('행사가').setDescription('현재가(기본), +5%, -10%, 75000, 7.5만');

const definitions = [
  new SlashCommandBuilder().setName('시세').setDescription('실시간 시세를 봅니다')
    .addStringOption((o) => o.setName('분류').setDescription('보고 싶은 분류만')
      .addChoices(...Object.entries(CATEGORIES).map(([value, name]) => ({ name, value })))),
  new SlashCommandBuilder().setName('차트').setDescription('종목의 최근 가격 흐름을 봅니다').addStringOption(assetOpt),
  new SlashCommandBuilder().setName('매수').setDescription('현물을 삽니다 (현금·신용·미수)')
    .addStringOption(assetOpt).addStringOption(qtyOpt)
    .addStringOption((o) => o.setName('방식').setDescription('기본: 현금')
      .addChoices(
        { name: '현금', value: 'cash' },
        { name: `신용 (본인 ${game.CREDIT_MARGIN * 100}% + 대출, 연 ${game.CREDIT_RATE * 100}% 이자)`, value: 'credit' },
        { name: `미수 (증거금 ${game.MISU_MARGIN * 100}%, ${game.MISU_DAYS}일 내 결제)`, value: 'misu' },
      )),
  new SlashCommandBuilder().setName('매도').setDescription('현물을 팝니다 (판 돈으로 대출 자동 상환)')
    .addStringOption(assetOpt).addStringOption(qtyOpt),
  new SlashCommandBuilder().setName('상환').setDescription('신용·미수 대출을 현금으로 갚습니다')
    .addStringOption((o) => o.setName('금액').setDescription('기본: 전부 (예: 50만, 절반)')),
  new SlashCommandBuilder().setName('선물진입').setDescription('레버리지 선물 포지션을 엽니다 (롱/숏)')
    .addStringOption(assetOpt)
    .addStringOption((o) => o.setName('방향').setDescription('롱: 상승 베팅 / 숏: 하락 베팅').setRequired(true)
      .addChoices({ name: '롱 (상승)', value: 'long' }, { name: '숏 (하락)', value: 'short' }))
    .addStringOption((o) => o.setName('증거금').setDescription('넣을 돈 (예: 10만, 전부, 30%)').setRequired(true))
    .addIntegerOption((o) => o.setName('레버리지').setDescription(`1~${game.MAX_LEVERAGE}배`).setRequired(true)
      .setMinValue(1).setMaxValue(game.MAX_LEVERAGE)),
  new SlashCommandBuilder().setName('선물청산').setDescription('선물 포지션을 닫습니다').addStringOption(posOpt),
  new SlashCommandBuilder().setName('옵션시세').setDescription('옵션 가격을 미리 봅니다')
    .addStringOption(assetOpt).addStringOption(kindOpt).addStringOption(expiryOpt).addStringOption(strikeOpt),
  new SlashCommandBuilder().setName('옵션매수').setDescription('콜/풋 옵션을 삽니다')
    .addStringOption(assetOpt).addStringOption(kindOpt).addStringOption(expiryOpt)
    .addStringOption((o) => o.setName('수량').setDescription('기초자산 몇 주(개)분인지 (예: 10, 전부, 10만원)').setRequired(true))
    .addStringOption(strikeOpt),
  new SlashCommandBuilder().setName('옵션매도').setDescription('만기 전에 옵션을 팝니다').addStringOption(posOpt),
  new SlashCommandBuilder().setName('내정보').setDescription('내 자산과 보유 종목을 봅니다')
    .addUserOption((o) => o.setName('유저').setDescription('다른 사람의 정보를 볼 수도 있어요')),
  new SlashCommandBuilder().setName('포지션').setDescription('내 선물·옵션·대출 현황을 봅니다'),
  new SlashCommandBuilder().setName('랭킹').setDescription('순자산 순위를 봅니다')
    .addStringOption((o) => o.setName('범위').setDescription('기본: 전체 서버')
      .addChoices({ name: '전체 서버', value: 'all' }, { name: '이 서버', value: 'guild' })),
  new SlashCommandBuilder().setName('출석').setDescription(`하루 한 번 ${won(game.DAILY_BONUS)}을 받습니다`),
  new SlashCommandBuilder().setName('파산신청')
    .setDescription(`순자산이 ${won(game.BANKRUPT_LIMIT)} 미만이면 초기 자금으로 다시 시작합니다`),
  new SlashCommandBuilder().setName('도움말').setDescription('주식 게임 사용법을 봅니다'),
].map((c) => c.setContexts(InteractionContextType.Guild).toJSON());

// ── 임베드 ───────────────────────────────────────────────────

function rawPrice(asset, q) {
  if (asset.currency === 'USD' && q.raw != null) return `$${q.raw.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  return null;
}

function marketEmbed(state, category, now) {
  const cats = category ? [category] : Object.keys(CATEGORIES);
  const e = new EmbedBuilder().setTitle('📈 실시간 시세').setColor(COLOR_INFO);
  for (const c of cats) {
    const lines = ASSETS.filter((a) => a.category === c).map((a) => {
      const q = quote(state.market, a.id);
      if (q.price == null) return `**${a.name}** · 시세 준비 중`;
      const closed = marketStatus(state.market, a.id, now) !== '거래 중' ? ' 💤' : '';
      return `**${a.name}** ${won(q.price)} ${q.prevClose ? fmtPct(pct(q.prevClose, q.price)) : ''}${closed}`;
    });
    e.addFields({ name: CATEGORIES[c], value: clip(lines.join('\n')) });
  }
  const fx = state.market.usdKrw ? ` · 환율 $1 = ${won(state.market.usdKrw)}` : '';
  return e.setFooter({ text: `등락률은 전일 종가 대비 · 💤 장 마감${fx}` }).setTimestamp(now);
}

function chartEmbed(state, asset, now) {
  const q = quote(state.market, asset.id);
  const hist = q.history.slice(-60);
  const change = q.prevClose ? pct(q.prevClose, q.price) : 0;
  const e = new EmbedBuilder()
    .setTitle(`${asset.name} (${asset.id}) · ${CATEGORIES[asset.category]}`)
    .setColor(change >= 0 ? COLOR_UP : COLOR_DOWN)
    .setDescription(hist.length >= 2 ? `\`\`\`\n${sparkline(hist)}\n\`\`\`` : '차트 데이터를 모으는 중이에요. 잠시 후 다시 확인해 주세요.')
    .addFields(
      { name: '현재가', value: q.price == null ? '시세 준비 중' : won(q.price), inline: true },
      { name: '전일 대비', value: q.prevClose ? fmtPct(change) : '-', inline: true },
      { name: '상태', value: marketStatus(state.market, asset.id, now), inline: true },
    );
  const raw = rawPrice(asset, q);
  if (raw) e.addFields({ name: '원본 시세', value: raw, inline: true });
  if (hist.length >= 2) {
    e.addFields(
      { name: '구간 최고', value: won(Math.max(...hist)), inline: true },
      { name: '구간 최저', value: won(Math.min(...hist)), inline: true },
    );
  }
  return e.setFooter({ text: `최근 ${hist.length}틱 기준` }).setTimestamp(q.updatedAt || now);
}

function profileEmbed(state, user, now) {
  const acc = game.getUser(state, user.id, null, now);
  const v = game.portfolioValue(state, acc, now);
  const profit = v.total - game.START_CASH;
  const holdings = Object.entries(acc.holdings).map(([id, h]) => {
    const a = findAsset(id);
    const p = quote(state.market, id)?.price ?? h.avgPrice;
    return `**${a ? a.name : id}** ${fmtQty(a, h.qty)} · 평단 ${won(h.avgPrice)} → ${won(p)} ` +
      `(${signedWon((p - h.avgPrice) * h.qty)}, ${fmtPct(pct(h.avgPrice, p))})`;
  });
  const fields = [
    { name: '💰 현금', value: won(v.cash), inline: true },
    { name: '📊 현물 평가', value: won(v.stock), inline: true },
    { name: '🏦 순자산', value: won(v.total), inline: true },
    { name: '📈 선물 평가', value: `${won(v.futures)} (${acc.futures.length}건)`, inline: true },
    { name: '🎯 옵션 평가', value: `${won(v.options)} (${acc.options.length}건)`, inline: true },
    { name: '💳 대출', value: won(v.loans), inline: true },
    { name: '누적 수익', value: `${signedWon(profit)} (${fmtPct(pct(game.START_CASH, v.total))})`, inline: true },
    { name: '실현 손익', value: signedWon(acc.realized), inline: true },
    { name: '​', value: '​', inline: true },
    { name: '보유 현물', value: clip(holdings.length ? holdings.join('\n') : '아직 없어요. `/매수`로 시작해 보세요!') },
  ];
  return new EmbedBuilder()
    .setAuthor({ name: `${user.displayName ?? user.username}님의 계좌`, iconURL: user.displayAvatarURL() })
    .setColor(profit >= 0 ? COLOR_UP : COLOR_DOWN)
    .addFields(fields)
    .setFooter({ text: '선물·옵션·대출 자세히: /포지션' });
}

function futuresLine(state, pos) {
  const a = findAsset(pos.asset);
  const p = quote(state.market, pos.asset)?.price ?? pos.entry;
  const pnl = game.futuresPnl(pos, p);
  return `\`#${pos.id}\` **${a ? a.name : pos.asset}** ${pos.side > 0 ? '롱' : '숏'} ${pos.leverage}배 · 증거금 ${won(pos.margin)}\n` +
    `　진입 ${won(pos.entry)} → ${won(p)} · 손익 ${signedWon(pnl)} (${fmtPct((pnl / pos.margin) * 100)}) · 청산가 ${won(game.liquidationPrice(pos))}`;
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

function positionsEmbed(state, userId, now) {
  const acc = game.getUser(state, userId, null, now);
  const v = game.portfolioValue(state, acc, now);
  const ratio = v.loans > 0 ? `담보비율 ${((v.assets / v.loans) * 100).toFixed(0)}% (기준 ${game.MAINTENANCE_RATIO * 100}% 미만 시 반대매매)` : '';
  return new EmbedBuilder()
    .setTitle('📋 내 포지션')
    .setColor(COLOR_INFO)
    .addFields(
      { name: `선물 (${acc.futures.length})`, value: clip(acc.futures.map((p) => futuresLine(state, p)).join('\n') || '없음') },
      { name: `옵션 (${acc.options.length})`, value: clip(acc.options.map((o) => optionLine(state, o, now)).join('\n') || '없음') },
      { name: `대출 (${won(v.loans)})`, value: clip([...acc.loans.map(loanLine), ratio].filter(Boolean).join('\n') || '없음') },
    )
    .setFooter({ text: '선물 닫기: /선물청산 · 옵션 팔기: /옵션매도 · 대출 갚기: /상환' });
}

function rankingEmbed(state, guildId, now) {
  const medals = ['🥇', '🥈', '🥉'];
  const rows = game.ranking(state, guildId, 10, now).map((r, i) =>
    `${medals[i] || `**${i + 1}.**`} <@${r.userId}> — ${won(r.total)} (${fmtPct(pct(game.START_CASH, r.total))})`);
  return new EmbedBuilder()
    .setTitle(guildId ? '🏆 이 서버 순자산 랭킹' : '🏆 전체 서버 순자산 랭킹')
    .setColor(COLOR_INFO)
    .setDescription(rows.length ? rows.join('\n') : '아직 참가자가 없어요. `/매수`나 `/출석`으로 참가해 보세요!');
}

function helpEmbed() {
  return new EmbedBuilder()
    .setTitle('📘 주식 게임 도움말')
    .setColor(COLOR_INFO)
    .setDescription(
      `처음 명령어를 쓰면 **${won(game.START_CASH)}**으로 계좌가 열려요. 계좌는 봇이 있는 **모든 서버에서 공용**이에요.\n` +
      '시세는 **실제 시장 가격**(한국·미국 주식, 코인, ETF, 금, 환율)이고, 미국 상품은 원화로 환산돼요.\n' +
      '장이 닫힌 상품(💤)은 거래할 수 없어요. 코인은 24시간 거래돼요.\n​')
    .addFields(
      { name: '📈 시세', value: '`/시세 [분류]` · `/차트 종목`' },
      { name: '🛒 현물', value: '`/매수 종목 수량 [방식]` · `/매도 종목 수량`\n수량: `10`, `0.01`, `전부`, `절반`, `30%`, `10만원`' },
      {
        name: '💳 신용·미수',
        value: `**신용**: 본인 돈 ${game.CREDIT_MARGIN * 100}% + 대출, 연 ${game.CREDIT_RATE * 100}% 이자\n` +
          `**미수**: 증거금 ${game.MISU_MARGIN * 100}%만 내고 사서 ${game.MISU_DAYS}일 안에 결제 (못 하면 반대매매)\n` +
          `대출 한도 순자산 ×${game.LOAN_LIMIT_RATIO} · 담보비율 ${game.MAINTENANCE_RATIO * 100}% 미만이면 반대매매 · \`/상환\``,
      },
      {
        name: '⚡ 선물 (마진거래)',
        value: `\`/선물진입 종목 방향 증거금 레버리지\` · \`/선물청산 포지션\`\n` +
          `롱=상승, 숏=하락 베팅 · 최대 ${game.MAX_LEVERAGE}배 · 손실이 증거금 ${game.LIQUIDATION_LOSS * 100}%에 닿으면 강제청산`,
      },
      {
        name: '🎯 옵션',
        value: '`/옵션시세` · `/옵션매수 종목 종류 만기 수량 [행사가]` · `/옵션매도 포지션`\n' +
          '콜=오를수록, 풋=내릴수록 이익 · 손실은 산 가격까지만 · 만기에 자동 정산',
      },
      { name: '👤 기타', value: '`/내정보` · `/포지션` · `/랭킹 [범위]` · `/출석` · `/파산신청`' },
    )
    .setFooter({ text: '반대매매·강제청산·만기 정산은 DM으로 알려 드려요 (DM 허용 시)' });
}

function buyEmbed(r) {
  const e = new EmbedBuilder()
    .setColor(COLOR_UP)
    .setTitle(`🛒 ${MODE_LABEL[r.mode]} 매수 체결 — ${r.asset.name}`)
    .addFields(
      { name: '체결가', value: won(r.price), inline: true },
      { name: '수량', value: fmtQty(r.asset, r.qty), inline: true },
      { name: '수수료', value: won(r.fee), inline: true },
      { name: '결제 금액', value: won(r.cost + r.fee), inline: true },
      { name: '보유', value: `${fmtQty(r.asset, r.holding.qty)} (평단 ${won(r.holding.avgPrice)})`, inline: true },
      { name: '남은 현금', value: won(r.cash), inline: true },
    );
  if (r.loan) {
    e.addFields({
      name: r.loan.type === 'misu' ? '미수 (결제 필요)' : '신용 대출',
      value: r.loan.type === 'misu' ? `${won(r.loan.amount)} · 결제일 ${rel(r.loan.dueAt)}` : `${won(r.loan.amount)} · 연 ${game.CREDIT_RATE * 100}%`,
    });
  }
  return e;
}

function sellEmbed(r) {
  const e = new EmbedBuilder()
    .setColor(COLOR_DOWN)
    .setTitle(`💸 매도 체결 — ${r.asset.name}`)
    .addFields(
      { name: '체결가', value: won(r.price), inline: true },
      { name: '수량', value: fmtQty(r.asset, r.qty), inline: true },
      { name: '수수료', value: won(r.fee), inline: true },
      { name: '정산 금액', value: won(r.revenue - r.fee), inline: true },
      { name: '실현 손익', value: signedWon(r.profit), inline: true },
      { name: '남은 현금', value: won(r.cash), inline: true },
    );
  if (r.repaid > 0) e.addFields({ name: '대출 자동 상환', value: won(r.repaid) });
  return e;
}

function optionQuoteEmbed(q, title) {
  const be = q.kind === 'call' ? q.strike + q.premium : q.strike - q.premium;
  return new EmbedBuilder()
    .setColor(q.kind === 'call' ? COLOR_UP : COLOR_DOWN)
    .setTitle(`${title} — ${q.asset.name} ${q.kind === 'call' ? '콜' : '풋'}`)
    .addFields(
      { name: '현재가', value: won(q.spot), inline: true },
      { name: '행사가', value: won(q.strike), inline: true },
      { name: '만기', value: `${q.expiryLabel} (${rel(q.expiry)})`, inline: true },
      { name: `1${unitOf(q.asset)}당 가격`, value: won(q.premium), inline: true },
      { name: '손익분기점', value: won(be), inline: true },
    );
}

// ── 처리 ─────────────────────────────────────────────────────

// 명령 처리. 상태가 바뀌었으면 true를 반환해 저장을 요청한다.
async function handle(interaction, ctx) {
  const { state } = ctx;
  const now = Date.now();
  const gid = interaction.guildId;
  const uid = interaction.user.id;
  const opt = interaction.options;
  const assetArg = () => {
    const a = findAsset(opt.getString('종목', true));
    if (!a) throw new game.GameError('목록에 있는 종목을 골라 주세요. (이름을 입력하면 자동완성이 나와요)');
    return a;
  };

  try {
    switch (interaction.commandName) {
      case '시세':
        await interaction.reply({ embeds: [marketEmbed(state, opt.getString('분류'), now)] });
        return false;
      case '차트':
        await interaction.reply({ embeds: [chartEmbed(state, assetArg(), now)] });
        return false;
      case '매수': {
        const r = game.buy(state, uid, gid, assetArg().id, opt.getString('수량', true), opt.getString('방식') || 'cash', now);
        await interaction.reply({ embeds: [buyEmbed(r)] });
        return true;
      }
      case '매도': {
        const r = game.sell(state, uid, gid, assetArg().id, opt.getString('수량', true), now);
        await interaction.reply({ embeds: [sellEmbed(r)] });
        return true;
      }
      case '상환': {
        const r = game.repay(state, uid, gid, opt.getString('금액') || '전부');
        await interaction.reply(`💳 대출 **${won(r.paid)}** 상환 완료. 남은 대출: ${won(r.remaining)} · 현금: ${won(r.cash)}`);
        return true;
      }
      case '선물진입': {
        const r = game.openFuture(state, uid, gid, assetArg().id, opt.getString('방향', true),
          opt.getString('증거금', true), opt.getInteger('레버리지', true), now);
        await interaction.reply({
          embeds: [new EmbedBuilder()
            .setColor(r.pos.side > 0 ? COLOR_UP : COLOR_DOWN)
            .setTitle(`⚡ 선물 ${r.pos.side > 0 ? '롱' : '숏'} ${r.pos.leverage}배 진입 — ${r.asset.name}`)
            .addFields(
              { name: '포지션 번호', value: `#${r.pos.id}`, inline: true },
              { name: '진입가', value: won(r.pos.entry), inline: true },
              { name: '증거금', value: won(r.pos.margin), inline: true },
              { name: '포지션 규모', value: won(r.pos.margin * r.pos.leverage), inline: true },
              { name: '청산가', value: won(r.liqPrice), inline: true },
              { name: '수수료', value: won(r.fee), inline: true },
            )],
        });
        return true;
      }
      case '선물청산': {
        const r = game.closeFuture(state, uid, gid, opt.getString('포지션', true), now);
        await interaction.reply({
          embeds: [new EmbedBuilder()
            .setColor(r.pnl >= 0 ? COLOR_UP : COLOR_DOWN)
            .setTitle(`✅ 선물 #${r.pos.id} 청산 — ${r.asset.name}`)
            .addFields(
              { name: '진입가 → 청산가', value: `${won(r.pos.entry)} → ${won(r.price)}`, inline: true },
              { name: '손익', value: `${signedWon(r.pnl)} (${fmtPct((r.pnl / r.pos.margin) * 100)})`, inline: true },
              { name: '돌려받은 금액', value: `${won(r.payout)} (수수료 ${won(r.fee)})`, inline: true },
            )],
        });
        return true;
      }
      case '옵션시세': {
        const q = game.quoteOption(state, assetArg().id, opt.getString('종류', true), opt.getString('행사가'),
          opt.getString('만기', true), now);
        await interaction.reply({ embeds: [optionQuoteEmbed(q, '🔎 옵션 시세')], flags: MessageFlags.Ephemeral });
        return false;
      }
      case '옵션매수': {
        const r = game.buyOption(state, uid, gid, assetArg().id, opt.getString('종류', true), opt.getString('행사가'),
          opt.getString('만기', true), opt.getString('수량', true), now);
        await interaction.reply({
          embeds: [optionQuoteEmbed(r, `🎯 옵션 #${r.opt.id} 매수`).addFields(
            { name: '수량', value: `${fmtQty(r.asset, r.qty)}분`, inline: true },
            { name: '결제 금액', value: `${won(r.cost + r.fee)} (수수료 ${won(r.fee)})`, inline: true },
            { name: '남은 현금', value: won(r.cash), inline: true },
          )],
        });
        return true;
      }
      case '옵션매도': {
        const r = game.sellOption(state, uid, gid, opt.getString('포지션', true), now);
        const cost = r.opt.premium * r.opt.qty;
        await interaction.reply(`🎯 옵션 #${r.opt.id} (${r.asset.name}) 매도: **${won(r.payout)}** 받음 ` +
          `(매수 ${won(cost)} → 손익 ${signedWon(r.payout - cost)})`);
        return true;
      }
      case '내정보': {
        const target = opt.getUser('유저') || interaction.user;
        if (target.bot) throw new game.GameError('봇은 계좌가 없어요.');
        game.getUser(state, target.id, target.id === uid ? gid : null, now);
        await interaction.reply({ embeds: [profileEmbed(state, target, now)] });
        return true;
      }
      case '포지션':
        game.getUser(state, uid, gid, now);
        await interaction.reply({ embeds: [positionsEmbed(state, uid, now)], flags: MessageFlags.Ephemeral });
        return true;
      case '랭킹':
        await interaction.reply({
          embeds: [rankingEmbed(state, opt.getString('범위') === 'guild' ? gid : null, now)],
          allowedMentions: { parse: [] },
        });
        return false;
      case '출석': {
        const r = game.claimDaily(state, uid, gid, now);
        await interaction.reply(`✅ 출석 완료! **${won(r.bonus)}**을 받았어요. 현재 현금: ${won(r.cash)}`);
        return true;
      }
      case '파산신청': {
        const r = game.bankrupt(state, uid, gid, now);
        await interaction.reply(`💀 파산 처리되었어요. (${r.bankruptcies}번째) **${won(r.cash)}**으로 다시 시작합니다.`);
        return true;
      }
      case '도움말':
        await interaction.reply({ embeds: [helpEmbed()], flags: MessageFlags.Ephemeral });
        return false;
      default:
        return false;
    }
  } catch (err) {
    if (!(err instanceof game.GameError)) throw err;
    await interaction.reply({ content: `⚠️ ${err.message}`, flags: MessageFlags.Ephemeral });
    return false;
  }
}

// 자동완성: 종목 검색, 내 포지션 목록
async function autocomplete(interaction, ctx) {
  const { state } = ctx;
  const focused = interaction.options.getFocused(true);
  let choices = [];
  if (focused.name === '종목') {
    choices = searchAssets(focused.value).map((a) => {
      const p = quote(state.market, a.id)?.price;
      return { name: clip(`${a.name} (${a.id})${p != null ? ` · ${won(p)}` : ''}`, 100), value: a.id };
    });
  } else if (focused.name === '포지션') {
    const user = state.users[interaction.user.id];
    if (user) {
      const list = interaction.commandName === '선물청산'
        ? (user.futures || []).map((p) => ({
          name: `#${p.id} ${findAsset(p.asset)?.name || p.asset} ${p.side > 0 ? '롱' : '숏'} ${p.leverage}배 · 증거금 ${won(p.margin)}`,
          value: String(p.id),
        }))
        : (user.options || []).map((o) => ({
          name: `#${o.id} ${findAsset(o.asset)?.name || o.asset} ${o.kind === 'call' ? '콜' : '풋'} 행사가 ${won(o.strike)}`,
          value: String(o.id),
        }));
      const q = String(focused.value || '');
      choices = list.filter((c) => c.name.includes(q)).slice(0, 25).map((c) => ({ ...c, name: clip(c.name, 100) }));
    }
  }
  await interaction.respond(choices.slice(0, 25));
}

module.exports = { definitions, handle, autocomplete, sparkline };
