# Third-party notices

This repository's own code is licensed under Apache-2.0 (see `LICENSE`).
The following materials are used by the application but are **not** covered by it.

## Downloaded at run / build time (not committed)

- **Starlink orbital elements (TLE)** — CelesTrak (<https://celestrak.org>),
  derived from Space-Track / 18th Space Defense Squadron data. Follow CelesTrak's
  usage terms; automated requests are rate-limited.

## Committed in this repository

- **Earth textures** (`web/public/assets/textures/*.jpg`) — derived from the
  [Solar System Scope textures](https://www.solarsystemscope.com/textures/)
  (Earth day / night / clouds / normal / specular maps; based on NASA elevation
  and imagery data, incl. the Blue Marble collection), licensed under
  [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/).
  **Changes made:** downscaled (8K → 4096×2048 / 2K), re-encoded as JPEG, the
  normal map's tilt amplified and renormalized, and the land mask, a constant and
  the cloud map packed into the R/G/B channels of one image
  (`web/scripts/build-textures.mjs`). These modified files are distributed under
  the same CC BY 4.0 terms, not Apache-2.0. Solar System Scope does not endorse this project.

- **Natural Earth 110m coastline and admin-0 boundaries**
  (`web/public/assets/data/ne_110m_*`) — public domain
  (<https://www.naturalearthdata.com/about/terms-of-use/>).

## npm dependencies

Installed from npm and licensed by their authors (MIT unless noted): `three`,
`@react-three/fiber`, `@react-three/drei`, `preact`, `lucide-preact`, `vite`,
`typescript`. See each package's `LICENSE` in `node_modules`.
