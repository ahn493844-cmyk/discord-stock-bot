// 블랙-숄즈 옵션 가격 계산

const RISK_FREE = 0.03;
const YEAR_MS = 365 * 24 * 3600 * 1000;

// 표준정규분포 누적분포함수 (Abramowitz-Stegun 근사)
function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

function intrinsic(kind, spot, strike) {
  return kind === 'call' ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
}

// 옵션 1단위 가격
function optionPrice(kind, spot, strike, msLeft, vol, r = RISK_FREE) {
  const T = msLeft / YEAR_MS;
  if (T <= 0 || vol <= 0) return intrinsic(kind, spot, strike);
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(spot / strike) + (r + (vol * vol) / 2) * T) / (vol * sqrtT);
  const d2 = d1 - vol * sqrtT;
  const disc = strike * Math.exp(-r * T);
  return kind === 'call'
    ? spot * normCdf(d1) - disc * normCdf(d2)
    : disc * normCdf(-d2) - spot * normCdf(-d1);
}

module.exports = { optionPrice, intrinsic, normCdf, YEAR_MS };
