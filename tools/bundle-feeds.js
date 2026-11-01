'use strict';
// 八戸圏プリセットの GTFS を app/data/feeds に保存する（会場のネットが落ちたときの予備・分析の入力）。
// 使い方: node tools/bundle-feeds.js 2026-11-01
const fs = require('fs');
const path = require('path');
const { BUNDLE_DIR, fetchCatalog, fetchFeedZip, metaOf, filesFromZip, core } = require('./gtfs-node');

const PRESET = [
  ['hachinohe', 'hachinohe-citybus'],
  ['hachinohecity', 'hachinohe-nango'],
  ['hashikamitown', 'hashikamibus'],
  ['towadakankodentetsu', 'toutetsu'],
];

(async () => {
  const fetched = process.argv[2];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fetched || '')) throw new Error('取得日を YYYY-MM-DD で渡してください');
  fs.mkdirSync(BUNDLE_DIR, { recursive: true });
  const cat = await fetchCatalog();
  const feeds = [];
  for (const [org, feed] of PRESET) {
    const c = cat.find((x) => x.organization_id === org && x.feed_id === feed);
    if (!c) throw new Error(`カタログにありません: ${org}/${feed}`);
    const buf = await fetchFeedZip(org, feed);
    const file = `${org}__${feed}.zip`;
    fs.writeFileSync(path.join(BUNDLE_DIR, file), buf);
    const files = filesFromZip(buf);
    const net = core.createNetwork();
    const info = core.addFeed(net, files, metaOf(c));
    feeds.push(Object.assign(metaOf(c), { file, fetched, bytes: buf.length, hasTranslations: 'translations.txt' in files, stats: info.stats }));
    console.log(file, buf.length, JSON.stringify(info.stats), info.warnings.join(' / '));
  }
  fs.writeFileSync(path.join(BUNDLE_DIR, 'manifest.json'), JSON.stringify({ fetched, feeds }, null, 2) + '\n');
})().catch((e) => { console.error(e); process.exit(1); });
