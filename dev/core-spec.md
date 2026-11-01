# core.js の仕様（テストの期待値はここから立てる）

`app/core.js` は、GTFS から「子どもが行けて、門限までに帰れる」バス停を計算する。Node では `require('../app/core.js')` で読み込める。時刻はすべて「その日の0時からの秒」。

## 読み込み
- `createNetwork()` → 空のネットワーク。`addFeed(net, files, meta)` を事業者ごとに呼び、最後に `finalize(net)` を一度呼ぶ。`files` は `{'stops.txt': 文字列, ...}`。
- 必須: stops.txt・trips.txt・stop_times.txt（無ければ例外）。任意: routes.txt・calendar.txt・calendar_dates.txt・frequencies.txt・translations.txt。
- CSV: 先頭の BOM を無視。ダブルクォートで囲んだ値（中のカンマ・改行・`""`）を扱う。改行は LF と CRLF。ヘッダーの前後空白は無視。値の前後空白も ID・時刻では無視する。
- stops: location_type が空か 0 のものだけを停留所として使う（1=駅などは除く）。緯度経度が数でない、または (0,0) の行は除く。
- 停留所の `kana`: translations.txt の language（旧形式は lang）が `ja-Hrkt` の行から取る。新形式は table_name=stops・field_name=stop_name の行で、record_id（stop_id）か field_value（停留所名）で対応づける。旧形式（trans_id, lang, translation）は trans_id が停留所名。
- 時刻: `HH:MM:SS`（24時以降もそのまま秒にする。`25:10:00` = 90600）。arrival_time が空なら departure_time を、逆も同様に使う。両方空の停留所は、同じ便の前後の時刻がわかる停留所から、stop_sequence の並び順で按分して補う（四捨五入）。便の最初・最後で時刻のわからない停留所は捨てる。時刻のわかる停留所が2つ未満の便は捨てる。
- stop_times は便ごとに stop_sequence 昇順に並べる（ファイル内の順番は問わない）。stops.txt にない stop_id を参照する行は捨てる。
- frequencies.txt: (trip_id, start_time, end_time, headway_secs) ごとに、start_time から end_time 未満まで headway_secs 刻みで便を複製する。複製の時刻 = 元の時刻 + (複製の出発時刻 − 元の便の最初の出発時刻)。元の便そのものは数えない。
- 運行日: calendar.txt の曜日（monday〜sunday が 1）と start_date〜end_date の範囲（両端を含む）。calendar_dates.txt の exception_type=1 はその日を追加、2 はその日を除外（除外が優先）。calendar.txt に無い service_id でも calendar_dates.txt の追加日には走る。日付は `YYYY-MM-DD` で渡し、曜日はタイムゾーンに依存しない。

## 計算 `compute(net, homeStops, P, act, opts)`
- `homeStops` = `nearStops(net, lat, lon, walkM)` の結果 `[{s, walk}]`。家から walkM メートル以内の停留所と、そこまでの徒歩秒（距離 ÷ 分速60m、四捨五入）。
- `P = {depart, budget, stay, curfew, transfers}`。`act = activeMask(net, 'YYYY-MM-DD')`。
- **行き**: 家を depart に出て、各家の停留所に depart+walk に着く。そこから、出発時刻が「着いた時刻以上」かつ「depart+budget 以下」の便に乗れる。到着が depart+budget を超える停留所には行けない。transfers=1 のとき、乗りかえ1回まで。乗りかえは、着いた停留所か、そこから150m以内の停留所（徒歩秒を足す）で、着いてから180秒以上あとに出る便に限る。
- **帰り**: 行き先の停留所 s に best[s]（最も早く着く時刻）に着き、stay 秒過ごす。そのあと、s か、s から300m以内の停留所（徒歩秒ぶん早く出る必要がある）から、乗りかえなしで家の停留所のどれかに行き、さらに家まで歩いて、curfew 以下に家に着ける便があれば「帰れる」。
- 返り値: `status[s]`（0=行けない、1=行けるが帰れない、2=行けて帰れる、3=家の停留所）、`ok`（status=2 の数）、`oneway`（status=1 の数）、`best`、`label`（経路）。`opts.countOnly` のときは `{ok, oneway}` だけを返し、結果は通常の呼び出しと同じになる。
- 境界: 便の出発時刻 = 着いた時刻はぎりぎり乗れる。到着 = depart+budget は行ける。家に着く時刻 = curfew は間に合う。帰りの便の出発 = best[s]+stay は乗れる。
- `returnOptions(net, R, s)`: 帰りの便の候補を出発の早い順に返す（同じ出発時刻は1件にまとめる）。各要素 `{ti, from, to, walkTo, walkHome, home}`。
- `townScore(net, i, P, act)`: 停留所 i の位置に家があるとして（walkM = P.walk、乗りかえなし）の ok。
- `poiReach(net, R, pois, home)`: 各施設から400m以内で status=2 の停留所のうち、到着時刻＋徒歩（分速60m、分単位に四捨五入）が最も早いものを選ぶ。同着なら徒歩の短いほう。家から800m以内の施設は除く。施設の種類の優先順（図書館→水族館→博物館・美術館→プール→本屋→映画館→公民館・児童館→体育館・スポーツ施設→公園）、次に到着の早い順に並べる。
