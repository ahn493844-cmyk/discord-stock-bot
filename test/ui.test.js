// GUI 흐름 테스트: 가짜 interaction으로 버튼·메뉴·팝업을 눌러 보고, 디스코드 제한을 지키는지 확인
const test = require('node:test');
const assert = require('node:assert');
const game = require('../src/game');
const { ASSETS, CATEGORIES } = require('../src/assets');
const { handleCommand, handleComponent, handleModal, autocomplete, definitions } = require('../src/commands');

const NOW = Date.now();

function makeState() {
  const s = game.createState(NOW);
  ASSETS.forEach((a, i) => Object.assign(s.market.assets[a.id], {
    price: 1000 + i * 1234.5, prevClose: 1000 + i * 1200, raw: 10 + i, updatedAt: NOW, period: null,
  }));
  Object.assign(s.market.assets['005930'], { price: 70000, prevClose: 69000 });
  Object.assign(s.market.assets.BTC, { price: 100_000_000, prevClose: 99_000_000 });
  s.market.fx = { USD: 1400, JPY: 9.5 };
  s.market.chartsVersion = NOW;
  return s;
}

const user = { id: 'u1', username: 'tester', displayName: '테스터', bot: false, displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png' };

const toJSON = (x) => (x && typeof x.toJSON === 'function' ? x.toJSON() : x);

// 디스코드 메시지 제한 검사
function checkMessage(msg, where) {
  const embeds = (msg.embeds || []).map(toJSON);
  let total = 0;
  for (const e of embeds) {
    total += (e.title || '').length + (e.description || '').length + (e.footer?.text || '').length + (e.author?.name || '').length;
    assert.ok((e.description || '').length <= 4096, `${where}: 설명 4096자 초과`);
    assert.ok((e.fields || []).length <= 25, `${where}: 필드 25개 초과`);
    for (const f of e.fields || []) {
      assert.ok(f.value.length <= 1024 && f.value.length > 0, `${where}: 필드 값 길이 ${f.value.length}`);
      assert.ok(f.name.length <= 256, `${where}: 필드 이름 초과`);
      total += f.name.length + f.value.length;
    }
  }
  assert.ok(total <= 6000, `${where}: 임베드 전체 ${total}자`);
  const rows = (msg.components || []).map(toJSON);
  assert.ok(rows.length <= 5, `${where}: 줄 ${rows.length}개`);
  const ids = new Set();
  for (const r of rows) {
    assert.ok(r.components.length >= 1 && r.components.length <= 5, `${where}: 한 줄 컴포넌트 ${r.components.length}개`);
    for (const c of r.components) {
      assert.ok(c.custom_id && c.custom_id.length <= 100, `${where}: custom_id ${c.custom_id}`);
      assert.ok(!ids.has(c.custom_id), `${where}: custom_id 중복 ${c.custom_id}`);
      ids.add(c.custom_id);
      if (c.label) assert.ok(c.label.length <= 80, `${where}: 버튼 라벨 길이`);
      if (c.options) {
        assert.ok(c.options.length >= 1 && c.options.length <= 25, `${where}: 선택지 ${c.options.length}개`);
        for (const o of c.options) {
          assert.ok(o.label.length <= 100 && (o.description || '').length <= 100, `${where}: 선택지 길이`);
        }
      }
    }
  }
  return { embeds, rows, ids };
}

function checkModal(modal, where) {
  const m = toJSON(modal);
  assert.ok(m.title.length <= 45, `${where}: 모달 제목 ${m.title.length}자`);
  assert.ok(m.custom_id.length <= 100);
  assert.ok(m.components.length >= 1 && m.components.length <= 5, `${where}: 모달 칸 ${m.components.length}개`);
  for (const l of m.components) {
    assert.ok(l.label.length <= 45, `${where}: 칸 이름 길이 ${l.label}`);
    assert.ok(!l.description || l.description.length <= 100, `${where}: 칸 설명 길이 ${l.description}`);
  }
  return m;
}

// 화면 하나를 흉내내는 가짜 상호작용
function harness(state) {
  let screen = null;
  let modal = null;
  const shared = [];
  const base = (extra) => ({
    user, guildId: 'g1', replied: false, deferred: false,
    reply: async (m) => {
      if (m.flags) screen = m;
      else shared.push(m);
    },
    update: async (m) => { screen = m; },
    deferUpdate: async () => {},
    showModal: async (m) => { modal = m; },
    isStringSelectMenu: () => false,
    isFromMessage: () => true,
    ...extra,
  });
  return {
    get screen() { return screen; },
    get modal() { return modal; },
    shared,
    async command(target) {
      await handleCommand(base({ options: { getString: () => target ?? null } }), { state });
      return checkMessage(screen, `/주식 ${target || ''}`);
    },
    async click(customId) {
      modal = null;
      await handleComponent(base({ customId }), { state });
      if (modal) return checkModal(modal, customId);
      return checkMessage(screen, customId);
    },
    async pick(customId, value) {
      await handleComponent(base({ customId, values: [value], isStringSelectMenu: () => true }), { state });
      return checkMessage(screen, `${customId}=${value}`);
    },
    async submit(customId, texts = {}, selects = {}) {
      const fields = {
        getTextInputValue: (k) => {
          if (!(k in texts)) throw new Error('없는 칸');
          return texts[k];
        },
        getStringSelectValues: (k) => {
          if (!(k in selects)) throw new Error('없는 칸');
          return [selects[k]];
        },
      };
      await handleModal(base({ customId, fields }), { state });
      return checkMessage(screen, `모달 ${customId}`);
    },
    notice() {
      return toJSON(screen.embeds[0]).description || '';
    },
  };
}

test('/주식 명령어는 하나뿐이다', () => {
  assert.deepStrictEqual(definitions.map((d) => d.name), ['주식']);
});

test('홈 → 분류 → 페이지 이동 → 종목 → 차트 기간 전환', async () => {
  const state = makeState();
  const h = harness(state);
  const home = await h.command();
  assert.ok(home.ids.has('stk|cat'));
  for (const cat of Object.keys(CATEGORIES)) {
    const list = await h.pick('stk|cat', cat);
    const pick = list.rows[0].components[0];
    assert.ok(pick.options.length > 0);
    if (list.ids.has(`stk|list|${cat}|1`)) await h.click(`stk|list|${cat}|1`);
  }
  const asset = await h.pick('stk|pick|kr', '005930');
  assert.match(asset.embeds[0].image.url, /charts\/005930_1d\.png\?v=/);
  const w = await h.click('stk|a|005930|1w');
  assert.match(w.embeds[0].image.url, /005930_1w/);
  await h.click('stk|a|005930|1y|refresh');
  await h.click('stk|list|kr|0');
  await h.click('stk|home');
});

test('모든 종목 화면이 제한을 지킨다', async () => {
  const state = makeState();
  const h = harness(state);
  await h.command();
  for (const a of ASSETS) await h.click(`stk|a|${a.id}|1d`);
});

test('매수(현금·신용·미수) → 매도 → 자산 화면', async () => {
  const state = makeState();
  const h = harness(state);
  await h.command('005930');
  const m = await h.click('stk|buy|005930');
  assert.strictEqual(m.custom_id, 'stk|m_buy|005930');
  await h.submit('stk|m_buy|005930', { qty: '5' }, { mode: 'cash' });
  assert.match(h.notice(), /현금 매수 체결/);
  await h.submit('stk|m_buy|005930', { qty: '3' }, { mode: 'credit' });
  assert.match(h.notice(), /신용 대출/);
  await h.submit('stk|m_buy|BTC', { qty: '5만원' }, { mode: 'misu' });
  assert.match(h.notice(), /미수/);
  await h.submit('stk|m_buy|005930', { qty: 'abc' }, { mode: 'cash' });
  assert.match(h.notice(), /⚠️/);
  await h.click('stk|sell|005930');
  await h.submit('stk|m_sell|005930', { qty: '전부' });
  assert.match(h.notice(), /매도 체결/);
  const pf = await h.click('stk|pf');
  assert.ok(pf.embeds[0].fields.some((f) => f.name.startsWith('보유 현물')));
  await h.pick('stk|pick|pf', 'BTC');
});

test('선물·옵션 → 포지션에서 선택·확인으로 정리 → 대출 상환', async () => {
  const state = makeState();
  const h = harness(state);
  await h.command('BTC');
  await h.click('stk|fut|BTC|short');
  await h.submit('stk|m_fut|BTC|short', { margin: '10만' }, { lev: '10' });
  assert.match(h.notice(), /숏 10배 진입/);
  await h.click('stk|opt|005930');
  await h.submit('stk|m_opt|005930', { qty: '10', strike: '+5%' }, { kind: 'call', expiry: '1w' });
  assert.match(h.notice(), /옵션 매수/);
  await h.submit('stk|m_buy|005930', { qty: '5' }, { mode: 'credit' });

  const pos = await h.click('stk|pos');
  const select = pos.rows[0].components[0];
  assert.strictEqual(select.options.length, 2);
  const confirm = await h.pick('stk|close', select.options[0].value);
  assert.ok([...confirm.ids].some((x) => x.startsWith('stk|closeok|')));
  await h.click(`stk|closeok|${select.options[0].value}`);
  assert.match(h.notice(), /청산/);
  await h.click(`stk|closeok|${select.options[1].value}`);
  assert.match(h.notice(), /옵션 .* 매도/);
  await h.click('stk|repay');
  await h.submit('stk|m_repay', { amount: '전부' });
  assert.match(h.notice(), /상환/);
  const u = game.getUser(state, 'u1');
  assert.strictEqual(u.futures.length + u.options.length + u.loans.length, 0);
});

test('검색·출석·랭킹·도움말·공유', async () => {
  const state = makeState();
  const h = harness(state);
  await h.command();
  await h.click('stk|search');
  const many = await h.submit('stk|m_search', { q: '삼성' });
  assert.ok(many.rows[0].components[0].options.length > 1);
  await h.submit('stk|m_search', { q: 'AAPL' });
  assert.match(toJSON(h.screen.embeds[0]).title, /애플/);
  await h.submit('stk|m_search', { q: '없는종목zzz' });
  await h.click('stk|daily');
  assert.match(h.notice(), /출석 보상/);
  await h.click('stk|daily');
  assert.match(h.notice(), /이미 출석/);
  await h.click('stk|rank|all');
  await h.click('stk|rank|guild');
  await h.click('stk|help');
  await h.click('stk|share|rank|all');
  await h.click('stk|share|pf');
  await h.click('stk|share|a|005930|1m');
  assert.strictEqual(h.shared.length, 3);
  for (const m of h.shared) checkMessage(m, '공유');
});

test('자동완성은 25개 이하', async () => {
  const state = makeState();
  let out;
  await autocomplete({ options: { getFocused: () => ({ name: '종목', value: '' }) }, respond: async (c) => { out = c; } }, { state });
  assert.strictEqual(out.length, 25);
  await autocomplete({ options: { getFocused: () => ({ name: '종목', value: 'kodex' }) }, respond: async (c) => { out = c; } }, { state });
  assert.ok(out.length > 3 && out.every((c) => c.name.length <= 100));
});

test('시세가 없는 상태(봇 막 켜짐)에서도 화면이 깨지지 않는다', async () => {
  const state = game.createState(NOW);
  const h = harness(state);
  await h.command();
  await h.pick('stk|cat', 'us');
  await h.click('stk|a|AAPL|1d');
  assert.strictEqual(toJSON(h.screen.embeds[0]).image, undefined);
  await h.click('stk|buy|AAPL');
  await h.submit('stk|m_buy|AAPL', { qty: '1' }, { mode: 'cash' });
  assert.match(h.notice(), /시세/);
});
