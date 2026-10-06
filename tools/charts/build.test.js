// node --test 로 실행되는 차트 도구 테스트 (네트워크·캔버스 없이 계산만)
const test = require('node:test');
const assert = require('node:assert');

test('직전 거래일 종가: 장 마감 후에도 오늘 등락이 나온다', () => {
  // build.js는 실행 시 바로 수집을 시작하므로 함수만 꺼내 쓴다
  const src = require('fs').readFileSync(require('path').join(__dirname, 'build.js'), 'utf-8');
  const fn = new Function(`${src.slice(src.indexOf('function previousClose'), src.indexOf('// ── 업비트'))}; return previousClose;`)();
  const KST = 9 * 3600;
  const at = (d, h) => Date.UTC(2026, 9, d, h - 9); // KST d일 h시
  const points = [
    { t: at(5, 10), c: 100 }, { t: at(5, 15), c: 110 }, // 어제 종가 110
    { t: at(6, 10), c: 112 }, { t: at(6, 15), c: 121 }, // 오늘 종가 121
  ];
  // 장 마감 후: 거래 세션 정보가 내일 아침을 가리켜도 전일 종가는 어제 110
  const meta = { gmtoffset: KST, currentTradingPeriod: { regular: { start: at(7, 9) / 1000, end: at(7, 15) / 1000 } } };
  assert.strictEqual(fn(meta, points), 110);
  // 데이터가 하루뿐이면 메타 정보로
  assert.strictEqual(fn({ gmtoffset: KST, chartPreviousClose: 99 }, points.slice(2)), 99);
});
