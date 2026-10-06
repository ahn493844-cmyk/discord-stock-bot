// /주식 명령어와 GUI 상호작용(버튼·선택 메뉴·팝업) 처리

const { SlashCommandBuilder, InteractionContextType, MessageFlags } = require('discord.js');
const game = require('./game');
const ui = require('./ui');
const { findAsset, searchAssets } = require('./assets');
const { quote } = require('./market');

const { won } = game;

const definitions = [
  new SlashCommandBuilder().setName('주식').setDescription('주식 터미널을 엽니다 (버튼으로 시세·차트·주문·자산 관리)')
    .addStringOption((o) => o.setName('종목').setDescription('바로 열 종목 (선택)').setAutocomplete(true))
    .setContexts(InteractionContextType.Guild)
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
  game.getUser(state, interaction.user.id, interaction.guildId, now);
  const target = interaction.options.getString('종목');
  const asset = target && findAsset(target);
  const view = asset
    ? ui.assetView(state, interaction.user, asset.id, '1d', now)
    : ui.homeView(state, interaction.user, now, target ? { error: true, text: '⚠️ 종목을 찾지 못해서 홈을 열었어요.' } : null);
  await interaction.reply({ ...view, flags: MessageFlags.Ephemeral });
  return true;
}

// 버튼·선택 메뉴
async function handleComponent(interaction, { state }) {
  const now = Date.now();
  const user = interaction.user;
  const gid = interaction.guildId;
  const [, action, ...args] = interaction.customId.split('|');
  const values = interaction.isStringSelectMenu() ? interaction.values : [];
  const show = (view) => interaction.update(view);
  let changed = false;

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
      await show(ui.rankingView(state, args[0], gid, now));
      break;
    case 'help':
      await show(ui.helpView());
      break;
    case 'daily': {
      const r = attempt(() => {
        const d = game.claimDaily(state, user.id, gid, now);
        return `🎁 출석 보상 **${won(d.bonus)}** 받았어요! 현금 ${won(d.cash)}`;
      });
      changed = r.changed;
      await show(ui.homeView(state, user, now, r.notice));
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

    // 팝업 입력창 열기
    case 'search':
      await interaction.showModal(ui.searchModal());
      break;
    case 'repay':
      await interaction.showModal(ui.repayModal());
      break;
    case 'buy':
    case 'sell':
    case 'fut':
    case 'opt': {
      const asset = findAsset(args[0]);
      if (!asset) {
        await show(ui.homeView(state, user, now, { error: true, text: '⚠️ 종목을 찾을 수 없어요.' }));
        break;
      }
      const modal = action === 'buy' ? ui.buyModal(asset, state)
        : action === 'sell' ? ui.sellModal(asset, state, user.id)
          : action === 'fut' ? ui.futuresModal(asset, args[1])
            : ui.optionModal(asset);
      await interaction.showModal(modal);
      break;
    }

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
      await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
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
  const choice = (key, fallback) => {
    try {
      return f.getStringSelectValues(key)[0] || fallback;
    } catch {
      return fallback;
    }
  };
  // 버튼이 있던 화면에서 연 팝업이면 그 화면을 바꾸고, 아니면 나만 보이는 새 화면으로
  const show = (view) => (interaction.isFromMessage()
    ? interaction.update(view)
    : interaction.reply({ ...view, flags: MessageFlags.Ephemeral }));

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

  const asset = findAsset(args[0]);
  if (!asset) {
    await show(ui.homeView(state, user, now, { error: true, text: '⚠️ 종목을 찾을 수 없어요.' }));
    return false;
  }
  const r = attempt(() => {
    switch (action) {
      case 'm_buy':
        return ui.buyText(game.buy(state, user.id, gid, asset.id, text('qty'), choice('mode', 'cash'), now));
      case 'm_sell':
        return ui.sellText(game.sell(state, user.id, gid, asset.id, text('qty') || '전부', now));
      case 'm_fut':
        return ui.futText(game.openFuture(state, user.id, gid, asset.id, args[1], text('margin'), Number(choice('lev', '5')), now));
      case 'm_opt':
        return ui.optText(game.buyOption(state, user.id, gid, asset.id, choice('kind', 'call'), text('strike') || '현재가',
          choice('expiry', '1d'), text('qty'), now));
      default:
        throw new game.GameError('알 수 없는 동작이에요.');
    }
  });
  await show(ui.assetView(state, user, asset.id, '1d', now, r.notice));
  return r.changed;
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
