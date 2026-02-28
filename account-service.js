// ═══════════════════════════════════════════════════════════════
// KIS 실제 계좌 서비스 — 잔고, 주문, 체결 조회
// ═══════════════════════════════════════════════════════════════
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const ORDER_LOG = path.join(__dirname, 'data', 'order-log.json');

// ── KIS API 요청 헬퍼 ────────────────────────────────────────
function kisRequest(method, apiPath, params, { token, appKey, appSecret, trId, body: reqBody } = {}) {
  return new Promise((resolve, reject) => {
    const query = method === 'GET' && params ? '?' + new URLSearchParams(params).toString() : '';
    const bodyStr = method === 'POST' && reqBody ? JSON.stringify(reqBody) : null;
    const hdrs = {
      'content-type': 'application/json; charset=utf-8',
      'authorization': `Bearer ${token}`,
      'appkey': appKey,
      'appsecret': appSecret,
      'tr_id': trId,
    };
    if (bodyStr) hdrs['content-length'] = Buffer.byteLength(bodyStr);

    const req = https.request({
      hostname: 'openapi.koreainvestment.com',
      port: 9443,
      path: apiPath + query,
      method,
      headers: hdrs,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch(e) { reject(new Error('응답 파싱 실패')); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── 주문 로그 기록 ────────────────────────────────────────────
function logOrder(entry) {
  let logs = [];
  try { logs = JSON.parse(fs.readFileSync(ORDER_LOG, 'utf8')); } catch(e) {}
  logs.unshift({ ...entry, timestamp: new Date().toISOString() });
  if (logs.length > 500) logs = logs.slice(0, 500);
  fs.writeFileSync(ORDER_LOG, JSON.stringify(logs, null, 2), 'utf8');
}

// ── 잔고 조회 (TTTC8434R) ────────────────────────────────────
async function getBalance(token, appKey, appSecret, cano) {
  const result = await kisRequest('GET',
    '/uapi/domestic-stock/v1/trading/inquire-balance',
    {
      CANO: cano, ACNT_PRDT_CD: '01',
      AFHR_FLPR_YN: 'N', OFL_YN: '', INQR_DVSN: '02',
      UNPR_DVSN: '01', FUND_STTL_ICLD_YN: 'N',
      FNCG_AMT_AUTO_RDPT_YN: 'N', PRCS_DVSN: '01',
      CTX_AREA_FK100: '', CTX_AREA_NK100: '',
    },
    { token, appKey, appSecret, trId: 'TTTC8434R' }
  );
  if (result.rt_cd !== '0') throw new Error(result.msg1 || '잔고 조회 실패');

  // output1: 보유종목 목록
  const holdings = (result.output1 || [])
    .filter(h => parseInt(h.hldg_qty) > 0)
    .map(h => ({
      code:       h.pdno,
      name:       h.prdt_name,
      qty:        parseInt(h.hldg_qty) || 0,
      avgPrice:   parseInt(h.pchs_avg_pric) || 0,
      curPrice:   parseInt(h.prpr) || 0,
      evalAmt:    parseInt(h.evlu_amt) || 0,
      pnlAmt:     parseInt(h.evlu_pfls_amt) || 0,
      pnlPct:     parseFloat(h.evlu_pfls_rt) || 0,
    }));

  // output2: 계좌 요약
  const summary = result.output2?.[0] || {};
  return {
    holdings,
    deposit:    parseInt(summary.dnca_tot_amt) || 0,       // 예수금 총액
    evalTotal:  parseInt(summary.tot_evlu_amt) || 0,       // 총 평가금액
    pnlTotal:   parseInt(summary.evlu_pfls_smtl_amt) || 0, // 평가손익
    purchaseAmt: parseInt(summary.pchs_amt_smtl_amt) || 0, // 매입금액 합계
  };
}

// ── 매수 주문 (TTTC0802U) ────────────────────────────────────
async function orderBuy(token, appKey, appSecret, cano, { code, qty, price, orderType }) {
  const ordDvsn = orderType === 'market' ? '01' : '00'; // 01=시장가, 00=지정가
  const result = await kisRequest('POST',
    '/uapi/domestic-stock/v1/trading/order-cash',
    null,
    {
      token, appKey, appSecret, trId: 'TTTC0802U',
      body: {
        CANO: cano, ACNT_PRDT_CD: '01',
        PDNO: code, ORD_DVSN: ordDvsn,
        ORD_QTY: String(qty),
        ORD_UNPR: orderType === 'market' ? '0' : String(price),
      }
    }
  );
  const success = result.rt_cd === '0';
  logOrder({ type: 'BUY', code, qty, price, orderType, success, msg: result.msg1, ordNo: result.output?.ODNO });
  if (!success) throw new Error(result.msg1 || '매수 주문 실패');
  return { ok: true, ordNo: result.output?.ODNO, msg: result.msg1 };
}

// ── 매도 주문 (TTTC0801U) ────────────────────────────────────
async function orderSell(token, appKey, appSecret, cano, { code, qty, price, orderType }) {
  const ordDvsn = orderType === 'market' ? '01' : '00';
  const result = await kisRequest('POST',
    '/uapi/domestic-stock/v1/trading/order-cash',
    null,
    {
      token, appKey, appSecret, trId: 'TTTC0801U',
      body: {
        CANO: cano, ACNT_PRDT_CD: '01',
        PDNO: code, ORD_DVSN: ordDvsn,
        ORD_QTY: String(qty),
        ORD_UNPR: orderType === 'market' ? '0' : String(price),
      }
    }
  );
  const success = result.rt_cd === '0';
  logOrder({ type: 'SELL', code, qty, price, orderType, success, msg: result.msg1, ordNo: result.output?.ODNO });
  if (!success) throw new Error(result.msg1 || '매도 주문 실패');
  return { ok: true, ordNo: result.output?.ODNO, msg: result.msg1 };
}

// ── 체결 내역 조회 (TTTC8001R) ───────────────────────────────
async function getOrders(token, appKey, appSecret, cano, { startDate, endDate } = {}) {
  const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
  const result = await kisRequest('GET',
    '/uapi/domestic-stock/v1/trading/inquire-daily-ccld',
    {
      CANO: cano, ACNT_PRDT_CD: '01',
      INQR_STRT_DT: startDate || today, INQR_END_DT: endDate || today,
      SLL_BUY_DVSN_CD: '00', INQR_DVSN: '00',
      PDNO: '', CCLD_DVSN: '00',
      ORD_GNO_BRNO: '', ODNO: '',
      INQR_DVSN_3: '00', INQR_DVSN_1: '',
      CTX_AREA_FK100: '', CTX_AREA_NK100: '',
    },
    { token, appKey, appSecret, trId: 'TTTC8001R' }
  );
  if (result.rt_cd !== '0') throw new Error(result.msg1 || '체결 내역 조회 실패');
  return (result.output1 || []).map(o => ({
    ordNo:     o.odno,
    code:      o.pdno,
    name:      o.prdt_name,
    side:      o.sll_buy_dvsn_cd === '02' ? 'BUY' : 'SELL',
    ordQty:    parseInt(o.ord_qty) || 0,
    filledQty: parseInt(o.tot_ccld_qty) || 0,
    ordPrice:  parseInt(o.ord_unpr) || 0,
    avgPrice:  parseInt(o.avg_prvs) || 0,
    ordTime:   o.ord_tmd,
    status:    parseInt(o.tot_ccld_qty) > 0 ? 'FILLED' : 'PENDING',
  }));
}

// ── 주문 로그 읽기 ────────────────────────────────────────────
function getOrderLog() {
  try { return JSON.parse(fs.readFileSync(ORDER_LOG, 'utf8')); }
  catch(e) { return []; }
}

module.exports = { getBalance, orderBuy, orderSell, getOrders, getOrderLog };
