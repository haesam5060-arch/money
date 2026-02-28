const express = require('express');
const https   = require('https');
const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const emailService = require('./email-service');
const accountService = require('./account-service');

const app  = express();
const PORT = process.env.PORT || 3000;

// 데이터 디렉토리 보장
const DATA_DIR   = path.join(__dirname, 'data');
const OHLCV_DIR  = path.join(DATA_DIR, 'ohlcv');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const CFG_FILE   = path.join(DATA_DIR, 'config.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(OHLCV_DIR, { recursive: true });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── 상태 저장/로드 ────────────────────────────────────────────
const DEFAULT_STATE = () => ({
  startDate:   null,
  lastScan:    null,
  positions:   [],   // PENDING | IN_POSITION
  trades:      [],   // CLOSED
  scanLog:     [],
  stockParams: {},
});

app.get('/api/state', (req, res) => {
  try {
    const s = fs.existsSync(STATE_FILE)
      ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
      : DEFAULT_STATE();
    res.json(s);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/state', (req, res) => {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(req.body, null, 2), 'utf8');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 설정 저장/로드 ────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  try {
    const c = fs.existsSync(CFG_FILE)
      ? JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'))
      : {};
    res.json(c);
  } catch(e) { res.json({}); }
});

app.post('/api/config', (req, res) => {
  try {
    fs.writeFileSync(CFG_FILE, JSON.stringify(req.body, null, 2), 'utf8');
    // 이메일 서비스 재초기화
    emailService.init(req.body);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 이메일 서비스 ─────────────────────────────────────────────
app.post('/api/test-email', async (req, res) => {
  try {
    const cfg = fs.existsSync(CFG_FILE) ? JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) : {};
    emailService.init(cfg);
    if (!emailService.isReady()) {
      return res.status(400).json({ error: '이메일 설정을 먼저 완료하세요 (수신 이메일, App Password, 활성화)' });
    }
    const result = await emailService.sendTestEmail();
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/send-email', async (req, res) => {
  try {
    if (!emailService.isReady()) return res.status(400).json({ error: '이메일 비활성화' });
    const { type, data } = req.body;
    let result;
    switch(type) {
      case 'buy':      result = await emailService.sendBuyNotification(data); break;
      case 'sell':     result = await emailService.sendSellNotification(data); break;
      case 'stopLoss': result = await emailService.sendStopLossReport(data); break;
      case 'scan':     result = await emailService.sendDailyScanReport(data.results, data.portfolio); break;
      case 'top50':    result = await emailService.sendTop50Report(data); break;
      default: return res.status(400).json({ error: '알 수 없는 이메일 타입: ' + type });
    }
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── KIS API 프록시 ────────────────────────────────────────────
app.post('/api/kis', (req, res) => {
  const { method, url: target, headers, body } = req.body;
  try {
    const u       = new URL(target);
    const bodyStr = body ? JSON.stringify(body) : null;
    const hdrs    = { ...headers };
    if (bodyStr) {
      hdrs['Content-Type']   = 'application/json';
      hdrs['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    const opts = {
      hostname: u.hostname,
      port:     parseInt(u.port) || 443,
      path:     u.pathname + u.search,
      method:   method || 'GET',
      headers:  hdrs,
    };
    const pr = https.request(opts, proxyRes => {
      const chunks = [];
      proxyRes.on('data', c => chunks.push(c));
      proxyRes.on('end', () => {
        try { res.json({ status: proxyRes.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch(e) { res.json({ status: proxyRes.statusCode, data: Buffer.concat(chunks).toString() }); }
      });
    });
    pr.on('error', e => res.json({ status: 0, error: e.message }));
    if (bodyStr) pr.write(bodyStr);
    pr.end();
  } catch(e) { res.json({ status: 0, error: e.message }); }
});

// ── KIS OAuth 토큰 관리 ──────────────────────────────────────
let _kisToken = null;
let _kisTokenExpiry = 0;

function getKisCreds() {
  const cfg = fs.existsSync(CFG_FILE) ? JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) : {};
  return {
    appKey:    cfg.appKey    || process.env.KIS_APP_KEY    || '',
    appSecret: cfg.appSecret || process.env.KIS_APP_SECRET || '',
    cano:      cfg.cano      || process.env.KIS_CANO       || '',
  };
}

function kisGetToken() {
  if (_kisToken && Date.now() < _kisTokenExpiry) return Promise.resolve(_kisToken);
  const { appKey, appSecret } = getKisCreds();
  if (!appKey || !appSecret) return Promise.reject(new Error('KIS App Key / Secret 미설정'));
  const body = JSON.stringify({ grant_type: 'client_credentials', appkey: appKey, appsecret: appSecret });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'openapi.koreainvestment.com', port: 9443,
      path: '/oauth2/tokenP', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const d = JSON.parse(Buffer.concat(chunks).toString());
          if (!d.access_token) throw new Error(d.error_description || '토큰 발급 실패');
          _kisToken = d.access_token;
          _kisTokenExpiry = Date.now() + 23 * 3600 * 1000;
          resolve(_kisToken);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

function kisGetReq(apiPath, params, { token, appKey, appSecret, trId, trCont, ctxFk, ctxNk, returnHeaders } = {}) {
  const query = new URLSearchParams(params).toString();
  const hdrs = {
    'content-type': 'application/json',
    'authorization': `Bearer ${token}`,
    'appkey': appKey, 'appsecret': appSecret, 'tr_id': trId,
  };
  if (trCont) hdrs['tr_cont'] = trCont;
  if (ctxFk) hdrs['ctx_area_fk100'] = ctxFk;
  if (ctxNk) hdrs['ctx_area_nk100'] = ctxNk;

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'openapi.koreainvestment.com', port: 9443,
      path: apiPath + '?' + query, method: 'GET',
      headers: hdrs
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          if (returnHeaders) {
            resolve({ body, headers: res.headers });
          } else {
            resolve(body);
          }
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── OHLCV 일봉 데이터 (네이버 차트 + 로컬 캐시) ──────────────
// 네이버 차트 API로 500일+ 히스토리컬 데이터 다운로드 → 로컬 캐시
// 캐시 24시간 유효, 이후 자동 갱신 (매일 새 데이터 누적)

function fetchNaverOhlcv(code) {
  return new Promise((resolve, reject) => {
    const url = `https://fchart.stock.naver.com/siseJson.nhn?symbol=${code}&requestType=1&startTime=20200101&endTime=20301231&timeframe=day`;
    https.get(url, res => {
      const ch = [];
      res.on('data', c => ch.push(c));
      res.on('end', () => {
        try {
          // 네이버 응답: JS 배열 형식 (싱글쿼트 헤더 + 더블쿼트 데이터)
          let raw = Buffer.concat(ch).toString().trim();
          // 싱글쿼트 → 더블쿼트 변환 후 JSON 파싱
          raw = raw.replace(/'/g, '"');
          const parsed = JSON.parse(raw);
          const rows = parsed
            .filter(r => Array.isArray(r) && r.length >= 6 && /^\d{8}$/.test(String(r[0]).replace(/"/g,'').trim()))
            .map(r => {
              const ds = String(r[0]).replace(/"/g, '').trim();
              return {
                date: `${ds.slice(0,4)}-${ds.slice(4,6)}-${ds.slice(6,8)}`,
                open: parseInt(r[1]) || 0,
                high: parseInt(r[2]) || 0,
                low: parseInt(r[3]) || 0,
                close: parseInt(r[4]) || 0,
                volume: parseInt(r[5]) || 0,
              };
            })
            .filter(d => d.close > 0);
          rows.sort((a, b) => a.date.localeCompare(b.date));
          resolve(rows);
        } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

app.get('/api/kis-ohlcv/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const cacheFile = path.join(OHLCV_DIR, `${code}.json`);
    const MAX_AGE = 12 * 3600 * 1000; // 12시간 캐시

    // 캐시 확인
    let cached = null;
    if (fs.existsSync(cacheFile)) {
      try {
        const stat = fs.statSync(cacheFile);
        if (Date.now() - stat.mtimeMs < MAX_AGE) {
          cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        }
      } catch(e) { /* 캐시 손상 무시 */ }
    }

    if (cached && cached.length > 0) {
      return res.json({ ok: true, data: cached });
    }

    // 네이버 차트에서 다운로드
    const rows = await fetchNaverOhlcv(code);

    // 캐시 저장
    if (rows.length > 0) {
      fs.writeFileSync(cacheFile, JSON.stringify(rows), 'utf8');
    }

    res.json({ ok: true, data: rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── KIS KOSPI 전종목 목록 (시가총액 순위) ─────────────────────
// 종목 목록 캐시 (서버 레벨, 24시간 유지)
let _allStocksCache = null;
let _allStocksCacheTs = 0;

// ── ETF / 특수증권 필터 ────────────────────────────────────
const ETF_KEYWORDS = [
  'ETF', 'ETN', 'KODEX', 'TIGER', 'KBSTAR', 'ARIRANG', 'SOL', 'HANARO',
  'ACE', 'KOSEF', 'KINDEX', 'SMART', 'FOCUS', 'TIMEFOLIO', 'WOORI',
  'TREX', 'VITA', 'PLUS', 'RISE', 'BNK',
  '인버스', '레버리지', '선물', '채권', '단기자금', '머니마켓',
  '스팩', 'SPAC', '리츠', 'REIT', '인프라', '우선주',
];
const ETF_KEYWORD_RE = new RegExp(ETF_KEYWORDS.join('|'), 'i');
const ETF_SUFFIX_RE = /\s+(MF|IN|EW|BW|EF|BC|DR|SW|SR|RT)$/i;

function isETF(name) {
  return ETF_KEYWORD_RE.test(name) || ETF_SUFFIX_RE.test(name);
}

// ── KRX 종목 마스터 다운로드 (인증 불필요, 전체 종목 한번에) ────
const zlib = require('zlib');

function downloadMstZip(url) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    proto.get(url, { rejectUnauthorized: false }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadMstZip(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function parseMstBuffer(buf, market) {
  // MST 파일은 CP949(EUC-KR) 인코딩, 종목코드 + 한글명이 앞부분에 있음
  // 포맷: 단축코드(6) + 표준코드(12) + 한글명(가변, \n으로 구분)
  const stocks = [];
  try {
    const text = require('iconv-lite') ? null : null; // fallback below
    // iconv-lite가 없을 수 있으므로 Buffer 직접 파싱
    let offset = 0;
    while (offset < buf.length) {
      // 각 라인에서 단축코드 6자리, 표준코드 12자리, 한글명 추출
      const lineEnd = buf.indexOf(0x0A, offset); // \n
      if (lineEnd === -1) break;
      const line = buf.slice(offset, lineEnd);
      offset = lineEnd + 1;
      if (line.length < 20) continue;

      // 단축코드: 처음 6바이트 (ASCII)
      const shortCode = line.slice(0, 6).toString('ascii').trim();
      if (!shortCode || shortCode.length !== 6) continue;
      // 숫자로만 구성된 종목코드만
      if (!/^\d{6}$/.test(shortCode)) continue;

      // 표준코드: 다음 12바이트
      // 한글명: 그 뒤부터 가변 길이 (CP949 인코딩)
      // 한글명 끝은 228바이트 고정폭 데이터 시작 전
      // 간단 파싱: 표준코드 뒤 한글명은 첫 번째 제어문자나 특수 구분까지
      const afterCode = line.slice(18); // 6+12 = 18
      // 한글명은 CP949로 인코딩되어 있음 → 바이트 단위로 읽어야 함
      // 이름 길이는 가변이지만 보통 40바이트 이내
      let nameEnd = 0;
      for (let i = 0; i < Math.min(40, afterCode.length); i++) {
        // 0x20 미만(제어문자)이거나 특정 ASCII 패턴이면 이름 끝
        if (afterCode[i] < 0x20 && afterCode[i] !== 0) { nameEnd = i; break; }
        nameEnd = i + 1;
      }
      // CP949 → UTF-8 변환 (Node.js에서 iconv 없이는 어려움)
      // fallback: latin1으로 읽고 나중에 처리
      const rawName = afterCode.slice(0, nameEnd);

      stocks.push({ code: shortCode, rawName, market });
    }
  } catch(e) { console.warn('MST parse error:', e.message); }
  return stocks;
}

async function fetchAllKisStocks(token, appKey, appSecret) {
  // 캐시 유효하면 바로 반환 (24시간)
  if (_allStocksCache && _allStocksCache.length > 0 && Date.now() - _allStocksCacheTs < 86400000) return _allStocksCache;

  const allStocks = [];
  const seen = new Set();

  // 방법 1: KRX 종목마스터 ZIP 다운로드 시도
  let mstLoaded = false;
  try {
    const iconv = (() => { try { return require('iconv-lite'); } catch(e) { return null; } })();
    const AdmZip = (() => { try { return require('adm-zip'); } catch(e) { return null; } })();

    if (iconv && AdmZip) {
      for (const [url, market] of [
        ['https://new.real.download.dws.co.kr/common/master/kospi_code.mst.zip', 'KOSPI'],
        ['https://new.real.download.dws.co.kr/common/master/kosdaq_code.mst.zip', 'KOSDAQ'],
      ]) {
        try {
          const zipBuf = await downloadMstZip(url);
          const zip = new AdmZip(zipBuf);
          const entries = zip.getEntries();
          if (entries.length > 0) {
            const mstBuf = entries[0].getData();
            const text = iconv.decode(mstBuf, 'cp949');
            const lines = text.split('\n');
            for (const line of lines) {
              if (line.length < 20) continue;
              const shortCode = line.substring(0, 6).trim();
              if (!/^\d{6}$/.test(shortCode)) continue;
              if (seen.has(shortCode)) continue;
              // 한글명: 18바이트 이후, 가변 길이
              const rest = line.substring(18);
              // MST 포맷: 숫자3자리 + 한글종목명 + 공백패딩 + 영문 구분자
              // 예: "002카카오                                  ST"
              // 숫자 3자리 건너뛰고 한글명 추출
              let nameStart = 0;
              // 앞의 숫자 건너뛰기
              while (nameStart < rest.length && rest[nameStart] >= '0' && rest[nameStart] <= '9') nameStart++;
              let nameStr = rest.substring(nameStart);
              // 이름 끝: 연속 공백 또는 영문 대문자 구분자
              const nameMatch = nameStr.match(/^([^\x00-\x1f]+?)[\s]{2,}/);
              let name = nameMatch ? nameMatch[1].trim() : nameStr.substring(0, 30).trim();
              // ETF/특수증권 필터 (접미사 제거 전에 체크)
              if (isETF(name)) continue;
              // 영문 접미사 제거 (ST 등)
              name = name.replace(/\s+(ST|MF|RT|IN|BC|DR|SW|SR|EW|BW|EF)$/i, '').trim();
              if (!name || name.length < 2) continue;
              // 접미사 제거 후 다시 체크
              if (isETF(name)) continue;
              seen.add(shortCode);
              allStocks.push({ code: shortCode, name, market });
            }
          }
        } catch(e) { console.warn(`[MST] ${market} 다운로드 실패:`, e.message); }
      }
      if (allStocks.length > 100) {
        mstLoaded = true;
        console.log(`[MST] 종목 마스터 로드 완료: ${allStocks.length}개 (KOSPI+KOSDAQ)`);
      }
    }
  } catch(e) { console.warn('[MST] 로드 실패:', e.message); }

  // 방법 2: MST 실패 시 KIS API 시총순위로 폴백
  if (!mstLoaded) {
    console.log('[KIS] MST 실패 → KIS API 시총순위로 종목 로드 (iconv-lite, adm-zip 설치 필요)');
    const apiPath = '/uapi/domestic-stock/v1/ranking/market-cap';
    const priceRanges = [
      [0, 5000], [5000, 12000], [12000, 25000], [25000, 50000],
      [50000, 110000], [110000, 300000], [300000, 99999999],
    ];
    const markets = ['J', 'Q'];
    for (const mkt of markets) {
      for (const [p1, p2] of priceRanges) {
        try {
          const result = await kisGetReq(apiPath, {
            fid_cond_mrkt_div_code: mkt,
            fid_cond_scr_div_code: '20171',
            fid_input_iscd: mkt === 'Q' ? '0002' : '0001',
            fid_div_cls_code: '0', fid_blng_cls_code: '0',
            fid_trgt_cls_code: '111111111', fid_trgt_exls_cls_code: '000000',
            fid_input_price_1: String(p1), fid_input_price_2: String(p2),
            fid_vol_cnt: '', fid_input_date_1: '',
          }, { token, appKey, appSecret, trId: 'FHPST01710000' });
          if (result.rt_cd !== '0') continue;
          for (const s of (result.output || [])) {
            const code = (s.mksc_shrn_iscd || '').trim();
            const name = (s.hts_kor_isnm || '').trim();
            if (!code || !name || seen.has(code)) continue;
            if (isETF(name)) continue;
            seen.add(code);
            allStocks.push({
              code, name, market: mkt === 'J' ? 'KOSPI' : 'KOSDAQ',
              price: parseInt(s.stck_prpr) || 0,
              changePct: parseFloat(s.prdy_ctrt) || 0,
            });
          }
        } catch(e) {}
        await new Promise(r => setTimeout(r, 200));
      }
    }
  }

  if (allStocks.length > 0) {
    _allStocksCache = allStocks;
    _allStocksCacheTs = Date.now();
    console.log(`[KIS] 종목 목록 캐시 완료: ${allStocks.length}개`);
  }
  return allStocks;
}

app.get('/api/kis-stocks', async (req, res) => {
  try {
    let stocks = _allStocksCache;
    if (!stocks || !stocks.length) {
      stocks = await fetchAllKisStocks(null, null, null);
    }

    // 가격대 필터 (벤포드 법칙 프리셋용)
    const priceMin = parseInt(req.query.priceMin) || 0;
    const priceMax = parseInt(req.query.priceMax) || 0;
    if (priceMin > 0 || priceMax > 0) {
      stocks = stocks.filter(s => {
        if (priceMin > 0 && s.price < priceMin) return false;
        if (priceMax > 0 && s.price > priceMax) return false;
        return true;
      });
    }

    res.json({ ok: true, stocks, total: stocks.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── KIS 현재가 조회 (FHKST01010100) ─────────────────────────
app.get('/api/kis-price/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const token = await kisGetToken();
    const { appKey, appSecret } = getKisCreds();
    const result = await kisGetReq(
      '/uapi/domestic-stock/v1/quotations/inquire-price',
      { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code },
      { token, appKey, appSecret, trId: 'FHKST01010100' }
    );
    if (result.rt_cd !== '0') return res.status(502).json({ error: result.msg1 });
    const o = result.output;
    res.json({
      ok: true,
      data: {
        price:     parseInt(o.stck_prpr) || 0,         // 현재가
        change:    parseInt(o.prdy_vrss) || 0,          // 전일 대비
        changePct: parseFloat(o.prdy_ctrt) || 0,        // 등락률 %
        volume:    parseInt(o.acml_vol) || 0,            // 누적 거래량
        open:      parseInt(o.stck_oprc) || 0,
        high:      parseInt(o.stck_hgpr) || 0,
        low:       parseInt(o.stck_lwpr) || 0,
        high52w:   parseInt(o.stck_dryc_hgpr) || 0,     // 52주 최고
        low52w:    parseInt(o.stck_dryc_lwpr) || 0,      // 52주 최저
        marketCap: parseInt(o.hts_avls) || 0,            // 시가총액 (억)
        per:       parseFloat(o.per) || 0,
        pbr:       parseFloat(o.pbr) || 0,
      }
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── KIS 호가 조회 (FHKST01010200) ───────────────────────────
app.get('/api/kis-ask/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const token = await kisGetToken();
    const { appKey, appSecret } = getKisCreds();
    const result = await kisGetReq(
      '/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn',
      { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code },
      { token, appKey, appSecret, trId: 'FHKST01010200' }
    );
    if (result.rt_cd !== '0') return res.status(502).json({ error: result.msg1 });
    const o1 = result.output1 || {};
    const o2 = result.output2 || {};
    // 매도호가 1~10, 매수호가 1~10
    const asks = [], bids = [];
    for (let i = 1; i <= 10; i++) {
      asks.push({ price: parseInt(o1[`askp${i}`]) || 0, qty: parseInt(o1[`askp_rsqn${i}`]) || 0 });
      bids.push({ price: parseInt(o1[`bidp${i}`]) || 0, qty: parseInt(o1[`bidp_rsqn${i}`]) || 0 });
    }
    res.json({
      ok: true,
      data: {
        asks: asks.filter(a => a.price > 0),
        bids: bids.filter(b => b.price > 0),
        totalAskQty: parseInt(o2.total_askp_rsqn) || 0,
        totalBidQty: parseInt(o2.total_bidp_rsqn) || 0,
      }
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── KIS 지수 일봉 (KOSPI 등 — regime filter용) ──────────────
let _indexCache = {};  // code → { data, ts }
app.get('/api/kis-index-ohlcv', async (req, res) => {
  try {
    const code = req.query.code || '0001';  // 0001 = KOSPI
    const days = parseInt(req.query.days) || 400;

    // 24시간 캐시
    if (_indexCache[code] && Date.now() - _indexCache[code].ts < 24 * 3600 * 1000) {
      return res.json({ ok: true, data: _indexCache[code].data });
    }

    const token = await kisGetToken();
    const { appKey, appSecret } = getKisCreds();
    const fmt = d => new Date(d).toISOString().slice(0, 10).replace(/-/g, '');
    const CHUNK = 120;
    const endMs = Date.now();
    const allRows = [];
    const seen = new Set();

    for (let off = 0; off < days; off += CHUNK) {
      const chunkEnd = endMs - off * 24 * 3600 * 1000;
      const chunkStart = endMs - Math.min(off + CHUNK, days) * 24 * 3600 * 1000;
      const result = await kisGetReq(
        '/uapi/domestic-stock/v1/quotations/inquire-daily-indexchartprice',
        {
          FID_COND_MRKT_DIV_CODE: 'U',
          FID_INPUT_ISCD:         code,
          FID_INPUT_DATE_1:       fmt(chunkStart),
          FID_INPUT_DATE_2:       fmt(chunkEnd),
          FID_PERIOD_DIV_CODE:    'D',
        },
        { token, appKey, appSecret, trId: 'FHKUP03500100' }
      );
      if (result.rt_cd !== '0') continue;
      for (const d of (result.output2 || [])) {
        const ds = d.stck_bsop_date;
        if (!ds || seen.has(ds)) continue;
        seen.add(ds);
        const close = parseFloat(d.bstp_nmix_prpr) || 0;
        if (close <= 0) continue;
        allRows.push({
          date:   `${ds.slice(0,4)}-${ds.slice(4,6)}-${ds.slice(6,8)}`,
          open:   parseFloat(d.bstp_nmix_oprc) || close,
          high:   parseFloat(d.bstp_nmix_hgpr) || close,
          low:    parseFloat(d.bstp_nmix_lwpr) || close,
          close,
          volume: parseInt(d.acml_vol) || 0,
        });
      }
    }

    allRows.sort((a, b) => a.date.localeCompare(b.date));
    _indexCache[code] = { data: allRows, ts: Date.now() };
    res.json({ ok: true, data: allRows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── KIS 종목 검색 ────────────────────────────────────────────
// MST 마스터 캐시에서 서버사이드 필터링 (토큰 불필요)
app.get('/api/kis-search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    if (!q) return res.json({ ok: true, results: [] });

    // MST 캐시가 있으면 바로 사용, 없으면 로드
    let list = _allStocksCache;
    if (!list || !list.length) {
      list = await fetchAllKisStocks(null, null, null);
    }

    const results = (list || [])
      .filter(s => s.name.toLowerCase().includes(q) || s.code.includes(q))
      .slice(0, 20)
      .map((s, i) => ({ ...s, rank: i + 1 }));

    res.json({ ok: true, results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── KIS 등락률 순위 ──────────────────────────────────────────
app.get('/api/kis-ranking', async (req, res) => {
  try {
    const type = req.query.type || 'rise';  // rise | fall | volume
    const token = await kisGetToken();
    const { appKey, appSecret } = getKisCreds();

    // 등락률 순위: FHPST01700000
    const result = await kisGetReq(
      '/uapi/domestic-stock/v1/ranking/fluctuation',
      {
        fid_cond_mrkt_div_code: 'J',
        fid_cond_scr_div_code:  '20170',
        fid_input_iscd:         '0001',
        fid_rank_sort_cls_code: type === 'fall' ? '1' : '0',  // 0=상승, 1=하락
        fid_input_cnt_1:        '0',
        fid_prc_cls_code:       '0',
        fid_input_price_1:      '',
        fid_input_price_2:      '',
        fid_vol_cnt:            '',
        fid_trgt_cls_code:      '111111111',
        fid_trgt_exls_cls_code: '000000',
        fid_div_cls_code:       '0',
        fid_rsfl_rate1:         '',
        fid_rsfl_rate2:         '',
      },
      { token, appKey, appSecret, trId: 'FHPST01700000' }
    );
    if (result.rt_cd !== '0') return res.status(502).json({ error: result.msg1 });

    const stocks = (result.output || []).slice(0, 30).map(s => ({
      code: (s.mksc_shrn_iscd || s.stck_shrn_iscd || '').trim(),
      name: (s.hts_kor_isnm || '').trim(),
      price: parseInt(s.stck_prpr) || 0,
      changePct: parseFloat(s.prdy_ctrt) || 0,
      volume: parseInt(s.acml_vol) || 0,
    }));

    res.json({ ok: true, stocks });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 손절 AI 분석 (Anthropic API) ─────────────────────────────
app.post('/api/analyze-stop', (req, res) => {
  const cfg = fs.existsSync(CFG_FILE) ? JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) : {};
  const apiKey = cfg.anthropicKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'Anthropic API Key 없음. 설정에서 입력하세요.' });

  const { trade, recentOhlcv } = req.body;

  // 최근 20일 시장 요약 (서버에서 텍스트로 변환)
  const ohlcvSummary = (recentOhlcv || []).slice(-20).map(d =>
    `${d.date} O:${d.open} H:${d.high} L:${d.low} C:${d.close} V:${d.volume}`
  ).join('\n');

  const prompt = `당신은 주식 트레이딩 전략 분석 전문가입니다.
아래는 방금 손절(Stop Loss)이 발생한 거래입니다. 원인을 분석하고 로직 개선 방안을 제시해주세요.

## 거래 정보
- 종목: ${trade.name} (${trade.code})
- 진입일: ${trade.entryDate}
- 청산일: ${trade.exitDate}
- 진입가: ${trade.entryPrice?.toLocaleString()}원
- 손절가: ${trade.exitPrice?.toLocaleString()}원
- 손실률: ${trade.pnlPct}%
- 보유기간: ${trade.daysHeld || Math.ceil((new Date(trade.exitDate)-new Date(trade.entryDate))/86400000)}일
- 진입 신호 강도: ${trade.signalScore || '알 수 없음'}점
- TP 설정: +${Math.round((trade.tp||0.08)*100)}%
- SL 설정: -${Math.round((trade.sl||0.05)*100)}%

## 최근 20일 OHLCV (손절 전후 포함)
${ohlcvSummary}

## 분석 요청
다음 형식으로 답변하세요:

**손절 원인 분석**
(2~3문장으로 핵심 원인)

**개선 방안** (최대 3개, 각각 적용 가능한 구체적인 파라미터 변경 포함)
1. [방안 제목]: [설명] → 파라미터: {key: 값} 형태로 JSON 명시
2. ...
3. ...

**우선 적용 추천**
어떤 방안을 먼저 적용할지 1줄로 추천`;

  const bodyStr = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }]
  });

  const opts = {
    hostname: 'api.anthropic.com',
    port: 443,
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(bodyStr),
    }
  };

  const pr = https.request(opts, proxyRes => {
    const chunks = [];
    proxyRes.on('data', c => chunks.push(c));
    proxyRes.on('end', () => {
      try {
        const data = JSON.parse(Buffer.concat(chunks).toString());
        const text = data.content?.[0]?.text || '분석 결과 없음';
        res.json({ ok: true, analysis: text });
      } catch(e) {
        res.status(500).json({ error: '응답 파싱 실패: ' + e.message });
      }
    });
  });
  pr.on('error', e => res.status(500).json({ error: e.message }));
  pr.write(bodyStr);
  pr.end();
});

// ── 캐시 초기화 API (디버그용) ───────────────────────────────
app.get('/api/cache-reset', (req, res) => {
  _allStocksCache = null;
  _allStocksCacheTs = 0;
  res.json({ ok: true, msg: 'Cache reset' });
});

// ── OHLCV 캐시 상태 조회 ─────────────────────────────────────
app.get('/api/cache-status', (req, res) => {
  try {
    const files = fs.readdirSync(OHLCV_DIR).filter(f => f.endsWith('.json'));
    let newest = 0, oldest = Infinity;
    for (const f of files) {
      const mtime = fs.statSync(path.join(OHLCV_DIR, f)).mtimeMs;
      if (mtime > newest) newest = mtime;
      if (mtime < oldest) oldest = mtime;
    }
    res.json({
      ok: true,
      count: files.length,
      newestTime: newest > 0 ? new Date(newest).toISOString() : null,
      oldestTime: oldest < Infinity ? new Date(oldest).toISOString() : null,
      newestAgeMin: newest > 0 ? Math.round((Date.now() - newest) / 60000) : null,
    });
  } catch(e) { res.json({ ok: true, count: 0, newestTime: null }); }
});

// ── OHLCV 캐시 초기화 ────────────────────────────────────────
app.post('/api/cache-clear-ohlcv', (req, res) => {
  try {
    const files = fs.readdirSync(OHLCV_DIR).filter(f => f.endsWith('.json'));
    for (const f of files) fs.unlinkSync(path.join(OHLCV_DIR, f));
    res.json({ ok: true, deleted: files.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 상태 백업/복원 ───────────────────────────────────────────
const BACKUP_FILE = path.join(DATA_DIR, 'state.backup.json');

app.post('/api/state-backup', (req, res) => {
  try {
    if (fs.existsSync(STATE_FILE)) {
      fs.copyFileSync(STATE_FILE, BACKUP_FILE);
      res.json({ ok: true });
    } else {
      res.json({ ok: false, error: '상태 파일 없음' });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/state-restore', (req, res) => {
  try {
    if (!fs.existsSync(BACKUP_FILE)) return res.status(400).json({ error: '백업 파일 없음' });
    fs.copyFileSync(BACKUP_FILE, STATE_FILE);
    const restored = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    res.json({ ok: true, state: restored });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── KIS 실제 계좌 API ───────────────────────────────────────
app.get('/api/account/balance', async (req, res) => {
  try {
    const token = await kisGetToken();
    const { appKey, appSecret, cano } = getKisCreds();
    if (!cano) return res.status(400).json({ error: '계좌번호 미설정' });
    const data = await accountService.getBalance(token, appKey, appSecret, cano);
    res.json({ ok: true, ...data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/account/buy', async (req, res) => {
  try {
    const token = await kisGetToken();
    const { appKey, appSecret, cano } = getKisCreds();
    if (!cano) return res.status(400).json({ error: '계좌번호 미설정' });
    const { code, qty, price, orderType } = req.body;
    if (!code || !qty) return res.status(400).json({ error: '종목코드, 수량 필수' });
    const result = await accountService.orderBuy(token, appKey, appSecret, cano, { code, qty, price, orderType: orderType || 'limit' });
    // 이메일 알림
    if (emailService.isReady()) {
      emailService.sendBuyNotification({ code, name: req.body.name || code, limitPrice: price, signalScore: '-', signalDate: new Date().toISOString().split('T')[0], profileName: 'manual' });
    }
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/account/sell', async (req, res) => {
  try {
    const token = await kisGetToken();
    const { appKey, appSecret, cano } = getKisCreds();
    if (!cano) return res.status(400).json({ error: '계좌번호 미설정' });
    const { code, qty, price, orderType } = req.body;
    if (!code || !qty) return res.status(400).json({ error: '종목코드, 수량 필수' });
    const result = await accountService.orderSell(token, appKey, appSecret, cano, { code, qty, price, orderType: orderType || 'limit' });
    // 이메일 알림
    if (emailService.isReady()) {
      emailService.sendSellNotification({ code, name: req.body.name || code, entryPrice: req.body.entryPrice || price, exitPrice: price, exitReason: 'MANUAL', entryDate: req.body.entryDate || '-', exitDate: new Date().toISOString().split('T')[0], pnlPct: req.body.pnlPct || 0, pnlAmt: req.body.pnlAmt || 0, daysHeld: req.body.daysHeld || 0 });
    }
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/account/orders', async (req, res) => {
  try {
    const token = await kisGetToken();
    const { appKey, appSecret, cano } = getKisCreds();
    if (!cano) return res.status(400).json({ error: '계좌번호 미설정' });
    const data = await accountService.getOrders(token, appKey, appSecret, cano, {
      startDate: req.query.startDate, endDate: req.query.endDate
    });
    res.json({ ok: true, orders: data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/account/order-log', (req, res) => {
  res.json({ ok: true, logs: accountService.getOrderLog() });
});

// ── Top 30 랭킹 (서버 사이드 백그라운드 스캔) ────────────────
const signalEngine = require('./public/signal-engine');
let _rankingJob = null; // { status, current, total, results, startTime, error }

function serverAutoDetectProfile(data) {
  // ATR% 기반 프로필 자동 감지 (app.js의 autoDetectProfile과 동일 로직)
  let atrSum = 0, cnt = 0;
  for (let i = 1; i < data.length; i++) {
    const tr = Math.max(data[i].high - data[i].low, Math.abs(data[i].high - data[i-1].close), Math.abs(data[i].low - data[i-1].close));
    atrSum += tr / data[i-1].close; cnt++;
  }
  return (atrSum / cnt) < 0.025 ? 'large_cap' : 'default';
}

app.post('/api/ranking/start', async (req, res) => {
  if (_rankingJob && _rankingJob.status === 'running') {
    return res.json({ ok: false, error: '이미 스캔 진행 중', jobId: _rankingJob.startTime });
  }
  const cfg = fs.existsSync(CFG_FILE) ? JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) : {};
  const priceMin = parseInt(req.body.priceMin) || 0;
  const priceMax = parseInt(req.body.priceMax) || 0;
  _rankingJob = { status: 'running', current: 0, total: 0, results: [], startTime: Date.now(), error: null };
  res.json({ ok: true, jobId: _rankingJob.startTime });

  // 백그라운드 실행
  (async () => {
    try {
      let stocks = _allStocksCache;
      if (!stocks || !stocks.length) stocks = await fetchAllKisStocks(null, null, null);
      _rankingJob.total = stocks.length;
      const BATCH = 5;
      const rankings = [];

      for (let i = 0; i < stocks.length; i += BATCH) {
        const batch = stocks.slice(i, i + BATCH);
        // 배치 병렬 OHLCV 다운로드
        const ohlcvBatch = await Promise.all(batch.map(async ({ code }) => {
          try {
            const cacheFile = path.join(OHLCV_DIR, `${code}.json`);
            const MAX_AGE = 12 * 3600 * 1000;
            if (fs.existsSync(cacheFile)) {
              const stat = fs.statSync(cacheFile);
              if (Date.now() - stat.mtimeMs < MAX_AGE) {
                return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
              }
            }
            const rows = await fetchNaverOhlcv(code);
            if (rows.length > 0) fs.writeFileSync(cacheFile, JSON.stringify(rows), 'utf8');
            return rows;
          } catch(e) { return null; }
        }));

        for (let j = 0; j < batch.length; j++) {
          const { code, name, market } = batch[j];
          const data = ohlcvBatch[j];
          _rankingJob.current = i + j + 1;
          if (!data || data.length < 62) continue;
          // 가격대 필터: OHLCV 최신 종가 기준
          const lastClose = data[data.length - 1].close;
          if (priceMin > 0 && lastClose < priceMin) continue;
          if (priceMax > 0 && lastClose > priceMax) continue;
          try {
            signalEngine.calcIndicatorsV2(data);
            const profileName = cfg.defaultProfile === 'auto'
              ? serverAutoDetectProfile(data)
              : (cfg.defaultProfile || 'default');
            const result = signalEngine.calcCompositeRankScore(data, data.length - 1, profileName, {
              threshold: cfg.threshold || 4.5,
              benfordInfluence: cfg.benfordInfluence || 0.15,
              benfordWindow: cfg.benfordWindow || 30,
              benfordMinHits: cfg.benfordMinHits || 3,
            });
            if (result && result.composite > 0) {
              const lastCandle = data[data.length - 1];
              const { pendingLimit, tpLevel } = signalEngine.calcDynamicPrices(data, data.length - 1,
                signalEngine.STOCK_PROFILES[profileName]?.take_profit || 0.17,
                signalEngine.STOCK_PROFILES[profileName]?.stop_loss || 0.07);
              rankings.push({
                code, name, market, profileName,
                ...result,
                price: lastCandle.close,
                entryPrice: pendingLimit || lastCandle.close,
                tpLevel,
              });
            }
          } catch(e) { /* 개별 오류 무시 */ }
        }
      }

      rankings.sort((a, b) => b.composite - a.composite);
      _rankingJob.results = rankings.slice(0, 100); // 상위 100개 보관
      _rankingJob.status = 'done';
      console.log(`[RANKING] 완료: ${rankings.length}개 중 Top ${_rankingJob.results.length}개`);

      // 이메일 발송
      if (emailService.isReady()) {
        emailService.sendTop50Report(_rankingJob.results.slice(0, 30));
      }
    } catch(e) {
      _rankingJob.status = 'error';
      _rankingJob.error = e.message;
      console.error('[RANKING] 오류:', e.message);
    }
  })();
});

app.get('/api/ranking/status', (req, res) => {
  if (!_rankingJob) return res.json({ status: 'idle' });
  const elapsed = Date.now() - _rankingJob.startTime;
  const eta = _rankingJob.current > 0 ? Math.round((elapsed / _rankingJob.current) * (_rankingJob.total - _rankingJob.current) / 1000) : 0;
  res.json({
    status: _rankingJob.status,
    current: _rankingJob.current,
    total: _rankingJob.total,
    eta,
    error: _rankingJob.error,
  });
});

app.get('/api/ranking/result', (req, res) => {
  if (!_rankingJob || _rankingJob.status !== 'done') {
    return res.json({ ok: false, error: '결과 없음 (스캔 먼저 실행)' });
  }
  res.json({ ok: true, rankings: _rankingJob.results });
});

// ── 매매 로직 문서화 ─────────────────────────────────────────
app.get('/api/trading-doc/generate', (req, res) => {
  try {
    const profiles = signalEngine.STOCK_PROFILES;
    const doc = {
      title: '매매 로직 문서 (자동 생성)',
      generatedAt: new Date().toISOString(),
      buySignal: {
        description: '5개 필수조건 + 12개 채점 요소로 매수 시그널을 계산합니다.',
        mandatoryConditions: [
          'MA5 > MA20 > MA60 (이동평균 정배열)',
          '종가 > MA20 (20일선 위)',
          'RSI >= 70 (강한 모멘텀 — 검증 결과 승률 2.2배)',
          '20일 고점 대비 거리 <= high_dist_max',
          '거래량 >= 최근 20일 평균의 50%',
        ],
        scoringComponents: [
          { name: 'MA 정배열', weight: '기본 1.0점', description: 'MA5>MA20>MA60일 때 기본 점수 부여' },
          { name: '52주 신고가 근접', weight: '+0.5', description: '52주 고점 90% 이상' },
          { name: '20일 고점 돌파', weight: '+0.8', description: '종가가 최근 20일 고점 돌파' },
          { name: 'MA20 방향', weight: '+0.3', description: 'MA20이 상승 추세' },
          { name: '구름 위', weight: '+0.3', description: '종가가 일목 구름 상단 위' },
          { name: 'MACD 상향', weight: '+0.3', description: 'MACD > 시그널' },
          { name: '볼린저 상단 근접', weight: '+0.3', description: 'BB 상단 95% 이상' },
          { name: '전환선 > 기준선', weight: '+0.3', description: '일목 텐칸 > 키준' },
          { name: '거래량 급증', weight: '+0.5', description: '거래량이 평균 2배 이상' },
          { name: 'RSI 고점', weight: '+0.3~1.0', description: 'RSI 70~90구간 비례 가산' },
          { name: '120일 전고 돌파', weight: '+0.5', description: '120일 고점 돌파 시' },
          { name: '벤포드 법칙', weight: '×배율', description: '세력 감지 시 스코어에 배율 적용' },
        ],
        threshold: '기본 4.5점 이상 시 매수 신호 발생',
      },
      entryPrice: {
        description: '진입가 결정 캐스케이드',
        cascade: [
          '기준선 10% 이내 → 기준선 가격',
          'MA20 4% 이내 → MA20 가격',
          '그 외 → 종가',
        ],
      },
      takeProfit: {
        description: '익절가 결정 캐스케이드',
        cascade: [
          '120일 전고점 (5%~40% 이내) → 해당 가격',
          '52일 전고점 → 해당 가격',
          'BB 상단 (3%+ 이상) → 해당 가격',
          '고정 TP% → 진입가 × (1 + TP%)',
        ],
      },
      stopLoss: {
        description: '손절가 결정',
        formula: 'max(기준선 × 0.97, 진입가 × (1 - SL%)) — 더 빡빡한 쪽 채택',
      },
      filters: {
        rsiFilter: 'RSI < 70 → 매수 차단 (검증: 승률 40.7% vs 18.4%)',
        regimeFilter: 'KOSPI 5개 지표 점수화, bad ≥ 4 → 매수 차단',
        circuitBreaker: '5연패 시 쿨다운 +15일',
        benford: '볼륨+가격 벤포드 법칙 이상 → 세력 감지 배율 적용',
      },
      profiles: Object.entries(profiles).map(([name, p]) => ({
        name,
        takeProfitPct: (p.take_profit * 100).toFixed(0) + '%',
        stopLossPct: (p.stop_loss * 100).toFixed(0) + '%',
        cooldownDays: p.cooldown,
        benfordWeight: p.benford_weight,
      })),
      gridSearch: {
        description: '6개 파라미터 그리드서치 (Walk-Forward)',
        parameters: ['TP (5~40%)', 'SL (3~15%)', 'CD (1~10일)', 'Benford Window', 'Benford Influence', 'Benford MinHits'],
        validation: '120일 테스트 기간으로 Walk-Forward 검증',
      },
    };

    // JSON 저장
    const jsonPath = path.join(DATA_DIR, 'trading-logic.json');
    fs.writeFileSync(jsonPath, JSON.stringify(doc, null, 2), 'utf8');

    // Markdown 생성
    let md = `# ${doc.title}\n\n생성: ${doc.generatedAt}\n\n`;
    md += `## 매수 시그널\n${doc.buySignal.description}\n\n`;
    md += `### 필수 조건\n${doc.buySignal.mandatoryConditions.map((c, i) => `${i+1}. ${c}`).join('\n')}\n\n`;
    md += `### 채점 요소\n| 항목 | 가중치 | 설명 |\n|------|--------|------|\n`;
    for (const c of doc.buySignal.scoringComponents) md += `| ${c.name} | ${c.weight} | ${c.description} |\n`;
    md += `\n임계값: ${doc.buySignal.threshold}\n\n`;
    md += `## 진입가\n${doc.entryPrice.cascade.map((c, i) => `${i+1}. ${c}`).join('\n')}\n\n`;
    md += `## 익절가\n${doc.takeProfit.cascade.map((c, i) => `${i+1}. ${c}`).join('\n')}\n\n`;
    md += `## 손절가\n${doc.stopLoss.formula}\n\n`;
    md += `## 필터\n`;
    for (const [k, v] of Object.entries(doc.filters)) md += `- **${k}**: ${v}\n`;
    md += `\n## 프로필\n| 이름 | TP | SL | CD | 벤포드 가중치 |\n|------|----|----|-----|---------------|\n`;
    for (const p of doc.profiles) md += `| ${p.name} | ${p.takeProfitPct} | ${p.stopLossPct} | ${p.cooldownDays}일 | ${p.benfordWeight} |\n`;
    md += `\n## 그리드서치\n${doc.gridSearch.description}\n파라미터: ${doc.gridSearch.parameters.join(', ')}\n검증: ${doc.gridSearch.validation}\n`;

    const mdPath = path.join(DATA_DIR, 'trading-logic.md');
    fs.writeFileSync(mdPath, md, 'utf8');

    res.json({ ok: true, doc, md });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/trading-doc', (req, res) => {
  try {
    const jsonPath = path.join(DATA_DIR, 'trading-logic.json');
    if (!fs.existsSync(jsonPath)) return res.json({ ok: false, error: '문서 없음. 먼저 생성하세요.' });
    const doc = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const mdPath = path.join(DATA_DIR, 'trading-logic.md');
    const md = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : '';
    res.json({ ok: true, doc, md });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 서버 사이드 스캔 ─────────────────────────────────────────
let _scanJob = null;
const ROUND_TRIP_COST = 0.00195; // (0.015% + 0.18%) = 수수료+세금

app.post('/api/scan/start', async (req, res) => {
  if (_scanJob && _scanJob.status === 'running') {
    return res.json({ ok: false, error: '이미 스캔 진행 중' });
  }
  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : { positions: [], trades: [], scanLog: [], stockParams: {} };
  const cfg = fs.existsSync(CFG_FILE) ? JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) : {};
  _scanJob = { status: 'running', current: 0, total: 0, results: [], startTime: Date.now(), error: null };
  res.json({ ok: true });

  (async () => {
    try {
      let stocks = _allStocksCache;
      if (!stocks || !stocks.length) stocks = await fetchAllKisStocks(null, null, null);

      // 가격대 필터: OHLCV 종가 기준으로 필터 (아래 루프에서 적용)
      const priceMin = parseInt(req.body.priceMin) || 0;
      const priceMax = parseInt(req.body.priceMax) || 0;
      let entries = stocks;

      _scanJob.total = entries.length;
      const THRESHOLD = cfg.threshold || 4.5;
      const RSI_MIN = cfg.rsiMin != null ? cfg.rsiMin : 70;
      const scanResults = [];
      const today = new Date().toISOString().split('T')[0];
      const circuitBreaker = new signalEngine.CircuitBreaker(state.trades || []);

      if (!state.startDate) state.startDate = today;
      const BATCH = 5;

      for (let bi = 0; bi < entries.length; bi += BATCH) {
        const batch = entries.slice(bi, bi + BATCH);
        const ohlcvBatch = await Promise.all(batch.map(async ({ code }) => {
          try {
            const cacheFile = path.join(OHLCV_DIR, `${code}.json`);
            const MAX_AGE = 12 * 3600 * 1000;
            if (fs.existsSync(cacheFile)) {
              const stat = fs.statSync(cacheFile);
              if (Date.now() - stat.mtimeMs < MAX_AGE) {
                return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
              }
            }
            const rows = await fetchNaverOhlcv(code);
            if (rows.length > 0) fs.writeFileSync(cacheFile, JSON.stringify(rows), 'utf8');
            return rows;
          } catch(e) { return null; }
        }));

        for (let j = 0; j < batch.length; j++) {
          const { code, name } = batch[j];
          const data = ohlcvBatch[j];
          _scanJob.current = bi + j + 1;
          if (!data || data.length < 62) continue;

          // 가격대 필터: OHLCV 최신 종가 기준
          const _lastClose = data[data.length - 1].close;
          if (priceMin > 0 && _lastClose < priceMin) continue;
          if (priceMax > 0 && _lastClose > priceMax) continue;

          try {
            const lastCandle = data[data.length - 1];
            const scanDate = lastCandle.date;

            // 1. PENDING 체결
            const pendingList = (state.positions || []).filter(p => p.code === code && p.status === 'PENDING');
            for (const pos of pendingList) {
              if (scanDate <= pos.signalDate) continue;
              if (lastCandle.low <= pos.limitPrice) {
                signalEngine.calcIndicatorsV2(data);
                const fillPrice = lastCandle.open <= pos.limitPrice ? lastCandle.open : pos.limitPrice;
                const fillKijun = lastCandle.ichiKijun;
                const fillAtr = lastCandle.atr14 || null;
                pos.status = 'IN_POSITION';
                pos.entryPrice = fillPrice;
                pos.entryDate = scanDate;
                pos.targetPrice = Math.round(signalEngine.calcTargetPrice(fillPrice, pos.tpLevel, pos.tp));
                pos.stopPrice = Math.round(signalEngine.calcStopPrice(fillPrice, fillKijun, pos.sl, fillAtr));
                pos.daysHeld = 0;
                scanResults.push({ name, code, action: 'FILLED', price: fillPrice });
              } else {
                state.positions = state.positions.filter(p => p.id !== pos.id);
                scanResults.push({ name, code, action: 'CANCELLED' });
              }
            }

            // 2. IN_POSITION — 동적 TP/SL 재조정 후 청산 확인
            const inPos = (state.positions || []).filter(p => p.code === code && p.status === 'IN_POSITION');
            for (const pos of inPos) {
              if (!pos.entryDate || scanDate <= pos.entryDate) continue;
              pos.daysHeld = Math.ceil((new Date(scanDate) - new Date(pos.entryDate)) / 86400000);

              let exitReason = null, exitPrice = null;
              const hitTarget = lastCandle.high >= pos.targetPrice;
              const hitStop = lastCandle.low <= pos.stopPrice;
              if (hitTarget && hitStop) {
                if (lastCandle.open >= pos.targetPrice) { exitReason = 'TARGET'; exitPrice = pos.targetPrice; }
                else { exitReason = 'STOP'; exitPrice = pos.stopPrice; }
              } else if (hitTarget) { exitReason = 'TARGET'; exitPrice = pos.targetPrice; }
              else if (hitStop) { exitReason = 'STOP'; exitPrice = pos.stopPrice; }
              if (exitReason) {
                const grossReturn = (exitPrice - pos.entryPrice) / pos.entryPrice;
                const pnlPct = Math.round((grossReturn - ROUND_TRIP_COST) * 10000) / 100;
                const pnlAmt = Math.round((exitPrice - pos.entryPrice) * pos.quantity);
                const closedTrade = { id: pos.id, code, name, signalDate: pos.signalDate, signalScore: pos.signalScore, entryDate: pos.entryDate, exitDate: scanDate, exitReason, limitPrice: pos.limitPrice, entryPrice: pos.entryPrice, exitPrice, quantity: pos.quantity, daysHeld: pos.daysHeld, pnlPct, pnlAmt, tp: pos.tp, sl: pos.sl, profileName: pos.profileName };
                state.trades.push(closedTrade);
                state.positions = state.positions.filter(p => p.id !== pos.id);
                circuitBreaker.recordResult(exitReason === 'TARGET');
                scanResults.push({ name, code, action: exitReason, pnlPct, exitPrice });
                // 이메일
                if (emailService.isReady()) emailService.sendSellNotification(closedTrade);
              }
            }

            // 3. 새 신호 탐지는 비활성화 — Top 30 랭킹 후 대기 주문 생성으로 대체
          } catch(e) { /* 개별 무시 */ }
        }
      }

      state.lastScan = today;
      state.scanLog = [{ date: today, results: scanResults }, ...(state.scanLog || [])].slice(0, 30);
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');

      _scanJob.results = scanResults;
      _scanJob.status = 'done';
      console.log(`[SCAN] 완료: ${scanResults.length}건 이벤트`);

      // 스캔 결과 이메일
      if (emailService.isReady() && scanResults.length > 0) {
        const pendCount = state.positions.filter(p => p.status === 'PENDING').length;
        const posCount = state.positions.filter(p => p.status === 'IN_POSITION').length;
        const wins = state.trades.filter(t => t.exitReason === 'TARGET').length;
        emailService.sendDailyScanReport(scanResults, {
          positions: posCount, pending: pendCount,
          completed: state.trades.length,
          winRate: state.trades.length ? Math.round(wins / state.trades.length * 100) : 0,
        });
      }
    } catch(e) {
      _scanJob.status = 'error';
      _scanJob.error = e.message;
      console.error('[SCAN] 오류:', e.message);
    }
  })();
});

app.get('/api/scan/status', (req, res) => {
  if (!_scanJob) return res.json({ status: 'idle' });
  const elapsed = Date.now() - _scanJob.startTime;
  const eta = _scanJob.current > 0 ? Math.round((elapsed / _scanJob.current) * (_scanJob.total - _scanJob.current) / 1000) : 0;
  res.json({
    status: _scanJob.status,
    current: _scanJob.current,
    total: _scanJob.total,
    eta,
    error: _scanJob.error,
  });
});

app.get('/api/scan/results', (req, res) => {
  if (!_scanJob || _scanJob.status !== 'done') {
    return res.json({ ok: false, error: '결과 없음' });
  }
  res.json({ ok: true, results: _scanJob.results });
});

// ── 헬스체크 ───────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    email: emailService.isReady(),
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`\n📈  모의투자 추적기 실행 중`);
  console.log(`→  브라우저: http://localhost:${PORT}`);
  console.log(`→  종료:    Ctrl+C\n`);

  // 이메일 서비스 초기화 (config에서)
  try {
    const cfg = fs.existsSync(CFG_FILE) ? JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) : {};
    emailService.init(cfg);
    if (emailService.isReady()) console.log('📧  이메일 서비스 활성화');
  } catch(e) { /* config 없으면 무시 */ }

  // 서버 시작 시 종목 목록 백그라운드 캐시 워밍 (MST는 토큰 불필요)
  setTimeout(async () => {
    try {
      await fetchAllKisStocks(null, null, null);
    } catch(e) { console.warn('[KIS] 종목 캐시 워밍 실패:', e.message); }
  }, 2000);
});
