// 디스코드 주식 게임 봇 — 진입점

require('dotenv').config();
const { Client, GatewayIntentBits, Events, REST, Routes, MessageFlags } = require('discord.js');
const store = require('./store');
const { tick } = require('./market');
const { definitions, handle, newsEmbed } = require('./commands');

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID; // 설정 시 해당 서버에만 즉시 명령어 등록 (테스트용)
const TICK_SECONDS = Math.max(10, Number(process.env.TICK_SECONDS) || 60);

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

async function broadcastNews(news) {
  for (const [guildId, g] of Object.entries(state.guilds)) {
    if (!g.newsChannelId || !client.guilds.cache.has(guildId)) continue;
    try {
      const ch = await client.channels.fetch(g.newsChannelId);
      if (ch && ch.isTextBased()) await ch.send({ embeds: news.map(newsEmbed) });
    } catch (err) {
      console.warn(`[news] ${guildId} 뉴스 전송 실패:`, err.message);
    }
  }
}

function runTick() {
  const news = tick(state.market);
  store.scheduleSave(state);
  if (news.length) {
    console.log('[news]', news.map((n) => n.headline).join(' / '));
    broadcastNews(news);
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
  setInterval(runTick, TICK_SECONDS * 1000);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.inGuild()) return;
  try {
    const changed = await handle(interaction, { state, tickSeconds: TICK_SECONDS });
    if (changed) store.scheduleSave(state);
  } catch (err) {
    console.error(`[bot] /${interaction.commandName} 처리 중 오류:`, err);
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
