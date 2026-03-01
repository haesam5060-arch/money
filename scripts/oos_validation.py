#!/usr/bin/env python3
"""
Out-of-Sample (OOS) 검증
────────────────────────────────────────────────────────
학습 구간: ~2021-12-31  → 전 종목 공통 최적 파라미터 탐색
검증 구간: 2022-01-01~  → 그 파라미터 그대로 적용한 진짜 성적

핵심 원칙:
  - 파라미터를 찾을 때 검증 구간 데이터 일절 사용 안 함
  - 종목별 개별 최적화 금지 (전 종목 동일 파라미터)
  - 검증 구간은 한 번만 사용 (여러 번 보면 또 과적합)
"""
import os, sys, itertools
from datetime import date
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from modules.data_parser import parse_stock_xml
from modules.indicators import calc_all_indicators
from modules.backtester import run_backtest, summarize_trades

XML_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'xml')
TRAIN_END  = date(2021, 12, 31)   # 학습 구간 끝
TEST_START = date(2022,  1,  1)   # 검증 구간 시작

# ── 탐색할 파라미터 조합 (학습 구간용) ──────────────────────────
PARAM_GRID = {
    'buy_threshold': [4.5, 5.0, 5.5, 6.0],
    'take_profit':   [0.17, 0.21],
    'stop_loss':     [0.07],
    'cooldown':      [3, 5],
    'profile_name':  ['default'],
}

MIN_STOCKS  = 30   # 최소 종목 수 기준 (너무 적으면 신뢰 불가)
MIN_CLOSED  = 3    # 종목당 최소 완료 거래 수

# ────────────────────────────────────────────────────────────────

def load_all_stocks():
    """전체 XML 파싱 + 지표 계산 (한 번만 실행)"""
    stocks = []
    xml_files = sorted([f for f in os.listdir(XML_DIR)
                        if f.endswith('.xml') and f != 'KOSPI.xml'])
    print(f"  총 {len(xml_files)}개 XML 로드 중...")
    for i, fname in enumerate(xml_files):
        try:
            df, symbol, name = parse_stock_xml(os.path.join(XML_DIR, fname))
            df = calc_all_indicators(df)
            stocks.append({'symbol': symbol, 'name': name, 'df': df})
        except Exception:
            pass
        if (i+1) % 40 == 0:
            print(f"    {i+1}/{len(xml_files)} 완료...")
    print(f"  → {len(stocks)}개 로드 성공")
    return stocks


def filter_df(df, start=None, end=None):
    """날짜 범위로 DataFrame 필터 (date 컬럼 기준)"""
    mask = [True] * len(df)
    if start:
        mask = [m and (row >= start) for m, row in zip(mask, df['date'].dt.date)]
    if end:
        mask = [m and (row <= end) for m, row in zip(mask, df['date'].dt.date)]
    return df[mask].reset_index(drop=True)


def run_period(stocks, params, start=None, end=None, label=''):
    """특정 기간으로 필터한 데이터에 백테스트 실행"""
    results = []
    for s in stocks:
        df_cut = filter_df(s['df'], start=start, end=end)
        if len(df_cut) < 120:   # 데이터 부족 종목 제외
            continue
        try:
            trades = run_backtest(df_cut, **params, benford_window=30)
            if not trades:
                continue
            sm = summarize_trades(trades)
            if sm['closed'] < MIN_CLOSED:
                continue
            results.append({
                'symbol': s['symbol'], 'name': s['name'],
                'closed': sm['closed'], 'wins': sm['wins'],
                'win_rate': sm['win_rate'], 'avg_return': sm['avg_return'],
                'cum_return': sm['total_return_pct'],
            })
        except Exception:
            pass
    return results


def score_results(results):
    """파라미터 조합 평가 점수 (전 종목 기준)"""
    if len(results) < MIN_STOCKS:
        return -999
    total_closed = sum(r['closed'] for r in results)
    total_wins   = sum(r['wins']   for r in results)
    if total_closed == 0:
        return -999
    overall_wr  = total_wins / total_closed * 100
    avg_ret     = sum(r['avg_return'] for r in results) / len(results)
    stocks_60up = sum(1 for r in results if r['win_rate'] >= 60) / len(results) * 100
    # 점수: 승률 + 평균수익률 + 60%↑비율 (각 동일 가중)
    return overall_wr * 0.5 + avg_ret * 2 + stocks_60up * 0.3


def print_result(label, results, params=None):
    if not results:
        print(f"  {label}: 결과 없음")
        return
    total_closed = sum(r['closed'] for r in results)
    total_wins   = sum(r['wins']   for r in results)
    overall_wr   = total_wins / total_closed * 100 if total_closed else 0
    avg_ret      = sum(r['avg_return'] for r in results) / len(results)
    stocks_60    = sum(1 for r in results if r['win_rate'] >= 60)
    stocks_50    = sum(1 for r in results if r['win_rate'] >= 50)
    ev           = (overall_wr/100 * (params['take_profit']*100)
                    + (1-overall_wr/100) * (-params['stop_loss']*100)) if params else 0

    print(f"\n{'='*60}")
    print(f"  [{label}]")
    if params:
        print(f"  파라미터: 임계값={params['buy_threshold']} / "
              f"익절={params['take_profit']*100:.0f}% / "
              f"손절={params['stop_loss']*100:.0f}% / "
              f"쿨다운={params['cooldown']}일")
    print(f"{'='*60}")
    print(f"  분석 종목 수   : {len(results)}개")
    print(f"  총 완료 거래   : {total_closed:,}건")
    print(f"  전체 승률      : {overall_wr:.1f}%  ({total_wins:,}승 / {total_closed-total_wins:,}패)")
    print(f"  건당 평균수익  : {avg_ret:+.2f}%")
    print(f"  기댓값 (EV)    : {ev:+.2f}% ({'✅ 양수' if ev > 0 else '❌ 음수'})")
    print(f"  승률 50%↑ 종목 : {stocks_50}개 ({stocks_50/len(results)*100:.0f}%)")
    print(f"  승률 60%↑ 종목 : {stocks_60}개 ({stocks_60/len(results)*100:.0f}%)")

    top = sorted(results, key=lambda x: x['win_rate'], reverse=True)[:8]
    print(f"\n  ▶ 상위 8 종목")
    print(f"  {'종목':<12} {'승률':>6} {'거래':>5} {'평균수익':>8}")
    print(f"  {'-'*40}")
    for r in top:
        print(f"  {r['name'][:10]:<12} {r['win_rate']:>5.1f}% "
              f"{r['closed']:>5}건 {r['avg_return']:>+7.2f}%")


if __name__ == '__main__':
    print("\n" + "="*60)
    print("  Out-of-Sample 검증 시작")
    print(f"  학습: ~ {TRAIN_END}  |  검증: {TEST_START} ~")
    print("="*60)

    # 1. 전체 데이터 로드 (한 번만)
    print("\n[1단계] 데이터 로드")
    stocks = load_all_stocks()

    # 2. 학습 구간 파라미터 탐색
    print(f"\n[2단계] 학습 구간 파라미터 탐색 (~{TRAIN_END})")
    keys   = list(PARAM_GRID.keys())
    combos = list(itertools.product(*[PARAM_GRID[k] for k in keys]))
    print(f"  탐색할 조합 수: {len(combos)}개")

    best_score  = -999
    best_params = None
    best_train  = None

    for i, combo in enumerate(combos):
        params = dict(zip(keys, combo))
        results = run_period(stocks, params, end=TRAIN_END, label='train')
        sc = score_results(results)
        if sc > best_score:
            best_score  = sc
            best_params = params.copy()
            best_train  = results
        if (i+1) % 4 == 0:
            print(f"  조합 {i+1}/{len(combos)} 탐색 중... (현재 최고 점수: {best_score:.1f})")

    print(f"\n  ✅ 최적 파라미터 선정 완료 (점수: {best_score:.1f})")
    print_result("학습 구간 성적", best_train, best_params)

    # 3. 검증 구간: 찾은 파라미터 그대로 적용
    print(f"\n[3단계] 검증 구간 성적 ({TEST_START} ~)")
    print("  (학습 구간에서 찾은 파라미터를 그대로 적용)")
    test_results = run_period(stocks, best_params, start=TEST_START, label='test')
    print_result("검증 구간 성적 (진짜 성적)", test_results, best_params)

    # 4. 최종 판정
    if test_results:
        total_closed = sum(r['closed'] for r in test_results)
        total_wins   = sum(r['wins']   for r in test_results)
        wr = total_wins / total_closed * 100 if total_closed else 0
        ev = (wr/100 * best_params['take_profit']*100
              + (1-wr/100) * (-best_params['stop_loss']*100))
        print(f"\n{'='*60}")
        print(f"  📋 최종 판정")
        print(f"{'='*60}")
        train_wr = sum(r['wins'] for r in best_train) / sum(r['closed'] for r in best_train) * 100
        print(f"  학습 승률: {train_wr:.1f}%  →  검증 승률: {wr:.1f}%")
        drop = train_wr - wr
        print(f"  승률 하락폭: {drop:.1f}%p {'(양호 ✅)' if drop < 10 else '(과적합 의심 ⚠️)' if drop < 20 else '(과적합 심각 ❌)'}")
        print(f"  기댓값(EV): {ev:+.2f}% {'→ 실전 투입 가능 ✅' if ev > 1.0 else '→ 추가 개선 필요 ⚠️' if ev > 0 else '→ 전략 재설계 필요 ❌'}")
        print()
