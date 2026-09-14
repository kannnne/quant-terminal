// Hourly snapshot of the three research pages (Signal Desk, Copy Desk, REKT Lab), run by GitHub Actions.
// Opens the live GitHub Pages site in headless Chromium, waits for each page to finish its own load/replay,
// and writes compact JSON to data/live/ for the twice-daily report agents. Read-only: it changes nothing
// about how the pages compute; it only records what a visitor would see at that moment.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';

const BASE = process.env.SITE || 'https://kannnne.github.io/quant-terminal';
const TRADOOOR = process.env.TRADOOOR || 'https://tradooor.rekt.com';   // tests point this at a local replay of their API
const OUT = 'data/live';
const H1 = 3600e3, DAY = 86400e3;
const now = Date.now();
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME, args: ['--no-sandbox'] } : {});
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 }, userAgent: 'quant-terminal-snapshot/1.0 (+github actions)' });
ctx.setDefaultTimeout(30e3);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const txt = (page, sel) => page.evaluate(s => { const el = document.querySelector(s); return el ? el.innerText.replace(/\s+/g, ' ').trim() : null; }, sel);
const rows = (page, sel, n) => page.evaluate(([s, k]) => [...document.querySelectorAll(s)].slice(0, k).map(r => [...r.children].map(c => c.innerText.replace(/\s+/g, ' ').trim())), [sel, n]);
const SCALE = +process.env.WAIT_SCALE || 1;   // tests pass WAIT_SCALE=0.01 to shorten every wait
const waitFor = async (page, fn, ms, label) => { try { await page.waitForFunction(fn, null, { timeout: ms * SCALE }); return true; } catch (e) { log('timeout waiting for', label); return false; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = { taken: now, takenIso: new Date(now).toISOString(), site: BASE, pages: {} };

/* ---------------- Copy Desk (first: it writes the leader-flow board the Signal Desk reads) ---------------- */
async function snapCopy() {
  const page = await ctx.newPage(); const errs = []; page.on('pageerror', e => errs.push(e.message));
  const t0 = Date.now();
  await page.goto(`${BASE}/copy.html?still&snap=${now}`, { waitUntil: 'domcontentloaded' });
  await waitFor(page, () => document.querySelector('#top10 tr') || (document.getElementById('connTxt') || {}).textContent === 'Error', 6 * 60e3, 'copy first render');
  await waitFor(page, () => window.COPY && !COPY.state.syncing, 6 * 60e3, 'copy sync');
  await waitFor(page, () => window.COPY && !(COPY.state.live && COPY.state.live.barsPending), 3 * 60e3, 'copy bars');
  // Signal Desk's attention x smart-money board reads localStorage.qt_leaderflow, which Copy Desk only fills on the
  // render that follows the fill sync. Waiting on `!syncing` alone was not enough: the 2026-09-07/08 snapshots
  // captured the page mid-refresh, wrote an EMPTY board, and every attention row came back "attention only".
  await waitFor(page, () => { try { const lf = JSON.parse(localStorage.getItem('qt_leaderflow') || 'null'); return !!(lf && lf.rows && lf.rows.length); } catch (e) { return false; } }, 3 * 60e3, 'copy leader-flow board');
  await sleep(5000);
  const d = await page.evaluate(() => {
    const S = COPY.state, H1 = 3600e3, now = Date.now();
    const r = S.rosters && S.rosters[0];
    const lf = JSON.parse(localStorage.getItem('qt_leaderflow') || 'null');
    // 24h flow per market from the raw tape (perps only): who opened what, and the net notional
    const agg = new Map();
    for (const e of S.events || []) { if (e.spot || e.t < now - 24 * H1 || !e.open) continue; const a = agg.get(e.coin) || { coin: e.coin, opensL: 0, opensS: 0, leaders: new Set(), buy: 0, sell: 0, last: 0 };
      if (e.side === 1) { a.opensL++; a.buy += e.notional; } else { a.opensS++; a.sell += e.notional; } a.leaders.add(e.a); a.last = Math.max(a.last, e.t); agg.set(e.coin, a); }
    const flow24 = [...agg.values()].map(a => ({ coin: a.coin, opensL: a.opensL, opensS: a.opensS, leaders: a.leaders.size, buyUsd: Math.round(a.buy), sellUsd: Math.round(a.sell), lastIso: new Date(a.last).toISOString().slice(0, 16) })).sort((p, q) => q.leaders - p.leaders || (q.buyUsd + q.sellUsd) - (p.buyUsd + p.sellUsd)).slice(0, 40);
    const scored = (S.scored || []).slice(0, 15).map(x => ({ id: x.g.id, rule: COPY.desc(x.g), ret: +x.s.ret.toFixed(2), trades: x.s.trades, inPos: x.s.inPos, open: x.s.open ? x.s.open.map(o => (o.side === 1 ? 'L ' : 'S ') + o.coin) : undefined }));
    const all = S.scored || [];
    const grp = key => { const m = {}; for (const x of all) { const k = String(x.g[key]); (m[k] = m[k] || []).push(x.s.ret); } return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { n: v.length, avg: +(v.reduce((s, y) => s + y, 0) / v.length).toFixed(2) }])); };
    const closes24 = (S.events || []).filter(e => !e.spot && !e.open && e.t >= now - 24 * H1);
    const pnl24 = closes24.reduce((s, e) => s + (+e.pnl || 0), 0);
    return {
      conn: (document.getElementById('connTxt') || {}).textContent, foot: ((document.getElementById('foot') || {}).innerText || '').replace(/\s+/g, ' ').slice(0, 300),
      chips: ['cPrice', 'cPriceD', 'cRoster', 'cRosterD', 'cTape', 'cTapeD', 'cArena', 'cArenaD'].map(id => (document.getElementById(id) || {}).textContent),
      roster: r ? { frozenIso: new Date(r.frozen).toISOString().slice(0, 16), n: r.traders.length, top5: r.traders.slice(0, 5).map(t => ({ name: t.name || t.a.slice(0, 6) + '…' + t.a.slice(-4), mroi: t.mroi, av: t.av, win30: t.win30, lev: t.lev, coins: (t.coins || []).slice(0, 5) })) } : null,
      leaderFlow: lf ? { tIso: new Date(lf.t).toISOString().slice(0, 16), rows: (lf.rows || []).slice(0, 40) } : null,
      flow24, tape24: { closes: closes24.length, realizedPnlUsd: Math.round(pnl24), opens: (S.events || []).filter(e => !e.spot && e.open && e.t >= now - 24 * H1).length },
      heatTag: (document.getElementById('heatTag') || {}).textContent, arenaTag: (document.getElementById('arenaTag') || {}).textContent, arenaNote: (document.getElementById('arenaNote') || {}).textContent,
      arenaTop: scored, groups: { who: grp('who'), delay: grp('delay'), k: grp('k'), exit: grp('exit'), lev: grp('lev'), sl: grp('sl') },
      seats: { n: all.length, profitable: all.filter(x => x.s.ret > 0).length, inPos: all.filter(x => x.s.inPos > 0).length, avg: all.length ? +(all.reduce((s, x) => s + x.s.ret, 0) / all.length).toFixed(2) : null, gen: S.arena && S.arena.gen, retired: S.arena && S.arena.deaths },
      // Copy Desk v2.3: buy-and-hold BTC from the same freeze, our fees and funding. The arena runs
      // 90%+ long, so the seat average only means something next to this line — `excess` is the test.
      bench: S.bench ? { coin: S.bench.coin, lev: S.bench.lev, ret: +S.bench.ret.toFixed(2), gross: +S.bench.gross.toFixed(2), cost: +S.bench.cost.toFixed(2), entry: S.bench.entry, px: S.bench.px } : null,
      feed: [...document.querySelectorAll('#feed .frow')].slice(0, 25).map(r => r.innerText.replace(/\s+/g, ' ').trim()),
    };
  });
  d.banner = await page.evaluate(() => ((document.getElementById('errBanner') || {}).textContent || '').trim().slice(0, 300) || null);
  d.loadMs = Date.now() - t0; d.pageErrors = errs.slice(0, 5);
  await page.close(); return d;
}

/* ---------------- Signal Desk ---------------- */
async function snapSignals() {
  const page = await ctx.newPage(); const errs = []; page.on('pageerror', e => errs.push(e.message));
  const t0 = Date.now();
  await page.goto(`${BASE}/signals.html?still&snap=${now}`, { waitUntil: 'domcontentloaded' });
  await waitFor(page, () => /^Live|^Degraded|^Error/.test((document.getElementById('connTxt') || {}).textContent || ''), 4 * 60e3, 'signals live');
  await sleep(2000);
  const d = await page.evaluate(() => {
    const T = s => { const el = document.querySelector(s); return el ? el.innerText.replace(/\s+/g, ' ').trim() : null; };
    const cards = [...document.querySelectorAll('#sgrid .sig')].map(c => ({ name: c.querySelector('.k b')?.innerText, src: c.querySelector('.k span')?.innerText, val: c.querySelector('.v')?.innerText.replace(/\s+/g, ' ').trim(), read: c.querySelector('.r')?.innerText.replace(/\s+/g, ' ').trim(), live: c.classList.contains('live') }));
    const gauges = [...document.querySelectorAll('#gauges .gauge')].map(g => ({ title: g.querySelector('.t')?.innerText, value: g.querySelector('text')?.textContent, sub: g.querySelector('.s')?.innerText }));
    const attn = [...document.querySelectorAll('#attn tr')].slice(0, 30).map(r => { const c = [...r.children].map(x => x.innerText.replace(/\s+/g, ' ').trim()); return c.length >= 9 ? { rank: c[0], token: c[1], where: c[2], chg24: c[3], leaders4h: c[4], leaders24h: c[5], net24h: c[6], firstTouch: c[7], read: c[8] } : { row: c.join(' | ') }; });
    const sc = (window.SIG && SIG.state.scored) || [];
    return {
      conn: T('#connTxt'), chips: ['cPrice', 'cPriceD', 'cCrowd', 'cCrowdD', 'cSent', 'cSentD', 'cArena', 'cArenaD'].map(id => (document.getElementById(id) || {}).textContent),
      readTag: T('#readTag'), read: T('#readTxt'), cards, gauges,
      attentionTag: T('#attnTag'), attention: attn,
      arenaTag: T('#arenaTag'), arenaNote: T('#arenaNote'),
      arenaTop: sc.slice(0, 12).map(x => ({ id: x.g.id, ret: +x.s.ret.toFixed(2), trades: x.s.trades, inPos: x.s.inPos, side: x.s.side, block: x.g.block, mode: x.g.mode, lev: x.g.lev, hold: x.g.hold })),
      seats: { n: sc.length, profitable: sc.filter(x => x.s.ret > 0).length, inPos: sc.filter(x => x.s.inPos).length, avg: sc.length ? +(sc.reduce((s, x) => s + x.s.ret, 0) / sc.length).toFixed(2) : null },
      species: [...document.querySelectorAll('#species .sp')].map(s => s.innerText.replace(/\s+/g, ' ').trim()),
      feed: [...document.querySelectorAll('#feed .frow')].slice(0, 25).map(r => r.innerText.replace(/\s+/g, ' ').trim()),
      degraded: (window.SIG && SIG.state.degraded) || null, foot: T('#foot')?.slice(0, 200),
    };
  });
  d.banner = await page.evaluate(() => ((document.getElementById('errBanner') || {}).textContent || '').trim().slice(0, 300) || null);
  d.loadMs = Date.now() - t0; d.pageErrors = errs.slice(0, 5);
  await page.close(); return d;
}

/* ---------------- REKT Lab ---------------- */
async function snapRekt() {
  const page = await ctx.newPage(); const errs = []; page.on('pageerror', e => errs.push(e.message));
  const t0 = Date.now();
  await page.goto(`${BASE}/rekt.html?still&snap=${now}`, { waitUntil: 'domcontentloaded' });
  await waitFor(page, () => /^Gen /.test((document.getElementById('arenaTag') || {}).textContent || '') || (document.getElementById('connTxt') || {}).textContent === 'Error', 9 * 60e3, 'rekt arena');
  await waitFor(page, () => window.REKT && REKT.state.shadowMeta && REKT.state.shadowMeta.ready, 8 * 60e3, 'rekt shadow');
  await sleep(2000);
  const d = await page.evaluate(() => {
    const T = s => { const el = document.querySelector(s); return el ? el.innerText.replace(/\s+/g, ' ').trim() : null; };
    const S = REKT.state, sc = S.scored || [];
    const byKey = (key, names) => { const m = {}; for (const x of sc) { const k = names ? names[x.g[key]] : String(x.g[key]); (m[k] = m[k] || []).push(x); } return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { n: v.length, avg: +(v.reduce((s, y) => s + y.s.ret, 0) / v.length).toFixed(2), profitable: v.filter(y => y.s.ret > 0).length, trades: v.reduce((s, y) => s + y.s.trades, 0), liqs: v.reduce((s, y) => s + (y.s.liqs || 0), 0) }])); };
    const coinsHeld = {}; for (const x of sc) if (x.s.open) for (const o of x.s.open) { const k = o.coin; coinsHeld[k] = coinsHeld[k] || { long: 0, short: 0 }; if (o.side === 1) coinsHeld[k].long++; else coinsHeld[k].short++; }
    return {
      conn: T('#connTxt'), chips: ['cPrice', 'cPriceD', 'cSpecies', 'cSpeciesD', 'cShadow', 'cShadowD', 'cArena', 'cArenaD'].map(id => (document.getElementById(id) || {}).textContent),
      arenaTag: T('#arenaTag'), arenaNote: T('#arenaNote'),
      arenaTop: sc.slice(0, 12).map(x => ({ id: x.g.id, rule: REKT.desc(x.g), arch: (typeof ARCH !== 'undefined' && ARCH[x.g.arch]) || x.g.arch, alleg: x.g.alleg, ret: +x.s.ret.toFixed(2), trades: x.s.trades, liqs: x.s.liqs, open: x.s.open ? x.s.open.map(o => (o.side === 1 ? 'L ' : 'S ') + o.coin) : [] })),
      seats: { n: sc.length, profitable: sc.filter(x => x.s.ret > 0).length, inPos: sc.filter(x => x.s.inPos).length, avg: sc.length ? +(sc.reduce((s, x) => s + x.s.ret, 0) / sc.length).toFixed(2) : null, gen: S.arena && S.arena.gen, retired: S.arena && S.arena.deaths },
      archetypes: byKey('arch'), allegiance: byKey('alleg', (typeof TIER !== 'undefined' && TIER.alleg) || ['Blue-chip purist', 'Majors tourist', 'Diversified', 'Tail believer', 'Tail maxi']),
      coinsHeld: Object.entries(coinsHeld).sort((a, b) => (b[1].long + b[1].short) - (a[1].long + a[1].short)).slice(0, 25).map(([c, v]) => ({ coin: c, ...v })),
      universe: S.universe ? { n: (S.universe.coins || []).length, frozenIso: S.universe.frozen ? new Date(S.universe.frozen).toISOString().slice(0, 16) : null } : null,
      species: [...document.querySelectorAll('#species .sp')].map(s => s.innerText.replace(/\s+/g, ' ').trim()),
      shadowTag: T('#shadowTag'), shadowNote: T('#shadowNote')?.slice(0, 600), shadow: [...document.querySelectorAll('#shadow tr')].slice(0, 12).map(r => [...r.children].map(c => c.innerText.replace(/\s+/g, ' ').trim()).join(' | ')),
      feed: [...document.querySelectorAll('#feed .frow')].slice(0, 30).map(r => r.innerText.replace(/\s+/g, ' ').trim()),
      priced: S.live && S.live.priced, foot: T('#foot')?.slice(0, 200),
    };
  });
  d.banner = await page.evaluate(() => ((document.getElementById('errBanner') || {}).textContent || '').trim().slice(0, 300) || null);
  d.loadMs = Date.now() - t0; d.pageErrors = errs.slice(0, 5);
  await page.close(); return d;
}

/* ---------------- tradooor.rekt.com · REKT's own live game (control group) ---------------- */
// Read-only observation of the game our Archetype Arena is a port of. We watch the MECHANISM, not the
// individuals: per-archetype survival across their 10,000 seats is the control our 100 seats are measured
// against. Their engine forces leverage up (squeeze floor only ever rises) and ours does not, so their
// leaderboard is never a copy list -- see claude/影子帳戶v2-tradooor頭部帳簿重放.md for why.
//
// Playwright is the only way in: robots.txt blocks plain fetchers and the API sends no CORS header, so the
// calls have to happen inside a real page on their own origin. Everything here is wrapped -- if their API
// shape changes or the season ends, this records an error and the other three pages are untouched.
async function snapTradooor() {
  const page = await ctx.newPage(); const t0 = Date.now();
  await page.goto(TRADOOOR + '/', { waitUntil: 'domcontentloaded', timeout: 60e3 });
  const d = await page.evaluate(async () => {
    const D = 1e8;                                   // their integers are 8-decimal fixed point
    const usd = v => +(Number(v) / D).toFixed(2);
    const j = async u => { const r = await fetch(u, { headers: { accept: 'application/json' } }); if (!r.ok) throw new Error(u + ' HTTP ' + r.status); return r.json(); };
    const b = await j('/api/w?u=board&n=400');
    const board = {
      meta: {
        tick: b.tick, epoch: b.epoch, alive: b.alive, population: b.populationCount,
        finished: !!b.finished, paused: !!b.paused, squeezeFloorX: b.squeezeFloorCenti / 100,
        maxLevX: b.maxLeverageCenti / 100, startCashUsd: usd(b.startingCashUsd),
        engine: b.season && b.season.engineVersion, dnaRoot: b.season && b.season.dnaRoot,
      },
      archetypes: Object.fromEntries(Object.entries(b.archetypes || {}).map(([k, v]) => [k, {
        alive: v.alive, total: v.total, alivePct: v.total ? +(100 * v.alive / v.total).toFixed(1) : null,
        avgPnlPct: +(v.avgPnlBps / 100).toFixed(1), bestId: v.best && v.best.tokenId, bestRank: v.best && v.best.rank,
      }])),
      top: b.leaders.slice(0, 15).map(r => ({ rank: r.rank, id: r.tokenId, arch: r.archetype, eq: usd(r.equityUsd), eq1h: usd(r.equity1hUsd) })),
      edge: (b.onTheEdge || []).slice(0, 10).map(r => ({ rank: r.rank, id: r.tokenId, arch: r.archetype, eq: usd(r.equityUsd) })),
      boardN: b.leaders.length,
    };
    // Fill-level tape for the top 12, for the shadow-desk replay. Overwritten each run, never accumulated.
    const pairs = [], reasons = [];
    const idx = (a, v) => { let i = a.indexOf(v); if (i < 0) { i = a.length; a.push(v); } return i; };
    const traders = {};
    for (const r of b.leaders.slice(0, 12)) {
      try {
        const t = await j('/api/w?u=trades&id=' + r.tokenId);
        traders[r.tokenId] = {
          rank: r.rank, arch: r.archetype, n: t.fillsTotal, eq: usd(t.book.equityUsd), peak: usd(t.book.peakEquityUsd),
          f: t.fills.map(x => [x.tick, x.ts, idx(pairs, x.pair), x.dir, usd(x.notionalDeltaUsd), usd(x.fillPrice), usd(x.realizedPnlUsd), idx(reasons, x.reason), x.levAfterCenti, usd(x.equityAfterUsd)]),
        };
      } catch (e) { traders[r.tokenId] = { rank: r.rank, error: String(e.message).slice(0, 120) }; }
    }
    return { board, fills: { pairs, reasons, cols: ['tick', 'ts', 'pairIdx', 'dir', 'notionalDeltaUsd', 'fillPrice', 'realizedPnlUsd', 'reasonIdx', 'levAfterCenti', 'equityAfterUsd'], traders } };
  });
  const r = { ...d.board, loadMs: Date.now() - t0 };
  r._fills = d.fills;                                // split out by the writer below, not kept in tradooor.json
  await page.close(); return r;
}

// Order matters twice over, and the two constraints pull against each other.
//  1. Copy Desk MUST run before Signal Desk: it writes the leader-flow board into localStorage (shared ctx), and
//     Signal Desk's attention x smart-money cross-check reads it from there. Putting Signal first on 2026-09-07
//     silently emptied that board — all 30 rows came back "attention only".
//  2. But Copy Desk's 100 leader-address queries drain the runner IP's Hyperliquid rate budget, which then starved
//     Signal Desk's price fallback and killed the page outright (2026-09-07 04:54 and 07:58).
// So: Copy, then a cooldown longer than Hyperliquid's 1-minute rate window, then Signal, then REKT.
// tradooor goes last: it is an outside site, nothing else depends on it, and a failure there must not cost
// us the three pages that matter.
const ONLY = (process.env.ONLY || '').split(',').map(s => s.trim()).filter(Boolean);   // ONLY=tradooor for a targeted run
for (const [name, fn] of [['copy', snapCopy], ['signals', snapSignals], ['rekt', snapRekt], ['tradooor', snapTradooor]]) {
  if (ONLY.length && !ONLY.includes(name)) continue;
  if (name === 'signals') { log('cooldown 75s to clear the Hyperliquid rate window'); await new Promise(r => setTimeout(r, 75e3)); }
  try { log('snapshot', name); out.pages[name] = await fn(); log(name, 'ok in', out.pages[name].loadMs, 'ms'); }
  catch (e) { log(name, 'FAILED', e.message); out.pages[name] = { error: String(e.message).slice(0, 300) }; }
}
await browser.close();

/* ---------------- write files ---------------- */
const write = (f, obj) => { const s = JSON.stringify(obj); writeFileSync(`${OUT}/${f}`, s); log('wrote', f, s.length, 'bytes'); };
// only rewrite what this run actually snapshotted, so a targeted ONLY= run never blanks the other files
for (const k of ['copy', 'signals', 'rekt']) if (out.pages[k]) write(`${k}.json`, { taken: now, takenIso: out.takenIso, page: k, ...out.pages[k] });

// tradooor: the small board goes to data/live/tradooor.json (what rekt.html renders); the fill tape goes to
// its own file so the board stays cheap to fetch. Neither accumulates -- both are overwritten every run.
// When their season ends we keep one dated copy, because after the closing bell that tape is gone for good.
{
  const t = out.pages.tradooor || {};
  const fills = t._fills; delete t._fills;
  write('tradooor.json', { taken: now, takenIso: out.takenIso, page: 'tradooor', src: 'tradooor.rekt.com', ...t });
  if (fills) {
    write('tradooor-fills.json', { taken: now, takenIso: out.takenIso, meta: t.meta || null, ...fills });
    if (t.meta && t.meta.finished) {
      const f = `data/tradooor-final-${out.takenIso.slice(0, 10)}.json`;
      if (!existsSync(f)) { writeFileSync(f, JSON.stringify({ taken: now, takenIso: out.takenIso, board: t, ...fills })); log('season finished — archived', f); }
    }
  }
}
// latest.json is the one file the report agents always read, so the tradooor headline rides along inside it
// rather than becoming a sixth URL they would have to be told about.
const td = out.pages.tradooor || {};
write('latest.json', {
  taken: now, takenIso: out.takenIso, site: BASE,
  pages: Object.fromEntries(Object.entries(out.pages).filter(([k]) => k !== 'tradooor').map(([k, v]) => [k, v.error ? { error: v.error } : { ok: !/^Error/.test(v.conn || ''), loadMs: v.loadMs, conn: v.conn, banner: v.banner }])),
  tradooor: td.error ? { error: td.error } : { ...(td.meta || {}), archetypes: td.archetypes || null, top: (td.top || []).slice(0, 5) },
});

// rolling hourly history (kept small: one line per hour, 14 days).
// A targeted ONLY= run has no business appending a row full of nulls to it.
const hf = `${OUT}/history.json`;
if (ONLY.length) { log('ONLY run — history.json left alone'); process.exit(0); }
let hist = []; try { if (existsSync(hf)) hist = JSON.parse(readFileSync(hf, 'utf8')); } catch (e) { hist = []; }
const c = out.pages.copy || {}, s = out.pages.signals || {}, r = out.pages.rekt || {};
hist.push({
  t: now, iso: out.takenIso.slice(0, 16),
  btc: (s.chips && s.chips[0]) || (c.chips && c.chips[0]) || null,
  crowd: s.chips && s.chips[2], sent: s.chips && s.chips[4],
  copyHeat: c.leaderFlow ? c.leaderFlow.rows.slice(0, 8).map(x => [x.coin, x.o24, Math.round((x.net || 0) / 1e3)]) : null,
  sigBuy: s.attention ? s.attention.filter(a => /net buying/.test(a.read || '')).map(a => (a.token || '').split(' ')[0]) : null,
  sigQuiet: s.attention ? s.attention.filter(a => /Quiet/.test(a.read || '')).map(a => (a.token || '').split(' ')[0]) : null,
  copySeats: c.seats || null, sigSeats: s.seats || null, rektSeats: r.seats || null,
  rektLeader: r.arenaTop && r.arenaTop[0] ? [r.arenaTop[0].id, r.arenaTop[0].ret] : null,
});
hist = hist.filter(h => h.t >= now - 14 * DAY);
write('history.json', hist);
log('done');
