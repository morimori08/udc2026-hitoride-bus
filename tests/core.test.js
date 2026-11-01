'use strict';
// core.js のテスト。期待値は dev/core-spec.md から立てる。実行: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../app/core.js');

const hms = (sec) => [Math.floor(sec / 3600), Math.floor(sec / 60) % 60, sec % 60].map((v) => String(v).padStart(2, '0')).join(':');
const T = (h, m, s = 0) => h * 3600 + m * 60 + s;
const LAT0 = 40, LON0 = 141;
// 緯度方向に m メートル北の点
const north = (m) => LAT0 + m / 111320;

// 合成 GTFS を組み立てる。trips: [tripId, serviceId, [[stopId, arr, dep], ...]]（時刻は秒か文字列）
function gtfs({ stops, trips, calendar, calendarDates, frequencies, translations, extraStopCols }) {
  const files = {};
  files['stops.txt'] = ['stop_id,stop_name,stop_lat,stop_lon,location_type', ...stops.map(([id, name, lat, lon, lt = '']) => `${id},${name},${lat},${lon},${lt}`)].join('\n');
  if (extraStopCols) files['stops.txt'] = extraStopCols;
  files['routes.txt'] = 'route_id,route_short_name,route_long_name\nR,1,テスト線';
  files['trips.txt'] = ['route_id,service_id,trip_id,trip_headsign', ...trips.map(([id, svc]) => `R,${svc},${id},終点`)].join('\n');
  const st = ['trip_id,arrival_time,departure_time,stop_id,stop_sequence'];
  for (const [id, , rows] of trips) rows.forEach(([sid, a, d, seq], i) => {
    const f = (v) => (v === '' || v == null ? '' : typeof v === 'number' ? hms(v) : v);
    st.push(`${id},${f(a)},${f(d === undefined ? a : d)},${sid},${seq ?? i + 1}`);
  });
  files['stop_times.txt'] = st.join('\n');
  files['calendar.txt'] = ['service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date',
    ...(calendar || [['ALL', '1111111', '20260101', '20271231']]).map(([id, days, s, e]) => `${id},${days.split('').join(',')},${s},${e}`)].join('\n');
  if (calendarDates) files['calendar_dates.txt'] = ['service_id,date,exception_type', ...calendarDates.map((r) => r.join(','))].join('\n');
  if (frequencies) files['frequencies.txt'] = ['trip_id,start_time,end_time,headway_secs', ...frequencies.map(([id, s, e, h]) => `${id},${hms(s)},${hms(e)},${h}`)].join('\n');
  if (translations) files['translations.txt'] = translations;
  return files;
}
function build(spec) {
  const net = core.createNetwork();
  core.addFeed(net, gtfs(spec), { name: 'test' });
  return core.finalize(net);
}
const idx = (net, id) => net.stops.findIndex((s) => s.id === id);
const P0 = { depart: T(10, 0), budget: 3600, walk: 400, stay: 5400, curfew: T(17, 0), transfers: 0 };
function run(net, P = P0, date = '2026-11-09', home = [LAT0, LON0]) {
  return core.compute(net, core.nearStops(net, home[0], home[1], P.walk), P, core.activeMask(net, date));
}

// 家（緯度40,経度141）の北222mに A、北5.5kmに行き先 B、さらに北に C
function base({ backStop = 'B', backAt = T(12, 30), backDist = 0, outArr = T(10, 30) } = {}) {
  const stops = [['A', 'エー', north(222), LON0], ['B', 'ビー', north(5500), LON0], ['C', 'シー', north(11000), LON0]];
  if (backStop !== 'B') stops.push([backStop, 'ビー東', north(5500 + backDist), LON0]);
  return {
    stops,
    trips: [
      ['T1', 'ALL', [['A', T(10, 10)], ['B', outArr], ['C', T(10, 50)]]],
      ['T2', 'ALL', [[backStop, backAt], ['A', backAt + 1200]]],
      ['T3', 'ALL', [['C', T(16, 50)], ['A', T(17, 10)]]],
    ],
  };
}

test('CSV: BOM・クォート内のカンマと改行・二重クォート・CRLF', () => {
  const t = core.parseCSV('﻿a, b ,c\r\n1,"x,y","he said ""hi"""\r\n2,"line1\nline2",z\r\n');
  assert.deepEqual(t.header, ['a', 'b', 'c']);
  assert.deepEqual(t.rows[0], ['1', 'x,y', 'he said "hi"']);
  assert.deepEqual(t.rows[1], ['2', 'line1\nline2', 'z']);
  assert.equal(t.col('b'), 1);
});

test('時刻: 24時を超える時刻と分単位の表示', () => {
  assert.equal(core.t2s('25:10:00'), 90600);
  assert.equal(core.t2s(' 07:05:30 '), T(7, 5, 30));
  assert.ok(Number.isNaN(core.t2s('')));
  assert.equal(core.s2t(T(9, 5, 31)), '9:06');
});

test('ファイル名: .csv や大文字、フォルダ入りも標準名に揃え、関係ないファイルは無視する', () => {
  assert.equal(core.gtfsName('trips.csv'), 'trips.txt');
  assert.equal(core.gtfsName('feed/Stop_Times.TXT'), 'stop_times.txt');
  assert.equal(core.gtfsName('shapes.csv'), null);
  assert.equal(core.gtfsName('readme.md'), null);
});

test('次に便が走る日: 翌日以降で最初の日。無ければ null', () => {
  const net = build({
    stops: [['P', 'p', north(0), LON0], ['Q', 'q', north(1000), LON0]],
    trips: [['W', 'TUE', [['P', T(9, 0)], ['Q', T(9, 10)]]]],
    calendar: [['TUE', '0100000', '20261101', '20261130']],
  });
  assert.equal(core.nextServiceDate(net, '2026-11-07', 30), '2026-11-10');
  assert.equal(core.nextServiceDate(net, '2026-11-30', 30), null);
});

test('曜日はタイムゾーンに依存しない（月曜=0）', () => {
  assert.equal(core.weekdayOf('2026-11-07'), 5);
  assert.equal(core.weekdayOf('2026-11-09'), 0);
});

test('停留所: location_type=1 と (0,0) を除く。ふりがなは新形式・旧形式の両方から', () => {
  const stopsTxt = 'stop_id,stop_name,stop_lat,stop_lon,location_type\nS1,八日町,40.1,141.1,0\nS2,三日町,40.2,141.1,\nST,駅,40.3,141.1,1\nZ,ゼロ,0,0,';
  const newTr = 'table_name,field_name,language,translation,record_id,record_sub_id,field_value\nstops,stop_name,ja-Hrkt,ようかまち,S1,,\nstops,stop_name,en,Yoka-Machi,S1,,\nstops,stop_name,ja-Hrkt,みっかまち,,,三日町';
  const net = build({ stops: [], trips: [['T', 'ALL', [['S1', T(9, 0)], ['S2', T(9, 10)]]]], extraStopCols: stopsTxt, translations: newTr });
  assert.deepEqual(net.stops.map((s) => s.id), ['S1', 'S2']);
  assert.equal(net.stops[0].kana, 'ようかまち');
  assert.equal(net.stops[1].kana, 'みっかまち');
  const oldTr = 'trans_id,lang,translation\n八日町,ja-Hrkt,ようかまち\n八日町,en,Yoka';
  const net2 = build({ stops: [], trips: [['T', 'ALL', [['S1', T(9, 0)], ['S2', T(9, 10)]]]], extraStopCols: stopsTxt, translations: oldTr });
  assert.equal(net2.stops[0].kana, 'ようかまち');
});

test('stop_times: 並べ替え・空欄の按分・端の空欄の切り捨て', () => {
  const net = build({
    stops: [['P', 'p', north(0), LON0], ['Q', 'q', north(100), LON0], ['R', 'r', north(200), LON0], ['S', 's', north(300), LON0], ['U', 'u', north(400), LON0]],
    trips: [['T', 'ALL', [['R', '', '', 3], ['U', '', '', 5], ['P', T(9, 0), T(9, 0), 1], ['Q', '', '', 2], ['S', T(9, 30), T(9, 30), 4]]]],
  });
  const tr = net.trips[0];
  assert.deepEqual([...tr.seq], [1, 2, 3, 4]);
  assert.deepEqual([...tr.dep], [T(9, 0), T(9, 10), T(9, 20), T(9, 30)]);
});

test('frequencies: 開始から終了未満まで間隔ごとに複製する', () => {
  const net = build({
    stops: [['P', 'p', north(0), LON0], ['Q', 'q', north(1000), LON0]],
    trips: [['F', 'ALL', [['P', T(6, 0)], ['Q', T(6, 15)]]]],
    frequencies: [['F', T(8, 0), T(9, 0), 1200]],
  });
  assert.equal(net.trips.length, 3);
  assert.deepEqual(net.trips.map((t) => t.dep[0]), [T(8, 0), T(8, 20), T(8, 40)]);
  assert.deepEqual(net.trips.map((t) => t.arr[1]), [T(8, 15), T(8, 35), T(8, 55)]);
});

test('運行日: 曜日・期間の両端・追加・除外（除外が優先）', () => {
  const spec = {
    stops: [['P', 'p', north(0), LON0], ['Q', 'q', north(1000), LON0]],
    trips: [['W', 'WK', [['P', T(9, 0)], ['Q', T(9, 10)]]], ['X', 'EXTRA', [['P', T(9, 0)], ['Q', T(9, 10)]]]],
    calendar: [['WK', '1111100', '20261102', '20261130']],
    calendarDates: [['WK', '20261110', '2'], ['WK', '20261107', '1'], ['EXTRA', '20261108', '1']],
  };
  const net = build(spec);
  const on = (d) => [...core.activeMask(net, d)];
  assert.deepEqual(on('2026-11-02'), [1, 0]); // 期間の初日（月）
  assert.deepEqual(on('2026-11-30'), [1, 0]); // 期間の最終日（月）
  assert.deepEqual(on('2026-12-01'), [0, 0]);
  assert.deepEqual(on('2026-11-10'), [0, 0]); // 除外
  assert.deepEqual(on('2026-11-07'), [1, 0]); // 土曜の追加
  assert.deepEqual(on('2026-11-08'), [0, 1]); // calendar.txt に無い service の追加
});

test('基本: 行けて帰れる・行けるが帰れない・家の停留所', () => {
  const net = build(base());
  const R = run(net);
  assert.equal(R.status[idx(net, 'A')], 3);
  assert.equal(R.status[idx(net, 'B')], 2);
  assert.equal(R.status[idx(net, 'C')], 1); // 帰り便は門限後に着く
  assert.equal(R.ok, 1);
  assert.equal(R.oneway, 1);
});

test('帰り: 300m 以内の別のりばから帰れる。300m を超えると帰れない', () => {
  const near = build(base({ backStop: 'B3', backDist: 250 }));
  assert.equal(run(near).status[idx(near, 'B')], 2);
  const far = build(base({ backStop: 'B3', backDist: 320 }));
  assert.equal(run(far).status[idx(far, 'B')], 1);
});

test('境界: 予算ちょうどに着く・着いた時刻ちょうどに出る便に乗れる', () => {
  const ok = build(base({ outArr: T(11, 0) }));
  assert.equal(run(ok).status[idx(ok, 'B')], 2);
  const late = build(base({ outArr: T(11, 0, 1) }));
  assert.equal(run(late).status[idx(late, 'B')], 0);
  const net = build(base());
  const walk = core.nearStops(net, LAT0, LON0, 400)[0].walk;
  const R = core.compute(net, [{ s: idx(net, 'A'), walk }], { ...P0, depart: T(10, 10) - walk }, core.activeMask(net, '2026-11-09'));
  assert.equal(R.status[idx(net, 'B')], 2);
  const R2 = core.compute(net, [{ s: idx(net, 'A'), walk }], { ...P0, depart: T(10, 10) - walk + 1 }, core.activeMask(net, '2026-11-09'));
  assert.equal(R2.status[idx(net, 'B')], 0);
});

test('境界: 滞在後ちょうどに出る帰り便・門限ちょうどに家に着く', () => {
  const net = build(base({ backAt: T(12, 0) }));
  assert.equal(run(net).status[idx(net, 'B')], 2);
  const net2 = build(base({ backAt: T(11, 59, 59) }));
  assert.equal(run(net2).status[idx(net2, 'B')], 1);
  const walk = core.nearStops(net, LAT0, LON0, 400)[0].walk;
  assert.equal(run(net, { ...P0, curfew: T(12, 20) + walk }).status[idx(net, 'B')], 2);
  assert.equal(run(net, { ...P0, curfew: T(12, 20) + walk - 1 }).status[idx(net, 'B')], 1);
});

test('乗りかえ: 150m 以内で180秒あと以降の便。乗りかえなしでは届かない', () => {
  const mk = (dep2) => build({
    stops: [['A', 'a', north(100), LON0], ['M', 'm', north(3000), LON0], ['M2', 'm2', north(3100), LON0], ['D', 'd', north(8000), LON0]],
    trips: [['T1', 'ALL', [['A', T(10, 5)], ['M', T(10, 20)]]], ['T2', 'ALL', [['M2', dep2], ['D', T(10, 45)]]], ['TB', 'ALL', [['D', T(13, 0)], ['A', T(13, 30)]]]],
  });
  const walkMM2 = core.walkSec(core.dist(north(3000), LON0, north(3100), LON0));
  const ok = mk(T(10, 20) + walkMM2 + 180);
  assert.equal(run(ok, { ...P0, transfers: 1 }).status[idx(ok, 'D')], 2);
  assert.equal(run(ok).status[idx(ok, 'D')], 0);
  const tight = mk(T(10, 20) + walkMM2 + 179);
  assert.equal(run(tight, { ...P0, transfers: 1 }).status[idx(tight, 'D')], 0);
});

test('returnOptions: 出発の早い順、同じ出発時刻は1件', () => {
  const spec = base();
  spec.trips.push(['T4', 'ALL', [['B', T(14, 0)], ['A', T(14, 20)]]], ['T5', 'ALL', [['B', T(12, 30)], ['A', T(12, 55)]]]);
  const net = build(spec);
  const R = run(net);
  const opts = core.returnOptions(net, R, idx(net, 'B'));
  assert.deepEqual(opts.map((o) => net.trips[o.ti].dep[o.from]), [T(12, 30), T(14, 0)]);
});

test('countOnly は通常の計算と同じ件数を返し、続けて呼んでも結果が変わらない', () => {
  const { loadBundled } = require('../tools/gtfs-node');
  const net = loadBundled();
  const act = core.activeMask(net, '2026-11-07');
  for (let i = 0; i < net.stops.length; i += 97) {
    const s = net.stops[i];
    const hs = core.nearStops(net, s.lat, s.lon, 400);
    const full = core.compute(net, hs, P0, act);
    const a = core.compute(net, hs, P0, act, { countOnly: true });
    const b = core.compute(net, hs, P0, act, { countOnly: true });
    assert.deepEqual([a.ok, a.oneway], [full.ok, full.oneway]);
    assert.deepEqual(b, a);
  }
});

test('poiReach: 同着なら徒歩の短いほう・家から800m以内は除外・種類の順', () => {
  const net = build(base({ backStop: 'B3', backDist: 120 }));
  net.stops[idx(net, 'B3')].lat = north(5500 + 120);
  const R = run(net);
  R.status[idx(net, 'B3')] = 2;
  R.best[idx(net, 'B3')] = R.best[idx(net, 'B')] - 120;
  const pois = [
    { name: '公園', kind: '公園', lat: north(5520), lon: LON0 },
    { name: '図書館', kind: '図書館', lat: north(5520), lon: LON0 },
    { name: '近所', kind: '図書館', lat: north(300), lon: LON0 },
  ];
  const out = core.poiReach(net, R, pois, { lat: LAT0, lon: LON0 });
  assert.deepEqual(out.map((p) => p.name), ['図書館', '公園']);
  // B は徒歩20m（0分）、B3 は2分早く着くが徒歩100m（2分）→ 同着なので徒歩の短い B
  assert.equal(out[0].stop, idx(net, 'B'));
  assert.equal(out[0].walk, 0);
});

test('回帰: 八戸圏の同梱データで発表の数字が再現する', () => {
  const { loadBundled } = require('../tools/gtfs-node');
  const net = loadBundled();
  const act = core.activeMask(net, '2026-11-07');
  const R = core.compute(net, core.nearStops(net, 40.5003, 141.4627, 400), P0, act);
  assert.deepEqual([R.ok, R.oneway], [27, 0]);
  const sc = net.stops.map((_, i) => core.townScore(net, i, P0, act));
  const sorted = [...sc].sort((a, b) => a - b);
  assert.equal(sc.filter((v) => v === 0).length, 836);
  assert.equal(sorted[Math.floor(sc.length / 2)], 8);
  assert.equal(Math.max(...sc), 258);
});
