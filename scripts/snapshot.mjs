// Hourly snapshot of the three research pages (Signal Desk, Copy Desk, REKT Lab), run by GitHub Actions.
// Opens the live GitHub Pages site in headless Chromium, waits for each page to finish its own load/replay,
// and writes compact JSON to data/live/ for the twice-daily report agents. Read-only: it changes nothing
// about how the pages compute; it only records what a visitor would see at that moment.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';

const BASE = process.env.SITE || 'https://kannnne.github.io/quant-terminal';
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
      feed: [...document.querySelectorAll('#feed .frow')].slice(0, 25).map(r => r.innerText.replace(/\s+/g, ' ').trim()),
    };
  });
  d.loadMs = Date.now() - t0; d.pageErrors = errs.slice(0, 5);
  await page.close(); return d;
}

/* ---------------- Signal Desk ---------------- */
async function snapSignals() {
  const page = await ctx.newPage(); const errs = []; page.on('pageerror', e => errs.push(e.message));
  const t0 = Date.now();
  await page.goto(`${BASE}/signals.html?still&snap=${now}`, { waitUntil: 'domcontentloaded' });
  await waitFor(page, () => /^Live|^Error/.test((document.getElementById('connTxt') || {}).textContent || ''), 4 * 60e3, 'signals live');
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
      foot: T('#foot')?.slice(0, 200),
    };
  });
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
  d.loadMs = Date.now() - t0; d.pageErrors = errs.slice(0, 5);
  await page.close(); return d;
}

for (const [name, fn] of [['copy', snapCopy], ['signals', snapSignals], ['rekt', snapRekt]]) {
  try { log('snapshot', name); out.pages[name] = await fn(); log(name, 'ok in', out.pages[name].loadMs, 'ms'); }
  catch (e) { log(name, 'FAILED', e.message); out.pages[name] = { error: String(e.message).slice(0, 300) }; }
}
await browser.close();

/* ---------------- write files ---------------- */
const write = (f, obj) => { const s = JSON.stringify(obj); writeFileSync(`${OUT}/${f}`, s); log('wrote', f, s.length, 'bytes'); };
for (const k of ['copy', 'signals', 'rekt']) write(`${k}.json`, { taken: now, takenIso: out.takenIso, page: k, ...out.pages[k] });
write('latest.json', { taken: now, takenIso: out.takenIso, site: BASE, pages: Object.fromEntries(Object.entries(out.pages).map(([k, v]) => [k, v.error ? { error: v.error } : { ok: true, loadMs: v.loadMs, conn: v.conn }])) });

// rolling hourly history (kept small: one line per hour, 14 days)
const hf = `${OUT}/history.json`;
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
