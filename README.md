# starlink-sim

MoonBit で書いた SGP4 軌道伝播エンジン(WebAssembly)と、Starlink コンステレーション約1万機をリアルタイムに可視化する Web アプリです。

- **SGP4 エンジン (MoonBit → Wasm)**: TLE の解析、SGP4 伝播、TEME→ECEF 変換、地上局からの可視判定、軌道パス生成。約10,650機を 1 フレーム 2ms 前後で伝播します(Chrome、通常コンパイル時)。
- **Web UI (Preact + react-three-fiber)**: 4K 地球シェーダ、昼夜・雲・海岸線/国境、シェル別表示、衛星検索、地上局(上空通過)、パフォーマンスプロファイラ。
- 軌道計算はすべてローカルで行います。ネットワークは、サーバーが TLE を更新するときにしか使いません(ブラウザは外部に通信しません)。

## 必要なもの

- Node.js 20 以上(開発は v24)と、パッケージマネージャー(**npm または pnpm**。どちらでも動きます)
- [MoonBit toolchain](https://docs.moonbitlang.com)(`moon`)は任意です。未インストールの場合は、リポジトリに同梱の wasm(`web/public/assets/wasm/starlink-sim.wasm`)をそのまま使います。ソースから再ビルドするときに必要です。

## 開発

```sh
cd web

# npm
npm ci            # 依存関係のインストール(package-lock.json)
npm run dev       # 初回は素材を自動取得し、Wasm をビルドして Vite を起動
npm run build     # 本番ビルド
npm run typecheck

# pnpm
pnpm install --frozen-lockfile   # pnpm-lock.yaml
pnpm dev
pnpm build
pnpm typecheck
```

スクリプトは、`pre*` フック(pnpm では既定で動かないことがある)に頼らず、plain node のスクリプトを `&&` でつないでいるため、npm でも pnpm でも同じ動作です。

**ロックファイルは 2 つ**(`web/package-lock.json` と `web/pnpm-lock.yaml`)を管理しています。依存関係を変えたときは、両方を更新してください。

```sh
npm install --package-lock-only && pnpm install --lockfile-only
```

pnpm 10 以降は、依存パッケージのビルドスクリプトを既定でブロックします。`web/pnpm-workspace.yaml` で esbuild の postinstall を許可しているため、`pnpm install` は警告なしで通ります(npm はこのファイルを無視します)。

MoonBit 側だけを操作する場合(リポジトリ直下):

```sh
moon test            # テスト
moon fmt && moon info
```

本番ビルドで実機を確認する場合は `npm run serve:lan`(ビルド後に `vite preview --host --port 4173`)を使います。dev サーバーには `preact/debug` や HMR などのオーバーヘッドがあり、フレームの乱れの原因の切り分けに向きません。

## 外部素材と TLE

### 地球テクスチャ(初回起動時に自動取得)

出典・再配布条件の都合でリポジトリに含めていません(`.gitignore` 済み)。`dev` / `build` の前に `web/scripts/fetch-assets.mjs` が、three.js `r169` の `examples/textures/planets/` から 5 枚を自動で取得します。存在するファイルは再取得しません。

```sh
npm run fetch:assets              # 不足分を取得(pnpm の場合は pnpm fetch:assets)
npm run fetch:assets -- --force   # すべて再取得
```

出典の詳細は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) を参照してください。

### Starlink TLE(サーバーが自動で取得・更新)

TLE は、**サーバー側が一元管理**します。ブラウザは、サーバーの `/assets/data/starlink.tle` を読むだけで、CelesTrak には直接アクセスせず、データの保存もしません(`localStorage` は使いません)。

- 実装は `web/server/tle-sync.mjs` で、Vite のプラグイン(`web/server/vite-plugin-tle.mjs`)として、dev サーバー(`npm run dev` / `dev:lan`)と、プレビューサーバー(`vite preview` / `serve:lan`)に組み込まれます。
- **更新するかどうかは、ファイルのタイムスタンプで判断します**(サーバーの起動時間は見ません)。
  - `starlink.tle` の更新時刻が **6 時間より古い**と、CelesTrak から再取得します。
  - CelesTrak は同じデータの再取得を 2 時間以内は拒否(HTTP 403)するため、隣の `.starlink.tle.attempt` ファイルの更新時刻で、**試行の間隔を 2 時間以上**あけます。失敗した試行も含みます。再起動しても、この間隔は保たれます。
  - 複数のクライアントが同時に接続していても、上流への取得は 1 回にまとまります。
- 起動時と、その後 10 分ごとに、同じ判定(タイムスタンプの確認だけ)を行います。クライアントがいなくても、データは新しく保たれます。
- ファイルがないとき(初回)は、最初のリクエストが取得の完了を待ちます。取得できなければ 503 を返し、クライアントは 15 秒ごとに再試行します。古いファイルがあるときは、それを返しながら、裏で更新します。
- クライアントは、条件付きリクエスト(ETag)で、10 分ごとと、タブが表示されたときに確認します。変更があったときだけ、衛星データを読み込み直します。
- 状態は `/api/tle-status`(JSON)と、アプリの「TLE Data」ダイアログで確認できます。
- 保存先は `web/public/assets/data/` です(環境変数 `TLE_DATA_DIR` で変更できます)。ビルド成果物(`dist`)には含めません。

Vite のサーバー(dev / preview)で動かす構成です。サーバーを使わない静的ホスティングでは、この更新は動かないため、`starlink.tle` を、cron などで更新して配置してください。

```sh
npm test    # サーバー側の同期ロジックのテスト(同時アクセス、タイムスタンプ判定、クールタイム、失敗時の動作)
```

## 構成

| パス | 内容 |
|---|---|
| `sgp4.mbt` `tle.mbt` `time.mbt` `coords.mbt` `constants.mbt` | SGP4、TLE 解析、時刻・座標変換 |
| `starlink-sim.mbt` | Wasm に export する API(コンステレーション状態、可視判定、軌道パス) |
| `moon.pkg` | Wasm の export 一覧 |
| `web/src/wasm/simEngine.ts` | Wasm ブリッジ(TLE の読み込み、バッファ読み出し) |
| `web/server/tle-sync.mjs`, `vite-plugin-tle.mjs` | サーバー側の TLE 同期(タイムスタンプ判定、クールタイム、配信) |
| `web/src/components/` | 3D ビュー、地球、パフォーマンスパネル |

## ライセンス

[Apache License 2.0](LICENSE)。第三者の素材は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) に従います。
