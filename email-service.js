// ═══════════════════════════════════════════════════════════════
// 이메일 서비스 — Gmail SMTP via nodemailer
// ═══════════════════════════════════════════════════════════════
const nodemailer = require('nodemailer');

let _transporter = null;
let _config = { emailTo: '', emailAppPassword: '', emailEnabled: false };

function init(config) {
  _config = { ..._config, ...config };
  if (_config.emailAppPassword && _config.emailTo) {
    _transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: _config.emailTo, pass: _config.emailAppPassword },
    });
  }
}

function isReady() {
  return !!_transporter && _config.emailEnabled;
}

async function _send(subject, html) {
  if (!isReady()) return { ok: false, reason: 'email not configured' };
  try {
    const info = await _transporter.sendMail({
      from: `"모의투자 추적기" <${_config.emailTo}>`,
      to: _config.emailTo,
      subject,
      html,
    });
    console.log('[EMAIL]', subject, '→', info.messageId);
    return { ok: true, messageId: info.messageId };
  } catch (e) {
    console.error('[EMAIL ERROR]', e.message);
    return { ok: false, reason: e.message };
  }
}

// ── 매수 알림 ─────────────────────────────────────────────────
async function sendBuyNotification(trade) {
  const subject = `[매수] ${trade.name}(${trade.code}) ${trade.limitPrice?.toLocaleString()}원`;
  const html = `
<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;background:#1C1B19;color:#E8E2DC;padding:24px;border-radius:12px;">
  <h2 style="color:#f5c842;margin-bottom:16px;">📈 매수 주문</h2>
  <table style="width:100%;border-collapse:collapse;font-size:14px;">
    <tr><td style="padding:6px 0;color:#8A8480;">종목</td><td style="padding:6px 0;font-weight:700;">${trade.name} (${trade.code})</td></tr>
    <tr><td style="padding:6px 0;color:#8A8480;">주문가</td><td style="padding:6px 0;">${(trade.limitPrice||0).toLocaleString()}원 (${trade.entryReason||'지정가'})</td></tr>
    <tr><td style="padding:6px 0;color:#8A8480;">시그널 점수</td><td style="padding:6px 0;color:#f5c842;">${trade.signalScore}점</td></tr>
    <tr><td style="padding:6px 0;color:#8A8480;">프로필</td><td style="padding:6px 0;">${trade.profileName||'auto'}</td></tr>
    <tr><td style="padding:6px 0;color:#8A8480;">시그널 날짜</td><td style="padding:6px 0;">${trade.signalDate}</td></tr>
    ${trade.tpLevel ? `<tr><td style="padding:6px 0;color:#8A8480;">예상 익절가</td><td style="padding:6px 0;color:#4caf50;">${trade.tpLevel.toLocaleString()}원</td></tr>` : ''}
  </table>
  <div style="margin-top:16px;padding:10px;background:#252320;border-radius:6px;font-size:12px;color:#7A7470;">
    자동 생성 알림 · 모의투자 추적기
  </div>
</div>`;
  return _send(subject, html);
}

// ── 매도 알림 (익절/손절) ─────────────────────────────────────
async function sendSellNotification(trade) {
  const isWin = trade.exitReason === 'TARGET';
  const isStop = trade.exitReason === 'STOP';
  const emoji = isWin ? '🟢' : isStop ? '🔴' : '⚪';
  const label = isWin ? '익절' : isStop ? '손절' : '만기';
  const color = isWin ? '#4caf50' : isStop ? '#ef5350' : '#ff9800';
  const pnlSign = trade.pnlPct >= 0 ? '+' : '';

  const subject = `[${label}] ${trade.name}(${trade.code}) ${pnlSign}${trade.pnlPct}%`;
  const html = `
<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;background:#1C1B19;color:#E8E2DC;padding:24px;border-radius:12px;">
  <h2 style="color:${color};margin-bottom:16px;">${emoji} ${label} 완료</h2>
  <table style="width:100%;border-collapse:collapse;font-size:14px;">
    <tr><td style="padding:6px 0;color:#8A8480;">종목</td><td style="padding:6px 0;font-weight:700;">${trade.name} (${trade.code})</td></tr>
    <tr><td style="padding:6px 0;color:#8A8480;">매수일 / 매도일</td><td style="padding:6px 0;">${trade.entryDate} → ${trade.exitDate}</td></tr>
    <tr><td style="padding:6px 0;color:#8A8480;">매수가 / 매도가</td><td style="padding:6px 0;">${(trade.entryPrice||0).toLocaleString()}원 → ${(trade.exitPrice||0).toLocaleString()}원</td></tr>
    <tr><td style="padding:6px 0;color:#8A8480;">손익률</td><td style="padding:6px 0;font-size:18px;font-weight:700;color:${color};">${pnlSign}${trade.pnlPct}%</td></tr>
    <tr><td style="padding:6px 0;color:#8A8480;">보유기간</td><td style="padding:6px 0;">${trade.daysHeld}일</td></tr>
    <tr><td style="padding:6px 0;color:#8A8480;">손익금</td><td style="padding:6px 0;color:${color};">${pnlSign}${(trade.pnlAmt||0).toLocaleString()}원</td></tr>
    ${trade.tpReason ? `<tr><td style="padding:6px 0;color:#8A8480;">익절 근거</td><td style="padding:6px 0;">${trade.tpReason}</td></tr>` : ''}
    ${trade.slReason ? `<tr><td style="padding:6px 0;color:#8A8480;">손절 근거</td><td style="padding:6px 0;">${trade.slReason}</td></tr>` : ''}
  </table>
  <div style="margin-top:16px;padding:10px;background:#252320;border-radius:6px;font-size:12px;color:#7A7470;">
    자동 생성 알림 · 모의투자 추적기
  </div>
</div>`;
  return _send(subject, html);
}

// ── 손절 분석 리포트 ──────────────────────────────────────────
async function sendStopLossReport(report) {
  const t = report.trade;
  const opt = report.reOptimization;
  const port = report.portfolioCheck;

  const subject = `[손절 분석] ${t.name} ${t.pnlPct}% (${t.exitDate})`;
  let html = `
<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;background:#1C1B19;color:#E8E2DC;padding:24px;border-radius:12px;">
  <h2 style="color:#ef5350;margin-bottom:16px;">🔴 손절 분석 리포트</h2>

  <h3 style="color:#C8C2BC;font-size:14px;">1. 거래 요약</h3>
  <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px;">
    <tr><td style="padding:4px 0;color:#8A8480;">종목</td><td>${t.name} (${t.code})</td></tr>
    <tr><td style="padding:4px 0;color:#8A8480;">매수/매도</td><td>${t.entryDate} → ${t.exitDate}</td></tr>
    <tr><td style="padding:4px 0;color:#8A8480;">가격</td><td>${(t.entryPrice||0).toLocaleString()}원 → ${(t.exitPrice||0).toLocaleString()}원</td></tr>
    <tr><td style="padding:4px 0;color:#8A8480;">손익</td><td style="color:#ef5350;font-weight:700;">${t.pnlPct}%</td></tr>
  </table>`;

  if (report.aiAnalysis) {
    html += `
  <h3 style="color:#C8C2BC;font-size:14px;">2. AI 분석</h3>
  <div style="padding:10px;background:#252320;border-radius:6px;font-size:13px;margin-bottom:16px;white-space:pre-wrap;line-height:1.6;">${report.aiAnalysis}</div>`;
  }

  if (opt) {
    html += `
  <h3 style="color:#C8C2BC;font-size:14px;">3. 파라미터 재최적화</h3>
  <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px;">
    <tr><td style="padding:4px 0;color:#8A8480;">기존</td><td>TP ${Math.round((t.tp||0.17)*100)}% / SL ${Math.round((t.sl||0.07)*100)}%</td></tr>
    <tr><td style="padding:4px 0;color:#8A8480;">신규</td><td style="color:#4caf50;">TP ${Math.round(opt.tp*100)}% / SL ${Math.round(opt.sl*100)}% / CD ${opt.cd}일</td></tr>
    <tr><td style="padding:4px 0;color:#8A8480;">신규 승률</td><td>${opt.winRate?.toFixed(0)}% (${opt.trades}건)</td></tr>
  </table>`;
  }

  if (port) {
    const prColor = port.recentWinRate >= 50 ? '#4caf50' : '#ef5350';
    html += `
  <h3 style="color:#C8C2BC;font-size:14px;">4. 포트폴리오 건강도</h3>
  <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px;">
    <tr><td style="padding:4px 0;color:#8A8480;">최근 20건 승률</td><td style="color:${prColor};">${port.recentWinRate?.toFixed(0)}%</td></tr>
    <tr><td style="padding:4px 0;color:#8A8480;">연패</td><td>${port.consecLosses}회</td></tr>
    <tr><td style="padding:4px 0;color:#8A8480;">상태</td><td>${port.recommendation}</td></tr>
  </table>`;
  }

  html += `
  <div style="margin-top:16px;padding:10px;background:#252320;border-radius:6px;font-size:12px;color:#7A7470;">
    자동 생성 · 손절 발생 시 자동 분석 파이프라인
  </div>
</div>`;
  return _send(subject, html);
}

// ── 스캔 결과 요약 ────────────────────────────────────────────
async function sendDailyScanReport(results, portfolioSummary) {
  const newOrders = results.filter(r => r.action === 'NEW_ORDER');
  const filled = results.filter(r => r.action === 'FILLED');
  const wins = results.filter(r => r.action === 'TARGET');
  const stops = results.filter(r => r.action === 'STOP');
  const date = new Date().toISOString().split('T')[0];

  if (!newOrders.length && !filled.length && !wins.length && !stops.length) return;

  const subject = `[스캔 완료] ${date} — 신규 ${newOrders.length} · 체결 ${filled.length} · 익절 ${wins.length} · 손절 ${stops.length}`;
  let html = `
<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;background:#1C1B19;color:#E8E2DC;padding:24px;border-radius:12px;">
  <h2 style="color:#f5c842;margin-bottom:16px;">📊 일일 스캔 리포트 (${date})</h2>`;

  if (newOrders.length) {
    html += `<h3 style="color:#f5c842;font-size:14px;">신규 매수 신호 (${newOrders.length}건)</h3><table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:12px;">`;
    for (const o of newOrders) {
      html += `<tr><td style="padding:3px 0;">${o.name}(${o.code})</td><td style="color:#f5c842;">${o.score}점</td><td>${(o.limitPrice||0).toLocaleString()}원</td></tr>`;
    }
    html += `</table>`;
  }

  if (wins.length) {
    html += `<h3 style="color:#4caf50;font-size:14px;">익절 (${wins.length}건)</h3>`;
    for (const w of wins) html += `<div style="font-size:13px;margin:2px 0;">${w.name} +${w.pnlPct}%</div>`;
  }

  if (stops.length) {
    html += `<h3 style="color:#ef5350;font-size:14px;">손절 (${stops.length}건)</h3>`;
    for (const s of stops) html += `<div style="font-size:13px;margin:2px 0;">${s.name} ${s.pnlPct}%</div>`;
  }

  if (portfolioSummary) {
    html += `
  <div style="margin-top:12px;padding:10px;background:#252320;border-radius:6px;font-size:13px;">
    <strong>포트폴리오:</strong> 포지션 ${portfolioSummary.positions}개 · 대기 ${portfolioSummary.pending}개 · 완료 ${portfolioSummary.completed}건 · 승률 ${portfolioSummary.winRate}%
  </div>`;
  }

  html += `
  <div style="margin-top:16px;padding:10px;background:#252320;border-radius:6px;font-size:12px;color:#7A7470;">
    자동 생성 알림 · 모의투자 추적기
  </div>
</div>`;
  return _send(subject, html);
}

// ── Top 50 추천 리포트 ────────────────────────────────────────
async function sendTop50Report(rankings) {
  const date = new Date().toISOString().split('T')[0];
  const subject = `[Top 50 추천] ${date} — ${rankings.length}개 종목`;
  let html = `
<div style="font-family:-apple-system,sans-serif;max-width:700px;margin:0 auto;background:#1C1B19;color:#E8E2DC;padding:24px;border-radius:12px;">
  <h2 style="color:#A070FF;margin-bottom:16px;">🏆 Top 50 종목 추천 (${date})</h2>
  <table style="width:100%;border-collapse:collapse;font-size:12px;">
    <tr style="color:#7A7470;border-bottom:1px solid #333;">
      <th style="padding:6px 4px;text-align:left;">#</th>
      <th style="padding:6px 4px;text-align:left;">종목</th>
      <th style="padding:6px 4px;text-align:center;">점수</th>
      <th style="padding:6px 4px;text-align:center;">RSI</th>
      <th style="padding:6px 4px;text-align:left;">추천사유</th>
    </tr>`;

  const top = rankings.slice(0, 50);
  for (let i = 0; i < top.length; i++) {
    const r = top[i];
    const bg = i % 2 === 0 ? '#1C1B19' : '#212019';
    html += `
    <tr style="background:${bg};">
      <td style="padding:4px;">${i+1}</td>
      <td style="padding:4px;font-weight:600;">${r.name}<span style="color:#666;font-size:11px;margin-left:4px;">${r.code}</span></td>
      <td style="padding:4px;text-align:center;color:#f5c842;font-weight:700;">${r.composite?.toFixed(1)}</td>
      <td style="padding:4px;text-align:center;">${r.rsi?.toFixed(0)}</td>
      <td style="padding:4px;font-size:11px;color:#9A9390;">${r.reason||''}</td>
    </tr>`;
  }

  html += `</table>
  <div style="margin-top:16px;padding:10px;background:#252320;border-radius:6px;font-size:12px;color:#7A7470;">
    자동 생성 · 전 종목 스캔 기반 추천
  </div>
</div>`;
  return _send(subject, html);
}

// ── 테스트 이메일 ─────────────────────────────────────────────
async function sendTestEmail() {
  return _send('모의투자 추적기 — 이메일 테스트', `
<div style="font-family:-apple-system,sans-serif;max-width:400px;margin:0 auto;background:#1C1B19;color:#E8E2DC;padding:24px;border-radius:12px;text-align:center;">
  <h2 style="color:#4caf50;">✅ 이메일 설정 완료</h2>
  <p style="margin-top:12px;font-size:14px;">모의투자 추적기의 이메일 알림이 정상적으로 설정되었습니다.</p>
  <p style="margin-top:8px;color:#7A7470;font-size:12px;">매수/매도/손절분석/스캔결과 알림이 이 주소로 발송됩니다.</p>
</div>`);
}

module.exports = {
  init,
  isReady,
  sendBuyNotification,
  sendSellNotification,
  sendStopLossReport,
  sendDailyScanReport,
  sendTop50Report,
  sendTestEmail,
};
