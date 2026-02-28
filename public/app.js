// ═══════════════════════════════════════════════════════════════
// 상태 관리
// ═══════════════════════════════════════════════════════════════
let STATE = null;
let CONFIG = { threshold: 4.5, rsiMin: 70, useRegimeFilter: true, useCircuitBreaker: true, defaultProfile: 'auto' };
let _stockListCache = [];
let _livePrices = {};  // code → { price, changePct }
const _regimeFilter = new RegimeFilter();
let _circuitBreaker = null;

async function loadState() {
  try {
    const [sr, cr] = await Promise.all([
      fetch('/api/state').then(r=>r.json()).catch(()=>null),
      fetch('/api/config').then(r=>r.json()).catch(()=>({}))
    ]);
    if (sr) STATE = sr;
    else STATE = { version: 2, startDate: null, lastScan: null, positions: [], trades: [], scanLog: [], stockParams: {} };
    CONFIG = { ...CONFIG, ...cr };
  } catch(e) {
    STATE = { version: 2, startDate: null, lastScan: null, positions: [], trades: [], scanLog: [], stockParams: {} };
    document.getElementById('scanStatus').textContent = '서버 접속 실패 — server.js 실행 확인';
  }
  // 상태 마이그레이션 v2
  if (!STATE.version || STATE.version < 2) {
    STATE.positions = (STATE.positions || []).filter(p => p.status !== 'PENDING');
    STATE.version = 2;
    await saveState();
  }
  _circuitBreaker = new CircuitBreaker(STATE.trades);
  // UI 반영
  if (CONFIG.threshold) document.getElementById('cfgThreshold').value = CONFIG.threshold;
  if (CONFIG.appKey) document.getElementById('cfgAppKey').value = CONFIG.appKey;
  if (CONFIG.appSecret) document.getElementById('cfgAppSecret').value = CONFIG.appSecret;
  if (CONFIG.cano) document.getElementById('cfgCano').value = CONFIG.cano;
  if (CONFIG.anthropicKey) document.getElementById('cfgAnthropicKey').value = CONFIG.anthropicKey;
  if (CONFIG.rsiMin != null) document.getElementById('cfgRsiMin').value = CONFIG.rsiMin;
  if (CONFIG.defaultProfile) document.getElementById('cfgProfile').value = CONFIG.defaultProfile;
  if (CONFIG.useRegimeFilter != null) document.getElementById('cfgRegimeFilter').value = CONFIG.useRegimeFilter ? '1' : '0';
  if (CONFIG.useCircuitBreaker != null) document.getElementById('cfgCircuitBreaker').value = CONFIG.useCircuitBreaker ? '1' : '0';
  if (CONFIG.benfordWindow) document.getElementById('cfgBenfordWindow').value = CONFIG.benfordWindow;
  if (CONFIG.benfordInfluence != null) document.getElementById('cfgBenfordInfluence').value = Math.round((CONFIG.benfordInfluence||0.15)*100);
  if (CONFIG.benfordMinHits) document.getElementById('cfgBenfordMinHits').value = CONFIG.benfordMinHits;
  if (CONFIG.emailTo) document.getElementById('cfgEmailTo').value = CONFIG.emailTo;
  if (CONFIG.emailAppPassword) document.getElementById('cfgEmailAppPw').value = CONFIG.emailAppPassword;
  document.getElementById('cfgEmailEnabled').value = CONFIG.emailEnabled ? '1' : '0';
  document.getElementById('hdrRsiMin').textContent = CONFIG.rsiMin || 70;
  document.getElementById('hdrProfile').textContent = `프로필: ${CONFIG.defaultProfile || 'auto'}`;
  renderAll();
  // 레짐 필터 로드
  _regimeFilter.load().then(() => updateRegimeBadge());
  // 종목 캐시 로드
  loadStockList();
}

async function saveState() {
  try {
    const r = await fetch('/api/state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(STATE)});
    if (!r.ok) console.error('상태 저장 실패:', r.status);
  } catch(e) { console.error('상태 저장 실패:', e.message); }
}

async function saveConfig() {
  CONFIG = {
    threshold: parseFloat(document.getElementById('cfgThreshold').value) || 4.5,
    rsiMin: parseInt(document.getElementById('cfgRsiMin').value) || 70,
    defaultProfile: document.getElementById('cfgProfile').value,
    useRegimeFilter: document.getElementById('cfgRegimeFilter').value === '1',
    useCircuitBreaker: document.getElementById('cfgCircuitBreaker').value === '1',
    benfordWindow: parseInt(document.getElementById('cfgBenfordWindow').value) || 30,
    benfordInfluence: (parseFloat(document.getElementById('cfgBenfordInfluence').value) || 15) / 100,
    benfordMinHits: parseInt(document.getElementById('cfgBenfordMinHits').value) || 3,
    appKey: document.getElementById('cfgAppKey').value.trim(),
    appSecret: document.getElementById('cfgAppSecret').value.trim(),
    cano: document.getElementById('cfgCano').value.trim(),
    anthropicKey: document.getElementById('cfgAnthropicKey').value.trim(),
    emailTo: document.getElementById('cfgEmailTo').value.trim(),
    emailAppPassword: document.getElementById('cfgEmailAppPw').value.trim(),
    emailEnabled: document.getElementById('cfgEmailEnabled').value === '1',
  };
  await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(CONFIG)});
  document.getElementById('hdrRsiMin').textContent = CONFIG.rsiMin;
  document.getElementById('hdrProfile').textContent = `프로필: ${CONFIG.defaultProfile}`;
  document.getElementById('scanStatus').textContent = '설정 저장됨';
  setTimeout(() => document.getElementById('scanStatus').textContent = '', 2000);
}

async function resetState() {
  if (!confirm('모든 거래 데이터를 초기화합니까?')) return;
  STATE = { version: 2, startDate: null, lastScan: null, positions: [], trades: [], scanLog: [], stockParams: {} };
  await saveState(); renderAll();
}

async function generateTradingDoc() {
  try {
    const r = await fetch('/api/trading-doc/generate');
    const d = await r.json();
    if (d.ok) alert('매매 로직 문서가 생성되었습니다.\ndata/trading-logic.md\ndata/trading-logic.json');
    else alert(d.error || '생성 실패');
  } catch(e) { alert('오류: ' + e.message); }
}

async function viewTradingDoc() {
  try {
    const r = await fetch('/api/trading-doc');
    const d = await r.json();
    if (!d.ok) { alert(d.error || '문서 없음'); return; }
    // 모달로 표시
    const backdrop = document.getElementById('stockModalBackdrop');
    document.getElementById('stockModalTitle').textContent = '매매 로직 문서';
    document.getElementById('stockModalBody').innerHTML = `<pre style="white-space:pre-wrap;font-size:12px;line-height:1.8;color:#C8C2BC;max-height:70vh;overflow-y:auto;">${d.md}</pre>`;
    backdrop.classList.add('open');
  } catch(e) { alert('오류: ' + e.message); }
}

async function backupState() {
  await fetch('/api/state-backup', { method: 'POST' });
}

async function clearPending() {
  const pending = (STATE.positions || []).filter(p => p.status === 'PENDING');
  if (!pending.length) { alert('대기 주문이 없습니다.'); return; }
  if (!confirm(`대기 주문 ${pending.length}개를 삭제합니까?`)) return;
  await backupState();
  STATE.positions = STATE.positions.filter(p => p.status !== 'PENDING');
  await saveState(); renderAll();
  alert('대기 주문이 초기화되었습니다.');
}

// 대기 주문 전체 삭제 (탭 상단 버튼용)
async function clearAllPending() {
  const pending = (STATE.positions || []).filter(p => p.status === 'PENDING');
  if (!pending.length) { alert('대기 주문이 없습니다.'); return; }
  if (!confirm(`대기 주문 ${pending.length}개를 모두 삭제합니까?`)) return;
  STATE.positions = STATE.positions.filter(p => p.status !== 'PENDING');
  await saveState(); renderAll();
}

// 대기 주문 개별 삭제
async function deletePendingById(id) {
  STATE.positions = STATE.positions.filter(p => p.id !== id);
  await saveState(); renderAll();
}

// 보유 포지션 개별 삭제 (강제 청산)
async function deletePositionById(id) {
  const pos = STATE.positions.find(p => p.id === id);
  if (!pos) return;
  if (!confirm(`${pos.name} 포지션을 강제 삭제합니까? (실제 주문은 취소되지 않습니다)`)) return;
  STATE.positions = STATE.positions.filter(p => p.id !== id);
  await saveState(); renderAll();
}

// 체결 내역(스캔 로그) 전체 삭제
async function clearOrderLog() {
  if (!confirm('체결 내역을 모두 삭제합니까?')) return;
  STATE.scanLog = [];
  await saveState(); renderAll();
}

async function clearTrades() {
  if (!confirm('모든 거래 내역과 스캔 로그를 삭제합니까?')) return;
  if (!confirm('정말로 삭제합니까? (복원 가능: 백업 복원 버튼)')) return;
  await backupState();
  STATE.trades = []; STATE.scanLog = [];
  await saveState(); renderAll();
  alert('거래 내역이 초기화되었습니다.');
}

async function clearOhlcvCache() {
  if (!confirm('OHLCV 캐시를 모두 삭제합니까? (다음 스캔 시 재다운로드)')) return;
  try {
    const r = await fetch('/api/cache-clear-ohlcv', { method: 'POST' });
    const d = await r.json();
    alert(`OHLCV 캐시 ${d.deleted}개 파일 삭제 완료`);
  } catch(e) { alert('오류: ' + e.message); }
}

async function restoreBackup() {
  if (!confirm('마지막 백업으로 복원합니까? (현재 데이터는 덮어씌워집니다)')) return;
  try {
    const r = await fetch('/api/state-restore', { method: 'POST' });
    const d = await r.json();
    if (d.ok && d.state) { STATE = d.state; renderAll(); alert('복원 완료'); }
    else alert(d.error || '복원 실패');
  } catch(e) { alert('오류: ' + e.message); }
}

function toggleSettings() { const p = document.getElementById('settingsPanel'); p.style.display = p.style.display === 'none' ? 'block' : 'none'; }

async function testEmail() {
  const btn = document.getElementById('testEmailBtn');
  const msg = document.getElementById('testEmailMsg');
  btn.disabled = true; msg.textContent = '전송 중...'; msg.style.color = '#f5c842';
  try {
    const r = await fetch('/api/test-email', { method: 'POST' });
    const d = await r.json();
    if (d.ok) { msg.textContent = '전송 성공!'; msg.style.color = '#4caf50'; }
    else { msg.textContent = d.error || '실패'; msg.style.color = '#ef5350'; }
  } catch(e) { msg.textContent = '서버 오류'; msg.style.color = '#ef5350'; }
  btn.disabled = false;
  setTimeout(() => msg.textContent = '', 5000);
}

async function sendEmailNotification(type, data) {
  if (!CONFIG.emailEnabled) return;
  try {
    await fetch('/api/send-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, data })
    });
  } catch(e) { console.warn('[EMAIL]', e.message); }
}

async function loadStockList() {
  try {
    const r = await fetch('/api/kis-stocks');
    const d = await r.json();
    if (d.ok && d.stocks?.length) _stockListCache = d.stocks;
  } catch(e) {}
}

// 벤포드 가격대 프리셋
let _scanPriceMin = 0, _scanPriceMax = 0;
function setPreset(el) {
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  _scanPriceMin = parseInt(el.dataset.min) || 0;
  _scanPriceMax = parseInt(el.dataset.max) || 0;
  const label = _scanPriceMin > 0 ? `${_scanPriceMin.toLocaleString()}~${_scanPriceMax.toLocaleString()}원` : '전체';
  document.getElementById('scanStatus').textContent = `스캔 범위: ${label}`;
}

function updateRegimeBadge() {
  const badge = document.getElementById('regimeBadge');
  const r = _regimeFilter.getLatestRegime();
  badge.textContent = r.label;
  badge.className = 'regime-badge ' + ['regime-bull','regime-sideways','regime-bear'][r.regime];
  if (r.regime === 2) badge.textContent += ' (매수차단)';
}

// ═══════════════════════════════════════════════════════════════
// 종목 검색
// ═══════════════════════════════════════════════════════════════
let _headerSearchTimer=null;
async function onSearchInput() {
  const q = document.getElementById('searchInput').value.trim().toLowerCase();
  const dd = document.getElementById('searchDropdown');
  if (!q || q.length < 1) { dd.style.display = 'none'; return; }

  // 로컬 캐시 즉시 결과
  const list = _stockListCache.length ? _stockListCache : _btStockCache;
  const local = list.filter(s=>s.name.toLowerCase().includes(q)||s.code.includes(q)).slice(0,10);
  if(local.length){
    dd.innerHTML=local.map(s=>`<div class="search-item" onclick="openStockDetail('${s.code}','${s.name.replace(/'/g,"\\'")}')"><div><span class="si-name">${s.name}</span><span class="si-code">${s.code}</span></div><div><span class="si-price">${s.price?Number(s.price).toLocaleString()+'원':''}</span></div></div>`).join('');
    dd.style.display='block';
  }

  // KIS API 검색 (디바운스 300ms, 항상 실행)
  if(q.length>=2){
    clearTimeout(_headerSearchTimer);
    _headerSearchTimer=setTimeout(async()=>{
      try {
        const r = await fetch(`/api/kis-search?q=${encodeURIComponent(q)}`);
        const d = await r.json();
        if (!d.ok || !d.results.length) { if(!local.length)dd.style.display='none'; return; }
        // 병합: API 결과 우선 (가격 정보 있음)
        const apiCodes=new Set(d.results.map(s=>s.code));
        const localOnly=local.filter(s=>!apiCodes.has(s.code));
        const merged=[...d.results,...localOnly].slice(0,15);
        dd.innerHTML = merged.map(s => {
          const cls = (s.changePct||0) >= 0 ? 'pos-up' : 'pos-dn';
          const sign = (s.changePct||0) >= 0 ? '+' : '';
          return `<div class="search-item" onclick="openStockDetail('${s.code}','${s.name.replace(/'/g,"\\'")}')">
            <div><span class="si-name">${s.name}</span><span class="si-code">${s.code}</span></div>
            <div><span class="si-price">${s.price?Number(s.price).toLocaleString()+'원':''}</span>${s.changePct!=null?`<span class="si-change ${cls}">${sign}${s.changePct}%</span>`:''}</div>
          </div>`;
        }).join('');
        dd.style.display = 'block';
      } catch(e) { if(!local.length) dd.style.display = 'none'; }
    },300);
  }
}

let _detailChart = null; // 종목 상세 차트 인스턴스

async function openStockDetail(code, name, priceLines) {
  document.getElementById('searchInput').value = '';
  document.getElementById('searchDropdown').style.display = 'none';
  document.getElementById('stockModalTitle').textContent = `${name} (${code})`;
  document.getElementById('stockModalBody').innerHTML = '<div class="ai-loading">데이터 로딩 중...<div class="ai-spinner"></div></div>';
  document.getElementById('stockModalBackdrop').classList.add('open');

  try {
    const [priceR, askR, ohlcvR] = await Promise.all([
      fetch(`/api/kis-price/${code}`).then(r=>r.json()),
      fetch(`/api/kis-ask/${code}`).then(r=>r.json()),
      fetch(`/api/kis-ohlcv/${code}?days=600`).then(r=>r.json()),
    ]);

    let html = '';
    // 현재가 정보
    if (priceR.ok) {
      const p = priceR.data;
      const cls = p.changePct >= 0 ? 'pos-up' : 'pos-dn';
      html += `<div style="text-align:center;margin-bottom:16px;">
        <div style="font-size:32px;font-weight:800;" class="${cls}">${p.price.toLocaleString()}원</div>
        <div class="${cls}" style="font-size:14px;">${p.changePct >= 0 ? '+' : ''}${p.change.toLocaleString()}원 (${p.changePct >= 0 ? '+' : ''}${p.changePct}%)</div>
      </div>`;
      html += `<div class="stock-info-grid">
        <div class="si-lbl">시가</div><div class="si-val">${p.open.toLocaleString()}</div>
        <div class="si-lbl">고가</div><div class="si-val">${p.high.toLocaleString()}</div>
        <div class="si-lbl">저가</div><div class="si-val">${p.low.toLocaleString()}</div>
        <div class="si-lbl">거래량</div><div class="si-val">${p.volume.toLocaleString()}</div>
        <div class="si-lbl">52주 최고</div><div class="si-val">${p.high52w.toLocaleString()}</div>
        <div class="si-lbl">52주 최저</div><div class="si-val">${p.low52w.toLocaleString()}</div>
        <div class="si-lbl">시가총액</div><div class="si-val">${p.marketCap.toLocaleString()}억</div>
        <div class="si-lbl">PER / PBR</div><div class="si-val">${p.per} / ${p.pbr}</div>
      </div>`;
    }

    // 차트 컨테이너
    html += '<div id="detailChartWrap" style="width:100%;height:300px;border-radius:8px;overflow:hidden;margin-bottom:16px;background:#141413;"></div>';

    // 가격선 범례 (priceLines이 있을 때만)
    if (priceLines) {
      html += `<div style="display:flex;gap:16px;font-size:11px;margin-bottom:12px;flex-wrap:wrap;">
        ${priceLines.limitPrice ? `<span><span style="color:#f5c842;">━</span> 지정매수가 ${Math.round(priceLines.limitPrice).toLocaleString()}원</span>` : ''}
        ${priceLines.targetPrice ? `<span><span style="color:#4caf50;">━</span> 목표가 ${Math.round(priceLines.targetPrice).toLocaleString()}원</span>` : ''}
        ${priceLines.stopPrice ? `<span><span style="color:#ef5350;">━</span> 손절가 ${Math.round(priceLines.stopPrice).toLocaleString()}원</span>` : ''}
      </div>`;
    }

    // 호가
    if (askR.ok && askR.data) {
      const { asks, bids } = askR.data;
      html += '<div style="font-size:12px;color:#7A7470;margin-bottom:6px;">호가</div>';
      html += '<table class="ask-bid-table" style="min-width:auto;">';
      for (let i = Math.min(asks.length, 5) - 1; i >= 0; i--) {
        html += `<tr class="ask-row"><td style="text-align:right">${asks[i].qty.toLocaleString()}</td><td style="text-align:center;font-weight:600">${asks[i].price.toLocaleString()}</td><td>매도${i+1}</td></tr>`;
      }
      for (let i = 0; i < Math.min(bids.length, 5); i++) {
        html += `<tr class="bid-row"><td style="text-align:right">${bids[i].qty.toLocaleString()}</td><td style="text-align:center;font-weight:600">${bids[i].price.toLocaleString()}</td><td>매수${i+1}</td></tr>`;
      }
      html += '</table>';
    }

    // 시그널 점수 계산
    if (ohlcvR.ok && ohlcvR.data && ohlcvR.data.length > 60) {
      const data = ohlcvR.data;
      calcIndicatorsV2(data);
      const profileName = CONFIG.defaultProfile === 'auto' ? classifyProfile(code, _stockListCache) : CONFIG.defaultProfile;
      const { score, details } = calcBuyScoreV2(data, data.length - 1, profileName, CONFIG.benfordInfluence||0.15, CONFIG.benfordWindow||30, CONFIG.benfordMinHits||5);
      const lastRsi = data[data.length - 1].rsi;
      const rsiPass = lastRsi != null && lastRsi >= (CONFIG.rsiMin || 70);
      const scoreColor = score >= (CONFIG.threshold || 4.5) && rsiPass ? '#4caf50' : score > 0 ? '#f5c842' : '#ef5350';

      html += `<div class="signal-score-box">
        <div class="ss-title">매수 시그널 분석 (V2) &middot; 프로필: <span class="badge-profile">${profileName}</span></div>
        <div class="ss-score" style="color:${scoreColor}">${score.toFixed(1)}점</div>
        <div style="font-size:11px;color:#7A7470;margin-top:4px;">
          임계값: ${CONFIG.threshold || 4.5} | RSI: ${lastRsi != null ? lastRsi.toFixed(0) : '-'} ${rsiPass ? '(통과)' : '(차단)'}
        </div>
        <div class="signal-detail-list">${Object.entries(details).map(([k,v])=>`<span style="color:#C8B89A">${k}:</span> ${v}`).join(' &middot; ')}</div>
      </div>`;

      // 동적 가격
      if (score >= (CONFIG.threshold || 4.5) && rsiPass) {
        const profile = STOCK_PROFILES[profileName];
        const dp = calcDynamicPrices(data, data.length - 1, profile.take_profit, profile.stop_loss);
        html += `<div style="background:#141413;border-radius:8px;padding:12px;font-size:12px;margin-bottom:12px;">
          <div style="color:#7A7470;margin-bottom:6px;">동적 가격 계산</div>
          <div>진입가: <span style="color:#f5c842;font-weight:600">${Math.round(dp.pendingLimit).toLocaleString()}원</span> (${getEntryReason(dp.pendingLimit, data[data.length-1])})</div>
          <div>목표가: <span style="color:#4caf50;font-weight:600">${dp.tpLevel ? Math.round(dp.tpLevel).toLocaleString()+'원' : '고정 +'+Math.round(profile.take_profit*100)+'%'}</span></div>
          <div>손절가: 체결 시 기준선-3% vs 고정-${Math.round(profile.stop_loss*100)}% 중 빡빡한 쪽</div>
        </div>`;
      }
    }

    document.getElementById('stockModalBody').innerHTML = html;

    // 차트 렌더링
    if (ohlcvR.ok && ohlcvR.data && ohlcvR.data.length > 30) {
      renderDetailChart(ohlcvR.data, priceLines);
    }
  } catch(e) {
    document.getElementById('stockModalBody').innerHTML = `<div style="color:#ef5350">데이터 로딩 실패: ${e.message}</div>`;
  }
}

function renderDetailChart(data, priceLines) {
  const container = document.getElementById('detailChartWrap');
  if (!container || typeof LightweightCharts === 'undefined') return;
  if (_detailChart) { _detailChart.remove(); _detailChart = null; }

  _detailChart = LightweightCharts.createChart(container, {
    width: container.clientWidth, height: 300,
    layout: { background: { color: '#141413' }, textColor: '#7A7470', fontSize: 11 },
    grid: { vertLines: { color: '#1E1D1B' }, horzLines: { color: '#1E1D1B' } },
    crosshair: { mode: 0 },
    rightPriceScale: { borderColor: '#252320' },
    timeScale: { borderColor: '#252320', timeVisible: false },
  });

  // 최근 120일 데이터
  const recent = data.slice(-120);
  const candles = recent.map(d => ({ time: d.date, open: d.open, high: d.high, low: d.low, close: d.close }));

  const candleSeries = _detailChart.addCandlestickSeries({
    upColor: '#ef5350', downColor: '#2962FF', borderUpColor: '#ef5350', borderDownColor: '#2962FF',
    wickUpColor: '#ef5350', wickDownColor: '#2962FF',
  });
  candleSeries.setData(candles);

  // MA20 라인
  const ma20Data = recent.filter(d => d.ma20 != null).map(d => ({ time: d.date, value: d.ma20 }));
  if (ma20Data.length > 0) {
    const ma20Series = _detailChart.addLineSeries({ color: '#4a9eff', lineWidth: 1, priceLineVisible: false });
    ma20Series.setData(ma20Data);
  }

  // TP/SL/진입가 수평선
  if (priceLines) {
    if (priceLines.targetPrice) {
      candleSeries.createPriceLine({ price: priceLines.targetPrice, color: '#4caf50', lineWidth: 2, lineStyle: 0, axisLabelVisible: true, title: 'TP' });
    }
    if (priceLines.stopPrice) {
      candleSeries.createPriceLine({ price: priceLines.stopPrice, color: '#ef5350', lineWidth: 2, lineStyle: 0, axisLabelVisible: true, title: 'SL' });
    }
    if (priceLines.limitPrice) {
      candleSeries.createPriceLine({ price: priceLines.limitPrice, color: '#f5c842', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '매수가' });
    }
  }

  _detailChart.timeScale().fitContent();

  // 반응형
  new ResizeObserver(() => {
    if (_detailChart && container.clientWidth > 0) _detailChart.applyOptions({ width: container.clientWidth });
  }).observe(container);
}

function closeStockModal() {
  document.getElementById('stockModalBackdrop').classList.remove('open');
  if (_detailChart) { _detailChart.remove(); _detailChart = null; }
}

// ═══════════════════════════════════════════════════════════════
// 현재가 조회
// ═══════════════════════════════════════════════════════════════
async function fetchLivePrices() {
  const positions = (STATE?.positions || []).filter(p => p.status === 'IN_POSITION');
  if (!positions.length) return;
  for (const pos of positions) {
    try {
      const r = await fetch(`/api/kis-price/${pos.code}`);
      const d = await r.json();
      if (d.ok) _livePrices[pos.code] = { price: d.data.price, changePct: d.data.changePct };
    } catch(e) {}
  }
  renderPositions();
}

// ═══════════════════════════════════════════════════════════════
// 일간 스캔 (V2 로직 적용)
// ═══════════════════════════════════════════════════════════════
let _pendingStopAnalysis = [];

// ═══════════════════════════════════════════════════════════════
// 통합 스캔 파이프라인: 서버 스캔 → Top 30 산출 → 자동 대기 주문
// ═══════════════════════════════════════════════════════════════
let _unifiedScanPhase = '';  // 'scan' | 'ranking' | 'done'
let _scanPollTimer = null;
let _rankPollTimer = null;

async function runUnifiedScan() {
  const btn = document.getElementById('scanBtn');
  const progressWrap = document.getElementById('progressWrap');
  const progressLabel = document.getElementById('progressLabel');
  const progressCount = document.getElementById('progressCount');
  const progressFill = document.getElementById('progressFill');

  btn.disabled = true;
  progressWrap.style.display = 'block';
  _unifiedScanPhase = 'scan';

  // 주말 안내
  const dow = new Date().getDay();
  if (dow === 0 || dow === 6) {
    document.getElementById('scanStatus').textContent = '주말: 금요일 데이터 기준 분석';
  }

  // PHASE 1: 서버 스캔 시작 (기존 포지션 체결/청산 체크 + 동적 TP 재조정)
  progressLabel.textContent = '[1/3] 서버 스캔 시작 중...';
  try {
    const r = await fetch('/api/scan/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ priceMin: _scanPriceMin, priceMax: _scanPriceMax })
    });
    const d = await r.json();
    if (!d.ok) { progressLabel.textContent = d.error; btn.disabled = false; return; }
    _scanPollTimer = setInterval(() => pollUnifiedPhase1(), 2000);
  } catch(e) {
    progressLabel.textContent = '서버 오류: ' + e.message;
    btn.disabled = false;
    progressWrap.style.display = 'none';
  }
}

async function pollUnifiedPhase1() {
  try {
    const r = await fetch('/api/scan/status');
    const d = await r.json();
    const pct = d.total > 0 ? Math.round(d.current / d.total * 100) : 0;
    document.getElementById('progressFill').style.width = `${Math.round(pct * 0.5)}%`; // 전체 진행의 50%
    document.getElementById('progressCount').textContent = `${d.current} / ${d.total}`;
    document.getElementById('progressLabel').textContent = `[1/3] 포지션 체크 + 신호 분석 중... (${pct}%)`;

    if (d.status === 'done' || d.status === 'error') {
      clearInterval(_scanPollTimer);
      if (d.status === 'done') {
        // 상태 새로 로드
        const sr = await fetch('/api/state').then(r => r.json()).catch(() => null);
        if (sr) { STATE = sr; renderAll(); }
        const rr = await fetch('/api/scan/results').then(r => r.json()).catch(() => null);
        if (rr && rr.ok) showScanToast(rr.results, new Date().toISOString().split('T')[0]);

        // PHASE 2: Top 30 랭킹 시작
        startUnifiedPhase2();
      } else {
        document.getElementById('progressWrap').style.display = 'none';
        document.getElementById('scanBtn').disabled = false;
        document.getElementById('scanStatus').textContent = '스캔 오류: ' + d.error;
      }
    }
  } catch(e) {}
}

async function startUnifiedPhase2() {
  _unifiedScanPhase = 'ranking';
  document.getElementById('progressLabel').textContent = '[2/3] Top 30 랭킹 산출 중...';

  try {
    const r = await fetch('/api/ranking/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ priceMin: _scanPriceMin, priceMax: _scanPriceMax })
    });
    const d = await r.json();
    if (!d.ok) {
      document.getElementById('progressLabel').textContent = '랭킹 시작 실패: ' + d.error;
      finishUnifiedScan();
      return;
    }
    _rankPollTimer = setInterval(() => pollUnifiedPhase2(), 3000);
  } catch(e) {
    document.getElementById('progressLabel').textContent = '랭킹 오류: ' + e.message;
    finishUnifiedScan();
  }
}

async function pollUnifiedPhase2() {
  try {
    const r = await fetch('/api/ranking/status');
    const d = await r.json();
    const pct = d.total > 0 ? Math.round(d.current / d.total * 100) : 0;
    document.getElementById('progressFill').style.width = `${50 + Math.round(pct * 0.4)}%`; // 50~90%
    document.getElementById('progressCount').textContent = `${d.current} / ${d.total}`;
    document.getElementById('progressLabel').textContent = `[2/3] Top 30 랭킹 산출 중... (${pct}%)`;

    if (d.status === 'done' || d.status === 'error') {
      clearInterval(_rankPollTimer);
      if (d.status === 'done') {
        // 랭킹 결과 로드 후 → 자동 대기 주문 생성
        await loadRankingResult();
        await createOrdersFromTop30();
      }
      finishUnifiedScan();
    }
  } catch(e) {}
}

// PHASE 3: Top 30에서 investable 종목을 대기 주문으로 생성
async function createOrdersFromTop30() {
  document.getElementById('progressLabel').textContent = '[3/3] Top 30 → 대기 주문 생성 중...';
  document.getElementById('progressFill').style.width = '95%';

  const rankings = _lastRankingResult || [];
  const top30 = rankings.slice(0, 30);
  const investable = top30.filter(r => r.investable);

  if (!investable.length) {
    document.getElementById('scanStatus').textContent = 'Top 30 중 투자 적합 종목 없음';
    return;
  }

  let created = 0;
  for (const stock of investable) {
    // 이미 해당 종목에 활성 포지션이 있으면 스킵
    const hasActive = STATE.positions.some(p => p.code === stock.code);
    if (hasActive) continue;

    // 쿨다운 체크
    const lastTrade = [...(STATE.trades||[])].reverse().find(t => t.code === stock.code);
    const profileName = stock.profileName || 'default';
    const profile = STOCK_PROFILES[profileName] || STOCK_PROFILES.default;
    const baseCooldown = STATE.stockParams[stock.code]?.cd || profile.cooldown;
    const today = new Date().toISOString().split('T')[0];
    const daysSinceLast = lastTrade ? daysDiff(lastTrade.exitDate, today) : 999;
    if (daysSinceLast < baseCooldown) continue;

    // OHLCV 로드 → 진입가/목표가/손절가 계산
    try {
      const resp = await fetch(`/api/kis-ohlcv/${stock.code}`);
      const json = await resp.json();
      if (!json.ok || !json.data || json.data.length < 62) continue;
      const data = json.data;
      calcIndicatorsV2(data);
      const idx = data.length - 1;
      const row = data[idx];
      const customTp = STATE.stockParams[stock.code]?.tp || profile.take_profit;
      const customSl = STATE.stockParams[stock.code]?.sl || profile.stop_loss;
      const { pendingLimit, tpLevel, kijunForSL, atrForSL } = calcDynamicPrices(data, idx, customTp, customSl);
      const limitPrice = pendingLimit || row.close;

      // 진입사유: 차트 기반 + Top30 추천사유 통합
      const baseReason = getEntryReason(pendingLimit, row);
      const entryReason = stock.reason
        ? `${baseReason} | ${stock.reason}`
        : baseReason;

      // 목표가/손절가를 대기주문 생성 시점에 미리 계산
      const targetPrice = calcTargetPrice(limitPrice, tpLevel, customTp);
      const stopPrice = calcStopPrice(limitPrice, kijunForSL, customSl, atrForSL);
      const tpReason = getTpReason(tpLevel, limitPrice, customTp, data, idx);
      const slReason = getSlReason(stopPrice, limitPrice, kijunForSL, customSl, atrForSL);

      STATE.positions.push({
        id: `${Date.now()}_${stock.code}`, code: stock.code, name: stock.name,
        status: 'PENDING', signalDate: today,
        signalScore: Math.round(stock.composite * 10) / 10,
        limitPrice, entryReason, tpLevel, quantity: 1,
        entryPrice: null, entryDate: null,
        targetPrice, stopPrice, tpReason, slReason,
        tp: customTp, sl: customSl,
        profileName, cooldownDays: baseCooldown, timeoutDays: 0, daysHeld: 0,
        fromTop30: true, investReason: stock.reason,
      });
      created++;
    } catch(e) { /* 개별 오류 무시 */ }
  }

  if (created > 0) {
    await saveState();
    renderAll();
    document.getElementById('scanStatus').textContent =
      `Top 30 중 ${investable.length}개 투자적합, ${created}개 대기 주문 생성`;
  }
}

function finishUnifiedScan() {
  _unifiedScanPhase = 'done';
  document.getElementById('progressFill').style.width = '100%';
  setTimeout(() => {
    document.getElementById('progressWrap').style.display = 'none';
    document.getElementById('scanBtn').disabled = false;
  }, 500);
}

function updateCircuitBadge() {
  const badge = document.getElementById('circuitBadge');
  if (_circuitBreaker && _circuitBreaker.isTriggered()) {
    badge.style.display = 'inline-block';
    badge.textContent = `${_circuitBreaker.consecLosses}연패 +15일 쿨다운`;
  } else {
    badge.style.display = 'none';
  }
}

function showScanToast(results, date) {
  const toast = document.getElementById('scanToast');
  const newOrders = results.filter(r => r.action === 'NEW_ORDER');
  const filled = results.filter(r => r.action === 'FILLED');
  const wins = results.filter(r => r.action === 'TARGET');
  const stops = results.filter(r => r.action === 'STOP');
  const cancelled = results.filter(r => r.action === 'CANCELLED');
  const parts = [];
  if (newOrders.length) parts.push(`<span style="color:#f5c842">신규 ${newOrders.length}개</span> (${newOrders.map(r=>r.name).join(', ')})`);
  if (filled.length) parts.push(`<span style="color:#4a9eff">체결 ${filled.length}개</span>`);
  if (wins.length) parts.push(`<span style="color:#4caf50">익절 ${wins.length}개</span>`);
  if (stops.length) parts.push(`<span style="color:#ef5350">손절 ${stops.length}개</span>`);
  if (cancelled.length) parts.push(`취소 ${cancelled.length}개`);
  // 기존 PENDING/포지션 현황 포함
  const pendCount = (STATE.positions||[]).filter(p=>p.status==='PENDING').length;
  const posCount = (STATE.positions||[]).filter(p=>p.status==='IN_POSITION').length;
  const statusParts = [];
  if (pendCount) statusParts.push(`대기 ${pendCount}건`);
  if (posCount) statusParts.push(`보유 ${posCount}건`);
  if (!parts.length) {
    parts.push(statusParts.length
      ? `<span style="color:#5A5450">신규 없음</span> (${statusParts.join(', ')} 유지중)`
      : '<span style="color:#5A5450">신호 없음</span>');
  } else if (statusParts.length) {
    parts.push(statusParts.join(', '));
  }
  toast.innerHTML = `<strong style="color:#7A7470;">${date} 스캔 완료 &middot;</strong> ${parts.join(' | ')}`;
  toast.style.display = 'block';
}

// ═══════════════════════════════════════════════════════════════
// 유틸
// ═══════════════════════════════════════════════════════════════
function daysDiff(from, to) { return Math.max(0, Math.floor((new Date(to) - new Date(from)) / 86400000)); }
function fmtPct(v, d=2) { if(v==null)return'\u2013'; const s=(v>=0?'+':'')+v.toFixed(d)+'%'; return `<span class="${v>=0?'pos-up':'pos-dn'}">${s}</span>`; }
function fmtAmt(v) { if(v==null)return'\u2013'; const s=(v>=0?'+':'')+v.toLocaleString()+'원'; return `<span class="${v>=0?'pos-up':'pos-dn'}">${s}</span>`; }
function reasonBadge(r) { if(r==='TARGET')return'<span class="badge badge-win">익절</span>'; if(r==='STOP')return'<span class="badge badge-loss">손절</span>'; if(r==='TIMEOUT')return'<span class="badge badge-timeout">만기</span>'; return r; }

// ═══════════════════════════════════════════════════════════════
// 렌더링
// ═══════════════════════════════════════════════════════════════
function renderAll() { if(!STATE)return; renderPortfolioBar(); renderPositions(); renderPending(); renderOrderLog(); renderHistory(); renderStats(); }

function renderPortfolioBar() {
  const trades = STATE.trades || [];
  const closed = trades.filter(t => t.pnlAmt != null);
  const totalPnl = closed.reduce((s, t) => s + t.pnlAmt, 0);
  const wins = closed.filter(t => t.pnlPct > 0);
  const wr = closed.length ? Math.round(wins.length / closed.length * 100) : null;
  const avgRet = closed.length ? closed.reduce((s,t)=>s+t.pnlPct,0)/closed.length : null;
  const inPosList = (STATE.positions||[]).filter(p=>p.status==='IN_POSITION');
  const pendList = (STATE.positions||[]).filter(p=>p.status==='PENDING');
  const invested = inPosList.reduce((s, p) => s + (p.entryPrice || 0), 0);
  const period = STATE.startDate ? daysDiff(STATE.startDate, new Date().toISOString().split('T')[0]) + '일차' : '\u2013';
  document.getElementById('pPeriod').innerHTML = period;
  document.getElementById('pStartDate').textContent = STATE.startDate ? `${STATE.startDate} 시작` : '스캔 후 시작';
  document.getElementById('pInvested').textContent = invested ? invested.toLocaleString()+'원' : '\u2013';
  document.getElementById('pOpen').textContent = `포지션 ${inPosList.length}개 · 대기 ${pendList.length}개`;
  document.getElementById('pPnl').innerHTML = fmtAmt(totalPnl===0&&!closed.length ? null : totalPnl);
  document.getElementById('pPnlPct').textContent = closed.length ? `완료 ${closed.length}건 기준` : '';
  document.getElementById('pTrades').textContent = closed.length;
  document.getElementById('pWinRate').innerHTML = wr!=null ? fmtPct(wr,0) : '\u2013';
  document.getElementById('pWinCount').textContent = wr!=null ? `${wins.length}승 ${closed.length-wins.length}패` : '';
  document.getElementById('pAvgRet').innerHTML = avgRet!=null ? fmtPct(avgRet) : '\u2013';
  document.getElementById('pPnlPct2').textContent = closed.length ? `완료 ${closed.length}건 기준` : '';
  document.getElementById('pLastScan').textContent = STATE.lastScan || '스캔 전';

  // OHLCV 캐시 상태
  fetch('/api/cache-status').then(r=>r.json()).then(d => {
    const el = document.getElementById('pOhlcvStatus');
    const sub = document.getElementById('pOhlcvSub');
    if (!el) return;
    if (d.ok && d.count > 0) {
      const age = d.newestAgeMin;
      let ageStr;
      if (age < 60) ageStr = `${age}분 전`;
      else if (age < 1440) ageStr = `${Math.floor(age/60)}시간 전`;
      else ageStr = `${Math.floor(age/1440)}일 전`;
      const fresh = age < 720; // 12시간 이내면 최신
      el.textContent = `${d.count}개`;
      el.style.color = fresh ? '#4caf50' : '#ff9800';
      sub.textContent = `최신: ${ageStr}`;
    } else {
      el.textContent = '없음';
      el.style.color = '#ef5350';
      sub.textContent = '스캔 시 자동 생성';
    }
  }).catch(()=>{});
}

function renderPositions() {
  const tbody = document.getElementById('posTbody');
  const items = (STATE.positions||[]).filter(p=>p.status==='IN_POSITION');
  document.getElementById('tabBadgePos').textContent = items.length ? `(${items.length})` : '';
  if (!items.length) { tbody.innerHTML = `<tr><td colspan="10"><div class="empty">보유 포지션 없음</div></td></tr>`; return; }
  tbody.innerHTML = items.map(p => {
    const live = _livePrices[p.code];
    const curPrice = live ? live.price : null;
    const pnlPct = curPrice ? ((curPrice / p.entryPrice - 1) * 100) : null;
    const pnlCls = pnlPct!=null ? (pnlPct>=0?'pos-up':'pos-dn') : '';
    return `<tr>
      <td style="cursor:pointer" onclick="openStockDetail('${p.code}','${p.name.replace(/'/g,"\\'")}',{targetPrice:${p.targetPrice||0},stopPrice:${p.stopPrice||0},limitPrice:${p.entryPrice||0}})"><strong style="border-bottom:1px dashed #5A5450">${p.name}</strong><br><span style="font-size:11px;color:#5A5450">${p.code}</span></td>
      <td><span class="badge-profile">${p.profileName||'default'}</span></td>
      <td style="color:#7A7470;font-size:12px">${p.entryDate}</td>
      <td>${p.entryPrice.toLocaleString()}원</td>
      <td class="${pnlCls}" style="font-weight:600">${curPrice ? curPrice.toLocaleString()+'원' : '<span style="color:#5A5450">-</span>'}</td>
      <td class="${pnlCls}">${pnlPct!=null ? (pnlPct>=0?'+':'')+pnlPct.toFixed(2)+'%' : '-'}</td>
      <td><span class="tip-wrap" style="color:#4caf50;cursor:help">${p.targetPrice?.toLocaleString()}원
        <div class="tip-box"><div class="tip-title">목표가 (TP)</div>${p.tpReason||'고정%'}<br><span class="tip-price">${p.targetPrice?.toLocaleString()}원</span></div>
      </span></td>
      <td><span class="tip-wrap" style="color:#ef5350;cursor:help">${p.stopPrice?.toLocaleString()}원
        <div class="tip-box"><div class="tip-title">손절가 (SL)</div>${p.slReason||'고정%'}<br><span class="tip-price" style="color:#ef5350">${p.stopPrice?.toLocaleString()}원</span></div>
      </span></td>
      <td>${p.daysHeld||0}일</td>
      <td><button onclick="deletePositionById('${p.id}')" style="background:none;border:none;color:#ef5350;cursor:pointer;font-size:16px;padding:4px 8px;" title="이 포지션 강제 삭제">&times;</button></td>
    </tr>`;
  }).join('');
}

let _pendingSortKey = null; // 'tp' | null
let _pendingSortAsc = true;
function togglePendingSort(key) {
  if (_pendingSortKey === key) _pendingSortAsc = !_pendingSortAsc;
  else { _pendingSortKey = key; _pendingSortAsc = true; }
  renderPending();
}

function renderPending() {
  const tbody = document.getElementById('pendTbody');
  const items = (STATE.positions||[]).filter(p=>p.status==='PENDING');
  document.getElementById('tabBadgePend').textContent = items.length ? `(${items.length})` : '';
  if (!items.length) { tbody.innerHTML = `<tr><td colspan="10"><div class="empty">대기 주문 없음</div></td></tr>`; return; }

  // 정렬
  if (_pendingSortKey === 'tp') {
    items.sort((a, b) => {
      const aPct = a.targetPrice && a.limitPrice ? a.targetPrice / a.limitPrice : 0;
      const bPct = b.targetPrice && b.limitPrice ? b.targetPrice / b.limitPrice : 0;
      return _pendingSortAsc ? aPct - bPct : bPct - aPct;
    });
  }

  // 목표가 헤더 정렬 아이콘 업데이트
  const thTp = document.getElementById('thPendTp');
  if (thTp) {
    const sortSpan = thTp.querySelector('.sort-arrow');
    const arrow = _pendingSortKey === 'tp' ? (_pendingSortAsc ? ' ▲' : ' ▼') : '';
    if (sortSpan) sortSpan.textContent = arrow;
    else if (arrow) { const s = document.createElement('span'); s.className='sort-arrow'; s.style.color='#E07151'; s.textContent=arrow; thTp.insertBefore(s, thTp.querySelector('.help-tip')); }
  }

  const today = new Date().toISOString().split('T')[0];
  tbody.innerHTML = items.map(p => {
    const waitDays = daysDiff(p.signalDate, today);
    // TP/SL: 실제 가격이 있으면 원 단위, 없으면 % 표시
    const tpDisplay = p.targetPrice
      ? `${Math.round(p.targetPrice).toLocaleString()}원`
      : `+${Math.round(p.tp*100)}%`;
    const slDisplay = p.stopPrice
      ? `${Math.round(p.stopPrice).toLocaleString()}원`
      : `-${Math.round(p.sl*100)}%`;
    const tpPct = p.targetPrice && p.limitPrice
      ? ` (+${((p.targetPrice/p.limitPrice-1)*100).toFixed(1)}%)`
      : '';
    const slPct = p.stopPrice && p.limitPrice
      ? ` (-${((1-p.stopPrice/p.limitPrice)*100).toFixed(1)}%)`
      : '';
    return `<tr>
      <td style="cursor:pointer" onclick="openStockDetail('${p.code}','${p.name.replace(/'/g,"\\'")}',{targetPrice:${p.targetPrice||0},stopPrice:${p.stopPrice||0},limitPrice:${p.limitPrice||0}})"><strong style="border-bottom:1px dashed #5A5450">${p.name}</strong><br><span style="font-size:11px;color:#5A5450">${p.code}</span>${p.fromTop30 ? '<br><span style="font-size:10px;color:#f5c842;">Top30</span>' : ''}</td>
      <td><span class="badge-profile">${p.profileName||'default'}</span></td>
      <td style="color:#7A7470;font-size:12px">${p.signalDate}</td>
      <td><span class="badge badge-pending">${p.signalScore}점</span></td>
      <td style="color:#f5c842;font-weight:600">${p.limitPrice?.toLocaleString()}원</td>
      <td><span class="tip-wrap" style="font-size:11px;color:#5A8A70;max-width:160px;display:inline-block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle;">${p.entryReason||''}
        <div class="tip-box"><div class="tip-title">진입사유</div>${(p.entryReason||'').replace(/\|/g, '<br>')}</div>
      </span></td>
      <td style="color:#7A7470">${waitDays}일째</td>
      <td><span class="tip-wrap" style="color:#4caf50;cursor:help">${tpDisplay}<span style="font-size:10px;color:#7A7470">${tpPct}</span>
        <div class="tip-box"><div class="tip-title">목표가 (TP)</div>${p.tpReason||'고정%'}<br><span class="tip-price" style="color:#4caf50">${tpDisplay}</span></div>
      </span></td>
      <td><span class="tip-wrap" style="color:#ef5350;cursor:help">${slDisplay}<span style="font-size:10px;color:#7A7470">${slPct}</span>
        <div class="tip-box"><div class="tip-title">손절가 (SL)</div>${p.slReason||'고정%'}<br><span class="tip-price" style="color:#ef5350">${slDisplay}</span></div>
      </span></td>
      <td><button onclick="deletePendingById('${p.id}')" style="background:none;border:none;color:#ef5350;cursor:pointer;font-size:16px;padding:4px 8px;" title="이 대기 주문 삭제">&times;</button></td>
    </tr>`;
  }).join('');
}

function renderOrderLog() {
  const tbody = document.getElementById('orderLogTbody');
  const allEvents = [];
  for (const log of (STATE.scanLog||[])) { for (const r of (log.results||[])) allEvents.push({date:log.date,...r}); }
  allEvents.reverse();
  document.getElementById('tabBadgeLog').textContent = allEvents.length ? `(${allEvents.length})` : '';
  if (!allEvents.length) { tbody.innerHTML = `<tr><td colspan="6"><div class="empty">체결 내역 없음</div></td></tr>`; return; }
  tbody.innerHTML = allEvents.slice(0,100).map(e => {
    let evBadge='', price='\u2013', pnlStr='\u2013';
    if (e.action==='NEW_ORDER') { evBadge=`<span class="badge badge-pending">신호 ${e.score}점</span>`; price=e.limitPrice?e.limitPrice.toLocaleString()+'원 (지정)':'\u2013'; }
    else if (e.action==='FILLED') { evBadge='<span class="badge badge-hold">체결</span>'; price=e.price?e.price.toLocaleString()+'원':'\u2013'; }
    else if (e.action==='TARGET') { evBadge='<span class="badge badge-win">익절</span>'; price=e.exitPrice?e.exitPrice.toLocaleString()+'원':'\u2013'; pnlStr=e.pnlPct!=null?`<span class="pos-up">+${e.pnlPct}%</span>`:'\u2013'; }
    else if (e.action==='STOP') { evBadge='<span class="badge badge-loss">손절</span>'; price=e.exitPrice?e.exitPrice.toLocaleString()+'원':'\u2013'; pnlStr=e.pnlPct!=null?`<span class="pos-dn">${e.pnlPct}%</span>`:'\u2013'; }
    else if (e.action==='TIMEOUT') { evBadge='<span class="badge badge-timeout">만기</span>'; price=e.exitPrice?e.exitPrice.toLocaleString()+'원':'\u2013'; pnlStr=e.pnlPct!=null?fmtPct(e.pnlPct):'\u2013'; }
    else if (e.action==='CANCELLED') { evBadge='<span class="badge" style="background:rgba(100,100,100,.12);color:#666;border:1px solid #333">취소</span>'; }
    return `<tr><td style="color:#7A7470;font-size:12px">${e.date}</td><td><strong>${e.name}</strong><br><span style="font-size:11px;color:#5A5450">${e.code}</span></td><td>${evBadge}</td><td>${price}</td><td style="color:#4a9eff;font-weight:600">1주</td><td>${pnlStr}</td></tr>`;
  }).join('');
}

function renderHistory() {
  const tbody = document.getElementById('histTbody');
  const items = [...(STATE.trades||[])].reverse();
  if (!items.length) { tbody.innerHTML = `<tr><td colspan="8"><div class="empty">거래 내역 없음</div></td></tr>`; return; }
  tbody.innerHTML = items.map(t => {
    const aiBtn = t.exitReason==='STOP' ? `<button class="btn btn-outline btn-sm" style="font-size:11px;padding:3px 8px;margin-top:4px;color:#90C8FF;border-color:#2A3550;" onclick="analyzeStopLoss(${JSON.stringify(t).replace(/"/g,'&quot;')},null)">AI 분석</button>` : '';
    return `<tr>
      <td><strong>${t.name}</strong><br><span style="font-size:11px;color:#5A5450">${t.code}</span>${aiBtn?'<br>'+aiBtn:''}</td>
      <td>${reasonBadge(t.exitReason)}</td>
      <td style="color:#7A7470;font-size:12px">${t.entryDate}</td>
      <td style="color:#7A7470;font-size:12px">${t.exitDate}</td>
      <td>${t.entryPrice.toLocaleString()}원</td>
      <td>${t.exitPrice.toLocaleString()}원</td>
      <td class="pos-value">${fmtPct(t.pnlPct)}</td>
      <td class="pos-value">${fmtAmt(t.pnlAmt)}</td>
    </tr>`;
  }).join('');
}

function renderStats() {
  const closed = (STATE.trades||[]).filter(t=>t.pnlAmt!=null);
  if (!closed.length) { document.getElementById('statsGrid').innerHTML = '<div class="stat-box" style="grid-column:1/-1"><div class="s-lbl">아직 완료 거래 없음</div></div>'; return; }
  const wins=closed.filter(t=>t.pnlPct>0), losses=closed.filter(t=>t.pnlPct<=0);
  const totalPnl=closed.reduce((s,t)=>s+t.pnlAmt,0);
  const wr=wins.length/closed.length*100;
  const avgRet=closed.reduce((s,t)=>s+t.pnlPct,0)/closed.length;
  const avgWin=wins.length?wins.reduce((s,t)=>s+t.pnlPct,0)/wins.length:0;
  const avgLoss=losses.length?losses.reduce((s,t)=>s+t.pnlPct,0)/losses.length:0;
  const ev=wr/100*avgWin+(1-wr/100)*avgLoss;
  let peak=0,cumPnl=0,maxDD=0;
  for(const t of closed){cumPnl+=t.pnlAmt||0;if(cumPnl>peak)peak=cumPnl;const dd=peak>0?(peak-cumPnl)/peak*100:0;if(dd>maxDD)maxDD=dd;}
  const byR={TARGET:0,STOP:0,TIMEOUT:0}; closed.forEach(t=>{if(byR[t.exitReason]!=null)byR[t.exitReason]++;});
  document.getElementById('statsGrid').innerHTML = [
    {l:'총 손익',v:fmtAmt(totalPnl),s:`${closed.length}건 완료`,tip:'모든 완료 거래의 합산 실현 손익'},
    {l:'승률',v:fmtPct(wr,1),s:`${wins.length}승 ${losses.length}패`,tip:'수익 거래 ÷ 전체 거래 × 100<br>50% 이상이면 양호'},
    {l:'기대값 (EV)',v:fmtPct(ev),s:'1거래당 기대 수익률',tip:'1회 거래 시 기대할 수 있는 평균 수익률<br>= 승률×평균이익 - 패률×평균손실<br>양수면 장기적으로 수익'},
    {l:'평균 수익률',v:fmtPct(avgRet),s:`평균 승 ${fmtPct(avgWin)} / 패 ${fmtPct(avgLoss)}`,tip:'전체 거래의 평균 수익률 (%)<br>승리/패배 거래 각각의 평균도 표시'},
    {l:'최대 낙폭(MDD)',v:`<span class="pos-dn">${maxDD.toFixed(2)}%</span>`,s:'누적 손익 기준',tip:'최고점 대비 최대 하락 비율<br>낮을수록 안정적인 전략<br>10% 이하면 양호'},
    {l:'청산 분포',v:'',s:`익절 ${byR.TARGET} · 손절 ${byR.STOP} · 만기 ${byR.TIMEOUT}`,tip:'매도 사유별 분포<br>익절=목표가 도달<br>손절=손절가 이탈<br>만기=보유기간 초과'},
  ].map(({l,v,s,tip})=>`<div class="stat-box"><div class="s-lbl">${l}<span class="help-tip">?<span class="ht-text">${tip}</span></span></div><div class="s-val">${v}</div><div class="s-sub">${s}</div></div>`).join('');
  drawCurve(closed);
}

function drawCurve(trades) {
  const canvas=document.getElementById('tradeCurve'); if(!canvas||!trades.length)return;
  const ctx=canvas.getContext('2d');
  canvas.width=canvas.offsetWidth*devicePixelRatio; canvas.height=canvas.offsetHeight*devicePixelRatio;
  ctx.scale(devicePixelRatio,devicePixelRatio);
  const w=canvas.offsetWidth,h=canvas.offsetHeight;
  const points=[0,...trades.map((_,i)=>trades.slice(0,i+1).reduce((s,t)=>s+(t.pnlAmt||0),0))];
  const minV=Math.min(...points),maxV=Math.max(...points,0.01),range=maxV-minV||1;
  const px=i=>40+(i/(points.length-1))*(w-60), py=v=>h-20-((v-minV)/range)*(h-40);
  ctx.clearRect(0,0,w,h);
  ctx.strokeStyle='#252320';ctx.lineWidth=1;
  [0.25,0.5,0.75].forEach(t=>{const y=py(minV+range*t);ctx.beginPath();ctx.moveTo(40,y);ctx.lineTo(w-10,y);ctx.stroke();});
  ctx.strokeStyle=points[points.length-1]>=0?'#4caf50':'#ef5350';ctx.lineWidth=2;
  ctx.beginPath();points.forEach((v,i)=>{i===0?ctx.moveTo(px(i),py(v)):ctx.lineTo(px(i),py(v));});ctx.stroke();
  ctx.fillStyle=ctx.strokeStyle+'30';ctx.lineTo(px(points.length-1),py(minV));ctx.lineTo(px(0),py(minV));ctx.closePath();ctx.fill();
  ctx.fillStyle='#5A5450';ctx.font='10px sans-serif';ctx.textAlign='right';
  ctx.fillText(maxV.toLocaleString()+'원',36,py(maxV)+4);ctx.fillText(minV.toLocaleString()+'원',36,py(minV)+4);
  const zeroY=py(0);ctx.strokeStyle='#3A3733';ctx.lineWidth=1;ctx.setLineDash([4,4]);
  ctx.beginPath();ctx.moveTo(40,zeroY);ctx.lineTo(w-10,zeroY);ctx.stroke();ctx.setLineDash([]);
}

// ═══════════════════════════════════════════════════════════════
// 탭 전환
// ═══════════════════════════════════════════════════════════════
function switchTab(name) {
  ['positions','pending','orderlog','history','stats','backtest','top30','stoploss','account'].forEach(t=>{
    const el = document.getElementById(`tab-${t}`);
    if (el) el.style.display = t===name ? 'block' : 'none';
  });
  document.querySelectorAll('.tab').forEach((el,i)=>{
    el.classList.toggle('active',['positions','pending','orderlog','history','stats','backtest','top30','stoploss','account'][i]===name);
  });
  if (name==='stoploss') renderStopLossTab();
  if (name==='stats') drawCurve(STATE?.trades?.filter(t=>t.pnlAmt!=null)||[]);
}

// ═══════════════════════════════════════════════════════════════
// AI 손절 분석
// ═══════════════════════════════════════════════════════════════
let _aiAnalysisCache = {};
let _aiCurrentTrade = null;
function openAiModal() { document.getElementById('aiModalBackdrop').classList.add('open'); }
function closeAiModal() { document.getElementById('aiModalBackdrop').classList.remove('open'); }

async function analyzeStopLoss(trade, ohlcv) {
  _aiCurrentTrade = trade;
  document.getElementById('aiModalTitle').textContent = ` ${trade.name}`;
  document.getElementById('aiAppliedMsg').textContent = '';
  document.getElementById('aiSuggestions').innerHTML = '';
  document.getElementById('aiTradeInfo').innerHTML = `
    <div class="ti-lbl">종목</div><div class="ti-val">${trade.name} (${trade.code})</div>
    <div class="ti-lbl">진입 / 청산</div><div class="ti-val">${trade.entryDate} &rarr; ${trade.exitDate}</div>
    <div class="ti-lbl">진입가 / 손절가</div><div class="ti-val">${trade.entryPrice?.toLocaleString()} / ${trade.exitPrice?.toLocaleString()}</div>
    <div class="ti-lbl">손실 / 보유</div><div class="ti-val pos-dn">${trade.pnlPct}% / ${trade.daysHeld||'?'}일</div>`;
  openAiModal();
  const cacheKey = trade.id || trade.code+trade.exitDate;
  if (_aiAnalysisCache[cacheKey]) { renderAiResult(_aiAnalysisCache[cacheKey]); return; }
  document.getElementById('aiContent').innerHTML = '<div class="ai-loading">Claude AI가 손절 원인을 분석 중...<div class="ai-spinner"></div></div>';
  try {
    const resp = await fetch('/api/analyze-stop',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({trade,recentOhlcv:ohlcv||[]})});
    const data = await resp.json();
    if (!resp.ok||data.error) throw new Error(data.error||'서버 오류');
    _aiAnalysisCache[cacheKey] = data.analysis;
    renderAiResult(data.analysis);
  } catch(e) { document.getElementById('aiContent').innerHTML = `<div style="color:#ef5350">분석 실패: ${e.message}</div>`; }
}

function renderAiResult(text) {
  const html = text.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>');
  document.getElementById('aiContent').innerHTML = `<div class="ai-analysis-text">${html}</div>`;
  const paramRegex = /(\d+\.\s*\[([^\]]+)\])[^\n]*\n([^\n]*)\n.*?파라미터[:\s]*(\{[^}]+\})/gis;
  const suggestions = []; let m;
  while ((m=paramRegex.exec(text))!==null) suggestions.push({title:m[2].trim(),desc:m[3].trim(),paramStr:m[4].trim()});
  if (!suggestions.length) return;
  const container = document.getElementById('aiSuggestions');
  container.innerHTML = '<div style="font-size:11px;color:#7A7470;margin-bottom:8px;">아래 개선안을 클릭하면 설정에 바로 적용됩니다</div>';
  suggestions.forEach((s,i)=>{
    let parsed={}; try{parsed=JSON.parse(s.paramStr);}catch(_){}
    const btn=document.createElement('button'); btn.className='ai-suggestion-btn';
    btn.innerHTML=`<div class="s-title">${i+1}. ${s.title}</div><div class="s-desc">${s.desc}</div><div class="s-param">적용: ${s.paramStr}</div>`;
    btn.onclick=()=>applyAiSuggestion(parsed,s.title,btn); container.appendChild(btn);
  });
}

async function applyAiSuggestion(params, title, btn) {
  if (params.threshold!=null) { CONFIG.threshold=parseFloat(params.threshold); document.getElementById('cfgThreshold').value=CONFIG.threshold; }
  if (params.tp!=null&&_aiCurrentTrade) STATE.stockParams[_aiCurrentTrade.code]={...STATE.stockParams[_aiCurrentTrade.code],tp:parseFloat(params.tp)};
  if (params.sl!=null&&_aiCurrentTrade) STATE.stockParams[_aiCurrentTrade.code]={...STATE.stockParams[_aiCurrentTrade.code],sl:parseFloat(params.sl)};
  if (params.cooldown!=null&&_aiCurrentTrade) STATE.stockParams[_aiCurrentTrade.code]={...STATE.stockParams[_aiCurrentTrade.code],cd:parseInt(params.cooldown)};
  await Promise.all([
    fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(CONFIG)}),
    fetch('/api/state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(STATE)})
  ]);
  btn.style.borderColor='#4caf50'; btn.style.background='rgba(76,175,80,.1)';
  document.getElementById('aiAppliedMsg').textContent = `"${title}" 적용 완료`;
}

async function triggerStopAnalysis(items) { if(items.length) analyzeStopLoss(items[0].trade, items[0].ohlcv); }

// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
// 백테스트 (V2 로직 — 원본 앱 구조 완전 이식)
// ═══════════════════════════════════════════════════════════════
let _btStockCache = [];
let _btSelected = null;
let _btRunning = false;
let _btTradesOpen = false;
let _btMode = 'auto';
let _btChart = null, _btVolChart = null;
let _btCandleSeries = null, _btVolSeries = null;
let _btMA5 = null, _btMA20 = null, _btMA60 = null;
let _btAllTrades = [], _btAllData = null, _btByStock = {};
let _btSelectedTradeIdx = -1;

async function btEnsureStockList() {
  if (_btStockCache.length) return;
  try { const r=await fetch('/api/kis-stocks');const d=await r.json();if(d.ok&&d.stocks?.length)_btStockCache=d.stocks; } catch(e) {}
}

let _btSearchTimer=null;
function btSearchFilter() {
  const q=document.getElementById('btSearchInput').value.trim().toLowerCase();
  const sug=document.getElementById('btSuggestions');
  if(!q){sug.style.display='none';return;}

  // 로컬 캐시에서 즉시 결과 (빠른 응답)
  const list = _btStockCache.length ? _btStockCache : _stockListCache;
  const localMatches=list.filter(s=>s.name.toLowerCase().includes(q)||s.code.includes(q)).slice(0,15);
  if(localMatches.length){
    btRenderSearchResults(localMatches);
  }

  // KIS API 실시간 검색 (항상 실행, 디바운스 300ms)
  if(q.length>=2){
    clearTimeout(_btSearchTimer);
    _btSearchTimer=setTimeout(()=>{
      fetch(`/api/kis-search?q=${encodeURIComponent(q)}`).then(r=>r.json()).then(d=>{
        if(!d.ok||!d.results?.length)return;
        // 로컬 결과와 API 결과 병합 (중복 제거)
        const existingCodes=new Set(localMatches.map(s=>s.code));
        const apiResults=d.results.filter(s=>!existingCodes.has(s.code));
        const merged=[...localMatches,...apiResults].slice(0,20);
        btRenderSearchResults(merged);
      }).catch(()=>{});
    },300);
  }

  if(!localMatches.length&&q.length<2){sug.style.display='none';}
}
function btRenderSearchResults(matches){
  const sug=document.getElementById('btSuggestions');
  if(!matches.length){sug.style.display='none';return;}
  sug.innerHTML=matches.map(s=>`<div onclick="btSelectStock('${s.code}','${s.name.replace(/'/g,"\\'")}')" style="padding:8px 12px;cursor:pointer;border-bottom:1px solid #1A1918;font-size:13px;display:flex;justify-content:space-between;" onmouseenter="this.style.background='#2A2825'" onmouseleave="this.style.background=''"><div><strong>${s.name}</strong> <span style="color:#5A5450;font-size:11px;">${s.code}</span></div>${s.price?`<span style="font-size:12px;color:#C8C2BC;">${Number(s.price).toLocaleString()}원</span>`:''}</div>`).join('');
  sug.style.display='block';
}
function btSelectStock(code,name){
  _btSelected={code,name};
  document.getElementById('btSearchInput').value=name;
  document.getElementById('btSuggestions').style.display='none';
  document.getElementById('btSelectedLabel').textContent=`선택: ${name} (${code})`;
  // 자동 최적화 모드면 즉시 OHLCV 다운로드 + 그리드서치 실행
  if(_btMode==='auto') btAutoOptimizeStock(code,name);
}

async function btAutoOptimizeStock(code,name) {
  const banner = document.getElementById('btRecommendBanner');
  banner.style.display='block';
  banner.innerHTML=`<div style="color:#A070FF;font-weight:700;">자동 최적화 진행 중...</div><div style="font-size:12px;color:#7A7470;margin-top:4px;">📊 ${name}(${code}) OHLCV 다운로드 + 6개 파라미터 조합 탐색 중입니다. 잠시만 기다려주세요.</div>`;
  try {
    const r = await fetch(`/api/kis-ohlcv/${code}`);
    const j = await r.json();
    if(!j.ok||!j.data||j.data.length<100){
      banner.innerHTML=`<div style="color:#ef5350;">데이터 부족 — 최소 100일 이상의 데이터가 필요합니다.</div>`;
      return;
    }
    const data = j.data;
    calcIndicatorsV2(data);
    const detection = autoDetectProfile(data);
    banner.innerHTML=`<div style="color:#A070FF;font-weight:700;">그리드서치 실행 중...</div><div style="font-size:12px;color:#7A7470;margin-top:4px;">📊 변동성 ${(detection.volatility.avgATR*100).toFixed(2)}% → ${detection.isLargeCap?'대형 우량주':'중소형 성장주'} 판별 완료. 파라미터 조합 탐색 중...</div>`;
    // 그리드서치는 무거우므로 setTimeout으로 UI 업데이트 후 실행
    await new Promise(r=>setTimeout(r,30));
    const optResult = autoOptimize(data, detection.profileName, 60);
    if(optResult){
      applyBtBestStrategy(detection.profileName, optResult);
      showBtRecommendBanner(detection, optResult, data);
      // 신호 강도 카드도 즉시 표시
      if(data.length>=62){
        const params=btGetParams();
        showBtSignalCard(data, params);
      }
    } else {
      const prof = STOCK_PROFILES[detection.profileName]||STOCK_PROFILES.default;
      applyBtRecommendation(detection.profileName, prof.take_profit, prof.stop_loss, prof.cooldown, 30, 15, 3);
      showBtRecommendBanner(detection, null, data);
    }
  } catch(e) {
    banner.innerHTML=`<div style="color:#ef5350;">최적화 실패: ${e.message}</div>`;
    console.error('btAutoOptimize error:', e);
  }
}
function btSelectAll(){_btSelected=null;document.getElementById('btSearchInput').value='';document.getElementById('btSelectedLabel').textContent='KOSPI 전체';}
function toggleBtTrades(){_btTradesOpen=!_btTradesOpen;document.getElementById('btTradesWrap').style.display=_btTradesOpen?'block':'none';document.getElementById('btTradesToggle').textContent=_btTradesOpen?'접기':'펼치기';}

function btSetMode(mode) {
  _btMode = mode;
  document.getElementById('btModeManual').classList.toggle('active', mode==='manual');
  document.getElementById('btModeAuto').classList.toggle('active', mode==='auto');
  const ps = document.getElementById('btParamsSection');
  const ai = document.getElementById('btAutoInfo');
  if (mode==='auto') { ps.style.opacity='0.3'; ps.style.pointerEvents='none'; ai.style.display='block'; }
  else { ps.style.opacity='1'; ps.style.pointerEvents='auto'; ai.style.display='none'; }
}

btEnsureStockList();

// ═══════════════════════════════════════════════════════════════
// 자동 최적화 시스템 (원본 연구앱 autoOptimize 완전 포팅)
// ═══════════════════════════════════════════════════════════════

function analyzeVolatility(data) {
  const returns = [];
  for (let i = 1; i < data.length; i++) {
    returns.push(Math.abs(data[i].close - data[i-1].close) / data[i-1].close);
  }
  const avg = returns.reduce((a,b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a,r) => a + (r - avg)**2, 0) / returns.length;
  const stdDev = Math.sqrt(variance);
  const avgPrice = data.reduce((a,d) => a + d.close, 0) / data.length;
  let atrSum = 0, atrCount = 0;
  for (let i = 1; i < data.length; i++) {
    const tr = Math.max(data[i].high - data[i].low, Math.abs(data[i].high - data[i-1].close), Math.abs(data[i].low - data[i-1].close));
    atrSum += tr / data[i-1].close;
    atrCount++;
  }
  return { avgReturn: avg, stdDev, avgPrice, avgATR: atrSum / atrCount };
}

function autoDetectProfile(data) {
  const vol = analyzeVolatility(data);
  const isLargeCap = vol.avgATR < 0.025;
  return { profileName: isLargeCap ? 'large_cap' : 'default', isLargeCap, volatility: vol };
}

function btSummarize(trades) {
  const valid = trades.filter(t => typeof t.pnlPct === 'number' && isFinite(t.pnlPct));
  const wins = valid.filter(t => t.pnlPct > 0);
  const losses = valid.filter(t => t.pnlPct <= 0);
  const closed = valid.length;
  const winRate = closed ? wins.length / closed * 100 : 0;
  const avgReturn = closed ? valid.reduce((s,t) => s + t.pnlPct, 0) / closed : 0;
  let cumReturn = 1;
  for (const t of valid) cumReturn *= (1 + t.pnlPct / 100);
  cumReturn = (cumReturn - 1) * 100;
  return { closed, wins: wins.length, losses: losses.length, winRate, avgReturn, cumReturn };
}

function autoOptimize(data, profileName, startIdx) {
  const totalLen = data.length;
  const commRate = parseFloat(document.getElementById('btCommission')?.value || 0.015) / 100;
  const taxR = parseFloat(document.getElementById('btTax')?.value || 0.18) / 100;

  const WF_TEST_DAYS = 120;
  const MIN_REQUIRED = 90;
  if (totalLen < MIN_REQUIRED) return null;

  let testStart = Math.max(60, totalLen - WF_TEST_DAYS);
  let trainEnd = testStart;
  const trainStartIdx = 60;
  if (testStart >= totalLen || trainEnd <= trainStartIdx) return null;

  const vol = analyzeVolatility(data);
  const dailyVol = vol.avgATR * 100;

  let tpRange, slRange, volLabel;
  if (dailyVol < 1.5) {
    volLabel = '초저변동(일평균<1.5%)';
    tpRange = [0.02, 0.03, 0.04, 0.06, 0.08, 0.10];
    slRange = [0.03, 0.05, 0.07, 0.10];
  } else if (dailyVol < 2.5) {
    volLabel = '저변동(일평균<2.5%)';
    tpRange = [0.03, 0.04, 0.06, 0.08, 0.10, 0.13];
    slRange = [0.04, 0.06, 0.08, 0.10];
  } else if (dailyVol < 4.0) {
    volLabel = '중변동(일평균<4%)';
    tpRange = [0.04, 0.06, 0.08, 0.10, 0.15, 0.21];
    slRange = [0.05, 0.07, 0.10, 0.13];
  } else {
    volLabel = '고변동(일평균≥4%)';
    tpRange = [0.05, 0.08, 0.10, 0.15, 0.21, 0.30];
    slRange = [0.07, 0.10, 0.13, 0.15];
  }
  const cdRange = [2, 3, 5, 7];
  const bwRange = [15, 20, 30, 45];
  const biRange = [5, 10, 15, 20, 25];
  const bmhRange = [2, 3, 5];

  let best = null, bestProfit = null;
  let totalCombos = 0, validCombos = 0;
  const trainData = data.slice(0, trainEnd);

  for (const tp of tpRange) {
    for (const sl of slRange) {
      for (const cd of cdRange) {
        for (const bw of bwRange) {
          for (const bi of biRange) {
            for (const bmh of bmhRange) {
              totalCombos++;
              const trades = btSimulateV2(trainData, trainStartIdx, {
                tp, sl, cd, threshold: 4.5, rsiMin: 70,
                benfordInfluence: bi / 100, benfordWindow: bw, benfordMinHits: bmh,
                maxHold: 0, commission: commRate, tax: taxR, qty: 10,
              }, '', '', profileName);
              const s = btSummarize(trades);
              if (s.closed < 3) continue;
              validCombos++;

              const winScore = s.winRate >= 80 ? s.winRate * 0.8
                             : s.winRate >= 70 ? s.winRate * 0.55
                             : s.winRate * 0.3;
              const cumScore = Math.max(0, Math.min(s.cumReturn / 200, 1)) * 15;
              const avgRetScore = Math.max(0, Math.min((s.avgReturn + 5) / 15, 1)) * 5;
              const tradeScore = Math.min(s.closed / 8, 1) * 10;
              const winPenalty = s.winRate < 50 ? -30 : (s.winRate < 60 ? -15 : 0);
              const score = winScore + cumScore + avgRetScore + tradeScore + winPenalty;

              const candidate = { score, tp, sl, cd, bw, bi, bmh,
                winRate: s.winRate, trades: s.closed, cumReturn: s.cumReturn,
                avgReturn: s.avgReturn, wins: s.wins, losses: s.losses };

              if (!best || score > best.score) best = candidate;

              const pScore = s.avgReturn * 5 + Math.min(Math.max(s.cumReturn, 0), 200) * 0.05
                           + Math.min(s.closed / 5, 1) * 3 + (s.winRate < 35 ? -30 : 0);
              if (!bestProfit || pScore > bestProfit._profitScore) {
                bestProfit = { ...candidate, _profitScore: pScore };
              }
            }
          }
        }
      }
    }
  }

  if (best) {
    // Walk-Forward: 테스트 구간 검증
    const testTrades = btSimulateV2(data, testStart, {
      tp: best.tp, sl: best.sl, cd: best.cd, threshold: 4.5, rsiMin: 70,
      benfordInfluence: best.bi / 100, benfordWindow: best.bw, benfordMinHits: best.bmh,
      maxHold: 0, commission: commRate, tax: taxR, qty: 10,
    }, '', '', profileName);
    const testSummary = btSummarize(testTrades);

    best.totalCombos = totalCombos;
    best.validCombos = validCombos;
    best.volLabel = volLabel;
    best.dailyVol = dailyVol;
    best.trainPeriod = `${data[trainStartIdx].date} ~ ${data[trainEnd-1].date} (${trainEnd - trainStartIdx}일)`;
    best.testPeriod = `${data[testStart].date} ~ ${data[totalLen-1].date} (${totalLen - testStart}일)`;
    best.testWinRate = testSummary.winRate;
    best.testTrades = testSummary.closed;
    best.testCumReturn = testSummary.cumReturn;
    best.testAvgReturn = testSummary.avgReturn;
    best.testWins = testSummary.wins;
    best.testLosses = testSummary.losses;

    const defaultProfile = STOCK_PROFILES[profileName] || STOCK_PROFILES.default;
    best.defaultTP = defaultProfile.take_profit;
    best.defaultSL = defaultProfile.stop_loss;
    best.defaultCD = defaultProfile.cooldown;

    if (bestProfit) {
      const profitTestTrades = btSimulateV2(data, testStart, {
        tp: bestProfit.tp, sl: bestProfit.sl, cd: bestProfit.cd, threshold: 4.5, rsiMin: 70,
        benfordInfluence: bestProfit.bi / 100, benfordWindow: bestProfit.bw, benfordMinHits: bestProfit.bmh,
        maxHold: 0, commission: commRate, tax: taxR, qty: 10,
      }, '', '', profileName);
      const pts = btSummarize(profitTestTrades);
      bestProfit.testWinRate = pts.winRate;
      bestProfit.testTrades = pts.closed;
      bestProfit.testCumReturn = pts.cumReturn;
      bestProfit.testAvgReturn = pts.avgReturn;
      best.profitBest = bestProfit;
    }

    best.evalWinRate = best.testWinRate;
    best.evalTrades = best.testTrades;
    best.evalAvgReturn = best.testAvgReturn;
    best.evalCumReturn = best.testCumReturn;
    best.evalPeriod = best.testPeriod;
    if (bestProfit) {
      bestProfit.evalWinRate = bestProfit.testWinRate;
      bestProfit.evalTrades = bestProfit.testTrades;
      bestProfit.evalAvgReturn = bestProfit.testAvgReturn;
      bestProfit.evalCumReturn = bestProfit.testCumReturn;
    }
  }
  return best;
}

function btCalcInvestmentScore(data, optResult) {
  const scores = { strategy: 0, signal: 0, profit: 0, trend: 0, confidence: 0 };
  const wr = (optResult.evalTrades > 0) ? optResult.evalWinRate
           : (optResult.testTrades > 0) ? optResult.testWinRate : optResult.winRate;
  scores.strategy = Math.round(Math.min(Math.max(wr / 100 * 30, 0), 30));

  if (data && data.length > 60) {
    const lastIdx = data.length - 1;
    const buyResult = calcBuyScoreV2(data, lastIdx, null, (optResult.bi||15)/100, optResult.bw||30, optResult.bmh||3);
    scores.signal = Math.round(Math.min(Math.max(buyResult.score / 10 * 25, 0), 25));
  }

  const avgRet = (optResult.evalTrades > 0) ? optResult.evalAvgReturn
               : (optResult.testTrades > 0) ? optResult.testAvgReturn : optResult.avgReturn;
  scores.profit = Math.round(Math.min(Math.max((avgRet + 5) / 10 * 20, 0), 20));

  if (data && data.length > 60) {
    const last = data[data.length - 1];
    if (last.ma5 > last.ma20 && last.ma20 > last.ma60) scores.trend += 5;
    else if (last.ma5 > last.ma20) scores.trend += 2;
    if (last.rsi != null && last.rsi >= 80) scores.trend += 5;
    else if (last.rsi != null && last.rsi >= 70) scores.trend += 4;
    else if (last.rsi != null && last.rsi >= 60) scores.trend += 2;
    if (last.macdHist != null && last.macdHist > 0) scores.trend += 5;
    else if (last.macdHist != null && last.macd > last.macdSignal) scores.trend += 2;
  }

  const evalN = optResult.evalTrades || optResult.testTrades || 0;
  scores.confidence = Math.round(Math.min(evalN / 5 * 10, 10));

  const total = scores.strategy + scores.signal + scores.profit + scores.trend + scores.confidence;
  let grade, gradeColor;
  if (total >= 80) { grade = '매수 적극 추천'; gradeColor = '#4caf50'; }
  else if (total >= 60) { grade = '매수 검토'; gradeColor = '#f5c842'; }
  else if (total >= 40) { grade = '관망 추천'; gradeColor = '#ff9800'; }
  else { grade = '투자 부적합'; gradeColor = '#ef5350'; }
  return { total, grade, gradeColor, scores };
}

function applyBtRecommendation(profileName, tp, sl, cd, bw, bi, bmh) {
  document.getElementById('btProfile').value = profileName;
  document.getElementById('btTP').value = Math.round(tp * 100);
  document.getElementById('btSL').value = Math.round(sl * 100);
  document.getElementById('btCD').value = cd;
  if (bw != null) document.getElementById('btBenfordWindow').value = bw;
  if (bi != null) document.getElementById('btBenfordInfluence').value = bi;
  if (bmh != null) document.getElementById('btBenfordMinHits').value = bmh;
}

function applyBtBestStrategy(profileName, optResult) {
  const pb = optResult.profitBest;
  let usePb = false;
  if (pb) {
    const stableRet = optResult.evalTrades > 0 ? optResult.evalAvgReturn
                    : optResult.testTrades > 0 ? optResult.testAvgReturn : optResult.avgReturn;
    const profitRet = pb.evalTrades > 0 ? pb.evalAvgReturn
                    : pb.testTrades > 0 ? pb.testAvgReturn : pb.avgReturn;
    const profitWR = pb.evalTrades > 0 ? pb.evalWinRate
                   : pb.testTrades > 0 ? pb.testWinRate : pb.winRate;
    if (profitRet > stableRet + 1 && profitWR >= 40) usePb = true;
  }
  const p = usePb ? pb : optResult;
  applyBtRecommendation(profileName, p.tp, p.sl, p.cd, p.bw, p.bi, p.bmh || 3);
}

function showBtRecommendBanner(detection, optResult, data) {
  const banner = document.getElementById('btRecommendBanner');
  const typeLabel = detection.isLargeCap ? '대형 우량주' : '중소형 성장주';
  const vol = detection.volatility;
  const sName = _btSelected ? _btSelected.name : '';
  const sCode = _btSelected ? _btSelected.code : '';

  // 실제 적용될 전략 결정 (applyBtBestStrategy와 동일 로직)
  let applied = optResult;
  let appliedLabel = '안정형(승률 우선)';
  if (optResult && optResult.profitBest) {
    const pb = optResult.profitBest;
    const stableRet = optResult.evalTrades > 0 ? optResult.evalAvgReturn : optResult.testTrades > 0 ? optResult.testAvgReturn : optResult.avgReturn;
    const profitRet = pb.evalTrades > 0 ? pb.evalAvgReturn : pb.testTrades > 0 ? pb.testAvgReturn : pb.avgReturn;
    const profitWR = pb.evalTrades > 0 ? pb.evalWinRate : pb.testTrades > 0 ? pb.testWinRate : pb.winRate;
    if (profitRet > stableRet + 1 && profitWR >= 40) { applied = pb; appliedLabel = '수익형(수익률 우선)'; }
  }

  let html = `<div style="font-size:18px;font-weight:800;color:#f5c842;margin-bottom:6px;">${sName} <span style="font-size:13px;font-weight:500;color:#7A7470;">(${sCode})</span> <span style="font-size:14px;font-weight:600;color:#C8C2BC;">주가 특성 자동 분석 완료</span></div>`;
  html += `<div style="font-size:12px;color:#9A9390;line-height:1.8;">`;
  html += `일평균 변동폭: <span style="color:#f5c842;font-weight:700;">${(vol.avgATR*100).toFixed(2)}%</span> → <span style="color:#f5c842;font-weight:700;">${typeLabel}</span>로 판별`;

  if (optResult) {
    html += `<div style="margin-top:10px;padding:10px 12px;background:#12122a;border:1px solid #252320;border-radius:6px;font-size:12px;line-height:1.8;">`;
    html += `<div style="color:#A070FF;font-weight:600;margin-bottom:4px;">최적화 분석 리포트</div>`;

    html += `<div style="color:#7A7470;">STEP 1. 변동성 분석</div>`;
    html += `<div style="margin-left:12px;">일평균 ATR: <span style="color:#f5c842;">${optResult.dailyVol.toFixed(2)}%</span> → 변동성 등급: <span style="color:#f5c842;">${optResult.volLabel}</span></div>`;

    html += `<div style="color:#7A7470;margin-top:4px;">STEP 2. 최적 파라미터 탐색</div>`;
    const validPct = optResult.totalCombos > 0 ? Math.round(optResult.validCombos / optResult.totalCombos * 100) : 0;
    html += `<div style="margin-left:12px;">익절/손절/쿨다운 등 <span style="color:#f5c842;">${optResult.totalCombos.toLocaleString()}가지</span> 설정을 시뮬레이션하여 최적값 선정 (유효 ${validPct}%)</div>`;

    // STEP 3: 적용 전략 + 파라미터 산출 근거
    const wr = applied.evalTrades > 0 ? applied.evalWinRate : applied.testTrades > 0 ? applied.testWinRate : applied.winRate;
    const avgRet = applied.evalTrades > 0 ? applied.evalAvgReturn : applied.testTrades > 0 ? applied.testAvgReturn : applied.avgReturn;
    const trades = applied.evalTrades || applied.testTrades || applied.trades || 0;
    html += `<div style="color:#7A7470;margin-top:4px;">STEP 3. 적용 전략: <span style="color:#A070FF;font-weight:600;">${appliedLabel}</span></div>`;
    html += `<div style="margin-left:12px;color:#9A9390;">승률 <span style="color:${wr>=50?'#4caf50':'#ef5350'};">${wr.toFixed(0)}%</span> · ${trades}건 거래 · 평균수익률 <span style="color:${avgRet>=0?'#4caf50':'#ef5350'};">${avgRet>=0?'+':''}${avgRet.toFixed(2)}%</span></div>`;

    // 파라미터 산출 근거 테이블
    const dVol = optResult.dailyVol;
    const tpPct = Math.round(applied.tp * 100);
    const slPct = Math.round(applied.sl * 100);
    const tpSlRatio = (applied.tp / applied.sl).toFixed(1);

    html += `<div style="margin-top:8px;padding:8px 10px;background:#191816;border:1px solid #2A2825;border-radius:6px;">`;
    html += `<div style="font-size:11px;font-weight:600;color:#C8C2BC;margin-bottom:6px;">파라미터 산출 근거</div>`;
    html += `<table style="font-size:11px;border-collapse:collapse;width:100%;"><tbody>`;

    // 익절
    let tpReason = '';
    if (dVol >= 4.0) tpReason = `고변동(${dVol.toFixed(1)}%) 종목 → 탐색범위 5~30% 중 최적`;
    else if (dVol >= 2.5) tpReason = `중변동(${dVol.toFixed(1)}%) 종목 → 탐색범위 4~21% 중 최적`;
    else if (dVol >= 1.5) tpReason = `저변동(${dVol.toFixed(1)}%) 종목 → 탐색범위 3~13% 중 최적`;
    else tpReason = `초저변동(${dVol.toFixed(1)}%) 종목 → 탐색범위 2~10% 중 최적`;
    html += `<tr><td style="padding:4px 6px;color:#4caf50;font-weight:600;white-space:nowrap;vertical-align:top;">익절 ${tpPct}%</td><td style="padding:4px 6px;color:#8A8480;">${tpReason}</td></tr>`;

    // 손절
    let slReason = `손익비 ${tpSlRatio}:1 (TP/SL) — `;
    if (parseFloat(tpSlRatio) >= 3) slReason += '공격적 전략, 높은 손익비로 소수 대승 추구';
    else if (parseFloat(tpSlRatio) >= 2) slReason += '균형 전략, 적절한 손익비';
    else slReason += '안정 전략, 빠른 손절로 리스크 최소화';
    html += `<tr><td style="padding:4px 6px;color:#ef5350;font-weight:600;white-space:nowrap;vertical-align:top;">손절 ${slPct}%</td><td style="padding:4px 6px;color:#8A8480;">${slReason}</td></tr>`;

    // 쿨다운
    let cdReason = '';
    if (applied.cd <= 2) cdReason = '짧은 대기 → 시그널 발생 시 즉시 재진입 (활발한 매매)';
    else if (applied.cd <= 3) cdReason = '표준 대기 → 연속 매매 방지, 적절한 관망 기간';
    else if (applied.cd <= 5) cdReason = '중기 대기 → 과매매 방지, 신중한 진입';
    else cdReason = '장기 대기 → 확실한 시그널만 선별 (보수적)';
    html += `<tr><td style="padding:4px 6px;color:#f5c842;font-weight:600;white-space:nowrap;vertical-align:top;">쿨다운 ${applied.cd}일</td><td style="padding:4px 6px;color:#8A8480;">${cdReason}</td></tr>`;

    // 벤포드
    let bfReason = `${applied.bw}일 윈도우에서 세력 흔적 감지, `;
    if (applied.bi >= 20) bfReason += '높은 영향도 → 세력 패턴 강하게 반영';
    else if (applied.bi >= 10) bfReason += '중간 영향도 → 세력 패턴 적절히 반영';
    else bfReason += '낮은 영향도 → 세력 패턴 참고 수준';
    bfReason += ` (최소 ${applied.bmh||3}회 감지 시 적용)`;
    html += `<tr><td style="padding:4px 6px;color:#9c27b0;font-weight:600;white-space:nowrap;vertical-align:top;">벤포드 ${applied.bw}일/${applied.bi}%</td><td style="padding:4px 6px;color:#8A8480;">${bfReason}</td></tr>`;

    // RSI 필터
    html += `<tr><td style="padding:4px 6px;color:#2196f3;font-weight:600;white-space:nowrap;vertical-align:top;">RSI 최소 70</td><td style="padding:4px 6px;color:#8A8480;">RSI≥70 검증 결과 승률 2.2배 상승 (40.7% vs 18.4%) — 강한 모멘텀 구간만 진입</td></tr>`;

    html += `</tbody></table></div>`;

    // 투자 매력도
    const evalLabel = optResult.testPeriod || '';
    html += `<div style="color:#7A7470;margin-top:8px;">STEP 4. 투자 매력도 평가 <span style="font-size:10px;color:#555;">(${evalLabel})</span></div>`;
    const invScore = btCalcInvestmentScore(data, optResult);
    const barItems = [
      { label: '전략 승률', score: invScore.scores.strategy, max: 30 },
      { label: '매수 스코어', score: invScore.scores.signal, max: 25 },
      { label: '수익성', score: invScore.scores.profit, max: 20 },
      { label: '추세 건전성', score: invScore.scores.trend, max: 15 },
      { label: '통계 신뢰도', score: invScore.scores.confidence, max: 10 },
    ];
    html += `<div style="display:flex;align-items:center;gap:20px;background:#191816;border:1px solid ${invScore.gradeColor}44;border-radius:10px;padding:16px 20px;margin:8px 0;">`;
    html += `<div style="text-align:center;min-width:90px;"><div style="font-size:40px;font-weight:800;color:${invScore.gradeColor};line-height:1;">${invScore.total}</div><div style="font-size:11px;color:#7A7470;margin-top:2px;">/ 100점</div><div style="font-size:13px;font-weight:700;color:${invScore.gradeColor};margin-top:4px;">${invScore.grade}</div></div>`;
    html += `<div style="flex:1;">`;
    for (const item of barItems) {
      const pct = item.max > 0 ? Math.round(item.score / item.max * 100) : 0;
      const bc = pct >= 70 ? '#4caf50' : (pct >= 40 ? '#f5c842' : '#ef5350');
      html += `<div style="display:flex;align-items:center;gap:8px;margin:3px 0;font-size:11px;">`;
      html += `<div style="width:85px;color:#8A8480;text-align:right;">${item.label}</div>`;
      html += `<div style="flex:1;background:#1E1D1B;border-radius:3px;height:10px;overflow:hidden;"><div style="width:${pct}%;height:100%;background:${bc};border-radius:3px;transition:width .3s;"></div></div>`;
      html += `<div style="width:40px;color:#9A9390;font-size:10px;">${item.score}/${item.max}</div></div>`;
    }
    html += `</div></div>`;

    // 최근 시그널 분석 — 왜 매매가 적은지/많은지 설명
    html += _buildRecentSignalAnalysis(data, applied, detection.profileName);

    html += `</div>`; // 로그 박스
  }
  html += `</div>`;
  banner.innerHTML = html;
  banner.style.display = 'block';
}

// 최근 시그널 발생 현황 분석
function _buildRecentSignalAnalysis(data, applied, profileName) {
  if (!data || data.length < 120) return '';
  const recentStart = Math.max(60, data.length - 120);
  const reasons = { rsiBlock: 0, thresholdBlock: 0, cooldownBlock: 0, signalOK: 0 };
  let lastSigIdx = -100;
  const cd = applied.cd || 3;
  for (let i = recentStart; i < data.length; i++) {
    if (i - lastSigIdx < cd) { reasons.cooldownBlock++; continue; }
    const rsi = data[i].rsi;
    if (rsi != null && rsi < 70) { reasons.rsiBlock++; continue; }
    const {score} = calcBuyScoreV2(data, i, profileName, (applied.bi||15)/100, applied.bw||30, applied.bmh||3);
    if (score < 4.5) { reasons.thresholdBlock++; continue; }
    reasons.signalOK++;
    lastSigIdx = i;
  }
  const total = reasons.rsiBlock + reasons.thresholdBlock + reasons.cooldownBlock + reasons.signalOK;
  if (total === 0) return '';

  let html = `<div style="margin-top:8px;padding:8px 10px;background:#191816;border:1px solid #2A2825;border-radius:6px;">`;
  html += `<div style="font-size:11px;font-weight:600;color:#C8C2BC;margin-bottom:6px;">최근 120일 시그널 발생 현황</div>`;
  html += `<div style="display:flex;gap:12px;flex-wrap:wrap;font-size:11px;">`;

  // 시그널 통과
  html += `<div style="padding:4px 8px;background:#4caf5022;border:1px solid #4caf5044;border-radius:4px;color:#4caf50;">매수 시그널 발생: <b>${reasons.signalOK}건</b></div>`;

  // 차단 사유
  if (reasons.rsiBlock > 0) {
    const rsiPct = Math.round(reasons.rsiBlock / total * 100);
    html += `<div style="padding:4px 8px;background:#ef535022;border:1px solid #ef535044;border-radius:4px;color:#ef5350;">RSI<70 차단: <b>${reasons.rsiBlock}일</b> (${rsiPct}%)</div>`;
  }
  if (reasons.thresholdBlock > 0) {
    const thPct = Math.round(reasons.thresholdBlock / total * 100);
    html += `<div style="padding:4px 8px;background:#ff980022;border:1px solid #ff980044;border-radius:4px;color:#ff9800;">점수<4.5 차단: <b>${reasons.thresholdBlock}일</b> (${thPct}%)</div>`;
  }
  if (reasons.cooldownBlock > 0) {
    html += `<div style="padding:4px 8px;background:#2196f322;border:1px solid #2196f344;border-radius:4px;color:#2196f3;">쿨다운 대기: <b>${reasons.cooldownBlock}일</b></div>`;
  }

  html += `</div>`;

  // 주요 차단 원인 설명
  const mainBlock = reasons.rsiBlock > reasons.thresholdBlock ? 'rsi' : 'threshold';
  if (reasons.signalOK === 0) {
    if (mainBlock === 'rsi') {
      html += `<div style="margin-top:6px;font-size:11px;color:#ef5350;">최근 120일간 RSI가 70을 넘지 못해 매수 시그널이 0건입니다. 이 종목은 현재 강한 상승 모멘텀이 부족합니다.</div>`;
    } else {
      html += `<div style="margin-top:6px;font-size:11px;color:#ff9800;">최근 120일간 매수 점수가 기준(4.5점)에 미달하여 시그널이 0건입니다. 기술적 조건이 충족되지 않고 있습니다.</div>`;
    }
  } else if (reasons.signalOK <= 2) {
    html += `<div style="margin-top:6px;font-size:11px;color:#f5c842;">시그널이 적은 편입니다. 엄격한 필터링이 적용되어 높은 품질의 시그널만 통과합니다.</div>`;
  }
  html += `</div>`;
  return html;
}

// ── 백테스트 파라미터 수집 ─────────────────────────────────
function btGetParams() {
  // auto 모드에서도 UI 필드 읽기 (autoOptimize가 값을 채워놨으므로)
  return {
    threshold: parseFloat(document.getElementById('btThreshold').value)||4.5,
    rsiMin: parseInt(document.getElementById('btRsiMin').value)||70,
    profileName: document.getElementById('btProfile').value || 'auto',
    tp: parseFloat(document.getElementById('btTP').value)/100,
    sl: parseFloat(document.getElementById('btSL').value)/100,
    cd: parseInt(document.getElementById('btCD').value)||3,
    qty: parseInt(document.getElementById('btQty').value)||10,
    commission: parseFloat(document.getElementById('btCommission').value)/100,
    tax: parseFloat(document.getElementById('btTax').value)/100,
    maxHold: parseInt(document.getElementById('btMaxHold').value)||0,
    benfordInfluence: (parseFloat(document.getElementById('btBenfordInfluence').value)||15)/100,
    benfordWindow: parseInt(document.getElementById('btBenfordWindow').value)||30,
    benfordMinHits: parseInt(document.getElementById('btBenfordMinHits').value)||3,
  };
}

async function runBacktest() {
  if(_btRunning)return; _btRunning=true;
  const btn=document.getElementById('btRunBtn'); btn.disabled=true; btn.textContent='분석 중...';
  const periodDays=parseInt(document.getElementById('btPeriod').value)||365;
  document.getElementById('btEmpty').style.display='none';
  document.getElementById('btSummary').style.display='none';
  document.getElementById('btSignalCard').style.display='none';
  document.getElementById('btRecommendBanner').style.display='none';
  document.getElementById('btProgressWrap').style.display='block';
  const fill=document.getElementById('btProgressFill'),label=document.getElementById('btProgressLabel'),cnt=document.getElementById('btProgressCount');

  let targets;
  if(_btSelected){targets=[[_btSelected.name,_btSelected.code]];}
  else{label.textContent='KOSPI 종목 로드 중...';await btEnsureStockList();targets=_btStockCache.map(s=>[s.name,s.code]);}

  const cutoff=new Date();cutoff.setDate(cutoff.getDate()-(periodDays||99999));
  const cutoffStr=cutoff.toISOString().split('T')[0].replace(/-/g,'');
  const allTrades=[],byStock={};
  let singleData=null;

  // OHLCV 병렬 다운로드 (5개씩) → 백테스트 시뮬레이션
  const BT_BATCH = 5;
  for(let bi=0;bi<targets.length;bi+=BT_BATCH){
    const batch=targets.slice(bi,bi+BT_BATCH);
    label.textContent=`다운로드+분석 중 (${batch.map(b=>b[0]).join(', ')})...`;
    cnt.textContent=`${Math.min(bi+BT_BATCH,targets.length)}/${targets.length}`;
    fill.style.width=`${Math.round(Math.min(bi+BT_BATCH,targets.length)/targets.length*100)}%`;
    const ohlcvs=await Promise.all(batch.map(async([,code])=>{
      try{const r=await fetch(`/api/kis-ohlcv/${code}`);if(!r.ok)return null;const j=await r.json();return(j.ok&&j.data&&j.data.length>=100)?j.data:null;}catch(e){return null;}
    }));
    for(let j=0;j<batch.length;j++){
      const [name,code]=batch[j]; const data=ohlcvs[j]; if(!data)continue;
      try{
        calcIndicatorsV2(data);

        // 자동 최적화 모드 + 단일 종목: btSelectStock에서 이미 실행됨
        // 배너가 없으면 (직접 코드 입력 등) 여기서 실행
        if (_btMode === 'auto' && targets.length === 1 && document.getElementById('btRecommendBanner').style.display === 'none') {
          label.textContent = `자동 최적화 중... 6개 파라미터 조합 탐색`;
          const detection = autoDetectProfile(data);
          const optResult = autoOptimize(data, detection.profileName, 60);
          if (optResult) {
            applyBtBestStrategy(detection.profileName, optResult);
            showBtRecommendBanner(detection, optResult, data);
          } else {
            const prof = STOCK_PROFILES[detection.profileName] || STOCK_PROFILES.default;
            applyBtRecommendation(detection.profileName, prof.take_profit, prof.stop_loss, prof.cooldown, 30, 15, 3);
            showBtRecommendBanner(detection, null, data);
          }
        }

        const params=btGetParams();
        // auto 모드 + 다중 종목: 프로필 기본값 사용
        if (_btMode === 'auto' && targets.length > 1) params._useProfile = true;
        const startIdx=periodDays>0?data.findIndex(d=>d.date.replace(/-/g,'')>=cutoffStr):0;
        if(startIdx<0)continue;
        const pName=params.profileName==='auto'?classifyProfile(code,_btStockCache.length?_btStockCache:_stockListCache):params.profileName;
        const trades=btSimulateV2(data,startIdx,params,name,code,pName);
        allTrades.push(...trades);
        if(trades.length)byStock[name]={code,trades,data};
        if(targets.length===1)singleData=data;
      }catch(e){console.warn('BT error',name,e);}
    }
  }
  document.getElementById('btProgressWrap').style.display='none';
  btn.disabled=false;btn.textContent='분석 시작';_btRunning=false;

  _btAllTrades=allTrades; _btByStock=byStock; _btAllData=singleData;

  const params=btGetParams();
  // 단일 종목이면 오늘의 신호 강도 카드 표시
  if(targets.length===1 && singleData && singleData.length>=62) {
    showBtSignalCard(singleData, params);
  }
  renderBtResults(allTrades,byStock,periodDays,params);
}

function btSimulateV2(data, startIdx, params, name, code, profileName) {
  const trades = [];
  const profile = STOCK_PROFILES[profileName] || STOCK_PROFILES.default;
  // useProfile: auto 모드에서 multi-stock일 때 프로필 기본값 사용
  const useProfile = params._useProfile;
  const tp = useProfile ? profile.take_profit : (params.tp || profile.take_profit);
  const sl = useProfile ? profile.stop_loss : (params.sl || profile.stop_loss);
  const cd = useProfile ? profile.cooldown : (params.cd || profile.cooldown);
  const maxHold = params.maxHold || 0; // 0 = 무제한
  const roundTrip = (params.commission||COMMISSION_RATE)*2 + (params.tax||SELL_TAX_RATE);
  let pending = null, position = null;
  let lastSignalIdx = -cd;
  let consecLosses = 0;

  for (let i = Math.max(60, startIdx - 10); i < data.length; i++) {
    const d = data[i];
    const inPeriod = i >= startIdx;
    const effectiveCooldown = consecLosses >= CIRCUIT_BREAKER_LOSSES ? cd + CIRCUIT_BREAKER_EXTRA : cd;

    // PENDING 체결 (Python 백테스터와 동일: 1일 만료)
    if (pending && inPeriod && d.date > pending.signalDate) {
      let fillPrice = null;
      if (d.open <= pending.limitPrice) fillPrice = d.open;
      else if (d.low <= pending.limitPrice) fillPrice = pending.limitPrice;
      if (fillPrice != null) {
        const fillKijun = d.ichiKijun;
        const fillAtr = d.atr14 || null;
        position = {
          name, code, profileName, entryDate: d.date, entryPrice: fillPrice,
          targetPrice: Math.round(calcTargetPrice(fillPrice, pending.tpLevel, tp)),
          stopPrice: Math.round(calcStopPrice(fillPrice, fillKijun, sl, fillAtr)),
          signalDate: pending.signalDate, signalScore: pending.signalScore,
          signalDetails: pending.signalDetails,
          limitPrice: pending.limitPrice, entryIdx: i,
          timeoutDays: maxHold, daysHeld: 0,
        };
        pending = null; continue;
      } else {
        pending = null;
      }
    }

    // IN_POSITION 청산 (Python 백테스터와 동일 분기 순서)
    if (position && inPeriod && d.date > position.entryDate) {
      position.daysHeld = Math.floor((new Date(d.date) - new Date(position.entryDate)) / 86400000);
      let exitReason=null, exitPrice=null;
      const hitT=d.high>=position.targetPrice, hitS=d.low<=position.stopPrice;
      if (hitT&&hitS) {
        // Python과 동일: open <= stopPrice 먼저 체크 (갭하락 시 손절 우선)
        if (d.open<=position.stopPrice) {exitReason='LOSS';exitPrice=position.stopPrice;}
        else if (d.open>=position.targetPrice) {exitReason='WIN';exitPrice=position.targetPrice;}
        else {exitReason='LOSS';exitPrice=position.stopPrice;}
      } else if (hitS) {exitReason='LOSS';exitPrice=position.stopPrice;}
      else if (hitT) {exitReason='WIN';exitPrice=position.targetPrice;}
      else if (maxHold>0 && position.daysHeld>=maxHold) {exitReason='TIMEOUT';exitPrice=d.close;}
      if (exitReason) {
        const gross=(exitPrice-position.entryPrice)/position.entryPrice;
        const pnlPct=Math.round((gross-roundTrip)*10000)/100;
        const pnlAmt=Math.round((exitPrice-position.entryPrice)*(params.qty||10));
        const er=exitReason==='WIN'?'TARGET':exitReason==='LOSS'?'STOP':'TIMEOUT';
        // maxGain 계산
        let maxGain=0;
        if(position.entryIdx){for(let k=position.entryIdx;k<=i;k++){const g=(data[k].high-position.entryPrice)/position.entryPrice*100;if(g>maxGain)maxGain=g;}}
        trades.push({...position,exitDate:d.date,exitReason:er,exitPrice,pnlPct,pnlAmt,exitIdx:i,maxGain:Math.round(maxGain*10)/10});
        if(er==='STOP')consecLosses++;else consecLosses=0;
        position=null;
      }
    }

    // 새 신호
    if (!position && !pending && inPeriod && i>=60) {
      if (i - lastSignalIdx < effectiveCooldown) continue;
      const rsi=data[i].rsi;
      if (rsi!=null && rsi<params.rsiMin) continue;
      if (CONFIG.useRegimeFilter && _regimeFilter.loaded && _regimeFilter.isBearMarket(d.date)) continue;
      const {score,details}=calcBuyScoreV2(data,i,profileName,params.benfordInfluence||0.15,params.benfordWindow||30,params.benfordMinHits||5);
      if (score<params.threshold) continue;
      const dp=calcDynamicPrices(data,i,tp,sl);
      const limitPrice=dp.pendingLimit||d.close;
      pending={signalDate:d.date,signalScore:Math.round(score*10)/10,limitPrice,tpLevel:dp.tpLevel,atrForSL:dp.atrForSL,signalDetails:details,signalIdx:i};
      lastSignalIdx=i;
    }
  }
  return trades;
}

// ── 오늘의 신호 강도 카드 ──────────────────────────────────
function showBtSignalCard(data, params) {
  const card = document.getElementById('btSignalCard');
  const lastIdx = data.length - 1;
  const d = data[lastIdx];
  const threshold = params.threshold;
  const {score,details}=calcBuyScoreV2(data,lastIdx,params.profileName==='auto'?'default':params.profileName,params.benfordInfluence||0.15,params.benfordWindow||30,params.benfordMinHits||5);

  card.style.display='block';
  let dateStr='';
  try{dateStr=new Date(d.date).toLocaleDateString('ko-KR');}catch(e){dateStr=d.date;}
  document.getElementById('btSignalDate').textContent=`(${dateStr} 기준)`;

  // 레짐 체크
  const regimeEl=document.getElementById('btSignalRegime');
  let isBear=false;
  if(CONFIG.useRegimeFilter && _regimeFilter.loaded) {
    isBear=_regimeFilter.isBearMarket(d.date);
    regimeEl.style.display='inline-block';
    if(isBear){regimeEl.style.background='rgba(239,83,80,.15)';regimeEl.style.color='#ef5350';regimeEl.textContent='약세장';}
    else{regimeEl.style.background='rgba(76,175,80,.1)';regimeEl.style.color='#4caf50';regimeEl.textContent='KOSPI 정상';}
  } else { regimeEl.style.display='none'; }

  // 상태 메시지
  const statusEl=document.getElementById('btSignalStatus');
  if(isBear){statusEl.innerHTML='<span style="color:#ef5350">KOSPI 약세 국면 — 매수 차단</span>';}
  else if(score>=threshold+2){statusEl.innerHTML=`<span style="color:#4caf50">강력 매수 신호 (임계값 +${(score-threshold).toFixed(1)}점 초과)</span>`;}
  else if(score>=threshold){statusEl.innerHTML=`<span style="color:#f5c842">매수 신호 발생 (임계값 +${(score-threshold).toFixed(1)}점 초과)</span>`;}
  else if(score>=threshold-1.5){statusEl.innerHTML=`<span style="color:#ff9800">신호 접근 중 (임계값까지 ${(threshold-score).toFixed(1)}점 부족)</span>`;}
  else{statusEl.innerHTML=`<span style="color:#7A7470">매수 조건 미달 (현재 ${score.toFixed(1)}점 / 임계 ${threshold.toFixed(1)}점)</span>`;}

  // 점수 바
  let barColor;
  if(isBear) barColor='#ef5350';
  else if(score>=threshold+2) barColor='#4caf50';
  else if(score>=threshold) barColor='#f5c842';
  else if(score>=threshold-1.5) barColor='#ff9800';
  else barColor='#3A3733';

  document.getElementById('btSignalScore').textContent=score>0?score.toFixed(1):'-';
  const maxVis=Math.max(threshold*2.5,10);
  const barPct=Math.min(score/maxVis*100,100);
  const bar=document.getElementById('btSignalBar');
  bar.style.width=barPct+'%';
  bar.style.background=barColor;
  const thPct=Math.min(threshold/maxVis*100,100);
  document.getElementById('btSignalThresh').style.left=thPct+'%';
  document.getElementById('btSignalThreshLbl').style.left=thPct+'%';
  document.getElementById('btSignalThreshLbl').textContent=`임계 ${threshold.toFixed(1)}점`;

  // 컴포넌트 바 (원본 앱과 동일 구조: details 키 기반)
  const compMap = {
    rsi:        { label:'RSI 모멘텀', max:2.5 },
    bb:         { label:'BB 위치',    max:1.5 },
    core:       { label:'MA 정배열',  max:2.0 },
    long_trend: { label:'MA 기울기',  max:1.0 },
    benford:    { label:'세력 감지',  max:1.5 },
    macd:       { label:'MACD',       max:2.0 },
    volume:     { label:'거래량',     max:2.0 },
  };
  let compHTML='';
  if(details && typeof details==='object') {
    for(const [key, meta] of Object.entries(compMap)) {
      if(!details[key]) continue;
      const detailText=details[key];
      const isNeg=typeof detailText==='string'&&(detailText.includes('약세')||detailText.includes('아래')||detailText.includes('과열'));
      const fillColor=isNeg?'#ef5350':barColor;
      const fillPct=isNeg?30:Math.min((meta.max/2.5)*100,100);
      compHTML+=`<div class="bt-comp-row"><div class="cn">${meta.label}</div><div class="ct"><div class="cf" style="width:${fillPct}%;background:${fillColor}"></div></div><div class="cv">${detailText}</div></div>`;
    }
  }
  document.getElementById('btCompBars').innerHTML=compHTML;

  // 시그널 태그
  const tagMap={
    rsi:{icon:'RSI',cls:'info'}, macd:{icon:'MACD',cls:'info'},
    bb:{icon:'BB',cls:'info'}, volume:{icon:'거래량',cls:'info'},
    candle:{icon:'캔들',cls:'pass'}, streak:{icon:'연속',cls:'pass'},
    breakout:{icon:'고가',cls:'pass'}, long_trend:{icon:'MA60',cls:'info'},
    ma200:{icon:'MA200',cls:'info'}, ichimoku:{icon:'일목',cls:'info'},
    benford:{icon:'세력',cls:'warn'}, ret20d:{icon:'수익',cls:'info'},
    core:{icon:'정배열',cls:'pass'},
  };
  let tagHTML='';
  if(details && typeof details==='object') {
    for(const [key,val] of Object.entries(details)) {
      const meta=tagMap[key]||{icon:key,cls:'info'};
      const isNeg=typeof val==='string'&&(val.includes('약세')||val.includes('아래')||val.includes('과열'));
      const cls=isNeg?'fail':meta.cls;
      tagHTML+=`<span class="bt-signal-tag ${cls}">${meta.icon} ${val}</span>`;
    }
  }
  if(!tagHTML && score===0) tagHTML='<span class="bt-signal-tag fail">필수조건 미통과</span>';
  document.getElementById('btSignalTags').innerHTML=tagHTML;

  // 핵심 지표값 (원본 앱과 동일)
  const lastRow=d;
  const rsiV=lastRow.rsi!=null?lastRow.rsi.toFixed(0):'-';
  const macdH=lastRow.macdHist!=null?(lastRow.macdHist>=0?'+':'')+lastRow.macdHist.toFixed(2):'-';
  const vr=lastRow.volRatio!=null?lastRow.volRatio.toFixed(1)+'x':'-';
  const ma5ok=(lastRow.ma5!=null&&lastRow.ma20!=null)?(lastRow.ma5>lastRow.ma20?'✅':'❌'):'-';
  const ma20ok=(lastRow.ma20!=null&&lastRow.ma60!=null)?(lastRow.ma20>lastRow.ma60?'✅':'❌'):'-';
  // 지표 요약줄 추가
  let indHTML=`<div style="font-size:12px;color:#5A5450;line-height:1.8;margin-top:8px;">MA5>MA20 ${ma5ok} | MA20>MA60 ${ma20ok} | RSI ${rsiV} | MACD히스트 ${macdH} | 거래량비율 ${vr}</div>`;
  const existingInd=document.getElementById('btSignalIndicators');
  if(existingInd){existingInd.innerHTML=indHTML;}
  else{
    const indDiv=document.createElement('div');indDiv.id='btSignalIndicators';indDiv.innerHTML=indHTML;
    document.getElementById('btSignalTags').after(indDiv);
  }
}

// ── 결과 렌더링 ────────────────────────────────────────────
function renderBtResults(allTrades,byStock,periodDays,params) {
  if(!allTrades.length){document.getElementById('btEmpty').style.display='block';document.getElementById('btEmpty').innerHTML='<div style="font-size:24px;margin-bottom:10px;">&#x1F50D;</div><div>조건에 맞는 신호 없음</div><div style="font-size:12px;margin-top:6px;color:#7A7470;">임계값을 낮추거나 RSI 최소값을 조정해 보세요</div>';return;}
  document.getElementById('btSummary').style.display='block';
  const qty=params.qty||10;

  // NaN 필터링: pnlPct가 유효한 거래만 통계에 사용
  const validTrades=allTrades.filter(t=>typeof t.pnlPct==='number'&&isFinite(t.pnlPct));
  const wins=validTrades.filter(t=>t.pnlPct>0),losses=validTrades.filter(t=>t.pnlPct<=0);
  const wr=validTrades.length?wins.length/validTrades.length*100:0;
  const avgRet=validTrades.length?validTrades.reduce((s,t)=>s+t.pnlPct,0)/validTrades.length:0;
  const totPnl=validTrades.reduce((s,t)=>s+(t.pnlAmt||0),0);
  const avgWin=wins.length?wins.reduce((s,t)=>s+t.pnlPct,0)/wins.length:0;
  const avgLoss=losses.length?losses.reduce((s,t)=>s+t.pnlPct,0)/losses.length:0;
  const ev=validTrades.length?(wr/100*avgWin+(1-wr/100)*avgLoss):0;
  const avgHold=validTrades.length?validTrades.reduce((s,t)=>s+(t.daysHeld||0),0)/validTrades.length:0;
  const totalInvested=validTrades.reduce((s,t)=>s+(t.entryPrice||0)*qty,0);

  // MDD 계산 (절대금액 기준 → peak 대비 %)
  const sorted=[...validTrades].sort((a,b)=>(a.exitDate||'').localeCompare(b.exitDate||''));
  let peak=0,cumPnl=0,mdd=0,maxDD=0;
  for(const t of sorted){
    cumPnl+=(t.pnlAmt||0);
    if(cumPnl>peak)peak=cumPnl;
    const dd=peak-cumPnl; // 절대 금액 드로다운
    if(dd>maxDD)maxDD=dd;
  }
  // MDD를 총 투자금 대비 %로 표시 (1회 평균 투자금 기준)
  const avgInvestPerTrade=validTrades.length?(totalInvested/validTrades.length):1;
  mdd=avgInvestPerTrade>0?(maxDD/avgInvestPerTrade*100):0;
  if(mdd>100)mdd=Math.min(mdd,100); // 100% 캡 (1회 투자금 전체 손실)

  const byR={TARGET:0,STOP:0,TIMEOUT:0};allTrades.forEach(t=>{if(byR[t.exitReason]!=null)byR[t.exitReason]++;});

  // 복리 수익률 계산 (NaN-safe)
  let compoundBal=1;
  for(const t of sorted){const r=t.pnlPct;if(isFinite(r))compoundBal*=(1+r/100);}
  const compoundRet=isFinite(compoundBal)?(compoundBal-1)*100:0;

  // 12 stat boxes
  function fmtMoney(v){if(!isFinite(v))return'-';if(Math.abs(v)>=100000000)return(v/100000000).toFixed(1)+'억';if(Math.abs(v)>=10000)return(v/10000).toFixed(0)+'만';return v.toLocaleString()+'원';}
  function safePct(v,d){return isFinite(v)?fmtPct(v,d):'<span style="color:#5A5450">-</span>';}
  const compoundProfit=isFinite(compoundBal)&&avgInvestPerTrade>0?Math.round(avgInvestPerTrade*(compoundBal-1)):0;
  document.getElementById('btStatsGrid').innerHTML=[
    {l:'총 시그널',v:`${allTrades.length}건`,s:`${Object.keys(byStock).length}개 종목`},
    {l:'승리',v:`<span class="pos-up">${wins.length}</span>`,s:`평균 +${avgWin.toFixed(1)}%`},
    {l:'패배',v:`<span class="pos-dn">${losses.length}</span>`,s:`평균 ${avgLoss.toFixed(1)}%`},
    {l:'승률',v:safePct(wr,1),s:`${wins.length}승 ${losses.length}패`},
    {l:'평균 수익률',v:safePct(avgRet,2),s:`승 ${avgWin.toFixed(1)}% / 패 ${avgLoss.toFixed(1)}%`,hl:true},
    {l:'총 수익금',v:`<span class="${totPnl>=0?'pos-up':'pos-dn'}">${(totPnl>=0?'+':'')}${fmtMoney(totPnl)}</span>`,s:`${qty}주 기준`,hl:true},
    {l:'기대값 (EV)',v:safePct(ev,2),s:'1거래당 기대 수익률'},
    {l:'매수 총액',v:fmtMoney(totalInvested),s:`${qty}주 × ${validTrades.length}거래`},
    {l:'MDD',v:`<span class="pos-dn">${mdd.toFixed(1)}%</span>`,s:`익절${byR.TARGET} 손절${byR.STOP} 만기${byR.TIMEOUT}`},
    {l:'평균 보유기간',v:`${avgHold.toFixed(0)}일`,s:'체결~청산'},
    {l:'복리 수익률',v:safePct(compoundRet,2),s:'수익금 재투자 시',hl:true},
    {l:'복리 총수익금',v:`<span class="${compoundProfit>=0?'pos-up':'pos-dn'}">${(compoundProfit>=0?'+':'')}${fmtMoney(compoundProfit)}</span>`,s:'1거래 평균 투자 기준',hl:true},
  ].map(({l,v,s,hl})=>`<div class="bt-stat${hl?' hl':''}"><div class="s-lbl">${l}</div><div class="s-val">${v}</div><div class="s-sub">${s}</div></div>`).join('');

  // 캔들 차트 (단일 종목만)
  if(_btAllData && _btSelected) {
    renderBtChart(_btAllData, allTrades);
  } else {
    document.getElementById('btChartCard').style.display='none';
  }

  // 종목별 성과
  const stockRows=Object.entries(byStock).map(([name,{trades}])=>{
    const valid=trades.filter(t=>isFinite(t.pnlPct));
    const w=valid.filter(t=>t.pnlPct>0);const wr=valid.length?Math.round(w.length/valid.length*100):0;
    const tot=valid.reduce((s,t)=>s+(t.pnlAmt||0),0);const avg=valid.length?valid.reduce((s,t)=>s+t.pnlPct,0)/valid.length:0;
    const worst=valid.length?Math.min(...valid.map(t=>t.pnlPct)):0;
    return{name,cnt:valid.length,wr,tot,avg,worst};
  }).sort((a,b)=>b.tot-a.tot);
  document.getElementById('btStockCount').textContent=`${stockRows.length}개 종목`;
  document.getElementById('btStockTbody').innerHTML=stockRows.map(r=>`<tr><td><strong>${r.name}</strong></td><td style="color:#7A7470">${r.cnt}건</td><td>${fmtPct(r.wr,0)}</td><td class="pos-value">${fmtAmt(r.tot)}</td><td class="pos-value">${fmtPct(r.avg)}</td><td class="pos-dn">${r.worst.toFixed(1)}%</td></tr>`).join('');

  // 거래 상세 내역 (15열)
  document.getElementById('btTradeCount').textContent=allTrades.length;
  const sorted2=[...allTrades].sort((a,b)=>b.exitDate.localeCompare(a.exitDate));
  document.getElementById('btTradeTbody').innerHTML=sorted2.map((t,i)=>{
    const investAmt=t.entryPrice*qty;
    const investStr=fmtMoney(investAmt);
    const daysStr=(t.daysHeld||0)+'일';
    const maxGainStr=t.maxGain>0?`최대 도달: +${t.maxGain}%`:'';
    const detailItems=t.signalDetails?Object.entries(t.signalDetails).filter(([,v])=>v!==0).map(([k,v])=>`<div style="display:flex;justify-content:space-between;padding:2px 0;border-bottom:1px solid #1A1918"><span style="color:#9A9390">${k}</span><span style="color:${v>0?'#4caf50':'#ef5350'};font-weight:600">${v>0?'+':''}${typeof v==='number'?v.toFixed(2):v}</span></div>`).join(''):'';
    return `<tr onclick="btSelectTrade(${i})" class="${_btSelectedTradeIdx===i?'bt-selected':''}">
      <td style="color:#5A5450">${i+1}</td>
      <td>${reasonBadge(t.exitReason)}</td>
      <td style="font-size:11px;font-weight:600">${t.name||''}</td>
      <td style="color:#B898FF;font-size:11px">${t.signalDate||'-'}</td>
      <td style="font-size:11px">${t.entryDate}</td>
      <td>${t.entryPrice.toLocaleString()}</td>
      <td style="color:#7A7470">${qty}주</td>
      <td style="color:#7A7470">${investStr}</td>
      <td style="font-size:11px;color:#7A7470">${t.exitDate}</td>
      <td>${t.exitPrice.toLocaleString()}</td>
      <td class="pos-value">${fmtPct(t.pnlPct)}</td>
      <td class="pos-value" style="font-weight:700">${fmtAmt(t.pnlAmt)}</td>
      <td style="color:#7A7470">${daysStr}</td>
      <td style="color:#B898FF">${t.signalScore||'-'}</td>
      <td style="text-align:center">${detailItems?`<span class="tip-icon" onclick="event.stopPropagation();btShowTip(this,${i})" style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;background:#252320;color:#B898FF;border-radius:50%;font-size:11px;font-weight:700;cursor:pointer;border:1px solid #3A3733;">?</span>`:''}</td>
    </tr>`;
  }).join('');
  // 툴팁 데이터 저장
  _btTipData=sorted2.map(t=>{
    const items=t.signalDetails?Object.entries(t.signalDetails).filter(([,v])=>v!==0).map(([k,v])=>`<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid #1A1918"><span style="color:#9A9390">${k}</span><span style="color:${v>0?'#4caf50':'#ef5350'};font-weight:600">${v>0?'+':''}${typeof v==='number'?v.toFixed(2):v}</span></div>`).join(''):'';
    const maxGain=t.maxGain>0?`<div style="margin-top:8px;color:#f5c842;font-size:11px;">최대 도달: +${t.maxGain}%</div>`:'';
    return items+maxGain;
  });

  // 수익 곡선
  const canvas=document.getElementById('btCurve');if(canvas&&sorted.length){
    const ctx=canvas.getContext('2d');canvas.width=canvas.offsetWidth*devicePixelRatio;canvas.height=canvas.offsetHeight*devicePixelRatio;
    ctx.scale(devicePixelRatio,devicePixelRatio);const w=canvas.offsetWidth,h=canvas.offsetHeight;
    const points=[0,...sorted.map((_,i)=>sorted.slice(0,i+1).reduce((s,t)=>s+t.pnlAmt,0))];
    const minV=Math.min(...points),maxV=Math.max(...points,0.01),range=maxV-minV||1;
    const px=i=>40+(i/(points.length-1))*(w-60),py=v=>h-20-((v-minV)/range)*(h-40);
    ctx.clearRect(0,0,w,h);ctx.strokeStyle='#252320';ctx.lineWidth=1;
    [0.25,0.5,0.75].forEach(t=>{const y=py(minV+range*t);ctx.beginPath();ctx.moveTo(40,y);ctx.lineTo(w-10,y);ctx.stroke();});
    ctx.strokeStyle=points[points.length-1]>=0?'#8050D0':'#ef5350';ctx.lineWidth=2;ctx.beginPath();
    points.forEach((v,i)=>i===0?ctx.moveTo(px(i),py(v)):ctx.lineTo(px(i),py(v)));ctx.stroke();
    ctx.fillStyle=ctx.strokeStyle+'28';ctx.lineTo(px(points.length-1),py(minV));ctx.lineTo(px(0),py(minV));ctx.closePath();ctx.fill();
    ctx.fillStyle='#5A5450';ctx.font='10px sans-serif';ctx.textAlign='right';
    ctx.fillText(maxV.toLocaleString()+'원',36,py(maxV)+4);ctx.fillText(minV.toLocaleString()+'원',36,py(minV)+4);
  }
}

// ── 캔들스틱 차트 (lightweight-charts) ──────────────────────
function renderBtChart(data, trades) {
  const chartCard=document.getElementById('btChartCard');
  chartCard.style.display='block';
  const container=document.getElementById('btChartContainer');
  const volContainer=document.getElementById('btVolumeContainer');
  container.innerHTML=''; volContainer.innerHTML='';

  // 메인 차트
  _btChart=LightweightCharts.createChart(container,{
    width:container.clientWidth, height:420,
    layout:{background:{color:'#141413'},textColor:'#C8C2BC'},
    grid:{vertLines:{color:'#2A2825'},horzLines:{color:'#2A2825'}},
    crosshair:{mode:0},
    timeScale:{borderColor:'#2A2825',timeVisible:false},
    rightPriceScale:{borderColor:'#2A2825'},
  });

  _btCandleSeries=_btChart.addCandlestickSeries({
    upColor:'#ef5350',downColor:'#26a69a',borderUpColor:'#ef5350',borderDownColor:'#26a69a',wickUpColor:'#ef5350',wickDownColor:'#26a69a'
  });

  const candles=data.map(d=>({time:d.date,open:d.open,high:d.high,low:d.low,close:d.close}));
  _btCandleSeries.setData(candles);

  // MA 라인
  _btMA5=_btChart.addLineSeries({color:'#f5c842',lineWidth:1,priceLineVisible:false,lastValueVisible:false});
  _btMA20=_btChart.addLineSeries({color:'#2196f3',lineWidth:1,priceLineVisible:false,lastValueVisible:false});
  _btMA60=_btChart.addLineSeries({color:'#e040fb',lineWidth:1,priceLineVisible:false,lastValueVisible:false});
  _btMA5.setData(data.filter(d=>d.ma5).map(d=>({time:d.date,value:d.ma5})));
  _btMA20.setData(data.filter(d=>d.ma20).map(d=>({time:d.date,value:d.ma20})));
  _btMA60.setData(data.filter(d=>d.ma60).map(d=>({time:d.date,value:d.ma60})));

  // 볼륨 차트
  _btVolChart=LightweightCharts.createChart(volContainer,{
    width:volContainer.clientWidth, height:100,
    layout:{background:{color:'#141413'},textColor:'#7A7470'},
    grid:{vertLines:{color:'#1A1918'},horzLines:{color:'#1A1918'}},
    timeScale:{borderColor:'#2A2825',timeVisible:false,visible:false},
    rightPriceScale:{borderColor:'#2A2825'},
  });
  _btVolSeries=_btVolChart.addHistogramSeries({priceFormat:{type:'volume'}});
  _btVolSeries.setData(data.map(d=>({time:d.date,value:d.volume,color:d.close>=d.open?'rgba(239,83,80,0.35)':'rgba(38,166,154,0.35)'})));

  // 시간축 동기화
  _btChart.timeScale().subscribeVisibleLogicalRangeChange(r=>{if(r)_btVolChart.timeScale().setVisibleLogicalRange(r);});
  _btVolChart.timeScale().subscribeVisibleLogicalRangeChange(r=>{if(r)_btChart.timeScale().setVisibleLogicalRange(r);});

  // 전체 마커 표시
  btShowAllMarkers();

  // 리사이즈
  const ro=new ResizeObserver(()=>{_btChart.applyOptions({width:container.clientWidth});_btVolChart.applyOptions({width:volContainer.clientWidth});});
  ro.observe(container);
}

function btBuildMarkers(trades, mode) {
  const markers=[];
  if(mode==='all') {
    trades.forEach((t,i)=>{
      markers.push({time:t.entryDate,position:'belowBar',color:'#ffeb3b',shape:'arrowUp',text:`#${i+1} 매수 ${t.signalScore}점`});
      const exitColor=t.exitReason==='TARGET'?'#4caf50':t.exitReason==='STOP'?'#ef5350':'#ffc107';
      const exitText=t.exitReason==='TARGET'?`익절 +${t.pnlPct}%`:t.exitReason==='STOP'?`손절 ${t.pnlPct}%`:`만기 ${t.pnlPct}%`;
      markers.push({time:t.exitDate,position:'aboveBar',color:exitColor,shape:'arrowDown',text:exitText});
    });
  } else if(mode==='single' && trades.length===1) {
    const t=trades[0];
    if(t.signalDate){markers.push({time:t.signalDate,position:'aboveBar',color:'#b388ff',shape:'circle',text:`신호 ${t.signalScore}점`});}
    markers.push({time:t.entryDate,position:'belowBar',color:'#ffeb3b',shape:'circle',text:`체결 ${t.entryPrice.toLocaleString()}원`});
    const exitColor=t.exitReason==='TARGET'?'#4caf50':t.exitReason==='STOP'?'#ef5350':'#ffc107';
    const exitText=t.exitReason==='TARGET'?`익절 +${t.pnlPct}%`:t.exitReason==='STOP'?`손절 ${t.pnlPct}%`:`만기 ${t.pnlPct}%`;
    markers.push({time:t.exitDate,position:'aboveBar',color:exitColor,shape:'circle',text:exitText});
  }
  return markers.sort((a,b)=>a.time.localeCompare(b.time));
}

function btShowAllMarkers() {
  if(!_btCandleSeries||!_btAllTrades.length)return;
  _btCandleSeries.setMarkers(btBuildMarkers(_btAllTrades,'all'));
  // 가격선 제거
  btClearPriceLines();
}

function btClearChart() {
  if(_btCandleSeries){_btCandleSeries.setMarkers([]);btClearPriceLines();}
}

function btClearPriceLines() {
  if(!_btCandleSeries)return;
  // lightweight-charts v4: remove all price lines
  try{_btCandleSeries.createPriceLine&&(_btPriceLines||[]).forEach(pl=>{try{_btCandleSeries.removePriceLine(pl);}catch(e){}});}catch(e){}
  _btPriceLines=[];
}
let _btPriceLines=[];

function btSelectTrade(idx) {
  _btSelectedTradeIdx=idx;
  const sorted=[..._btAllTrades].sort((a,b)=>b.exitDate.localeCompare(a.exitDate));
  const t=sorted[idx];
  if(!t||!_btCandleSeries)return;

  // 마커
  _btCandleSeries.setMarkers(btBuildMarkers([t],'single'));

  // 가격선
  btClearPriceLines();
  const entryLine=_btCandleSeries.createPriceLine({price:t.entryPrice,color:'#ffeb3b',lineWidth:2,lineStyle:0,axisLabelVisible:true,title:'체결가'});
  const tpLine=_btCandleSeries.createPriceLine({price:t.targetPrice,color:'#4caf50',lineWidth:1,lineStyle:2,axisLabelVisible:true,title:'목표가'});
  const slLine=_btCandleSeries.createPriceLine({price:t.stopPrice,color:'#ef5350',lineWidth:1,lineStyle:2,axisLabelVisible:true,title:'손절가'});
  _btPriceLines=[entryLine,tpLine,slLine];

  // 해당 구간으로 스크롤
  if(t.signalDate && t.exitDate) {
    const from=new Date(t.signalDate);from.setDate(from.getDate()-5);
    const to=new Date(t.exitDate);to.setDate(to.getDate()+5);
    _btChart.timeScale().setVisibleRange({from:from.toISOString().split('T')[0],to:to.toISOString().split('T')[0]});
  }

  // 선택 행 하이라이트
  document.querySelectorAll('.bt-trade-table tr.bt-selected').forEach(r=>r.classList.remove('bt-selected'));
  const rows=document.querySelectorAll('#btTradeTbody tr');
  if(rows[idx])rows[idx].classList.add('bt-selected');
}

// ── 거래 근거 툴팁 (클릭 기반, position:fixed) ──────────────
let _btTipData=[];
let _btTipEl=null;
function btShowTip(iconEl, idx) {
  // 기존 팝업 제거
  if(_btTipEl){_btTipEl.remove();_btTipEl=null;}
  const html=_btTipData[idx];
  if(!html)return;
  const rect=iconEl.getBoundingClientRect();
  _btTipEl=document.createElement('div');
  _btTipEl.style.cssText='position:fixed;width:340px;background:#252320;border:1px solid #3A3733;border-radius:10px;padding:14px;font-size:12px;color:#C8C2BC;line-height:1.8;z-index:99999;box-shadow:0 8px 32px rgba(0,0,0,.7);max-height:320px;overflow-y:auto;';
  _btTipEl.innerHTML=`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;"><span style="font-weight:700;color:#B898FF;">신호 상세 근거</span><span onclick="btCloseTip()" style="cursor:pointer;color:#5A5450;font-size:16px;">&times;</span></div>${html}`;
  document.body.appendChild(_btTipEl);
  // 위치 계산
  let top=rect.top-_btTipEl.offsetHeight-8;
  if(top<10)top=rect.bottom+8;
  let left=rect.right-_btTipEl.offsetWidth;
  if(left<10)left=10;
  _btTipEl.style.top=top+'px';
  _btTipEl.style.left=left+'px';
}
function btCloseTip(){if(_btTipEl){_btTipEl.remove();_btTipEl=null;}}
document.addEventListener('click',e=>{if(_btTipEl&&!_btTipEl.contains(e.target)&&!e.target.classList.contains('tip-icon'))btCloseTip();});

// ═══════════════════════════════════════════════════════════════
// 손절 분석 탭
// ═══════════════════════════════════════════════════════════════
function renderStopLossTab() {
  const stops = (STATE?.trades || []).filter(t => t.exitReason === 'STOP');
  // 요약
  document.getElementById('slTotal').textContent = stops.length + '건';
  if (stops.length > 0) {
    const avgLoss = stops.reduce((s, t) => s + t.pnlPct, 0) / stops.length;
    const maxLoss = Math.min(...stops.map(t => t.pnlPct));
    document.getElementById('slAvgLoss').textContent = avgLoss.toFixed(1) + '%';
    document.getElementById('slMaxLoss').textContent = maxLoss.toFixed(1) + '%';
  }
  // 최근 5건 승률 (전체 trades 기준)
  const recent5 = (STATE?.trades || []).slice(-5);
  const r5Wins = recent5.filter(t => t.exitReason === 'TARGET').length;
  document.getElementById('slRecent5').textContent = recent5.length ? Math.round(r5Wins / recent5.length * 100) + '%' : '–';
  document.getElementById('slRecent5').style.color = r5Wins / recent5.length >= 0.5 ? '#4caf50' : '#ef5350';

  const tbody = document.getElementById('slTbody');
  if (!stops.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#5A5450;padding:30px;">손절 내역이 없습니다</td></tr>';
    return;
  }
  tbody.innerHTML = stops.reverse().map((t, i) => {
    return `<tr>
      <td style="font-weight:600;">${t.name}<span style="color:#5A5450;font-size:11px;margin-left:4px;">${t.code}</span></td>
      <td>${t.entryDate}</td><td>${t.exitDate}</td>
      <td>${(t.entryPrice||0).toLocaleString()}</td>
      <td>${(t.exitPrice||0).toLocaleString()}</td>
      <td style="color:#ef5350;font-weight:700;">${t.pnlPct}%</td>
      <td>${t.daysHeld||'-'}일</td>
      <td style="font-size:11px;">+${Math.round((t.tp||0.17)*100)}% / -${Math.round((t.sl||0.07)*100)}%</td>
      <td>
        <button class="btn btn-outline btn-sm" style="font-size:10px;padding:2px 8px;color:#90C8FF;border-color:#2A3550;" onclick="slAnalyzeSingle(${i})">AI 분석</button>
        <button class="btn btn-outline btn-sm" style="font-size:10px;padding:2px 8px;color:#B898FF;border-color:#352D45;" onclick="slReoptimize('${t.code}','${t.name}','${t.profileName||'default'}')">재최적화</button>
      </td>
    </tr>`;
  }).join('');
}

async function slAnalyzeSingle(idx) {
  const stops = (STATE?.trades || []).filter(t => t.exitReason === 'STOP').reverse();
  const t = stops[idx];
  if (!t) return;
  const card = document.getElementById('slAnalysisCard');
  card.style.display = 'block';
  document.getElementById('slAnalysisTitle').textContent = `AI 분석 — ${t.name} (${t.pnlPct}%)`;
  document.getElementById('slAnalysisContent').textContent = '분석 중...';
  document.getElementById('slReoptResult').style.display = 'none';

  try {
    // OHLCV 로드
    const ohlcvResp = await fetch(`/api/kis-ohlcv/${t.code}`);
    const ohlcvData = await ohlcvResp.json();
    const recentOhlcv = ohlcvData.ok ? ohlcvData.data.slice(-30) : [];

    const r = await fetch('/api/analyze-stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trade: t, recentOhlcv })
    });
    const d = await r.json();
    document.getElementById('slAnalysisContent').textContent = d.ok ? d.analysis : (d.error || '분석 실패');
  } catch(e) {
    document.getElementById('slAnalysisContent').textContent = '오류: ' + e.message;
  }
}

async function slReoptimize(code, name, profileName) {
  const card = document.getElementById('slAnalysisCard');
  card.style.display = 'block';
  document.getElementById('slAnalysisTitle').textContent = `재최적화 — ${name}`;
  document.getElementById('slAnalysisContent').textContent = '백테스트 그리드서치 실행 중...';
  const reoptDiv = document.getElementById('slReoptResult');
  reoptDiv.style.display = 'none';

  try {
    const resp = await fetch(`/api/kis-ohlcv/${code}`);
    const json = await resp.json();
    if (!json.ok || !json.data || json.data.length < 120) {
      document.getElementById('slAnalysisContent').textContent = '데이터 부족 (최소 120일 필요)';
      return;
    }
    const data = json.data;
    calcIndicatorsV2(data);
    const startIdx = Math.max(60, data.length - 365);
    const opt = autoOptimize(data, profileName, startIdx);

    if (opt && opt.trades > 0) {
      document.getElementById('slAnalysisContent').textContent = '';
      reoptDiv.style.display = 'block';
      const current = STATE.stockParams?.[code] || {};
      const profile = STOCK_PROFILES[profileName] || STOCK_PROFILES.default;
      document.getElementById('slReoptContent').innerHTML = `
        <table style="width:100%;font-size:13px;border-collapse:collapse;">
          <tr style="color:#7A7470;border-bottom:1px solid #2A2825;">
            <th style="padding:4px 0;text-align:left;">파라미터</th>
            <th style="padding:4px 0;">기존</th>
            <th style="padding:4px 0;">신규 (최적)</th>
          </tr>
          <tr><td style="padding:4px 0;">익절(TP)</td><td style="text-align:center;">${Math.round((current.tp || profile.take_profit)*100)}%</td><td style="text-align:center;color:#4caf50;font-weight:600;">${Math.round(opt.tp*100)}%</td></tr>
          <tr><td style="padding:4px 0;">손절(SL)</td><td style="text-align:center;">${Math.round((current.sl || profile.stop_loss)*100)}%</td><td style="text-align:center;color:#4caf50;font-weight:600;">${Math.round(opt.sl*100)}%</td></tr>
          <tr><td style="padding:4px 0;">쿨다운(CD)</td><td style="text-align:center;">${current.cd || profile.cooldown}일</td><td style="text-align:center;color:#4caf50;font-weight:600;">${opt.cd}일</td></tr>
          <tr style="border-top:1px solid #2A2825;"><td style="padding:6px 0;font-weight:600;">성과</td><td colspan="2" style="padding:6px 0;text-align:center;">승률 ${opt.winRate?.toFixed(0)}% · ${opt.trades}건 · EV ${opt.ev?.toFixed(1)}%</td></tr>
        </table>
        <div style="margin-top:10px;">
          <button class="btn btn-sm" style="background:#4caf50;color:#fff;" onclick="slApplyOptParams('${code}',${opt.tp},${opt.sl},${opt.cd})">이 파라미터 적용</button>
        </div>
      `;
    } else {
      document.getElementById('slAnalysisContent').textContent = '최적화 결과가 없습니다 (거래 수 부족)';
    }
  } catch(e) {
    document.getElementById('slAnalysisContent').textContent = '오류: ' + e.message;
  }
}

function slApplyOptParams(code, tp, sl, cd) {
  if (!STATE.stockParams) STATE.stockParams = {};
  STATE.stockParams[code] = { tp, sl, cd };
  saveState();
  alert(`${code} 파라미터 적용: TP ${Math.round(tp*100)}% / SL ${Math.round(sl*100)}% / CD ${cd}일`);
}

async function analyzeAllStops() {
  const stops = (STATE?.trades || []).filter(t => t.exitReason === 'STOP');
  if (!stops.length) { alert('손절 내역이 없습니다'); return; }
  const btn = document.getElementById('analyzeAllStopsBtn');
  const status = document.getElementById('stopAnalysisStatus');
  btn.disabled = true;
  for (let i = 0; i < Math.min(stops.length, 10); i++) {
    status.textContent = `${i+1}/${Math.min(stops.length,10)} 분석 중...`;
    await slAnalyzeSingle(i);
    await new Promise(r => setTimeout(r, 1000));
  }
  status.textContent = '분석 완료';
  btn.disabled = false;
}

// ═══════════════════════════════════════════════════════════════
// Top 30 랭킹
// ═══════════════════════════════════════════════════════════════
let _rankingPollTimer = null;
let _lastRankingResult = [];

async function startRanking() {
  const btn = document.getElementById('rankingStartBtn');
  const status = document.getElementById('rankingStatus');
  btn.disabled = true; status.textContent = '시작 중...';
  try {
    const r = await fetch('/api/ranking/start', { method: 'POST' });
    const d = await r.json();
    if (!d.ok) { status.textContent = d.error; btn.disabled = false; return; }
    document.getElementById('rankingProgressWrap').style.display = 'block';
    _rankingPollTimer = setInterval(pollRankingStatus, 2000);
  } catch(e) { status.textContent = e.message; btn.disabled = false; }
}

async function pollRankingStatus() {
  try {
    const r = await fetch('/api/ranking/status');
    const d = await r.json();
    const pct = d.total > 0 ? Math.round(d.current / d.total * 100) : 0;
    document.getElementById('rankingProgressFill').style.width = pct + '%';
    document.getElementById('rankingProgressCount').textContent = `${d.current} / ${d.total}`;
    document.getElementById('rankingProgressLabel').textContent = `분석 중... (${pct}%)`;
    document.getElementById('rankingEta').textContent = d.eta > 0 ? `예상 ${Math.ceil(d.eta/60)}분 남음` : '';
    document.getElementById('rankingStatus').textContent = `${d.current}/${d.total}`;

    if (d.status === 'done' || d.status === 'error') {
      clearInterval(_rankingPollTimer);
      document.getElementById('rankingProgressWrap').style.display = 'none';
      document.getElementById('rankingStartBtn').disabled = false;
      if (d.status === 'done') {
        document.getElementById('rankingStatus').textContent = '완료!';
        loadRankingResult();
      } else {
        document.getElementById('rankingStatus').textContent = '오류: ' + d.error;
      }
    }
  } catch(e) {}
}

async function loadRankingResult() {
  try {
    const r = await fetch('/api/ranking/result');
    const d = await r.json();
    if (!d.ok) return;
    _lastRankingResult = d.rankings || [];
    renderRankingTable(_lastRankingResult);
  } catch(e) {}
}

function renderRankingTable(rankings) {
  const tbody = document.getElementById('rankingTbody');
  const top30 = rankings.slice(0, 30);
  if (!top30.length) {
    tbody.innerHTML = '<tr><td colspan="13" style="text-align:center;color:#5A5450;padding:30px;">결과 없음</td></tr>';
    return;
  }
  tbody.innerHTML = top30.map((r, i) => {
    const investBadge = r.investable
      ? '<span style="background:#1B3A1B;color:#4caf50;padding:2px 8px;border-radius:8px;font-size:11px;font-weight:600;">투자 진행</span>'
      : '<span style="background:#2A2220;color:#8A8480;padding:2px 8px;border-radius:8px;font-size:11px;">관망</span>';
    const scoreColor = r.composite >= 60 ? '#f5c842' : r.composite >= 40 ? '#ff9800' : '#8A8480';
    const rsiColor = r.rsi >= 70 ? '#f5c842' : r.rsi >= 60 ? '#ff9800' : '#8A8480';
    return `<tr style="cursor:pointer;" onclick="openStockFromRanking('${r.code}','${r.name}')">
      <td style="font-weight:700;color:#f5c842;">${i+1}</td>
      <td>${investBadge}</td>
      <td style="font-weight:600;">${r.name}</td>
      <td style="color:#7A7470;font-size:11px;">${r.code}</td>
      <td style="color:${scoreColor};font-weight:800;font-size:15px;">${r.composite}</td>
      <td>${r.buyScore}</td>
      <td style="color:${rsiColor};font-weight:600;">${r.rsi}</td>
      <td>${r.trendPts}/15</td>
      <td>${r.benfordPts}/15</td>
      <td>${r.volPts}/10</td>
      <td style="font-size:11px;">${r.profileName}</td>
      <td>${r.price?.toLocaleString()}</td>
      <td style="font-size:11px;color:#9A9390;max-width:250px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${r.reason}">${r.reason}</td>
    </tr>`;
  }).join('');

  const investCount = top30.filter(r => r.investable).length;
  document.getElementById('rankingTotal').textContent = `Top 30 중 투자 진행 ${investCount}개 · 관망 ${30-investCount}개`;
  document.getElementById('rankingFooter').style.display = 'flex';
  document.getElementById('emailTop30Btn').style.display = 'inline-block';
  document.getElementById('btVerifyTop30Btn').style.display = 'inline-block';
}

function openStockFromRanking(code, name) {
  // 백테스트 탭으로 이동하고 해당 종목 자동 선택
  switchTab('backtest');
  document.getElementById('btSearchInput').value = name;
  btSelectStock(code, name);
}

async function btVerifyTop30() {
  const btn = document.getElementById('btVerifyTop30Btn');
  const card = document.getElementById('btVerifyResultCard');
  const progressWrap = document.getElementById('btVerifyProgressWrap');
  const progressFill = document.getElementById('btVerifyProgressFill');
  const status = document.getElementById('btVerifyStatus');
  const tbody = document.getElementById('btVerifyTbody');

  btn.disabled = true;
  card.style.display = 'block';
  progressWrap.style.display = 'block';
  tbody.innerHTML = '';

  try {
    const r = await fetch('/api/ranking/result');
    const d = await r.json();
    if (!d.ok || !d.rankings.length) { status.textContent = '랭킹 결과 없음'; btn.disabled = false; return; }

    const candidates = d.rankings.slice(0, 30);
    const results = [];
    let failCount = 0;

    for (let i = 0; i < candidates.length; i++) {
      const { code, name, profileName, composite, reason, investable } = candidates[i];
      status.textContent = `${i+1}/${candidates.length} ${name}`;
      progressFill.style.width = Math.round((i+1)/candidates.length*100) + '%';

      try {
        const resp = await fetch(`/api/kis-ohlcv/${code}`);
        const json = await resp.json();
        if (!json.ok || !json.data || json.data.length < 90) {
          results.push({ code, name, profileName, composite, reason, investable, failed: true, failMsg: `데이터 부족(${json.data?.length||0}일)` });
          failCount++; continue;
        }
        const data = json.data;
        calcIndicatorsV2(data);

        const opt = autoOptimize(data, profileName, Math.max(60, data.length - 365));
        if (!opt || !opt.trades) {
          results.push({ code, name, profileName, composite, reason, investable, failed: true, failMsg: '최적화 실패(거래 부족)' });
          failCount++; continue;
        }

        // EV 계산: 승률 × 평균승 + (1-승률) × 평균패
        const wr = (opt.winRate || 0) / 100;
        const avgWinRet = opt.wins > 0 && opt.avgReturn != null ? Math.max(opt.avgReturn, 0) : 0;
        const avgLossRet = opt.losses > 0 ? Math.min(opt.avgReturn, 0) : 0;
        const ev = opt.avgReturn || 0; // 단순 평균 수익률을 EV로 사용

        results.push({
          code, name, profileName, composite, reason, investable, failed: false,
          trades: opt.trades, winRate: opt.winRate, avgReturn: opt.avgReturn,
          ev, tp: opt.tp, sl: opt.sl, cd: opt.cd,
        });
      } catch(e) {
        results.push({ code, name, profileName, composite, reason, investable, failed: true, failMsg: e.message });
        failCount++;
      }
    }

    // 성공한 것 먼저 (승률 순), 실패한 것 뒤에
    results.sort((a, b) => {
      if (a.failed !== b.failed) return a.failed ? 1 : -1;
      return (b.winRate || 0) - (a.winRate || 0);
    });

    tbody.innerHTML = results.map((r, i) => {
      if (r.failed) {
        return `<tr style="opacity:0.5;">
          <td style="color:#5A5450;">${i+1}</td>
          <td><span style="background:#2A2220;color:#8A8480;padding:2px 8px;border-radius:8px;font-size:11px;">실패</span></td>
          <td>${r.name}</td>
          <td style="font-size:11px;">${r.profileName||''}</td>
          <td colspan="7" style="color:#8A8480;font-size:11px;">${r.failMsg}</td>
          <td style="font-size:11px;color:#5A5450;" title="${r.reason||''}">${(r.reason||'').slice(0,30)}</td>
        </tr>`;
      }
      const investBadge = r.investable && r.winRate >= 50
        ? '<span style="background:#1B3A1B;color:#4caf50;padding:2px 8px;border-radius:8px;font-size:11px;font-weight:600;">투자</span>'
        : '<span style="background:#2A2220;color:#8A8480;padding:2px 8px;border-radius:8px;font-size:11px;">관망</span>';
      const wrColor = r.winRate >= 60 ? '#4caf50' : r.winRate >= 45 ? '#ff9800' : '#ef5350';
      const evColor = r.ev > 0 ? '#4caf50' : '#ef5350';
      return `<tr onclick="openStockFromRanking('${r.code}','${r.name}')" style="cursor:pointer;" title="클릭하면 백테스트 탭에서 상세 분석">
        <td style="font-weight:700;color:#B898FF;">${i+1}</td>
        <td>${investBadge}</td>
        <td style="font-weight:600;">${r.name}</td>
        <td style="font-size:11px;">${r.profileName}</td>
        <td title="최적화 기간 내 총 거래 횟수">${r.trades}</td>
        <td style="color:${wrColor};font-weight:600;" title="익절 거래 비율">${r.winRate?.toFixed(0)}%</td>
        <td title="전체 거래 평균 수익률">${r.avgReturn?.toFixed(1)}%</td>
        <td style="color:${evColor};font-weight:600;" title="1거래당 기대 수익률">${r.ev?.toFixed(1)}%</td>
        <td title="최적 익절 비율">${Math.round((r.tp||0)*100)}%</td>
        <td title="최적 손절 비율">${Math.round((r.sl||0)*100)}%</td>
        <td title="최적 쿨다운 기간">${r.cd||3}일</td>
        <td style="font-size:11px;color:#9A9390;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${r.reason}">${r.reason}</td>
      </tr>`;
    }).join('');

    progressWrap.style.display = 'none';
    status.textContent = `${results.length - failCount}개 검증 완료${failCount ? `, ${failCount}개 실패` : ''}`;
  } catch(e) {
    status.textContent = '오류: ' + e.message;
  }
  btn.disabled = false;
}

async function emailTop30() {
  const btn = document.getElementById('emailTop30Btn');
  btn.disabled = true; btn.textContent = '전송 중...';
  try {
    const r = await fetch('/api/ranking/result');
    const d = await r.json();
    if (d.ok) {
      await sendEmailNotification('top50', d.rankings.slice(0, 30));
      btn.textContent = '전송 완료!';
    }
  } catch(e) { btn.textContent = '전송 실패'; }
  setTimeout(() => { btn.textContent = '이메일 전송'; btn.disabled = false; }, 3000);
}

// ═══════════════════════════════════════════════════════════════
// 실제 계좌 관련
// ═══════════════════════════════════════════════════════════════
async function refreshAccount() {
  const btn = document.getElementById('acctRefreshBtn');
  const status = document.getElementById('acctStatus');
  btn.disabled = true; status.textContent = '조회 중...';
  try {
    const r = await fetch('/api/account/balance');
    const d = await r.json();
    if (!d.ok) throw new Error(d.error);
    document.getElementById('acctDeposit').textContent = d.deposit.toLocaleString() + '원';
    document.getElementById('acctEvalTotal').textContent = d.evalTotal.toLocaleString() + '원';
    document.getElementById('acctPurchase').textContent = d.purchaseAmt.toLocaleString() + '원';
    const pnlEl = document.getElementById('acctPnl');
    pnlEl.textContent = (d.pnlTotal >= 0 ? '+' : '') + d.pnlTotal.toLocaleString() + '원';
    pnlEl.style.color = d.pnlTotal >= 0 ? '#4caf50' : '#ef5350';
    // 보유종목
    const tbody = document.getElementById('acctHoldingsTbody');
    if (!d.holdings.length) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#5A5450;padding:20px;">보유종목 없음</td></tr>';
    } else {
      tbody.innerHTML = d.holdings.map(h => {
        const pColor = h.pnlPct >= 0 ? '#4caf50' : '#ef5350';
        const pSign = h.pnlPct >= 0 ? '+' : '';
        return `<tr>
          <td>${h.name}</td><td>${h.code}</td><td>${h.qty}</td>
          <td>${h.avgPrice.toLocaleString()}</td><td>${h.curPrice.toLocaleString()}</td>
          <td style="color:${pColor};font-weight:600;">${pSign}${h.pnlPct.toFixed(2)}%</td>
          <td style="color:${pColor};">${pSign}${h.pnlAmt.toLocaleString()}원</td>
          <td>
            <button class="btn btn-sm" style="font-size:10px;padding:2px 8px;background:#ef5350;color:#fff;" onclick="quickSell('${h.code}','${h.name}',${h.qty},${h.curPrice})">매도</button>
          </td>
        </tr>`;
      }).join('');
    }
    status.textContent = '갱신 완료';
  } catch(e) {
    status.textContent = e.message;
    status.style.color = '#ef5350';
  }
  btn.disabled = false;
  setTimeout(() => { status.textContent = ''; status.style.color = '#5A5450'; }, 4000);
}

async function submitOrder(side) {
  const code = document.getElementById('orderCode').value.trim();
  const qty = parseInt(document.getElementById('orderQty').value) || 0;
  const price = parseInt(document.getElementById('orderPrice').value) || 0;
  const orderType = document.getElementById('orderType').value;
  const result = document.getElementById('orderResult');
  if (!code || code.length !== 6) { result.textContent = '종목코드 6자리 입력'; result.style.color = '#ef5350'; return; }
  if (qty <= 0) { result.textContent = '수량을 입력하세요'; result.style.color = '#ef5350'; return; }
  if (orderType === 'limit' && price <= 0) { result.textContent = '지정가를 입력하세요'; result.style.color = '#ef5350'; return; }
  const typeLabel = orderType === 'market' ? '시장가' : `${price.toLocaleString()}원`;
  const sideLabel = side === 'buy' ? '매수' : '매도';
  if (!confirm(`${code} ${qty}주 ${typeLabel} ${sideLabel} 주문을 실행합니까?`)) return;
  if (!confirm(`정말 실행합니까? (실제 주문입니다)`)) return;
  result.textContent = '주문 중...'; result.style.color = '#f5c842';
  try {
    const r = await fetch(`/api/account/${side}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, qty, price: orderType === 'market' ? 0 : price, orderType })
    });
    const d = await r.json();
    if (d.ok) { result.textContent = `주문 성공 (주문번호: ${d.ordNo})`; result.style.color = '#4caf50'; }
    else { result.textContent = d.error; result.style.color = '#ef5350'; }
  } catch(e) { result.textContent = e.message; result.style.color = '#ef5350'; }
}

function quickSell(code, name, qty, price) {
  document.getElementById('orderCode').value = code;
  document.getElementById('orderQty').value = qty;
  document.getElementById('orderPrice').value = price;
  document.getElementById('orderType').value = 'limit';
  document.getElementById('orderResult').textContent = `${name} ${qty}주 매도 준비 — 매도 버튼을 눌러주세요`;
  document.getElementById('orderResult').style.color = '#f5c842';
}

async function refreshOrders() {
  try {
    const r = await fetch('/api/account/orders');
    const d = await r.json();
    if (!d.ok) throw new Error(d.error);
    const tbody = document.getElementById('acctOrdersTbody');
    if (!d.orders.length) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#5A5450;padding:20px;">오늘 체결 없음</td></tr>';
    } else {
      tbody.innerHTML = d.orders.map(o => {
        const sColor = o.side === 'BUY' ? '#2962FF' : '#ef5350';
        return `<tr>
          <td>${o.ordNo}</td><td>${o.name||o.code}</td>
          <td style="color:${sColor};font-weight:600;">${o.side === 'BUY' ? '매수' : '매도'}</td>
          <td>${o.ordQty}</td><td>${o.filledQty}</td>
          <td>${o.ordPrice.toLocaleString()}</td><td>${o.avgPrice.toLocaleString()}</td>
          <td>${o.ordTime}</td>
        </tr>`;
      }).join('');
    }
  } catch(e) { console.warn('체결 조회 실패:', e.message); }
}

async function refreshOrderLog() {
  try {
    const r = await fetch('/api/account/order-log');
    const d = await r.json();
    const tbody = document.getElementById('acctLogTbody');
    const logs = (d.logs || []).slice(0, 20);
    if (!logs.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#5A5450;padding:20px;">주문 기록 없음</td></tr>';
    } else {
      tbody.innerHTML = logs.map(l => {
        const color = l.success ? '#4caf50' : '#ef5350';
        return `<tr>
          <td style="font-size:11px;">${l.timestamp?.slice(0,19).replace('T',' ')}</td>
          <td style="color:${l.type==='BUY'?'#2962FF':'#ef5350'};font-weight:600;">${l.type}</td>
          <td>${l.code}</td><td>${l.qty}</td><td>${(l.price||0).toLocaleString()}</td>
          <td style="color:${color};">${l.success ? '성공' : '실패'} ${l.msg||''}</td>
        </tr>`;
      }).join('');
    }
  } catch(e) { console.warn('로그 조회 실패:', e.message); }
}

// ── 툴팁 position:fixed 위치 계산 (overflow 부모에 잘리지 않도록) ──
// CSS :hover 대신 JS mouseover/mouseout으로 show/hide + 위치 제어
let _activeTooltip = null;

document.addEventListener('mouseover', e => {
  const wrap = e.target.closest('.tip-wrap') || e.target.closest('.help-tip');
  if (!wrap) return;
  const box = wrap.querySelector('.tip-box') || wrap.querySelector('.ht-text');
  if (!box || box === _activeTooltip) return;

  // 이전 툴팁 숨기기
  if (_activeTooltip) {
    _activeTooltip.style.visibility = 'hidden';
    _activeTooltip.style.opacity = '0';
  }
  _activeTooltip = box;

  // 위치 계산
  const rect = wrap.getBoundingClientRect();
  // 크기 측정: visibility:hidden 상태에서도 offsetWidth/Height 사용 가능
  const bw = box.offsetWidth || 220;
  const bh = box.offsetHeight || 60;

  let top = rect.top - bh - 8;
  if (top < 8) top = rect.bottom + 8;

  let left = rect.left + rect.width / 2 - bw / 2;
  if (left < 8) left = 8;
  if (left + bw > window.innerWidth - 8) left = window.innerWidth - bw - 8;

  box.style.top = top + 'px';
  box.style.left = left + 'px';
  box.style.visibility = 'visible';
  box.style.opacity = '1';
});

document.addEventListener('mouseout', e => {
  const wrap = e.target.closest('.tip-wrap') || e.target.closest('.help-tip');
  if (!wrap) return;
  // relatedTarget이 같은 wrap 안이면 무시 (내부 이동)
  if (wrap.contains(e.relatedTarget)) return;
  const box = wrap.querySelector('.tip-box') || wrap.querySelector('.ht-text');
  if (!box) return;
  box.style.visibility = 'hidden';
  box.style.opacity = '0';
  if (_activeTooltip === box) _activeTooltip = null;
});

// ── 시작 ─────────────────────────────────────────────────────
loadState();
