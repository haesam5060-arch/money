import numpy as np
import pandas as pd
from modules.benford import (
    analyze_volume_benford,
    analyze_price_change_benford,
    is_near_psychological_level,
)


# ============================================================
# 종목 유형별 프로필 — 대형주와 중소형주는 변동성/패턴이 다름
# ============================================================
STOCK_PROFILES = {
    'default': {  # 중소형 성장주 (카카오페이, 셀트리온 등)
        'high_dist_max': 0.05,    # 20일 고점 대비 최대 거리 (5%)
        'ma20_slope_min': 0.02,   # MA20 10일 최소 기울기 (2%)
        'vol_overheat': 8.0,      # 거래량 과열 상한 (8배)
        'rsi_optimal': (70, 85),  # RSI 최적 구간 (데이터 검증: 고RSI = 세력 진행 중)
        'rsi_forming': (60, 70),  # RSI 모멘텀 형성 구간
        'ret20d_strong': 0.15,    # 20일 수익 강한 모멘텀 (15%)
        'ret20d_mid': 0.10,       # 20일 수익 중간 (10%)
        'ret20d_weak': 0.05,      # 20일 수익 약한 (5%)
        'take_profit': 0.17,      # 추천 익절 (17%)
        'stop_loss': 0.07,        # 추천 손절 (7%)
        'cooldown': 3,            # 추천 쿨다운
        'benford_weight': 0.10,   # 벤포드 최대 가중치 (15%)
    },
    'large_cap': {  # 대형 우량주 (삼성전자, 현대차, SK하이닉스 등)
        'high_dist_max': 0.07,    # 대형주는 고점 대비 7%까지 허용
        'ma20_slope_min': 0.01,   # 대형주는 기울기 1%면 충분
        'vol_overheat': 6.0,      # 대형주는 6배 이상이면 과열
        'rsi_optimal': (65, 80),  # 대형주도 고RSI가 세력 진행 확인 신호
        'rsi_forming': (55, 65),  # 대형주 모멘텀 형성 구간
        'ret20d_strong': 0.08,    # 대형주는 8%면 강한 모멘텀
        'ret20d_mid': 0.05,       # 대형주는 5%가 중간
        'ret20d_weak': 0.03,      # 대형주는 3%도 의미
        'take_profit': 0.10,      # 추천 익절 (10%)
        'stop_loss': 0.10,        # 추천 손절 (10%)
        'cooldown': 5,            # 추천 쿨다운
        'benford_weight': 0.10,   # 벤포드 최대 가중치 (15%)
    },
    'force_following': {  # 세력 추종형 — 벤포드 이상 + 거래량 급증 중심
        'high_dist_max': 0.08,    # 고점 대비 8%까지 허용 (매집 초기 포착)
        'ma20_slope_min': 0.01,   # MA20 기울기 완화 (매집 초기는 기울기 약함)
        'vol_overheat': 10.0,     # 거래량 10배까지 허용 (세력 진입시 폭발적 거래량)
        'rsi_optimal': (70, 90),  # 세력 추종형: 고RSI 구간이 핵심 (극단 모멘텀)
        'rsi_forming': (60, 70),  # 모멘텀 형성 구간
        'ret20d_strong': 0.12,    # 20일 강한 모멘텀 기준
        'ret20d_mid': 0.07,       # 20일 중간 기준
        'ret20d_weak': 0.03,      # 20일 약한 기준
        'take_profit': 0.21,      # 익절 +21% (세력 움직임은 큼)
        'stop_loss': 0.07,        # 손절 -7% 유지 (R:R = 1:3)
        'cooldown': 5,            # 쿨다운 5일 (세력 재진입 주기 고려)
        'benford_weight': 0.25,   # 벤포드 최대 가중치 대폭 상향 (35%)
    },
}


def get_profile(profile_name='default'):
    """종목 프로필 반환"""
    return STOCK_PROFILES.get(profile_name, STOCK_PROFILES['default'])


def calculate_buy_score(df, idx, benford_window=30, profile_name='default',
                        benford_influence=0.15, benford_min_hits=5):
    """
    매수 시그널 v6 — 종목 유형별 프로필 지원

    프로필별로 필수 조건의 임계값이 달라짐:
    - default(중소형주): 변동성 크고 성장 빠름 → 엄격한 기준
    - large_cap(대형주): 변동성 작고 안정적 → 완화된 기준

    필수 조건 (ALL):
      1. 정배열: MA5 > MA20 > MA60
      2. 종가가 20일 고점의 N% 이상 (프로필별)
      3. MA20이 10일 전 대비 N% 이상 상승 (프로필별)
      4. 양봉 (close > open)
      5. 거래량 < Nx 평균 (프로필별)
    """
    if idx < 60:
        return 0.0, {}

    p = get_profile(profile_name)
    row = df.iloc[idx]
    prev = df.iloc[idx - 1]
    details = {}

    ma5 = row.get('ma_5')
    ma20 = row.get('ma_20')
    ma60 = row.get('ma_60')

    # ============================================================
    # 필수 조건 5가지 (프로필별 임계값)
    # ============================================================

    # 1. 정배열 (MA5 > MA20 > MA60)
    if not (pd.notna(ma5) and pd.notna(ma20) and pd.notna(ma60)):
        return 0.0, {}
    if not (ma5 > ma20 > ma60):
        return 0.0, {}

    # 2. 20일 고점 근접 (프로필별 범위)
    high_20d = df['high'].iloc[max(0, idx - 20):idx + 1].max()
    if high_20d <= 0:
        return 0.0, {}
    dist_from_high = (high_20d - row['close']) / high_20d
    if dist_from_high > p['high_dist_max']:
        return 0.0, {}

    # 3. MA20 상승 (프로필별 최소 기울기)
    if idx < 10:
        return 0.0, {}
    ma20_10ago = df.iloc[idx - 10].get('ma_20')
    if not pd.notna(ma20_10ago) or ma20_10ago <= 0:
        return 0.0, {}
    ma20_slope = (ma20 - ma20_10ago) / ma20_10ago
    if ma20_slope < p['ma20_slope_min']:
        return 0.0, {}

    # 4. 양봉
    if row['close'] <= row['open']:
        return 0.0, {}

    # 5. 거래량 과열 차단 (프로필별 상한)
    vol_ratio = row.get('vol_ratio')
    if pd.notna(vol_ratio) and vol_ratio > p['vol_overheat']:
        return 0.0, {}

    # ============================================================
    # 필수 조건 모두 통과 → 스코어링 (기본 5.0점)
    # ============================================================
    score = 5.0
    details['core'] = f'정배열,고점{dist_from_high*100:.1f}%,MA20↑{ma20_slope*100:.1f}%'

    # === 1. RSI 모멘텀 점수 (데이터 검증: 고RSI = 세력 진행 = 승률↑) ===
    # 검증 결과: RSI>70 → 승률 38%, RSI<50 → 승률 18% (역전 확인)
    rsi = row.get('rsi')
    if pd.notna(rsi):
        if rsi >= 80:
            score += 2.5
            details['rsi'] = f'극강모멘텀({rsi:.0f})'   # 세력 강력 진행 중
        elif rsi >= 70:
            score += 2.0
            details['rsi'] = f'강모멘텀({rsi:.0f})'     # 데이터 최적 구간
        elif rsi >= 60:
            score += 1.0
            details['rsi'] = f'모멘텀({rsi:.0f})'
        elif rsi >= 50:
            score += 0.5
            details['rsi'] = f'중립모멘텀({rsi:.0f})'
        elif rsi >= 40:
            score += 0.0                                 # 중립: 0점
            details['rsi'] = f'중립({rsi:.0f})'
        else:
            score -= 1.0                                 # 하락 모멘텀: 패널티
            details['rsi'] = f'약세({rsi:.0f})'

    # === 2. MACD 상태 (검증: 히스토그램 음의 상관 → 캡 1.0으로 축소) ===
    macd = row.get('macd')
    macd_signal = row.get('macd_signal')
    macd_hist = row.get('macd_hist')
    prev_macd_hist = prev.get('macd_hist')

    _macd_score = 0.0
    if pd.notna(macd_hist) and macd_hist > 0:
        _macd_score += 1.0
        if pd.notna(prev_macd_hist) and macd_hist > prev_macd_hist:
            _macd_score += 0.5
            details['macd'] = 'MACD가속'
        else:
            details['macd'] = 'MACD양전'

    prev_macd = prev.get('macd')
    prev_macd_signal = prev.get('macd_signal')
    if all(pd.notna(v) for v in [macd, macd_signal, prev_macd, prev_macd_signal]):
        if macd > macd_signal and prev_macd <= prev_macd_signal:
            _macd_score += 1.5
            details['macd'] = 'MACD골든크로스'

    score += min(_macd_score, 1.0)  # 상한 캡: 최대 1.0점 (데이터 검증 결과 축소)

    # === 3. 20일 수익률 (검증: 미미한 기여도 → 축소) ===
    if idx >= 20:
        price_20ago = df.iloc[idx - 20]['close']
        if price_20ago > 0:
            ret_20d = (row['close'] - price_20ago) / price_20ago
            if ret_20d > p['ret20d_strong']:
                score += 0.5
                details['ret20d'] = f'+{ret_20d*100:.0f}%'
            elif ret_20d > p['ret20d_mid']:
                score += 0.3
                details['ret20d'] = f'+{ret_20d*100:.0f}%'
            elif ret_20d > p['ret20d_weak']:
                score += 0.2

    # === 4. 거래량 품질 (검증: 높은 거래량 = 승률↓, 대폭 축소) ===
    if pd.notna(vol_ratio):
        if profile_name == 'force_following':
            if 3.0 <= vol_ratio <= 7.0:
                score += 0.5
                details['volume'] = f'세력거래량(x{vol_ratio:.1f})'
            elif 1.5 <= vol_ratio < 3.0:
                score += 0.3
                details['volume'] = f'증가거래량(x{vol_ratio:.1f})'
            elif 7.0 < vol_ratio <= p['vol_overheat']:
                score -= 0.5  # 과열 → 패널티
                details['volume'] = f'폭발거래량(x{vol_ratio:.1f})'
        else:
            if 1.3 <= vol_ratio <= 3.0:
                score += 0.3
                details['volume'] = f'건전거래량(x{vol_ratio:.1f})'
            elif 3.0 < vol_ratio <= 5.0:
                score += 0.0
                details['volume'] = f'높은거래량(x{vol_ratio:.1f})'
            elif 5.0 < vol_ratio <= p['vol_overheat']:
                score -= 1.0  # 과열 강한 패널티 (승률 27%)
                details['volume'] = f'과열주의(x{vol_ratio:.1f})'

    # === 5. 캔들/패턴 ===
    if row.get('is_bullish_engulfing', False):
        score += 1.0
        details['candle'] = '상승장악형'

    # 연속 상승
    consec = 0
    for lb in range(1, min(8, idx + 1)):
        if df.iloc[idx - lb + 1]['close'] > df.iloc[idx - lb]['close']:
            consec += 1
        else:
            break
    if 2 <= consec <= 5:
        score += 0.5
        details['streak'] = f'{consec}일연속↑'
    elif consec > 5:
        score -= 0.5  # 너무 연속 상승 = 조정 임박

    # === 6. 볼린저밴드 (검증: 변별력 없음 → 삭제) ===
    # 필수조건(정배열+양봉+MA20상승) 통과 시 거의 항상 BB중심선 위
    # bb_mid 체크 제거

    # === 7. 20일 신고가 ===
    if row['close'] >= high_20d * 0.99:  # 거의 신고가
        score += 0.5
        details['breakout'] = '20일신고가'

    # === 8. MA60 기울기 (검증: 승률 상관 유의 → 상향) ===
    if idx >= 20:
        ma60_20ago = df.iloc[idx - 20].get('ma_60')
        if pd.notna(ma60_20ago) and ma60_20ago > 0:
            ma60_slope = (ma60 - ma60_20ago) / ma60_20ago
            if ma60_slope > 0.02:
                score += 1.5
                details['long_trend'] = f'MA60도상승(+{ma60_slope*100:.1f}%)'

    # === 10. MA200 — 장기 우상향 필터 ===
    ma200 = row.get('ma_200')
    if pd.notna(ma200) and ma200 > 0:
        if row['close'] > ma200:
            score += 1.5
            details['ma200'] = f'MA200위(+{(row["close"]/ma200-1)*100:.1f}%)'
        else:
            # MA200 아래 = 장기 하락 추세, 강한 패널티
            score -= 1.5
            details['ma200'] = f'MA200아래({(row["close"]/ma200-1)*100:.1f}%)'

    # === 11. 일목균형표 (검증: 구름위 = 회귀 기여도 1위 → 대폭 상향) ===
    tenkan    = row.get('ichi_tenkan')
    kijun     = row.get('ichi_kijun')
    cloud_a   = row.get('ichi_cloud_a')
    cloud_b   = row.get('ichi_cloud_b')
    if all(pd.notna(v) for v in [tenkan, kijun, cloud_a, cloud_b]):
        cloud_top = max(cloud_a, cloud_b)
        cloud_bot = min(cloud_a, cloud_b)
        close     = row['close']
        # 가격이 구름 위 → 강한 상승 추세 (기여도 1위)
        if close > cloud_top:
            score += 2.0
            details['ichimoku'] = '구름위'
        # 가격이 구름 안 → 중립 (보너스 없음)
        elif close < cloud_bot:
            score -= 0.5
            details['ichimoku'] = '구름아래'
        # 전환선 > 기준선 → 단기 상승 신호
        if tenkan > kijun:
            score += 0.5
            details['ichimoku'] = details.get('ichimoku', '') + '+전환>기준'
        # 구름 자체가 상승형 (선행A > 선행B)
        if cloud_a > cloud_b:
            score += 0.3
            details['ichimoku'] = details.get('ichimoku', '') + '+상승구름'

    # === 9. 벤포드 법칙 (benford_influence: 최대 승수 비율, benford_min_hits: 최소 데이터) ===
    # benford_influence: 0.0 ~ 0.5 (0.15 = 최대 15% 스코어 증폭)
    # benford_min_hits:  벤포드 분석에 필요한 최소 데이터 포인트 (기본 5)
    bw = min(p.get('benford_weight', 0.10), benford_influence)
    if profile_name == 'force_following':
        # 세력 추종형: 단기(15일) + 장기(60일) 이중 윈도우
        short_w = min(15, benford_window)
        long_w = min(60, idx + 1)
        vol_s, _ = analyze_volume_benford(
            df['volume'].iloc[max(0, idx - short_w):idx + 1].values, window=max(short_w, benford_min_hits))
        vol_l, _ = analyze_volume_benford(
            df['volume'].iloc[max(0, idx - long_w):idx + 1].values, window=max(long_w, benford_min_hits))
        pc_s, _ = analyze_price_change_benford(
            df['close'].iloc[max(0, idx - short_w):idx + 1].values, window=max(short_w, benford_min_hits))
        # 단기 이탈도 2배 가중 (최근 세력 흔적 강조)
        combined = (vol_s * 2 + vol_l + pc_s) / 4
        benford_mult = 1.0 + min(combined * bw * 2, bw * 2)
    else:
        eff_window = max(benford_window, benford_min_hits)
        volumes = df['volume'].iloc[max(0, idx - eff_window):idx + 1].values
        vol_bscore, _ = analyze_volume_benford(volumes, window=eff_window)
        prices = df['close'].iloc[max(0, idx - eff_window):idx + 1].values
        pc_bscore, _ = analyze_price_change_benford(prices, window=eff_window)
        benford_mult = 1.0 + min((vol_bscore + pc_bscore) * 0.1, benford_influence)

    if benford_mult > 1.03:
        details['benford'] = f'벤포드(x{benford_mult:.2f})'

    final_score = score * benford_mult
    return final_score, details


# ============================================================
# 매집 감지 스코어링 — 모멘텀과 근본적으로 다른 전략
# ============================================================
# 검증 결과 (194개 종목, 1,360건):
#   SDE 패턴: 승률 57.9%, EV +3.01% (모멘텀 EV +0.75% 대비 4배)
#   최적: TP=15%, SL=13%, MaxHold=20일
# ============================================================

ACCUM_PROFILES = {
    'default': {
        'rsi_range': (20, 85),         # SDE 폭발일은 RSI 급등 가능 → 넓은 범위
        'max_price_change_5d': 0.15,   # SDE 폭발일 자체가 +5%+ → 완화 필요
        'vpd_threshold': 3.0,          # VPD 시그널 기준
        'vpd_strong': 5.0,             # VPD 강한 시그널
        'take_profit': 0.15,           # 검증 최적 TP
        'stop_loss': 0.13,             # 검증 최적 SL
        'max_hold': 20,                # 최대 보유일
        'cooldown': 10,                # 쿨다운 (매집 시그널은 드물기 때문)
    },
}


def calculate_accumulation_score(df, idx, profile_name='default'):
    """
    매집 감지 시그널 스코어링 — SDE 패턴 중심

    모멘텀(calculate_buy_score)과의 차이:
      - RSI 25-70 (모멘텀은 70+)
      - 정배열 불필요 (매집은 추세 형성 전)
      - SDE 패턴이 핵심 (5점, 최대 기여)
      - VPD/벤포드는 보조 확인 시그널

    검증 결과:
      SDE 단독: 1,360건, 승률 57.9%, EV +3.01%
      SDE+VPD: 968건, 승률 58.1%, EV +3.06% (약간 선별)

    스코어링 (총 16점 만점):
      SDE 패턴:       0~5점 (풀 패턴 = 5점)
      VPD:            0~4점 (≥5.0 = 4점, ≥3.0 = 2.5점)
      벤포드 멀티윈도우: 0~3점 (alert=2 = 3점)
      거래량 압축:     0~2점 (10일간 vol 감소)
      가격 기반 형성:  0~2점 (20일 레인지 < 8%)
    """
    if idx < 60:
        return 0.0, {}

    p = ACCUM_PROFILES.get(profile_name, ACCUM_PROFILES['default'])
    row = df.iloc[idx]
    details = {}

    # ── 필수 게이트 1: RSI 매집 구간 ──
    rsi = row.get('rsi')
    if pd.notna(rsi):
        if rsi < p['rsi_range'][0] or rsi > p['rsi_range'][1]:
            return 0.0, {}

    # ── 필수 게이트 2: 최근 5일 급변동 없음 ──
    if idx >= 5:
        close_5ago = df.iloc[idx - 5]['close']
        if close_5ago > 0:
            ret_5d = abs((row['close'] - close_5ago) / close_5ago)
            if ret_5d > p['max_price_change_5d']:
                return 0.0, {}

    # ── 필수 게이트 3: SDE 패턴 (검증 결과 유일한 유효 시그널) ──
    # VPD/벤포드 단독은 NO-GO (v1 검증: 24K+ 시그널, 승률 48-50%)
    # SDE만 CONDITIONAL GO (1,360건, 승률 57.9%, EV +3.01%)
    sde = row.get('sde_signal', 0)
    if sde != 3:
        return 0.0, {}

    # ── 스코어링 (SDE 패턴 확인됨) ──
    score = 5.0  # SDE 기본 5점
    shakeout_days = row.get('sde_shakeout_days', 0)
    details['sde'] = f'매집패턴({shakeout_days}일전급락)'

    # 2. VPD (0~4점) — 보조 확인
    vpd_val = row.get('vpd', 0)
    if pd.notna(vpd_val):
        if vpd_val >= p['vpd_strong']:
            score += 4.0
            details['vpd'] = f'강VPD({vpd_val:.1f})'
        elif vpd_val >= p['vpd_threshold']:
            score += 2.5
            details['vpd'] = f'VPD({vpd_val:.1f})'
        elif vpd_val >= 2.0:
            score += 1.0
            details['vpd'] = f'약VPD({vpd_val:.1f})'

    # 3. 벤포드 멀티윈도우 (0~3점)
    from modules.benford import multi_window_benford
    volumes = df['volume'].iloc[max(0, idx - 30):idx + 1].values
    _, alert_level = multi_window_benford(volumes)
    if alert_level == 2:
        score += 3.0
        details['benford'] = '강벤포드이탈'
    elif alert_level == 1:
        score += 1.5
        details['benford'] = '벤포드이탈'

    # 4. 거래량 압축 (0~2점) — 공급 소화 확인
    if idx >= 10:
        vol_avg_col = row.get('vol_avg', None)
        if pd.notna(vol_avg_col) and vol_avg_col > 0:
            recent_10 = df['volume'].iloc[idx - 9:idx + 1]
            avg_recent = recent_10.mean()
            vol_ratio_10d = avg_recent / vol_avg_col
            if vol_ratio_10d < 0.6:
                score += 2.0
                details['vol_compress'] = f'거래건조(x{vol_ratio_10d:.1f})'
            elif vol_ratio_10d < 0.8:
                score += 1.0
                details['vol_compress'] = f'거래감소(x{vol_ratio_10d:.1f})'

    # 5. 가격 기반 형성 (0~2점) — 횡보/압축
    if idx >= 20:
        recent_20 = df.iloc[idx - 19:idx + 1]
        price_range = (recent_20['high'].max() - recent_20['low'].min())
        avg_price = recent_20['close'].mean()
        if avg_price > 0:
            range_pct = price_range / avg_price
            if range_pct < 0.08:
                score += 2.0
                details['base'] = f'가격압축({range_pct*100:.1f}%)'
            elif range_pct < 0.12:
                score += 1.0
                details['base'] = f'좁은레인지({range_pct*100:.1f}%)'

    return score, details
