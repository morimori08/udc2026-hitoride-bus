'use strict';
// ひとりで、バスに乗れた。— 子どもが「行けて、門限までに帰れる」範囲を GTFS から計算する中核
// 画面（DOM）に触れないので、ブラウザでは HBCore として、Node では require で読み込める。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HBCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const KID_WALK_M_PER_MIN = 60;   // 子どもの歩く速さ（分速60m）
  const NEAR_M = 150;              // 乗りかえで歩ける距離
  // 帰りは乗りかえより広く探す：八戸中心街ターミナルでは降りた八日町のりばと帰りの六日町のりばが214m離れている
  const RETURN_M = 300;
  const TRANSFER_BUFFER = 180;     // 乗りかえの余裕（秒）
  const GRID_DEG = 0.004;
  const GTFS_FILES = ['stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt', 'calendar.txt', 'calendar_dates.txt', 'frequencies.txt', 'translations.txt'];

  // ---------- 小道具 ----------
  function t2s(s) {
    if (!s) return NaN;
    const p = String(s).trim().split(':');
    if (p.length < 2) return NaN;
    const v = (+p[0]) * 3600 + (+p[1]) * 60 + (+(p[2] || 0));
    return Number.isFinite(v) ? v : NaN;
  }
  function s2t(sec) {
    const m = Math.round(sec / 60);
    return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
  }
  function hm2s(v) { const [h, m] = String(v).split(':').map(Number); return h * 3600 + m * 60; }
  function dist(aLat, aLon, bLat, bLon) {
    const x = (bLon - aLon) * Math.cos(((aLat + bLat) / 2) * Math.PI / 180);
    const y = bLat - aLat;
    return Math.sqrt(x * x + y * y) * 111320;
  }
  function walkSec(m) { return Math.round((m / KID_WALK_M_PER_MIN) * 60); }

  // zip 内のファイル名を GTFS の標準名に揃える。拡張子が .csv のフィード（つくバス等）や大文字混じりも受ける
  function gtfsName(path) {
    const base = String(path).split('/').pop().toLowerCase();
    const m = base.match(/^(.+)\.(txt|csv)$/);
    if (!m) return null;
    const std = m[1] + '.txt';
    return GTFS_FILES.includes(std) ? std : null;
  }

  // GTFS-JP の規定は UTF-8 だが、Shift_JIS のまま公開されたファイルも読めるようにする
  function decodeText(bytes) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (e) { return new TextDecoder('shift_jis').decode(bytes); }
  }

  function parseCSV(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    let rows;
    if (text.indexOf('"') < 0) {
      rows = text.split(/\r?\n/).filter((l) => l.length).map((l) => l.split(','));
    } else {
      rows = [];
      let row = [], f = '', q = false;
      for (let i = 0, n = text.length; i < n; i++) {
        const c = text[i];
        if (q) {
          if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
          else f += c;
        } else if (c === '"') q = true;
        else if (c === ',') { row.push(f); f = ''; }
        else if (c === '\n' || c === '\r') {
          row.push(f); f = '';
          if (row.length > 1 || row[0] !== '') rows.push(row);
          row = [];
          if (c === '\r' && text[i + 1] === '\n') i++;
        } else f += c;
      }
      if (f !== '' || row.length) { row.push(f); rows.push(row); }
    }
    const header = (rows.shift() || []).map((h) => h.trim());
    const col = (name) => header.indexOf(name);
    return { header, rows, col };
  }

  // ---------- ネットワークの組み立て ----------
  function createNetwork() {
    return { feeds: [], stops: [], trips: [], services: [], serviceIndex: new Map() };
  }

  // files: { 'stops.txt': 文字列, ... }（無いファイルは省く）。meta はフィードの名前・ライセンスなど
  function addFeed(net, files, meta) {
    const fi = net.feeds.length;
    const feed = Object.assign({ name: '', orgName: '', license: '', licenseUrl: '', start: '', end: '' }, meta || {}, { stats: {}, warnings: [] });
    net.feeds.push(feed);
    const warn = (w) => { if (!feed.warnings.includes(w)) feed.warnings.push(w); };
    const table = (name) => (files[name] == null ? null : parseCSV(files[name]));
    const id = (v) => (v == null ? '' : String(v).trim());

    const kanaById = new Map(), kanaByName = new Map();
    const tr = table('translations.txt');
    if (tr) {
      const cLang = tr.col('language') >= 0 ? tr.col('language') : tr.col('lang');
      const cTr = tr.col('translation'), cTable = tr.col('table_name'), cField = tr.col('field_name');
      const cRec = tr.col('record_id'), cVal = tr.col('field_value'), cTid = tr.col('trans_id');
      for (const r of tr.rows) {
        if (cLang < 0 || cTr < 0 || id(r[cLang]) !== 'ja-Hrkt') continue;
        if (cTable >= 0 && r[cTable] && id(r[cTable]) !== 'stops') continue;
        if (cField >= 0 && r[cField] && id(r[cField]) !== 'stop_name') continue;
        const kana = id(r[cTr]);
        if (!kana) continue;
        if (cRec >= 0 && r[cRec]) kanaById.set(id(r[cRec]), kana);
        const key = cVal >= 0 && r[cVal] ? id(r[cVal]) : cTid >= 0 ? id(r[cTid]) : '';
        if (key) kanaByName.set(key, kana);
      }
    }

    const st = table('stops.txt');
    if (!st) throw new Error('stops.txt がありません');
    const stopIndex = new Map();
    {
      const cId = st.col('stop_id'), cN = st.col('stop_name'), cLa = st.col('stop_lat'), cLo = st.col('stop_lon'), cT = st.col('location_type');
      for (const r of st.rows) {
        if (cT >= 0 && id(r[cT]) && id(r[cT]) !== '0') continue;
        const lat = +r[cLa], lon = +r[cLo];
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) { warn('座標のないバス停を除外'); continue; }
        const sid = id(r[cId]), name = id(r[cN]);
        stopIndex.set(sid, net.stops.length);
        net.stops.push({ id: sid, name, kana: kanaById.get(sid) || kanaByName.get(name) || '', lat, lon, feed: fi });
      }
    }

    const routes = new Map();
    const rt = table('routes.txt');
    if (rt) {
      const cId = rt.col('route_id'), cS = rt.col('route_short_name'), cL = rt.col('route_long_name');
      for (const r of rt.rows) routes.set(id(r[cId]), id(r[cS]) || id(r[cL]));
    }

    const svcKey = (sid) => {
      const k = fi + ':' + sid;
      if (!net.serviceIndex.has(k)) {
        net.serviceIndex.set(k, net.services.length);
        net.services.push({ days: null, start: '0', end: '99999999', add: new Set(), rem: new Set() });
      }
      return net.serviceIndex.get(k);
    };
    const cal = table('calendar.txt');
    if (cal) {
      const c = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((d) => cal.col(d));
      const cId = cal.col('service_id'), cS = cal.col('start_date'), cE = cal.col('end_date');
      for (const r of cal.rows) {
        const s = net.services[svcKey(id(r[cId]))];
        s.days = c.map((i) => id(r[i]) === '1');
        s.start = id(r[cS]) || '0';
        s.end = id(r[cE]) || '99999999';
      }
    }
    const cd = table('calendar_dates.txt');
    if (cd) {
      const cId = cd.col('service_id'), cD = cd.col('date'), cT = cd.col('exception_type');
      for (const r of cd.rows) {
        const s = net.services[svcKey(id(r[cId]))];
        (id(r[cT]) === '1' ? s.add : s.rem).add(id(r[cD]));
      }
    }
    if (!cal && !cd) warn('calendar.txt と calendar_dates.txt がない');

    const tripMeta = new Map();
    const trp = table('trips.txt');
    if (!trp) throw new Error('trips.txt がありません');
    {
      const cId = trp.col('trip_id'), cR = trp.col('route_id'), cS = trp.col('service_id'), cH = trp.col('trip_headsign');
      for (const r of trp.rows) {
        const sid = id(r[cS]);
        if (!net.serviceIndex.has(fi + ':' + sid)) warn('運行日の定義がない便がある');
        tripMeta.set(id(r[cId]), { route: routes.get(id(r[cR])) || '', svc: svcKey(sid), headsign: cH >= 0 ? id(r[cH]) : '' });
      }
    }

    const freqs = new Map();
    const fq = table('frequencies.txt');
    if (fq) {
      const cId = fq.col('trip_id'), cS = fq.col('start_time'), cE = fq.col('end_time'), cH = fq.col('headway_secs');
      for (const r of fq.rows) {
        const s = t2s(r[cS]), e = t2s(r[cE]), h = +r[cH];
        if (!Number.isFinite(s) || !Number.isFinite(e) || !(h > 0)) continue;
        const k = id(r[cId]);
        if (!freqs.has(k)) freqs.set(k, []);
        freqs.get(k).push([s, e, h]);
      }
      if (freqs.size) warn('frequencies.txt の便を展開');
    }

    const stt = table('stop_times.txt');
    if (!stt) throw new Error('stop_times.txt がありません');
    const cT = stt.col('trip_id'), cA = stt.col('arrival_time'), cD = stt.col('departure_time'), cS = stt.col('stop_id'), cQ = stt.col('stop_sequence'), cH = stt.col('stop_headsign');
    const byTrip = new Map();
    let unknownStop = 0;
    for (const r of stt.rows) {
      const si = stopIndex.get(id(r[cS]));
      if (si === undefined) { unknownStop++; continue; }
      let a = t2s(r[cA]), d = t2s(r[cD]);
      if (Number.isNaN(a)) a = d;
      if (Number.isNaN(d)) d = a;
      const k = id(r[cT]);
      let arr = byTrip.get(k);
      if (!arr) byTrip.set(k, (arr = []));
      arr.push([+r[cQ], si, a, d, cH >= 0 ? id(r[cH]) : '']);
    }
    if (unknownStop) warn('stops.txt にないバス停を参照する行を除外');

    let interpolated = 0, tripCount = 0;
    for (const [tripId, rows] of byTrip) {
      const m = tripMeta.get(tripId);
      if (!m) continue;
      rows.sort((x, y) => x[0] - y[0]);
      // 時刻が空欄の停留所は、前後の時刻のわかる停留所から並び順で按分する（GTFS では時刻を省略できる）
      const known = [];
      rows.forEach((x, i) => { if (Number.isFinite(x[2])) known.push(i); });
      if (known.length < 2) continue;
      for (let j = 0; j + 1 < known.length; j++) {
        const i0 = known[j], i1 = known[j + 1];
        for (let i = i0 + 1; i < i1; i++) {
          const t = Math.round(rows[i0][3] + (rows[i1][2] - rows[i0][3]) * (i - i0) / (i1 - i0));
          rows[i][2] = rows[i][3] = t;
          interpolated++;
        }
      }
      const body = rows.slice(known[0], known[known.length - 1] + 1);
      if (body.length < 2) continue;
      const headsign = m.headsign || body[0][4] || net.stops[body[body.length - 1][1]].name;
      const seq = Int32Array.from(body, (x) => x[0]);
      const stops = Int32Array.from(body, (x) => x[1]);
      const base = { feed: fi, routeName: m.route, headsign, svc: m.svc, seq, stops };
      const arr = Int32Array.from(body, (x) => x[2]);
      const dep = Int32Array.from(body, (x) => x[3]);
      const fr = freqs.get(tripId);
      if (fr) {
        for (const [s, e, h] of fr) {
          for (let t = s; t < e; t += h) {
            const off = t - dep[0];
            net.trips.push(Object.assign({ tripId: `${tripId}@${s2t(t)}`, arr: arr.map((v) => v + off), dep: dep.map((v) => v + off) }, base));
            tripCount++;
          }
        }
      } else {
        net.trips.push(Object.assign({ tripId, arr, dep }, base));
        tripCount++;
      }
    }
    if (interpolated) warn('時刻が空欄の停留所を前後から補った');
    feed.stats = { stops: stopIndex.size, trips: tripCount, interpolated };
    return feed;
  }

  // 全フィードを読み込んだあとに一度呼ぶ。停留所ごとの便の索引と、近くの停留所の一覧を作る
  function finalize(net) {
    const N = net.stops.length;
    const start = new Int32Array(N + 1);
    for (const t of net.trips) for (let k = 0; k < t.stops.length; k++) start[t.stops[k] + 1]++;
    for (let i = 0; i < N; i++) start[i + 1] += start[i];
    const cur = start.slice(0, N);
    const tsTrip = new Int32Array(start[N]), tsPos = new Int32Array(start[N]);
    net.trips.forEach((t, ti) => {
      for (let k = 0; k < t.stops.length; k++) { const e = cur[t.stops[k]]++; tsTrip[e] = ti; tsPos[e] = k; }
    });
    net.tsStart = start; net.tsTrip = tsTrip; net.tsPos = tsPos;
    net.grid = new Map();
    net.stops.forEach((s, i) => {
      const k = Math.floor(s.lat / GRID_DEG) + ',' + Math.floor(s.lon / GRID_DEG);
      if (!net.grid.has(k)) net.grid.set(k, []);
      net.grid.get(k).push(i);
    });
    net.neighbors = net.stops.map((s, i) => stopsWithin(net, s.lat, s.lon, NEAR_M).filter((x) => x.s !== i).map((x) => [x.s, x.walk]));
    net.returnNeighbors = net.stops.map((s, i) => stopsWithin(net, s.lat, s.lon, RETURN_M).filter((x) => x.s !== i).map((x) => [x.s, x.walk]));
    net._ws = null;
    return net;
  }

  function stopsWithin(net, lat, lon, radius) {
    const out = [];
    const gy = Math.floor(lat / GRID_DEG), gx = Math.floor(lon / GRID_DEG);
    const ry = Math.ceil(radius / (GRID_DEG * 111320));
    const rx = Math.ceil(radius / (GRID_DEG * 111320 * Math.max(0.1, Math.cos(lat * Math.PI / 180))));
    for (let dy = -ry; dy <= ry; dy++) for (let dx = -rx; dx <= rx; dx++) {
      const cell = net.grid.get((gy + dy) + ',' + (gx + dx));
      if (!cell) continue;
      for (const j of cell) {
        const d = dist(lat, lon, net.stops[j].lat, net.stops[j].lon);
        if (d <= radius) out.push({ s: j, walk: walkSec(d), d });
      }
    }
    return out;
  }

  function nearStops(net, lat, lon, walkM) {
    return stopsWithin(net, lat, lon, walkM).map(({ s, walk }) => ({ s, walk }));
  }

  // ---------- 計算 ----------
  function weekdayOf(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // 0=月曜
  }

  // dateStr の翌日から days 日先までで、便が1本以上走る最初の日（無ければ null）
  function nextServiceDate(net, dateStr, days) {
    const [y, m, d] = dateStr.split('-').map(Number);
    for (let i = 1; i <= days; i++) {
      const t = new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10);
      if (activeMask(net, t).some((v) => v)) return t;
    }
    return null;
  }

  function activeMask(net, dateStr) {
    const wd = weekdayOf(dateStr);
    const ymd = dateStr.replaceAll('-', '');
    const on = net.services.map((s) => {
      let v = !!(s.days && s.days[wd] && ymd >= s.start && ymd <= s.end);
      if (s.add.has(ymd)) v = true;
      if (s.rem.has(ymd)) v = false;
      return v;
    });
    return Uint8Array.from(net.trips, (t) => (on[t.svc] ? 1 : 0));
  }

  function workspace(net) {
    const n = net.stops.length;
    if (!net._ws || net._ws.n !== n) {
      net._ws = { n, best: new Float64Array(n).fill(Infinity), latest: new Float64Array(n).fill(-Infinity), label: [] };
    }
    return net._ws;
  }

  // homeStops: [{s, walk}]。P: {depart, budget, stay, curfew, transfers}（秒）。act: 運行している便のマスク
  // opts.countOnly のときは件数だけを返し、作業用の配列を使い回す（まちモードで全停留所を回すため）
  function compute(net, homeStops, P, act, opts) {
    const countOnly = !!(opts && opts.countOnly);
    const N = net.stops.length;
    const W = countOnly ? workspace(net) : { best: new Float64Array(N).fill(Infinity), latest: new Float64Array(N).fill(-Infinity), label: new Array(N) };
    const { best, latest, label } = W;
    const { tsStart, tsTrip, tsPos, trips } = net;
    const reached = [], latestSet = [];
    const deadline = P.depart + P.budget;
    let marked = new Map();
    for (const h of homeStops) {
      const t = P.depart + h.walk;
      if (t < best[h.s]) {
        if (best[h.s] === Infinity) reached.push(h.s);
        best[h.s] = t;
        if (!countOnly) label[h.s] = { type: 'walk', walk: h.walk };
        marked.set(h.s, t);
      }
    }
    for (let round = 0; round <= P.transfers; round++) {
      const next = new Map();
      for (const [s, tReady] of marked) {
        const ready = round === 0 ? tReady : tReady + TRANSFER_BUFFER;
        for (let e = tsStart[s]; e < tsStart[s + 1]; e++) {
          const ti = tsTrip[e];
          if (!act[ti]) continue;
          const tr = trips[ti], pos = tsPos[e], dep = tr.dep[pos];
          if (dep < ready || dep > deadline) continue;
          for (let k = pos + 1; k < tr.stops.length; k++) {
            const a = tr.arr[k];
            if (a > deadline) break;
            const s2 = tr.stops[k];
            if (a < best[s2]) {
              if (best[s2] === Infinity) reached.push(s2);
              best[s2] = a;
              if (!countOnly) label[s2] = { type: 'ride', trip: ti, fromPos: pos, toPos: k, prev: label[s] };
              next.set(s2, a);
            }
          }
        }
      }
      if (round < P.transfers) {
        for (const [s, t] of [...next]) {
          for (const [s2, w] of net.neighbors[s]) {
            const a = t + w;
            if (a < best[s2]) {
              if (best[s2] === Infinity) reached.push(s2);
              best[s2] = a;
              if (!countOnly) label[s2] = { type: 'xfer', walk: w, from: s, prev: label[s] };
              next.set(s2, a);
            }
          }
        }
      }
      marked = next;
    }

    // 帰り：門限までに家に着ける「最終の帰り便」を、各バス停ごとに逆算（乗りかえなし）
    for (const h of homeStops) {
      for (let e = tsStart[h.s]; e < tsStart[h.s + 1]; e++) {
        const ti = tsTrip[e];
        if (!act[ti]) continue;
        const tr = trips[ti], pos = tsPos[e];
        if (tr.arr[pos] + h.walk > P.curfew) continue;
        for (let k = 0; k < pos; k++) {
          const s = tr.stops[k];
          if (tr.dep[k] > latest[s]) {
            if (latest[s] === -Infinity) latestSet.push(s);
            latest[s] = tr.dep[k];
          }
        }
      }
    }
    const homeSet = new Set(homeStops.map((h) => h.s));
    const status = countOnly ? null : new Int8Array(N); // 0=届かない 1=行けるが帰れない 2=行けて帰れる 3=家の近く
    let ok = 0, oneway = 0;
    for (const s of reached) {
      if (homeSet.has(s)) { if (status) status[s] = 3; continue; }
      const need = best[s] + P.stay;
      let back = latest[s] >= need;
      if (!back) for (const [s2, w] of net.returnNeighbors[s]) if (latest[s2] - w >= need) { back = true; break; }
      if (status) status[s] = back ? 2 : 1;
      if (back) ok++; else oneway++;
    }
    if (countOnly) {
      for (const s of reached) best[s] = Infinity;
      for (const s of latestSet) latest[s] = -Infinity;
      return { ok, oneway };
    }
    return { best, label, status, ok, oneway, homeStops, homeSet, P, act };
  }

  // 帰りの便の候補（カード用）。出発の早い順
  function returnOptions(net, R, s) {
    const P = R.P, need = R.best[s] + P.stay, out = [];
    const { tsStart, tsTrip, tsPos, trips } = net;
    const homeWalk = new Map(R.homeStops.map((h) => [h.s, h.walk]));
    for (const [s2, w] of [[s, 0], ...net.returnNeighbors[s]]) {
      for (let e = tsStart[s2]; e < tsStart[s2 + 1]; e++) {
        const ti = tsTrip[e];
        if (!R.act[ti]) continue;
        const tr = trips[ti], pos = tsPos[e];
        if (tr.dep[pos] - w < need) continue;
        for (let k = pos + 1; k < tr.stops.length; k++) {
          const hw = homeWalk.get(tr.stops[k]);
          if (hw === undefined) continue;
          const home = tr.arr[k] + hw;
          if (home <= P.curfew) { out.push({ ti, from: pos, to: k, walkTo: w, walkHome: hw, home }); break; }
        }
      }
    }
    out.sort((a, b) => trips[a.ti].dep[a.from] - trips[b.ti].dep[b.from] || a.walkTo - b.walkTo);
    const seen = new Set();
    return out.filter((o) => { const k = trips[o.ti].dep[o.from]; if (seen.has(k)) return false; seen.add(k); return true; });
  }

  function legsOf(label) {
    const legs = [];
    let l = label;
    while (l && l.type !== 'walk') { legs.unshift(l); l = l.prev; }
    return { walk: l ? l.walk : 0, legs };
  }

  // まちモード：停留所 i の位置に家があるとして、行けて帰れる行き先の数
  function townScore(net, i, P, act) {
    const s = net.stops[i];
    return compute(net, nearStops(net, s.lat, s.lon, P.walk), { ...P, transfers: 0 }, act, { countOnly: true }).ok;
  }

  // 公園を後ろに回す：近所の小さな公園が上位を埋めると「バスで行く意味」が見えなくなるため
  const POI_RANK = ['図書館', '水族館', '博物館・美術館', 'プール', '本屋', '映画館', '公民館・児童館', '体育館・スポーツ施設', '公園'];
  function poiReach(net, R, pois, home) {
    const out = [];
    for (const p of pois) {
      if (home && dist(p.lat, p.lon, home.lat, home.lon) < 800) continue;
      let bestS = -1, bestW = Infinity, bestArr = Infinity;
      for (const { s, d } of stopsWithin(net, p.lat, p.lon, 400)) {
        if (R.status[s] !== 2) continue;
        const w = Math.round(d / KID_WALK_M_PER_MIN);
        const t = R.best[s] + w * 60;
        if (t < bestArr || (t === bestArr && w < bestW)) { bestArr = t; bestS = s; bestW = w; }
      }
      if (bestS >= 0) out.push(Object.assign({}, p, { stop: bestS, walk: bestW, arrive: bestArr }));
    }
    out.sort((a, b) => POI_RANK.indexOf(a.kind) - POI_RANK.indexOf(b.kind) || a.arrive - b.arrive);
    return out;
  }

  return {
    KID_WALK_M_PER_MIN, NEAR_M, RETURN_M, TRANSFER_BUFFER, GTFS_FILES, POI_RANK,
    t2s, s2t, hm2s, dist, walkSec, gtfsName, decodeText, parseCSV,
    createNetwork, addFeed, finalize, stopsWithin, nearStops, weekdayOf, activeMask, nextServiceDate,
    compute, returnOptions, legsOf, townScore, poiReach,
  };
}));
