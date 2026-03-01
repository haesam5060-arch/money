#!/usr/bin/env python3
"""
매집 감지 시그널 195개 종목 검증
==================================
Phase 1: 지표 계산 (VPD, 멀티윈도우 벤포드, SDE 패턴)
Phase 2: 시그널별 Forward Return 분석
Phase 3: 임계값 그리드서치
Phase 4: 모의 백테스트 (매집 모드)
Phase 5: 종합 Go/No-Go 판정

통과 기준:
  1. 시그널 ≥ 100건
  2. 평균 fwd_20d > +3%
  3. fwd_20d > 0 비율 ≥ 55%
  4. 중앙값 max_gain_30d ≥ 8%
  5. 양수수익/음수수익 비율 > 1.3
"""

import sys, os, warnings
warnings.filterwarnings('ignore')
sys.path.insert(0, '/Users/kakao/Desktop/project/연구')

import numpy as np
import pandas as pd
from modules.data_parser import parse_stock_xml
from modules.indicators import calc_all_indicators
from modules.benford import multi_window_benford, benford_chi_square

XML_DIR = '/Users/kakao/Desktop/project/연구/xml/'

# ── 거래 비용 ──
ROUND_TRIP_COST = 0.0021  # 0.21%


def load_all_stocks():
    """195개 종목 로드 + 매집 지표 계산"""
    xml_files = sorted([f for f in os.listdir(XML_DIR) if f.endswith('.xml')])
    stocks = []
    for fname in xml_files:
        filepath = os.path.join(XML_DIR, fname)
        try:
            df, sym, name = parse_stock_xml(filepath)
            df = calc_all_indicators(df, include_accumulation=True)
            if len(df) >= 100:
                stocks.append((df, sym, name))
        except Exception:
            pass
    return stocks


def calc_forward_returns(df, signal_idx):
    """시그널 발생일로부터 미래 수익률 계산"""
    close_at_signal = df.iloc[signal_idx]['close']
    if close_at_signal <= 0:
        return None

    n = len(df)
    result = {'signal_idx': signal_idx}

    # Forward returns
    for days in [5, 10, 20, 30]:
        fwd_idx = signal_idx + days
        if fwd_idx < n:
            fwd_close = df.iloc[fwd_idx]['close']
            result[f'fwd_{days}d'] = (fwd_close - close_at_signal) / close_at_signal * 100
        else:
            result[f'fwd_{days}d'] = None

    # Max gain/drawdown within 30 days
    end_idx = min(signal_idx + 31, n)
    if end_idx > signal_idx + 1:
        future = df.iloc[signal_idx + 1:end_idx]
        future_highs = future['high'].values
        future_lows = future['low'].values
        result['max_gain_30d'] = (max(future_highs) - close_at_signal) / close_at_signal * 100
        result['max_dd_30d'] = (min(future_lows) - close_at_signal) / close_at_signal * 100
        # +10% 도달 여부
        result['hit_10pct'] = result['max_gain_30d'] >= 10.0
    else:
        result['max_gain_30d'] = None
        result['max_dd_30d'] = None
        result['hit_10pct'] = False

    return result


def detect_vpd_signals(df, threshold=3.0):
    """VPD 시그널 감지"""
    signals = []
    for i in range(60, len(df) - 30):  # 앞뒤 여유
        vpd = df.iloc[i].get('vpd', 0)
        if pd.notna(vpd) and vpd >= threshold:
            rsi = df.iloc[i].get('rsi', 50)
            if pd.notna(rsi) and 25 <= rsi <= 70:  # 매집 RSI 구간
                signals.append(i)
    return signals


def detect_benford_signals(df, chi2_long=20, chi2_short=15):
    """멀티윈도우 벤포드 시그널 감지"""
    signals = []
    for i in range(60, len(df) - 30):
        volumes = df['volume'].iloc[max(0, i - 30):i + 1].values
        _, alert_level = multi_window_benford(volumes)
        if alert_level >= 2:
            rsi = df.iloc[i].get('rsi', 50)
            if pd.notna(rsi) and 25 <= rsi <= 70:
                signals.append(i)
    return signals


def detect_sde_signals(df):
    """SDE 패턴 시그널 (이미 calc_all_indicators에서 계산됨)"""
    signals = []
    for i in range(60, len(df) - 30):
        sde = df.iloc[i].get('sde_signal', 0)
        if sde == 3:
            signals.append(i)
    return signals


def detect_combined_signals(df, vpd_signals, benford_signals, sde_signals, window=5):
    """5일 내 2개 이상 시그널 동시 발생"""
    all_signal_days = set()
    combined = []

    for i in range(60, len(df) - 30):
        count = 0
        types = []
        # i 기준 ±window일 내에 각 시그널 있는지
        for s in vpd_signals:
            if abs(s - i) <= window:
                count += 1
                types.append('VPD')
                break
        for s in benford_signals:
            if abs(s - i) <= window:
                count += 1
                types.append('BFD')
                break
        for s in sde_signals:
            if abs(s - i) <= window:
                count += 1
                types.append('SDE')
                break

        if count >= 2 and i not in all_signal_days:
            combined.append(i)
            all_signal_days.add(i)

    return combined


def analyze_signals(stocks, signal_type, detect_func, **kwargs):
    """시그널 타입별 Forward Return 분석"""
    all_results = []
    signal_count_by_stock = {}

    for df, sym, name in stocks:
        if signal_type == 'combined':
            vpd_s = detect_vpd_signals(df, kwargs.get('vpd_threshold', 3.0))
            bfd_s = detect_benford_signals(df)
            sde_s = detect_sde_signals(df)
            signals = detect_combined_signals(df, vpd_s, bfd_s, sde_s)
        else:
            signals = detect_func(df, **kwargs) if kwargs else detect_func(df)

        signal_count_by_stock[sym] = len(signals)

        # 중복 방지: 같은 종목에서 10일 이내 시그널은 첫 번째만
        filtered = []
        last_sig = -100
        for s in sorted(signals):
            if s - last_sig >= 10:
                filtered.append(s)
                last_sig = s

        for sig_idx in filtered:
            fwd = calc_forward_returns(df, sig_idx)
            if fwd:
                fwd['symbol'] = sym
                fwd['name'] = name
                fwd['date'] = df.iloc[sig_idx]['date'].strftime('%Y-%m-%d')
                fwd['close'] = int(df.iloc[sig_idx]['close'])
                fwd['rsi'] = df.iloc[sig_idx].get('rsi', 0)
                all_results.append(fwd)

    return all_results, signal_count_by_stock


def print_validation_report(name, results):
    """검증 리포트 출력 + Go/No-Go 판정"""
    if not results:
        print(f"  시그널 없음 — FAIL\n")
        return False

    n = len(results)
    fwd_20d = [r['fwd_20d'] for r in results if r['fwd_20d'] is not None]
    max_gains = [r['max_gain_30d'] for r in results if r['max_gain_30d'] is not None]
    hit_10 = [r for r in results if r.get('hit_10pct', False)]

    if not fwd_20d:
        print(f"  데이터 부족 — FAIL\n")
        return False

    avg_5d = np.mean([r['fwd_5d'] for r in results if r['fwd_5d'] is not None])
    avg_10d = np.mean([r['fwd_10d'] for r in results if r['fwd_10d'] is not None])
    avg_20d = np.mean(fwd_20d)
    avg_30d = np.mean([r['fwd_30d'] for r in results if r['fwd_30d'] is not None])

    win_rate_20d = len([x for x in fwd_20d if x > 0]) / len(fwd_20d) * 100
    median_max_gain = np.median(max_gains) if max_gains else 0
    hit_10_rate = len(hit_10) / n * 100

    # 양수/음수 수익 비율
    pos_returns = [x for x in fwd_20d if x > 0]
    neg_returns = [x for x in fwd_20d if x < 0]
    avg_pos = np.mean(pos_returns) if pos_returns else 0
    avg_neg = abs(np.mean(neg_returns)) if neg_returns else 1
    asymmetry = avg_pos / avg_neg if avg_neg > 0 else 0

    print(f"  시그널 수: {n}건")
    print(f"  Forward Return:")
    print(f"    5일 평균:  {avg_5d:+.2f}%")
    print(f"    10일 평균: {avg_10d:+.2f}%")
    print(f"    20일 평균: {avg_20d:+.2f}%")
    print(f"    30일 평균: {avg_30d:+.2f}%")
    print(f"  20일 승률: {win_rate_20d:.1f}%")
    print(f"  30일 내 최대상승 중앙값: {median_max_gain:.1f}%")
    print(f"  30일 내 +10% 도달: {hit_10_rate:.1f}%")
    print(f"  양수/음수 비율: {asymmetry:.2f}")

    # Go/No-Go 판정
    c1 = n >= 100
    c2 = avg_20d > 3.0
    c3 = win_rate_20d >= 55
    c4 = median_max_gain >= 8.0
    c5 = asymmetry > 1.3

    print(f"\n  통과 기준 판정:")
    print(f"    1. 시그널 ≥ 100건:        {'PASS' if c1 else 'FAIL'} ({n}건)")
    print(f"    2. 평균 fwd_20d > +3%:    {'PASS' if c2 else 'FAIL'} ({avg_20d:+.2f}%)")
    print(f"    3. 20일 승률 ≥ 55%:       {'PASS' if c3 else 'FAIL'} ({win_rate_20d:.1f}%)")
    print(f"    4. max_gain 중앙값 ≥ 8%:  {'PASS' if c4 else 'FAIL'} ({median_max_gain:.1f}%)")
    print(f"    5. 양수/음수 비율 > 1.3:  {'PASS' if c5 else 'FAIL'} ({asymmetry:.2f})")

    passed = sum([c1, c2, c3, c4, c5])
    verdict = 'GO' if passed >= 4 else ('CONDITIONAL' if passed >= 3 else 'NO-GO')
    print(f"\n  → 종합 판정: {verdict} ({passed}/5 통과)")

    return passed >= 3


def run_mock_backtest(stocks, results, tp_pct=0.25, sl_pct=0.10, max_hold=30):
    """매집 시그널 기반 모의 백테스트"""
    trades = []

    for r in results:
        if r['max_gain_30d'] is None:
            continue

        close = r['close']
        tp_price = close * (1 + tp_pct)
        sl_price = close * (1 - sl_pct)

        # 해당 종목 찾기
        target_df = None
        for df, sym, name in stocks:
            if sym == r['symbol']:
                target_df = df
                break
        if target_df is None:
            continue

        sig_idx = r['signal_idx']
        exit_price = None
        exit_result = None
        hold_days = 0

        for d in range(1, min(max_hold + 1, len(target_df) - sig_idx)):
            day = target_df.iloc[sig_idx + d]
            hold_days = d

            hit_tp = day['high'] >= tp_price
            hit_sl = day['low'] <= sl_price

            if hit_tp and hit_sl:
                if day['open'] <= sl_price:
                    exit_price = sl_price
                    exit_result = 'LOSS'
                else:
                    exit_price = tp_price
                    exit_result = 'WIN'
                break
            elif hit_tp:
                exit_price = tp_price
                exit_result = 'WIN'
                break
            elif hit_sl:
                exit_price = sl_price
                exit_result = 'LOSS'
                break

        if exit_result is None:
            # max hold 도달 → 종가 청산
            last_idx = min(sig_idx + max_hold, len(target_df) - 1)
            exit_price = target_df.iloc[last_idx]['close']
            exit_result = 'TIMEOUT'

        gross_return = (exit_price - close) / close
        net_return = (gross_return - ROUND_TRIP_COST) * 100

        trades.append({
            'symbol': r['symbol'],
            'date': r['date'],
            'entry': close,
            'exit': int(exit_price),
            'result': exit_result,
            'return_pct': round(net_return, 2),
            'hold_days': hold_days,
        })

    return trades


# ══════════════════════════════════════════════════════════════
# 메인 실행
# ══════════════════════════════════════════════════════════════
if __name__ == '__main__':
    print("=" * 75)
    print("  매집 감지 시그널 195개 종목 검증")
    print("=" * 75)

    print("\n종목 로딩 + 매집 지표 계산 중...")
    stocks = load_all_stocks()
    print(f"  {len(stocks)}개 종목 로드 완료\n")

    # ══════════════════════════════════════════════════════════
    # STEP 1: 시그널별 Forward Return 분석
    # ══════════════════════════════════════════════════════════
    print("=" * 75)
    print("  STEP 1: 시그널별 Forward Return 분석")
    print("=" * 75)

    # 1-1. VPD 시그널
    print(f"\n{'─' * 75}")
    print("  [VPD] 거래량-가격 괴리 시그널 (VPD ≥ 3.0, RSI 25-70)")
    print(f"{'─' * 75}")
    vpd_results, vpd_counts = analyze_signals(
        stocks, 'vpd', detect_vpd_signals, threshold=3.0)
    vpd_pass = print_validation_report('VPD', vpd_results)

    # 1-2. 벤포드 멀티윈도우 시그널
    print(f"\n{'─' * 75}")
    print("  [벤포드] 멀티윈도우 chi² 시그널 (alert_level ≥ 2, RSI 25-70)")
    print(f"{'─' * 75}")
    bfd_results, bfd_counts = analyze_signals(
        stocks, 'benford', detect_benford_signals)
    bfd_pass = print_validation_report('벤포드', bfd_results)

    # 1-3. SDE 패턴 시그널
    print(f"\n{'─' * 75}")
    print("  [SDE] 세이크아웃→건조→폭발 패턴")
    print(f"{'─' * 75}")
    sde_results, sde_counts = analyze_signals(
        stocks, 'sde', detect_sde_signals)
    sde_pass = print_validation_report('SDE', sde_results)

    # 1-4. 복합 시그널 (5일 내 2개 이상)
    print(f"\n{'─' * 75}")
    print("  [복합] 5일 내 2개 이상 시그널 동시 발생")
    print(f"{'─' * 75}")
    comb_results, comb_counts = analyze_signals(
        stocks, 'combined', None)
    comb_pass = print_validation_report('복합', comb_results)

    # ══════════════════════════════════════════════════════════
    # STEP 2: VPD 임계값 그리드서치
    # ══════════════════════════════════════════════════════════
    print(f"\n\n{'=' * 75}")
    print("  STEP 2: VPD 임계값 그리드서치")
    print("=" * 75)

    print(f"\n  {'VPD임계':>8} {'시그널수':>8} {'평균20d':>8} {'승률20d':>8} {'max_gain':>9} {'비대칭':>7}")
    print(f"  {'─' * 52}")

    best_vpd_threshold = 3.0
    best_vpd_score = -999

    for threshold in [1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0]:
        results, _ = analyze_signals(
            stocks, 'vpd', detect_vpd_signals, threshold=threshold)
        if not results:
            continue
        fwd_20d = [r['fwd_20d'] for r in results if r['fwd_20d'] is not None]
        max_gains = [r['max_gain_30d'] for r in results if r['max_gain_30d'] is not None]
        if not fwd_20d:
            continue
        avg_20 = np.mean(fwd_20d)
        wr = len([x for x in fwd_20d if x > 0]) / len(fwd_20d) * 100
        med_gain = np.median(max_gains) if max_gains else 0
        pos = [x for x in fwd_20d if x > 0]
        neg = [x for x in fwd_20d if x < 0]
        asym = np.mean(pos) / abs(np.mean(neg)) if neg else 0

        # 종합 스코어: 시그널수 + 수익률 + 승률
        combo_score = avg_20 * 0.5 + wr * 0.3 + med_gain * 0.2
        if combo_score > best_vpd_score and len(results) >= 30:
            best_vpd_score = combo_score
            best_vpd_threshold = threshold

        marker = ' ★' if threshold == best_vpd_threshold else ''
        print(f"  {threshold:>7.1f}  {len(results):>7}  {avg_20:>+7.2f}%  {wr:>7.1f}%  {med_gain:>8.1f}%  {asym:>6.2f}{marker}")

    print(f"\n  최적 VPD 임계값: {best_vpd_threshold}")

    # ══════════════════════════════════════════════════════════
    # STEP 3: 모의 백테스트
    # ══════════════════════════════════════════════════════════
    print(f"\n\n{'=' * 75}")
    print("  STEP 3: 모의 백테스트 (최적 복합 시그널)")
    print("=" * 75)

    # 가장 성과 좋은 시그널 타입으로 백테스트
    best_results = None
    best_name = None
    for name, results, passed in [('VPD', vpd_results, vpd_pass),
                                   ('벤포드', bfd_results, bfd_pass),
                                   ('SDE', sde_results, sde_pass),
                                   ('복합', comb_results, comb_pass)]:
        if results and len(results) >= 30:
            if best_results is None or len(results) > len(best_results):
                best_results = results
                best_name = name

    if best_results:
        # TP/SL 그리드
        print(f"\n  시그널: {best_name} ({len(best_results)}건)")
        print(f"\n  {'TP':>5} {'SL':>5} {'거래':>5} {'WIN':>5} {'LOSS':>5} {'TO':>5} {'승률':>7} {'평균수익':>9} {'EV':>9}")
        print(f"  {'─' * 60}")

        best_ev = -999
        best_tp_sl = (0.25, 0.10)

        for tp in [0.15, 0.20, 0.25, 0.30]:
            for sl in [0.07, 0.10, 0.13]:
                trades = run_mock_backtest(stocks, best_results, tp, sl, 30)
                if not trades:
                    continue
                wins = [t for t in trades if t['result'] == 'WIN']
                losses = [t for t in trades if t['result'] == 'LOSS']
                timeouts = [t for t in trades if t['result'] == 'TIMEOUT']
                closed = wins + losses
                if not closed:
                    continue
                wr = len(wins) / len(closed) * 100
                avg_ret = np.mean([t['return_pct'] for t in trades])
                avg_win = np.mean([t['return_pct'] for t in wins]) if wins else 0
                avg_loss = np.mean([t['return_pct'] for t in losses]) if losses else 0
                ev = (wr / 100) * avg_win + (1 - wr / 100) * avg_loss

                if ev > best_ev:
                    best_ev = ev
                    best_tp_sl = (tp, sl)

                marker = ' ★' if (tp, sl) == best_tp_sl and ev == best_ev else ''
                print(f"  {tp*100:>4.0f}% {sl*100:>4.0f}% {len(trades):>5} {len(wins):>5} "
                      f"{len(losses):>5} {len(timeouts):>5} {wr:>6.1f}% {avg_ret:>+8.2f}% {ev:>+8.2f}%{marker}")

        # 최적 TP/SL로 최종 백테스트
        print(f"\n  최적 TP/SL: TP={best_tp_sl[0]*100:.0f}%, SL={best_tp_sl[1]*100:.0f}%")

        final_trades = run_mock_backtest(stocks, best_results, best_tp_sl[0], best_tp_sl[1], 30)
        if final_trades:
            wins = [t for t in final_trades if t['result'] == 'WIN']
            losses = [t for t in final_trades if t['result'] == 'LOSS']
            timeouts = [t for t in final_trades if t['result'] == 'TIMEOUT']
            closed = wins + losses
            wr = len(wins) / len(closed) * 100 if closed else 0
            avg_ret = np.mean([t['return_pct'] for t in final_trades])
            avg_hold = np.mean([t['hold_days'] for t in final_trades])

            print(f"\n  총 거래: {len(final_trades)}건 (WIN {len(wins)}, LOSS {len(losses)}, TIMEOUT {len(timeouts)})")
            print(f"  승률: {wr:.1f}%")
            print(f"  평균 수익률: {avg_ret:+.2f}%")
            print(f"  평균 보유일: {avg_hold:.1f}일")

            # 복리 수익
            total_return = 1.0
            for t in sorted(final_trades, key=lambda x: x['date']):
                total_return *= (1 + t['return_pct'] / 100)
            print(f"  복리 누적 수익: {(total_return-1)*100:+.1f}%")

            # 상위 거래
            print(f"\n  상위 10건 (수익률 순):")
            for t in sorted(final_trades, key=lambda x: x['return_pct'], reverse=True)[:10]:
                print(f"    {t['date']} {t['symbol']:>6} {t['entry']:>7,}→{t['exit']:>7,} "
                      f"{t['return_pct']:>+6.2f}% {t['hold_days']:>2}일 {t['result']}")

    # ══════════════════════════════════════════════════════════
    # STEP 4: 종합 판정
    # ══════════════════════════════════════════════════════════
    print(f"\n\n{'=' * 75}")
    print("  STEP 4: 종합 Go/No-Go 판정")
    print("=" * 75)

    print(f"\n  시그널 타입       통과  시그널수  평균20d  판정")
    print(f"  {'─' * 55}")

    any_pass = False
    for sname, results, passed in [('VPD', vpd_results, vpd_pass),
                                    ('벤포드', bfd_results, bfd_pass),
                                    ('SDE', sde_results, sde_pass),
                                    ('복합', comb_results, comb_pass)]:
        fwd = [r['fwd_20d'] for r in results if r.get('fwd_20d') is not None] if results else []
        avg = np.mean(fwd) if fwd else 0
        v = 'GO' if passed else 'NO-GO'
        if passed:
            any_pass = True
        print(f"  {sname:<12}  {'PASS' if passed else 'FAIL':>4}  {len(results) if results else 0:>7}  {avg:>+7.2f}%  {v}")

    print(f"\n  {'═' * 55}")
    if any_pass:
        print("  최종 판정: GO — 시그널 엔진 탑재 진행")
        print("  → signal_engine.py에 calculate_accumulation_score() 추가")
        print("  → backtester.py에 mode='accumulation' 추가")
    else:
        print("  최종 판정: NO-GO — 시그널 품질 부족, 재설계 필요")
        print("  → 임계값 조정 또는 추가 시그널 개발 필요")

    print(f"\n{'=' * 75}")
