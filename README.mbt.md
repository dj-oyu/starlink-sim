# starlink-sim

SGP4 orbit propagation for the Starlink constellation, compiled to WebAssembly.
See the repository `README.md` for the web app and setup.

The Wasm API (exported from `moon.pkg`) is driven as: `reset_constellation` →
`add_satellite_elements` (per TLE) → `set_observer` → `propagate_constellation(unix_ms)`,
then read results with `get_sat_ecef_*`, `get_sat_status[_quad]` and `get_visible_sat_index`.
