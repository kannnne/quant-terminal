// Weekly Copy Desk roster: the 100 Hyperliquid addresses the copy bots follow for the coming week.
//
// The Copy Desk charter (§一) has always said the roster is re-frozen every Monday from the live leaderboard,
// but nothing in the repo ever did it: the first roster was hand-built on 2026-09-05 and the two Mondays after
// it were missed. Kane chose automation on 2026-09-14 (option A). This module is that automation. It is called
// by snapshot.mjs on Mondays and writes data/copy-roster-<Monday>.json, which copy.html already knows how to load.
//
// Filter and ordering are the charter's, unchanged: account value >= $20,000, 30-day volume >= $1,000,000,
// 30-day pnl > 0, sorted by 30-day ROI, top 100. The per-trader fields mirror the first roster file so that
// whoSet() on the page ("steady", "low leverage", "whales") keeps meaning the same thing week to week.
//
// ROI scale: Hyperliquid reports roi as a fraction (0.5 = +50%) and the page renders `mroi * 100`. This file
// stores the fraction as received and says so with roiScale: 1 -- the same unit the hand-built 2026-09-05 file
// used. Very large values are genuine: on the first automated roster three accounts have roi × 100 equal to
// their pnl to the cent, i.e. Hyperliquid floors the ROI denominator at ~$100 for accounts that started the
// window near-empty. "Top 100 by 30-day ROI" therefore favours tiny-starting-balance lottery winners; the
// av >= $20k filter is on CURRENT value and does not prevent it. Whether to change the rule is Kane's call.
import { writeFileSync, existsSync } from 'node:fs';

const LB_URL = 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard';
const INFO_URL = 'https://api.hyperliquid.xyz/info';
const DAY = 86400e3;
export const FILTER = { minAccountValue: 20000, minMonthVolume: 1e6, minMonthPnl: 0, top: 100 };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = v => { const n = +v; return Number.isFinite(n) ? n : null; };

/** Apply the charter's filter and ordering to raw leaderboard rows. Pure; unit-tested. */
export function selectRoster(rows, filter = FILTER) {
  const out = [];
  for (const x of rows || []) {
    if (!x || typeof x.ethAddress !== 'string') continue;
    const perf = {}; for (const [w, p] of x.windowPerformances || []) perf[w] = p || {};
    const m = perf.month || {}, w = perf.week || {}, a = perf.allTime || {};
    const av = num(x.accountValue), mvlm = num(m.vlm), mpnl = num(m.pnl), mroi = num(m.roi);
    if (av == null || mvlm == null || mpnl == null || mroi == null) continue;
    if (av < filter.minAccountValue || mvlm < filter.minMonthVolume || mpnl <= filter.minMonthPnl) continue;
    out.push({ a: x.ethAddress.toLowerCase(), name: x.displayName || null, av, mroi, mpnl, mvlm,
               wroi: num(w.roi), wpnl: num(w.pnl), aroi: num(a.roi), apnl: num(a.pnl) });
  }
  out.sort((p, q) => q.mroi - p.mroi || p.a.localeCompare(q.a));
  return out.slice(0, filter.top);
}

/** Summarise 30 days of fills the way the first roster did. Pure; unit-tested. */
export function summariseFills(fills) {
  let nClose = 0, wins = 0, rpnl = 0, fee = 0, last = 0, first = Infinity; const coins = new Map();
  for (const f of fills) {
    const t = num(f.time); if (t == null) continue;
    last = Math.max(last, t); first = Math.min(first, t);
    coins.set(f.coin, (coins.get(f.coin) || 0) + 1);
    if (/^Close/.test(f.dir || '')) { nClose++; const p = num(f.closedPnl) || 0; if (p > 0) wins++; }
    rpnl += num(f.closedPnl) || 0; fee += num(f.fee) || 0;
  }
  return { nFills30: fills.length, nClose30: nClose, win30: nClose ? wins / nClose : null, rpnl30: rpnl, fee30: fee,
           lastFill: last || null, firstFillKnown: Number.isFinite(first) ? first : null,
           coins: [...coins.entries()].sort((p, q) => q[1] - p[1]).slice(0, 8).map(e => e[0]) };
}

/** Summarise clearinghouseState the way the first roster did. Pure; unit-tested. */
export function summariseState(st) {
  const ps = (st && st.assetPositions || []).map(p => p.position || {}).filter(p => num(p.szi));
  const levs = ps.map(p => p.leverage && num(p.leverage.value)).filter(v => v != null);
  return { nPos: ps.length, posNotional: Math.round(ps.reduce((s, p) => s + Math.abs(num(p.positionValue) || 0), 0)),
           lev: levs.length ? Math.round(levs.reduce((s, v) => s + v, 0) / levs.length) : null,
           mm: st && st.marginSummary ? num(st.marginSummary.totalMarginUsed) : null };
}

async function info(body, fetchFn) {
  const r = await fetchFn(INFO_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`info ${body.type} HTTP ${r.status}`);
  return r.json();
}

async function fills30(addr, now, fetchFn, pace) {
  const out = []; let st = now - 30 * DAY;
  for (let i = 0; i < 3; i++) {                                  // 3 pages x 2,000 = plenty; the first roster capped at 2,000
    const r = await info({ type: 'userFillsByTime', user: addr, startTime: st, endTime: now }, fetchFn);
    if (!Array.isArray(r) || !r.length) break;
    out.push(...r); if (r.length < 2000) break;
    st = r[r.length - 1].time + 1; await sleep(pace);
  }
  return out;
}

/**
 * Build the roster for `mondayIso` (YYYY-MM-DD). Returns { file, roster } or null when the file already exists.
 * `deps` lets the test inject fetch and a fast pace; production uses global fetch and 1.1 s between calls
 * (userFillsByTime carries weight 20 against a 1,200/min budget, and this runs ahead of Copy Desk's own sync).
 */
export async function buildRoster(mondayIso, deps = {}) {
  const fetchFn = deps.fetch || globalThis.fetch, pace = deps.pace ?? 1100, log = deps.log || (() => {}), now = deps.now || Date.now();
  const file = `data/copy-roster-${mondayIso}.json`;
  if (!deps.force && existsSync(file)) return null;
  const r = await fetchFn(LB_URL); if (!r.ok) throw new Error('leaderboard HTTP ' + r.status);
  const lb = await r.json();
  const picked = selectRoster(lb.leaderboardRows || lb.rows || [], deps.filter || FILTER);
  log('roster: leaderboard rows', (lb.leaderboardRows || []).length, '-> selected', picked.length);
  if (picked.length < 50) throw new Error('roster: only ' + picked.length + ' addresses passed the filter — refusing to freeze a thin roster');
  const traders = [];
  for (const t of picked) {
    let f = { nFills30: null, nClose30: null, win30: null, rpnl30: null, fee30: null, lastFill: null, firstFillKnown: null, coins: [] };
    let s = { nPos: null, posNotional: null, lev: null, mm: null };
    try { f = summariseFills(await fills30(t.a, now, fetchFn, pace)); } catch (e) { log('roster: fills failed', t.a.slice(0, 10), e.message); }
    await sleep(pace);
    try { s = summariseState(await info({ type: 'clearinghouseState', user: t.a }, fetchFn)); } catch (e) { log('roster: state failed', t.a.slice(0, 10), e.message); }
    await sleep(pace);
    traders.push({ ...t, ...f, ...s });
  }
  const roster = { frozen: now, source: 'hyperliquid leaderboard · filter av>=20k, 30d vlm>=1M, 30d pnl>0 · sort 30d roi · built by scripts/roster.mjs', roiScale: 1, filter: deps.filter || FILTER, traders };
  if (!deps.dryRun) writeFileSync(file, JSON.stringify(roster));
  return { file, roster };
}

/** Monday (UTC) that the given time falls in, as YYYY-MM-DD. */
export function mondayOf(ms) { const d = new Date(ms); const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7))); return m.toISOString().slice(0, 10); }
