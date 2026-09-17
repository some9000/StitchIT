This project would not exist without inspiration from https://github.com/sanriomisintaro/stitch-360

You can support me here, in case you would like to: https://buymeacoffee.com/some9000

# StitchIT

Browser-based dual-fisheye to equirectangular 360° stitcher. Processing is local: images are not uploaded to a server. WebGL2 handles the rendering pipeline, while registration, seam analysis, editing, and compatibility fallbacks also use browser workers or the main thread.

<img width="3770" height="1804" alt="2026-09-17 10 52 08  3e3b973147cf" src="https://github.com/user-attachments/assets/bcbe93ea-fef8-471c-b487-8436441b717b" />

## What it does

StitchIT takes dual-fisheye source images from 360° cameras and produces stitched equirectangular panoramas, entirely in the browser. No server, no upload, no install. You can also exposure-fuse or stack already stitched images.

<img width="3770" height="1804" alt="2026-09-17 10 59 10 stitchit-smoky vercel app f7672af72b66" src="https://github.com/user-attachments/assets/a7cf0596-9806-43f9-9413-3be8ebf780b6" />

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

<img width="3770" height="1804" alt="2026-09-17 11 04 17  52ec6064b561" src="https://github.com/user-attachments/assets/8a8b6129-d822-43fa-a4dc-cac6b0a15640" />

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
