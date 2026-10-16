# Third-party notices

This repository's own code is licensed under Apache-2.0 (see `LICENSE`).
The following materials are used by the application but are **not** covered by it.

## Downloaded at setup time (not committed)

Fetched by `web/scripts/fetch-assets.mjs`; see `README.md`.

- **Earth textures** (`earth_day_4096.jpg`, `earth_night_4096.jpg`,
  `earth_bump_roughness_clouds_4096.jpg`, `earth_normal_2048.jpg`,
  `earth_specular_2048.jpg`) — obtained from the three.js repository
  (<https://github.com/mrdoob/three.js>, tag `r169`, `examples/textures/planets/`),
  which is distributed under the MIT License. The upstream repository does not
  state the origin or license of each individual texture, so check the terms
  yourself before redistributing them or using them commercially.
- **Starlink orbital elements (TLE)** — CelesTrak (<https://celestrak.org>),
  derived from Space-Track / 18th Space Defense Squadron data. Follow CelesTrak's
  usage terms; automated requests are rate-limited.

## Committed in this repository

- **Natural Earth 110m coastline and admin-0 boundaries**
  (`web/public/assets/data/ne_110m_*`) — public domain
  (<https://www.naturalearthdata.com/about/terms-of-use/>).

## npm dependencies

Installed from npm and licensed by their authors (MIT unless noted): `three`,
`@react-three/fiber`, `@react-three/drei`, `preact`, `lucide-preact`, `vite`,
`typescript`. See each package's `LICENSE` in `node_modules`.
