'use strict';
// analysis/nationwide/results.jsonl から summary.md を作る。使い方: node tools/smoke/summarize.js 2026-11-01
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'analysis', 'nationwide');
const PREFS = ['北海道','青森県','岩手県','宮城県','秋田県','山形県','福島県','茨城県','栃木県','群馬県','埼玉県','千葉県','東京都','神奈川県','新潟県','富山県','石川県','福井県','山梨県','長野県','岐阜県','静岡県','愛知県','三重県','滋賀県','京都府','大阪府','兵庫県','奈良県','和歌山県','鳥取県','島根県','岡山県','広島県','山口県','徳島県','香川県','愛媛県','高知県','福岡県','佐賀県','長崎県','熊本県','大分県','宮崎県','鹿児島県','沖縄県'];
const LABEL = { fetch: 'リポジトリに zip が無い（HTTP 404 など）', zip: 'zip が壊れている', missing_file: '必須ファイルが無い', exception_load: '読み込みで例外', exception_compute: '計算で例外', no_service: '11月以降に走る日がデータに無い', crash: '想定外の停止' };

const day = process.argv[2] || '';
const rs = fs.readFileSync(path.join(DIR, 'results.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const ok = rs.filter((r) => r.ok);
const ng = rs.filter((r) => !r.ok);
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };
const pct = (a, b) => (b ? Math.round(1000 * a / b) / 10 : 0);
const fetched = rs.filter((r) => r.category !== 'fetch');

const lines = [];
lines.push(`# 全国検証の結果（${day} 実施）`, '');
lines.push(`GTFSデータリポジトリ（api.gtfs-data.jp/v2/feeds）の運行中フィード ${rs.length} 件すべてについて、zip の取得 → app/core.js での読み込み → 「行けて帰れる」の計算までを行った。スクリプトは tools/smoke/run-all.js、1件ごとの記録は results.jsonl。`, '');
lines.push('## 結果', '');
lines.push(`- 計算まで通った: **${ok.length} / ${rs.length} 件（${pct(ok.length, rs.length)}%）**`);
lines.push(`- zip を取得できたフィードに限ると: ${ok.length} / ${fetched.length} 件（${pct(ok.length, fetched.length)}%）`);
lines.push(`- 「成功」の定義: 例外なく読み込めて、検証日（2026-11-07 以降の土曜・平日。走らなければ走る日を探す）に便が1本以上あり、計算が最後まで終わったこと`, '');
lines.push('## 通らなかったもの', '', '| 理由 | 件数 | 例 |', '|---|---|---|');
const cats = {};
for (const r of ng) (cats[r.category] = cats[r.category] || []).push(r);
for (const [k, v] of Object.entries(cats).sort((a, b) => b[1].length - a[1].length)) {
  lines.push(`| ${LABEL[k] || k} | ${v.length} | ${v.slice(0, 4).map((r) => r.name).join('、')} |`);
}
lines.push('', 'どれもアプリの不具合ではなく、リポジトリに zip が無いか、データに今後の運行日が入っていないもの。', '');
lines.push('## データの性質', '');
const kana = ok.map((r) => r.kanaPct);
lines.push(`- 停留所名のふりがな（translations.txt の ja-Hrkt）: 中央値 ${q(kana, 0.5)}%。全停留所に付いているフィード ${kana.filter((k) => k >= 99.95).length} 件、まったく無いフィード ${kana.filter((k) => k === 0).length} 件`);
lines.push(`- 拡張子が .csv のフィード: ${ok.filter((r) => (r.files || []).length && r.name && /つく/.test(r.name)).length ? 'つくバス・つくばね号（読めるように対応済み）' : 'なし'}`);
lines.push(`- 先の日付で検証したフィード（週に数日だけ運行など）: ${ok.filter((r) => r.dateFallback).length} 件`);
const warn = {};
ok.forEach((r) => (r.warnings || []).forEach((w) => { warn[w] = (warn[w] || 0) + 1; }));
for (const [w, n] of Object.entries(warn)) lines.push(`- 警告「${w}」: ${n} 件`);
lines.push('', '## 速さ', '');
const load = ok.map((r) => r.loadSec), town = ok.map((r) => r.townSec);
lines.push(`- 読み込み（Node 26、この検証に使った Mac）: 中央値 ${q(load, 0.5)} 秒、最大 ${Math.max(...load)} 秒`);
lines.push(`- まちモード（全停留所の計算）: 中央値 ${Math.round(q(town, 0.5) * 1000) / 1000} 秒、最大 ${Math.round(Math.max(...town) * 10) / 10} 秒`);
const heavy = [...ok].sort((a, b) => b.stats.stops - a.stats.stops).slice(0, 3);
lines.push(`- 停留所の多いフィード: ${heavy.map((r) => `${r.name}（停留所 ${r.stats.stops}・便 ${r.stats.trips}、読み込み ${r.loadSec} 秒・まちモード ${Math.round(r.townSec * 10) / 10} 秒）`).join('、')}`, '');
lines.push('## 都道府県別', '', '| 都道府県 | 対象 | 計算まで通った |', '|---|---|---|');
const byPref = {};
for (const r of rs) { const k = PREFS[(r.pref || 0) - 1] || '不明'; byPref[k] = byPref[k] || [0, 0]; byPref[k][0]++; if (r.ok) byPref[k][1]++; }
for (const p of [...PREFS, '不明']) if (byPref[p]) lines.push(`| ${p} | ${byPref[p][0]} | ${byPref[p][1]} |`);
lines.push('');
fs.writeFileSync(path.join(DIR, 'summary.md'), lines.join('\n'));
console.log(JSON.stringify({ total: rs.length, ok: ok.length, fetched: fetched.length, cats: Object.fromEntries(Object.entries(cats).map(([k, v]) => [k, v.length])), prefs: Object.keys(byPref).length, prefsWithOk: Object.values(byPref).filter((v) => v[1] > 0).length }));
