'use strict';
// 八戸圏（同梱の4事業者）の分析: 条件ごとの「行き先ゼロ」、のりば違い、行けるが帰れない行き先、乗りかえの効果。
// 使い方: node analysis/hachinohe/run.js
const fs = require('fs');
const path = require('path');
const { loadBundled, core } = require('../../tools/gtfs-node');

const OUT = __dirname;
const net = loadBundled();
const N = net.stops.length;
const hm = core.hm2s;
const BASE = { date: '2026-11-07', depart: hm('10:00'), budget: 3600, walk: 400, stay: 5400, curfew: hm('17:00'), transfers: 0 };
const homes = net.stops.map((s) => core.nearStops(net, s.lat, s.lon, BASE.walk));
const csv = (rows) => '﻿' + rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n') + '\n';
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

function scores(P) {
  const act = core.activeMask(net, P.date);
  return homes.map((h) => core.compute(net, h, P, act, { countOnly: true }).ok);
}

// 1. 既定条件の再現
const base = scores(BASE);
const baseZero = base.filter((v) => v === 0).length;
const report = [];
report.push('# 八戸圏の分析（同梱データ: 八戸市営バス・八戸市南郷コミュニティバス・階上町コミュニティバス・十和田観光電鉄）', '');
report.push(`既定条件（2026-11-07 土・10:00発・60分以内・徒歩400m・滞在90分・門限17:00・乗りかえなし）: 停留所 ${N} のうち行き先ゼロ ${baseZero}、中央値 ${median(base)}、最大 ${Math.max(...base)}。発表の数字（836・8・258）と${baseZero === 836 && median(base) === 8 && Math.max(...base) === 258 ? '一致' : '不一致'}。`, '');
report.push('注意: 南部バス（八戸市内も走る）は、この同梱データに入っていない。南部バスが単独で走る地区では、ゼロが実際より多く出る。', '');

// 2. 感度表
const sens = [['date', 'weekday', 'depart', 'curfew', 'transfers', 'zero', 'zero_pct', 'median']];
const WD = '月火水木金土日';
for (const date of ['2026-11-07', '2026-11-08', '2026-11-10']) for (const dep of ['09:00', '10:00', '13:00', '15:00']) for (const cur of ['17:00', '18:00']) for (const tr of [0, 1]) {
  const P = Object.assign({}, BASE, { date, depart: hm(dep), curfew: hm(cur), transfers: tr });
  const sc = scores(P);
  const z = sc.filter((v) => v === 0).length;
  sens.push([date, WD[core.weekdayOf(date)], dep, cur, tr, z, Math.round(1000 * z / N) / 10, median(sc)]);
}
fs.writeFileSync(path.join(OUT, 'sensitivity.csv'), csv(sens));
const rows = sens.slice(1);
const best = rows.reduce((a, b) => (b[5] < a[5] ? b : a));
const worst = rows.reduce((a, b) => (b[5] > a[5] ? b : a));
report.push('## 条件を変えると', '', '| 曜日 | 出発 | 門限 | 乗りかえ | 行き先ゼロ | 割合 | 中央値 |', '|---|---|---|---|---|---|---|');
for (const r of rows.filter((r) => r[3] === '17:00')) report.push(`| ${r[0]}（${r[1]}） | ${r[2]} | ${r[3]} | ${r[4] ? '1回まで' : 'なし'} | ${r[5]} | ${r[6]}% | ${r[7]} |`);
report.push('', `門限18:00を含む全${rows.length}通りは sensitivity.csv。ゼロが最も少ない条件: ${best[0]}（${best[1]}）${best[2]}発・門限${best[3]}・乗りかえ${best[4] ? '1回' : 'なし'}で ${best[5]}（${best[6]}%）。最も多い条件: ${worst[0]}（${worst[1]}）${worst[2]}発・門限${worst[3]}・乗りかえ${worst[4] ? '1回' : 'なし'}で ${worst[5]}（${worst[6]}%）。`, '');

// 3. のりば違いと、行けるが帰れない行き先（既定条件、全停留所を家として）
const act = core.activeMask(net, BASE.date);
const mismatch = new Map();
const oneway = new Map();
let okPairs = 0, mismatchPairs = 0;
for (let i = 0; i < N; i++) {
  const R = core.compute(net, homes[i], BASE, act);
  for (let s = 0; s < N; s++) {
    if (R.status[s] === 2) {
      okPairs++;
      const o = core.returnOptions(net, R, s)[0];
      const back = net.trips[o.ti].stops[o.from];
      if (net.stops[back].name !== net.stops[s].name) {
        mismatchPairs++;
        const k = `${net.stops[s].name}→${net.stops[back].name}`;
        const m = mismatch.get(k) || { from: net.stops[s].name, to: net.stops[back].name, m: Math.round(core.dist(net.stops[s].lat, net.stops[s].lon, net.stops[back].lat, net.stops[back].lon)), n: 0 };
        m.n++;
        mismatch.set(k, m);
      }
    } else if (R.status[s] === 1) {
      const name = net.stops[s].name;
      const e = oneway.get(name) || { name, n: 0, noLater: 0, lateOnly: 0 };
      e.n++;
      // 理由: 帰りの便はあるが滞在後には無い／滞在後に出る便はあるが門限に間に合わない
      const need = R.best[s] + BASE.stay;
      const hw = new Map(R.homeStops.map((h) => [h.s, h.walk]));
      let anyAfter = false;
      for (const [s2, w] of [[s, 0], ...net.returnNeighbors[s]]) {
        for (let e2 = net.tsStart[s2]; e2 < net.tsStart[s2 + 1]; e2++) {
          const ti = net.tsTrip[e2], pos = net.tsPos[e2], tr = net.trips[ti];
          if (!act[ti] || tr.dep[pos] - w < need) continue;
          for (let k = pos + 1; k < tr.stops.length; k++) if (hw.has(tr.stops[k])) { anyAfter = true; break; }
        }
      }
      if (anyAfter) e.lateOnly++; else e.noLater++;
      oneway.set(name, e);
    }
  }
}
const mm = [...mismatch.values()].sort((a, b) => b.n - a.n);
fs.writeFileSync(path.join(OUT, 'platform_mismatch.csv'), csv([['alight_stop', 'board_stop', 'distance_m', 'pairs'], ...mm.map((m) => [m.from, m.to, m.m, m.n])]));
report.push('## 帰りののりばが、降りたのりばと違う', '', `既定条件で「行けて帰れる」になった（家・行き先）の組 ${okPairs} のうち ${mismatchPairs}（${Math.round(1000 * mismatchPairs / okPairs) / 10}%）で、最も早い帰りの便が、降りた停留所と違う名前の停留所から出る。多い組:`, '', '| 降りる | 帰りに乗る | 距離 | 組の数 |', '|---|---|---|---|');
for (const m of mm.slice(0, 15)) report.push(`| ${m.from} | ${m.to} | ${m.m}m | ${m.n} |`);
const ow = [...oneway.values()].sort((a, b) => b.n - a.n);
fs.writeFileSync(path.join(OUT, 'oneway_destinations.csv'), csv([['stop', 'homes', 'no_return_after_stay', 'return_after_curfew_only'], ...ow.map((e) => [e.name, e.n, e.noLater, e.lateOnly])]));
report.push('', '## 行けるけど帰れない行き先', '', '既定条件で「行けるが帰れない」になった回数（家の位置の数）が多い行き先。理由は「滞在後に帰りの便が無い」と「滞在後の便はあるが門限に間に合わない」に分けた。', '', '| 行き先 | 家の数 | 滞在後に便なし | 門限に間に合わない |', '|---|---|---|---|');
for (const e of ow.slice(0, 15)) report.push(`| ${e.name} | ${e.n} | ${e.noLater} | ${e.lateOnly} |`);

// 4. 乗りかえの効果
const t1 = scores(Object.assign({}, BASE, { transfers: 1 }));
const gain = net.stops.map((s, i) => ({ name: s.name, base: base[i], t1: t1[i] })).sort((a, b) => (b.t1 - b.base) - (a.t1 - a.base));
report.push('', '## 乗りかえを1回許すと', '', `行き先ゼロ ${baseZero} → ${t1.filter((v) => v === 0).length}、中央値 ${median(base)} → ${median(t1)}。行き先が大きく増える家の位置（停留所名）:`, '');
const seen = new Set();
for (const g of gain) { if (seen.has(g.name)) continue; seen.add(g.name); report.push(`- ${g.name}: ${g.base} → ${g.t1}`); if (seen.size >= 10) break; }
report.push('');
fs.writeFileSync(path.join(OUT, 'report.md'), report.join('\n'));
console.log(JSON.stringify({ baseZero, median: median(base), max: Math.max(...base), okPairs, mismatchPairs, best, worst, t1Zero: t1.filter((v) => v === 0).length, t1Median: median(t1), topMismatch: mm.slice(0, 5), topOneway: ow.slice(0, 5) }, null, 1));
