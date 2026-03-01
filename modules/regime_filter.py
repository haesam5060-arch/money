"""
KOSPI 시장 국면 감지 모듈 — Option A (약세 Hard Block)

국면 분류 기준:
    0 = 강세  → 매수 허용 (정상)
    1 = 횡보  → 매수 허용 (주의)
    2 = 약세  → 매수 차단 (Hard Block)

약세 판정 로직 (bad score 합산):
    ① KOSPI MA20 < MA60 (역배열)          +2
    ② KOSPI MA60 기울기 20일 < -2%        +2  (약하면 +1)
    ③ KOSPI 60일 수익률 < -10%            +2  (약하면 -4% 시 +1)
    ④ KOSPI 52주 고점 대비 낙폭 < -20%    +2  (약하면 -10% 시 +1)
    ⑤ KOSPI 20일 수익률 < -5%             +1  (단기 급락 조기 감지)
    → bad >= 4 : 약세 (Hard Block)  ← 기존 5에서 강화
    → bad >= 2 : 횡보
    → bad <  2 : 강세
"""
import os
import pandas as pd

_kospi_df = None
_kospi_by_date = {}   # date → (idx, row)


# ─────────────────────────────────────────────────────────────
# KOSPI 데이터 로드 (모듈 초기화 시 1회만 실행)
# ─────────────────────────────────────────────────────────────
def load_kospi(kospi_path=None):
    """
    KOSPI XML 파일을 로드하고 지표를 계산합니다.
    kospi_path 생략 시 xml/KOSPI.xml 경로를 자동으로 탐색합니다.

    Returns:
        True  — 로드 성공
        False — 파일 없음 (필터 비활성화 상태로 동작)
    """
    global _kospi_df, _kospi_by_date

    if kospi_path is None:
        base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        kospi_path = os.path.join(base, 'xml', 'KOSPI.xml')

    if not os.path.exists(kospi_path):
        return False

    from modules.data_parser import parse_stock_xml
    from modules.indicators import calc_all_indicators

    df, _, _ = parse_stock_xml(kospi_path)
    df = calc_all_indicators(df)
    _kospi_df = df
    _kospi_by_date = {row['date'].date(): (i, row) for i, row in df.iterrows()}
    return True


# ─────────────────────────────────────────────────────────────
# 국면 감지
# ─────────────────────────────────────────────────────────────
def detect_regime(date):
    """
    주어진 날짜의 KOSPI 시장 국면을 반환합니다.

    Parameters:
        date : datetime.date 또는 pandas Timestamp

    Returns:
        0 = 강세, 1 = 횡보, 2 = 약세
    """
    if not _kospi_by_date:
        return 0  # KOSPI 데이터 없으면 강세로 가정 → 차단 없음

    d = date.date() if hasattr(date, 'date') else date
    if d not in _kospi_by_date:
        return 1  # 해당 날짜 없음 → 안전하게 횡보 처리

    kidx, krow = _kospi_by_date[d]
    ma20  = krow.get('ma_20')
    ma60  = krow.get('ma_60')
    close = krow['close']

    if not (pd.notna(ma20) and pd.notna(ma60)):
        return 1

    bad = 0

    # ① MA 배열
    if ma20 < ma60:
        bad += 2
    elif (ma20 - ma60) / ma60 < 0.02:
        bad += 1

    # ② MA60 기울기 (20일 전 대비)
    if kidx >= 20:
        m60_20 = _kospi_df.iloc[kidx - 20].get('ma_60')
        if pd.notna(m60_20) and m60_20 > 0:
            slope = (ma60 - m60_20) / m60_20
            if slope < -0.02:
                bad += 2
            elif slope < 0:
                bad += 1

    # ③ 60일 수익률
    if kidx >= 60:
        c60 = _kospi_df.iloc[kidx - 60]['close']
        if c60 > 0:
            r60 = (close - c60) / c60
            if r60 < -0.10:
                bad += 2
            elif r60 < -0.04:
                bad += 1

    # ④ 52주 고점 대비 낙폭
    hi52 = _kospi_df['high'].iloc[max(0, kidx - 250):kidx + 1].max()
    if hi52 > 0:
        drawdown = (close - hi52) / hi52
        if drawdown < -0.20:
            bad += 2
        elif drawdown < -0.10:
            bad += 1

    # ⑤ 20일 단기 급락 (조기 경보)
    if kidx >= 20:
        c20 = _kospi_df.iloc[kidx - 20]['close']
        if c20 > 0:
            r20 = (close - c20) / c20
            if r20 < -0.05:
                bad += 1

    if bad >= 4:   # 기존 5 → 4로 강화
        return 2  # 약세
    if bad >= 2:
        return 1  # 횡보
    return 0      # 강세


def is_bear_market(date):
    """
    약세 국면 여부를 반환합니다. (Option A Hard Block 조건)

    Returns:
        True  → 약세 → 매수 차단
        False → 강세/횡보 → 매수 허용
    """
    return detect_regime(date) == 2


def regime_label(date):
    """날짜에 해당하는 국면 레이블 문자열 반환"""
    code = detect_regime(date)
    return {0: '강세', 1: '횡보', 2: '약세'}[code]
