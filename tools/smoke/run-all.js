'use strict';
// 全国検証: GTFSデータリポジトリの運行中フィードすべてで、読み込み→計算が通るかを確かめる。
// 結果は analysis/nationwide/results.jsonl に1フィード1行で追記し、途中で止めても続きから再開できる。
// 使い方: node tools/smoke/run-all.js
const fs = require('fs');
const path = require('path');
const { fetchCatalog, fetchFeedZip, filesFromZip, metaOf, core } = require('../gtfs-node');
const { unzip } = require('../unzip');

const OUT = path.join(__dirname, '..', '..', 'analysis', 'nationwide');
const RESULTS = path.join(OUT, 'results.jsonl');
const CONCURRENCY = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ymd(d) { return d.toISOString().slice(0, 10); }
function parseYmd(s) {
  const m = String(s || '').replace(/-/g, '').match(/^(\d{4})(\d{2})(\d{2})$/);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
}

// 2026-11-07 以降で、フィードの有効期間に入る最初の土曜と平日。期間が過去なら期間の末尾から探す
function candidateDates(meta) {
  const from = parseYmd(meta.start) || new Date(Date.UTC(2026, 10, 7));
  const to = parseYmd(meta.end) || new Date(Date.UTC(2027, 2, 31));
  const anchor = new Date(Date.UTC(2026, 10, 7));
  const out = [];
  const scan = (start, step) => {
    let sat = null, wk = null;
    for (let i = 0, d = new Date(start); i < 400 && d >= from && d <= to; i++, d = new Date(d.getTime() + step * 86400000)) {
      const w = d.getUTCDay();
      if (!sat && w === 6) sat = ymd(d);
      if (!wk && w >= 1 && w <= 5) wk = ymd(d);
      if (sat && wk) break;
    }
    return [sat, wk].filter(Boolean);
  };
  if (to >= anchor) out.push(...scan(anchor < from ? from : anchor, 1));
  if (!out.length) out.push(...scan(to, -1));
  return out;
}

async function one(c) {
  const meta = metaOf(c);
  const rec = { org: meta.org, feed: meta.feed, name: meta.name, pref: c.feed_pref_id, start: meta.start, end: meta.end };
  const t0 = Date.now();
  let buf;
  try { buf = await fetchFeedZip(meta.org, meta.feed, 120000); }
  catch (e) { return Object.assign(rec, { ok: false, category: 'fetch', error: e.message }); }
  rec.bytes = buf.length;
  rec.fetchSec = (Date.now() - t0) / 1000;
  let files;
  try {
    const entries = unzip(buf);
    rec.utf8 = true;
    for (const [n, data] of Object.entries(entries)) {
      if (!/stops\.txt$/.test(n) || !data) continue;
      try { new TextDecoder('utf-8', { fatal: true }).decode(data); } catch (e) { rec.utf8 = false; }
    }
    files = filesFromZip(buf);
  } catch (e) { return Object.assign(rec, { ok: false, category: 'zip', error: e.message }); }
  rec.files = Object.keys(files);
  const net = core.createNetwork();
  const t1 = Date.now();
  try {
    const info = core.addFeed(net, files, meta);
    core.finalize(net);
    rec.warnings = info.warnings;
    rec.stats = info.stats;
  } catch (e) {
    return Object.assign(rec, { ok: false, category: /がありません/.test(e.message) ? 'missing_file' : 'exception_load', error: e.message });
  }
  rec.loadSec = (Date.now() - t1) / 1000;
  rec.kanaPct = net.stops.length ? Math.round(1000 * net.stops.filter((s) => s.kana).length / net.stops.length) / 10 : 0;
  try {
    let date = null, act = null, active = 0;
    for (const d of candidateDates(meta)) {
      const a = core.activeMask(net, d);
      const n = a.reduce((x, y) => x + y, 0);
      if (n > active) { date = d; act = a; active = n; }
      if (n > 0 && /-/.test(d) && core.weekdayOf(d) === 5) break;
    }
    if (!active) {
      // 週に数日だけ走る便や、案内上の有効期間と実データがずれるフィードがあるので、先の日付も探す
      const d = core.nextServiceDate(net, '2026-10-31', 240);
      if (d) { date = d; act = core.activeMask(net, d); active = act.reduce((x, y) => x + y, 0); rec.dateFallback = true; }
    }
    rec.date = date;
    rec.activeTrips = active;
    if (!active) return Object.assign(rec, { ok: false, category: 'no_service', error: '検証日に運行便がない' });
    const count = new Map();
    for (let ti = 0; ti < net.trips.length; ti++) {
      if (!act[ti]) continue;
      for (const s of net.trips[ti].stops) count.set(s, (count.get(s) || 0) + 1);
    }
    const hubs = [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s]) => s);
    const P = { depart: 36000, budget: 3600, walk: 400, stay: 5400, curfew: 61200, transfers: 0 };
    rec.samples = hubs.map((s) => {
      const st = net.stops[s];
      const R = core.compute(net, core.nearStops(net, st.lat, st.lon, P.walk), P, act);
      return { stop: st.name, ok: R.ok, oneway: R.oneway };
    });
    const N = net.stops.length;
    const n = Math.min(N, N <= 3000 ? N : 300);
    const t2 = Date.now();
    let zero = 0;
    for (let i = 0; i < n; i++) if (core.townScore(net, i, P, act) === 0) zero++;
    rec.townSec = ((Date.now() - t2) / 1000) * (N / n);
    rec.townEstimated = n < N;
    rec.townZeroPct = Math.round(1000 * zero / n) / 10;
  } catch (e) {
    return Object.assign(rec, { ok: false, category: 'exception_compute', error: e.message, stack: String(e.stack).split('\n').slice(0, 3).join(' | ') });
  }
  return Object.assign(rec, { ok: true });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const done = new Set();
  if (fs.existsSync(RESULTS)) for (const l of fs.readFileSync(RESULTS, 'utf8').split('\n')) if (l) { const r = JSON.parse(l); done.add(r.org + '/' + r.feed); }
  const cat = (await fetchCatalog()).filter((c) => !c.feed_is_discontinued);
  const todo = cat.filter((c) => !done.has(c.organization_id + '/' + c.feed_id));
  console.log(`対象 ${cat.length} 件、処理済み ${done.size} 件、残り ${todo.length} 件`);
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const c = todo[i++];
      let r;
      try { r = await one(c); } catch (e) { r = { org: c.organization_id, feed: c.feed_id, name: c.feed_name, ok: false, category: 'crash', error: e.message }; }
      fs.appendFileSync(RESULTS, JSON.stringify(r) + '\n');
      console.log(`${r.ok ? 'OK ' : 'NG '} ${r.name}（${r.org}/${r.feed}）${r.ok ? `停留所${r.stats.stops} 便${r.stats.trips} ${r.loadSec}s` : `${r.category}: ${r.error}`}`);
      await sleep(250);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log('完了');
})().catch((e) => { console.error(e); process.exit(1); });
