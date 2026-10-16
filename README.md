# starlink-sim

MoonBit で書いた SGP4 軌道伝播エンジン(WebAssembly)と、Starlink コンステレーション約1万機をリアルタイムに可視化する Web アプリです。

- **SGP4 エンジン (MoonBit → Wasm)**: TLE の解析、SGP4 伝播、TEME→ECEF 変換、地上局からの可視判定、軌道パス生成。約10,650機を 1 フレーム 2ms 前後で伝播します(Chrome、通常コンパイル時)。
- **Web UI (Preact + react-three-fiber)**: 4K 地球シェーダ、昼夜・雲・海岸線/国境、シェル別表示、衛星検索、地上局(上空通過)、パフォーマンスプロファイラ。
- 軌道計算はすべてローカルで行います。ネットワークは TLE の更新にしか使いません。

## 必要なもの

- [MoonBit toolchain](https://docs.moonbitlang.com)(`moon`)
- Node.js 20 以上(開発は v24)

## 開発

```sh
cd web
npm install
npm run dev      # 初回は素材を自動取得し、Wasm をビルドして Vite を起動
npm run build    # 本番ビルド
```

### LAN 内のスマートフォン(iPhone など)から見る

```sh
cd web
npm run dev:lan   # vite --host: 0.0.0.0 で待ち受け
```

起動時に表示される `Network:` の URL(例: `http://192.168.1.17:5173/`)を、同じ Wi-Fi のスマートフォンで開きます。つながらない場合は Windows ファイアウォールで Node.js の受信(プライベート/パブリック)を許可してください。開発サーバーは認証なしで LAN に公開されるため、信頼できるネットワークでのみ使ってください。なお HTTP のため、クリップボード API など HTTPS 限定の機能は使えません。

### モバイル(iOS Safari)での性能

iOS Safari(JavaScriptCore)は、この wasm をデスクトップの Chrome より **約 20 倍遅く**実行します(iPhone で全衛星の伝播が約 19ms)。そのため、計算コストが 1 フレームあたり 4ms を超える環境では、衛星を最大 8 分割し、1 フレームに 1 分割だけ更新します(`web/src/wasm/simEngine.ts` の `propagate`)。再生速度が速い(+100x 以上)ときや、時刻を大きく飛ばしたときは、位置のずれを避けるため全機を更新します。

- `?slices=N`(例: `http://…:5173/?slices=4`)で分割数を強制できます(0 または未指定で自動)。
- Perf Stats の「Copy JSON」には、端末情報と実際の分割数(`wasmSlicesPerFrame`)が含まれます。
- Perf Stats の「🧪 GPU Bench」は、端末上の GPU 負荷を測ります(約 40 秒)。Safari には GPU タイマーがないため、描画を連続実行して最後に `readPixels` で完了を待つ方式です。ピクセル比、地球シェーダ(雲・大気・昼夜・モード)、衛星・航跡・通信リンク別のコストと、HUD の `backdrop-filter` の影響(実フレームレート)を比較し、結果をコピーできます。

### GPU モード(遅い端末で自動的に有効)

衛星の位置を GPU の頂点シェーダで外挿する経路です。wasm の SGP4 は「アンカー」(ある時刻の厳密な位置と速度)を低頻度で更新するだけで、毎フレームの JS からの位置の書き込み・アップロード・航跡の計算が不要になります。遅い端末(iPhone など)向けです。

- 外挿は、アンカーの状態を軌道面内で円運動として回転させます(`r(dt) = r0·cos(w·dt) + (v0/w)·sin(w·dt)`、`w = |v0|/|r0|`)。その後 GMST で ECEF に回し、Three.js の軸に変換します。
- 精度(実際の TLE 10,652 機、厳密な伝播との差): アンカーから 60 秒後で平均 20m(最大 59m)、300 秒後で平均 0.49km(最大 1.4km)、600 秒後で平均 2.0km。線形外挿(`p + v·dt`)は 60 秒後で 15km なので、約 300 倍良い値です。
- アンカー更新のサイクルは、通常 30 シミュレーション秒以内です(CPU 側の機能: 可視リスト、スカイプロット、クリック選択の鮮度)。高速再生(+100x 超)では 240 秒まで許容し、そのぶん CPU 側の機能の位置は古くなります。
- 選択中のマーカーや通信リンクの端点は、同じ式の JS 版で外挿するため、GPU が描く衛星とずれません。
- **自動選択**: 起動時に全衛星の伝播を数回測り(デスクトップで約 3ms、iPhone で約 70ms)、1 回あたりの中央値が 4ms を超える端末で自動的に有効になります。デスクトップは従来の経路のままです。URL の `?gpu=1` で強制オン、`?gpu=0` で強制オフにできます。
- Perf Stats の「Copy JSON」に、使われている経路(`gpuPositionPath`)と起動時の計測値(`startupFullPassCalibrationMs`)が含まれます。

MoonBit 側だけを操作する場合(リポジトリ直下):

```sh
moon test            # テスト
moon fmt && moon info
```

本番ビルドで実機を確認する場合は `npm run serve:lan`(ビルド後に `vite preview --host --port 4173`)を使います。dev サーバーには `preact/debug` や HMR などのオーバーヘッドがあり、フレームの乱れの原因の切り分けに向きません。

## 外部素材と TLE(初回起動時に自動取得)

次のファイルは出典・再配布条件の都合でリポジトリに含めていません(`.gitignore` 済み)。`npm run dev` / `npm run build` の前に `web/scripts/fetch-assets.mjs` が自動で取得します。存在するファイルは再取得しません。TLE の取得に失敗してもビルドは失敗せず(CelesTrak の再取得制限に当たることがあります)、アプリが初回の読み込み時に自分で TLE を取得します。

| 素材 | 取得元 |
|---|---|
| 地球テクスチャ 5 枚 (`web/public/assets/textures/`) | three.js `r169` の `examples/textures/planets/` |
| Starlink TLE (`web/public/assets/data/starlink.tle`) | CelesTrak |

```sh
npm run fetch:assets                       # 不足分を取得
npm run fetch:assets -- --force            # すべて再取得
npm run fetch:assets -- --only=tle         # TLE だけ(textures も指定可)
```

出典の詳細は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) を参照してください。

### TLE の更新

Starlink の TLE は数日で劣化するため、次の仕組みで更新します。

- アプリを開いている間、最後の取得から 6 時間以上たっていれば CelesTrak から自動取得します(10 分ごとに判定)。取得した TLE は `localStorage` に保存し、24 時間以内は再読み込みでも再取得しません。
- UI の「TLE Data」から手動取得もできます。
- `npm run dev` / `build` では、TLE ファイルが 24 時間より古ければ再取得します。失敗しても既存ファイルを使い続けます。
- CelesTrak は同じデータの再取得を **2 時間以内は拒否(HTTP 403)** します。連続して実行しないでください。失敗してもシミュレーションのデータは消えません。

## 構成

| パス | 内容 |
|---|---|
| `sgp4.mbt` `tle.mbt` `time.mbt` `coords.mbt` `constants.mbt` | SGP4、TLE 解析、時刻・座標変換 |
| `starlink-sim.mbt` | Wasm に export する API(コンステレーション状態、可視判定、軌道パス) |
| `moon.pkg` | Wasm の export 一覧 |
| `web/src/wasm/simEngine.ts` | Wasm ブリッジ(TLE の読み込み、バッファ読み出し) |
| `web/src/wasm/tleRefresh.ts` | TLE の自動/手動更新 |
| `web/src/components/` | 3D ビュー、地球、パフォーマンスパネル |

## ライセンス

[Apache License 2.0](LICENSE)。第三者の素材は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) に従います。
