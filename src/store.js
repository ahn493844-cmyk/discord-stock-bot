// JSON 파일 저장소 — 메모리 상태를 주기적으로 디스크에 원자적으로 기록

const fs = require('fs');
const path = require('path');
const { createState, normalizeState } = require('./game');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'stock_game.json');

function load() {
  try {
    if (!fs.existsSync(DATA_FILE)) return createState();
    return normalizeState(JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')));
  } catch (err) {
    // 원본을 덮어쓰기 전에 백업해 둔다
    const backup = `${DATA_FILE}.broken-${Date.now()}`;
    try {
      fs.copyFileSync(DATA_FILE, backup);
    } catch {
      // 백업 실패는 무시
    }
    console.error(`[store] 데이터 읽기 실패, 새로 시작합니다 (백업: ${backup}):`, err);
    return createState();
  }
}

function saveNow(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, DATA_FILE);
}

let timer = null;
function scheduleSave(state, delayMs = 1000) {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    try {
      saveNow(state);
    } catch (err) {
      console.error('[store] 저장 실패:', err.message);
    }
  }, delayMs);
}

function flush(state) {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  saveNow(state);
}

module.exports = { load, scheduleSave, flush, DATA_FILE };
