import pandas as pd
import xml.etree.ElementTree as ET


def parse_stock_xml(filepath):
    """XML 주식 데이터 파싱 → pandas DataFrame 반환"""
    with open(filepath, 'r', encoding='euc-kr', errors='replace') as f:
        content = f.read()

    root = ET.fromstring(content)
    chartdata = root.find('.//chartdata')

    if chartdata is None:
        raise ValueError("XML에서 chartdata 요소를 찾을 수 없습니다")

    symbol = chartdata.get('symbol', '')
    name = chartdata.get('name', '')
    count = chartdata.get('count', '0')

    items = chartdata.findall('.//item')
    records = []

    for item in items:
        data = item.get('data', '')
        parts = data.split('|')
        if len(parts) == 6:
            records.append({
                'date': pd.to_datetime(parts[0]),
                'open': int(parts[1]),
                'high': int(parts[2]),
                'low': int(parts[3]),
                'close': int(parts[4]),
                'volume': int(parts[5])
            })

    df = pd.DataFrame(records)
    df = df.sort_values('date').reset_index(drop=True)

    return df, symbol, name
