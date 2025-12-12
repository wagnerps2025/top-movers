// Configurações iniciais
const cfg = {
  winShortMs: 180_000,
  upThresholdPct: 1.5,
  downThresholdPct: 1.5,
  maxStretchPct: 4,
  minUsd24h: 5_000_000,
};

// Estado em memória
const state = {
  symbols: new Map(),
};

// Utilidades
const now = () => Date.now();

// ---- ÁUDIO ----
// Reutilizar um único contexto evita travamentos
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}
function playBeep(frequency = 800, duration = 200, volume = 0.05) {
  const ctx = getAudioCtx();
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  gain.gain.value = volume;
  oscillator.type = 'sine';
  oscillator.frequency.value = frequency;
  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.start();
  setTimeout(() => oscillator.stop(), duration);
}
function beepAscension() {
  playBeep(1000, 160);
  setTimeout(() => playBeep(1000, 160), 220);
}
function beepDescent() {
  playBeep(420, 420);
}
// desbloqueia áudio após primeiro clique
document.addEventListener('click', () => { try { getAudioCtx().resume(); } catch {} }, { once: true });

// ---- LÓGICA DE PREÇOS ----
function pushPrice(symbol, price, volume24hBase) {
  let s = state.symbols.get(symbol);
  if (!s) {
    s = { history: [], lastPrice: price, lastUpdate: now(), volume24hBase: volume24hBase ?? null };
    state.symbols.set(symbol, s);
  }
  s.lastPrice = price;
  s.lastUpdate = now();
  if (typeof volume24hBase === 'number') s.volume24hBase = volume24hBase;
  s.history.push({ t: s.lastUpdate, p: price });
  const cutoff = s.lastUpdate - (cfg.winShortMs + 60_000);
  while (s.history.length && s.history[0].t < cutoff) s.history.shift();
}

function pctChange(symbol, windowMs) {
  const s = state.symbols.get(symbol);
  if (!s || s.history.length < 2) return null;
  const end = s.history[s.history.length - 1];
  for (let i = s.history.length - 1; i >= 0; i--) {
    if (end.t - s.history[i].t >= windowMs) {
      const start = s.history[i];
      const pct = ((end.p - start.p) / start.p) * 100;
      return { pct, startP: start.p, endP: end.p };
    }
  }
  return null;
}

function estimateUsd24h(symbol) {
  const s = state.symbols.get(symbol);
  if (!s || s.volume24hBase == null || s.lastPrice == null) return null;
  return s.lastPrice * s.volume24hBase;
}

function isUsdtPair(symbol) {
  return symbol.endsWith('USDT');
}

// ---- REGRAS ----
function evaluate(symbol) {
  const ch1m = pctChange(symbol, 60_000);
  const ch3m = pctChange(symbol, cfg.winShortMs);
  const usd24h = estimateUsd24h(symbol);
  const s = state.symbols.get(symbol);

  if (!ch1m || !ch3m || !usd24h) return { status: 'AGUARDAR', reason: 'dados insuficientes' };
  if (!isUsdtPair(symbol)) return { status: 'AGUARDAR', reason: 'ignorado: não é par USDT' };
  if (usd24h < cfg.minUsd24h) return { status: 'NÃO VIÁVEL', reason: 'baixa liquidez 24h' };

  const upFast = ch1m.pct >= cfg.upThresholdPct || ch3m.pct >= cfg.upThresholdPct;
  const downFast = ch1m.pct <= -cfg.downThresholdPct || ch3m.pct <= -cfg.downThresholdPct;
  const stretched = Math.abs(ch3m.pct) >= cfg.maxStretchPct;

  if (upFast) {
    if (stretched) return { status: 'NÃO VIÁVEL', reason: 'esticado na alta', dir: 'UP', pct: ch3m.pct, price: s.lastPrice, usd24h };
    return { status: 'ASCENSÃO RÁPIDA', reason: 'aceleração acima do limiar', dir: 'UP', pct: ch3m.pct, price: s.lastPrice, usd24h };
  }
  if (downFast) {
    if (stretched) return { status: 'NÃO VIÁVEL', reason: 'esticado na queda', dir: 'DOWN', pct: ch3m.pct, price: s.lastPrice, usd24h };
    return { status: 'DESCENSO RÁPIDO', reason: 'aceleração abaixo do limiar', dir: 'DOWN', pct: ch3m.pct, price: s.lastPrice, usd24h };
  }
  return { status: 'AGUARDAR', reason: 'sem aceleração relevante', pct: ch3m.pct, price: s.lastPrice, usd24h };
}

// ---- WEBSOCKET ----
const WS_URL = 'wss://stream.binance.com:9443/ws/!miniTicker@arr';
function startFeed() {
  const ws = new WebSocket(WS_URL);
  ws.onopen = () => logAlert('WebSocket conectado. Varredura iniciada.');
  ws.onmessage = (evt) => {
    try {
      const data = JSON.parse(evt.data);
      if (!Array.isArray(data)) return;
      for (const it of data) {
        if (!isUsdtPair(it.s)) continue;
        const price = Number(it.c);
        const volBase24h = Number(it.v);
        if (!Number.isFinite(price) || !Number.isFinite(volBase24h)) continue;
        pushPrice(it.s, price, volBase24h);
      }
    } catch (e) {
      logAlert('Erro de parsing dos dados do feed.');
    }
  };
  ws.onclose = () => {
    logAlert('WebSocket desconectado. Tentando reconectar em 5s...');
    setTimeout(startFeed, 5000);
  };
  ws.onerror = () => logAlert('Erro no WebSocket.');
}

// ---- UI ----
function logAlert(text) {
  const ul = document.getElementById('alerts');
  if (!ul) return;
  const li = document.createElement('li');
  const ts = new Date().toLocaleTimeString();
  li.textContent = `[${ts}] ${text}`;
  ul.prepend(li);
  while (ul.children.length > 50) ul.removeChild(ul.lastChild);
}

function renderRank() {
  const up = [];
  const down = [];
  for (const [symbol] of state.symbols) {
    const ev = evaluate(symbol);
    if (ev.dir === 'UP' || ev.status === 'ASCENSÃO RÁPIDA') up.push({ symbol, ev });
    else if (ev.dir === 'DOWN' || ev.status === 'DESCENSO RÁPIDO') down.push({ symbol, ev });
  }
  up.sort((a, b) => (b.ev.pct ?? 0) - (a.ev.pct ?? 0));
  down.sort((a, b) => (Math.abs(b.ev.pct ?? 0) - Math.abs(a.ev.pct ?? 0)));
  fillTable('topUp', up.slice(0, 5));
  fillTable('topDown', down.slice(0, 5));
}

function fmtPct(v) {
  if (v == null) return '-';
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}
function fmtUsd(v) {
  if (v == null) return '-';
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

// ---- TABELA ----
const lastStatus = new Map(); // evita repetir beep
function fillTable(elId, arr) {
  const tbody = document.getElementById(elId);
  if (!tbody) return;
  tbody.innerHTML = '';
  for (const row of arr) {
    const { symbol, ev } = row;
    const tr = document.createElement('tr');
    const pctClass = (ev.pct ?? 0) >= 0 ? 'pos' : 'neg';
    const usd = fmtUsd(ev.usd24h);

    const statusColor =
      ev.status === 'ASCENSÃO RÁPIDA' ? 'pos' :
      ev.status === 'DESCENSO RÁPIDO' ? 'neg' :
      ev.status === 'NÃO VIÁVEL' ? 'warn' : '';

    tr.innerHTML = `
      <td>${symbol}</td>
      <td><span class="${pctClass}">${fmtPct(ev.pct)}</span></td>
      <td>${ev.price?.toFixed(6) ?? '-'}</td>
      <td>${usd}</td>
      <td><span class="${statusColor}">${ev.status}</span> — <small>${ev.reason}</small></td>
    `;
    tbody.appendChild(tr);

    // Alertas e bipes apenas quando o status muda
    const prev = lastStatus.get(symbol);
    if (prev !== ev.status) {
      lastStatus.set(symbol, ev.status);
      if (ev.status === 'ASCENSÃO RÁPIDA') {
        logAlert(`ASCENSÃO: ${symbol} ${fmtPct(ev.pct)} — possível entrada se não estiver esticado.`);
        beepAscension();
      } else if (ev.status === 'DESCENSO RÁPIDO') {
        logAlert(`DESCENSO: ${symbol} ${fmtPct(ev.pct)} — possível entrada short/hedge se permitido.`);
        beepDescent();
      } else if (ev.status === 'NÃO VIÁVEL') {
        logAlert(`NÃO VIÁVEL: ${symbol} — ${ev.reason}.`);
      }
    }
  }
}

// ---- CONFIGURAÇÕES ----
function bindCfg() {
  const winShort = document.getElementById('winShort');
  const thUp = document.getElementById('thUp');
  const thDown = document.getElementById('thDown');
  const maxStretch = document.getElementById('maxStretch');
  const minUsd24h = document.getElementById('minUsd24h');
  const apply = document.getElementById('applyCfg');

  apply.addEventListener('click', () => {
    cfg.winShortMs = Number(winShort.value);
    cfg.upThresholdPct = Number(thUp.value);
    cfg.downThresholdPct = Number(thDown.value);
    cfg.maxStretchPct = Number(maxStretch.value);
    cfg.minUsd24h = Number(minUsd24h.value);
    logAlert(`Config aplicada: janela=${cfg.winShortMs/60000}m, up=${cfg.upThresholdPct}%, down=${cfg.downThresholdPct}%, esticamento=${cfg.maxStretchPct}%, liquidez≥${fmtUsd(cfg.minUsd24h)}.`);
  });
}

// ---- LOOP ----
function startLoops() {
  setInterval(renderRank, 2000);
}

// ---- INICIALIZAÇÃO ----
window.addEventListener('DOMContentLoaded', () => {
  bindCfg();
  startFeed();
  startLoops();
});
