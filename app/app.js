'use strict';
// ひとりで、バスに乗れた。— 子どもが「行けて、門限までに帰れる」範囲を GTFS から計算する
// すべての計算はブラウザ内で行い、家の位置は外部に送らない。

const API = 'https://api.gtfs-data.jp/v2';
const PREFS = ['北海道','青森県','岩手県','宮城県','秋田県','山形県','福島県','茨城県','栃木県','群馬県','埼玉県','千葉県','東京都','神奈川県','新潟県','富山県','石川県','福井県','山梨県','長野県','岐阜県','静岡県','愛知県','三重県','滋賀県','京都府','大阪府','兵庫県','奈良県','和歌山県','鳥取県','島根県','岡山県','広島県','山口県','徳島県','香川県','愛媛県','高知県','福岡県','佐賀県','長崎県','熊本県','大分県','宮崎県','鹿児島県','沖縄県'];
const PRESET_HACHINOHE = [
  ['hachinohe', 'hachinohe-citybus'],
  ['hachinohecity', 'hachinohe-nango'],
  ['hashikamitown', 'hashikamibus'],
  ['towadakankodentetsu', 'toutetsu'],
];
const KID_WALK_M_PER_MIN = 60;   // 子どもの歩く速さ（分速60m）
const NEAR_M = 150;              // 乗りかえで歩ける距離
// 帰りは乗りかえより広く探す：八戸中心街ターミナルでは降りた八日町のりばと帰りの六日町のりばが214m離れている
const RETURN_M = 300;
const TRANSFER_BUFFER = 180;     // 乗りかえの余裕（秒）

const S = {
  feeds: [],        // {org, feed, name, license, licenseUrl, start, end}
  stops: [],        // {id, name, lat, lon, feed}
  trips: [],        // {feed, routeName, headsign, service, tripId, stops, arr, dep, seq}
  tripsByStop: [],  // stop -> [[tripIdx, pos], ...]
  neighbors: [],    // stop -> [[stop, walkSec], ...]
  services: {},     // key -> {days, start, end, add:Set, rem:Set}
  home: null,
  result: null,
  feedCatalog: [],
};

// ---------- 小道具 ----------
const $ = (id) => document.getElementById(id);
function busy(msg) { $('busy-msg').textContent = msg; $('busy').hidden = false; }
function idle() { $('busy').hidden = true; }
const tick = () => new Promise((r) => setTimeout(r, 0));
function t2s(s) {
  if (!s) return NaN;
  const p = s.trim().split(':');
  if (p.length < 2) return NaN;
  return (+p[0]) * 3600 + (+p[1]) * 60 + (+(p[2] || 0));
}
function s2t(sec) {
  const m = Math.round(sec / 60);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}
function hm2s(v) { const [h, m] = v.split(':').map(Number); return h * 3600 + m * 60; }
function dist(aLat, aLon, bLat, bLon) {
  const x = (bLon - aLon) * Math.cos(((aLat + bLat) / 2) * Math.PI / 180);
  const y = bLat - aLat;
  return Math.sqrt(x * x + y * y) * 111320;
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

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
  const header = rows.shift().map((h) => h.trim());
  const col = (name) => header.indexOf(name);
  return { header, rows, col };
}

// ---------- GTFS 読み込み ----------
async function fetchCatalog() {
  if (S.feedCatalog.length) return S.feedCatalog;
  const j = await (await fetch(`${API}/feeds`)).json();
  S.feedCatalog = j.body.filter((f) => !f.feed_is_discontinued);
  return S.feedCatalog;
}

async function loadFeed(org, feedId) {
  const cat = await fetchCatalog();
  const meta = cat.find((f) => f.organization_id === org && f.feed_id === feedId) || {};
  const url = `${API}/organizations/${org}/feeds/${feedId}/files/feed.zip?rid=current`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${meta.feed_name || feedId} の取得に失敗（${res.status}）`);
  const zip = await JSZip.loadAsync(await res.arrayBuffer());
  const read = async (name) => {
    const f = zip.file(name) || zip.file(new RegExp('(^|/)' + name.replace('.', '\\.') + '$'))[0];
    return f ? parseCSV(await f.async('string')) : null;
  };
  const fi = S.feeds.length;
  S.feeds.push({
    org, feed: feedId, name: meta.feed_name || feedId, orgName: meta.organization_name || org,
    license: meta.feed_license || '', licenseUrl: meta.feed_license_url || '',
    start: meta.latest_feed_start_date || '', end: meta.latest_feed_end_date || '',
  });
  const P = fi + ':';

  // stops
  const st = await read('stops.txt');
  const stopIndex = new Map();
  {
    const cId = st.col('stop_id'), cN = st.col('stop_name'), cLa = st.col('stop_lat'), cLo = st.col('stop_lon'), cT = st.col('location_type');
    for (const r of st.rows) {
      if (cT >= 0 && r[cT] && r[cT] !== '0') continue;
      const lat = +r[cLa], lon = +r[cLo];
      if (!lat || !lon) continue;
      stopIndex.set(r[cId], S.stops.length);
      S.stops.push({ id: r[cId], name: r[cN], lat, lon, feed: fi });
      S.tripsByStop.push([]);
    }
  }
  // routes
  const routes = new Map();
  {
    const rt = await read('routes.txt');
    const cId = rt.col('route_id'), cS = rt.col('route_short_name'), cL = rt.col('route_long_name');
    for (const r of rt.rows) routes.set(r[cId], (r[cS] || '').trim() || (r[cL] || '').trim());
  }
  // calendar
  const cal = await read('calendar.txt');
  if (cal) {
    const c = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((d) => cal.col(d));
    const cId = cal.col('service_id'), cS = cal.col('start_date'), cE = cal.col('end_date');
    for (const r of cal.rows) {
      S.services[P + r[cId]] = { days: c.map((i) => r[i] === '1'), start: r[cS], end: r[cE], add: new Set(), rem: new Set() };
    }
  }
  const cd = await read('calendar_dates.txt');
  if (cd) {
    const cId = cd.col('service_id'), cD = cd.col('date'), cT = cd.col('exception_type');
    for (const r of cd.rows) {
      const k = P + r[cId];
      S.services[k] ||= { days: null, start: '0', end: '99999999', add: new Set(), rem: new Set() };
      (r[cT] === '1' ? S.services[k].add : S.services[k].rem).add(r[cD]);
    }
  }
  // trips
  const tripMeta = new Map();
  {
    const tr = await read('trips.txt');
    const cId = tr.col('trip_id'), cR = tr.col('route_id'), cS = tr.col('service_id'), cH = tr.col('trip_headsign');
    for (const r of tr.rows) tripMeta.set(r[cId], { route: routes.get(r[cR]) || '', service: P + r[cS], headsign: cH >= 0 ? r[cH] : '' });
  }
  // stop_times
  await tick();
  const stt = await read('stop_times.txt');
  const cT = stt.col('trip_id'), cA = stt.col('arrival_time'), cD = stt.col('departure_time'), cS = stt.col('stop_id'), cQ = stt.col('stop_sequence'), cH = stt.col('stop_headsign');
  const byTrip = new Map();
  for (const r of stt.rows) {
    const si = stopIndex.get(r[cS]);
    if (si === undefined) continue;
    let a = t2s(r[cA]), d = t2s(r[cD]);
    if (isNaN(a)) a = d; if (isNaN(d)) d = a;
    if (isNaN(a)) continue;
    let arr = byTrip.get(r[cT]);
    if (!arr) byTrip.set(r[cT], (arr = []));
    arr.push([+r[cQ], si, a, d, cH >= 0 ? r[cH] : '']);
  }
  for (const [tripId, arr] of byTrip) {
    const m = tripMeta.get(tripId);
    if (!m || arr.length < 2) continue;
    arr.sort((x, y) => x[0] - y[0]);
    const ti = S.trips.length;
    const headsign = m.headsign || arr[0][4] || S.stops[arr[arr.length - 1][1]].name;
    S.trips.push({
      feed: fi, tripId, routeName: m.route, headsign, service: m.service,
      seq: arr.map((x) => x[0]),
      stops: Int32Array.from(arr, (x) => x[1]),
      arr: Int32Array.from(arr, (x) => x[2]),
      dep: Int32Array.from(arr, (x) => x[3]),
    });
    arr.forEach((x, pos) => S.tripsByStop[x[1]].push([ti, pos]));
  }
}

function buildNeighbors() {
  S.neighbors = neighborsWithin(NEAR_M);
  S.returnNeighbors = neighborsWithin(RETURN_M);
}
function neighborsWithin(radius) {
  const cell = 0.004, grid = new Map();
  S.stops.forEach((s, i) => {
    const k = Math.floor(s.lat / cell) + ',' + Math.floor(s.lon / cell);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });
  return S.stops.map((s, i) => {
    const out = [], gy = Math.floor(s.lat / cell), gx = Math.floor(s.lon / cell);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      for (const j of grid.get((gy + dy) + ',' + (gx + dx)) || []) {
        if (j === i) continue;
        const d = dist(s.lat, s.lon, S.stops[j].lat, S.stops[j].lon);
        if (d <= radius) out.push([j, Math.round((d / KID_WALK_M_PER_MIN) * 60)]);
      }
    }
    return out;
  });
}

// ---------- 計算 ----------
function activeMask(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const wd = (d.getDay() + 6) % 7;
  const ymd = dateStr.replaceAll('-', '');
  const on = {};
  for (const [k, s] of Object.entries(S.services)) {
    let v = !!(s.days && s.days[wd] && ymd >= s.start && ymd <= s.end);
    if (s.add.has(ymd)) v = true;
    if (s.rem.has(ymd)) v = false;
    on[k] = v;
  }
  return Uint8Array.from(S.trips, (t) => (on[t.service] ? 1 : 0));
}

function nearStops(lat, lon, walkM) {
  const out = [];
  S.stops.forEach((s, i) => {
    const d = dist(lat, lon, s.lat, s.lon);
    if (d <= walkM) out.push({ s: i, walk: Math.round((d / KID_WALK_M_PER_MIN) * 60) });
  });
  return out;
}

function params() {
  return {
    date: $('p-date').value,
    depart: hm2s($('p-depart').value),
    budget: +$('p-budget').value * 60,
    walk: +$('p-walk').value,
    stay: +$('p-stay').value * 60,
    curfew: hm2s($('p-curfew').value),
    transfers: $('p-transfer').checked ? 1 : 0,
  };
}

// homeStops: [{s, walk}]。act: 運行している便のマスク
function compute(homeStops, P, act) {
  const N = S.stops.length;
  const best = new Float64Array(N).fill(Infinity);
  const label = new Array(N);
  const deadline = P.depart + P.budget;
  let marked = new Map();
  for (const h of homeStops) {
    const t = P.depart + h.walk;
    if (t < best[h.s]) { best[h.s] = t; label[h.s] = { type: 'walk', walk: h.walk }; marked.set(h.s, t); }
  }
  for (let round = 0; round <= P.transfers; round++) {
    const next = new Map();
    for (const [s, tReady] of marked) {
      const ready = round === 0 ? tReady : tReady + TRANSFER_BUFFER;
      for (const [ti, pos] of S.tripsByStop[s]) {
        if (!act[ti]) continue;
        const tr = S.trips[ti];
        const dep = tr.dep[pos];
        if (dep < ready || dep > deadline) continue;
        for (let k = pos + 1; k < tr.stops.length; k++) {
          const a = tr.arr[k];
          if (a > deadline) break;
          const s2 = tr.stops[k];
          if (a < best[s2]) {
            best[s2] = a;
            label[s2] = { type: 'ride', trip: ti, fromPos: pos, toPos: k, prev: label[s] };
            next.set(s2, a);
          }
        }
      }
    }
    if (round < P.transfers) {
      for (const [s, t] of [...next]) {
        for (const [s2, w] of S.neighbors[s]) {
          const a = t + w;
          if (a < best[s2]) { best[s2] = a; label[s2] = { type: 'xfer', walk: w, from: s, prev: label[s] }; next.set(s2, a); }
        }
      }
    }
    marked = next;
  }

  // 帰り：門限までに家に着ける「最終の帰り便」を、各バス停ごとに逆算（乗りかえなし）
  const latest = new Float64Array(N).fill(-Infinity);
  for (const h of homeStops) {
    for (const [ti, pos] of S.tripsByStop[h.s]) {
      if (!act[ti]) continue;
      const tr = S.trips[ti];
      if (tr.arr[pos] + h.walk > P.curfew) continue;
      for (let k = 0; k < pos; k++) {
        const s = tr.stops[k];
        if (tr.dep[k] > latest[s]) latest[s] = tr.dep[k];
      }
    }
  }
  const homeSet = new Set(homeStops.map((h) => h.s));
  const status = new Int8Array(N); // 0=届かない 1=行けるが帰れない 2=行けて帰れる 3=家の近く
  let ok = 0, oneway = 0;
  for (let s = 0; s < N; s++) {
    if (best[s] === Infinity) continue;
    if (homeSet.has(s)) { status[s] = 3; continue; }
    const need = best[s] + P.stay;
    let back = latest[s] >= need;
    if (!back) for (const [s2, w] of S.returnNeighbors[s]) if (latest[s2] - w >= need) { back = true; break; }
    status[s] = back ? 2 : 1;
    back ? ok++ : oneway++;
  }
  return { best, label, status, ok, oneway, homeStops, homeSet, P, act };
}

// 帰りの便の候補（カード用）
function returnOptions(R, s) {
  const P = R.P, need = R.best[s] + P.stay, out = [];
  const homeWalk = new Map(R.homeStops.map((h) => [h.s, h.walk]));
  const cands = [[s, 0], ...S.returnNeighbors[s]];
  for (const [s2, w] of cands) {
    for (const [ti, pos] of S.tripsByStop[s2]) {
      if (!R.act[ti]) continue;
      const tr = S.trips[ti];
      if (tr.dep[pos] - w < need) continue;
      for (let k = pos + 1; k < tr.stops.length; k++) {
        const hw = homeWalk.get(tr.stops[k]);
        if (hw === undefined) continue;
        const home = tr.arr[k] + hw;
        if (home <= P.curfew) { out.push({ ti, from: pos, to: k, walkTo: w, walkHome: hw, home }); break; }
      }
    }
  }
  out.sort((a, b) => S.trips[a.ti].dep[a.from] - S.trips[b.ti].dep[b.from]);
  const seen = new Set();
  return out.filter((o) => { const k = S.trips[o.ti].dep[o.from]; if (seen.has(k)) return false; seen.add(k); return true; });
}

function legsOf(label) {
  const legs = [];
  let l = label;
  while (l && l.type !== 'walk') { legs.unshift(l); l = l.prev; }
  return { walk: l ? l.walk : 0, legs };
}

// ---------- 地図 ----------
let map, stopLayer, homeMarker, poiLayer, homeCircle;
function initMap() {
  map = L.map('map', { preferCanvas: true }).setView([40.512, 141.488], 12);
  L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', {
    maxZoom: 18, attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html">地理院タイル</a>',
  }).addTo(map);
  stopLayer = L.layerGroup().addTo(map);
  poiLayer = L.layerGroup().addTo(map);
  map.on('click', (e) => {
    if (currentMode !== 'kid') return;
    setHome(e.latlng.lat, e.latlng.lng);
  });
}
const COLORS = { 0: '#a3a8af', 1: '#e8890c', 2: '#1f9d55', 3: '#2563eb' };

function drawStopsPlain() {
  stopLayer.clearLayers();
  S.stops.forEach((s) => {
    L.circleMarker([s.lat, s.lon], { radius: 3, color: '#a3a8af', weight: 1, fillOpacity: 0.6 })
      .bindTooltip(s.name).addTo(stopLayer);
  });
}

function drawResult(R) {
  stopLayer.clearLayers();
  S.stops.forEach((s, i) => {
    const st = R.status[i];
    const m = L.circleMarker([s.lat, s.lon], {
      radius: st === 2 ? 6 : st === 0 ? 2.5 : 5,
      color: COLORS[st], weight: 1, fillColor: COLORS[st], fillOpacity: st === 0 ? 0.35 : 0.85,
    }).bindTooltip(s.name + (st === 2 ? '（行けて帰れる）' : st === 1 ? '（帰りのバスがない）' : ''));
    if (st === 1 || st === 2) m.on('click', (e) => { L.DomEvent.stopPropagation(e); openCard(i); });
    m.addTo(stopLayer);
  });
}

function setHome(lat, lon) {
  S.home = { lat, lon };
  if (homeMarker) homeMarker.remove();
  if (homeCircle) homeCircle.remove();
  homeMarker = L.marker([lat, lon], { title: '家' }).addTo(map).bindTooltip('家のあたり', { permanent: true, direction: 'top', offset: [-15, -12] });
  homeCircle = L.circle([lat, lon], { radius: +$('p-walk').value, color: '#2563eb', weight: 1, fillOpacity: 0.05 }).addTo(map);
  const n = nearStops(lat, lon, +$('p-walk').value).length;
  $('home-status').textContent = n ? `家から歩けるバス停：${n}か所` : '歩ける距離にバス停がありません。距離を広げるか、別の場所をタップしてください。';
  $('run').disabled = !S.stops.length;
}

// ---------- 行き先の施設（OpenStreetMap） ----------
const POI_KIND = [
  ['amenity', 'library', '図書館'], ['amenity', 'community_centre', '公民館・児童館'],
  ['leisure', 'park', '公園'], ['leisure', 'sports_centre', '体育館・スポーツ施設'],
  ['leisure', 'swimming_pool', 'プール'], ['tourism', 'museum', '博物館・美術館'],
  ['tourism', 'aquarium', '水族館'], ['amenity', 'cinema', '映画館'], ['shop', 'books', '本屋'],
];
let POIS = null;
let POI_FILE = null;
// 八戸圏は同梱ファイルを使う：公開の Overpass サーバは混雑で 502・無応答が続くことがあり、審査中に施設が出ない事態を避けるため
async function loadPOIs() {
  if (POIS) return POIS;
  if (POI_FILE) {
    try {
      const j = await (await fetch(POI_FILE)).json();
      POIS = j.items.map(([name, k, lat, lon]) => ({ name, kind: j.kinds[k], lat, lon }));
      return POIS;
    } catch (err) { console.warn('同梱の施設データを読めません', err); }
  }
  let s = 90, w = 180, n = -90, e = -180;
  for (const p of S.stops) { s = Math.min(s, p.lat); n = Math.max(n, p.lat); w = Math.min(w, p.lon); e = Math.max(e, p.lon); }
  if ((n - s) * (e - w) > 1.5) { POIS = []; return POIS; } // 広すぎる範囲は問い合わせない
  const bb = `${s},${w},${n},${e}`;
  const q = `[out:json][timeout:25];(${POI_KIND.map(([k, v]) => `nwr["${k}"="${v}"]["name"](${bb});`).join('')});out center tags;`;
  for (const ep of ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter']) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 25000);
      const res = await fetch(ep, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctl.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      const j = await res.json();
      POIS = j.elements.map((el) => {
        const kind = POI_KIND.find(([k, v]) => el.tags[k] === v);
        return { name: el.tags.name, kind: kind ? kind[2] : '', lat: el.lat ?? el.center?.lat, lon: el.lon ?? el.center?.lon };
      }).filter((p) => p.lat && p.kind);
      return POIS;
    } catch (err) { console.warn('OSM 施設の取得に失敗', ep, err); }
  }
  return [];
}

// 公園を後ろに回す：近所の小さな公園が上位を埋めると「バスで行く意味」が見えなくなるため
const POI_RANK = ['図書館', '水族館', '博物館・美術館', 'プール', '本屋', '映画館', '公民館・児童館', '体育館・スポーツ施設', '公園'];
function poiReach(R, pois) {
  const out = [];
  for (const p of pois) {
    if (S.home && dist(p.lat, p.lon, S.home.lat, S.home.lon) < 800) continue;
    let bestS = -1, bestW = Infinity, bestArr = Infinity;
    for (const [i, s] of S.stops.entries()) {
      if (R.status[i] !== 2) continue;
      const d = dist(p.lat, p.lon, s.lat, s.lon);
      if (d > 400) continue;
      const w = Math.round(d / KID_WALK_M_PER_MIN);
      if (R.best[i] + w * 60 < bestArr) { bestArr = R.best[i] + w * 60; bestS = i; bestW = w; }
    }
    if (bestS >= 0) out.push({ ...p, stop: bestS, walk: bestW, arrive: bestArr });
  }
  out.sort((a, b) => POI_RANK.indexOf(a.kind) - POI_RANK.indexOf(b.kind) || a.arrive - b.arrive);
  return out;
}

// ---------- 実行 ----------
async function run() {
  if (!S.home) return;
  const P = params();
  busy('しらべています…');
  await tick();
  const act = activeMask(P.date);
  const homeStops = nearStops(S.home.lat, S.home.lon, P.walk);
  const R = compute(homeStops, P, act);
  S.result = R;
  drawResult(R);
  const shown = [[S.home.lat, S.home.lon], ...S.stops.filter((_, i) => R.status[i] >= 1).map((s) => [s.lat, s.lon])];
  map.fitBounds(L.latLngBounds(shown), { padding: [30, 30], maxZoom: 15 });
  $('step-result').hidden = false;
  const activeTrips = act.reduce((a, b) => a + b, 0);
  $('score').innerHTML = activeTrips === 0
    ? `<p>この日はバスが走っていないか、データの有効期間外です。日にちを変えてください。</p>`
    : `<div class="big">${R.ok}<small> か所のバス停へ、ひとりで行けて帰れる</small></div>
       <p>行けるけど帰りのバスがないバス停：${R.oneway}か所</p>
       <p>${P.date}　${s2t(P.depart)}に出発・${P.budget / 60}分以内・門限${s2t(P.curfew)}・${P.transfers ? '乗りかえ1回まで' : '乗りかえなし'}</p>`;
  idle();
  const list = $('poi-list');
  list.innerHTML = '<li class="hint">行き先の施設を探しています…</li>';
  const pois = await loadPOIs();
  const reach = poiReach(R, pois);
  poiLayer.clearLayers();
  reach.forEach((p) => {
    L.circleMarker([p.lat, p.lon], { radius: 7, color: '#7c3aed', weight: 2, fillColor: '#fff', fillOpacity: 1 })
      .bindTooltip(`${p.kind}：${p.name}`).on('click', (e) => { L.DomEvent.stopPropagation(e); openCard(p.stop, p); })
      .addTo(poiLayer);
  });
  list.innerHTML = reach.length
    ? reach.slice(0, 40).map((p, i) => `<li data-i="${i}"><b>${esc(p.kind)}　${esc(p.name)}</b><span>「${esc(S.stops[p.stop].name)}」で降りて歩いて${p.walk}分・${s2t(p.arrive)}ごろ着</span></li>`).join('')
    : `<li class="hint">${pois.length ? '近くに行ける施設が見つかりませんでした。条件をゆるめてみてください。' : '施設データを取得できませんでした。地図のバス停をタップしてカードを作れます。'}</li>`;
  list.querySelectorAll('li[data-i]').forEach((li) => li.addEventListener('click', () => {
    const p = reach[+li.dataset.i];
    map.setView([p.lat, p.lon], 15);
    openCard(p.stop, p);
  }));
}

// ---------- おでかけカード ----------
let cardCtx = null;
function openCard(s, poi) {
  const R = S.result;
  if (!R) return;
  const { walk, legs } = legsOf(R.label[s]);
  const rets = returnOptions(R, s);
  cardCtx = { s, legs, rets };
  const dest = poi ? `${poi.kind}「${poi.name}」` : `「${S.stops[s].name}」`;
  let html = `<h2>おでかけカード</h2><div class="who">なまえ：　　　　　　　　　行き先：${esc(dest)}</div>`;
  html += `<div class="leg"><h3>いき</h3><ol><li>家を出る：<span class="t">${s2t(R.P.depart)}</span>　バス停まで歩いて${Math.max(1, Math.round(walk / 60))}分</li>`;
  legs.forEach((l) => {
    if (l.type === 'xfer') { html += `<li>となりのバス停まで歩いて${Math.max(1, Math.round(l.walk / 60))}分</li>`; return; }
    const tr = S.trips[l.trip];
    html += `<li>「<b>${esc(S.stops[tr.stops[l.fromPos]].name)}</b>」から <span class="t">${s2t(tr.dep[l.fromPos])}</span> の<br>${esc(tr.routeName)}（${esc(tr.headsign)}行き）に乗る</li>`;
    html += `<li>「<b>${esc(S.stops[tr.stops[l.toPos]].name)}</b>」で降りる <span class="t">${s2t(tr.arr[l.toPos])}</span>（${l.toPos - l.fromPos}つめ）</li>`;
  });
  if (poi) html += `<li>歩いて${poi.walk}分で${esc(poi.name)}に着く</li>`;
  html += `</ol></div>`;
  if (rets.length) {
    const first = rets[0], last = rets[rets.length - 1];
    const legHtml = (o) => {
      const tr = S.trips[o.ti];
      return `「<b>${esc(S.stops[tr.stops[o.from]].name)}</b>」から <span class="t">${s2t(tr.dep[o.from])}</span> の ${esc(tr.routeName)}（${esc(tr.headsign)}行き）→「${esc(S.stops[tr.stops[o.to]].name)}」で降りる ${s2t(tr.arr[o.to])} → 家に着く ${s2t(o.home)}`;
    };
    html += `<div class="leg"><h3>かえり</h3><ol><li>${legHtml(first)}</li></ol>`;
    if (first.walkTo) {
      const back = S.stops[S.trips[first.ti].stops[first.from]].name;
      html += back === S.stops[s].name
        ? `<p class="hint">帰りは道の反対側ののりばから乗ります（歩いて${Math.max(1, Math.round(first.walkTo / 60))}分）。</p>`
        : `<div class="last">ちゅうい：帰りは<b>「${esc(back)}」</b>から乗ります。降りたバス停とはちがう場所です（歩いて${Math.max(1, Math.round(first.walkTo / 60))}分）。</div>`;
    }
    html += `</div><div class="last">さいごの帰りのバス：<span class="t">${s2t(S.trips[last.ti].dep[last.from])}</span>「${esc(S.stops[S.trips[last.ti].stops[last.from]].name)}」発（帰りの便は${rets.length}本）<br>これに乗れなかったら、すぐに電話する。</div>`;
  } else {
    html += `<div class="last">このバス停からは、門限までに家に帰るバスがありません。<br>おうちの人とむかえの相談をしよう。</div>`;
  }
  html += `<div class="tel">電話：　　　　　　　　　　　　　（おうちの人）</div>`;
  const f = S.feeds[S.stops[s].feed];
  html += `<div class="src">${esc(R.P.date)}のダイヤ／出典：${esc(f.orgName)}「${esc(f.name)}」GTFSデータ（${esc(f.license)}）・GTFSデータリポジトリ。運休・遅れ・運賃は事業者の案内で確認してください。</div>`;
  $('card').innerHTML = html;
  $('card-raw').hidden = true;
  $('card-modal').hidden = false;
}

function showRaw() {
  // 「時刻表はデータでできている」：カードの元になった stop_times の行を見せる
  if (!cardCtx) return;
  const rideLegs = cardCtx.legs.filter((l) => l.type === 'ride').map((l) => ({ ti: l.trip, from: l.fromPos, to: l.toPos }));
  if (cardCtx.rets[0]) rideLegs.push(cardCtx.rets[0]);
  let html = '<p>このカードは、バス会社が公開している <b>stop_times.txt</b>（どの便が、どのバス停を、何時に通るか）の次の行から作られています。色のついた行が、乗る所と降りる所です。</p>';
  for (const o of rideLegs) {
    const tr = S.trips[o.ti];
    html += `<table><tr><th>trip_id</th><th>stop_sequence</th><th>stop_id</th><th>（バス停名）</th><th>departure_time</th></tr>`;
    for (let k = Math.max(0, o.from - 1); k <= Math.min(tr.stops.length - 1, o.to + 1); k++) {
      const hl = k === o.from || k === o.to ? ' class="hl"' : '';
      html += `<tr${hl}><td>${esc(tr.tripId)}</td><td>${tr.seq[k]}</td><td>${esc(S.stops[tr.stops[k]].id)}</td><td>${esc(S.stops[tr.stops[k]].name)}</td><td>${s2t(tr.dep[k])}</td></tr>`;
    }
    html += '</table><br>';
  }
  $('card-raw').innerHTML = html;
  $('card-raw').hidden = false;
}

// ---------- まちモード ----------
async function runTown() {
  const P = { ...params(), transfers: 0 };
  busy('まち全体を計算しています…');
  await tick();
  const act = activeMask(P.date);
  const N = S.stops.length;
  const score = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    const s = S.stops[i];
    const homeStops = nearStops(s.lat, s.lon, P.walk);
    score[i] = compute(homeStops, P, act).ok;
    if (i % 50 === 0) { $('busy-msg').textContent = `まち全体を計算しています… ${i}/${N}`; await tick(); }
  }
  S.townScore = score;
  stopLayer.clearLayers();
  if (homeMarker) homeMarker.remove();
  if (homeCircle) homeCircle.remove();
  poiLayer.clearLayers();
  const max = Math.max(1, ...score);
  const color = (v) => v === 0 ? '#c2410c' : v < max * 0.15 ? '#f59e0b' : v < max * 0.4 ? '#84cc16' : '#15803d';
  S.stops.forEach((s, i) => {
    L.circleMarker([s.lat, s.lon], { radius: 3 + 6 * Math.sqrt(score[i] / max), color: color(score[i]), weight: 1, fillColor: color(score[i]), fillOpacity: 0.8 })
      .bindTooltip(`${s.name}：${score[i]}か所`).addTo(stopLayer);
  });
  const zero = [...score].filter((v) => v === 0).length;
  const sorted = [...score].sort((a, b) => a - b);
  const median = sorted[Math.floor(N / 2)];
  const byName = new Map();
  S.stops.forEach((s, i) => { if (!byName.has(s.name) || byName.get(s.name) < score[i]) byName.set(s.name, score[i]); });
  const ranked = [...byName.entries()].sort((a, b) => a[1] - b[1]);
  $('town-summary').innerHTML = `
    <div class="score"><div class="big">${zero}<small> / ${N} のバス停</small></div>
    <p>…は、そこを最寄りにする子どもが「ひとりで行けて帰れる行き先」がゼロ（${P.date} ${s2t(P.depart)}発・${P.budget / 60}分以内・門限${s2t(P.curfew)}・乗りかえなし）。中央値は${median}か所。</p></div>
    <ul class="legend"><li><i class="dot" style="background:#c2410c"></i>0か所</li><li><i class="dot" style="background:#f59e0b"></i>少ない</li><li><i class="dot" style="background:#84cc16"></i>中くらい</li><li><i class="dot" style="background:#15803d"></i>多い（最大${max}か所）</li></ul>
    <h3>行き先が少ないバス停（下位15）</h3>
    <table class="town-table">${ranked.slice(0, 15).map(([n, v]) => `<tr><td>${esc(n)}</td><td>${v}</td></tr>`).join('')}</table>
    <button id="town-csv">結果をCSVで保存</button>`;
  $('town-csv').addEventListener('click', () => {
    const rows = [['stop_id', 'stop_name', 'lat', 'lon', 'feed', 'reachable_and_returnable']];
    S.stops.forEach((s, i) => rows.push([s.id, s.name, s.lat, s.lon, S.feeds[s.feed].name, score[i]]));
    const csv = '﻿' + rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `hitoride-bus_town_${P.date}.csv`;
    a.click();
  });
  idle();
}

// ---------- データ選択 UI ----------
async function loadFeeds(list) {
  busy('バスのデータを読み込んでいます…');
  try {
    S.feeds = []; S.stops = []; S.trips = []; S.tripsByStop = []; S.services = {}; S.result = null; POIS = null;
    for (const [i, [org, feed]] of list.entries()) {
      $('busy-msg').textContent = `バスのデータを読み込んでいます…（${i + 1}/${list.length}）`;
      await loadFeed(org, feed);
    }
    buildNeighbors();
    drawStopsPlain();
    if (S.stops.length) map.fitBounds(L.latLngBounds(S.stops.map((s) => [s.lat, s.lon])), { padding: [20, 20] });
    $('data-status').innerHTML = `読み込み完了：${S.feeds.map((f) => esc(f.name)).join('、')}<br>バス停 ${S.stops.length}か所・便 ${S.trips.length}本`;
    $('credit-list').innerHTML = S.feeds.map((f) => `<li>${esc(f.orgName)}「${esc(f.name)}」GTFS（${f.licenseUrl ? `<a href="${esc(f.licenseUrl)}" target="_blank" rel="noopener">${esc(f.license)}</a>` : esc(f.license)}）有効期間 ${esc(f.start)}〜${esc(f.end)}</li>`).join('');
    const ends = S.feeds.map((f) => f.end).filter(Boolean).sort();
    if (ends.length) $('p-date').max = ends[0];
    $('run').disabled = !S.home;
    $('run-town').disabled = false;
    $('step-result').hidden = true;
  } catch (err) {
    console.error(err);
    $('data-status').textContent = '読み込みに失敗しました：' + err.message;
  }
  idle();
}

async function fillFeedList() {
  const pref = +$('pref').value;
  const cat = await fetchCatalog();
  const feeds = cat.filter((f) => f.feed_pref_id === pref);
  $('feed-list').innerHTML = feeds.length
    ? feeds.map((f) => `<label><input type="checkbox" value="${esc(f.organization_id)}|${esc(f.feed_id)}"> ${esc(f.feed_name)}（${esc(f.organization_name)}）</label>`).join('')
    : '<p class="hint">この都道府県のデータは登録されていません。</p>';
}

let currentMode = 'kid';
function setMode(mode) {
  currentMode = mode;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  const kid = mode === 'kid';
  ['step-home', 'step-cond'].forEach((id) => ($(id).hidden = !kid));
  $('step-result').hidden = !(kid && S.result);
  $('step-town').hidden = mode !== 'town';
  $('step-about').hidden = mode !== 'about';
  $('step-data').hidden = mode === 'about';
  if (kid && S.result) { drawResult(S.result); if (S.home) setHome(S.home.lat, S.home.lon); }
  if (mode === 'town') {
    // まちモードは独自の条件欄を持たないので、こどもモードの条件を共有する
    $('step-cond').hidden = false;
    $('run').hidden = true; $('p-transfer').parentElement.hidden = true;
  } else { $('run').hidden = false; $('p-transfer').parentElement.hidden = false; }
}

function nextSaturday() {
  const d = new Date();
  d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7));
  return d.toISOString().slice(0, 10);
}

function init() {
  initMap();
  $('p-date').value = nextSaturday();
  $('pref').innerHTML = PREFS.map((p, i) => `<option value="${i + 1}"${i === 1 ? ' selected' : ''}>${p}</option>`).join('');
  $('pref').addEventListener('change', fillFeedList);
  document.querySelector('details').addEventListener('toggle', (e) => { if (e.target.open) fillFeedList(); }, { once: true });
  $('preset-hachinohe').addEventListener('click', () => { POI_FILE = 'data/pois_hachinohe.json'; loadFeeds(PRESET_HACHINOHE); });
  $('load-selected').addEventListener('click', () => {
    const sel = [...document.querySelectorAll('#feed-list input:checked')].map((c) => c.value.split('|'));
    if (sel.length) { POI_FILE = null; loadFeeds(sel); }
  });
  $('run').addEventListener('click', run);
  $('run-town').addEventListener('click', runTown);
  $('p-walk').addEventListener('change', () => S.home && setHome(S.home.lat, S.home.lon));
  $('card-close').addEventListener('click', () => ($('card-modal').hidden = true));
  $('card-modal').addEventListener('click', (e) => { if (e.target.id === 'card-modal') $('card-modal').hidden = true; });
  $('card-print').addEventListener('click', () => window.print());
  $('card-data').addEventListener('click', showRaw);
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
}
init();
