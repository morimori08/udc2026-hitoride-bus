'use strict';
// 子どもの人数で見る: 500mメッシュごとの年少人口（国土数値情報・将来推計人口 R6、2025年値）を、
// メッシュの中心に家があるとして「ひとりで行けて帰れる行き先」が0か所かどうかで数える。
// 使い方: node analysis/children/run.js <500m_mesh_2024_02.geojson のパス>
const fs = require('fs');
const path = require('path');
const { loadBundled, core } = require('../../tools/gtfs-node');

const src = process.argv[2];
if (!src) throw new Error('geojson のパスを渡してください');
const TOWNS = { '02203': '八戸市', '02446': '階上町' };
const hm = core.hm2s;
const BASE = { depart: hm('10:00'), budget: 3600, walk: 400, stay: 5400, curfew: hm('17:00'), transfers: 0 };

const net = loadBundled();
const gj = JSON.parse(fs.readFileSync(src, 'utf8'));
const meshes = gj.features.filter((f) => TOWNS[f.properties.SHICODE]).map((f) => {
  const ring = f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : f.geometry.coordinates[0][0];
  const lons = ring.map((c) => c[0]), lats = ring.map((c) => c[1]);
  const p = f.properties;
  return {
    id: p.MESH_ID, town: TOWNS[p.SHICODE],
    lat: (Math.min(...lats) + Math.max(...lats)) / 2, lon: (Math.min(...lons) + Math.max(...lons)) / 2,
    kids: p.PTA_2025 || 0, school: (p.PT02_2025 || 0) + (p.PT03_2025 || 0),
  };
});

function evaluate(date, transfers) {
  const act = core.activeMask(net, date);
  const P = Object.assign({}, BASE, { transfers });
  const sum = { kids: 0, school: 0, zeroKids: 0, zeroSchool: 0, noStopKids: 0, stopZeroKids: 0, meshes: 0, zeroMeshes: 0 };
  const byTown = {};
  for (const m of meshes) {
    if (m.kids <= 0) continue;
    const hs = core.nearStops(net, m.lat, m.lon, P.walk);
    const ok = hs.length ? core.compute(net, hs, P, act, { countOnly: true }).ok : 0;
    const t = (byTown[m.town] = byTown[m.town] || { kids: 0, zeroKids: 0 });
    sum.meshes++; sum.kids += m.kids; sum.school += m.school; t.kids += m.kids;
    if (ok === 0) {
      sum.zeroMeshes++; sum.zeroKids += m.kids; sum.zeroSchool += m.school; t.zeroKids += m.kids;
      if (hs.length) sum.stopZeroKids += m.kids; else sum.noStopKids += m.kids;
    }
  }
  const r = (v) => Math.round(v);
  return {
    date, transfers, meshesWithKids: sum.meshes, zeroMeshes: sum.zeroMeshes,
    kids: r(sum.kids), zeroKids: r(sum.zeroKids), zeroPct: Math.round(1000 * sum.zeroKids / sum.kids) / 10,
    school: r(sum.school), zeroSchool: r(sum.zeroSchool), zeroSchoolPct: Math.round(1000 * sum.zeroSchool / sum.school) / 10,
    noStopKids: r(sum.noStopKids), stopZeroKids: r(sum.stopZeroKids),
    byTown: Object.fromEntries(Object.entries(byTown).map(([k, v]) => [k, { kids: r(v.kids), zeroKids: r(v.zeroKids), zeroPct: Math.round(1000 * v.zeroKids / v.kids) / 10 }])),
  };
}

const results = [evaluate('2026-11-07', 0), evaluate('2026-11-07', 1), evaluate('2026-11-10', 0)];
fs.writeFileSync(path.join(__dirname, 'result.json'), JSON.stringify({ source: '国土数値情報 500mメッシュ別将来推計人口（R6国政局推計）青森県 500m_mesh_2024_02, PTA_2025（0〜14歳）と PT02_2025+PT03_2025（5〜14歳）', conditions: '10:00発・行き60分以内・徒歩400m・滞在90分・門限17:00', feeds: net.feeds.map((f) => f.name), results }, null, 2) + '\n');
console.log(JSON.stringify(results, null, 1));
