// 차트 PNG 그리기 (GitHub Actions에서만 실행)

const path = require('path');
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');

const FONT_DIR = path.dirname(require.resolve('@expo-google-fonts/nanum-gothic/package.json'));
GlobalFonts.registerFromPath(path.join(FONT_DIR, '400Regular/NanumGothic_400Regular.ttf'), 'Nanum');
GlobalFonts.registerFromPath(path.join(FONT_DIR, '800ExtraBold/NanumGothic_800ExtraBold.ttf'), 'NanumBold');

const W = 800;
const H = 420;
const PAD = { left: 16, right: 86, top: 70, bottom: 34 };
const C = {
  bg: '#1e1f22',
  grid: '#2f3136',
  text: '#dbdee1',
  sub: '#949ba4',
  up: '#f03e3e',    // 한국 증시 관례: 상승 빨강
  down: '#4dabf7',  // 하락 파랑
  line: '#ffd43b',
};

const RANGE_LABEL = { '1d': '1일', '1w': '1주', '1m': '1달', '1y': '1년' };

function fmtPrice(v, currency) {
  const digits = Math.abs(v) >= 1000 ? 0 : Math.abs(v) >= 10 ? 2 : 4;
  const s = v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: digits });
  return currency === 'USD' ? `$${s}` : currency === 'JPY' ? `¥${s}` : `${s}`;
}

function niceTicks(min, max, count = 5) {
  const span = max - min || Math.abs(max) || 1;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) || step0;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) ticks.push(v);
  return ticks;
}

function timeLabel(t, range, tz) {
  const d = new Date(t);
  const opt = range === '1d' ? { hour: '2-digit', minute: '2-digit', hour12: false }
    : range === '1w' ? { month: 'numeric', day: 'numeric', hour: '2-digit', hour12: false }
      : range === '1m' ? { month: 'numeric', day: 'numeric' }
        : { year: '2-digit', month: 'numeric' };
  return d.toLocaleString('ko-KR', { ...opt, timeZone: tz });
}

// points: [{ t, o, h, l, c }] (시간 오름차순)
function renderChart({ name, id, currency, range, points, tz = 'Asia/Seoul' }) {
  const canvas = createCanvas(W, H);
  const g = canvas.getContext('2d');
  g.fillStyle = C.bg;
  g.fillRect(0, 0, W, H);

  const valid = points.filter((p) => Number.isFinite(p.c));
  if (valid.length < 2) {
    g.fillStyle = C.sub;
    g.font = '22px Nanum';
    g.fillText(`${name} — 차트 데이터 없음`, 30, H / 2);
    return canvas.toBuffer('image/png');
  }

  const first = valid[0].o ?? valid[0].c;
  const last = valid[valid.length - 1].c;
  const change = ((last - first) / first) * 100;
  const color = change >= 0 ? C.up : C.down;
  const candles = valid.length <= 100 && valid.every((p) => Number.isFinite(p.o) && Number.isFinite(p.h) && Number.isFinite(p.l));

  // 제목
  g.fillStyle = C.text;
  g.font = '26px NanumBold';
  g.fillText(name, PAD.left + 4, 34);
  const nameW = g.measureText(name).width;
  g.fillStyle = C.sub;
  g.font = '16px Nanum';
  g.fillText(`${id} · ${RANGE_LABEL[range] || range}`, PAD.left + 14 + nameW, 34);
  g.font = '22px NanumBold';
  g.fillStyle = color;
  g.fillText(`${fmtPrice(last, currency)}  ${change >= 0 ? '▲' : '▼'} ${change >= 0 ? '+' : ''}${change.toFixed(2)}%`, PAD.left + 4, 60);

  // 축 범위
  const lows = valid.map((p) => (candles ? p.l : p.c));
  const highs = valid.map((p) => (candles ? p.h : p.c));
  let min = Math.min(...lows);
  let max = Math.max(...highs);
  const padY = (max - min) * 0.08 || Math.abs(max) * 0.01 || 1;
  min -= padY;
  max += padY;
  const x0 = PAD.left;
  const x1 = W - PAD.right;
  const y0 = PAD.top;
  const y1 = H - PAD.bottom;
  const xOf = (i) => x0 + ((x1 - x0) * (i + 0.5)) / valid.length;
  const yOf = (v) => y1 - ((v - min) / (max - min)) * (y1 - y0);

  // 가로 눈금
  g.font = '13px Nanum';
  g.lineWidth = 1;
  for (const v of niceTicks(min, max)) {
    const y = Math.round(yOf(v)) + 0.5;
    g.strokeStyle = C.grid;
    g.beginPath();
    g.moveTo(x0, y);
    g.lineTo(x1, y);
    g.stroke();
    g.fillStyle = C.sub;
    g.fillText(fmtPrice(v, currency), x1 + 8, y + 4);
  }

  // 시간 눈금 (5개 정도)
  const labelCount = 5;
  g.fillStyle = C.sub;
  for (let k = 0; k < labelCount; k++) {
    const i = Math.round((k * (valid.length - 1)) / (labelCount - 1));
    const label = timeLabel(valid[i].t, range, tz);
    const w = g.measureText(label).width;
    g.fillText(label, Math.min(Math.max(xOf(i) - w / 2, x0), x1 - w), H - 10);
  }

  if (candles) {
    const bw = Math.max(1, Math.min(14, ((x1 - x0) / valid.length) * 0.65));
    valid.forEach((p, i) => {
      const up = p.c >= p.o;
      g.strokeStyle = up ? C.up : C.down;
      g.fillStyle = up ? C.up : C.down;
      const x = xOf(i);
      g.beginPath();
      g.moveTo(Math.round(x) + 0.5, yOf(p.h));
      g.lineTo(Math.round(x) + 0.5, yOf(p.l));
      g.stroke();
      const top = yOf(Math.max(p.o, p.c));
      const bot = yOf(Math.min(p.o, p.c));
      g.fillRect(x - bw / 2, top, bw, Math.max(1, bot - top));
    });
  } else {
    // 선 + 그라데이션 영역
    const grad = g.createLinearGradient(0, y0, 0, y1);
    grad.addColorStop(0, `${color}55`);
    grad.addColorStop(1, `${color}00`);
    g.beginPath();
    valid.forEach((p, i) => (i ? g.lineTo(xOf(i), yOf(p.c)) : g.moveTo(xOf(i), yOf(p.c))));
    g.lineTo(xOf(valid.length - 1), y1);
    g.lineTo(xOf(0), y1);
    g.closePath();
    g.fillStyle = grad;
    g.fill();
    g.beginPath();
    valid.forEach((p, i) => (i ? g.lineTo(xOf(i), yOf(p.c)) : g.moveTo(xOf(i), yOf(p.c))));
    g.strokeStyle = color;
    g.lineWidth = 2;
    g.stroke();
  }

  // 현재가 가이드선
  const ly = Math.round(yOf(last)) + 0.5;
  g.setLineDash([4, 4]);
  g.strokeStyle = color;
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(x0, ly);
  g.lineTo(x1, ly);
  g.stroke();
  g.setLineDash([]);
  g.fillStyle = color;
  g.fillRect(x1 + 2, ly - 10, PAD.right - 4, 20);
  g.fillStyle = '#ffffff';
  g.font = '13px NanumBold';
  g.fillText(fmtPrice(last, currency), x1 + 6, ly + 5);

  return canvas.toBuffer('image/png');
}

// ── 종목 아이콘 ──────────────────────────────────────────────

const CATEGORY_COLOR = {
  kr: ['#1c7ed6', '#4dabf7'],
  us: ['#5f3dc4', '#9775fa'],
  etf: ['#087f5b', '#38d9a9'],
  futures: ['#d9480f', '#ffa94d'],
  crypto: ['#e67700', '#ffd43b'],
  macro: ['#495057', '#adb5bd'],
};

function iconLabel(asset) {
  if (asset.category === 'kr' || (asset.category === 'etf' && /^\d/.test(asset.id))) {
    return asset.name.replace(/^(KODEX|TIGER)\s*/, '').replace(/[^가-힣A-Za-z0-9&]/g, '').slice(0, 2);
  }
  if (asset.id === 'GOLD') return '금';
  return asset.id.replace(/-.*/, '').slice(0, 4);
}

function renderIcon(asset, size = 96) {
  const canvas = createCanvas(size, size);
  const g = canvas.getContext('2d');
  const [c1, c2] = CATEGORY_COLOR[asset.category] || CATEGORY_COLOR.macro;
  const grad = g.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, c1);
  grad.addColorStop(1, c2);
  g.fillStyle = grad;
  g.beginPath();
  g.roundRect(0, 0, size, size, size * 0.24);
  g.fill();
  const label = iconLabel(asset);
  g.fillStyle = '#ffffff';
  const fs = label.length <= 2 ? size * 0.36 : label.length === 3 ? size * 0.3 : size * 0.25;
  g.font = `${fs}px NanumBold`;
  const w = g.measureText(label).width;
  g.fillText(label, (size - w) / 2, size / 2 + fs * 0.36);
  return canvas.toBuffer('image/png');
}

module.exports = { renderChart, renderIcon, RANGE_LABEL };
