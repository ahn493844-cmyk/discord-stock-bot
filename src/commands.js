// /주식 명령어와 GUI 상호작용(버튼·선택 메뉴·팝업) 처리

const {
  SlashCommandBuilder, InteractionContextType, ApplicationIntegrationType, MessageFlags,
} = require('discord.js');
const game = require('./game');
const ui = require('./ui');
const tickets = require('./tickets');
const { render } = require('./v2');
const { findAsset, searchAssets } = require('./assets');
const { quote } = require('./market');

const { won } = game;

// 서버에 설치한 봇으로도, 각자 "내 계정에 앱 추가"로도 쓸 수 있게 한다.
// (서버 설정에서 봇 명령어가 막혀 있어도 내 계정에 추가하면 그 서버에서 쓸 수 있다)
const INSTALL_TYPES = [ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall];

const definitions = [
  new SlashCommandBuilder().setName('주식').setDescription('주식 터미널을 엽니다 (버튼으로 시세·차트·주문·자산 관리)')
    .addStringOption((o) => o.setName('종목').setDescription('바로 열 종목 (선택)').setAutocomplete(true))
    .setContexts(InteractionContextType.Guild)
    .setIntegrationTypes(INSTALL_TYPES)
    .toJSON(),
  new SlashCommandBuilder().setName('직업랜덤뽑기').setDescription('직업(매일 출석 보상)을 다시 뽑습니다 (하루 한 번, 확인 후 실행)')
    .setContexts(InteractionContextType.Guild)
    .setIntegrationTypes(INSTALL_TYPES)
    .toJSON(),
  new SlashCommandBuilder().setName('환생').setDescription('모든 자산을 버리고 출신·직업을 다시 뽑습니다 (24시간에 한 번, 확인 후 실행)')
    .setContexts(InteractionContextType.Guild)
    .setIntegrationTypes(INSTALL_TYPES)
    .toJSON(),
];

function signedWon(n) {
  return `${n > 0 ? '+' : n < 0 ? '-' : ''}${won(Math.abs(n))}`;
}

// 게임 동작을 실행하고, 성공/실패 알림과 상태 변경 여부를 돌려준다
function attempt(fn) {
  try {
    return { notice: { text: fn() }, changed: true };
  } catch (err) {
    if (err instanceof game.GameError) return { notice: { error: true, text: `⚠️ ${err.message}` }, changed: false };
    throw err;
  }
}

// /주식
async function handleCommand(interaction, { state }) {
  const now = Date.now();
  const isNew = !state.users[interaction.user.id];
  const acc = game.getUser(state, interaction.user.id, interaction.guildId, now);
  let view;
  if (interaction.commandName === '직업랜덤뽑기') {
    view = isNew ? ui.homeView(state, interaction.user, now, ui.birthNotice(acc)) : ui.jobRollConfirmView(state, interaction.user, now);
  } else if (interaction.commandName === '환생') {
    view = isNew ? ui.homeView(state, interaction.user, now, ui.birthNotice(acc)) : ui.rebirthConfirmView(state, interaction.user, now);
  } else {
    const target = interaction.options.getString('종목');
    const asset = target && findAsset(target);
    const notice = isNew ? ui.birthNotice(acc) : target && !asset ? { error: true, text: '⚠️ 종목을 찾지 못해서 홈을 열었어요.' } : null;
    view = asset && !isNew ? ui.assetView(state, interaction.user, asset.id, '1d', now) : ui.homeView(state, interaction.user, now, notice);
  }
  const msg = render(view);
  await interaction.reply({ ...msg, flags: msg.flags | MessageFlags.Ephemeral });
  return true;
}

// 버튼·선택 메뉴
async function handleComponent(interaction, { state }) {
  const now = Date.now();
  const user = interaction.user;
  const gid = interaction.guildId;
  const [, action, ...args] = interaction.customId.split('|');
  const values = interaction.isStringSelectMenu() ? interaction.values : [];
  const show = (view) => interaction.update(render(view));
  let changed = false;

  // 주문창·실행 버튼은 첫 인자가 종목 코드
  if (['tb', 'tbm', 'ts', 'tf', 'tfl', 'to', 'toe', 'xb', 'xs', 'xf', 'xo'].includes(action) || (action === 'qi' && args[1])) {
    if (!findAsset(action === 'qi' ? args[1] : args[0])) {
      await show(ui.homeView(state, user, now, { error: true, text: '⚠️ 종목을 찾을 수 없어요.' }));
      return false;
    }
  }

  switch (action) {
    case 'home':
      await show(ui.homeView(state, user, now));
      break;
    case 'cat':
      await show(ui.listView(state, values[0], 0, now));
      break;
    case 'list':
      await show(ui.listView(state, args[0], Number(args[1]) || 0, now));
      break;
    case 'pick':
      await show(ui.assetView(state, user, values[0], '1d', now));
      break;
    case 'a':
      await show(ui.assetView(state, user, args[0], args[1], now));
      break;
    case 'pf':
      await show(ui.portfolioView(state, user, now));
      break;
    case 'pos':
      await show(ui.positionsView(state, user, now));
      break;
    case 'close':
      await show(ui.positionsView(state, user, now, null, values[0]));
      break;
    case 'closeb':
      await show(ui.positionsView(state, user, now, null, args[0]));
      break;
    case 'pfu': {
      // 랭킹에서 다른 사람 자산 보기 (보기만 가능)
      const target = args[0] === user.id ? user : { id: args[0] };
      if (!state.users[args[0]]) {
        await show(ui.rankingView(state, 'all', gid, now, { error: true, text: '⚠️ 계좌를 찾을 수 없어요.' }, user.id));
        break;
      }
      await show(ui.portfolioView(state, target, now, null, user.id));
      break;
    }
    case 'closeok': {
      const [kind, pid] = String(args[0]).split(':');
      const r = attempt(() => {
        if (kind === 'f') {
          const c = game.closeFuture(state, user.id, gid, pid, now);
          return `✅ 선물 \`#${c.pos.id}\` 청산 — ${c.asset.name} ${won(c.pos.entry)} → ${won(c.price)} · 손익 ${signedWon(c.pnl)} · ${won(c.payout)} 돌려받음`;
        }
        const s = game.sellOption(state, user.id, gid, pid, now);
        return `✅ 옵션 \`#${s.opt.id}\` 매도 — ${s.asset.name} · ${won(s.payout)} 받음 (손익 ${signedWon(s.payout - s.opt.premium * s.opt.qty)})`;
      });
      changed = r.changed;
      await show(ui.positionsView(state, user, now, r.notice));
      break;
    }
    case 'rank':
      await show(ui.rankingView(state, args[0], gid, now, null, user.id));
      break;
    case 'help':
      await show(ui.helpView());
      break;
    case 'daily': {
      const r = attempt(() => {
        const d = game.claimDaily(state, user.id, gid, now);
        return `🎁 ${d.job.emoji} ${d.job.name} 출석 보상 **${won(d.bonus)}** 받았어요! 현금 ${won(d.cash)}`;
      });
      changed = r.changed;
      await show(ui.homeView(state, user, now, r.notice));
      break;
    }
    case 'jr':
      await show(ui.jobRollConfirmView(state, user, now));
      break;
    case 'jrok': {
      try {
        const r = game.rerollJob(state, user.id, gid, now);
        changed = true;
        await show(ui.jobRollResultView(state, user, r, now));
      } catch (err) {
        if (!(err instanceof game.GameError)) throw err;
        await show(ui.jobRollConfirmView(state, user, now, { error: true, text: `⚠️ ${err.message}` }));
      }
      break;
    }
    case 'rb':
      await show(ui.rebirthConfirmView(state, user, now));
      break;
    case 'rbok': {
      // 확인 화면의 버튼으로만 실행된다
      try {
        const r = game.rebirth(state, user.id, gid, now);
        changed = true;
        await show(ui.rebirthResultView(state, user, r, now));
      } catch (err) {
        if (!(err instanceof game.GameError)) throw err;
        await show(ui.rebirthConfirmView(state, user, now, { error: true, text: `⚠️ ${err.message}` }));
      }
      break;
    }
    case 'bankrupt': {
      const r = attempt(() => {
        const b = game.bankrupt(state, user.id, gid, now);
        return `💀 파산 처리됐어요 (${b.bankruptcies}번째). **${won(b.cash)}**으로 다시 시작해요.`;
      });
      changed = r.changed;
      await show(ui.portfolioView(state, user, now, r.notice));
      break;
    }

    // 주문창: 버튼을 누를 때마다 미리보기를 다시 계산한다 (체결은 실행 버튼에서만)
    case 'tb':
      await show(tickets.buyTicket(state, user, args[0], args[1], args[2], now));
      break;
    case 'tbm':
      await show(tickets.buyTicket(state, user, args[0], values[0], args[1], now));
      break;
    case 'ts':
      await show(tickets.sellTicket(state, user, args[0], args[1], now));
      break;
    case 'tf':
      await show(tickets.futuresTicket(state, user, args[0], args[1], args[2], args[3], now));
      break;
    case 'tfl':
      await show(tickets.futuresTicket(state, user, args[0], args[1], values[0], args[2], now));
      break;
    case 'to':
      await show(tickets.optionTicket(state, user, args[0], args[1], args[2], args[3], args[4], now));
      break;
    case 'toe':
      await show(tickets.optionTicket(state, user, args[0], args[1], values[0], args[2], args[3], now));
      break;
    case 'xb':
    case 'xs':
    case 'xf':
    case 'xo': {
      const r = tickets.execute(state, user, gid, action, args, now);
      changed = r.changed;
      await show(r.view);
      break;
    }

    // 팝업 입력창 열기
    case 'qi':
      await interaction.showModal(tickets.inputModal(state, user, args[0], args.slice(1), now));
      break;
    case 'search':
      await interaction.showModal(ui.searchModal());
      break;
    case 'repay':
      await interaction.showModal(ui.repayModal());
      break;

    // 채널에 공개로 올리기
    case 'share': {
      let embed;
      if (args[0] === 'a') {
        const asset = findAsset(args[1]);
        if (!asset) {
          await show(ui.homeView(state, user, now));
          break;
        }
        embed = ui.assetEmbed(state, asset, ui.RANGES[args[2]] ? args[2] : '1d', now, null);
      } else if (args[0] === 'pf') {
        embed = ui.portfolioEmbed(state, user, now);
      } else {
        embed = ui.rankingEmbed(state, args[1], gid, now);
      }
      embed.setFooter({ text: `${user.displayName ?? user.username}님이 공유 · /주식 으로 직접 해 보세요` });
      await interaction.reply(render({ embeds: [embed], allowedMentions: { parse: [] } }));
      break;
    }
    default:
      await interaction.deferUpdate();
  }
  return changed;
}

// 팝업 입력창 제출
async function handleModal(interaction, { state }) {
  const now = Date.now();
  const user = interaction.user;
  const gid = interaction.guildId;
  const [, action, ...args] = interaction.customId.split('|');
  const f = interaction.fields;
  const text = (key) => {
    try {
      return (f.getTextInputValue(key) || '').trim();
    } catch {
      return '';
    }
  };
  // 버튼이 있던 화면에서 연 팝업이면 그 화면을 바꾸고, 아니면 나만 보이는 새 화면으로
  const show = (view) => {
    const msg = render(view);
    return interaction.isFromMessage()
      ? interaction.update(msg)
      : interaction.reply({ ...msg, flags: msg.flags | MessageFlags.Ephemeral });
  };

  if (action === 'm_search') {
    const q = text('q');
    const hits = searchAssets(q, 25);
    await show(hits.length === 1 ? ui.assetView(state, user, hits[0].id, '1d', now) : ui.searchResultView(state, q, hits, now));
    return false;
  }
  if (action === 'm_repay') {
    const r = attempt(() => {
      const p = game.repay(state, user.id, gid, text('amount') || '전부');
      return `💳 대출 **${won(p.paid)}** 상환 · 남은 대출 ${won(p.remaining)} · 현금 ${won(p.cash)}`;
    });
    await show(ui.positionsView(state, user, now, r.notice));
    return r.changed;
  }

  if (action === 'mq') {
    // 직접 입력한 수량·금액으로 주문창을 다시 보여 준다 (아직 체결하지 않음)
    await show(tickets.fromInput(state, user, args[0], args.slice(1), text('v'), now));
    return false;
  }
  await show(ui.homeView(state, user, now));
  return false;
}

// 자동완성: /주식 종목
async function autocomplete(interaction, { state }) {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== '종목') return interaction.respond([]);
  const choices = searchAssets(focused.value).map((a) => {
    const p = quote(state.market, a.id)?.price;
    const name = `${a.name} (${a.id})${p != null ? ` · ${won(p)}` : ''}`;
    return { name: name.length > 100 ? `${name.slice(0, 99)}…` : name, value: a.id };
  });
  return interaction.respond(choices.slice(0, 25));
}

module.exports = { definitions, handleCommand, handleComponent, handleModal, autocomplete };
