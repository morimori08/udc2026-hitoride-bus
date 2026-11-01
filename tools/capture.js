'use strict';
// 説明資料・動画用の画面を、?demo=1 の自動表示からヘッドレス Chrome で高解像度に撮る。
// 先に app/ を http://localhost:8794 で配信しておく（python3 -m http.server 8794 --directory app）。
// 使い方: node tools/capture.js <出力フォルダ> [light|dark]
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const out = process.argv[2] || path.join(__dirname, '..', 'docs', 'submission', 'img', 'hd');
const theme = process.argv[3] || 'light';
const base = `http://localhost:8794/?demo=1&offline=1&theme=${theme}`;
const card = encodeURIComponent('八戸市美術館');

const SHOTS = [
  ['01_こどもモード結果', base],
  ['02_おでかけカード', `${base}&card=${card}`],
  ['03_元データ表示', `${base}&card=${card}&raw=1`],
  ['04_まちモード', `${base}&mode=town`],
];

fs.mkdirSync(out, { recursive: true });
for (const [name, url] of SHOTS) {
  const file = path.join(out, `${name}.png`);
  execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--window-size=1600,1000', '--force-device-scale-factor=2', '--virtual-time-budget=25000', `--screenshot=${file}`, url], { stdio: 'ignore' });
  console.log(file);
}
