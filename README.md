This project would not exist without inspiration from https://github.com/sanriomisintaro/stitch-360

You can support me here, in case you would like to: https://buymeacoffee.com/some9000

# StitchIT

Browser-based dual-fisheye to equirectangular 360° stitcher. Processing is local: images are not uploaded to a server. WebGL2 handles the rendering pipeline, while registration, seam analysis, editing, and compatibility fallbacks also use browser workers or the main thread.

<img width="3770" height="1804" alt="2026-08-30 13 25 52  6552da82205f" src="https://github.com/user-attachments/assets/7e9ce939-6778-4039-9d2b-941a745ec941" />


## What it does

StitchIT takes dual-fisheye source images from 360° cameras and produces stitched equirectangular panoramas, entirely in the browser. No server, no upload, no install. You can also exposure-fuse or stack already stitched images.

<img width="3770" height="1804" alt="2026-08-30 13 27 39  3b8ca7e2de80" src="https://github.com/user-attachments/assets/b3235320-f2ef-40b8-b439-72f2cc423762" />


## Features

- **Dual-fisheye to equirect** - Content-aware seam detection and automatic colour balancing, with manual lens-geometry controls
- **Exposure fusion** - Reference-guided blending of useful detail and unclipped regions from aligned photographs
- **Frame blending** - Stack multiple captures for noise reduction
- **Noise cleanup** - Separate edge-aware controls for fine grain and yellow/cyan JPEG color blocks
- **Post-processing** - Exposure, gamma, contrast, saturation, sharpening, and white balance adjustments
- **Zenith and nadir decals** - Place and rotate images at the top or bottom of the panorama
- **3D preview** - View your panorama in a real-time 3D viewer, directly in the browser
- **Synchronized comparison** - Load a finished 2:1 panorama beside the current result with shared pan, pitch, projection, and zoom
- **Source editing** - Brush, line, heal/clone, and lens-warp tools in the 3D view, with one-step Undo
- **Stitched-image workflows** - Open, exposure-fuse, or stack existing equirectangular panoramas
- **Lens profiles** - Import and export camera/lens calibration as JSON
- **Export** - PNG or JPG with embedded XMP metadata for 360° viewers
- **GPU-accelerated** - WebGL shaders handle stitching, blending, and filtering at full resolution

<img width="3770" height="1804" alt="2026-08-30 13 30 05  c430bfa9ff50" src="https://github.com/user-attachments/assets/46442796-6180-416f-bc0d-4bd474ac3962" />

## Getting started

1. Open `index.html` in a modern browser (Chrome, Firefox, Edge)
2. Click **Open OO** and select your dual-fisheye source image
3. Adjust lens parameters (capture edge, radius, lens centres, width/height, angle, and seam) if needed
4. Click **Export JPG (XMP)** to save your stitched panorama

That's it.

## Controls

| Button | What it does |
|--------|-------------|
| **Open OO** | Load a dual-fisheye source image |
| **Exposure Fusion OO** | Blend the best-exposed detail from multiple aligned photographs before stitching |
| **Merge OO** | Stack multiple frames for noise reduction, then stitch |
| **Stitched** | Load an already-stitched equirectangular panorama (skips alignment) |
| **HD** | Toggle 2x upscaling for higher resolution output |
| **3D** | Switch between 2D equirectangular and 3D spherical preview |
| **Compare** | Load a stitched panorama as a synchronized 3D reference beside the current result. Click again to close it |
| **Export JPG (XMP)** | Export the stitched panorama as a JPG with Google Photo Sphere XMP metadata |
| **Export PNG** | Export the stitched panorama as a lossless PNG |
| **Export Profile** | Export the current lens calibration as a JSON file |
| **Import Profile** | Import a lens calibration JSON file |
| **Add bottom / Add top** | Add watermark decals at the nadir (bottom) or zenith (top) of the panorama |

**HD applies to images loaded after the toggle is changed.** It does not reprocess a source that is already open.

- Double-click the result to toggle between 2D and 3D view
- Drag to pan in 3D view
- Scroll to zoom in 3D view
- In Compare mode, drag or zoom either half; editing tools remain on the right/current half

**Most sliders and controls have tooltips - hover over any control to see what it does.**

## Requirements

- A modern browser with WebGL2 support
- No server required - runs entirely from a local file or any static host

## Tutorial

### 1. Basic stitch

1. Open `index.html` in your browser or go to [stitchit-smoky.vercel.app](https://stitchit-smoky.vercel.app)
2. Click **Open OO** and select your dual-fisheye image
3. The image loads and stitches automatically - you'll see the result on the canvas
4. If the stitch looks off, tweak the lens controls in the sidebar:
   - **Outer Margin** - adjusts the usable capture edge beyond the nominal 180° ring
   - **Radius** - adjusts the nominal 180° lens ring
   - **Center L / Center R** - nudges each lens horizontally if the optical center isn't perfectly aligned
   - **Seam Width** - controls how wide the blend zone is at the stitch line

When you're happy, click **Export JPG (XMP)** or **Export PNG** to save

### 2. Exposure fusion

Exposure fusion selects trustworthy detail and usable shadow/highlight information from aligned photographs while keeping a balanced reference frame as the colour and brightness anchor. It directly produces a display-ready image without constructing an HDR radiance map.

1. Click **Exposure Fusion OO** and select two or more exposures
2. The app aligns and fuses them into a display-ready source, then stitches as normal
3. Adjust **Contrast**, **Saturation**, and **Well Exposed** to change the three quality measures
4. Export as usual

### 3. Frame stacking

For reducing noise by averaging multiple captures:

1. Click **Merge OO** and select your frames
2. They'll be aligned and blended into a single cleaner image
3. More frames = less noise

### 4. Post-processing

The **Processing** panel has all your adjustments:

| Control | What it does |
|---------|-------------|
| **Exposure** | Brighten or darken the image |
| **Gamma** | Adjust midtone response |
| **Contrast** | Stretch or compress the tonal range around mid-grey |
| **Saturation** | Boost or reduce colour intensity |
| **Sharpen** | Apply unsharp masking for crisper detail |
| **Temperature** | Warm or cool the white balance |

Toggle all processing on/off with the **ON / OFF** button. **Save** and **Load** store one processing preset in this browser's local storage; they do not create or open a file. Camera profiles use the separate file-based **Export Profile** and **Import Profile** controls.

The separate **Preprocessing** panel operates before grading and is included in every clean render, export, conversion, and 3D view:

| Control | What it does |
|---------|-------------|
| **Grain** | Reduces fine luminance noise with a small edge-aware kernel |
| **Color blocks** | Suppresses yellow/cyan JPEG blocks and coarse color noise, especially in gray areas |

### 5. Zenith / nadir decals

You can add decals at the bottom (nadir) or top (zenith) of the panorama. A bottom decal can cover a tripod or the photographer:

1. Click **Add bottom** or **Add top** in the **Watermark** section and select your decal image
2. Use **Size** and **Rotation** sliders to position it
3. Export with **Export JPG (XMP)** - the decal is baked into the output

### 6. 3D preview

1. Click **3D** in the top-right corner of the canvas
2. Drag to pan around the panorama
3. Scroll to zoom in and out
4. Click **3D** again (or double-click the canvas) to return to the flat view

Double-clicking the flat panorama enters 3D and aims at the selected direction; double-clicking in 3D returns to the flat view.

### 7. Lens profiles

If you're stitching the same camera repeatedly:

1. Dial in your lens settings (outer margin, radius, centres, width/height, angle, and roll)
2. Click **Export Profile** to save them as a JSON file
3. Next time, click **Import Profile** to load your saved settings instantly

### 8. Auto-alignment tools

The app includes intelligent tools to automatically align your lenses:

- **Auto Alignment** - Uses structural patch matching to estimate center positions, zoom levels, and rotation angles
- **Auto Geometry** - Resets alignment then compares structural patches around both fisheye boundaries to estimate Radius, Outer Margin, and Seam Width
- **Improve Geometry** - Refines Radius and Outer Margin within 1.5% of current values while preserving alignment

### 9. Horizon level

- **Level Horizon** - Analyzes long edges across the full panorama and rotates the sphere to make the best-supported horizon level
- **Reset Horizon** - Resets Horizon Pitch and Horizon Roll to zero
- **Manual Horizon** - Draw a vertical line in the 3D view, then another after the automatic 180° turn

### 10. Auto focus

- **Auto Focus** - Click a region that should be sharp (text, edges, patterns) to automatically estimate the optimal blur radius and focus recovery amount

### 11. Seam tools

- **Seam Highlight** - Click to toggle display of the seam blend zone in the stitched output
- **Auto Seam** - Automatically adjust all eight lens alignment sliders to minimize color discontinuity across the seam

### 12. Snapshot controls

The app supports saving and loading various presets:

- **Save Geometry / Load Geometry** - Save/load current lens geometry
- **Save Alignment / Load Alignment** - Save/load current lens alignment values
- **Save Exposure Fusion / Load Exposure Fusion** - Save/load exposure fusion settings
- **Save Processing / Load Processing** - Save/load post-processing settings
- **Save Canvas / Load Canvas** - Save/load drawing settings and canvas state

### 13. Watermark controls

- **Add bottom / Add top** - Load watermark images to overlay on the nadir (bottom) or zenith (top) of the panorama
- **Remove** - Remove loaded watermarks
- **Size / Rotation** - Adjust watermark decal size and rotation angle
- **Save / Load** - Save/load watermark settings

### 14. Processing controls

The **Processing** panel includes these adjustments (toggle all with ON/OFF button):

| Control | What it does |
|---------|-------------|
| **Exposure** | Brighten or darken the image |
| **Gamma** | Adjust midtone response |
| **Contrast** | Stretch or compress the tonal range around mid-grey |
| **Saturation** | Boost or reduce colour intensity |
| **Sharpen** | Apply unsharp masking for crisper detail |
| **Temperature** | Warm or cool the white balance |
| **Clarity** | Boost mid-contrast for perceived sharpness |

### 15. Mirror 3D

- **Mirror 3D** - Mirror the 3D spherical view horizontally (3D view preference, not lens geometry)

## Architecture and Ownership

StitchIT follows a modular architecture where each module owns specific functionality to maintain clear separation of concerns. This ownership structure keeps the codebase maintainable and prevents duplication.

### Core Ownership Map

- **stitcher.js** - Application state coordination and the main stitch GPU pass. Manages the `ctx` interface that connects all modules (but doesn't own DOM elements)
- **loaders.js** - Source loading, job cancellation, and publication. Prepares decoded/merged images privately and publishes only successful current jobs
- **source-texture.js** - Transactional source handling including texture upload, gain adjustment, and blur operations. Uses adoption before release with GPU resource disposal on failure
- **render-target.js** - Creates explicitly owned framebuffer/texture pairs with `dispose()`. Used for pass targets to avoid allocation boilerplate
- **panorama-compositor.js** - Optional post-processing and active decals for 2D preview and equirectangular export. Owns scratch targets
- **render-scheduler.js** - Coarse animation-frame coalescing and independent fine-render debouncing. `cancel()` clears both; `cancelFine()` cancels only refinement
- **viewer.js** - Camera state management and lifetime listeners. Samples the raw stitch texture and applies post-processing/decals inline (no full-resolution viewer cache)
- **exposure-fusion.js** - Streaming reference-guided exposure fusion. Blends coherent luminance substitution with edge-aware detail stage
- **blend.js** - Simple frame averaging (Stack). Grain and color-block cleanup owned by the cached stitch/copy pass
- **drawing.js** - Input sessions, camera/source capture, and worker orchestration. Brush/Line commit on release; Heal commits on confirmation; `flush()` precedes export/conversion
- **source-edit.js** - Editable CPU source and one patch-based Undo. Blends projected patches into raw source pixels and publishes via loaders
- **drawing-projection.js** - Tiled projection and sampling for stitched and OO sources. Shared by bake/worker.js with same generator
- **view-clone.js** - Two-step view-space clone/heal tool (mark, pick source, tone match, multiband blend)
- **view-warp.js**, **warp-projection.js**, **warp-gpu.js** - Pull interaction, deformation, preview, and bake for lens-warp tools
- **geometry.js** - Canonical worker-safe geometry math (`rotateAroundAxis`, `lensBasis`, `sourcePoint`, `sampleBilinear`, `distanceTransformQuadratic`) published on `globalThis.S360`
- **seam-analysis.js** - Pure content-aware seam DP kernel (`analyzeSeam` over a CPU proxy)
- **seam.js** - Builds proxies and main-thread wrapper for seam analysis
- **seam-worker.js** - Thin transport for seam analysis worker
- **stitch-seam.js** - Seam scheduling and texture publication; publishing invalidates the stitch. `reset()` cancels work but keeps live curve
- **stitch-decal.js** - Nadir/zenith decal slots, parameters, textures, and controls. Consumers read `decals.bottom/top` directly
- **settings.js** - Settings persistence, validation, migrations, and labels. Owns `writeSlot`/`readSlot` snapshot primitives
- **schematic.js** - Lens preview, white-balance eyedropper, WB_LUT, and decoded schematic background reference
- **lp-modal.js** - Owned disposable output with projection type selector (equidistant/stereographic/orthographic) and zenith/nadir center toggle
- **stitch-ui.js** - Control listeners. Receives `ctx` plus only pipeline entries that are not on ctx
- **ui-chrome.js** - Passive UI chrome: tooltips, welcome overlay, resize, loading overlay, and actions visibility
- **manual-horizon.js** - Manual horizon drawing tool for rotating the sphere
- **horizon-leveling.js** - Automatic horizon leveling analysis
- **lens-alignment.js** - Auto-alignment tool using structural patch matching
- **lens-alignment-kernel.js** - Pure kernel for lens alignment math
- **lens-geometry-kernel.js** - Pure kernel for lens geometry calculations
- **focus-recovery.js** - Automatic focus restoration sharpening
- **warp-projection.js** - Warp projection calculations
- **view-warp.js** - View warping for interaction
- **warp-gpu.js** - GPU implementation of warp operations
- **auto-warp.js** - Auto-warp analysis and application
- **compare.js** - Synchronized comparison between stitched and OO sources
- **exporter.js** - Export functionality for PNG/JPG with XMP metadata
- **image.js** - Image loading and preparation
- **render-target.js** - Target management
- **webgl-utils.js** - WebGL utilities and helpers
- **stitcher.js** - Main application state and stitching pipeline
- **dev-smoke.js** - Browser harness for testing
- **dev-regression.cjs** - Deterministic regression tests in Node

### Key Design Principles

These ownership guards prevent code duplication and maintain module independence:

- Give each module narrow `init(deps)` ownership with DOM elements owned in closure
- Decompose instead of forwarding - if a module reads/writes a shared value more than 3 ways, it should own that state
- Use one canonical path - check whether existing code already owns the job before adding utilities
- Keep module top-of-file comments stating ownership and `init` contract, not refactor history
- Never commit debug scratch files (`_probe*.js`, `_probe*.txt`) or `require("fs")` debug payloads

### Non-negotiable invariants

- Projection must match between sphere shader, CPU kernels, and independent `referenceProjection` test oracle: `r(theta)=tan(s*theta)/tan(s*fov/2)` with `s=1` rectilinear, `0.5` stereographic, `0.05` near-equidistant
- Drawing works only in main 3D views for stitched and OO sources with one-step Undo
- Large images (e.g., 13824×6912) preserve sparse/tiled work with fallbacks, cancellation, and latest-job-wins behavior
- Geometry, seam, and edits call `markStitchDirty()`; stitch caching includes dimensions, dirty state, and diagnostic variant
- Exposure Fusion operates on processed LDR inputs with robust reference-relative normalization
- Clean export and 3D suppress diagnostics; conversion retains committed edits but excludes post-processing/live decals
- Context loss cancels work and drops dead GPU resources; restoration preserves CPU source, edits, and camera

### Validation

Choose the narrowest sufficient set of checks for the changed behavior:

- Any code change: `node dev-regression.cjs` (35 deterministic checks)
- Rendering, Exposure Fusion, source, or drawing changes: run `node dev-smoke.js regression` with browser harness
- Add `&workers` for native-worker changes, `&large` for representative 13824×6912 performance work
- Compare pixels when changing orientation, projection, readback, Undo/rollback, or rendering paths

Run one server at a time. Harness pages are generated from `index.html`; never edit generated HTML. Reports appear at page bottom and are appended to `%TEMP%/s360-smoke-results.txt`.

### Development workflow

- Read once per task. Start with scoped searches and short excerpts from owners; never inventory or dump the repository
- Exclude generated HTML, backups, and unrelated folders. Reuse evidence already collected
- Batch independent reads/checks; edit sequentially. Delegate only when asked
- Make the smallest complete change. Test behavior and failure paths, not implementation trivia
- Report only the outcome, relevant checks, and real limitations

## Development

### Commands

There is nothing to install or build — the app runs offline from `file://`.
The npm scripts below are shorthand for the dev tools and have no dependencies
(`npm test` is the only one you need for day-to-day work):

| Command | What it runs |
|---------|-------------|
| `npm test` | `node dev-regression.cjs` — deterministic Node checks |
| `npm run smoke` | `node dev-smoke.js regression` — real-browser harness |
| `npm run smoke:plain` / `npm run smoke:deep` | plain / deep smoke pages |

Extra smoke flags go after the script, e.g. `node dev-smoke.js regression &workers &large`.

### Deterministic regression checks

`npm test` (or `node dev-regression.cjs`) runs deterministic JavaScript-only checks in Node. It stubs DOM,
WebGL, and worker APIs so every path is deterministic. No browser or server
required. Use this for fast iteration on core logic:

- Projection math and lens inverse round-trips
- Source-edit patch generation and sparse warp evaluation
- Seam analysis and registration
- UI handler wiring (Export/Import Profile, Load Geo)

### Browser testing status

`dev-smoke.js` generates the browser harness pages. Use its regression mode for
real WebGL2 coverage of loading, 2D/3D rendering, editing, fusion/stacking,
context recovery, and PNG/JPEG export.
