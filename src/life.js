// 출신(시작 자금)과 직업(매일 출석 보상) 뽑기표
//  weight: 뽑힐 확률(%), 합계 100 (소수 가능)
//  min/max: 시작 자금 범위(원, 같으면 고정 금액), pay: 하루 출석 보상(원)

const ORIGINS = [
  { key: 'chaebol', name: '재벌가 자제', emoji: '🏰', weight: 0.01, min: 1_000_000_000, max: 3_000_000_000, desc: '태어날 때부터 그룹 지분이 있었다' },
  { key: 'gold', name: '금수저', emoji: '💎', weight: 0.99, min: 100_000_000, max: 100_000_000, desc: '부모님이 건물주' },
  { key: 'silver', name: '은수저', emoji: '🥈', weight: 10, min: 20_000_000, max: 30_000_000, desc: '넉넉한 중산층 집안' },
  { key: 'bronze', name: '동수저', emoji: '🥉', weight: 40, min: 10_000_000, max: 20_000_000, desc: '평범한 맞벌이 가정' },
  { key: 'dirt', name: '흙수저', emoji: '🪵', weight: 40, min: 10_000_000, max: 10_000_000, desc: '모은 돈은 알바비가 전부' },
  { key: 'orphan', name: '고아', emoji: '🍂', weight: 9, min: 5_000_000, max: 5_000_000, desc: '기댈 곳 없이 혼자 시작한다' },
];

// 출신·직업 기능 전에 만들어진 계좌
const LEGACY_ORIGIN = { key: 'legacy', name: '1세대 투자자', emoji: '🧭', weight: 0, min: 1_000_000, max: 1_000_000, desc: '출신 제도 이전부터 투자해 온 개척자' };

const JOBS = [
  { key: 'jobless', name: '백수', emoji: '🛋️', weight: 30, pay: 100_000 },
  { key: 'parttime', name: '아르바이트생', emoji: '🧹', weight: 20, pay: 300_000 },
  { key: 'factory', name: '생산직 근로자', emoji: '🏭', weight: 10, pay: 700_000 },
  { key: 'office', name: '회사원', emoji: '💼', weight: 10, pay: 1_000_000 },
  { key: 'civil', name: '공무원', emoji: '🏛️', weight: 10, pay: 1_200_000 },
  { key: 'dev', name: '개발자', emoji: '🧑‍💻', weight: 5, pay: 1_500_000 },
  { key: 'fund', name: '펀드매니저', emoji: '📈', weight: 5, pay: 2_000_000 },
  { key: 'lawyer', name: '변호사', emoji: '⚖️', weight: 5, pay: 3_000_000 },
  { key: 'doctor', name: '의사', emoji: '🩺', weight: 4, pay: 4_000_000 },
  { key: 'idol', name: '아이돌', emoji: '🎤', weight: 1, pay: 10_000_000 },
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

function rollJob(rng = Math.random) {
  return pick(JOBS, rng).key;
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

module.exports = {
  ORIGINS, JOBS, LEGACY_ORIGIN, REBIRTH_COOLDOWN_MS, rollLife, rollJob, rollCapital, originOf, jobOf, pick,
};
