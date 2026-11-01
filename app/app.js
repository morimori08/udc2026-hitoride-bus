'use strict';
// ひとりで、バスに乗れた。— 画面（地図・カード・まちモード）。計算は core.js（HBCore）が受け持つ。
// すべての計算はブラウザ内で行い、家の位置は外部に送らない。

const H = window.HBCore;
const API = 'https://api.gtfs-data.jp/v2';
const BUNDLE = 'data/feeds/';
const PREFS = ['北海道','青森県','岩手県','宮城県','秋田県','山形県','福島県','茨城県','栃木県','群馬県','埼玉県','千葉県','東京都','神奈川県','新潟県','富山県','石川県','福井県','山梨県','長野県','岐阜県','静岡県','愛知県','三重県','滋賀県','京都府','大阪府','兵庫県','奈良県','和歌山県','鳥取県','島根県','岡山県','広島県','山口県','徳島県','香川県','愛媛県','高知県','福岡県','佐賀県','長崎県','熊本県','大分県','宮崎県','鹿児島県','沖縄県'];
const PRESET_HACHINOHE = [
  ['hachinohe', 'hachinohe-citybus'],
  ['hachinohecity', 'hachinohe-nango'],
  ['hashikamitown', 'hashikamibus'],
  ['towadakankodentetsu', 'toutetsu'],
];

let NET = null;
const S = { home: null, result: null, feedCatalog: null, bundle: null, kanaIndex: new Map(), townScore: null };

// ---------- 小道具 ----------
const $ = (id) => document.getElementById(id);
function busy(msg) { $('busy-msg').textContent = msg; $('busy').hidden = false; }
function idle() { $('busy').hidden = true; }
const tick = () => new Promise((r) => setTimeout(r, 0));
const s2t = H.s2t;
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

async function fetchWithTimeout(url, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// 八戸市営バスの GTFS は「八戸中心街ターミナル（八日町）」の読みに括弧内ののりば名を含まない。読みは同じデータの英語の行き先表示（Yoka-Machi など）で確かめた
const PLATFORM_KANA = { 八日町: 'ようかまち', 六日町: 'むいかまち', 三日町: 'みっかまち', 朔日町: 'ついたちまち', 中央通り: 'ちゅうおうどおり' };

// バス停名にふりがなを振る。括弧内は同名の停留所の読みか、上の補いから引く
function rubyName(s) {
  const stop = NET.stops[s];
  if (!stop.kana) return esc(stop.name);
  const m = stop.name.match(/^(.+?)（(.+)）$/);
  if (!m || stop.kana.includes('（')) return `<ruby>${esc(stop.name)}<rt>${esc(stop.kana)}</rt></ruby>`;
  const inner = S.kanaIndex.get(m[2]) || PLATFORM_KANA[m[2]];
  return `<ruby>${esc(m[1])}<rt>${esc(stop.kana)}</rt></ruby>（${inner ? `<ruby>${esc(m[2])}<rt>${esc(inner)}</rt></ruby>` : esc(m[2])}）`;
}

// ---------- GTFS 読み込み ----------
async function fetchCatalog() {
  if (S.feedCatalog) return S.feedCatalog;
  const j = await (await fetchWithTimeout(`${API}/feeds`, 8000)).json();
  S.feedCatalog = j.body.filter((f) => !f.feed_is_discontinued);
  return S.feedCatalog;
}

async function loadBundleManifest() {
  if (!S.bundle) S.bundle = await (await fetchWithTimeout(BUNDLE + 'manifest.json', 10000)).json();
  return S.bundle;
}

function metaOf(c) {
  return {
    org: c.organization_id, feed: c.feed_id, name: c.feed_name, orgName: c.organization_name,
    license: c.feed_license, licenseUrl: c.feed_license_url, start: c.latest_feed_start_date, end: c.latest_feed_end_date,
  };
}

async function zipToFiles(buf) {
  const zip = await JSZip.loadAsync(buf);
  const entries = Object.values(zip.files).filter((f) => !f.dir && !f.name.startsWith('__MACOSX/'));
  // .txt を優先し、無いときだけ .csv を使う
  entries.sort((a, b) => Number(/\.csv$/i.test(a.name)) - Number(/\.csv$/i.test(b.name)));
  const files = {};
  for (const f of entries) {
    const std = H.gtfsName(f.name);
    if (std && !(std in files)) files[std] = H.decodeText(await f.async('uint8array'));
  }
  return files;
}

// API から取れなければ、同梱の保存版（八戸圏のみ）を使う。一度つながらなかったら、残りのフィードは API を待たない
async function getFeed(org, feedId, allowBundle) {
  try {
    if (allowBundle && S.apiDown) throw new Error('API に接続できません');
    const cat = await fetchCatalog();
    const c = cat.find((f) => f.organization_id === org && f.feed_id === feedId);
    const res = await fetchWithTimeout(`${API}/organizations/${org}/feeds/${feedId}/files/feed.zip?rid=current`, 45000);
    return { files: await zipToFiles(await res.arrayBuffer()), meta: Object.assign(c ? metaOf(c) : { org, feed: feedId, name: feedId }, { source: 'api' }) };
  } catch (err) {
    if (!allowBundle) throw new Error(`${feedId} の取得に失敗しました（${err.message}）`);
    S.apiDown = true;
    const man = await loadBundleManifest();
    const m = man.feeds.find((f) => f.org === org && f.feed === feedId);
    if (!m) throw err;
    const res = await fetchWithTimeout(BUNDLE + m.file, 20000);
    return { files: await zipToFiles(await res.arrayBuffer()), meta: Object.assign({}, m, { source: 'bundle' }) };
  }
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
  NET.stops.forEach((s) => {
    L.circleMarker([s.lat, s.lon], { radius: 3, color: '#a3a8af', weight: 1, fillOpacity: 0.6 })
      .bindTooltip(s.name).addTo(stopLayer);
  });
}

function drawResult(R) {
  stopLayer.clearLayers();
  NET.stops.forEach((s, i) => {
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
  const n = NET ? H.nearStops(NET, lat, lon, +$('p-walk').value).length : 0;
  $('home-status').textContent = n ? `家から歩けるバス停：${n}か所` : '歩ける距離にバス停がありません。距離を広げるか、別の場所をタップしてください。';
  $('run').disabled = !NET;
}

function params() {
  return {
    date: $('p-date').value,
    depart: H.hm2s($('p-depart').value),
    budget: +$('p-budget').value * 60,
    walk: +$('p-walk').value,
    stay: +$('p-stay').value * 60,
    curfew: H.hm2s($('p-curfew').value),
    transfers: $('p-transfer').checked ? 1 : 0,
  };
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
      const j = await (await fetchWithTimeout(POI_FILE, 10000)).json();
      POIS = j.items.map(([name, k, lat, lon]) => ({ name, kind: j.kinds[k], lat, lon }));
      return POIS;
    } catch (err) { console.warn('同梱の施設データを読めません', err); }
  }
  let s = 90, w = 180, n = -90, e = -180;
  for (const p of NET.stops) { s = Math.min(s, p.lat); n = Math.max(n, p.lat); w = Math.min(w, p.lon); e = Math.max(e, p.lon); }
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

// ---------- 実行 ----------
async function run() {
  if (!S.home || !NET) return;
  const P = params();
  busy('しらべています…');
  await tick();
  const act = H.activeMask(NET, P.date);
  const R = H.compute(NET, H.nearStops(NET, S.home.lat, S.home.lon, P.walk), P, act);
  S.result = R;
  drawResult(R);
  const shown = [[S.home.lat, S.home.lon], ...NET.stops.filter((_, i) => R.status[i] >= 1).map((s) => [s.lat, s.lon])];
  map.fitBounds(L.latLngBounds(shown), { padding: [30, 30], maxZoom: 15, animate: false });
  $('step-result').hidden = false;
  const activeTrips = act.reduce((a, b) => a + b, 0);
  const next = activeTrips === 0 ? H.nextServiceDate(NET, P.date, 120) : null;
  $('score').innerHTML = activeTrips === 0
    ? (next
      ? `<p>${esc(P.date)}はバスが走っていません。次に走るのは <b>${esc(next)}</b>（${'月火水木金土日'[H.weekdayOf(next)]}）です。日にちを変えてしらべてください。</p>`
      : `<p>このデータには、${esc(P.date)}から120日先までに走る日が入っていません。データの有効期限が切れている可能性があります。</p>`)
    : `<div class="big">${R.ok}<small> か所のバス停へ、ひとりで行けて帰れる</small></div>
       <p>行けるけど帰りのバスがないバス停：${R.oneway}か所</p>
       <p>${P.date}　${s2t(P.depart)}に出発・${P.budget / 60}分以内・門限${s2t(P.curfew)}・${P.transfers ? '乗りかえ1回まで' : '乗りかえなし'}</p>`;
  idle();
  const list = $('poi-list');
  list.innerHTML = '<li class="hint">行き先の施設を探しています…</li>';
  const pois = await loadPOIs();
  const reach = H.poiReach(NET, R, pois, S.home);
  S.reach = reach;
  poiLayer.clearLayers();
  reach.forEach((p) => {
    L.circleMarker([p.lat, p.lon], { radius: 7, color: '#7c3aed', weight: 2, fillColor: '#fff', fillOpacity: 1 })
      .bindTooltip(`${p.kind}：${p.name}`).on('click', (e) => { L.DomEvent.stopPropagation(e); openCard(p.stop, p); })
      .addTo(poiLayer);
  });
  list.innerHTML = reach.length
    ? reach.slice(0, 40).map((p, i) => `<li data-i="${i}"><b>${esc(p.kind)}　${esc(p.name)}</b><span>「${esc(NET.stops[p.stop].name)}」で降りて歩いて${p.walk}分・${s2t(p.arrive)}ごろ着</span></li>`).join('')
    : `<li class="hint">${pois.length ? '近くに行ける施設が見つかりませんでした。条件をゆるめてみてください。' : '施設データを取得できませんでした。地図のバス停をタップしてカードを作れます。'}</li>`;
  list.querySelectorAll('li[data-i]').forEach((li) => li.addEventListener('click', () => {
    const p = reach[+li.dataset.i];
    map.setView([p.lat, p.lon], 15, { animate: false });
    openCard(p.stop, p);
  }));
}

// ---------- おでかけカード ----------
let cardCtx = null;
function openCard(s, poi) {
  const R = S.result;
  if (!R) return;
  const { walk, legs } = H.legsOf(R.label[s]);
  const rets = H.returnOptions(NET, R, s);
  cardCtx = { s, legs, rets };
  const T = NET.trips;
  const dest = poi ? `${esc(poi.kind)}「${esc(poi.name)}」` : `「${rubyName(s)}」`;
  let html = `<h2>おでかけカード</h2><div class="who">なまえ：　　　　　　　　　行き先：${dest}</div>`;
  html += `<div class="leg"><h3>いき</h3><ol><li>家を出る：<span class="t">${s2t(R.P.depart)}</span>　バス停まで歩いて${Math.max(1, Math.round(walk / 60))}分</li>`;
  legs.forEach((l) => {
    if (l.type === 'xfer') { html += `<li>となりのバス停まで歩いて${Math.max(1, Math.round(l.walk / 60))}分</li>`; return; }
    const tr = T[l.trip];
    html += `<li>「<b>${rubyName(tr.stops[l.fromPos])}</b>」から <span class="t">${s2t(tr.dep[l.fromPos])}</span> の<br>${esc(tr.routeName)}（${esc(tr.headsign)}行き）に乗る</li>`;
    html += `<li>「<b>${rubyName(tr.stops[l.toPos])}</b>」でおりる <span class="t">${s2t(tr.arr[l.toPos])}</span>（${l.toPos - l.fromPos}つめ）</li>`;
  });
  if (poi) html += `<li>歩いて${poi.walk}分で${esc(poi.name)}に着く</li>`;
  html += `</ol></div>`;
  if (rets.length) {
    const first = rets[0], last = rets[rets.length - 1];
    const legHtml = (o) => {
      const tr = T[o.ti];
      return `「<b>${rubyName(tr.stops[o.from])}</b>」から <span class="t">${s2t(tr.dep[o.from])}</span> の ${esc(tr.routeName)}（${esc(tr.headsign)}行き）→「${rubyName(tr.stops[o.to])}」でおりる ${s2t(tr.arr[o.to])} → 家に着く ${s2t(o.home)}`;
    };
    html += `<div class="leg"><h3>かえり</h3><ol><li>${legHtml(first)}</li></ol>`;
    if (first.walkTo) {
      const back = T[first.ti].stops[first.from];
      html += NET.stops[back].name === NET.stops[s].name
        ? `<p class="hint">帰りは道の反対側ののりばから乗ります（歩いて${Math.max(1, Math.round(first.walkTo / 60))}分）。</p>`
        : `<div class="last">ちゅうい：帰りは<b>「${rubyName(back)}」</b>から乗ります。おりたバス停とはちがう場所です（歩いて${Math.max(1, Math.round(first.walkTo / 60))}分）。</div>`;
    }
    html += `</div><div class="last">さいごの帰りのバス：<span class="t">${s2t(T[last.ti].dep[last.from])}</span>「${rubyName(T[last.ti].stops[last.from])}」発（帰りの便は${rets.length}本）<br>これに乗れなかったら、すぐに電話する。</div>`;
  } else {
    html += `<div class="last">このバス停からは、門限までに家に帰るバスがありません。<br>おうちの人とむかえの相談をしよう。</div>`;
  }
  html += `<div class="tel">電話：　　　　　　　　　　　　　（おうちの人）</div>`;
  const f = NET.feeds[NET.stops[s].feed];
  const saved = f.source === 'bundle' ? `（${esc(f.fetched)}保存版）` : '';
  html += `<div class="src">${esc(R.P.date)}のダイヤ／出典：${esc(f.orgName)}「${esc(f.name)}」GTFSデータ${saved}（${esc(f.license)}）・GTFSデータリポジトリ。運休・遅れ・運賃は事業者の案内で確認してください。</div>`;
  $('card').innerHTML = html;
  $('card-raw').hidden = true;
  $('card-modal').hidden = false;
}

function showRaw() {
  // 「時刻表はデータでできている」：カードの元になった stop_times の行を見せる
  if (!cardCtx) return;
  const rideLegs = cardCtx.legs.filter((l) => l.type === 'ride').map((l) => ({ ti: l.trip, from: l.fromPos, to: l.toPos }));
  if (cardCtx.rets[0]) rideLegs.push(cardCtx.rets[0]);
  let html = '<p>このカードは、バス会社が公開している <b>stop_times.txt</b>（どの便が、どのバス停を、何時に通るか）の次の行から作られています。色のついた行が、乗る所とおりる所です。</p>';
  for (const o of rideLegs) {
    const tr = NET.trips[o.ti];
    html += `<p class="hint">この便の trip_id：${esc(tr.tripId)}</p><table><tr><th>stop_sequence</th><th>stop_id</th><th>（バス停名）</th><th>departure_time</th></tr>`;
    for (let k = Math.max(0, o.from - 1); k <= Math.min(tr.stops.length - 1, o.to + 1); k++) {
      const hl = k === o.from || k === o.to ? ' class="hl"' : '';
      const st = NET.stops[tr.stops[k]];
      html += `<tr${hl}><td>${tr.seq[k]}</td><td>${esc(st.id)}</td><td>${esc(st.name)}</td><td>${s2t(tr.dep[k])}</td></tr>`;
    }
    html += '</table><br>';
  }
  $('card-raw').innerHTML = html;
  $('card-raw').hidden = false;
}

// ---------- まちモード ----------
async function runTown() {
  if (!NET) return;
  const P = Object.assign(params(), { transfers: 0 });
  busy('まち全体を計算しています…');
  await tick();
  const act = H.activeMask(NET, P.date);
  const N = NET.stops.length;
  const score = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    score[i] = H.townScore(NET, i, P, act);
    if (i % 500 === 0) { $('busy-msg').textContent = `まち全体を計算しています… ${i}/${N}`; await tick(); }
  }
  S.townScore = score;
  stopLayer.clearLayers();
  if (homeMarker) homeMarker.remove();
  if (homeCircle) homeCircle.remove();
  poiLayer.clearLayers();
  const max = Math.max(1, ...score);
  const color = (v) => v === 0 ? '#c2410c' : v < max * 0.15 ? '#f59e0b' : v < max * 0.4 ? '#84cc16' : '#15803d';
  NET.stops.forEach((s, i) => {
    L.circleMarker([s.lat, s.lon], { radius: 3 + 6 * Math.sqrt(score[i] / max), color: color(score[i]), weight: 1, fillColor: color(score[i]), fillOpacity: 0.8 })
      .bindTooltip(`${s.name}：${score[i]}か所`).addTo(stopLayer);
  });
  const zero = [...score].filter((v) => v === 0).length;
  const sorted = [...score].sort((a, b) => a - b);
  const median = sorted[Math.floor(N / 2)];
  const byName = new Map();
  NET.stops.forEach((s, i) => { if (!byName.has(s.name) || byName.get(s.name) < score[i]) byName.set(s.name, score[i]); });
  const ranked = [...byName.entries()].sort((a, b) => a[1] - b[1]);
  $('town-summary').innerHTML = `
    <div class="score"><div class="big zero">${zero}<small> / ${N} のバス停で、ひとりで行けて帰れる行き先がゼロ</small></div>
    <p>その場所に住む子どもの場合（${P.date} ${s2t(P.depart)}発・${P.budget / 60}分以内・門限${s2t(P.curfew)}・乗りかえなし）。全バス停の中央値は${median}か所。</p></div>
    <ul class="legend"><li><i class="dot" style="background:#c2410c"></i>0か所</li><li><i class="dot" style="background:#f59e0b"></i>少ない</li><li><i class="dot" style="background:#84cc16"></i>中くらい</li><li><i class="dot" style="background:#15803d"></i>多い（最大${max}か所）</li></ul>
    <h3>行き先が少ないバス停（下位15）</h3>
    <table class="town-table">${ranked.slice(0, 15).map(([n, v]) => `<tr><td>${esc(n)}</td><td>${v}</td></tr>`).join('')}</table>
    <button id="town-csv">結果をCSVで保存</button>`;
  $('town-csv').addEventListener('click', () => {
    const rows = [['stop_id', 'stop_name', 'lat', 'lon', 'feed', 'reachable_and_returnable']];
    NET.stops.forEach((s, i) => rows.push([s.id, s.name, s.lat, s.lon, NET.feeds[s.feed].name, score[i]]));
    const csv = '﻿' + rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `hitoride-bus_town_${P.date}.csv`;
    a.click();
  });
  idle();
}

// ---------- データ選択 UI ----------
async function loadFeeds(list, allowBundle) {
  busy('バスのデータを読み込んでいます…');
  // 発表会場などで通信を待ちたくないときは、URL に ?offline=1 を付けると最初から保存版を使う
  S.apiDown = allowBundle && new URLSearchParams(location.search).has('offline');
  try {
    const net = H.createNetwork();
    for (const [i, [org, feed]] of list.entries()) {
      $('busy-msg').textContent = `バスのデータを読み込んでいます…（${i + 1}/${list.length}）`;
      const { files, meta } = await getFeed(org, feed, allowBundle);
      await tick();
      H.addFeed(net, files, meta);
    }
    NET = H.finalize(net);
    S.result = null; S.townScore = null; POIS = null;
    S.kanaIndex = new Map(NET.stops.filter((s) => s.kana).map((s) => [s.name, s.kana]));
    drawStopsPlain();
    if (NET.stops.length) map.fitBounds(L.latLngBounds(NET.stops.map((s) => [s.lat, s.lon])), { padding: [20, 20], animate: false });
    const saved = NET.feeds.filter((f) => f.source === 'bundle');
    $('data-status').innerHTML = `読み込み完了：${NET.feeds.map((f) => esc(f.name)).join('、')}<br>バス停 ${NET.stops.length}か所・便 ${NET.trips.length}本`
      + (saved.length ? `<br>通信できなかったため、${esc(saved[0].fetched)}に保存したデータを使っています。` : '');
    $('credit-list').innerHTML = NET.feeds.map((f) => `<li>${esc(f.orgName)}「${esc(f.name)}」GTFS（${f.licenseUrl ? `<a href="${esc(f.licenseUrl)}" target="_blank" rel="noopener">${esc(f.license)}</a>` : esc(f.license)}）有効期間 ${esc(f.start)}〜${esc(f.end)}</li>`).join('');
    const ends = NET.feeds.map((f) => f.end).filter(Boolean).sort();
    if (ends.length) $('p-date').max = ends[0];
    if (S.home) setHome(S.home.lat, S.home.lon);
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
  try {
    const cat = await fetchCatalog();
    const feeds = cat.filter((f) => f.feed_pref_id === pref);
    $('feed-count').textContent = `全国 ${cat.length} 件のGTFSから選べます（GTFSデータリポジトリ）`;
    $('feed-list').innerHTML = feeds.length
      ? feeds.map((f) => `<label><input type="checkbox" value="${esc(f.organization_id)}|${esc(f.feed_id)}"> ${esc(f.feed_name)}（${esc(f.organization_name)}）</label>`).join('')
      : '<p class="hint">この都道府県のデータは登録されていません。</p>';
  } catch (err) {
    $('feed-list').innerHTML = `<p class="hint">一覧を取得できませんでした（${esc(err.message)}）。</p>`;
  }
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
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function init() {
  initMap();
  $('p-date').value = nextSaturday();
  $('pref').innerHTML = PREFS.map((p, i) => `<option value="${i + 1}"${i === 1 ? ' selected' : ''}>${p}</option>`).join('');
  $('pref').addEventListener('change', fillFeedList);
  document.querySelector('details').addEventListener('toggle', (e) => { if (e.target.open) fillFeedList(); }, { once: true });
  $('preset-hachinohe').addEventListener('click', () => { POI_FILE = 'data/pois_hachinohe.json'; loadFeeds(PRESET_HACHINOHE, true); });
  $('load-selected').addEventListener('click', () => {
    const sel = [...document.querySelectorAll('#feed-list input:checked')].map((c) => c.value.split('|'));
    if (sel.length) { POI_FILE = null; loadFeeds(sel, false); }
  });
  $('run').addEventListener('click', run);
  $('run-town').addEventListener('click', runTown);
  $('p-walk').addEventListener('change', () => S.home && setHome(S.home.lat, S.home.lon));
  $('card-close').addEventListener('click', () => ($('card-modal').hidden = true));
  $('card-modal').addEventListener('click', (e) => { if (e.target.id === 'card-modal') $('card-modal').hidden = true; });
  $('card-print').addEventListener('click', () => window.print());
  $('card-data').addEventListener('click', showRaw);
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  runDemo(new URLSearchParams(location.search));
}

// ?demo=1 で、八戸圏の読み込みから計算までを自動で行う（審査員がリンクを開くだけで結果を見られるように）。
// &home=緯度,経度 &mode=town &card=施設名の一部 &raw=1 で、見せる画面を選べる
async function runDemo(q) {
  if (['light', 'dark'].includes(q.get('theme'))) document.documentElement.dataset.theme = q.get('theme');
  if (!q.has('demo')) return;
  POI_FILE = 'data/pois_hachinohe.json';
  await loadFeeds(PRESET_HACHINOHE, true);
  if (!NET) return;
  const [lat, lon] = (q.get('home') || '40.5003,141.4627').split(',').map(Number);
  if (q.get('mode') === 'town') {
    setMode('town');
    await runTown();
    return;
  }
  setHome(lat, lon);
  await run();
  if (!q.has('card')) return;
  const p = (S.reach || []).find((x) => x.name.includes(q.get('card')));
  if (!p) return;
  map.setView([p.lat, p.lon], 15, { animate: false });
  openCard(p.stop, p);
  if (q.has('raw')) { showRaw(); $('card-raw').scrollIntoView({ block: 'start' }); }
}
init();
