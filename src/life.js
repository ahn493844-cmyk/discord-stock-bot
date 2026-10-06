// 출신(시작 자금)과 직업(매일 출석 보상) 뽑기표
//  weight: 뽑힐 확률(%), 합계 100
//  min/max: 시작 자금 범위(원), pay: 하루 출석 보상(원)

const ORIGINS = [
  { key: 'chaebol', name: '재벌가 자제', emoji: '🏰', weight: 1, min: 1_000_000_000, max: 3_000_000_000, desc: '태어날 때부터 그룹 지분이 있었다' },
  { key: 'gold', name: '금수저', emoji: '💎', weight: 4, min: 100_000_000, max: 300_000_000, desc: '부모님이 건물주' },
  { key: 'silver', name: '은수저', emoji: '🥈', weight: 15, min: 30_000_000, max: 70_000_000, desc: '넉넉한 중산층 집안' },
  { key: 'bronze', name: '동수저', emoji: '🥉', weight: 30, min: 10_000_000, max: 20_000_000, desc: '평범한 맞벌이 가정' },
  { key: 'dirt', name: '흙수저', emoji: '🪵', weight: 35, min: 3_000_000, max: 7_000_000, desc: '모은 돈은 알바비가 전부' },
  { key: 'broke', name: '무일푼', emoji: '🍂', weight: 15, min: 500_000, max: 1_500_000, desc: '통장 잔고가 불안하다' },
];

// 출신·직업 기능 전에 만들어진 계좌
const LEGACY_ORIGIN = { key: 'legacy', name: '1세대 투자자', emoji: '🧭', weight: 0, min: 1_000_000, max: 1_000_000, desc: '출신 제도 이전부터 투자해 온 개척자' };

const JOBS = [
  { key: 'jobless', name: '백수', emoji: '🛋️', weight: 5, pay: 10_000 },
  { key: 'parttime', name: '아르바이트생', emoji: '🧹', weight: 22, pay: 30_000 },
  { key: 'factory', name: '생산직 근로자', emoji: '🏭', weight: 15, pay: 70_000 },
  { key: 'office', name: '회사원', emoji: '💼', weight: 25, pay: 100_000 },
  { key: 'civil', name: '공무원', emoji: '🏛️', weight: 10, pay: 120_000 },
  { key: 'dev', name: '개발자', emoji: '🧑‍💻', weight: 10, pay: 200_000 },
  { key: 'fund', name: '펀드매니저', emoji: '📈', weight: 5, pay: 300_000 },
  { key: 'lawyer', name: '변호사', emoji: '⚖️', weight: 4, pay: 350_000 },
  { key: 'doctor', name: '의사', emoji: '🩺', weight: 3, pay: 400_000 },
  { key: 'star', name: '톱스타', emoji: '🎤', weight: 1, pay: 1_000_000 },
];

const REBIRTH_COOLDOWN_MS = 24 * 3600 * 1000;

function pick(table, rng) {
  const total = table.reduce((s, x) => s + x.weight, 0);
  let r = rng() * total;
  for (const x of table) {
    r -= x.weight;
    if (r < 0) return x;
  }
  return table[table.length - 1];
}

// 시작 자금: 범위 안에서 10만원 단위로
function rollCapital(origin, rng) {
  const unit = 100_000;
  const steps = Math.floor((origin.max - origin.min) / unit);
  return origin.min + Math.floor(rng() * (steps + 1)) * unit;
}

function rollLife(rng = Math.random) {
  const origin = pick(ORIGINS, rng);
  const job = pick(JOBS, rng);
  return { origin: origin.key, job: job.key, startCash: rollCapital(origin, rng) };
}

function originOf(key) {
  return ORIGINS.find((o) => o.key === key) || LEGACY_ORIGIN;
}

function jobOf(key) {
  return JOBS.find((j) => j.key === key) || JOBS.find((j) => j.key === 'office');
}

// "상위 5%" 같은 희귀도 표시 (자기보다 좋은 출신 + 자기 확률)
function originRarity(key) {
  const i = ORIGINS.findIndex((o) => o.key === key);
  if (i < 0) return null;
  return ORIGINS.slice(0, i + 1).reduce((s, o) => s + o.weight, 0);
}

function jobRarity(key) {
  const sorted = [...JOBS].sort((a, b) => b.pay - a.pay);
  const i = sorted.findIndex((j) => j.key === key);
  return i < 0 ? null : sorted.slice(0, i + 1).reduce((s, j) => s + j.weight, 0);
}

module.exports = {
  ORIGINS, JOBS, LEGACY_ORIGIN, REBIRTH_COOLDOWN_MS, rollLife, rollCapital, originOf, jobOf, originRarity, jobRarity, pick,
};
