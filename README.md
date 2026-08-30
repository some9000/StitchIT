# StitchIT

Browser-based dual-fisheye to equirectangular 360° stitcher. Everything runs on the GPU - no image ever leaves your machine.

## What it does

StitchIT takes dual-fisheye source images from 360° cameras and produces stitched equirectangular panoramas, entirely in the browser. No server, no upload, no install.

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

- Most sliders and controls have tooltips - hover over any control to see what it does.
- Double-click the result to toggle between 2D and 3D view
- Drag to pan in 3D view
- Scroll to zoom in 3D view

## Requirements

- A modern browser with WebGL support
- No server required - runs entirely from a local file or any static host

You can support me here, in case you would like to: https://buymeacoffee.com/some9000 Thanks!
