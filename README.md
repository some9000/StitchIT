This project would not exist without inspiration from https://github.com/sanriomisintaro/stitch-360

You can support me here, in case you would like to: https://buymeacoffee.com/some9000

# StitchIT

Browser-based dual-fisheye to equirectangular 360° stitcher. Everything runs on the GPU - no image ever leaves your machine.

<img width="3770" height="1804" alt="2026-08-30 13 25 52  6552da82205f" src="https://github.com/user-attachments/assets/7e9ce939-6778-4039-9d2b-941a745ec941" />


## What it does

StitchIT takes dual-fisheye source images from 360° cameras and produces stitched equirectangular panoramas, entirely in the browser. No server, no upload, no install. You can also load already stitched images to (HDR) merge them and/or adjust the appearance.

<img width="3770" height="1804" alt="2026-08-30 13 27 39  3b8ca7e2de80" src="https://github.com/user-attachments/assets/b3235320-f2ef-40b8-b439-72f2cc423762" />


## Features

- **Dual-fisheye to equirect** - Automatic seam detection, colour balancing, and alignment
- **HDR merge** - Merge multiple exposures into a single HDR-ready panorama
- **Frame blending** - Stack multiple captures for noise reduction
- **Post-processing** - Exposure, gamma, contrast, saturation, sharpening, and white balance adjustments
- **Watermark / nadir decal** - Place and rotate a decal to cover the tripod hole
- **3D preview** - View your panorama in a real-time 3D viewer, directly in the browser
- **Lens profiles** - Import and export camera/lens calibration as JSON
- **Export** - PNG or JPG with embedded XMP metadata for 360° viewers
- **GPU-accelerated** - WebGL shaders handle stitching, blending, and filtering at full resolution

<img width="3770" height="1804" alt="2026-08-30 13 30 05  c430bfa9ff50" src="https://github.com/user-attachments/assets/46442796-6180-416f-bc0d-4bd474ac3962" />

## Getting started

1. Open `index.html` in a modern browser (Chrome, Firefox, Edge)
2. Click **Open OO** and select your dual-fisheye source image
3. Adjust lens parameters (FOV, radius, center) if needed
4. Click **Export JPG (XMP)** to save your stitched panorama

That's it.

## Controls

| Button | What it does |
|---|---|
| **Open OO** | Load a dual-fisheye source image |
| **HDR Merge OO** | Merge multiple exposures before stitching |
| **Merge OO** | Stack multiple frames for noise reduction |
| **Stitched** | Open an already-stitched equirectangular image (skips alignment) |
| **HD** | Toggle 2x upscaling for higher resolution output |
| **3D** | Switch between 2D canvas and 3D equirectangular preview |

- Double-click the result to toggle between 2D and 3D view
- Drag to pan in 3D view
- Scroll to zoom in 3D view

**Most sliders and controls have tooltips - hover over any control to see what it does.**

## Requirements

- A modern browser with WebGL support
- No server required - runs entirely from a local file or any static host

## Tutorial

### 1. Basic stitch

1. Open `index.html` in your browser or go to stitchit-smoky.vercel.app
2. Click **Open OO** and select your dual-fisheye image
3. The image loads and stitches automatically - you'll see the result on the canvas
4. If the stitch looks off, tweak the lens controls in the sidebar:
   - **FOV** - adjust if the fisheye field of view isn't exactly 180°
   - **Radius** - scales the lens projection radius
   - **Center L / Center R** - nudges each lens horizontally if the optical center isn't perfectly aligned
   - **Seam Width** - controls how wide the blend zone is at the stitch line

When you're happy, click **Export JPG (XMP)** or **Export PNG** to save

### 2. HDR merge

This is more of a "HDR-ish" processing which lets you add images of any exposure and find a decent blend by changing the settings.

1. Click **HDR Merge OO** and select your bracketed images (they'll be listed in the loader)
2. The app merges them into a single HDR-ready source, then stitches as normal
3. Adjust **HDR Sigma** if the merge looks too flat or too contrasty
4. Export as usual

### 3. Frame stacking

For reducing noise by averaging multiple captures:

1. Click **Merge OO** and select your frames
2. They'll be aligned and blended into a single cleaner image
3. More frames = less noise

### 4. Post-processing

The **Processing** panel has all your adjustments:

| Control | What it does |
|---|---|
| **Exposure** | Brighten or darken the image |
| **Gamma** | Adjust midtone response |
| **Contrast** | Stretch or compress tonal range |
| **Saturation** | Boost or reduce colour intensity |
| **Sharpen** | Apply unsharp masking for crisper detail |
| **Temperature** | Warm or cool the white balance |

Toggle all processing on/off with the **ON / OFF** button. You can **Save** your processing settings to a file and **Load** them back later.

### 5. Watermark / nadir decal

You can add a watermark to the bottom of the panorama to cover the tripod or yourself:

1. Click the **+** button in the **Watermark** section and select your decal image
2. Use **Size** and **Rotation** sliders to position it
3. Export with **Export JPG (XMP)** - the decal is baked into the output

### 6. 3D preview

1. Click **3D** in the top-right corner of the canvas
2. Drag to pan around the panorama
3. Scroll to zoom in and out
4. Click **3D** again (or double-click the canvas) to return to the flat view

Double clicking will aim the 3D at the place you click.

### 7. Lens profiles

If you're stitching the same camera repeatedly:

1. Dial in your lens settings (FOV, radius, center offsets, etc.)
2. Click **Export Profile** to save them as a JSON file
3. Next time, click **Import Profile** to load your saved settings instantly

### 8. Export options

- **Export JPG (XMP)** - saves a JPG with XMP metadata so 360° viewers (Google Photos, Facebook, etc.) recognise it as a panorama
- **Export PNG** - lossless output without metadata
- Toggle **HD** before processing for 2x resolution. Can make the results look better if you have an older, lower resolution camera.

Enjoy!
