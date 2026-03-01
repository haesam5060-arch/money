import pandas as pd
from modules.signal_engine import calculate_buy_score, calculate_accumulation_score
from modules.regime_filter import load_kospi, is_bear_market

# KOSPI 데이터 로드 (xml/KOSPI.xml 자동 탐색)
load_kospi()


CIRCUIT_BREAKER_LOSSES = 5   # 연속 손실 N회 → 쿨다운 연장 발동
CIRCUIT_BREAKER_EXTRA  = 15  # 추가 쿨다운 일수

# ── 거래 비용 (국내 주식 기준) ──────────────────────────
COMMISSION_RATE = 0.00015   # 증권사 수수료 0.015% (매수/매도 각각)
SELL_TAX_RATE   = 0.0018    # 증권거래세 0.18% (KOSPI 기준, 매도 시만)
ROUND_TRIP_COST = COMMISSION_RATE * 2 + SELL_TAX_RATE  # 합계 ≈ 0.21%


def _calc_dynamic_prices(df, signal_idx, fill_price, take_profit, stop_loss,
                          atr_tp_mult=3.0, atr_sl_mult=2.0):
    """
    신호 발생 시점의 데이터로 동적 진입가/목표가/손절가 계산

    Returns:
        pending_limit : 지정가 (다음날 매수 희망가)
        tp_level      : 목표가 (가격 레벨, None이면 fill 시 fixed % 사용)
        kijun_for_sl  : 손절 계산용 기준선 (None이면 fixed % 사용)
        atr_for_sl    : ATR 기반 손절 계산용 (None이면 미사용)
    """
    row   = df.iloc[signal_idx]
    close = row['close']

    # ── 진입가: 기준선 또는 MA20이 종가 10% 이내면 해당 레벨을 지정가로 ──
    kijun = row.get('ichi_kijun', None)
    ma20  = row.get('ma_20', None)
    if (kijun and kijun > 0 and kijun < close
            and (close - kijun) / close <= 0.10):
        pending_limit = kijun   # 기준선까지 눌리면 매수 (최우선)
    elif (ma20 and ma20 > 0 and ma20 < close
            and (close - ma20) / close <= 0.04):
        pending_limit = ma20    # MA20이 4% 이내면 MA20을 지정가로
    else:
        pending_limit = close   # 기본값: 현재 종가

    # ── 목표가: 120일 전고점 → 52일 전고점 → BB상단 → ATR×N → 고정% ──
    tp_level = None
    # 1순위: 120일 전고점 (5~40% 범위)
    pre120 = df.iloc[max(0, signal_idx - 120):signal_idx]
    if len(pre120) > 0:
        swing_high_120 = pre120['high'].max()
        if close * 1.05 <= swing_high_120 <= close * 1.40:
            tp_level = swing_high_120
    # 2순위: 52일 전고점 (5~40% 범위, 120일과 다를 경우)
    if tp_level is None:
        pre52 = df.iloc[max(0, signal_idx - 52):signal_idx]
        if len(pre52) > 0:
            swing_high_52 = pre52['high'].max()
            if close * 1.05 <= swing_high_52 <= close * 1.40:
                tp_level = swing_high_52
    # 3순위: BB상단 (3% 이상인 경우)
    if tp_level is None:
        bb_upper = row.get('bb_upper', None)
        if bb_upper and bb_upper > close * 1.03:
            tp_level = bb_upper
    # 4순위: ATR 기반 (종목별 변동성 반영)
    atr = row.get('atr_14', None)
    if tp_level is None and pd.notna(atr) and atr > 0:
        atr_tp = close + atr * atr_tp_mult
        if atr_tp >= close * 1.05 and atr_tp <= close * 1.40:
            tp_level = atr_tp

    # ── 손절가 기준 ─────────────────────────
    kijun_for_sl = kijun
    atr_for_sl = float(atr) if pd.notna(atr) and atr > 0 else None

    return pending_limit, tp_level, kijun_for_sl, atr_for_sl


def run_backtest(df, buy_threshold=4.0, take_profit=0.17, stop_loss=0.07,
                 cooldown=5, benford_window=30, profile_name='default',
                 use_regime_filter=True,
                 benford_influence=0.15, benford_min_hits=5,
                 rsi_min=70,
                 atr_tp_mult=3.0, atr_sl_mult=2.0,
                 mode='momentum', max_hold=0):
    """
    Walk-forward 백테스트 실행 (지정가 주문 + 데이터 기반 가격 설정)

    매일봉을 과거→현재 순서로 순회하며 상태 머신으로 처리:
      LOOKING  → N일: 스코어·RSI·구름 필터 → 신호 시 동적 지정가 설정
      PENDING  → N+1일: 지정가 체결 확인; 미달 시 주문 소멸
      IN_POSITION → 매일 TP/SL 체크 → 청산

    진입가: 기준선 5% 이내면 기준선, 아니면 종가
    목표가: 52일 전고점(8~40%) > BB상단 > 고정 비율 순 우선
    손절가: fill일 기준선 - 1.5% (단, 고정 stop_loss % 이내 제한)

    Parameters:
        rsi_min: 최소 RSI (기본 50 — 모멘텀 없는 신호 차단)
        mode: 'momentum' (기존) 또는 'accumulation' (매집 감지)
              매집 모드: RSI 필터 역전, SDE 패턴 중심 스코어링, 종가 진입
              검증 결과: 1,360건, 승률 57.9%, EV +3.01%
        max_hold: 최대 보유일 (0=무제한, 매집 모드 기본 20일)
    """
    trades = []
    last_signal_idx = -cooldown
    consec_losses   = 0

    # 상태 머신 변수
    state             = 'LOOKING'
    pending_limit     = None
    tp_level          = None   # 신호일에 계산한 목표가 레벨
    entry_price       = None
    entry_date        = None
    target_price      = None
    stop_price        = None
    atr_for_sl        = None
    score_at_signal   = 0.0
    details_at_signal = {}

    for idx in range(60, len(df)):
        effective_cooldown = (cooldown + CIRCUIT_BREAKER_EXTRA
                              if consec_losses >= CIRCUIT_BREAKER_LOSSES
                              else cooldown)

        # ── PENDING: 지정가 체결 여부 확인 ─────────────────────────
        if state == 'PENDING':
            row = df.iloc[idx]
            if row['open'] <= pending_limit:
                fill_price = row['open']      # 갭 하락 → 시가 체결 (더 유리)
            elif row['low'] <= pending_limit:
                fill_price = pending_limit    # 장중 지정가 터치 → 지정가 체결
            else:
                fill_price = None             # 지정가 미달 → 주문 소멸

            if fill_price is not None:
                entry_price = fill_price
                entry_date  = row['date']

                # ── 목표가: 신호일에 계산한 레벨 사용, 없으면 고정 % ──
                if tp_level and tp_level > fill_price * 1.03:
                    target_price = tp_level
                else:
                    target_price = fill_price * (1 + take_profit)

                # ── 손절가 ──
                if mode == 'accumulation':
                    # 매집 모드: 고정 SL만 사용 (기준선/ATR 무관, 추세 미형성)
                    stop_price = fill_price * (1 - stop_loss)
                else:
                    # 모멘텀 모드: 후보 중 가장 빡빡한(높은) 것 선택
                    candidates = []
                    fill_kijun = row.get('ichi_kijun', None)
                    if fill_kijun and fill_kijun > 0:
                        kijun_stop = fill_kijun * (1 - 0.03)   # 기준선 3% 아래
                        if kijun_stop < fill_price:
                            candidates.append(kijun_stop)
                    if atr_for_sl and atr_for_sl > 0:
                        atr_stop = fill_price - atr_for_sl * atr_sl_mult
                        if atr_stop > 0 and atr_stop < fill_price:
                            candidates.append(atr_stop)
                    fixed_stop = fill_price * (1 - stop_loss)
                    candidates.append(fixed_stop)
                    stop_price = max(candidates)  # 가장 빡빡한(높은) 쪽

                state = 'IN_POSITION'
                continue   # 체결 당일은 청산 체크 없이 다음날부터 시작
            else:
                state = 'LOOKING'   # 주문 소멸 → 당일 신호 재탐색 가능

        # ── IN_POSITION: TP/SL 청산 체크 ───────────────────────────
        if state == 'IN_POSITION':
            row = df.iloc[idx]

            # max_hold 체크: 최대 보유일 초과 시 강제 청산
            if max_hold > 0 and entry_date:
                holding = (row['date'] - entry_date).days
                if holding >= max_hold:
                    exit_price   = row['close']
                    exit_date    = row['date']
                    holding_days = holding
                    gross_return = (exit_price - entry_price) / entry_price
                    return_pct   = (gross_return - ROUND_TRIP_COST) * 100
                    result = 'WIN' if return_pct > 0 else 'LOSS'

                    if result == 'LOSS':
                        consec_losses += 1
                    else:
                        consec_losses = 0

                    trades.append({
                        'entry_date':   entry_date,
                        'entry_price':  int(entry_price),
                        'exit_date':    exit_date,
                        'exit_price':   int(exit_price),
                        'target_price': int(target_price),
                        'stop_price':   int(stop_price),
                        'score':        round(score_at_signal, 2),
                        'details':      details_at_signal,
                        'result':       result,
                        'return_pct':   round(return_pct, 2),
                        'holding_days': holding_days,
                    })
                    state = 'LOOKING'
                    continue

            hit_stop   = row['low']  <= stop_price
            hit_target = row['high'] >= target_price

            if hit_target or hit_stop:
                if hit_target and hit_stop:
                    if row['open'] <= stop_price:
                        result = 'LOSS'; exit_price = stop_price
                    elif row['open'] >= target_price:
                        result = 'WIN';  exit_price = target_price
                    else:
                        result = 'LOSS'; exit_price = stop_price   # 보수적: 손절 우선
                elif hit_target:
                    result = 'WIN';  exit_price = target_price
                else:
                    result = 'LOSS'; exit_price = stop_price

                exit_date    = row['date']
                holding_days = (exit_date - entry_date).days
                gross_return = (exit_price - entry_price) / entry_price
                return_pct   = (gross_return - ROUND_TRIP_COST) * 100

                if result == 'LOSS':
                    consec_losses += 1
                else:
                    consec_losses = 0

                trades.append({
                    'entry_date':   entry_date,
                    'entry_price':  int(entry_price),
                    'exit_date':    exit_date,
                    'exit_price':   int(exit_price),
                    'target_price': int(target_price),
                    'stop_price':   int(stop_price),
                    'score':        round(score_at_signal, 2),
                    'details':      details_at_signal,
                    'result':       result,
                    'return_pct':   round(return_pct, 2),
                    'holding_days': holding_days,
                })
                state = 'LOOKING'
            continue   # IN_POSITION 중: 새 신호 탐색 안 함

        # ── LOOKING: 쿨다운 확인 + 매수 신호 탐색 ─────────────────
        if idx - last_signal_idx < effective_cooldown:
            continue

        if mode == 'accumulation':
            # 매집 모드: RSI 필터 역전 (25-70), SDE 패턴 중심 스코어링
            score, details = calculate_accumulation_score(df, idx, profile_name)
            if score < buy_threshold:
                continue
        else:
            # 모멘텀 모드: 기존 로직 (RSI≥70 필터 + 정배열 + 스코어링)
            rsi = df.iloc[idx].get('rsi', None)
            if rsi is not None and rsi < rsi_min:
                continue
            score, details = calculate_buy_score(df, idx, benford_window, profile_name,
                                                 benford_influence, benford_min_hits)
            if score < buy_threshold:
                continue

        signal_date = df.iloc[idx]['date']
        if use_regime_filter and is_bear_market(signal_date):
            continue

        if mode == 'accumulation':
            # 매집 모드: 종가 진입 (추세 미형성, 기준선 대기 불필요)
            close = df.iloc[idx]['close']
            pending_limit = close
            tp_level = close * (1 + take_profit)  # 고정 TP (전고점 로직 불필요)
            atr_for_sl = None
        else:
            # 모멘텀 모드: 동적 진입가/목표가 계산 후 지정가 주문 설정
            pending_limit, tp_level, _, atr_for_sl = _calc_dynamic_prices(
                df, idx, df.iloc[idx]['close'], take_profit, stop_loss,
                atr_tp_mult, atr_sl_mult)

        score_at_signal   = score
        details_at_signal = details
        last_signal_idx   = idx
        state = 'PENDING'

    # 루프 종료 후 보유 중인 포지션 → OPEN 처리
    if state == 'IN_POSITION':
        last_row     = df.iloc[-1]
        exit_price   = last_row['close']
        exit_date    = last_row['date']
        holding_days = (exit_date - entry_date).days
        gross_return = (exit_price - entry_price) / entry_price
        return_pct   = (gross_return - ROUND_TRIP_COST) * 100
        trades.append({
            'entry_date':   entry_date,
            'entry_price':  int(entry_price),
            'exit_date':    exit_date,
            'exit_price':   int(exit_price),
            'target_price': int(target_price),
            'stop_price':   int(stop_price),
            'score':        round(score_at_signal, 2),
            'details':      details_at_signal,
            'result':       'OPEN',
            'return_pct':   round(return_pct, 2),
            'holding_days': holding_days,
        })
    # PENDING 상태로 루프 종료 시 → 미체결 주문 소멸 (trade 미등록)

    return trades


def summarize_trades(trades):
    """거래 결과 요약 통계"""
    if not trades:
        return {
            'total': 0, 'wins': 0, 'losses': 0, 'open': 0,
            'win_rate': 0.0, 'avg_return': 0.0, 'avg_holding': 0,
        }

    wins = [t for t in trades if t['result'] == 'WIN']
    losses = [t for t in trades if t['result'] == 'LOSS']
    opens = [t for t in trades if t['result'] == 'OPEN']
    closed = wins + losses

    win_rate = len(wins) / len(closed) * 100 if closed else 0
    avg_return = sum(t['return_pct'] for t in closed) / len(closed) if closed else 0
    avg_holding = sum(t['holding_days'] for t in closed) / len(closed) if closed else 0

    # 수익률 계산 (복리)
    total_return = 1.0
    for t in sorted(closed, key=lambda x: x['entry_date']):
        total_return *= (1 + t['return_pct'] / 100)
    total_return_pct = (total_return - 1) * 100

    return {
        'total': len(trades),
        'wins': len(wins),
        'losses': len(losses),
        'open': len(opens),
        'closed': len(closed),
        'win_rate': round(win_rate, 2),
        'avg_return': round(avg_return, 2),
        'avg_holding': round(avg_holding, 1),
        'total_return_pct': round(total_return_pct, 2),
        'best_trade': max(closed, key=lambda x: x['return_pct']) if closed else None,
        'worst_trade': min(closed, key=lambda x: x['return_pct']) if closed else None,
    }
