// 디스코드 주식 게임 봇 — 진입점

require('dotenv').config();
const { Client, GatewayIntentBits, Events, REST, Routes, MessageFlags } = require('discord.js');
const store = require('./store');
const { refreshPrices } = require('./prices');
const { processRisk } = require('./game');
const { definitions, handleCommand, handleComponent, handleModal, autocomplete } = require('./commands');

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID; // 설정 시 해당 서버에만 즉시 명령어 등록 (테스트용)
const TICK_SECONDS = Math.max(15, Number(process.env.TICK_SECONDS) || 60);

if (!TOKEN) {
  console.error('DISCORD_TOKEN 환경변수가 없습니다. .env.example을 참고해 .env 파일을 만들어 주세요.');
  process.exit(1);
}

const state = store.load();
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function registerCommands(appId) {
  const rest = new REST().setToken(TOKEN);
  const route = GUILD_ID ? Routes.applicationGuildCommands(appId, GUILD_ID) : Routes.applicationCommands(appId);
  await rest.put(route, { body: definitions });
  console.log(`[bot] 슬래시 명령어 ${definitions.length}개 등록 (${GUILD_ID ? `서버 ${GUILD_ID}` : '전역'})`);
}

// 반대매매·강제청산·만기 정산 알림을 DM으로 보낸다 (DM을 막아둔 사람은 건너뜀)
async function notify(events) {
  const byUser = new Map();
  for (const e of events) byUser.set(e.userId, [...(byUser.get(e.userId) || []), e.text]);
  for (const [userId, lines] of byUser) {
    try {
      const user = await client.users.fetch(userId);
      await user.send(`📢 **주식 게임 알림**\n${lines.join('\n')}`);
    } catch (err) {
      console.warn(`[notify] ${userId} DM 실패:`, err.message);
    }
  }
}

const PRICE_SAVE_MS = 10 * 60 * 1000; // 시세만 바뀐 경우 디스크 저장은 10분에 한 번

let ticking = false;
let lastSummaryLog = 0;
let lastPriceSave = 0;
async function runTick(force = false) {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    const summary = await refreshPrices(state.market, { now, force });
    if (force || summary.errors.length || now - lastSummaryLog > 30 * 60 * 1000) {
      console.log(`[price] 시세 갱신(${summary.source || '코인만'}) 성공 ${summary.ok} · 실패 ${summary.fail}` +
        (summary.errors.length ? ` · ${summary.errors.slice(0, 5).join(' | ')}` : ''));
      lastSummaryLog = now;
    }
    const events = processRisk(state, now);
    if (events.length || now - lastPriceSave > PRICE_SAVE_MS) {
      store.scheduleSave(state);
      lastPriceSave = now;
    }
    if (events.length) {
      console.log(`[risk] 알림 ${events.length}건`);
      await notify(events);
    }
  } catch (err) {
    console.error('[tick] 오류:', err);
  } finally {
    ticking = false;
  }
}

client.once(Events.ClientReady, async (c) => {
  console.log(`[bot] ${c.user.tag} 로그인 완료 · ${c.guilds.cache.size}개 서버`);
  console.log(`[bot] 초대 링크: https://discord.com/oauth2/authorize?client_id=${c.user.id}&scope=bot+applications.commands&permissions=18432`);
  try {
    await registerCommands(c.user.id);
  } catch (err) {
    console.error('[bot] 명령어 등록 실패:', err);
  }
  await runTick(true);
  setInterval(() => runTick(), TICK_SECONDS * 1000);
});

client.on(Events.InteractionCreate, async (interaction) => {
  // 내 계정에 추가한 앱으로 쓰면 봇이 없는 서버에서도 온다 → 서버 ID만 있으면 처리
  if (!interaction.guildId) return;
  const ctx = { state };
  try {
    if (interaction.isAutocomplete()) {
      await autocomplete(interaction, ctx);
      return;
    }
    let changed = false;
    if (interaction.isChatInputCommand()) changed = await handleCommand(interaction, ctx);
    else if (interaction.isButton() || interaction.isStringSelectMenu()) changed = await handleComponent(interaction, ctx);
    else if (interaction.isModalSubmit()) changed = await handleModal(interaction, ctx);
    if (changed) store.scheduleSave(state);
  } catch (err) {
    console.error(`[bot] 상호작용 처리 중 오류 (${interaction.customId || interaction.commandName}):`, err);
    if (interaction.isAutocomplete()) return;
    const msg = { content: '⚠️ 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.', flags: MessageFlags.Ephemeral };
    if (interaction.replied || interaction.deferred) await interaction.followUp(msg).catch(() => {});
    else await interaction.reply(msg).catch(() => {});
  }
});

function shutdown() {
  console.log('[bot] 종료 중… 데이터 저장');
  try {
    store.flush(state);
  } finally {
    client.destroy();
    process.exit(0);
  }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

client.login(TOKEN);
