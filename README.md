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

### 地球テクスチャ(リポジトリに同梱)

[Solar System Scope](https://www.solarsystemscope.com/textures/) のテクスチャ(CC BY 4.0、NASA Blue Marble 等が元)を縮小・再エンコード・チャンネル合成した物を `web/public/assets/textures/` にコミットしています。これらのファイルは Apache-2.0 ではなく CC BY 4.0 に従います(表示は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) とアプリ内の TLE ダイアログ)。再生成は `npm run build:textures`(`web/scripts/build-textures.mjs`、ネットワーク必須)。

### GitHub Pages

`.github/workflows/pages.yml` が `main` への push と 6 時間ごとに、CelesTrak から TLE を 1 回取得してビルドし、公開します(リポジトリの Settings → Pages → Source を「GitHub Actions」にしてください)。静的ホスティングなのでサーバー側の TLE 自動更新は動かず、TLE はビルド時点のスナップショットです。サブパス配信のため `BASE_PATH` を Vite の `base` に渡しています。

### Starlink TLE(サーバーが自動で取得・更新)

TLE は、**サーバー側が一元管理**します。ブラウザは、サーバーの `/assets/data/starlink.tle` を読むだけで、CelesTrak には直接アクセスせず、データの保存もしません(`localStorage` は使いません)。

- 実装は `web/server/tle-sync.mjs` で、Vite のプラグイン(`web/server/vite-plugin-tle.mjs`)として、dev サーバー(`npm run dev` / `dev:lan`)と、プレビューサーバー(`vite preview` / `serve:lan`)に組み込まれます。
- **更新するかどうかは、データ自身のタイムスタンプ(TLE のエポック)で判断します**(サーバーの起動時間も、ファイルの更新時刻も見ません)。
  - データの古さは、ファイル内の**最も新しいエポック**(1 行目の 19〜32 桁目)の古さです。最古や中央値は、休止・軌道離脱した衛星の古いエポックに引っ張られるので使いません。ファイルをコピー・復元しても、古いデータが新しく見えることはありません。
  - 最も新しいエポックが **12 時間より古い**と、CelesTrak から再取得します(実データでは、ダウンロード直後でも最新エポックが約 4 時間前のため、これより短いと更新を要求し続けます)。
  - CelesTrak は同じデータの再取得を 2 時間以内は拒否(HTTP 403)するため、隣の `.starlink.tle.attempt` ファイルの更新時刻で、**試行の間隔を 2 時間以上**あけます。失敗した試行も含みます。再起動しても、この間隔は保たれます。
  - ダウンロードしたデータの最新エポックが、手元のものより古い場合は、置き換えません。
  - 複数のクライアントが同時に接続していても、上流への取得は 1 回にまとまります。
- 起動時と、その後 10 分ごとに、同じ判定を行います。クライアントがいなくても、データは新しく保たれます。
- ファイルがないとき(初回)は、最初のリクエストが取得の完了を待ちます。取得できなければ 503 を返し、クライアントは 15 秒ごとに再試行します。古いファイルがあるときは、それを返しながら、裏で更新します。
- クライアントは、条件付きリクエスト(ETag)で、10 分ごとと、タブが表示されたときに確認します。変更があったときだけ、衛星データを読み込み直します。
- 状態は `/api/tle-status`(JSON)と、アプリの「TLE Data」ダイアログで確認できます。
- 保存先は `web/public/assets/data/` です(環境変数 `TLE_DATA_DIR` で変更できます)。ビルド成果物(`dist`)には含めません。

Vite のサーバー(dev / preview)で動かす構成です。サーバーを使わない静的ホスティングでは、この更新は動かないため、`starlink.tle` を、cron などで更新して配置してください。

```sh
npm test    # サーバー側の同期ロジックのテスト(エポック判定、同時アクセス、クールタイム、失敗時の動作)
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
