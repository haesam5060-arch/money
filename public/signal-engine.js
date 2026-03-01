// ═══════════════════════════════════════════════════════════════
// Signal Engine V2 — 백테스터 검증 로직 정확 포팅
// 원본: modules/signal_engine.py, modules/backtester.py,
//       modules/indicators.py, modules/regime_filter.py
// ═══════════════════════════════════════════════════════════════

// ── 종목 유형별 프로필 (signal_engine.py 그대로) ──────────────
const STOCK_PROFILES = {
  default: {  // 중소형 성장주
    high_dist_max: 0.05,    // 20일 고점 대비 최대 거리 (5%)
    ma20_slope_min: 0.02,   // MA20 10일 최소 기울기 (2%)
    vol_overheat: 8.0,      // 거래량 과열 상한 (8배)
    rsi_optimal: [70, 85],
    rsi_forming: [60, 70],
    ret20d_strong: 0.15,
    ret20d_mid: 0.10,
    ret20d_weak: 0.05,
    take_profit: 0.17,
    stop_loss: 0.07,
    cooldown: 3,
    benford_weight: 0.10,
  },
  large_cap: {  // 대형 우량주
    high_dist_max: 0.07,
    ma20_slope_min: 0.01,
    vol_overheat: 6.0,
    rsi_optimal: [65, 80],
    rsi_forming: [55, 65],
    ret20d_strong: 0.08,
    ret20d_mid: 0.05,
    ret20d_weak: 0.03,
    take_profit: 0.10,
    stop_loss: 0.10,
    cooldown: 5,
    benford_weight: 0.10,
  },
  force_following: {  // 세력 추종형
    high_dist_max: 0.08,
    ma20_slope_min: 0.01,
    vol_overheat: 10.0,
    rsi_optimal: [70, 90],
    rsi_forming: [60, 70],
    ret20d_strong: 0.12,
    ret20d_mid: 0.07,
    ret20d_weak: 0.03,
    take_profit: 0.21,
    stop_loss: 0.07,
    cooldown: 5,
    benford_weight: 0.25,
  },
};

// ── 거래 비용 (국내 주식 기준) ────────────────────────────────
const COMMISSION_RATE = 0.00015;   // 0.015%
const SELL_TAX_RATE   = 0.0018;    // 0.18%
const ROUND_TRIP_COST = COMMISSION_RATE * 2 + SELL_TAX_RATE; // ≈ 0.21%

// ── 서킷 브레이커 ────────────────────────────────────────────
const CIRCUIT_BREAKER_LOSSES = 5;
const CIRCUIT_BREAKER_EXTRA  = 15;

// ═══════════════════════════════════════════════════════════════
// 기술지표 계산 (indicators.py 포팅)
// ═══════════════════════════════════════════════════════════════
function calcIndicatorsV2(data) {
  const n = data.length;
  if (n < 2) return data;
  const close = data.map(d => d.close);

  // 이동평균 (MA5, MA20, MA60, MA200)
  [5, 20, 60, 200].forEach(w => {
    const key = 'ma' + w;
    for (let i = 0; i < n; i++) {
      if (i < w - 1) { data[i][key] = null; continue; }
      let s = 0;
      for (let j = i - w + 1; j <= i; j++) s += close[j];
      data[i][key] = s / w;
    }
  });

  // RSI (Wilder 방식, period=14)
  const P = 14;
  const rsi = new Array(n).fill(null);
  if (n > P) {
    let ag = 0, al = 0;
    for (let i = 1; i <= P; i++) {
      const d = close[i] - close[i - 1];
      ag += (d > 0 ? d : 0);
      al += (d < 0 ? -d : 0);
    }
    ag /= P; al /= P;
    rsi[P] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    for (let i = P + 1; i < n; i++) {
      const d = close[i] - close[i - 1];
      ag = (ag * (P - 1) + (d > 0 ? d : 0)) / P;
      al = (al * (P - 1) + (d < 0 ? -d : 0)) / P;
      rsi[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    }
  }
  data.forEach((d, i) => d.rsi = rsi[i]);

  // 볼린저밴드 (20일, 2σ)
  for (let i = 0; i < n; i++) {
    if (i < 19) { data[i].bbMid = data[i].bbUpper = data[i].bbLower = null; continue; }
    let s = 0;
    for (let j = i - 19; j <= i; j++) s += close[j];
    const m = s / 20;
    let sq = 0;
    for (let j = i - 19; j <= i; j++) sq += (close[j] - m) ** 2;
    const std = Math.sqrt(sq / 19); // ddof=1 (sample std, Python 일치)
    data[i].bbMid = m;
    data[i].bbUpper = m + 2 * std;
    data[i].bbLower = m - 2 * std;
  }

  // 거래량 비율 (20일 평균)
  for (let i = 0; i < n; i++) {
    if (i < 19) { data[i].volRatio = data[i].volAvg = null; continue; }
    let s = 0;
    for (let j = i - 19; j <= i; j++) s += data[j].volume;
    data[i].volAvg = s / 20;
    data[i].volRatio = data[i].volume / (s / 20);
  }

  // MACD (12, 26, 9)
  const ema = (arr, span) => {
    const k = 2 / (span + 1), out = [arr[0]];
    for (let i = 1; i < arr.length; i++) out.push(arr[i] * k + out[i - 1] * (1 - k));
    return out;
  };
  const e12 = ema(close, 12), e26 = ema(close, 26);
  const ml = e12.map((v, i) => v - e26[i]), ms = ema(ml, 9);
  data.forEach((d, i) => {
    d.macd = ml[i]; d.macdSignal = ms[i]; d.macdHist = ml[i] - ms[i];
  });

  // 일목균형표
  const mid = (h, l) => (h + l) / 2;
  for (let i = 0; i < n; i++) {
    // 전환선 (9일)
    if (i >= 8) {
      let h = data[i].high, l = data[i].low;
      for (let j = i - 8; j < i; j++) { if (data[j].high > h) h = data[j].high; if (data[j].low < l) l = data[j].low; }
      data[i].ichiTenkan = mid(h, l);
    } else data[i].ichiTenkan = null;

    // 기준선 (26일)
    if (i >= 25) {
      let h = data[i].high, l = data[i].low;
      for (let j = i - 25; j < i; j++) { if (data[j].high > h) h = data[j].high; if (data[j].low < l) l = data[j].low; }
      data[i].ichiKijun = mid(h, l);
    } else data[i].ichiKijun = null;

    // 선행스팬 A (shift 26)
    data[i].ichiCloudA = (i >= 25 + 26 - 1) ? (() => {
      const t = data[i - 26].ichiTenkan, k = data[i - 26].ichiKijun;
      return (t != null && k != null) ? (t + k) / 2 : null;
    })() : null;

    // 선행스팬 B (52일 고저 중간, shift 26)
    if (i >= 52 + 26 - 1) {
      let h = data[i - 26].high, l = data[i - 26].low;
      for (let j = i - 26 - 51; j <= i - 26; j++) { if (data[j].high > h) h = data[j].high; if (data[j].low < l) l = data[j].low; }
      data[i].ichiCloudB = mid(h, l);
    } else data[i].ichiCloudB = null;
  }

  // ATR (14일)
  for (let i = 0; i < n; i++) {
    if (i < 1) { data[i].atr14 = null; continue; }
    const tr = Math.max(
      data[i].high - data[i].low,
      Math.abs(data[i].high - data[i - 1].close),
      Math.abs(data[i].low - data[i - 1].close)
    );
    data[i]._tr = tr;
    if (i < 14) { data[i].atr14 = null; continue; }
    if (i === 14) {
      let s = 0;
      for (let j = 1; j <= 14; j++) s += data[j]._tr;
      data[i].atr14 = s / 14;
    } else {
      data[i].atr14 = (data[i - 1].atr14 * 13 + tr) / 14;
    }
  }

  // 캔들 패턴
  data[0].isHammer = false;
  data[0].isBullishEngulfing = false;
  for (let i = 1; i < n; i++) {
    const d = data[i], p = data[i - 1];
    const body = d.close - d.open, ba = Math.abs(body);
    const upper = d.high - Math.max(d.open, d.close);
    const lower = Math.min(d.open, d.close) - d.low;
    d.isHammer = lower > 2 * ba && upper < ba * 0.5 && ba > 0;
    d.isBullishEngulfing = body > 0 && (p.close - p.open) < 0 && d.open <= p.close && d.close >= p.open;
  }

  return data;
}

// ═══════════════════════════════════════════════════════════════
// 벤포드 법칙 분석 (benford.py 포팅)
// ═══════════════════════════════════════════════════════════════
const BENFORD_EXPECTED = [0, 0.30103, 0.17609, 0.12494, 0.09691, 0.07918, 0.06695, 0.05799, 0.05115, 0.04576];

function firstDigit(n) {
  n = Math.abs(n);
  if (n === 0) return 0;
  while (n < 1) n *= 10;
  while (n >= 10) n /= 10;
  return Math.floor(n);
}

function benfordChi2(vals) {
  const digs = vals.filter(v => v !== 0).map(firstDigit).filter(d => d >= 1 && d <= 9);
  if (digs.length < 5) return 0;
  const obs = new Array(9).fill(0);
  digs.forEach(d => obs[d - 1]++);
  let c = 0;
  for (let d = 1; d <= 9; d++) {
    const e = BENFORD_EXPECTED[d] * digs.length;
    if (e > 0) c += (obs[d - 1] - e) ** 2 / e;
  }
  return c;
}

function benfordDeviationScore(vals) {
  const c = benfordChi2(vals);
  return { score: 1 - 1 / (1 + c / 15), chi2: c };
}

function analyzeVolumeBenford(volumes, window) {
  if (volumes.length < window) return 0;
  const recent = volumes.slice(-window);
  return benfordDeviationScore(recent).score;
}

function analyzePriceChangeBenford(prices, window) {
  if (prices.length < window + 1) return 0;
  const changes = [];
  const slice = prices.slice(-(window + 1));
  for (let i = 1; i < slice.length; i++) {
    const ch = Math.abs(slice[i] - slice[i - 1]);
    if (ch > 0) changes.push(ch);
  }
  if (changes.length < 5) return 0;
  return benfordDeviationScore(changes).score;
}

// ═══════════════════════════════════════════════════════════════
// 매수 점수 계산 V2 (signal_engine.py calculate_buy_score 정확 포팅)
// ═══════════════════════════════════════════════════════════════
function calcBuyScoreV2(data, idx, profileName, benfordInfluence, benfordWindow, benfordMinHits) {
  profileName = profileName || 'default';
  benfordInfluence = benfordInfluence != null ? benfordInfluence : 0.15;
  benfordWindow = benfordWindow || 30;
  benfordMinHits = benfordMinHits || 5;

  if (idx < 60) return { score: 0, details: {} };

  const p = STOCK_PROFILES[profileName] || STOCK_PROFILES.default;
  const row = data[idx];
  const prev = data[idx - 1];
  const details = {};

  const ma5 = row.ma5, ma20 = row.ma20, ma60 = row.ma60;

  // ════════════════════════════════════════════════════
  // 필수 조건 5가지 (하나라도 실패하면 score=0)
  // ════════════════════════════════════════════════════

  // 1. 정배열 (MA5 > MA20 > MA60 — 3개 모두 필수, Python과 동일)
  if (ma5 == null || ma20 == null || ma60 == null) return { score: 0, details: {} };
  if (!(ma5 > ma20 && ma20 > ma60)) return { score: 0, details: {} };

  // 2. 20일 고점 근접 (프로필별 범위)
  let high20d = 0;
  for (let j = Math.max(0, idx - 20); j <= idx; j++) {
    if (data[j].high > high20d) high20d = data[j].high;
  }
  if (high20d <= 0) return { score: 0, details: {} };
  const distFromHigh = (high20d - row.close) / high20d;
  if (distFromHigh > p.high_dist_max) return { score: 0, details: {} };

  // 3. MA20 상승 기울기 (10일 전 대비)
  if (idx < 10) return { score: 0, details: {} };
  const ma20_10ago = data[idx - 10].ma20;
  if (ma20_10ago == null || ma20_10ago <= 0) return { score: 0, details: {} };
  const ma20Slope = (ma20 - ma20_10ago) / ma20_10ago;
  if (ma20Slope < p.ma20_slope_min) return { score: 0, details: {} };

  // 4. 양봉
  if (row.close <= row.open) return { score: 0, details: {} };

  // 5. 거래량 과열 차단
  if (row.volRatio != null && row.volRatio > p.vol_overheat) return { score: 0, details: {} };

  // ════════════════════════════════════════════════════
  // 스코어링 시작 (기본 5.0점)
  // ════════════════════════════════════════════════════
  let score = 5.0;
  details.core = `정배열,고점${(distFromHigh * 100).toFixed(1)}%,MA20↑${(ma20Slope * 100).toFixed(1)}%`;

  // 1. RSI 모멘텀 (검증: RSI≥70 → 승률 40.7%, RSI<50 → 18.4%)
  const rsi = row.rsi;
  if (rsi != null) {
    if (rsi >= 80)      { score += 2.5; details.rsi = `극강모멘텀(${rsi.toFixed(0)})`; }
    else if (rsi >= 70) { score += 2.0; details.rsi = `강모멘텀(${rsi.toFixed(0)})`; }
    else if (rsi >= 60) { score += 1.0; details.rsi = `모멘텀(${rsi.toFixed(0)})`; }
    else if (rsi >= 50) { score += 0.5; details.rsi = `중립모멘텀(${rsi.toFixed(0)})`; }
    else if (rsi >= 40) { details.rsi = `중립(${rsi.toFixed(0)})`; }
    else                { score -= 1.0; details.rsi = `약세(${rsi.toFixed(0)})`; }
  }

  // 2. MACD 상태 (검증: 히스토그램 음의 상관 → 캡 1.0으로 축소)
  let _macdScore = 0;
  if (row.macdHist != null && row.macdHist > 0) {
    _macdScore += 1.0;
    if (prev.macdHist != null && row.macdHist > prev.macdHist) {
      _macdScore += 0.5;
      details.macd = 'MACD가속';
    } else {
      details.macd = 'MACD양전';
    }
  }
  if (row.macd != null && row.macdSignal != null &&
      prev.macd != null && prev.macdSignal != null) {
    if (row.macd > row.macdSignal && prev.macd <= prev.macdSignal) {
      _macdScore += 1.5;
      details.macd = 'MACD골든크로스';
    }
  }
  score += Math.min(_macdScore, 1.0);

  // 3. 20일 수익률 (검증: 미미한 기여도 → 축소)
  if (idx >= 20) {
    const price20ago = data[idx - 20].close;
    if (price20ago > 0) {
      const ret20d = (row.close - price20ago) / price20ago;
      if (ret20d > p.ret20d_strong) {
        score += 0.5; details.ret20d = `+${(ret20d * 100).toFixed(0)}%`;
      } else if (ret20d > p.ret20d_mid) {
        score += 0.3; details.ret20d = `+${(ret20d * 100).toFixed(0)}%`;
      } else if (ret20d > p.ret20d_weak) {
        score += 0.2;
      }
    }
  }

  // 4. 거래량 품질 (검증: 높은 거래량 = 승률↓, 대폭 축소)
  if (row.volRatio != null) {
    if (profileName === 'force_following') {
      if (row.volRatio >= 3.0 && row.volRatio <= 7.0) {
        score += 0.5; details.volume = `세력거래량(x${row.volRatio.toFixed(1)})`;
      } else if (row.volRatio >= 1.5 && row.volRatio < 3.0) {
        score += 0.3; details.volume = `증가거래량(x${row.volRatio.toFixed(1)})`;
      } else if (row.volRatio > 7.0 && row.volRatio <= p.vol_overheat) {
        score -= 0.5; details.volume = `폭발거래량(x${row.volRatio.toFixed(1)})`;
      }
    } else {
      if (row.volRatio >= 1.3 && row.volRatio <= 3.0) {
        score += 0.3; details.volume = `건전거래량(x${row.volRatio.toFixed(1)})`;
      } else if (row.volRatio > 3.0 && row.volRatio <= 5.0) {
        score += 0.0; details.volume = `높은거래량(x${row.volRatio.toFixed(1)})`;
      } else if (row.volRatio > 5.0 && row.volRatio <= p.vol_overheat) {
        score -= 1.0; details.volume = `과열주의(x${row.volRatio.toFixed(1)})`;
      }
    }
  }

  // 5. 캔들 패턴
  if (row.isBullishEngulfing) { score += 1.0; details.candle = '상승장악형'; }

  // 6. 연속 상승일
  let consec = 0;
  for (let lb = 1; lb < Math.min(8, idx + 1); lb++) {
    if (data[idx - lb + 1].close > data[idx - lb].close) consec++;
    else break;
  }
  if (consec >= 2 && consec <= 5) { score += 0.5; details.streak = `${consec}일연속↑`; }
  else if (consec > 5) { score -= 0.5; }

  // 7. 볼린저밴드 (검증: 변별력 없음 → 삭제)

  // 8. 20일 신고가
  if (row.close >= high20d * 0.99) {
    score += 0.5; details.breakout = '20일신고가';
  }

  // 9. MA60 기울기 (장기 추세)
  if (idx >= 20) {
    const ma60_20ago = data[idx - 20].ma60;
    if (ma60_20ago != null && ma60_20ago > 0) {
      const ma60Slope = (ma60 - ma60_20ago) / ma60_20ago;
      if (ma60Slope > 0.02) {
        score += 1.5; details.long_trend = `MA60도상승(+${(ma60Slope * 100).toFixed(1)}%)`;
      }
    }
  }

  // 10. MA200 장기 우상향 필터
  const ma200 = row.ma200;
  if (ma200 != null && ma200 > 0) {
    if (row.close > ma200) {
      score += 1.5; details.ma200 = `MA200위(+${((row.close / ma200 - 1) * 100).toFixed(1)}%)`;
    } else {
      score -= 1.5; details.ma200 = `MA200아래(${((row.close / ma200 - 1) * 100).toFixed(1)}%)`;
    }
  }

  // 11. 일목균형표 (검증: 구름위 = 회귀 기여도 1위 → 대폭 상향)
  const tenkan = row.ichiTenkan, kijun = row.ichiKijun;
  const cloudA = row.ichiCloudA, cloudB = row.ichiCloudB;
  if (tenkan != null && kijun != null && cloudA != null && cloudB != null) {
    const cloudTop = Math.max(cloudA, cloudB);
    const cloudBot = Math.min(cloudA, cloudB);
    if (row.close > cloudTop) { score += 2.0; details.ichimoku = '구름위'; }
    else if (row.close < cloudBot) { score -= 0.5; details.ichimoku = '구름아래'; }
    if (tenkan > kijun) {
      score += 0.5;
      details.ichimoku = (details.ichimoku || '') + '+전환>기준';
    }
    if (cloudA > cloudB) {
      score += 0.3;
      details.ichimoku = (details.ichimoku || '') + '+상승구름';
    }
  }

  // 12. 벤포드 법칙 (세력 이상 감지)
  const bw = Math.min(p.benford_weight, benfordInfluence);
  let benfordMult = 1.0;

  if (profileName === 'force_following') {
    // 세력 추종형: 단기(15일) + 장기(60일) 이중 윈도우
    const shortW = Math.min(15, benfordWindow);
    const longW = Math.min(60, idx + 1);
    const volumes = data.slice(Math.max(0, idx - longW), idx + 1).map(d => d.volume);
    const prices = data.slice(Math.max(0, idx - longW), idx + 1).map(d => d.close);
    const volShort = analyzeVolumeBenford(volumes.slice(-shortW), Math.max(shortW, benfordMinHits));
    const volLong = analyzeVolumeBenford(volumes, Math.max(longW, benfordMinHits));
    const pcShort = analyzePriceChangeBenford(prices.slice(-shortW - 1), Math.max(shortW, benfordMinHits));
    const combined = (volShort * 2 + volLong + pcShort) / 4;
    benfordMult = 1.0 + Math.min(combined * bw * 2, bw * 2);
  } else {
    const effWindow = Math.max(benfordWindow, benfordMinHits);
    const volumes = data.slice(Math.max(0, idx - effWindow), idx + 1).map(d => d.volume);
    const prices = data.slice(Math.max(0, idx - effWindow), idx + 1).map(d => d.close);
    const volScore = analyzeVolumeBenford(volumes, effWindow);
    const pcScore = analyzePriceChangeBenford(prices, effWindow);
    benfordMult = 1.0 + Math.min((volScore + pcScore) * 0.1, benfordInfluence);
  }

  if (benfordMult > 1.03) {
    details.benford = `벤포드(x${benfordMult.toFixed(2)})`;
  }

  const finalScore = score * benfordMult;
  return { score: finalScore, details };
}

// ═══════════════════════════════════════════════════════════════
// 동적 가격 계산 (backtester.py _calc_dynamic_prices 정확 포팅)
// ═══════════════════════════════════════════════════════════════
function calcDynamicPrices(data, signalIdx, takeProfit, stopLoss) {
  const row = data[signalIdx];
  const close = row.close;

  // ── 진입가: 기준선 → MA20 → 종가 우선순위 ──
  const kijun = row.ichiKijun;
  const ma20 = row.ma20;
  let pendingLimit;

  if (kijun && kijun > 0 && kijun < close && (close - kijun) / close <= 0.10) {
    pendingLimit = kijun;   // 기준선 10% 이내 → 기준선에서 매수
  } else if (ma20 && ma20 > 0 && ma20 < close && (close - ma20) / close <= 0.04) {
    pendingLimit = ma20;    // MA20 4% 이내 → MA20에서 매수
  } else {
    pendingLimit = close;   // 기본: 현재 종가
  }

  // ── 목표가: 120일 전고점 → 52일 전고점 → BB상단 → 고정% ──
  let tpLevel = null;

  // 1순위: 120일 전고점 (5~40% 범위)
  if (signalIdx > 0) {
    let swingHigh120 = 0;
    const start120 = Math.max(0, signalIdx - 120);
    for (let j = start120; j < signalIdx; j++) {
      if (data[j].high > swingHigh120) swingHigh120 = data[j].high;
    }
    if (swingHigh120 > 0 && close * 1.05 <= swingHigh120 && swingHigh120 <= close * 1.40) {
      tpLevel = swingHigh120;
    }
  }

  // 2순위: 52일 전고점
  if (tpLevel == null && signalIdx > 0) {
    let swingHigh52 = 0;
    const start52 = Math.max(0, signalIdx - 52);
    for (let j = start52; j < signalIdx; j++) {
      if (data[j].high > swingHigh52) swingHigh52 = data[j].high;
    }
    if (swingHigh52 > 0 && close * 1.05 <= swingHigh52 && swingHigh52 <= close * 1.40) {
      tpLevel = swingHigh52;
    }
  }

  // 3순위: BB 상단 (3% 이상)
  if (tpLevel == null) {
    const bbUpper = row.bbUpper;
    if (bbUpper && bbUpper > close * 1.03) {
      tpLevel = bbUpper;
    }
  }

  // 4순위: ATR 기반 (종목별 변동성 반영, 고정% 대신 개별 목표)
  if (tpLevel == null && row.atr14 && row.atr14 > 0) {
    const atrTp = close + row.atr14 * 3;
    // 최소 5%, 최대 40% 범위 내에서만 적용
    if (atrTp >= close * 1.05 && atrTp <= close * 1.40) {
      tpLevel = atrTp;
    }
  }

  // 손절 기준용 기준선
  const kijunForSL = kijun;
  // ATR 기반 손절가 (종목별 변동성 반영)
  const atrForSL = (row.atr14 && row.atr14 > 0) ? row.atr14 : null;

  return { pendingLimit, tpLevel, kijunForSL, atrForSL };
}

// ── 체결 시 손절가 계산 (backtester.py 라인 128-138) ──
function calcStopPrice(fillPrice, fillKijun, stopLossPct, atrForSL) {
  const candidates = [];
  // 기준선 기반
  if (fillKijun && fillKijun > 0) {
    const kijunStop = fillKijun * (1 - 0.03);   // 기준선 3% 아래
    if (kijunStop < fillPrice) candidates.push(kijunStop);
  }
  // ATR 기반 (종목별 변동성)
  if (atrForSL && atrForSL > 0) {
    const atrStop = fillPrice - atrForSL * 2;
    if (atrStop > 0 && atrStop < fillPrice) candidates.push(atrStop);
  }
  // 고정%
  const fixedStop = fillPrice * (1 - stopLossPct);
  candidates.push(fixedStop);
  // 가장 빡빡한(높은) 손절가 선택
  return Math.max(...candidates);
}

// ── 체결 시 목표가 계산 ──
function calcTargetPrice(fillPrice, tpLevel, takeProfitPct) {
  if (tpLevel && tpLevel > fillPrice * 1.03) {
    return tpLevel;
  }
  return fillPrice * (1 + takeProfitPct);
}

// ═══════════════════════════════════════════════════════════════
// 레짐 필터 (regime_filter.py 정확 포팅)
// ═══════════════════════════════════════════════════════════════
class RegimeFilter {
  constructor() {
    this.kospiData = null;
    this.kospiByDate = {};
    this.loaded = false;
  }

  async load() {
    try {
      const resp = await fetch('/api/kis-index-ohlcv?code=0001&days=600');
      const json = await resp.json();
      if (!json.ok || !json.data || json.data.length < 60) {
        this.loaded = false;
        return false;
      }
      this.kospiData = calcIndicatorsV2(json.data);
      this.kospiByDate = {};
      this.kospiData.forEach((d, i) => { this.kospiByDate[d.date] = i; });
      this.loaded = true;
      return true;
    } catch (e) {
      this.loaded = false;
      return false;
    }
  }

  detectRegime(dateStr) {
    if (!this.kospiData || !this.loaded) return 0;  // 데이터 없으면 강세 가정
    const idx = this.kospiByDate[dateStr];
    if (idx == null) return 1;  // 날짜 없으면 횡보

    const d = this.kospiData;
    const row = d[idx];
    const ma20 = row.ma20, ma60 = row.ma60, close = row.close;
    if (ma20 == null || ma60 == null) return 1;

    let bad = 0;

    // ① MA 배열
    if (ma20 < ma60) bad += 2;
    else if ((ma20 - ma60) / ma60 < 0.02) bad += 1;

    // ② MA60 기울기 (20일 전 대비)
    if (idx >= 20) {
      const m60_20 = d[idx - 20].ma60;
      if (m60_20 != null && m60_20 > 0) {
        const slope = (ma60 - m60_20) / m60_20;
        if (slope < -0.02) bad += 2;
        else if (slope < 0) bad += 1;
      }
    }

    // ③ 60일 수익률
    if (idx >= 60) {
      const c60 = d[idx - 60].close;
      if (c60 > 0) {
        const r60 = (close - c60) / c60;
        if (r60 < -0.10) bad += 2;
        else if (r60 < -0.04) bad += 1;
      }
    }

    // ④ 52주 고점 대비 낙폭
    let hi52 = 0;
    for (let j = Math.max(0, idx - 250); j <= idx; j++) {
      if (d[j].high > hi52) hi52 = d[j].high;
    }
    if (hi52 > 0) {
      const drawdown = (close - hi52) / hi52;
      if (drawdown < -0.20) bad += 2;
      else if (drawdown < -0.10) bad += 1;
    }

    // ⑤ 20일 단기 급락
    if (idx >= 20) {
      const c20 = d[idx - 20].close;
      if (c20 > 0) {
        const r20 = (close - c20) / c20;
        if (r20 < -0.05) bad += 1;
      }
    }

    if (bad >= 4) return 2;  // 약세
    if (bad >= 2) return 1;  // 횡보
    return 0;                // 강세
  }

  isBearMarket(dateStr) {
    return this.detectRegime(dateStr) === 2;
  }

  getLabel(dateStr) {
    const code = this.detectRegime(dateStr);
    return ['강세', '횡보', '약세'][code];
  }

  getLatestRegime() {
    if (!this.kospiData || !this.kospiData.length) return { regime: 0, label: '강세', date: null };
    const last = this.kospiData[this.kospiData.length - 1];
    const regime = this.detectRegime(last.date);
    return { regime, label: ['강세', '횡보', '약세'][regime], date: last.date };
  }
}

// ═══════════════════════════════════════════════════════════════
// 서킷 브레이커
// ═══════════════════════════════════════════════════════════════
class CircuitBreaker {
  constructor(trades) {
    this.consecLosses = 0;
    if (trades && trades.length) {
      for (let i = trades.length - 1; i >= 0; i--) {
        if (trades[i].exitReason === 'STOP') this.consecLosses++;
        else break;
      }
    }
  }

  recordResult(isWin) {
    if (isWin) this.consecLosses = 0;
    else this.consecLosses++;
  }

  getEffectiveCooldown(baseCooldown) {
    return this.consecLosses >= CIRCUIT_BREAKER_LOSSES
      ? baseCooldown + CIRCUIT_BREAKER_EXTRA
      : baseCooldown;
  }

  isTriggered() {
    return this.consecLosses >= CIRCUIT_BREAKER_LOSSES;
  }
}

// ═══════════════════════════════════════════════════════════════
// 종목 프로필 자동 분류
// ═══════════════════════════════════════════════════════════════
function classifyProfile(code, stockList) {
  if (!stockList || !stockList.length) return 'default';
  const idx = stockList.findIndex(s => s.code === code);
  if (idx >= 0 && idx < 30) return 'large_cap';
  return 'default';
}

// ═══════════════════════════════════════════════════════════════
// 진입 사유 생성
// ═══════════════════════════════════════════════════════════════
function getEntryReason(pendingLimit, row) {
  const close = row.close;
  const kijun = row.ichiKijun;
  const ma20 = row.ma20;
  if (kijun && kijun > 0 && Math.abs(pendingLimit - kijun) < 1) {
    const pct = ((kijun / close - 1) * 100).toFixed(1);
    return `기준선매수 ${pct}%`;
  }
  if (ma20 && ma20 > 0 && Math.abs(pendingLimit - ma20) < 1) {
    const pct = ((ma20 / close - 1) * 100).toFixed(1);
    return `MA20매수 ${pct}%`;
  }
  return '종가매수';
}

// ═══════════════════════════════════════════════════════════════
// TP/SL 근거 텍스트 생성
// ═══════════════════════════════════════════════════════════════
function getTpReason(tpLevel, fillPrice, takeProfitPct, data, signalIdx) {
  if (!tpLevel || tpLevel <= fillPrice * 1.03) {
    return `고정 +${(takeProfitPct * 100).toFixed(0)}%`;
  }
  const pct = ((tpLevel / fillPrice - 1) * 100).toFixed(1);
  // 120일 vs 52일 vs BB vs ATR 판별
  let swingHigh120 = 0;
  for (let j = Math.max(0, signalIdx - 120); j < signalIdx; j++) {
    if (data[j].high > swingHigh120) swingHigh120 = data[j].high;
  }
  if (Math.abs(tpLevel - swingHigh120) < 10) return `120일전고 +${pct}%`;

  let swingHigh52 = 0;
  for (let j = Math.max(0, signalIdx - 52); j < signalIdx; j++) {
    if (data[j].high > swingHigh52) swingHigh52 = data[j].high;
  }
  if (Math.abs(tpLevel - swingHigh52) < 10) return `52일전고 +${pct}%`;

  const bbUpper = data[signalIdx]?.bbUpper;
  if (bbUpper && Math.abs(tpLevel - bbUpper) < 10) return `BB상단 +${pct}%`;

  return `ATR×3 +${pct}%`;
}

function getSlReason(stopPrice, fillPrice, fillKijun, stopLossPct, atrForSL) {
  const pct = ((stopPrice / fillPrice - 1) * 100).toFixed(1);
  if (fillKijun && fillKijun > 0) {
    const kijunStop = fillKijun * 0.97;
    if (kijunStop < fillPrice && Math.abs(stopPrice - kijunStop) < 10) {
      return `기준선-3% ${pct}%`;
    }
  }
  if (atrForSL && atrForSL > 0) {
    const atrStop = fillPrice - atrForSL * 2;
    if (atrStop > 0 && Math.abs(stopPrice - atrStop) < 10) {
      return `ATR×2 ${pct}%`;
    }
  }
  return `고정 -${(stopLossPct * 100).toFixed(0)}%`;
}

// ═══════════════════════════════════════════════════════════════
// Top 30 종합 점수 — 세력추종 로직 적합도 평가
// ═══════════════════════════════════════════════════════════════
function calcCompositeRankScore(data, idx, profileName, params) {
  if (!data || idx < 60) return null;
  const d = data[idx];
  const reasons = [];
  let composite = 0;

  // ── 1. 매수 시그널 강도 (40점 만점) ────────────────────────
  const { score: buyScore, details } = calcBuyScoreV2(data, idx, profileName,
    params?.benfordInfluence || 0.15, params?.benfordWindow || 30, params?.benfordMinHits || 3);
  const signalPts = Math.min(40, (buyScore / 15) * 40); // 15점 만점 → 40점 스케일
  composite += signalPts;
  if (buyScore >= 8) reasons.push(`시그널 ${buyScore.toFixed(1)}점`);

  // ── 2. RSI 모멘텀 (10점 만점 — buyScore에 이미 RSI 반영, 이중가산 축소) ──
  const rsi = d.rsi || 0;
  let rsiPts = 0;
  if (rsi >= 80) rsiPts = 10;
  else if (rsi >= 70) rsiPts = 7;
  else if (rsi >= 60) rsiPts = 4;
  else rsiPts = 0;
  composite += rsiPts;
  if (rsi >= 70) reasons.push(`RSI ${rsi.toFixed(0)}`);

  // ── 3. 추세 건전성 (15점 만점) ─────────────────────────────
  let trendPts = 0;
  const ma5 = d.ma5 || 0, ma20 = d.ma20 || 0, ma60 = d.ma60 || 0;
  const close = d.close;
  // MA 정배열: close > MA5 > MA20 > MA60
  if (close > ma5 && ma5 > ma20 && ma20 > ma60) { trendPts += 8; reasons.push('MA정배열'); }
  else if (close > ma20 && ma20 > ma60) { trendPts += 4; }
  // 구름 위
  const cloudA = d.ichiCloudA || 0, cloudB = d.ichiCloudB || 0;
  const cloudTop = Math.max(cloudA, cloudB);
  if (close > cloudTop && cloudTop > 0) { trendPts += 4; reasons.push('구름위'); }
  // 기준선 위
  const kijun = d.ichiKijun || 0;
  if (kijun > 0 && close > kijun) trendPts += 3;
  composite += Math.min(15, trendPts);

  // ── 4. 세력 감지 — 벤포드 (15점 만점) ─────────────────────
  let benfordPts = 0;
  const bw = params?.benfordWindow || 30;
  if (idx >= bw) {
    const prices = [], vols = [];
    for (let i = idx - bw + 1; i <= idx; i++) {
      prices.push(data[i].close);
      vols.push(data[i].volume);
    }
    const pScore = benfordDeviationScore(prices).score;
    const vScore = benfordDeviationScore(vols).score;
    const anomCount = (pScore > 2 ? 1 : 0) + (vScore > 2 ? 1 : 0);
    if (anomCount >= 2) { benfordPts = 15; reasons.push(`세력감지(벤포드 ${Math.max(pScore,vScore).toFixed(1)})`); }
    else if (anomCount === 1) { benfordPts = 8; reasons.push('벤포드 이상 감지'); }
    // 거래량 급증
    let avgVol = 0;
    for (let i = idx - 20; i < idx; i++) avgVol += data[i].volume;
    avgVol /= 20;
    if (d.volume > avgVol * 2.5) { benfordPts += 5; reasons.push(`거래량 급증 ${(d.volume/avgVol).toFixed(1)}x`); }
  }
  composite += Math.min(15, benfordPts);

  // ── 5. 변동성 적합도 (10점 만점) ───────────────────────────
  // ATR% 기반 — 적절한 변동성이 있어야 세력추종이 먹힘
  let volPts = 0;
  if (d.atr14) {
    const atrPct = (d.atr14 / close) * 100;
    if (atrPct >= 2 && atrPct <= 6) { volPts = 10; reasons.push(`ATR ${atrPct.toFixed(1)}%`); }
    else if (atrPct >= 1.5 && atrPct < 2) volPts = 6;
    else if (atrPct > 6 && atrPct <= 10) volPts = 5;
    else volPts = 2;
  }
  composite += volPts;

  // ── 투자 적합성 판정 ───────────────────────────────────────
  // RSI >= 70 + 시그널 >= threshold → 투자 진행
  // 그 외 → 미진행 (관망)
  const threshold = params?.threshold || 4.5;
  const investable = rsi >= 70 && buyScore >= threshold;

  return {
    composite: Math.round(composite * 10) / 10,
    investable,
    buyScore: Math.round(buyScore * 10) / 10,
    rsi: Math.round(rsi * 10) / 10,
    trendPts: Math.min(15, trendPts),
    benfordPts: Math.min(15, benfordPts),
    volPts,
    reason: reasons.join(' | '),
    details,
  };
}

// ============================================================
// 매집 감지 (Accumulation Detection) — SDE 패턴 중심
// ============================================================
// 검증 결과 (194개 종목, 1,360건):
//   SDE 패턴: 승률 57.9%, EV +3.01% (모멘텀 EV +0.75% 대비 4배)
//   최적: TP=15%, SL=13%, MaxHold=20일
// ============================================================

const ACCUM_PROFILES = {
  default: {
    rsi_range: [20, 85],         // SDE 폭발일은 RSI 급등 가능 → 넓은 범위
    max_price_change_5d: 0.15,   // SDE 폭발일 자체가 +5%+ → 완화 필요
    vpd_threshold: 3.0,          // VPD 시그널 기준
    vpd_strong: 5.0,             // VPD 강한 시그널
    take_profit: 0.10,           // 그리드서치 최적: 58%WR, 50%TP율
    stop_loss: 0.13,             // 검증 최적 SL
    max_hold: 30,                // 그리드서치 최적: TO 23%
    cooldown: 10,                // 쿨다운
  },
};

/**
 * VPD (Volume-Price Divergence) — 거래량-가격 괴리 지표
 * VPD = volRatio / |일간등락률%|
 * 높을수록 '거래량은 많은데 가격이 안 움직임' = 조용한 매집 의심
 * 카카오페이 검증: VPD=6.2 → 17일 후 +30%
 *
 * requires calcIndicatorsV2() to have run first (needs volRatio)
 */
function calcVPD(data) {
  for (let i = 0; i < data.length; i++) {
    if (i < 1 || data[i].volRatio == null) {
      data[i].vpd = null;
      continue;
    }
    const pctChange = Math.max(
      Math.abs((data[i].close - data[i - 1].close) / data[i - 1].close) * 100,
      0.1  // floor 0.1% to avoid division by zero
    );
    const vr = data[i].volRatio;
    if (vr < 0.5) {
      data[i].vpd = 0;  // 저볼륨 제외 (의미 없음)
      continue;
    }
    data[i].vpd = Math.min(vr / pctChange, 20.0);  // cap at 20
  }
  return data;
}

/**
 * 세력 매집 3단계 패턴 감지 (Shakeout-Dryup-Explosion)
 * Phase 1 (세이크아웃): 급락 -4% 이상 + 거래량 1.5배 이상
 * Phase 2 (건조/매집): 이후 평균 거래량 < 1.0배 (공급 소화)
 * Phase 3 (폭발): +5% 이상 + 거래량 2배 이상
 *
 * sdeSignal: 0 = 신호 없음, 3 = 풀 패턴 확인 (진입 시그널)
 */
/**
 * SDE(Shakeout-Dryup-Explosion) 패턴 탐지
 *
 * 시그널 값:
 *   0 = 패턴 없음
 *   2 = 급락→건조기 진행 중 (매수 타이밍!)
 *   3 = 급락→건조→폭발 완료 (너무 늦음, 추격매수 금지)
 *
 * 라이브 스캔에서는 signal=2만 매수 대상.
 * signal=3은 이미 폭발한 종목 → 매수 불가.
 */
function detectSDE(data) {
  const n = data.length;
  for (let i = 0; i < n; i++) {
    data[i].sdeSignal = 0;
    data[i].sdeShakeoutDays = 0;
  }
  for (let i = 30; i < n; i++) {
    const row = data[i];
    const prev = data[i - 1];
    if (prev.close <= 0) continue;

    const dailyReturn = (row.close - prev.close) / prev.close;
    const volRatioVal = row.volRatio != null ? row.volRatio : 1.0;
    const isExplosion = (dailyReturn >= 0.05 && volRatioVal >= 2.0);

    // 과거 5-30일 내 세이크아웃 탐색
    for (let sOffset = 5; sOffset <= 30; sOffset++) {
      const sIdx = i - sOffset;
      if (sIdx < 1) break;
      const sRow = data[sIdx];
      const sPrev = data[sIdx - 1];
      if (sPrev.close <= 0) continue;

      const sReturn = (sRow.close - sPrev.close) / sPrev.close;
      const sVol = sRow.volRatio != null ? sRow.volRatio : 1.0;

      // Phase 1: 세이크아웃 확인 (-4% 이상 하락, 거래량 1.5배+)
      if (sReturn <= -0.04 && sVol >= 1.5) {
        // Phase 2: 세이크아웃~오늘 사이 건조도 확인 (오늘 제외)
        const dryupStart = sIdx + 1;
        const dryupEnd = i;  // 오늘 제외
        if (dryupEnd - dryupStart < 3) continue;  // 최소 3일 건조기

        let dryupSum = 0, dryupCnt = 0;
        for (let d = dryupStart; d < dryupEnd; d++) {
          const dv = data[d].volRatio;
          if (dv != null) { dryupSum += dv; dryupCnt++; }
        }
        if (dryupCnt > 0 && (dryupSum / dryupCnt) < 1.0) {
          if (isExplosion) {
            // 오늘 폭발 → signal=3 (이미 터짐, 매수 금지)
            data[i].sdeSignal = 3;
          } else {
            // 건조기 진행 중 → signal=2 (매수 타이밍!)
            data[i].sdeSignal = 2;
          }
          data[i].sdeShakeoutDays = sOffset;
          break;
        }
      }
    }
  }
  return data;
}

/**
 * 멀티윈도우 벤포드 분석 — 매집 감지용
 * 여러 윈도우(5,7,10,15,30일)에서 동시에 chi² 계산.
 * 장기(30d) + 단기(5-10d) 동시 이탈 = 매집 강력 신호.
 *
 * @returns {{ results: Object, alertLevel: number }}
 *   alertLevel: 0(없음), 1(장기만), 2(장기+단기=강한 매집)
 */
function multiWindowBenford(volumes, windows) {
  if (!windows) windows = [5, 7, 10, 15, 30];
  const results = {};
  for (const w of windows) {
    if (volumes.length < w || volumes.length < 5) {
      results[w] = 0;
      continue;
    }
    const recent = volumes.slice(-w).filter(v => v > 0);
    if (recent.length < 5) {
      results[w] = 0;
      continue;
    }
    results[w] = benfordChi2(recent);
  }
  const longAlert = (results[30] || 0) > 20;
  const shortAlert = [5, 7, 10].some(w => (results[w] || 0) > 15);
  let alertLevel = 0;
  if (longAlert && shortAlert) alertLevel = 2;
  else if (longAlert) alertLevel = 1;
  return { results, alertLevel };
}

/**
 * 매집 감지 시그널 스코어링 — SDE 패턴 중심
 *
 * 모멘텀(calcBuyScoreV2)과의 차이:
 *   - RSI 20-85 (모멘텀은 70+)
 *   - 정배열 불필요 (매집은 추세 형성 전)
 *   - SDE 패턴이 핵심 게이트 (5점, 최대 기여)
 *   - VPD/벤포드는 보조 확인 시그널
 *
 * 스코어링 (총 16점 만점):
 *   SDE 패턴:       0~5점 (풀 패턴 = 5점)
 *   VPD:            0~4점 (≥5.0 = 4점, ≥3.0 = 2.5점)
 *   벤포드 멀티윈도우: 0~3점 (alert=2 = 3점)
 *   거래량 압축:     0~2점 (10일간 vol 감소)
 *   가격 기반 형성:  0~2점 (20일 레인지 < 8%)
 *
 * @returns {{ score: number, details: Object }}
 */
function calcAccumulationScore(data, idx, profileName) {
  if (idx < 60) return { score: 0, details: {} };

  const p = ACCUM_PROFILES[profileName] || ACCUM_PROFILES.default;
  const row = data[idx];
  const details = {};

  // ── 필수 게이트 1: RSI 매집 구간 ──
  const rsi = row.rsi;
  if (rsi != null) {
    if (rsi < p.rsi_range[0] || rsi > p.rsi_range[1]) {
      return { score: 0, details: {} };
    }
  }

  // ── 필수 게이트 2: 최근 5일 급변동 없음 ──
  if (idx >= 5) {
    const close5ago = data[idx - 5].close;
    if (close5ago > 0) {
      const ret5d = Math.abs((row.close - close5ago) / close5ago);
      if (ret5d > p.max_price_change_5d) {
        return { score: 0, details: {} };
      }
    }
  }

  // ── 필수 게이트 3: SDE 패턴 ──
  // signal=2: 건조기 진행 중 (매수 타이밍)
  // signal=3: 이미 폭발 완료 (추격매수 금지)
  const sde = row.sdeSignal || 0;
  if (sde === 3) return { score: 0, details: { sde: '이미 폭발 (매수 불가)' } };
  if (sde !== 2) return { score: 0, details: {} };

  // ── 필수 게이트 4: 건조기 품질 — 5일 레인지 & 저점 회복률 ──
  // 데이터 검증 결과: 5일 레인지 <5% = EV 0%, 저점 회복 <3% = EV 0.85%
  const shakeoutDays = row.sdeShakeoutDays || 0;
  if (idx >= 5) {
    let hi5 = 0, lo5 = Infinity;
    for (let j = idx - 4; j <= idx; j++) {
      if (data[j].high > hi5) hi5 = data[j].high;
      if (data[j].low < lo5) lo5 = data[j].low;
    }
    const range5d = hi5 > 0 ? (hi5 - lo5) / ((hi5 + lo5) / 2) : 0;
    if (range5d < 0.05) {
      return { score: 0, details: { sde: `건조기 비활성 (5일레인지 ${(range5d*100).toFixed(1)}% < 5%)` } };
    }
  }
  // 세이크아웃 저점 대비 회복률
  const shakeIdx = idx - shakeoutDays;
  if (shakeIdx >= 0 && shakeIdx < data.length) {
    let shakeLow = Infinity;
    for (let j = shakeIdx; j <= Math.min(shakeIdx + 3, idx); j++) {
      if (data[j] && data[j].low < shakeLow) shakeLow = data[j].low;
    }
    const recovery = shakeLow > 0 ? (row.close - shakeLow) / shakeLow : 0;
    if (recovery < 0.03) {
      return { score: 0, details: { sde: `저점 미회복 (회복률 ${(recovery*100).toFixed(1)}% < 3%)` } };
    }
  }

  // ── 스코어링 (건조기 품질 확인됨 — 폭발 대기 중) ──
  let score = 5.0;
  details.sde = `SDE ${shakeoutDays}일전급락→건조중 +5`;

  // 2. VPD (0~4점) — 보조 확인
  const vpdVal = row.vpd || 0;
  if (vpdVal >= p.vpd_strong) {
    score += 4.0;
    details.vpd = `VPD ${vpdVal.toFixed(1)} 강한괴리 +4`;
  } else if (vpdVal >= p.vpd_threshold) {
    score += 2.5;
    details.vpd = `VPD ${vpdVal.toFixed(1)} 괴리감지 +2.5`;
  } else if (vpdVal >= 2.0) {
    score += 1.0;
    details.vpd = `VPD ${vpdVal.toFixed(1)} 약괴리 +1`;
  } else {
    details.vpd = `VPD ${vpdVal.toFixed(1)} 정상`;
  }

  // 3. 벤포드 멀티윈도우 (0~3점)
  const vols = [];
  for (let j = Math.max(0, idx - 30); j <= idx; j++) vols.push(data[j].volume);
  const { alertLevel } = multiWindowBenford(vols);
  if (alertLevel === 2) {
    score += 3.0;
    details.benford = '벤포드 강이탈 +3';
  } else if (alertLevel === 1) {
    score += 1.5;
    details.benford = '벤포드 이탈 +1.5';
  } else {
    details.benford = '벤포드 정상';
  }

  // 4. 거래량 압축 (0~2점) — 공급 소화 확인
  if (idx >= 10) {
    const volAvg = row.volAvg;
    if (volAvg != null && volAvg > 0) {
      let recentVolSum = 0;
      for (let j = idx - 9; j <= idx; j++) recentVolSum += data[j].volume;
      const volRatio10d = (recentVolSum / 10) / volAvg;
      if (volRatio10d < 0.6) {
        score += 2.0;
        details.vol_compress = `거래량 x${volRatio10d.toFixed(2)} 건조 +2`;
      } else if (volRatio10d < 0.8) {
        score += 1.0;
        details.vol_compress = `거래량 x${volRatio10d.toFixed(2)} 감소 +1`;
      } else {
        details.vol_compress = `거래량 x${volRatio10d.toFixed(2)} 보통`;
      }
    } else {
      details.vol_compress = '거래량 데이터없음';
    }
  }

  // 5. 건조기 활력도 (0~2점) — 가격 활력 + 저점 회복
  // 검증 결과: 5일 레인지 8%+ → EV +1.57%, 회복률 7%+ → EV +1.25%
  if (idx >= 5) {
    let hi5 = 0, lo5 = Infinity;
    for (let j = idx - 4; j <= idx; j++) {
      if (data[j].high > hi5) hi5 = data[j].high;
      if (data[j].low < lo5) lo5 = data[j].low;
    }
    const range5d = hi5 > 0 ? (hi5 - lo5) / ((hi5 + lo5) / 2) : 0;
    // 저점 회복률 다시 계산 (스코어링용)
    const sIdxScore = idx - shakeoutDays;
    let sLow = Infinity;
    for (let j = sIdxScore; j <= Math.min(sIdxScore + 3, idx); j++) {
      if (data[j] && data[j].low < sLow) sLow = data[j].low;
    }
    const recov = sLow > 0 ? (row.close - sLow) / sLow : 0;
    if (range5d >= 0.08 && recov >= 0.07) {
      score += 2.0;
      details.base = `활력 우수 (5일${(range5d*100).toFixed(1)}% 회복${(recov*100).toFixed(0)}%) +2`;
    } else if (range5d >= 0.05 && recov >= 0.03) {
      score += 1.0;
      details.base = `활력 양호 (5일${(range5d*100).toFixed(1)}% 회복${(recov*100).toFixed(0)}%) +1`;
    } else {
      details.base = `활력 보통 (5일${(range5d*100).toFixed(1)}% 회복${(recov*100).toFixed(0)}%)`;
    }
  }

  return { score, details };
}

/**
 * 매집 감지 지표 래퍼 — 기존 calcIndicatorsV2 + VPD + SDE
 * calcIndicatorsV2는 수정 없이 그대로 호출 후, 추가 지표만 계산
 */
function calcAccumulationIndicators(data) {
  calcIndicatorsV2(data);
  calcVPD(data);
  detectSDE(data);
  return data;
}

// ── CommonJS export (서버에서 require 시 사용, 브라우저에서는 무시) ──
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    STOCK_PROFILES, calcIndicatorsV2, calcBuyScoreV2, calcDynamicPrices,
    benfordDeviationScore, benfordChi2, classifyProfile,
    analyzeVolumeBenford, analyzePriceChangeBenford,
    calcCompositeRankScore, RegimeFilter, CircuitBreaker,
    calcTargetPrice, calcStopPrice, getTpReason, getSlReason, getEntryReason,
    ACCUM_PROFILES, calcVPD, detectSDE, multiWindowBenford,
    calcAccumulationScore, calcAccumulationIndicators,
  };
}
