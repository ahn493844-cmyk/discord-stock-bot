// GUI 흐름 테스트: 가짜 interaction으로 버튼·메뉴·팝업을 눌러 보고, 디스코드 제한을 지키는지 확인
const test = require('node:test');
const assert = require('node:assert');
const game = require('../src/game');

// 출신·직업 뽑기를 고정: 동수저 · 회사원(일급 10만) · 시작 자금 100만원
game.setLifeRoller(() => ({ origin: 'bronze', job: 'office', startCash: 1_000_000 }));
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

// 디스코드 메시지 제한 검사 (Components V2)
const TYPE = { row: 1, button: 2, select: 3, section: 9, text: 10, thumb: 11, gallery: 12, sep: 14, container: 17 };

function walk(components, visit) {
  for (const c of components) {
    visit(c);
    if (c.components) walk(c.components, visit);
    if (c.accessory) walk([c.accessory], visit);
  }
}

function checkMessage(msg, where) {
  assert.ok(msg.flags & 32768, `${where}: Components V2 플래그 없음`);
  assert.ok(!msg.embeds || !msg.embeds.length, `${where}: V2 메시지에 embeds`);
  const top = (msg.components || []).map(toJSON);
  assert.ok(top.length >= 1 && top.length <= 10, `${where}: 최상위 ${top.length}개`);
  let count = 0;
  let textLen = 0;
  const rows = [];
  const ids = new Set();
  const texts = [];
  const images = [];
  walk(top, (c) => {
    count++;
    if (c.type === TYPE.text) {
      assert.ok(c.content.length > 0, `${where}: 빈 텍스트`);
      textLen += c.content.length;
      texts.push(c.content);
    }
    if (c.type === TYPE.gallery) for (const it of c.items) images.push(it.media.url);
    if (c.type === TYPE.thumb) images.push(c.media.url);
    if (c.type === TYPE.section) {
      assert.ok(c.components.length >= 1 && c.components.length <= 3, `${where}: 섹션 텍스트 개수`);
      assert.ok(c.accessory, `${where}: 섹션 accessory 없음`);
    }
    if (c.type === TYPE.row) {
      rows.push(c);
      assert.ok(c.components.length >= 1 && c.components.length <= 5, `${where}: 한 줄 컴포넌트 ${c.components.length}개`);
    }
    if (c.type === TYPE.button || c.type === TYPE.select) {
      assert.ok(c.custom_id && c.custom_id.length <= 100, `${where}: custom_id ${c.custom_id}`);
      assert.ok(!ids.has(c.custom_id), `${where}: custom_id 중복 ${c.custom_id}`);
      ids.add(c.custom_id);
      if (c.label) assert.ok(c.label.length <= 80, `${where}: 버튼 라벨 길이`);
      if (c.options) {
        assert.ok(c.options.length >= 1 && c.options.length <= 25, `${where}: 선택지 ${c.options.length}개`);
        for (const o of c.options) assert.ok(o.label.length <= 100 && (o.description || '').length <= 100, `${where}: 선택지 길이`);
      }
    }
  });
  assert.ok(count <= 40, `${where}: 컴포넌트 ${count}개 (최대 40)`);
  assert.ok(textLen <= 4000, `${where}: 텍스트 ${textLen}자 (최대 4000)`);
  return { rows, ids, texts, images, text: texts.join('\n') };
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
      if (m.flags & 64) screen = m; // 64 = 나만 보이는 메시지
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
    async command(target, commandName = '주식') {
      await handleCommand(base({ commandName, options: { getString: () => target ?? null } }), { state });
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
      // 맨 위 카드(알림)의 글자
      const first = toJSON(screen.components[0]);
      const out = [];
      walk([first], (c) => { if (c.type === TYPE.text) out.push(c.content); });
      return out.join('\n');
    },
  };
}

test('명령어는 /주식, /직업랜덤뽑기, /환생', () => {
  assert.deepStrictEqual(definitions.map((d) => d.name), ['주식', '직업랜덤뽑기', '환생']);
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
  assert.ok(asset.images.some((u) => /charts\/005930_1d\.png\?v=/.test(u)), asset.images.join());
  assert.ok(asset.images.some((u) => /icon_005930/.test(u)));
  const w = await h.click('stk|a|005930|1w');
  assert.ok(w.images.some((u) => /005930_1w/.test(u)));
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

// 화면의 모든 필드 텍스트를 한 줄로
const fieldsText = (screen) => checkMessage(screen, '본문').text;
const findId = (r, prefix) => [...r.ids].find((x) => x.startsWith(prefix));

test('매수 주문창: 버튼으로 수량을 고르면 미리보기만 바뀌고, 실행해야 체결된다', async () => {
  const state = makeState();
  const h = harness(state);
  await h.command('005930');
  let t = await h.click('stk|tb|005930|cash|0|o');
  assert.match(fieldsText(h.screen), /수량을 정해 주세요/);
  assert.ok(toJSON(t.rows[3].components[0]).disabled, '수량 0이면 실행 버튼 비활성');
  t = await h.click(findId(t, 'stk|tb|005930|cash|10|pb'));
  const preview = fieldsText(h.screen);
  assert.match(preview, /10주 × 70,000원/);
  assert.match(preview, /내 돈 지출/);
  assert.match(preview, /거래 후 모습/);
  assert.strictEqual(game.getUser(state, 'u1').cash, game.START_CASH, '미리보기는 계좌를 바꾸지 않는다');
  // 신용으로 바꾸면 대출이 보인다
  await h.pick('stk|tbm|005930|10', 'credit');
  assert.match(fieldsText(h.screen), /대출[\s\S]*350,000원/);
  // 최대 → 실행
  t = await h.pick('stk|tbm|005930|10', 'cash');
  t = await h.click(findId(t, 'stk|tb|005930|cash|') && [...t.ids].find((x) => x.endsWith('|r3')));
  const exec = findId(t, 'stk|xb|005930|cash|');
  const maxQty = Number(exec.split('|')[4]);
  assert.strictEqual(maxQty, 14);
  const r = await h.click(exec);
  assert.match(fieldsText(h.screen), /매수 체결[\s\S]*현금[\s\S]*→/);
  assert.strictEqual(game.getUser(state, 'u1').holdings['005930'].qty, 14);
  assert.ok(findId(r, 'stk|tb|005930|cash|0|n'), '한 번 더 주문 버튼');
});

test('직접 입력: 금액·비율 입력이 주문창 미리보기로 들어간다 (체결 X)', async () => {
  const state = makeState();
  const h = harness(state);
  await h.click('stk|tb|BTC|cash|0|o');
  const m = await h.click('stk|qi|b|BTC|cash');
  assert.strictEqual(m.custom_id, 'stk|mq|b|BTC|cash');
  const t = await h.submit('stk|mq|b|BTC|cash', { v: '10만원' });
  assert.ok(findId(t, 'stk|xb|BTC|cash|0.001'));
  assert.strictEqual(game.getUser(state, 'u1').holdings.BTC, undefined);
  await h.submit('stk|mq|b|BTC|cash', { v: '이상한값' });
  assert.match(h.notice(), /⚠️/);
});

test('매도 주문창: 실현 손익과 대출 자동 상환을 미리 보여 준다', async () => {
  const state = makeState();
  const h = harness(state);
  game.buy(state, 'u1', 'g1', '005930', '10', 'credit');
  state.market.assets['005930'].price = 77000;
  let t = await h.click('stk|ts|005930|0|o');
  t = await h.click([...t.ids].find((x) => x.startsWith('stk|ts|005930|5|')));
  const p = fieldsText(h.screen);
  assert.match(p, /실현 이익[\s\S]*\+35,000원|\+34,/);
  assert.match(p, /대출 자동 상환/);
  await h.click('stk|xs|005930|5');
  assert.strictEqual(game.getUser(state, 'u1').holdings['005930'].qty, 5);
  // 보유 없는 종목
  const none = await h.click('stk|ts|AAPL|0|o');
  assert.ok(toJSON(none.rows[2].components[0]).disabled);
});

test('선물 주문창: 레버리지·방향·증거금 → 청산가와 손익 시나리오 → 진입', async () => {
  const state = makeState();
  const h = harness(state);
  let t = await h.click('stk|tf|BTC|long|5|0|o');
  t = await h.pick('stk|tfl|BTC|long|0', '10');
  t = await h.click(findId(t, 'stk|tf|BTC|long|10|100000|pb'));
  let p = fieldsText(h.screen);
  assert.match(p, /포지션 규모[\s\S]*1,000,000원/);
  assert.match(p, /강제청산 가격[\s\S]*91,000,000원/);
  assert.match(p, /\+1\.00% → \+10,000원/);
  t = await h.click('stk|tf|BTC|short|10|100000|S');
  p = fieldsText(h.screen);
  assert.match(p, /\+1\.00% → -10,000원/);
  await h.click('stk|xf|BTC|short|10|100000');
  assert.match(fieldsText(h.screen), /선물 진입/);
  assert.strictEqual(game.getUser(state, 'u1').futures.length, 1);
  await h.click('stk|qi|f|BTC|long|10');
  await h.submit('stk|mq|f|BTC|long|10', { v: '5만' });
  assert.ok(findId(checkMessage(h.screen, '직접 입력 후'), 'stk|xf|BTC|long|10|50000'));
});

test('옵션 주문창: 행사가·만기·수량 → 손익분기점과 만기 시나리오 → 매수', async () => {
  const state = makeState();
  const h = harness(state);
  let t = await h.click('stk|to|005930|call|1d|0|0|o');
  t = await h.click('stk|to|005930|call|1d|5|0|U');
  assert.match(fieldsText(h.screen), /행사가[\s\S]*73,500원/);
  t = await h.pick('stk|toe|005930|call|5|0', '1w');
  t = await h.click(findId(t, 'stk|to|005930|call|1w|5|10|pb'));
  const p = fieldsText(h.screen);
  assert.match(p, /최대 손실/);
  assert.match(p, /손익분기점/);
  assert.match(p, /만기 때 가격별 손익/);
  t = await h.click('stk|to|005930|put|1w|5|10|P');
  await h.click('stk|xo|005930|put|1w|5|10');
  assert.match(fieldsText(h.screen), /옵션 매수/);
  const u = game.getUser(state, 'u1');
  assert.strictEqual(u.options[0].kind, 'put');
  assert.strictEqual(u.options[0].strike, 73500);
});

test('실행 직전에 조건이 바뀌면 체결하지 않고 이유를 보여 준다', async () => {
  const state = makeState();
  const h = harness(state);
  game.getUser(state, 'u1').cash = 1000;
  await h.click('stk|xb|005930|cash|10');
  assert.match(h.notice(), /체결되지 않았어요/);
  assert.strictEqual(game.getUser(state, 'u1').holdings['005930'], undefined);
});

test('모든 종목의 모든 주문창이 디스코드 제한을 지킨다', async () => {
  const state = makeState();
  const h = harness(state);
  game.getUser(state, 'u1', 'g1');
  for (const a of ASSETS) {
    await h.click(`stk|tb|${a.id}|misu|0|o`);
    await h.click(`stk|tb|${a.id}|cash|${a.decimals ? '0.5' : '3'}|x`);
    await h.click(`stk|tf|${a.id}|short|50|200000|x`);
    await h.click(`stk|to|${a.id}|put|1h|-50|1|x`);
    await h.click(`stk|ts|${a.id}|0|o`);
    await h.click(`stk|qi|b|${a.id}|cash`);
    await h.click(`stk|qi|o|${a.id}|call|1d|0`);
  }
  await h.click('stk|tb|없는종목|cash|0|o');
  assert.match(h.notice(), /찾을 수 없어요/);
});

test('검색·출석·랭킹·도움말·공유', async () => {
  const state = makeState();
  const h = harness(state);
  await h.command();
  await h.click('stk|search');
  const many = await h.submit('stk|m_search', { q: '삼성' });
  assert.ok([...many.ids].filter((x) => x.startsWith('stk|a|') && x.endsWith('|s')).length > 1, '검색 결과 줄마다 버튼');
  await h.click('stk|a|005930|1d|s');
  assert.match(fieldsText(h.screen), /삼성전자/);
  await h.submit('stk|m_search', { q: 'AAPL' });
  assert.match(fieldsText(h.screen), /애플/);
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
  assert.ok(!checkMessage(h.screen, 'AAPL').images.some((u) => /charts\/AAPL_/.test(u)));
  await h.click('stk|tb|AAPL|cash|0|o');
  assert.match(fieldsText(h.screen), /시세 준비 중/);
  await h.click('stk|xb|AAPL|cash|1');
  assert.match(h.notice(), /시세/);
});

test('선물·옵션 → 포지션에서 선택·확인으로 정리 → 대출 상환', async () => {
  const state = makeState();
  const h = harness(state);
  await h.command('BTC');
  await h.click('stk|xf|BTC|short|10|100000');
  await h.click('stk|xo|005930|call|1w|5|10');
  await h.click('stk|xb|005930|credit|5');
  const pos = await h.click('stk|pos');
  const closeBtns = [...pos.ids].filter((x) => x.startsWith('stk|closeb|'));
  assert.strictEqual(closeBtns.length, 2, '포지션 줄마다 정리 버튼');
  assert.match(pos.text, /담보비율/);
  const confirm = await h.click(closeBtns[0]);
  assert.match(confirm.text, /청산 확인/);
  const ok = [...confirm.ids].find((x) => x.startsWith('stk|closeok|'));
  await h.click(ok);
  assert.match(h.notice(), /청산/);
  await h.click('stk|closeb|' + closeBtns[1].split('|')[2]);
  await h.click('stk|closeok|' + closeBtns[1].split('|')[2]);
  assert.match(h.notice(), /옵션 .* 매도/);
  await h.click('stk|repay');
  await h.submit('stk|m_repay', { amount: '전부' });
  assert.match(h.notice(), /상환/);
  const u = game.getUser(state, 'u1');
  assert.strictEqual(u.futures.length + u.options.length + u.loans.length, 0);
});

test('누를 수 있는 UI: 홈 시장 버튼·목록 줄 버튼·랭킹에서 남의 자산·도움말 바로가기', async () => {
  const state = makeState();
  const h = harness(state);
  const home = await h.command();
  const heat = [...home.ids].filter((x) => x.startsWith('stk|a|') && x.endsWith('|h'));
  assert.ok(heat.length >= 10, '홈 시장 종목 버튼');
  await h.click(heat[0]);
  assert.match(fieldsText(h.screen), /원/);

  const list = await h.click('stk|list|kr|0');
  const rowsBtns = [...list.ids].filter((x) => x.endsWith('|l'));
  assert.strictEqual(rowsBtns.length, 8);
  await h.click('stk|list|kr|6');

  // 다른 사람 계좌 만들고 랭킹 → 그 사람 자산 (보기 전용)
  game.getUser(state, 'u2', 'g1').cash = 2_000_000;
  game.buy(state, 'u2', 'g1', 'AAPL', '1', 'cash');
  const rank = await h.click('stk|rank|all');
  assert.match(rank.text, /내 순위/);
  assert.ok(rank.ids.has('stk|pfu|u2'));
  const other = await h.click('stk|pfu|u2');
  assert.match(other.text, /<@u2>님의 자산/);
  assert.ok(!other.ids.has('stk|share|pf'), '남의 자산 화면엔 공유·파산 버튼 없음');
  assert.ok(other.ids.has('stk|a|AAPL|1d|pf'));
  await h.click('stk|pfu|nobody');
  assert.match(h.notice(), /찾을 수 없어요/);

  const help = await h.click('stk|help');
  assert.ok(help.ids.has('stk|list|kr|0'));
});

test('포지션이 많아도 제한을 지키고 나머지는 메뉴로', async () => {
  const state = makeState();
  const h = harness(state);
  game.getUser(state, 'u1', 'g1').cash = 1e9;
  for (let i = 0; i < 20; i++) game.openFuture(state, 'u1', 'g1', 'BTC', i % 2 ? 'long' : 'short', '1만', 2);
  for (let i = 0; i < 20; i++) game.buyOption(state, 'u1', 'g1', 'BTC', 'call', '현재가', '1w', '0.001');
  game.buy(state, 'u1', 'g1', 'BTC', '0.01', 'misu');
  for (const a of ASSETS.slice(0, 40)) game.buy(state, 'u1', 'g1', a.id, a.decimals ? '0.01' : '1', 'cash');
  const pos = await h.click('stk|pos');
  assert.ok(pos.ids.has('stk|close'));
  await h.click('stk|pf');
  await h.click('stk|rank|all');
});

test('처음 /주식: 운명 카드 → 출석은 직업 보상', async () => {
  const state = makeState();
  const h = harness(state);
  const home = await h.command();
  assert.match(h.notice(), /운명이 정해졌어요/);
  assert.match(home.text, /동수저 · 💼 회사원/);
  await h.click('stk|daily');
  assert.match(h.notice(), /회사원 출석 보상 \*\*1,000,000원\*\*/);
  // 두 번째부터는 운명 카드 없음
  await h.command();
  assert.doesNotMatch(h.notice(), /운명이 정해졌어요/);
});

test('/환생: 경고·확인 화면 → 24시간 쿨다운 → 실행하면 새 인생', async () => {
  const state = makeState();
  const h = harness(state);
  await h.command();
  game.buy(state, 'u1', 'g1', '005930', '3', 'credit');
  // 막 태어났으면 24시간 동안 환생 불가 (버튼 비활성)
  let c = await h.command(null, '환생');
  assert.match(c.text, /정말 환생하시겠어요/);
  assert.match(c.text, /사라지는 것[\s\S]*보유 종목 1개[\s\S]*대출/);
  const rows = c.rows.flatMap((r) => r.components);
  assert.ok(rows.find((b) => b.custom_id === 'stk|rbok').disabled);
  await h.click('stk|rbok'); // 그래도 누르면 거절
  assert.match(h.notice(), /24시간에 한 번/);
  assert.ok(game.getUser(state, 'u1').holdings['005930']);

  // 하루 지난 것으로
  game.getUser(state, 'u1').lastRebirthAt -= 25 * 3600e3;
  game.setLifeRoller(() => ({ origin: 'gold', job: 'doctor', startCash: 150_000_000 }));
  try {
    c = await h.click('stk|rb');
    assert.ok(!c.rows.flatMap((r) => r.components).find((b) => b.custom_id === 'stk|rbok').disabled);
    const done = await h.click('stk|rbok');
    assert.match(done.text, /새로운 인생이 시작됐어요/);
    assert.match(done.text, /금수저[\s\S]*150,000,000원[\s\S]*의사[\s\S]*4,000,000원/);
    const u = game.getUser(state, 'u1');
    assert.strictEqual(u.cash, 150_000_000);
    assert.deepStrictEqual(u.holdings, {});
    assert.strictEqual(u.loans.length, 0);
    assert.strictEqual(u.rebirths, 1);
    // 수익률은 새 시작 자금 기준
    const home = await h.click('stk|home');
    assert.match(home.text, /시작 자금 150,000,000원 대비/);
  } finally {
    game.setLifeRoller(() => ({ origin: 'bronze', job: 'office', startCash: 1_000_000 }));
  }
});

test('/직업랜덤뽑기: 확인 화면 → 뽑기 → 결과, 같은 날 두 번은 안 됨', async () => {
  const state = makeState();
  const h = harness(state);
  await h.command();
  let c = await h.command(null, '직업랜덤뽑기');
  assert.match(c.text, /직업 다시 뽑기[\s\S]*지금 직업: 💼 \*\*회사원\*\*/);
  assert.match(c.text, /아이돌 1%/);
  game.setLifeRoller(() => ({ origin: 'bronze', job: 'office', startCash: 1_000_000 }), () => 'jobless');
  try {
    const r = await h.click('stk|jrok');
    assert.match(r.text, /새 직업: 🛋️ 백수/);
    assert.match(r.text, /1,000,000원\*\* → \*\*100,000원/);
    c = await h.click('stk|jr');
    assert.ok(c.rows.flatMap((x) => x.components).find((b) => b.custom_id === 'stk|jrok').disabled);
    await h.click('stk|jrok');
    assert.match(h.notice(), /하루에 한 번/);
    assert.strictEqual(game.getUser(state, 'u1').job, 'jobless');
    // 결과 화면의 출석 버튼은 새 직업 보상
    await h.click('stk|daily|jr');
    assert.match(h.notice(), /백수 출석 보상 \*\*100,000원/);
  } finally {
    game.setLifeRoller(() => ({ origin: 'bronze', job: 'office', startCash: 1_000_000 }));
  }
});

test('명령어는 서버 설치와 내 계정 설치 둘 다 지원하고, 서버 안에서만 쓴다', () => {
  for (const d of definitions) {
    assert.deepStrictEqual(d.integration_types, [0, 1], d.name);
    assert.deepStrictEqual(d.contexts, [0], d.name);
  }
});
