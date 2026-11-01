'use strict';
// Node から GTFS を読み込む補助（テスト・全国検証・分析で共有する）。依存なし。
const fs = require('fs');
const path = require('path');
const { unzip } = require('./unzip');
const core = require('../app/core.js');

const API = 'https://api.gtfs-data.jp/v2';
const BUNDLE_DIR = path.join(__dirname, '..', 'app', 'data', 'feeds');

function filesFromZip(buf) {
  const files = {};
  for (const [name, data] of Object.entries(unzip(buf))) {
    if (!data || name.startsWith('__MACOSX/')) continue;
    const base = name.split('/').pop();
    if (core.GTFS_FILES.includes(base) && !(base in files)) files[base] = core.decodeText(data);
  }
  return files;
}

async function fetchCatalog() {
  const j = await (await fetch(`${API}/feeds`)).json();
  return j.body;
}

async function fetchFeedZip(org, feed, timeoutMs = 90000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}/organizations/${org}/feeds/${feed}/files/feed.zip?rid=current`, { signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

function metaOf(c) {
  return {
    org: c.organization_id, feed: c.feed_id, name: c.feed_name, orgName: c.organization_name,
    license: c.feed_license, licenseUrl: c.feed_license_url, start: c.latest_feed_start_date, end: c.latest_feed_end_date,
  };
}

// app/data/feeds の同梱データ（八戸圏）からネットワークを組む
function loadBundled(dir = BUNDLE_DIR) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const net = core.createNetwork();
  for (const m of manifest.feeds) core.addFeed(net, filesFromZip(fs.readFileSync(path.join(dir, m.file))), m);
  return core.finalize(net);
}

module.exports = { API, BUNDLE_DIR, filesFromZip, fetchCatalog, fetchFeedZip, metaOf, loadBundled, core };
