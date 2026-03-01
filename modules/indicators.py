import pandas as pd
import numpy as np


def calc_moving_averages(df, windows=[5, 20, 60, 200]):
    """이동평균선 계산 (MA200 추가)"""
    for w in windows:
        df[f'ma_{w}'] = df['close'].rolling(window=w).mean()
    return df


def calc_rsi(df, period=14):
    """RSI (Relative Strength Index) - Wilder 방식"""
    delta = df['close'].diff()
    gain = delta.clip(lower=0)
    loss = (-delta).clip(lower=0)

    # 첫 번째 평균: SMA
    avg_gain = pd.Series(np.nan, index=df.index, dtype=float)
    avg_loss = pd.Series(np.nan, index=df.index, dtype=float)

    avg_gain.iloc[period] = gain.iloc[1:period + 1].mean()
    avg_loss.iloc[period] = loss.iloc[1:period + 1].mean()

    # Wilder 지수이동평균
    for i in range(period + 1, len(df)):
        avg_gain.iloc[i] = (avg_gain.iloc[i - 1] * (period - 1) + gain.iloc[i]) / period
        avg_loss.iloc[i] = (avg_loss.iloc[i - 1] * (period - 1) + loss.iloc[i]) / period

    rs = avg_gain / avg_loss
    df['rsi'] = 100 - (100 / (1 + rs))
    return df


def calc_bollinger_bands(df, window=20, num_std=2):
    """볼린저밴드 계산"""
    df['bb_mid'] = df['close'].rolling(window=window).mean()
    rolling_std = df['close'].rolling(window=window).std()
    df['bb_upper'] = df['bb_mid'] + num_std * rolling_std
    df['bb_lower'] = df['bb_mid'] - num_std * rolling_std
    return df


def calc_volume_ratio(df, window=20):
    """거래량 비율 (현재 거래량 / N일 평균 거래량)"""
    df['vol_avg'] = df['volume'].rolling(window=window).mean()
    df['vol_ratio'] = df['volume'] / df['vol_avg']
    return df


def calc_macd(df, fast=12, slow=26, signal=9):
    """MACD 계산"""
    ema_fast = df['close'].ewm(span=fast, adjust=False).mean()
    ema_slow = df['close'].ewm(span=slow, adjust=False).mean()
    df['macd'] = ema_fast - ema_slow
    df['macd_signal'] = df['macd'].ewm(span=signal, adjust=False).mean()
    df['macd_hist'] = df['macd'] - df['macd_signal']
    return df


def detect_candle_patterns(df):
    """캔들스틱 패턴 감지"""
    body = df['close'] - df['open']
    body_abs = body.abs()
    upper_shadow = df['high'] - df[['open', 'close']].max(axis=1)
    lower_shadow = df[['open', 'close']].min(axis=1) - df['low']

    # 평균 몸통 크기 (기준값)
    avg_body = body_abs.rolling(window=20, min_periods=5).mean()

    # 망치형 (Hammer): 아래꼬리가 몸통의 2배 이상, 윗꼬리 작음
    df['is_hammer'] = (
        (lower_shadow > 2 * body_abs) &
        (upper_shadow < body_abs * 0.5) &
        (body_abs > 0)
    )

    # 상승장악형 (Bullish Engulfing): 전일 음봉을 오늘 양봉이 감싸는 패턴
    df['is_bullish_engulfing'] = (
        (body > 0) &
        (body.shift(1) < 0) &
        (df['open'] <= df['close'].shift(1)) &
        (df['close'] >= df['open'].shift(1))
    )

    # 유성형 (Shooting Star): 윗꼬리가 몸통 2배 이상
    df['is_shooting_star'] = (
        (upper_shadow > 2 * body_abs) &
        (lower_shadow < body_abs * 0.5) &
        (body_abs > 0)
    )

    # 하락장악형 (Bearish Engulfing)
    df['is_bearish_engulfing'] = (
        (body < 0) &
        (body.shift(1) > 0) &
        (df['open'] >= df['close'].shift(1)) &
        (df['close'] <= df['open'].shift(1))
    )

    # 도지 (Doji): 몸통이 매우 작음
    df['is_doji'] = body_abs < (avg_body * 0.1)

    return df


def calc_ichimoku(df):
    """일목균형표 계산 (선행스팬 A/B는 현재 시점 클라우드로 변환)"""
    high = df['high']
    low  = df['low']

    # 전환선 (9일)
    df['ichi_tenkan'] = (high.rolling(9).max() + low.rolling(9).min()) / 2
    # 기준선 (26일)
    df['ichi_kijun']  = (high.rolling(26).max() + low.rolling(26).min()) / 2
    # 선행스팬 A — 26봉 뒤에 표시되므로 shift(26)하면 현재 클라우드 값
    df['ichi_cloud_a'] = ((df['ichi_tenkan'] + df['ichi_kijun']) / 2).shift(26)
    # 선행스팬 B — 52일 고저 평균, 26봉 뒤에 표시
    df['ichi_cloud_b'] = ((high.rolling(52).max() + low.rolling(52).min()) / 2).shift(26)

    return df


def calc_atr(df, period=14):
    """ATR (Average True Range) — Wilder 방식"""
    high = df['high']
    low = df['low']
    prev_close = df['close'].shift(1)

    tr = pd.concat([
        high - low,
        (high - prev_close).abs(),
        (low - prev_close).abs()
    ], axis=1).max(axis=1)

    atr = pd.Series(np.nan, index=df.index, dtype=float)
    # 첫 번째 ATR: SMA
    if len(df) > period:
        atr.iloc[period] = tr.iloc[1:period + 1].mean()
        # Wilder 스무딩
        for i in range(period + 1, len(df)):
            atr.iloc[i] = (atr.iloc[i - 1] * (period - 1) + tr.iloc[i]) / period

    df['atr_14'] = atr
    return df


def calc_vpd(df):
    """
    VPD (Volume-Price Divergence) — 거래량-가격 괴리 지표
    VPD = vol_ratio / |일간등락률%|
    높을수록 '거래량은 많은데 가격이 안 움직임' = 조용한 매집 의심

    카카오페이 검증: VPD=6.2 → 17일 후 +30%
    """
    price_change_pct = df['close'].pct_change().abs() * 100
    price_change_pct = price_change_pct.clip(lower=0.1)  # 0% 방지

    vol_ratio = df['vol_ratio']
    vpd = (vol_ratio / price_change_pct).clip(upper=20.0)  # 극단값 제한
    vpd = vpd.where(vol_ratio >= 0.5, 0.0)  # 저볼륨 제외 (의미 없음)

    df['vpd'] = vpd
    return df


def detect_shakeout_dryup_explosion(df):
    """
    세력 매집 3단계 패턴 감지
    Phase 1 (세이크아웃): 급락 -4% 이상 + 거래량 1.5배 이상
    Phase 2 (건조/매집): 이후 10일 평균 거래량 < 1.0배 (공급 소화)
    Phase 3 (폭발): +5% 이상 + 거래량 2배 이상

    sde_signal 컬럼:
      0 = 신호 없음
      3 = 풀 패턴 확인 (진입 시그널)
    """
    n = len(df)
    sde_signal = pd.Series(0, index=df.index, dtype=int)
    sde_shakeout_days = pd.Series(0, index=df.index, dtype=int)

    for i in range(30, n):
        row = df.iloc[i]
        prev = df.iloc[i - 1]

        if prev['close'] <= 0:
            continue

        daily_return = (row['close'] - prev['close']) / prev['close']
        vol_ratio_val = row.get('vol_ratio', 1.0)
        if not pd.notna(vol_ratio_val):
            vol_ratio_val = 1.0

        # Phase 3: 오늘이 폭발일인지 확인
        if daily_return >= 0.05 and vol_ratio_val >= 2.0:
            # 과거 30일 내 세이크아웃+건조 패턴 탐색
            for s_offset in range(10, 31):
                s_idx = i - s_offset
                if s_idx < 1:
                    break
                s_row = df.iloc[s_idx]
                s_prev = df.iloc[s_idx - 1]
                if s_prev['close'] <= 0:
                    continue

                s_return = (s_row['close'] - s_prev['close']) / s_prev['close']
                s_vol = s_row.get('vol_ratio', 1.0)
                if not pd.notna(s_vol):
                    s_vol = 1.0

                # Phase 1: 세이크아웃 확인
                if s_return <= -0.04 and s_vol >= 1.5:
                    # Phase 2: 세이크아웃과 폭발 사이 건조도 확인
                    dryup_start = s_idx + 1
                    dryup_end = i
                    if dryup_end - dryup_start < 5:
                        continue
                    dryup_vols = []
                    for d in range(dryup_start, dryup_end):
                        dv = df.iloc[d].get('vol_ratio', 1.0)
                        if pd.notna(dv):
                            dryup_vols.append(dv)
                    if dryup_vols and np.mean(dryup_vols) < 1.0:
                        sde_signal.iloc[i] = 3
                        sde_shakeout_days.iloc[i] = s_offset
                        break

    df['sde_signal'] = sde_signal
    df['sde_shakeout_days'] = sde_shakeout_days
    return df


def calc_all_indicators(df, include_accumulation=False):
    """모든 기술지표를 한번에 계산

    include_accumulation: True면 매집 감지 지표도 계산 (VPD, SDE)
    기본값 False로 기존 시스템 영향 없음
    """
    df = calc_moving_averages(df)
    df = calc_rsi(df)
    df = calc_bollinger_bands(df)
    df = calc_volume_ratio(df)  # VPD보다 먼저 (vol_ratio 의존)
    df = calc_macd(df)
    df = detect_candle_patterns(df)
    df = calc_ichimoku(df)
    df = calc_atr(df)

    if include_accumulation:
        df = calc_vpd(df)
        df = detect_shakeout_dryup_explosion(df)

    return df
