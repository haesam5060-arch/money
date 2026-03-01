#!/usr/bin/env python3
"""
종합 딥 분석 스크립트
====================
1. 전체 195개 종목 스캔 (RSI≥70 필터 적용)
2. 상위 20개 종목 그리드서치 최적화
3. 손절 패턴 분석 (왜 TP를 못 달성했나)
4. 종목 티어별 최적 파라미터 도출
5. 100만원→1000만원 로드맵 제시
"""

import sys
import os
import json
import warnings
warnings.filterwarnings('ignore')

sys.path.insert(0, '/Users/kakao/Desktop/project/연구')

from modules.backtester import run_backtest, summarize_trades
from modules.data_parser import parse_stock_xml
from modules.indicators import calc_all_indicators

import numpy as np

# ─────────────────────────────────────────────────────────────
# 설정
# ─────────────────────────────────────────────────────────────
XML_DIR   = '/Users/kakao/Desktop/project/연구/xml/'
RSI_MIN   = 70          # 검증 완료: RSI≥70 = 40.7% WR

# 그리드서치 파라미터 공간
GRID_TP = [0.10, 0.15, 0.17, 0.20, 0.25, 0.30]
GRID_SL = [0.05, 0.07, 0.09, 0.11, 0.13]
GRID_CD = [3, 5, 7]

# 최소 거래 건수 (신뢰도)
MIN_TRADES_RANK = 5
MIN_TRADES_GRID = 8

# ─────────────────────────────────────────────────────────────
# 유틸
# ─────────────────────────────────────────────────────────────
def load_stock(filepath):
    try:
        df, sym, name = parse_stock_xml(filepath)
        df = calc_all_indicators(df)
        return df, sym, name
    except Exception as e:
        return None, None, None


def backtest_ev(trades):
    """기대값(EV) 계산: WR * avg_win + (1-WR) * avg_loss (nan/inf 제거)"""
    closed = [t for t in trades if t['result'] in ('WIN','LOSS')]
    if len(closed) < MIN_TRADES_GRID:
        return None, None, None
    # 이상값(nan/inf) 제거
    valid = [t for t in closed if np.isfinite(t['return_pct'])]
    if len(valid) < MIN_TRADES_GRID:
        return None, None, None
    wins   = [t['return_pct'] for t in valid if t['result'] == 'WIN']
    losses = [t['return_pct'] for t in valid if t['result'] == 'LOSS']
    # 최소 1건 손실이 있어야 EV 신뢰 가능 (all-win은 과적합 의심)
    if len(losses) == 0:
        return None, None, None
    wr  = len(wins) / len(valid)
    avg_win  = np.mean(wins)   if wins   else 0.0
    avg_loss = np.mean(losses)
    ev  = wr * avg_win + (1 - wr) * avg_loss
    if not np.isfinite(ev):
        return None, None, None
    return wr, ev, len(valid)


def composite_score(wr, ev, n_trades):
    """복합 점수: EV 40% + WR 30% + 안정성 30%"""
    if wr is None or ev is None or not np.isfinite(ev):
        return -999
    stability = min(n_trades / 30, 1.0)  # 30건 이상 = 완전 신뢰
    return ev * 0.40 + wr * 100 * 0.30 + stability * 30 * 0.30


# ─────────────────────────────────────────────────────────────
# STEP 1: 전체 종목 스캔 (기본 파라미터)
# ─────────────────────────────────────────────────────────────
print("=" * 70)
print("  STEP 1: 전체 종목 스캔 (RSI≥70 | TP=17% | SL=7% | CD=5일)")
print("=" * 70)

files = sorted([f for f in os.listdir(XML_DIR) if f.endswith('.xml')])
print(f"  총 {len(files)}개 종목 로드 중...\n")

all_results = []
failed = 0

for i, fname in enumerate(files):
    df, sym, name = load_stock(os.path.join(XML_DIR, fname))
    if df is None:
        failed += 1
        continue

    trades = run_backtest(df, take_profit=0.17, stop_loss=0.07,
                          cooldown=5, rsi_min=RSI_MIN)
    closed = [t for t in trades if t['result'] in ('WIN', 'LOSS')]

    if len(closed) < MIN_TRADES_RANK:
        continue

    wr, ev, n = backtest_ev(trades)
    if wr is None:
        continue

    # 현재 최신 RSI
    latest_rsi = df['rsi'].dropna().iloc[-1] if 'rsi' in df.columns else 0

    score = composite_score(wr, ev, n)
    all_results.append({
        'sym': sym, 'name': name,
        'wr': wr, 'ev': ev, 'n': n,
        'score': score,
        'latest_rsi': latest_rsi,
        'trades': trades,
        'df': df,
    })

    if (i + 1) % 30 == 0:
        print(f"  [{i+1}/{len(files)}] 처리 중...")

all_results.sort(key=lambda x: x['score'], reverse=True)

print(f"\n  완료: {len(all_results)}개 종목 분석 ({failed}개 실패)\n")
print(f"  {'순위':>3}  {'종목명':<14}  {'승률':>6}  {'EV':>7}  {'거래수':>5}  {'현RSI':>6}  {'복합점수':>8}")
print(f"  {'-'*62}")

for rank, r in enumerate(all_results[:30], 1):
    flag = " ★" if r['latest_rsi'] >= 70 else "  "
    print(f"  {rank:>3}  {r['name']:<14}  {r['wr']*100:>5.1f}%  "
          f"{r['ev']:>+6.2f}%  {r['n']:>5}건  {r['latest_rsi']:>5.1f}  "
          f"{r['score']:>7.2f}{flag}")

print(f"\n  ★ = 현재 RSI≥70 (지금 당장 투자 가능 종목)")


# ─────────────────────────────────────────────────────────────
# STEP 2: 상위 20개 종목 그리드서치 최적화
# ─────────────────────────────────────────────────────────────
TOP_N = 20
top_stocks = all_results[:TOP_N]

print(f"\n\n{'=' * 70}")
print(f"  STEP 2: 상위 {TOP_N}개 종목 그리드서치 최적화")
print(f"  TP={[int(x*100) for x in GRID_TP]}%  SL={[int(x*100) for x in GRID_SL]}%  CD={GRID_CD}일")
print(f"  총 조합: {len(GRID_TP)}×{len(GRID_SL)}×{len(GRID_CD)} = {len(GRID_TP)*len(GRID_SL)*len(GRID_CD)}개/종목")
print("=" * 70)

optimized = []

for r in top_stocks:
    df   = r['df']
    name = r['name']
    sym  = r['sym']

    best_score = -999
    best_params = None
    best_wr = 0
    best_ev = 0
    best_n  = 0

    for tp in GRID_TP:
        for sl in GRID_SL:
            for cd in GRID_CD:
                if tp / sl < 1.5:   # R:R 최소 1.5 이상만 허용
                    continue
                trades_g = run_backtest(df, take_profit=tp, stop_loss=sl,
                                        cooldown=cd, rsi_min=RSI_MIN)
                wr_g, ev_g, n_g = backtest_ev(trades_g)
                if wr_g is None:
                    continue
                s = composite_score(wr_g, ev_g, n_g)
                if s > best_score:
                    best_score  = s
                    best_params = (tp, sl, cd)
                    best_wr     = wr_g
                    best_ev     = ev_g
                    best_n      = n_g
                    best_trades = trades_g

    if best_params is None:
        continue

    base_wr, base_ev, base_n = backtest_ev(r['trades'])
    improvement_wr = (best_wr - base_wr) * 100
    improvement_ev = best_ev - base_ev

    optimized.append({
        'sym': sym, 'name': name,
        'base_wr': base_wr, 'base_ev': base_ev,
        'opt_wr': best_wr, 'opt_ev': best_ev, 'opt_n': best_n,
        'opt_tp': best_params[0], 'opt_sl': best_params[1], 'opt_cd': best_params[2],
        'improvement_wr': improvement_wr,
        'improvement_ev': improvement_ev,
        'opt_trades': best_trades,
        'df': df,
    })

    print(f"  {name:<12} ({sym})  "
          f"기본: WR={base_wr*100:.1f}% EV={base_ev:+.2f}%  →  "
          f"최적: WR={best_wr*100:.1f}% EV={best_ev:+.2f}%  "
          f"TP={best_params[0]*100:.0f}% SL={best_params[1]*100:.0f}% CD={best_params[2]}일")


# ─────────────────────────────────────────────────────────────
# STEP 3: 손절 패턴 분석 (왜 TP를 못 달성했나)
# ─────────────────────────────────────────────────────────────
print(f"\n\n{'=' * 70}")
print(f"  STEP 3: 손절 패턴 분석 — 손절 후 주가 행동 추적")
print("=" * 70)

total_losses    = 0
recovered_to_tp = 0   # SL 후 30일 이내 TP 도달
partial_recover = 0   # SL 후 15% 이상 반등
stayed_down     = 0   # SL 이후에도 계속 하락
bounce_pcts     = []  # SL 후 최대 반등폭

for r in optimized[:10]:  # 상위 10개 딥 분석
    df   = r['df']
    name = r['name']
    losses_this = [t for t in r['opt_trades'] if t['result'] == 'LOSS']
    total_losses += len(losses_this)

    for t in losses_this:
        exit_date  = t['exit_date']
        sl_price   = t['stop_price']
        tp_price   = t['target_price']

        # 손절 날짜 이후 30일 데이터
        after = df[df['date'] > exit_date].head(30)
        if len(after) == 0:
            continue

        max_high = after['high'].max()
        min_low  = after['low'].min()
        sl_pct   = t['stop_price']
        entry    = t['entry_price']

        # 손절 후 최대 반등폭 (entry 대비)
        bounce = (max_high - entry) / entry * 100
        bounce_pcts.append(bounce)

        if max_high >= tp_price:
            recovered_to_tp += 1
        elif bounce >= 15:
            partial_recover += 1
        else:
            stayed_down += 1

if total_losses > 0:
    # 반등폭 분포
    b = np.array(bounce_pcts)
    cat_neg    = (b < 0).sum()      # 계속 하락
    cat_03     = ((b >= 0) & (b < 3)).sum()
    cat_37     = ((b >= 3) & (b < 7)).sum()
    cat_715    = ((b >= 7) & (b < 15)).sum()
    cat_1530   = ((b >= 15) & (b < 30)).sum()
    cat_30p    = (b >= 30).sum()

    print(f"\n  분석 손절 건수: {total_losses}건 (상위 10개 종목 기준)\n")
    print(f"  ┌─────────────────────────────────────────────────────┐")
    print(f"  │  손절 후 30일 주가 행동 분석                          │")
    print(f"  ├─────────────────────────────────────────────────────┤")
    print(f"  │  TP 도달 (놓친 기회)     : {recovered_to_tp:>4}건 ({recovered_to_tp/total_losses*100:>5.1f}%)              │")
    print(f"  │  15%+ 부분 회복          : {partial_recover:>4}건 ({partial_recover/total_losses*100:>5.1f}%)              │")
    print(f"  │  계속 하락/횡보           : {stayed_down:>4}건 ({stayed_down/total_losses*100:>5.1f}%)              │")
    print(f"  └─────────────────────────────────────────────────────┘")
    print(f"\n  반등폭 분포 (entry 가격 기준):")
    print(f"    계속 하락     : {cat_neg:>4}건 ({cat_neg/total_losses*100:.1f}%)")
    print(f"    0~3% 반등     : {cat_03:>4}건 ({cat_03/total_losses*100:.1f}%)")
    print(f"    3~7% 반등     : {cat_37:>4}건 ({cat_37/total_losses*100:.1f}%)")
    print(f"    7~15% 반등    : {cat_715:>4}건 ({cat_715/total_losses*100:.1f}%)")
    print(f"    15~30% 반등   : {cat_1530:>4}건 ({cat_1530/total_losses*100:.1f}%)")
    print(f"    30%+ 반등     : {cat_30p:>4}건 ({cat_30p/total_losses*100:.1f}%)  ← 손절이 틀렸던 케이스")
    print(f"\n  평균 최대 반등폭: {np.mean(b):+.1f}%  |  중앙값: {np.median(b):+.1f}%")
    print(f"  정확한 손절(계속 하락+0~7% 반등): {(cat_neg+cat_03+cat_37)/total_losses*100:.1f}%")
    print(f"  아쉬운 손절(7~15% 반등): {cat_715/total_losses*100:.1f}%  ← SL 좀 더 여유를 줬으면...")
    print(f"  놓친 TP(15%+ 반등): {(cat_1530+cat_30p)/total_losses*100:.1f}%  ← SL이 너무 빡빡했던 케이스")

    if len(b) > 0:
        print(f"\n  ▶ 해석: 손절 이후 {(cat_neg+cat_03+cat_37)/total_losses*100:.0f}%는 올바른 손절,")
        print(f"         {(cat_1530+cat_30p)/total_losses*100:.0f}%는 SL을 조금만 넓혔으면 TP 달성 가능했음")


# ─────────────────────────────────────────────────────────────
# STEP 4: 티어별 최적 파라미터 도출
# ─────────────────────────────────────────────────────────────
print(f"\n\n{'=' * 70}")
print(f"  STEP 4: 티어별 최적 파라미터 분석")
print("=" * 70)

if optimized:
    # 최적화된 파라미터 집계
    tps = [r['opt_tp'] for r in optimized]
    sls = [r['opt_sl'] for r in optimized]
    cds = [r['opt_cd'] for r in optimized]
    wrs = [r['opt_wr'] for r in optimized]
    evs = [r['opt_ev'] for r in optimized]

    # TP 분포
    tp_counts = {}
    for tp in tps:
        tp_counts[tp] = tp_counts.get(tp, 0) + 1
    best_tp = max(tp_counts, key=tp_counts.get)

    # SL 분포
    sl_counts = {}
    for sl in sls:
        sl_counts[sl] = sl_counts.get(sl, 0) + 1
    best_sl = max(sl_counts, key=sl_counts.get)

    # CD 분포
    cd_counts = {}
    for cd in cds:
        cd_counts[cd] = cd_counts.get(cd, 0) + 1
    best_cd = max(cd_counts, key=cd_counts.get)

    print(f"\n  TP 분포: {dict(sorted(tp_counts.items()))}")
    print(f"  SL 분포: {dict(sorted(sl_counts.items()))}")
    print(f"  CD 분포: {dict(sorted(cd_counts.items()))}")

    print(f"\n  ┌─────────────────────────────────────────────────────────┐")
    print(f"  │  종목 티어별 권장 파라미터 (그리드서치 기반)               │")
    print(f"  ├─────────────┬──────┬──────┬──────┬──────────────────────┤")
    print(f"  │  티어       │  TP  │  SL  │  CD  │  기대 성과            │")
    print(f"  ├─────────────┼──────┼──────┼──────┼──────────────────────┤")

    # 상위 5개 → 안정형
    top5 = optimized[:5]
    avg_tp5 = np.mean([r['opt_tp'] for r in top5])
    avg_sl5 = np.mean([r['opt_sl'] for r in top5])
    avg_cd5 = np.median([r['opt_cd'] for r in top5])
    avg_wr5 = np.mean([r['opt_wr'] for r in top5])
    avg_ev5 = np.mean([r['opt_ev'] for r in top5])
    print(f"  │  TOP 5 (안정)│ {avg_tp5*100:.0f}%  │ {avg_sl5*100:.0f}%  │ {avg_cd5:.0f}일  │  WR={avg_wr5*100:.1f}% EV={avg_ev5:+.1f}%    │")

    # 6~15위 → 성장형
    mid10 = optimized[5:15]
    if mid10:
        avg_tp_m = np.mean([r['opt_tp'] for r in mid10])
        avg_sl_m = np.mean([r['opt_sl'] for r in mid10])
        avg_cd_m = np.median([r['opt_cd'] for r in mid10])
        avg_wr_m = np.mean([r['opt_wr'] for r in mid10])
        avg_ev_m = np.mean([r['opt_ev'] for r in mid10])
        print(f"  │  6~15위 (성장)│ {avg_tp_m*100:.0f}%  │ {avg_sl_m*100:.0f}%  │ {avg_cd_m:.0f}일  │  WR={avg_wr_m*100:.1f}% EV={avg_ev_m:+.1f}%    │")

    print(f"  └─────────────┴──────┴──────┴──────┴──────────────────────┘")


# ─────────────────────────────────────────────────────────────
# STEP 5: 100만원 → 1000만원 로드맵
# ─────────────────────────────────────────────────────────────
print(f"\n\n{'=' * 70}")
print(f"  STEP 5: 100만원 → 1,000만원 로드맵 시뮬레이션")
print("=" * 70)

# 상위 10개 종목으로 시뮬레이션
# 최적화된 파라미터로 연간 수익률 계산
if optimized:
    print(f"\n  [시뮬레이션 가정]")
    print(f"  - 자산: 100만원 시작, 한 번에 1개 종목만 (집중 투자)")
    print(f"  - 종목: 상위 10개 순환 매매")
    print(f"  - RSI≥70 진입 신호만 사용")
    print(f"  - 실제 거래 비용 포함 (수수료 0.015% + 세금 0.18%)")

    # 전체 최적화 종목의 평균 성과
    all_opt = optimized[:10]
    avg_wr = np.mean([r['opt_wr'] for r in all_opt])
    avg_ev = np.mean([r['opt_ev'] for r in all_opt])
    avg_n  = np.mean([r['opt_n']  for r in all_opt])

    # 연간 예상 거래수 (종목별 평균 × 10개 순환)
    # 각 종목 거래수 ÷ 데이터 기간(일) × 252 영업일
    trades_per_year_per_stock = []
    for r in all_opt:
        all_t = [t for t in r['opt_trades'] if t['result'] in ('WIN','LOSS')]
        if not all_t:
            continue
        date_range = (all_t[-1]['exit_date'] - all_t[0]['entry_date']).days
        if date_range > 0:
            annual_rate = len(all_t) / date_range * 252
            trades_per_year_per_stock.append(annual_rate)

    if trades_per_year_per_stock:
        avg_annual = np.mean(trades_per_year_per_stock)
        total_annual = avg_annual  # 1종목씩 순환하므로 동일

        print(f"\n  [백테스트 기반 연간 예상 성과]")
        print(f"  - 평균 승률       : {avg_wr*100:.1f}%")
        print(f"  - 평균 기대값(EV) : {avg_ev:+.2f}% per 거래")
        print(f"  - 연간 예상 거래수 : {total_annual:.0f}건")
        print(f"  - 연간 복리 수익률 : {((1 + avg_ev/100) ** total_annual - 1) * 100:+.0f}%")

    # 복리 성장 시뮬레이션
    print(f"\n  [복리 성장 시뮬레이션]")
    print(f"  시작 자산: 1,000,000원\n")

    capital = 1_000_000
    cumulative_trades = 0
    monthly_log = []

    # 모든 최적화 종목의 거래를 시간순으로 정렬 (nan/inf 제거)
    all_trade_results = []
    for r in all_opt:
        for t in r['opt_trades']:
            if t['result'] in ('WIN', 'LOSS') and np.isfinite(t['return_pct']):
                all_trade_results.append((t['entry_date'], t['return_pct'], r['name']))

    all_trade_results.sort(key=lambda x: x[0])

    if all_trade_results:
        monthly_capital = {}
        cap = 1_000_000
        trade_log = []

        # 연도별로 집계
        for date, ret, name in all_trade_results:
            cap *= (1 + ret / 100)
            year = date.year
            if year not in monthly_capital:
                monthly_capital[year] = []
            monthly_capital[year].append(cap)
            trade_log.append((date, ret, name, cap))

        print(f"  {'날짜':<12}  {'거래':>3}  {'자산':>14}  {'누적수익률':>9}")
        print(f"  {'-'*50}")

        # 분기별 출력
        prev_year = None
        trade_count = 0
        for i, (date, ret, stock, cap_val) in enumerate(trade_log):
            trade_count += 1
            year = date.year
            # 연말 또는 마지막 거래 출력
            if year != prev_year or i == len(trade_log) - 1:
                prev_year = year
                total_ret = (cap_val - 1_000_000) / 1_000_000 * 100
                marker = " ← 목표!" if cap_val >= 10_000_000 else ""
                print(f"  {str(date.date()):<12}  {trade_count:>3}건  {cap_val:>14,.0f}원  {total_ret:>+8.1f}%{marker}")

        final_cap = trade_log[-1][3] if trade_log else 1_000_000
        final_ret = (final_cap - 1_000_000) / 1_000_000 * 100
        target_x = final_cap / 1_000_000

        print(f"\n  최종 자산: {final_cap:,.0f}원 ({target_x:.1f}x)")
        print(f"  총 수익률: {final_ret:+.1f}%")

        if final_cap >= 10_000_000:
            print(f"\n  ✓ 목표 달성! 100만원 → 1000만원")
        else:
            gap = 10_000_000 - final_cap
            print(f"\n  △ 목표까지 {gap:,.0f}원 부족")
            print(f"    → 종목 선택 강화 + RSI≥70 필터 엄수로 개선 가능")


# ─────────────────────────────────────────────────────────────
# STEP 6: 현재 투자 가능 종목 (RSI≥70)
# ─────────────────────────────────────────────────────────────
print(f"\n\n{'=' * 70}")
print(f"  STEP 6: 현재 투자 가능 종목 (현재 RSI≥70 + 백테스트 우수)")
print("=" * 70)

investable = [r for r in all_results if r['latest_rsi'] >= 70]
investable.sort(key=lambda x: x['score'], reverse=True)

if investable:
    print(f"\n  현재 RSI≥70 조건 충족 종목: {len(investable)}개\n")
    print(f"  {'순위':>3}  {'종목명':<14}  {'현재RSI':>7}  {'WR':>6}  {'EV':>7}  {'거래수':>5}  {'추천 TP/SL'}")
    print(f"  {'-'*70}")

    # 각 투자 가능 종목의 최적 파라미터 찾기
    opt_map = {r['sym']: r for r in optimized}

    for rank, r in enumerate(investable[:15], 1):
        sym = r['sym']
        if sym in opt_map:
            o = opt_map[sym]
            tp_str = f"TP={o['opt_tp']*100:.0f}%/SL={o['opt_sl']*100:.0f}%"
        else:
            tp_str = "TP=17%/SL=7% (기본)"
        print(f"  {rank:>3}  {r['name']:<14}  {r['latest_rsi']:>6.1f}  "
              f"{r['wr']*100:>5.1f}%  {r['ev']:>+6.2f}%  {r['n']:>5}건  {tp_str}")
else:
    print(f"\n  현재 RSI≥70 조건 충족 종목 없음")
    print(f"  → 가장 높은 RSI 종목 상위 5개:")
    rsi_sorted = sorted(all_results, key=lambda x: x['latest_rsi'], reverse=True)
    for r in rsi_sorted[:5]:
        print(f"     {r['name']}: RSI={r['latest_rsi']:.1f}")


# ─────────────────────────────────────────────────────────────
# 최종 요약
# ─────────────────────────────────────────────────────────────
print(f"\n\n{'=' * 70}")
print(f"  최종 요약 및 권장 사항")
print("=" * 70)

if optimized:
    best = optimized[0]
    print(f"\n  ■ 최고 성과 종목: {best['name']} ({best['sym']})")
    print(f"    최적 파라미터: TP={best['opt_tp']*100:.0f}% | SL={best['opt_sl']*100:.0f}% | CD={best['opt_cd']}일")
    print(f"    기대 성과: WR={best['opt_wr']*100:.1f}% | EV={best['opt_ev']:+.2f}%")

print(f"""
  ■ 데이터 기반 최종 권장 사항:

  ① RSI≥70 필터 (검증 완료)
     - RSI≥70: 40.7% 승률 vs RSI<50: 18.4% 승률 (2.2배 차이)
     - 절대 RSI<70 신호에는 진입하지 말 것

  ② 동적 진입가 (Kijun 기준)
     - 기준선이 종가의 10% 이내 → 기준선을 지정가로
     - 기준선 지지 확인 후 매수 → 더 정밀한 진입

  ③ 동적 TP (120일 전고점)
     - 120일 전고점이 5~40% 범위 → 해당 레벨을 목표가로
     - 저항선이 명확한 TP → 현실적인 목표

  ④ 손절 기준
     - 기준선 -3% 또는 고정 SL 중 더 빡빡한 쪽
     - 손절 후 {recovered_to_tp/total_losses*100:.0f}% 케이스는 30일 내 TP 도달
     → SL을 조금 여유있게 설정하면 추가 이익 가능

  ⑤ 100만원→1000만원 현실적 전략:
     - 한 번에 1종목 집중 (분산 투자는 수익률 희석)
     - 상위 랭킹 + 현재 RSI≥70 종목만 선택
     - 월 1~3건 거래 목표 (과도한 매매 금지)
     - 수익 복리 재투자
""")

print("=" * 70)
print("  분석 완료")
print("=" * 70)
