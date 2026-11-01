# 同梱の GTFS（八戸圏プリセットの保存版）

GTFSデータリポジトリ（https://gtfs-data.jp/）の API から取得した zip を、加工せずに保存しています。アプリは通常 API から最新版を読み込み、通信できないとき（または URL に `?offline=1` を付けたとき）だけ、この保存版を使います。取得日・有効期間は `manifest.json` にあります。

| ファイル | 提供者 | データ | ライセンス |
|---|---|---|---|
| hachinohe__hachinohe-citybus.zip | 八戸市交通部 | 八戸市営バス | CC BY 4.0 |
| hachinohecity__hachinohe-nango.zip | 八戸市 | 八戸市南郷コミュニティバス | CC BY 4.0 |
| hashikamitown__hashikamibus.zip | 階上町 | 階上町コミュニティバス | CC0 1.0 |
| towadakankodentetsu__toutetsu.zip | 十和田観光電鉄 | 十和田観光電鉄（一般路線） | CC BY 4.0 |

更新: `node tools/bundle-feeds.js YYYY-MM-DD`
