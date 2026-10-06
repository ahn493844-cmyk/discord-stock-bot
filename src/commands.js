// 슬래시 명령어 정의와 처리

const {
  SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ChannelType, MessageFlags, InteractionContextType,
} = require('discord.js');
const game = require('./game');
const { STOCKS, findStock } = require('./market');

const { won } = game;
const STOCK_CHOICES = STOCKS.map((s) => ({ name: `${s.name} (${s.symbol})`, value: s.symbol }));
const COLOR_UP = 0xe03131;   // 한국 증시 관례: 상승 빨강
const COLOR_DOWN = 0x1c7ed6; // 하락 파랑
const COLOR_INFO = 0xf59f00;

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

function sparkline(values) {
  const bars = '▁▂▃▄▅▆▇█';
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return bars[3].repeat(values.length);
  return values.map((v) => bars[Math.round(((v - min) / (max - min)) * (bars.length - 1))]).join('');
}

function stockOption(o) {
  return o.setName('종목').setDescription('거래할 종목').setRequired(true).addChoices(...STOCK_CHOICES);
}

const definitions = [
  new SlashCommandBuilder().setName('시세').setDescription('전체 종목의 현재 시세를 봅니다'),
  new SlashCommandBuilder().setName('차트').setDescription('종목의 최근 가격 흐름을 봅니다')
    .addStringOption(stockOption),
  new SlashCommandBuilder().setName('매수').setDescription('주식을 삽니다')
    .addStringOption(stockOption)
    .addStringOption((o) => o.setName('수량').setDescription('숫자, 전부, 절반, 50% 등').setRequired(true)),
  new SlashCommandBuilder().setName('매도').setDescription('주식을 팝니다')
    .addStringOption(stockOption)
    .addStringOption((o) => o.setName('수량').setDescription('숫자, 전부, 절반, 50% 등').setRequired(true)),
  new SlashCommandBuilder().setName('내정보').setDescription('내 자산과 보유 주식을 봅니다')
    .addUserOption((o) => o.setName('유저').setDescription('다른 사람의 정보를 볼 수도 있어요')),
  new SlashCommandBuilder().setName('랭킹').setDescription('총자산 순위를 봅니다')
    .addStringOption((o) => o.setName('범위').setDescription('기본: 전체 서버')
      .addChoices({ name: '전체 서버', value: 'all' }, { name: '이 서버', value: 'guild' })),
  new SlashCommandBuilder().setName('출석').setDescription(`하루 한 번 ${won(game.DAILY_BONUS)}을 받습니다`),
  new SlashCommandBuilder().setName('파산신청')
    .setDescription(`총자산이 ${won(game.BANKRUPT_LIMIT)} 미만이면 초기 자금으로 다시 시작합니다`),
  new SlashCommandBuilder().setName('뉴스채널').setDescription('시장 뉴스가 올라올 채널을 설정합니다 (관리자)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((o) => o.setName('채널').setDescription('비워두면 뉴스 알림을 끕니다')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
  new SlashCommandBuilder().setName('도움말').setDescription('주식 게임 사용법을 봅니다'),
].map((c) => c.setContexts(InteractionContextType.Guild).toJSON());

function marketEmbed(state, tickSeconds) {
  const lines = STOCKS.map((s) => {
    const st = state.market.stocks[s.symbol];
    return `**${s.name}** \`${s.symbol}\` · ${s.sector}\n` +
      `　${won(st.price)}　직전 ${fmtPct(pct(st.prevPrice, st.price))}　오늘 ${fmtPct(pct(st.open, st.price))}`;
  });
  return new EmbedBuilder()
    .setTitle('📈 디코 증권거래소 시세')
    .setColor(COLOR_INFO)
    .setDescription(lines.join('\n'))
    .setFooter({ text: `시세는 ${tickSeconds}초마다 변동 · 수수료 ${(game.FEE_RATE * 100).toFixed(2)}%` })
    .setTimestamp(state.market.lastTick);
}

function chartEmbed(state, symbol) {
  const s = findStock(symbol);
  const st = state.market.stocks[symbol];
  const hist = st.history.slice(-40);
  const change = pct(hist[0], st.price);
  return new EmbedBuilder()
    .setTitle(`${s.name} (${s.symbol}) 차트`)
    .setColor(change >= 0 ? COLOR_UP : COLOR_DOWN)
    .setDescription(`\`\`\`\n${sparkline(hist)}\n\`\`\``)
    .addFields(
      { name: '현재가', value: won(st.price), inline: true },
      { name: '구간 변동', value: fmtPct(change), inline: true },
      { name: '오늘 시가', value: won(st.open), inline: true },
      { name: '구간 최고', value: won(Math.max(...hist)), inline: true },
      { name: '구간 최저', value: won(Math.min(...hist)), inline: true },
      { name: '업종', value: s.sector, inline: true },
    )
    .setFooter({ text: `최근 ${hist.length}틱 기준` });
}

function profileEmbed(state, guildId, user) {
  const acc = game.getUser(state, user.id, guildId);
  const v = game.portfolioValue(state, acc);
  const totalProfit = v.total - game.START_CASH;
  const holdings = Object.entries(acc.holdings).map(([sym, h]) => {
    const s = findStock(sym);
    const p = state.market.stocks[sym].price;
    const evalProfit = (p - h.avgPrice) * h.qty;
    return `**${s ? s.name : sym}** ${h.qty.toLocaleString('ko-KR')}주 · 평단 ${won(h.avgPrice)} → ${won(p)}\n` +
      `　평가손익 ${signedWon(evalProfit)} (${fmtPct(pct(h.avgPrice, p))})`;
  });
  return new EmbedBuilder()
    .setAuthor({ name: `${user.displayName ?? user.username}님의 계좌`, iconURL: user.displayAvatarURL() })
    .setColor(totalProfit >= 0 ? COLOR_UP : COLOR_DOWN)
    .addFields(
      { name: '💰 현금', value: won(v.cash), inline: true },
      { name: '📊 주식 평가액', value: won(v.stock), inline: true },
      { name: '🏦 총자산', value: won(v.total), inline: true },
      { name: '누적 수익', value: `${signedWon(totalProfit)} (${fmtPct(pct(game.START_CASH, v.total))})`, inline: true },
      { name: '실현 손익', value: signedWon(acc.realized), inline: true },
      { name: '​', value: '​', inline: true },
      { name: '보유 종목', value: holdings.length ? holdings.join('\n') : '아직 보유한 주식이 없어요. `/매수`로 시작해 보세요!' },
    );
}

function rankingEmbed(state, guildId) {
  const medals = ['🥇', '🥈', '🥉'];
  const rows = game.ranking(state, guildId, 10).map((r, i) =>
    `${medals[i] || `**${i + 1}.**`} <@${r.userId}> — ${won(r.total)} (${fmtPct(pct(game.START_CASH, r.total))})`);
  return new EmbedBuilder()
    .setTitle(guildId ? '🏆 이 서버 자산 랭킹' : '🏆 전체 서버 자산 랭킹')
    .setColor(COLOR_INFO)
    .setDescription(rows.length ? rows.join('\n') : '아직 참가자가 없어요. `/매수`나 `/출석`으로 참가해 보세요!');
}

function helpEmbed() {
  return new EmbedBuilder()
    .setTitle('📘 주식 게임 도움말')
    .setColor(COLOR_INFO)
    .setDescription(
      `처음 명령어를 쓰면 **${won(game.START_CASH)}**으로 계좌가 자동 개설됩니다.\n` +
      '계좌는 봇이 있는 **모든 서버에서 공용**입니다. 어느 서버에서 거래해도 같은 계좌예요.\n' +
      '가상의 종목들의 가격이 주기적으로 변하고, 가끔 뉴스가 터져 크게 움직입니다.\n​')
    .addFields(
      { name: '/시세', value: '전체 종목 현재가와 변동률' },
      { name: '/차트 종목', value: '최근 가격 흐름 미니 차트' },
      { name: '/매수 종목 수량 · /매도 종목 수량', value: '수량은 `10`, `전부`, `절반`, `30%` 처럼 입력' },
      { name: '/내정보 [유저]', value: '현금, 보유 주식, 수익률' },
      { name: '/랭킹 [범위]', value: '전체 서버 또는 이 서버의 총자산 순위' },
      { name: '/출석', value: `하루 한 번 ${won(game.DAILY_BONUS)} 지급 (KST 자정 초기화)` },
      { name: '/파산신청', value: `총자산 ${won(game.BANKRUPT_LIMIT)} 미만일 때 초기 자금으로 재시작` },
      { name: '/뉴스채널 [채널]', value: '시장 뉴스 알림 채널 설정 (서버 관리 권한 필요)' },
    );
}

function tradeEmbed(kind, r) {
  const s = findStock(r.symbol);
  const e = new EmbedBuilder()
    .setColor(kind === 'buy' ? COLOR_UP : COLOR_DOWN)
    .setTitle(`${kind === 'buy' ? '🛒 매수' : '💸 매도'} 체결 — ${s.name}`)
    .addFields(
      { name: '체결가', value: won(r.price), inline: true },
      { name: '수량', value: `${r.qty.toLocaleString('ko-KR')}주`, inline: true },
      { name: '수수료', value: won(r.fee), inline: true },
    );
  if (kind === 'buy') {
    e.addFields(
      { name: '결제 금액', value: won(r.cost + r.fee), inline: true },
      { name: '보유', value: `${r.holding.qty.toLocaleString('ko-KR')}주 (평단 ${won(r.holding.avgPrice)})`, inline: true },
    );
  } else {
    e.addFields(
      { name: '정산 금액', value: won(r.revenue - r.fee), inline: true },
      { name: '실현 손익', value: signedWon(r.profit), inline: true },
    );
  }
  return e.addFields({ name: '남은 현금', value: won(r.cash), inline: true });
}

function newsEmbed(n) {
  return new EmbedBuilder()
    .setColor(n.pct > 0 ? COLOR_UP : COLOR_DOWN)
    .setTitle(`📰 [속보] ${n.headline}`)
    .setDescription(`**${n.name}** (\`${n.symbol}\`) ${fmtPct(n.pct * 100)} → ${won(n.price)}`)
    .setTimestamp();
}

// 명령 처리. 상태가 바뀌었으면 true를 반환해 저장을 요청한다.
async function handle(interaction, ctx) {
  const { state, tickSeconds } = ctx;
  const gid = interaction.guildId;
  const uid = interaction.user.id;
  const opt = interaction.options;

  try {
    switch (interaction.commandName) {
      case '시세':
        await interaction.reply({ embeds: [marketEmbed(state, tickSeconds)] });
        return false;
      case '차트':
        await interaction.reply({ embeds: [chartEmbed(state, opt.getString('종목', true))] });
        return false;
      case '매수': {
        const r = game.buy(state, uid, gid, opt.getString('종목', true), opt.getString('수량', true));
        await interaction.reply({ embeds: [tradeEmbed('buy', r)] });
        return true;
      }
      case '매도': {
        const r = game.sell(state, uid, gid, opt.getString('종목', true), opt.getString('수량', true));
        await interaction.reply({ embeds: [tradeEmbed('sell', r)] });
        return true;
      }
      case '내정보': {
        const target = opt.getUser('유저') || interaction.user;
        if (target.bot) throw new game.GameError('봇은 계좌가 없어요.');
        await interaction.reply({ embeds: [profileEmbed(state, gid, target)] });
        return true;
      }
      case '랭킹':
        await interaction.reply({
          embeds: [rankingEmbed(state, opt.getString('범위') === 'guild' ? gid : null)],
          allowedMentions: { parse: [] },
        });
        return false;
      case '출석': {
        const r = game.claimDaily(state, uid, gid);
        await interaction.reply(`✅ 출석 완료! **${won(r.bonus)}**을 받았습니다. 현재 현금: ${won(r.cash)}`);
        return true;
      }
      case '파산신청': {
        const r = game.bankrupt(state, uid, gid);
        await interaction.reply(`💀 파산 처리되었습니다. (${r.bankruptcies}번째) **${won(r.cash)}**으로 다시 시작합니다.`);
        return true;
      }
      case '뉴스채널': {
        const ch = opt.getChannel('채널');
        game.getGuild(state, gid).newsChannelId = ch ? ch.id : null;
        await interaction.reply({
          content: ch ? `📰 앞으로 시장 뉴스가 <#${ch.id}> 채널에 올라옵니다.` : '📴 뉴스 알림을 껐습니다.',
          flags: MessageFlags.Ephemeral,
        });
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

module.exports = { definitions, handle, newsEmbed, sparkline };
