// quant-market-snapshot.mjs — hourly "多空分布" snapshot for quant-terminal
// Writes data/live/market.json (and keeps data/live/liq-BTC.json as a rolling 24h liquidation tape).
// Sources (all public, no keys, all answer US IPs):
//   OKX v5 public/rubik  : price, OI, all-account L/S ratio, top-trader position L/S ratio, taker buy/sell, funding, liquidations
//   Hyperliquid          : leaderboard → top-N accounts → open positions (entry price, liquidation price, size)
// Run:  node scripts/quant-market-snapshot.mjs            (Node 18+, no dependencies)
// Env:  HL_TOP_N (default 400)  COINS (default "BTC,ETH")  OUT (default data/live)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

const OKX = 'https://www.okx.com/api/v5';
const HL = 'https://api.hyperliquid.xyz/info';
const OUT = process.env.OUT || 'data/live';
const COINS = (process.env.COINS || 'BTC,ETH').split(',').map(s => s.trim()).filter(Boolean);
const TOP_N = +(process.env.HL_TOP_N || 400);
const BUCKET = { BTC: 250, ETH: 10, SOL: 1, HYPE: 0.25 };           // price bucket width per coin
const CT_VAL = { BTC: 0.01, ETH: 0.1, SOL: 1, HYPE: 1 };             // OKX USDT-SWAP contract value (coins per contract)
const H1 = 3600e3, DAY = 86400e3;
const now = Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function okx(path, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(OKX + path, { headers: { 'accept': 'application/json' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (j.code !== '0') throw new Error('code ' + j.code + ' ' + (j.msg || ''));
      return j.data || [];
    } catch (e) { if (i === tries - 1) throw e; await sleep(800 * (i + 1)); }
  }
}
async function hl(body, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(HL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (r.status === 429) throw new Error('429');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { if (i === tries - 1) throw e; await sleep(e.message === '429' ? 15000 : 1500 * (i + 1)); }
  }
}
const bucketOf = (px, w) => Math.floor(px / w) * w;
function toRows(map) { return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [k, Math.round(v.long), Math.round(v.short)]); }
function addTo(map, bucket, side, usd) { const o = map.get(bucket) || { long: 0, short: 0 }; o[side] += usd; map.set(bucket, o); }

/* ---------- OKX block for one coin ---------- */
async function okxCoin(coin) {
  const inst = `${coin}-USDT-SWAP`;
  const ctVal = CT_VAL[coin] || 1;
  const out = { inst, errors: [] };
  const tryStep = async (name, fn) => { try { await fn(); } catch (e) { out.errors.push(name + ': ' + (e.message || e)); log('okx', coin, name, 'failed:', e.message || e); } };
  await tryStep('ticker', async () => { const t = (await okx(`/market/ticker?instId=${inst}`))[0]; out.price = +t.last; out.open24h = +t.open24h; out.high24h = +t.high24h; out.low24h = +t.low24h; out.ts = +t.ts; });
  await tryStep('oi', async () => {
    const rows = await okx(`/rubik/stat/contracts/open-interest-history?instId=${inst}&period=1H&limit=48&end=${now}`);
    out.oi = { usd: Math.round(+rows[0][3]), coin: Math.round(+rows[0][2]), hist: rows.map(x => [+x[0], Math.round(+x[3])]).sort((a, b) => a[0] - b[0]) };
  });
  await tryStep('lsAccount', async () => {
    const rows = await okx(`/rubik/stat/contracts/long-short-account-ratio?ccy=${coin}&period=1H&begin=${now - 48 * H1}`);
    const hist = rows.map(x => [+x[0], +x[1]]).sort((a, b) => a[0] - b[0]);
    out.lsAccount = { value: hist[hist.length - 1][1], hist };
  });
  await tryStep('lsTop', async () => {
    const rows = await okx(`/rubik/stat/contracts/long-short-position-ratio-contract-top-trader?instId=${inst}&period=1H&limit=48&end=${now}`);
    const hist = rows.map(x => [+x[0], +(+x[1]).toFixed(4)]).sort((a, b) => a[0] - b[0]);
    out.lsTop = { value: hist[hist.length - 1][1], hist };
  });
  await tryStep('taker', async () => {
    const rows = await okx(`/rubik/stat/taker-volume-contract?instId=${inst}&period=1H&limit=24&end=${now}`);
    let sell = 0, buy = 0; for (const x of rows) { sell += +x[1]; buy += +x[2]; }
    out.taker = { buy: Math.round(buy), sell: Math.round(sell), ratio: sell > 0 ? +(buy / sell).toFixed(3) : null };
  });
  await tryStep('funding', async () => {
    const f = (await okx(`/public/funding-rate?instId=${inst}`))[0];
    const rate = +f.fundingRate;
    out.funding = { rate, next: f.nextFundingRate ? +f.nextFundingRate : null, nextTime: +f.nextFundingTime, aprPct: +(rate * 3 * 365 * 100).toFixed(2), premium: +f.premium };
  });
  await tryStep('liq', async () => {
    // Rolling 24h tape: OKX only returns the latest 100 fills per call, so we merge each hourly sample into a file.
    const file = `${OUT}/liq-${coin}.json`;
    let tape = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
    const seen = new Set(tape.map(r => r.k));
    let after = '', added = 0;
    for (let page = 0; page < 5; page++) {
      const d = await okx(`/public/liquidation-orders?instType=SWAP&uly=${coin}-USDT&state=filled&limit=100${after ? '&after=' + after : ''}`);
      const det = (d[0] && d[0].details) || [];
      if (!det.length) break;
      for (const x of det) { const k = `${x.ts}|${x.bkPx}|${x.sz}|${x.posSide}`; if (!seen.has(k)) { seen.add(k); tape.push({ k, ts: +x.ts, px: +x.bkPx, sz: +x.sz, side: x.posSide }); added++; } }
      const oldest = Math.min(...det.map(x => +x.ts));
      if (oldest < now - DAY) break;
      after = String(oldest);
      await sleep(150);
    }
    tape = tape.filter(r => r.ts >= now - DAY).sort((a, b) => a.ts - b.ts);
    writeFileSync(file, JSON.stringify(tape));
    const w = BUCKET[coin] || 1, map = new Map(); let longUsd = 0, shortUsd = 0;
    for (const r of tape) { const usd = r.sz * ctVal * r.px; addTo(map, bucketOf(r.px, w), r.side === 'long' ? 'long' : 'short', usd); if (r.side === 'long') longUsd += usd; else shortUsd += usd; }
    out.liq = { windowFrom: now - DAY, windowTo: now, n: tape.length, addedThisRun: added, sampled: true, bucket: w, longUsd: Math.round(longUsd), shortUsd: Math.round(shortUsd), rows: toRows(map) };
  });
  return out;
}

/* ---------- Hyperliquid: where the biggest accounts sit ---------- */
async function hlPositions(coins) {
  const res = { topN: TOP_N, accountsOk: 0, accountsFailed: 0, byCoin: {} };
  for (const c of coins) res.byCoin[c] = { longUsd: 0, shortUsd: 0, nLong: 0, nShort: 0, entry: new Map(), liqPx: new Map(), biggest: [] };
  let addrs = [];
  try {
    const r = await fetch('https://stats-data.hyperliquid.xyz/Mainnet/leaderboard');
    const j = await r.json();
    addrs = (j.leaderboardRows || []).map(x => ({ a: x.ethAddress, v: +x.accountValue })).filter(x => x.a && x.v > 0).sort((a, b) => b.v - a.v).slice(0, TOP_N);
  } catch (e) { res.error = 'leaderboard: ' + (e.message || e); return res; }
  res.leaderboardRows = addrs.length;
  for (let i = 0; i < addrs.length; i++) {
    try {
      const st = await hl({ type: 'clearinghouseState', user: addrs[i].a });
      res.accountsOk++;
      for (const ap of st.assetPositions || []) {
        const p = ap.position; if (!p || !res.byCoin[p.coin]) continue;
        const sz = +p.szi; if (!sz) continue;
        const side = sz > 0 ? 'long' : 'short', entry = +p.entryPx, liq = p.liquidationPx == null ? null : +p.liquidationPx, usd = Math.abs(+p.positionValue);
        const b = res.byCoin[p.coin], w = BUCKET[p.coin] || 1;
        b[side === 'long' ? 'longUsd' : 'shortUsd'] += usd; b[side === 'long' ? 'nLong' : 'nShort']++;
        addTo(b.entry, bucketOf(entry, w), side, usd);
        if (liq && liq > 0) addTo(b.liqPx, bucketOf(liq, w), side, usd);
        b.biggest.push({ side, entryPx: entry, liqPx: liq, usd: Math.round(usd), lev: p.leverage && p.leverage.value, addr: addrs[i].a.slice(0, 6) + '…' + addrs[i].a.slice(-4) });
      }
    } catch (e) { res.accountsFailed++; }
    await sleep(120);   // clearinghouseState weight 2 → stays well under HL's 1200/min budget
  }
  for (const c of coins) { const b = res.byCoin[c]; b.entry = toRows(b.entry); b.liqPx = toRows(b.liqPx); b.biggest = b.biggest.sort((x, y) => y.usd - x.usd).slice(0, 10); b.longUsd = Math.round(b.longUsd); b.shortUsd = Math.round(b.shortUsd); b.bucket = BUCKET[c] || 1; }
  return res;
}

/* ---------- main ---------- */
mkdirSync(OUT, { recursive: true });
const out = { taken: now, takenIso: new Date(now).toISOString(), coins: {}, hl: null, version: 1 };
for (const c of COINS) { log('okx', c); out.coins[c] = await okxCoin(c); }
log('hyperliquid top', TOP_N);
out.hl = await hlPositions(COINS);
for (const c of COINS) { out.coins[c].positions = out.hl.byCoin[c] || null; }
delete out.hl.byCoin;
writeFileSync(`${OUT}/market.json`, JSON.stringify(out));
log('wrote', `${OUT}/market.json`, JSON.stringify(out).length, 'bytes; HL accounts ok', out.hl.accountsOk, 'failed', out.hl.accountsFailed);
