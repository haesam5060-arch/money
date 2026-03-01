import numpy as np

# 벤포드 법칙 기대 확률: P(d) = log10(1 + 1/d)
BENFORD_EXPECTED = {d: np.log10(1 + 1 / d) for d in range(1, 10)}


def first_digit(n):
    """숫자의 첫째 유효숫자 추출"""
    n = abs(n)
    if n == 0:
        return 0
    while n < 1:
        n *= 10
    while n >= 10:
        n /= 10
    return int(n)


def benford_chi_square(values):
    """
    첫째자리 분포 vs 벤포드 기대분포의 카이제곱 통계량 계산
    값이 클수록 벤포드 법칙에서 크게 이탈
    """
    digits = [first_digit(v) for v in values if v != 0]
    if len(digits) < 5:
        return 0.0

    n = len(digits)
    observed = np.zeros(9)
    for d in digits:
        if 1 <= d <= 9:
            observed[d - 1] += 1

    expected = np.array([BENFORD_EXPECTED[d] * n for d in range(1, 10)])

    # 기대값이 0인 경우 방지
    mask = expected > 0
    chi2 = np.sum((observed[mask] - expected[mask]) ** 2 / expected[mask])
    return chi2


def benford_deviation_score(values):
    """
    벤포드 이탈도를 0~1 사이 연속 스코어로 반환
    0 = 벤포드 법칙에 완벽히 부합
    1 = 극단적 이탈
    """
    chi2 = benford_chi_square(values)
    # 시그모이드 정규화: chi2=15에서 약 0.5, chi2=30에서 약 0.88
    score = 1.0 - 1.0 / (1.0 + chi2 / 15.0)
    return score, chi2


def is_near_psychological_level(price, margin_pct=0.02):
    """
    가격이 심리적 지지/저항선(만원 단위 등) 근처인지 확인
    벤포드 법칙: 첫째자리가 작은 숫자일수록 해당 가격대에 오래 머묾
    → 자릿수 경계가 자연스러운 지지/저항선
    """
    if price <= 0:
        return False, 0

    magnitude = 10 ** (len(str(int(price))) - 1)
    # 가장 가까운 만원/천원 단위 레벨
    level = round(price / magnitude) * magnitude
    distance_pct = abs(price - level) / price
    return distance_pct < margin_pct, level


def multi_window_benford(volumes, windows=None):
    """
    멀티윈도우 벤포드 분석 — 매집 감지용

    여러 윈도우(5,7,10,15,30일)에서 동시에 chi² 계산.
    장기(30d) + 단기(5-10d) 동시 이탈 = 매집 강력 신호.

    카카오페이 검증:
      - 5/16: χ²(7d)=25.9, χ²(10d)=23.1, χ²(30d)=15.0 → 11일 후 +12%
      - 11월: χ²(30d)=28~41 연속 → 조용한 매집 구간

    Returns:
        results: dict {window: chi2}
        alert_level: 0(없음), 1(장기만), 2(장기+단기=강한 매집)
    """
    if windows is None:
        windows = [5, 7, 10, 15, 30]

    results = {}
    for w in windows:
        if len(volumes) < w or len(volumes) < 5:
            results[w] = 0.0
            continue
        recent = volumes[-w:]
        recent = recent[recent > 0]
        if len(recent) < 5:
            results[w] = 0.0
            continue
        results[w] = benford_chi_square(recent)

    # Alert level 판정
    long_alert = results.get(30, 0) > 20  # p<0.01 수준
    short_alert = any(results.get(w, 0) > 15 for w in [5, 7, 10])  # p<0.05

    if long_alert and short_alert:
        alert_level = 2  # 강한 매집 신호
    elif long_alert:
        alert_level = 1  # 매집 가능성
    else:
        alert_level = 0  # 신호 없음

    return results, alert_level


def analyze_volume_benford(volumes, window=20):
    """
    거래량의 벤포드 이탈도를 롤링 윈도우로 분석
    이탈이 크면 비정상적 시장 활동 (기관 매집, 작전 등)
    """
    if len(volumes) < window:
        return 0.0, 0.0

    recent = volumes[-window:]
    score, chi2 = benford_deviation_score(recent)
    return score, chi2


def analyze_price_change_benford(prices, window=20):
    """
    일별 가격 변동폭의 벤포드 이탈도 분석
    이탈이 크면 가격 움직임이 비자연적 (모멘텀 전환 가능성)
    """
    if len(prices) < window + 1:
        return 0.0, 0.0

    changes = np.abs(np.diff(prices[-window - 1:]))
    changes = changes[changes > 0]  # 변동 없는 날 제외

    if len(changes) < 5:
        return 0.0, 0.0

    score, chi2 = benford_deviation_score(changes)
    return score, chi2
