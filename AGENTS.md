# StitchIT agent guide

Vanilla JavaScript/WebGL2. `index.html` loads classic scripts in dependency order. Production must work offline from `file://`: no install, server, build step, modules, or external runtime dependencies.

## Efficient workflow

- Read once per task. Start with scoped `rg -n` and short excerpts from owners below; never inventory or dump the repository.
- Exclude generated HTML, backups, and unrelated folders. Reuse evidence already collected.
- Treat `C:\Users\joedo\Downloads\stitch-360-main\stitch-360` as the complete project boundary. There is no project Git repository or relevant project state elsewhere on this system: do not inspect, search, diff, or consider anything outside this folder.
- Batch independent reads/checks; edit sequentially. Delegate only when asked. Prefer canonical paths over wrappers and duplicate helpers.
- Make the smallest complete change. Test behavior and failure paths, not implementation trivia. Avoid speculative abstractions and cleanup.
- Report only the outcome, relevant checks, and real limitations. Stop once the requested behavior is verified.

## Ownership map

- `stitcher.js`: application state and stitch pass. Keep it under 1,000 lines; do not grow `ctx` or `S360.viewerShared`. Modules fetch and own their DOM controls.
- `loaders.js`: source loading, cancellation, and publication. Prepare privately; publish only successful current jobs. Set schematic backgrounds only through its API.
- `source-texture.js`: transactional source, gain, blur, and patch updates. Adopt replacements before release and restore both GPU layers on failure.
- `render-target.js`: owned texture/FBO pairs with `dispose()`. Use it for pass targets; never evict targets still consumed by live composition or little-planet output.
- `panorama-compositor.js`: 2D/export post, decals, and scratch targets. `render-scheduler.js`: coarse frame and independent fine-render scheduling.
- `compare.js`: optional stitched reference texture and Compare controls. The sphere shader renders reference/current halves from one shared camera; drawing remains scoped to the current half.
- `viewer.js`: camera, projection, and lifetime listeners. It samples the raw stitch texture and applies post/decals inline; there is no full-resolution viewer cache.
- `exposure-fusion.js`: streaming reference-guided exposure fusion. `blend.js`: simple frame average (Stack). Grain and color-block cleanup are owned by the cached stitch/copy pass so every consumer sees one processed result.
- `drawing.js`: input sessions, camera/source capture, single-flight projection, and busy state. Brush/Line commit on release, Heal on confirmation; `flush()` precedes export/conversion. Brush: 6-step linear interpolation for smooth strokes. Line: left-drag previews, left-up bakes point, right-click/Enter finishes (1pt=cancel, 2+=finish). Polygon: dual preview from first/last point to cursor, right-click/Enter closes at cursor with fill+outline. Blur Area: brush/polygon mask that censors (blurs) the source content under it — mask patches are re-baked on the main thread from padded source regions with `ctx.filter` blur; Strength slider sets the blur radius as a brush-size ratio; commits through the normal one-Undo path. All sliders always visible (disabled where inapplicable). ESC cancel hint on all tools. `drawSize`/`drawFeather`/`drawOpacity` persist in geometry snapshots via localStorage; CANVAS panel header has Save/Load buttons for drawing settings.
- `source-edit.js`: editable CPU source and one patch-based Undo. Blend into raw pixels and publish via `loaders.replaceEditedSource`, rolling back CPU patches on failure. Preserve calibration/gain; even GPU-merged sources become recoverable CPU images after editing.
- `drawing-projection.js`: tiled projection and sampling. `view-clone.js` owns Heal. `view-warp.js`, `warp-projection.js`, and `warp-gpu.js` own Pull interaction, deformation, preview, and bake.
- `geometry.js`: canonical worker-safe geometry. `seam-analysis.js` owns seam DP; `seam.js` builds proxies. Workers only transport shared kernels.
- `stitch-seam.js`: seam scheduling and texture publication; publishing invalidates the stitch. `reset()` cancels work but keeps the live curve; context loss also drops the dead texture/curve.
- `stitch-decal.js`: decal slots, textures, parameters, controls. Consumers read `decals.bottom/top` directly. Initialize with `{gl,getViewMode,refreshView,scheduleRender,scheduleLiveSave}`; no second accessor interface.
- `settings.js`: persistence, validation, migrations, and labels. `stitch-ui.js` owns listeners. Slider behavior belongs in `sliderMap` policies.
- `schematic.js`: lens preview, WB, and background. `lp-modal.js`: owned disposable output with projection type selector (equidistant/stereographic/orthographic via `u_projType`), zenith/nadir center toggle (`u_center`), and crop up to 150%. Check `image.js`, `exporter.js`, and `webgl-utils.js` before adding helpers.

HD selects 2× Lanczos source preparation for subsequent loads, before registration and fusion. Render/export dimensions use the prepared source directly; never multiply them by HD again.

## Non-negotiable invariants

- Projection must match between the sphere shader, CPU kernels, and independent `referenceProjection` test oracle: `r(theta)=tan(s*theta)/tan(s*fov/2)`, with `s=1` rectilinear, `0.5` stereographic, `0.05` near-equidistant. Mask directions beyond the antipode; preserve orientation conventions.
- Drawing works only in main 3D views, for stitched and OO sources. Edits permanently enter the source, with one Undo. Brush/Line commit on pointer-up; Heal commits on confirmation. Pull and Heal lock zoom for the captured session. Keep busy status visible through the updated frame; 2D tools remain blocked.
- Large images are normal (for example 13824×6912). Preserve sparse/tiled work, yielding fallbacks, patch uploads, local blur halos, target reuse, cancellation, and latest-job-wins behavior. Never replace a small edit with full-image projection/upload.
- Width/Height/Angle L/R use 0.05 steps. Signed Seam Shift supports both lens priorities. Keep lens transforms consistent across shader, inverse projection, seam analysis, and schematic.
- Geometry, seam, and edits call `markStitchDirty()`. Stitch caching includes dimensions, dirty state, and diagnostic variant; every restitch increments `contentRevision`, also used by the luminance cache.
- Exposure Fusion operates on processed LDR inputs: use robust reference-relative normalization and local rejection, retain the reference as an anchor, and keep tone compression restrained. Detail combines coherent luminance substitution with an edge-aware final denoise/detail stage rather than passing RGB noise; Recovered Color controls low-frequency alternate chroma; Exposure Balance directly controls clipped-region replacement through 0–200% with the former maximum at 100%. Stack remains equal-weight and bypasses fusion tone finishing.
- Clean export and 3D suppress diagnostics. Conversion retains committed edits but excludes post-processing/live decals to avoid double application.
- Context loss cancels work and drops dead GPU resources; restoration preserves CPU source, edits, and camera. Unedited consumed GPU-only merge results still need reloading/remerging.
- GPU allocations have one owner and one disposal path. Prepare candidates transactionally. Workers use shared `globalThis.S360` kernels via `importScripts`; never duplicate math or add copy-sync/version validators. `file://` uses the same main-thread fallback.
- Use narrow module ownership and `init(deps)`. Put slider policies on `sliderMap` entries; value formatting belongs to settings. Comments describe current ownership/contracts, not refactor history.

## Validation: choose the narrowest sufficient set

Choose checks by the changed behavior; avoid running overlapping suites without a reason.

- Any code change: `node dev-regression.cjs` (JavaScript parsing plus 25 deterministic checks). Documentation-only changes need content review, not runtime tests.
- Rendering, Exposure Fusion, source, or drawing changes: run `node dev-smoke.js regression`, open `http://127.0.0.1:8139/dev-regression.html?drawing`, and verify the page result. GPU claims require this real-browser check; parser or GL mocks are insufficient.
- Add `&workers` only for native-worker changes, `&large` only for representative 13824×6912 performance work, or `&status` for the fallback busy indicator. Use plain smoke for startup and `deep` for load/render/export.
- Compare pixels when changing orientation, projection, readback, Undo/rollback, or rendering paths. For performance work, report projection, GPU-update, and end-to-end timing separately.

Run one server at a time. Harness pages are generated from `index.html`; never edit them. Read the page result or `%TEMP%/s360-smoke-results.txt`, stop the server, and remove only test artifacts you created. Never commit generated pages, `_probe*` files, ad-hoc logs, or `require("fs")` debug payloads.
