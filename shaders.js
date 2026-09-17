// shaders.js
window.S360 = window.S360 || {};
(function (S360) {
'use strict';
  // Separable Gaussian blur used to precompute the low-frequency source layer.
  S360.BLUR_VS = S360.QUAD_VS;

  S360.BLUR_FS = `#version 300 es
    precision highp float;
    in vec2 v_uv;
    out vec4 fragColor;
    uniform sampler2D u_tex;
    uniform vec2 u_texel;
    uniform vec2 u_dir;
    void main() {
      float w0 = 0.227027, w1 = 0.194595, w2 = 0.121621, w3 = 0.054054, w4 = 0.016216;
      vec3 c = texture(u_tex, v_uv).rgb * w0;
      c += texture(u_tex, v_uv + u_dir * u_texel * 1.0).rgb * w1;
      c += texture(u_tex, v_uv - u_dir * u_texel * 1.0).rgb * w1;
      c += texture(u_tex, v_uv + u_dir * u_texel * 2.0).rgb * w2;
      c += texture(u_tex, v_uv - u_dir * u_texel * 2.0).rgb * w2;
      c += texture(u_tex, v_uv + u_dir * u_texel * 3.0).rgb * w3;
      c += texture(u_tex, v_uv - u_dir * u_texel * 3.0).rgb * w3;
      c += texture(u_tex, v_uv + u_dir * u_texel * 4.0).rgb * w4;
      c += texture(u_tex, v_uv - u_dir * u_texel * 4.0).rgb * w4;
      fragColor = vec4(c, 1.0);
    }
  `;

  // Source-domain cleanup shared by the dual-fisheye stitch shader and the
  // already-stitched copy shader. Dual-fisheye stitching reuses the prepared
  // low-frequency source for its wide chroma estimate; stitched sources use
  // the sparse fallback because they intentionally do not retain that layer.
  S360.CLEANUP_GLSL = `
    vec3 s360ToYCoCg(vec3 c) {
      return vec3(dot(c, vec3(.25, .5, .25)), .5 * (c.r - c.b), .5 * c.g - .25 * (c.r + c.b));
    }
    vec3 s360FromYCoCg(vec3 c) {
      return vec3(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z);
    }
    vec2 s360CleanupUv(vec2 uv, int wrapX) {
      return vec2(wrapX == 1 ? fract(uv.x) : clamp(uv.x, 0., 1.), clamp(uv.y, 0., 1.));
    }
    float s360LinearLum(sampler2D tex, vec2 uv, int wrapX) {
      vec3 linearRgb = pow(max(texture(tex, s360CleanupUv(uv, wrapX)).rgb, vec3(0.0)), vec3(2.2));
      return dot(linearRgb, vec3(0.2126, 0.7152, 0.0722));
    }
    // A bounded first inverse-blur step in native source pixels. It operates
    // on luminance only and rescales the cleaned colour, avoiding the coloured
    // fringes produced by independent per-channel Richardson-Lucy division.
    vec3 s360FocusRecover(sampler2D tex, vec2 uv, vec2 texel, vec3 baseColor,
                          float amount, float radiusPx, int wrapX) {
      if (amount <= 0.0) return baseColor;
      vec2 d = texel * clamp(radiusPx, 0.5, 4.0);
      float observed = s360LinearLum(tex, uv, wrapX);
      float blurred = observed * 0.25;
      blurred += s360LinearLum(tex, uv + vec2( d.x, 0.0), wrapX) * 0.125;
      blurred += s360LinearLum(tex, uv + vec2(-d.x, 0.0), wrapX) * 0.125;
      blurred += s360LinearLum(tex, uv + vec2(0.0,  d.y), wrapX) * 0.125;
      blurred += s360LinearLum(tex, uv + vec2(0.0, -d.y), wrapX) * 0.125;
      blurred += s360LinearLum(tex, uv + vec2( d.x,  d.y), wrapX) * 0.0625;
      blurred += s360LinearLum(tex, uv + vec2(-d.x,  d.y), wrapX) * 0.0625;
      blurred += s360LinearLum(tex, uv + vec2( d.x, -d.y), wrapX) * 0.0625;
      blurred += s360LinearLum(tex, uv + vec2(-d.x, -d.y), wrapX) * 0.0625;

      vec3 baseLinear = pow(max(baseColor, vec3(0.0)), vec3(2.2));
      float baseLum = dot(baseLinear, vec3(0.2126, 0.7152, 0.0722));
      float detail = observed - blurred;
      float edgeGate = smoothstep(0.0025, 0.025, abs(detail));
      float toneGate = smoothstep(0.008, 0.06, baseLum) * (1.0 - smoothstep(0.86, 0.99, baseLum));
      float delta = clamp(detail * 1.75, -0.075, 0.075) * clamp(amount, 0.0, 1.0) * edgeGate * toneGate;
      float recoveredLum = clamp(baseLum + delta, 0.0, 1.0);
      float gain = clamp(recoveredLum / max(baseLum, 0.0005), 0.80, 1.25);
      return pow(clamp(baseLinear * gain, 0.0, 1.0), vec3(1.0 / 2.2));
    }
    vec3 s360CleanupSample(sampler2D tex, sampler2D lowTex, vec2 uv, vec2 texel,
                           float grainStrength, float chromaStrength,
                           int useLowFrequency, int wrapX) {
      vec3 center = s360ToYCoCg(texture(tex, s360CleanupUv(uv, wrapX)).rgb);
      vec2 grainOffsets[12] = vec2[12](
        vec2(1,0),vec2(-1,0),vec2(0,1),vec2(0,-1),
        vec2(1,1),vec2(-1,1),vec2(1,-1),vec2(-1,-1),
        vec2(2,0),vec2(-2,0),vec2(0,2),vec2(0,-2)
      );
      float ySum = center.x, yWeight = 1.;
      if (grainStrength > 0.) {
        float sigmaY = .012 + .045 * grainStrength;
        for (int i = 0; i < 12; i++) {
          vec3 n = s360ToYCoCg(texture(tex, s360CleanupUv(uv + grainOffsets[i] * texel, wrapX)).rgb);
          float spatial = i < 8 ? 1. : .55;
          float w = spatial * exp(-pow((n.x - center.x) / sigmaY, 2.));
          ySum += n.x * w; yWeight += w;
        }
      }

      vec2 chromaOffsets[20] = vec2[20](
        vec2(2,0),vec2(-2,0),vec2(0,2),vec2(0,-2),
        vec2(4,0),vec2(-4,0),vec2(0,4),vec2(0,-4),
        vec2(4,4),vec2(-4,4),vec2(4,-4),vec2(-4,-4),
        vec2(8,0),vec2(-8,0),vec2(0,8),vec2(0,-8),
        vec2(8,8),vec2(-8,8),vec2(8,-8),vec2(-8,-8)
      );
      vec2 smoothChroma = center.yz;
      float edgeGuard = 1.;
      if (chromaStrength > 0.) {
        float sigmaEdge = .018 + .035 * chromaStrength;
        if (useLowFrequency == 1) {
          vec3 low = s360ToYCoCg(texture(lowTex, s360CleanupUv(uv, wrapX)).rgb);
          smoothChroma = low.yz;
          edgeGuard = exp(-pow((low.x - center.x) / sigmaEdge, 2.));
        } else {
          vec2 cSum = center.yz; float cWeight = 1.;
          for (int i = 0; i < 20; i++) {
            vec3 n = s360ToYCoCg(texture(tex, s360CleanupUv(uv + chromaOffsets[i] * texel, wrapX)).rgb);
            float spatial = i < 4 ? .8 : i < 12 ? .55 : .38;
            float w = spatial * exp(-pow((n.x - center.x) / sigmaEdge, 2.));
            cSum += n.yz * w; cWeight += w;
          }
          smoothChroma = cSum / cWeight;
        }
      }
      float cleanY = ySum / yWeight;
      if (grainStrength > 0.) {
        // JPEG blocks are usually much stronger across an 8-pixel boundary
        // than between immediate neighbours. Smooth only when that boundary
        // is not supported by a real local edge, keeping text and fine detail.
        vec2 blockOffsets[4] = vec2[4](vec2(8, 0), vec2(-8, 0), vec2(0, 8), vec2(0, -8));
        float blockMean = 0.;
        float blockEnergy = 0.;
        for (int i = 0; i < 4; i++) {
          float farY = s360ToYCoCg(texture(tex, s360CleanupUv(uv + blockOffsets[i] * texel, wrapX)).rgb).x;
          blockMean += farY;
          blockEnergy += abs(center.x - farY);
        }
        blockMean *= .25;
        blockEnergy *= .25;
        float localEnergy = 0.;
        for (int i = 0; i < 4; i++) {
          vec2 nearOffset = blockOffsets[i] * .125;
          float nearY = s360ToYCoCg(texture(tex, s360CleanupUv(uv + nearOffset * texel, wrapX)).rgb).x;
          localEnergy += abs(center.x - nearY);
        }
        localEnergy *= .25;
        float blockLike = smoothstep(.008, .055, blockEnergy) * (1. - smoothstep(.012, .07, localEnergy));
        cleanY = mix(cleanY, blockMean, .18 * blockLike * clamp(grainStrength, 0., 1.));
      }
      float neutralArea = 1. - smoothstep(.045, .20, length(smoothChroma));
      float falseColor = smoothstep(.006, .10, length(center.yz - smoothChroma));
      float chromaMix = clamp(.5 * chromaStrength * mix(.22, 1., max(neutralArea, falseColor)) * edgeGuard, 0., 1.);
      vec3 cleaned = vec3(cleanY, mix(center.yz, smoothChroma, chromaMix));
      return clamp(s360FromYCoCg(cleaned), 0., 1.);
    }
  `;

  // 4-lobe Lanczos upscaling shaders (separable: horizontal + vertical passes)
  S360.LANCZOS_VS = S360.QUAD_VS;

  S360.LANCZOS_H_FS = `#version 300 es
    precision highp float;
    in vec2 v_uv;
    out vec4 fragColor;
    uniform sampler2D u_tex;
    uniform vec2 u_inputSize;   // input texture size in pixels
    uniform vec2 u_outputSize;  // output texture size in pixels

    const int LOBES = 4;
    const float PI = 3.14159265358979323846;

    float lanczos(float x) {
      float absx = abs(x);
      if (absx >= float(LOBES)) return 0.0;
      if (absx < 1e-6) return 1.0;
      float pix = PI * absx;
      return float(LOBES) * sin(pix) * sin(pix / float(LOBES)) / (pix * pix);
    }

    void main() {
      float outX = v_uv.x * u_outputSize.x - 0.5;
      float inX = (outX + 0.5) * u_inputSize.x / u_outputSize.x - 0.5;
      float baseX = floor(inX);

      vec4 sum = vec4(0.0);
      float wSum = 0.0;

      for (int i = -4; i <= 4; i++) {
        float sampleIndex = baseX + float(i);
        float weight = lanczos(inX - sampleIndex);
        if (abs(weight) > 1e-7) {
          float sampleX = (sampleIndex + 0.5) / u_inputSize.x;
          sampleX = clamp(sampleX, 0.5 / u_inputSize.x, 1.0 - 0.5 / u_inputSize.x);
          sum += texture(u_tex, vec2(sampleX, v_uv.y)) * weight;
          wSum += weight;
        }
      }
      fragColor = sum / max(wSum, 1e-6);
    }
  `;

  S360.LANCZOS_V_FS = `#version 300 es
    precision highp float;
    in vec2 v_uv;
    out vec4 fragColor;
    uniform sampler2D u_tex;
    uniform vec2 u_inputSize;   // intermediate texture size in pixels
    uniform vec2 u_outputSize;  // final output texture size in pixels

    const int LOBES = 4;
    const float PI = 3.14159265358979323846;

    float lanczos(float x) {
      float absx = abs(x);
      if (absx >= float(LOBES)) return 0.0;
      if (absx < 1e-6) return 1.0;
      float pix = PI * absx;
      return float(LOBES) * sin(pix) * sin(pix / float(LOBES)) / (pix * pix);
    }

    void main() {
      float outY = v_uv.y * u_outputSize.y - 0.5;
      float inY = (outY + 0.5) * u_inputSize.y / u_outputSize.y - 0.5;
      float baseY = floor(inY);

      vec4 sum = vec4(0.0);
      float wSum = 0.0;

      for (int i = -4; i <= 4; i++) {
        float sampleIndex = baseY + float(i);
        float weight = lanczos(inY - sampleIndex);
        if (abs(weight) > 1e-7) {
          float sampleY = (sampleIndex + 0.5) / u_inputSize.y;
          sampleY = clamp(sampleY, 0.5 / u_inputSize.y, 1.0 - 0.5 / u_inputSize.y);
          sum += texture(u_tex, vec2(v_uv.x, sampleY)) * weight;
          wSum += weight;
        }
      }
      fragColor = sum / max(wSum, 1e-6);
    }
  `;

  S360.VS_SOURCE = S360.QUAD_VS;

  S360.FS_SOURCE = `#version 300 es
  precision highp float;
  in vec2 v_uv;
  out vec4 fragColor;
  uniform sampler2D u_image;
  uniform sampler2D u_imageLF;
  uniform sampler2D u_seamCurve;
  uniform vec3 u_gainR;
  uniform int u_showSeam;
  uniform vec2 u_srcSize;
  uniform vec2 u_centersL;
  uniform vec2 u_centersR;
  uniform float u_radius;
  uniform float u_halfFov;
  uniform float u_f;
  uniform float u_matchNorm;
  uniform float u_beltNorm;
  uniform float u_seamWidth;
  uniform float u_seamShift;
  uniform vec3 u_axisL;
  uniform vec3 u_upL;
  uniform vec3 u_rightL;
  uniform vec3 u_axisR;
  uniform vec3 u_upR;
  uniform vec3 u_rightR;
  uniform int u_schematicMode;
  uniform float u_rollL;
  uniform float u_rollR;
  uniform float u_widthL;
  uniform float u_heightL;
  uniform float u_angleL;
  uniform float u_widthR;
  uniform float u_heightR;
  uniform float u_angleR;
  uniform int u_guideOn;
  uniform vec2 u_guidePos;
  uniform int u_outputLens;
  uniform float u_grainStrength;
  uniform float u_chromaCleanup;
  uniform float u_caRed;
  uniform float u_caBlue;
  uniform float u_focusRecovery;
  uniform float u_focusRadius;

  #define PI 3.14159265358979323846

  ${S360.CLEANUP_GLSL}

  struct LensResult {
      vec2 sxsy;
      float theta;
      float az;
      bool hit;
  };

  // Pure lens geometry from precomputed polar coords: theta = angle off the
  // lens axis (acos of dot(v, axis)), az = in-lens azimuth (atan of the
  // right/up components). Split out of projectLens so mapLens can compute
  // the expensive trig ONCE — previously mapLens computed theta for the FoV
  // check, then projectLens recomputed theta AND az from the same v, and a
  // second atan rebuilt az for the result struct (2x acos + 2x atan + a
  // duplicate axis dot per lens per fragment where 1 of each suffices).
  vec2 projectLensPolar(float theta, float az, vec2 center, float width, float height, float angle) {
      float dist = u_f * theta;
      float dx = dist * sin(az);
      float dy = -dist * cos(az);
      dx *= width;
      dy *= height;
      float c = cos(angle);
      float s = sin(angle);
      return center + vec2(dx * c - dy * s, dx * s + dy * c);
  }

  // Full projection: ray -> polar angles -> lens coordinates. Public entry
  // point for callers that only need the projection (the no-hit fallback in
  // main()); mapLens calls projectLensPolar directly with its own trig.
  vec2 projectLens(vec3 v, vec3 axis, vec3 up, vec3 right, vec2 center, float width, float height, float angle) {
      float theta = acos(clamp(dot(v, axis), -1.0, 1.0));
      float az = atan(dot(v, right), dot(v, up));
      return projectLensPolar(theta, az, center, width, height, angle);
  }

  LensResult mapLens(vec3 v, vec3 axis, vec3 up, vec3 right, vec2 center, float width, float height, float angle) {
      LensResult res;
      res.hit = false;
      res.theta = 0.0;
      res.az = 0.0;
      res.sxsy = vec2(0.0);

      // Trig computed once: theta is needed for the FoV check regardless, and
      // az feeds both the projection and the result struct. Identical
      // expressions to the old values — same inputs, evaluated one time.
      float theta = acos(clamp(dot(v, axis), -1.0, 1.0));
      if (theta > u_halfFov) return res;
      float az = atan(dot(v, right), dot(v, up));
      vec2 s = projectLensPolar(theta, az, center, width, height, angle);
      if (dot(s - center, s - center) > u_radius * u_radius) return res;
      res.sxsy = s;
      res.theta = theta;
      res.az = az;
      res.hit = true;
      return res;
  }

  // ORIENTATION CONVENTION — read before touching any vertical flip!
  // (Guarded by the synthetic tripwire in orientation-selftest.js — open the
  // app with ?selftest, or call S360.runOrientationSelfTest() from the console.)
  //
  // pixelCoord is in source-image pixel space with y = 0 at the image TOP —
  // the exact space the CPU lens twins use (geometry.js sourcePoint; the seam
  // and calibrate workers feed its y straight into their top-down ImageData).
  // The source texture is uploaded UNflipped (UNPACK_FLIP_Y = false; image.js
  // and stitcher.js), which stores the image's first (top) row at v = 0.
  //
  // The 1.0 - below is inversion #1 of a deliberate PAIR: it fetches the
  // vertically mirrored pixel relative to the image as viewed. main()'s
  // pyNorm = 1.0 - v_uv.y is inversion #2 (the pano is assembled pole-flipped
  // in the FBO). #1 x #2 cancel, so the final pano is upright. Remove either
  // flip ALONE and every panorama renders upside-down. The watermark upload
  // (stitcher.js) and the schematic overlay below are flipped for their own
  // separate reasons and are NOT part of this pair.
  vec2 sourceUv(vec2 pixelCoord) {
      // Wrap horizontally so left/right edges of the equirect seam are seamless;
      // clamp vertically to the valid [0, srcHeight] range.
      float u = fract(pixelCoord.x / u_srcSize.x);
      float v = 1.0 - clamp(pixelCoord.y / u_srcSize.y, 0.0, 1.0);
      return vec2(u, v);
  }

  vec3 sampleProcessedSource(vec2 pixelCoord) {
      vec2 uv = sourceUv(pixelCoord);
      vec3 color = s360CleanupSample(u_image, u_imageLF, uv, 1.0 / u_srcSize,
          u_grainStrength, u_chromaCleanup, 1, 0);
      return s360FocusRecover(u_image, uv, 1.0 / u_srcSize, color,
          u_focusRecovery, u_focusRadius, 0);
  }

  vec4 sampleSource(vec2 pixelCoord, vec2 lensCenter) {
      vec3 color = sampleProcessedSource(pixelCoord);
      if (abs(u_caRed) > 0.001 || abs(u_caBlue) > 0.001) {
          // Values are channel displacement in source pixels at the usable lens
          // edge. The correction tap grows linearly from zero at the optical
          // centre, matching lateral chromatic aberration in a fisheye lens.
          vec2 radial = (pixelCoord - lensCenter) / max(u_radius, 1.0);
          if (abs(u_caRed) > 0.001) color.r = sampleProcessedSource(pixelCoord + radial * u_caRed).r;
          if (abs(u_caBlue) > 0.001) color.b = sampleProcessedSource(pixelCoord + radial * u_caBlue).b;
      }
      return vec4(color, 1.0);
  }

  // Low-frequency twin of sampleSource — same pixel space, same inversion #1.
  vec3 sampleSourceLF(vec2 pixelCoord) {
      float u = fract(pixelCoord.x / u_srcSize.x);
      float v = 1.0 - clamp(pixelCoord.y / u_srcSize.y, 0.0, 1.0);
      return texture(u_imageLF, vec2(u, v)).rgb;
  }

  float sdCircle(vec2 p, vec2 c, float r) {
      return length(p - c) - r;
  }

  float sdEllipse(vec2 p, vec2 c, vec2 radius) {
      vec2 d = p - c;
      vec2 safeR = max(radius, vec2(1e-6));
      float f = (d.x*d.x)/(safeR.x*safeR.x) + (d.y*d.y)/(safeR.y*safeR.y) - 1.0;
      vec2 grad = 2.0 * d / (safeR * safeR);
      return f / max(length(grad), 1e-6);
  }

  vec3 mixStroke(vec3 base, vec3 stroke, float strokeAlpha, float dist, float width) {
      float alpha = 1.0 - smoothstep(width * 0.5, width * 0.5 + 1.5, abs(dist));
      return mix(base, stroke, strokeAlpha * alpha);
  }

  float sdSegment(vec2 p, vec2 a, vec2 b) {
      vec2 pa = p - a;
      vec2 ba = b - a;
      float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
      return length(pa - ba * h);
  }

  vec2 lineBoxIntersection(vec2 c, vec2 d, vec2 boxMin, vec2 boxMax) {
      float tNeg = -1e6;
      float tPos = 1e6;
      if (abs(d.x) > 1e-6) {
          float tx1 = (boxMin.x - c.x) / d.x;
          float tx2 = (boxMax.x - c.x) / d.x;
          tNeg = max(tNeg, min(tx1, tx2));
          tPos = min(tPos, max(tx1, tx2));
      }
      if (abs(d.y) > 1e-6) {
          float ty1 = (boxMin.y - c.y) / d.y;
          float ty2 = (boxMax.y - c.y) / d.y;
          tNeg = max(tNeg, min(ty1, ty2));
          tPos = min(tPos, max(ty1, ty2));
      }
      return vec2(tNeg, tPos);
  }

  vec3 mixRotatedCrossSegments(vec3 base, vec2 p, vec2 c, float roll, vec2 boxMin, vec2 boxMax, vec3 stroke, float strokeAlpha, float width) {
      float co = cos(roll), si = sin(roll);
      vec2 dx = vec2(co, si);
      vec2 dy = vec2(-si, co);
      vec2 tx = lineBoxIntersection(c, dx, boxMin, boxMax);
      vec2 ty = lineBoxIntersection(c, dy, boxMin, boxMax);
      float d1 = sdSegment(p, c + dx * tx.x, c + dx * tx.y);
      float d2 = sdSegment(p, c + dy * ty.x, c + dy * ty.y);
      float alpha1 = 1.0 - smoothstep(width * 0.5, width * 0.5 + 1.5, d1);
      float alpha2 = 1.0 - smoothstep(width * 0.5, width * 0.5 + 1.5, d2);
      return mix(base, stroke, strokeAlpha * max(alpha1, alpha2));
  }

  vec3 mixRayThroughPoint(vec3 base, vec2 px, vec2 center, vec2 target, vec2 boxMin, vec2 boxMax, vec3 stroke, float strokeAlpha, float width) {
      vec2 dir = target - center;
      float len = length(dir);
      if (len < 1e-6) return base;
      dir /= len;
      vec2 tRange = lineBoxIntersection(center, dir, boxMin, boxMax);
      float d = sdSegment(px, center, center + dir * tRange.y);
      float alpha = 1.0 - smoothstep(width * 0.5, width * 0.5 + 1.5, d);
      return mix(base, stroke, strokeAlpha * alpha);
  }

  // Fills a translucent annulus between two concentric ellipses of the same
  // aspect (both scaled horizontally by width). sdEllipse is signed (negative
  // inside), so edge = max(-dInner, dOuter) is <= 0 only inside the band giving
  // an anti-aliased 1.5px ramp on both boundaries.
  vec3 mixAnnulus(vec3 base, vec2 p, vec2 c, float r0, float r1, float width, float height, float alpha) {
      float d0 = sdEllipse(p, c, vec2(r0 * width, r0 * height));
      float d1 = sdEllipse(p, c, vec2(r1 * width, r1 * height));
      float edge = max(-d0, d1);
      return mix(base, vec3(0.13, 0.55, 0.35), alpha * (1.0 - smoothstep(0.0, 1.5, edge)));
  }

  // Mirrors geometry.js seamBand: signed lens preference across the full overlap.
  float seamCenter(float base, float halfBand) {
      base = clamp(base, halfBand, 1.0 - halfBand);
      float shift = clamp(u_seamShift, -1.0, 1.0);
      float edge = shift < 0.0 ? 1.0 + halfBand : -halfBand;
      return mix(base, edge, abs(shift));
  }

  vec3 schematicOverlay(vec3 base, vec2 px) {
      vec3 color = base;
      float lineW = 10.0;
      float r = u_radius;                          // outer-margin capture circle (blue)
      float rMatch = u_f * (PI / 2.0);             // 180° / perfect-sphere ring (orange)

      // Nominal full overlap; the right lens has reversed radial coordinates.
      float beltPx = max(2.0 * (r - rMatch), 0.0);
      float innerR = 2.0 * rMatch - r;
      float halfBand = max(0.001, u_seamWidth) * 0.5;
      float centerBelt = seamCenter(0.5, halfBand);
      float lo = clamp(centerBelt - halfBand, 0.0, 1.0);
      float hi = clamp(centerBelt + halfBand, 0.0, 1.0);
      float loR = innerR + lo * beltPx;
      float hiR = innerR + hi * beltPx;
      float midR = innerR + clamp(centerBelt, 0.0, 1.0) * beltPx;

      vec2 halfScreen = u_srcSize * 0.5;
      vec2 leftBoxMin = vec2(0.0, 0.0);
      vec2 leftBoxMax = vec2(halfScreen.x, u_srcSize.y);
      vec2 rightBoxMin = vec2(halfScreen.x, 0.0);
      vec2 rightBoxMax = u_srcSize;

      // Left lens — rotate pixel coords by -angle, then draw width-scaled ellipses
      {
          vec2 dL = px - u_centersL;
          float cL = cos(-u_angleL);
          float sL = sin(-u_angleL);
          vec2 rxL = u_centersL + vec2(dL.x * cL - dL.y * sL, dL.x * sL + dL.y * cL);
          color = mixStroke(color, vec3(0.20, 0.50, 1.00), 0.35, sdEllipse(rxL, u_centersL, vec2(r * u_widthL, r * u_heightL)), lineW);
          color = mixStroke(color, vec3(0.95, 0.55, 0.10), 0.35, sdEllipse(rxL, u_centersL, vec2(rMatch * u_widthL, rMatch * u_heightL)), lineW * 1.4);
          color = mixAnnulus(color, rxL, u_centersL, loR, hiR, u_widthL, u_heightL, 0.25);
          color = mixStroke(color, vec3(0.13, 0.55, 0.35), 0.75, sdEllipse(rxL, u_centersL, vec2(midR * u_widthL, midR * u_heightL)), lineW * 1.5);
      }
      color = mixRotatedCrossSegments(color, px, u_centersL, u_rollL, leftBoxMin, leftBoxMax, vec3(1.00, 0.55, 0.00), 0.50, lineW);

      // Right lens — rotate pixel coords by -angle, then draw width-scaled ellipses
      {
          loR = innerR + (1.0 - hi) * beltPx;
          hiR = innerR + (1.0 - lo) * beltPx;
          midR = innerR + (1.0 - clamp(centerBelt, 0.0, 1.0)) * beltPx;
          vec2 dR = px - u_centersR;
          float cR = cos(-u_angleR);
          float sR = sin(-u_angleR);
          vec2 rxR = u_centersR + vec2(dR.x * cR - dR.y * sR, dR.x * sR + dR.y * cR);
          color = mixStroke(color, vec3(0.20, 0.50, 1.00), 0.35, sdEllipse(rxR, u_centersR, vec2(r * u_widthR, r * u_heightR)), lineW);
          color = mixStroke(color, vec3(0.95, 0.55, 0.10), 0.35, sdEllipse(rxR, u_centersR, vec2(rMatch * u_widthR, rMatch * u_heightR)), lineW * 1.4);
          color = mixAnnulus(color, rxR, u_centersR, loR, hiR, u_widthR, u_heightR, 0.25);
          color = mixStroke(color, vec3(0.13, 0.55, 0.35), 0.75, sdEllipse(rxR, u_centersR, vec2(midR * u_widthR, midR * u_heightR)), lineW * 1.5);
      }
      color = mixRotatedCrossSegments(color, px, u_centersR, u_rollR, rightBoxMin, rightBoxMax, vec3(1.00, 0.55, 0.00), 0.50, lineW);

      // Persistent horizontal guideline and green diagonal radius reference
      if (u_guideOn == 1) {
          vec2 gp = u_guidePos;
          float gy = gp.y;
          color = mixStroke(color, vec3(0.00, 0.85, 0.20), 0.70, px.y - gy, lineW);

          bool clickedLeft = gp.x < u_srcSize.x * 0.5;
          vec2 mirror = vec2(u_srcSize.x - gp.x, gp.y);
          vec2 leftTarget  = clickedLeft ? gp : mirror;
          vec2 rightTarget = clickedLeft ? mirror : gp;

          // Rays from each lens center through the clicked point (or its mirror),
          // clipped to the lens's own half of the screen.
          color = mixRayThroughPoint(color, px, u_centersL, leftTarget,  leftBoxMin, leftBoxMax,  vec3(0.00, 0.85, 0.20), 0.50, lineW);
          color = mixRayThroughPoint(color, px, u_centersR, rightTarget, rightBoxMin, rightBoxMax, vec3(0.00, 0.85, 0.20), 0.50, lineW);
      }

      return color;
  }

  void main() {
      float pxNorm = v_uv.x;
      // Inversion #2 of the orientation pair documented at sampleSource():
      // v_uv.y = 1 is the TOP row of the pano as finally displayed (the post
      // pass samples this FBO directly and readFboToCanvas flips rows on the
      // way to a canvas — both preserve that), so pyNorm runs 0 at the top
      // and vLat sweeps -90deg .. +90deg DOWNWARD. The pano is therefore
      // assembled pole-flipped in the FBO, and sampleSource's mirrored fetch
      // (inversion #1) flips it back upright. Do not remove this alone.
      float pyNorm = 1.0 - v_uv.y;

      float vLat = pyNorm * PI - (PI / 2.0);
      float vLon = pxNorm * 2.0 * PI;
      float cosLat = cos(vLat);
      vec3 v = vec3(cosLat * cos(vLon), cosLat * sin(vLon), sin(vLat));

      LensResult resR = mapLens(v, u_axisR, u_upR, u_rightR, u_centersR, u_widthR, u_heightR, u_angleR);
      LensResult resL = mapLens(v, u_axisL, u_upL, u_rightL, u_centersL, u_widthL, u_heightL, u_angleL);

      // Schematic overlay: show the raw dual-fisheye source with geometry guides
      // (ideal circles, seam blend band, rotated center axes).
      if (u_schematicMode == 1) {
          // Raw-source view (no lens math). This flip stands ALONE — it is not
          // part of the sampleSource/pyNorm pair: the screen top (v_uv.y = 1)
          // must sample v = 0, where the unflipped upload put the image's
          // first (top) row, so the raw photo displays upright.
          vec2 px = vec2(v_uv.x * u_srcSize.x, (1.0 - v_uv.y) * u_srcSize.y);
          vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y);
          vec3 color = texture(u_image, uv).rgb;
          color = schematicOverlay(color, px);
          fragColor = vec4(color, 1.0);
          return;
      }

      // Simple seam: an opacity gradient on the RIGHT lens over the part where it
      // overlaps the LEFT lens. It is a straight mix of the two lens samples, so
      // seamWidth (band width) and seamShift (centre position) map directly to
      // visible gradient width and 50% crossing point, and the two exposures blend
      // smoothly so neither lens dominates the overlap.
      vec3 colorL_raw = resL.hit ? sampleSource(resL.sxsy, u_centersL).rgb : vec3(0.0);
      vec3 colorR_unbalanced = resR.hit ? sampleSource(resR.sxsy, u_centersR).rgb : vec3(0.0);

      if (resL.hit && resR.hit) {
          // Full overlap: 0 = right capture edge, 1 = left capture edge.
          float baseBelt = texture(u_seamCurve, vec2(fract((resL.az + PI) / (2.0 * PI)), 0.5)).r;
          // Negative shift favours left; positive favours right, at every width.
          float bandWidth = max(0.001, u_seamWidth);
          float halfBand = bandWidth * 0.5;
          float centerBelt = seamCenter(baseBelt, halfBand);

          float thetaNorm = resL.theta / u_halfFov;
          float beltPos = (thetaNorm - (2.0 * u_matchNorm - 1.0)) / max(2.0 * u_beltNorm, 0.001);

          // wR = right-lens fill: 0 at the near edge (left-lens side), 1 at the far
          // edge (right-lens side). A single smooth ramp over the whole band makes
          // the feather width and shift directly visible.
          float wR = smoothstep(centerBelt - halfBand, centerBelt + halfBand, beltPos);
          // Apply exposure matching as a fixed lens-space gradient, independent
          // of seamWidth. seamWidth controls which lens is preferred; it must
          // not also stretch the tone correction until the whole overlap is
          // over-corrected. The correction is strongest toward the inner
          // (match-radius) side of the lens and fades toward its outer edge.
          vec3 colorR_balanced = clamp(colorR_unbalanced * u_gainR, 0.0, 1.0);
          float toneWeight = 1.0 - smoothstep(0.15, 0.85, clamp(beltPos, 0.0, 1.0));
          vec3 colorR_raw = mix(colorR_unbalanced, colorR_balanced, toneWeight);
          // Isolated lens layers are analysis/warp inputs, not a decomposition
          // of the feathered result. Keep both fully opaque throughout their
          // physical overlap so matching can compare the same scene points.
          if (u_outputLens == 1) { fragColor = vec4(colorL_raw, 1.0); return; }
          if (u_outputLens == 2) { fragColor = vec4(colorR_raw, 1.0); return; }
          vec3 color = clamp(mix(colorL_raw, colorR_raw, wR), 0.0, 1.0);

          if (u_showSeam == 1) {
              float seamDistance = abs(beltPos - centerBelt);
              // Translucent tint makes the gradient band inspectable; cyan marks
              // the 50% centre, orange marks each transition edge.
              if (seamDistance < halfBand) color = mix(color, vec3(0.0, 0.75, 0.55), 0.12);
              if (abs(seamDistance - halfBand) < 0.004) color = mix(color, vec3(1.0, 0.55, 0.0), 0.70);
              if (seamDistance < 0.004) color = mix(color, vec3(0.0, 1.0, 0.80), 0.70);
          }
          fragColor = vec4(color, 1.0);
      } else if (resL.hit) {
          if (u_outputLens == 1) { fragColor = vec4(colorL_raw, 1.0); return; }
          if (u_outputLens == 2) { fragColor = vec4(0.0); return; }
          fragColor = vec4(colorL_raw, 1.0);
      } else if (resR.hit) {
          if (u_outputLens == 1) { fragColor = vec4(0.0); return; }
          if (u_outputLens == 2) { fragColor = vec4(colorR_unbalanced, 1.0); return; }
          fragColor = vec4(colorR_unbalanced, 1.0);
      } else {
          bool useRight = v.x >= 0.0;
          vec2 s = projectLens(v,
              useRight ? u_axisR : u_axisL,
              useRight ? u_upR : u_upL,
              useRight ? u_rightR : u_rightL,
              useRight ? u_centersR : u_centersL,
              useRight ? u_widthR : u_widthL,
              useRight ? u_heightR : u_heightL,
              useRight ? u_angleR : u_angleL);
          vec3 color = sampleSource(s, useRight ? u_centersR : u_centersL).rgb;
          if (u_outputLens == 1) { fragColor = useRight ? vec4(0.0) : vec4(color, 1.0); return; }
          if (u_outputLens == 2) { fragColor = useRight ? vec4(color, 1.0) : vec4(0.0); return; }
          fragColor = vec4(color, 1.0);
      }
  }
  `;

  // ---------------------------------------------------------------------------
  // Shared Processing-pipeline GLSL. Single source of truth for the grading
  // math used by BOTH the equirect post pass (createPostProgram below) and the
  // live 3D sphere shader (viewer.js) — they stay identical by construction.
  // Inject into any fragment shader that declares the needed inputs; the
  // pipeline expects blurLum to be the half-res low-frequency luminance
  // estimate produced by S360.ensureLumBlur (webgl-utils.js).
  // ---------------------------------------------------------------------------
  S360.POST_GLSL = `
    float luminance(vec3 color) {
      return dot(color, vec3(0.2126, 0.7152, 0.0722));
    }

    // Maps a colour temperature (Kelvin) to a normalised RGB white point using
    // Tanner Helland's approximation. Dividing the colour by this white point
    // performs white balancing, so warmer sources (low K) get cooled and the
    // image is pushed toward neutral grey.
    vec3 kelvinToRGB(float kelvin) {
      float t = kelvin / 100.0;
      float r, g, b;
      if (t <= 66.0) {
        r = 255.0;
        g = 99.4708025861 * log(t) - 161.1195681661;
      } else {
        r = 329.698727446 * pow(t - 60.0, -0.1332047592);
        g = 288.1221695283 * pow(t - 60.0, -0.0755148492);
      }
      if (t >= 66.0) {
        b = 255.0;
      } else if (t <= 19.0) {
        b = 0.0;
      } else {
        b = 138.5177312231 * log(t - 10.0) - 305.0447927307;
      }
      return clamp(vec3(r, g, b) / 255.0, 0.0, 1.0);
    }

    // Full grading pipeline: exposure -> gamma -> unsharp mask (blurLum is the
    // low-frequency luminance estimate) -> saturation -> contrast -> white
    // balance. Returns the final clamped display colour.
    vec3 s360ApplyPost(vec3 color, float blurLum,
                       float exposure, float gamma, float sharpen,
                       float clarity, float saturation, float contrast, float temp) {
      color *= exposure;
      color = pow(color, vec3(gamma));

      if (sharpen > 0.0) {
        float origLum = luminance(color);
        float detail = origLum - blurLum;
        float threshold = .006 + .018 * min(sharpen, 1.0);
        float detailGate = smoothstep(threshold, threshold * 2.5, abs(detail));
        float newLum = clamp(origLum + detail * sharpen * detailGate, 0.0, 1.0);
        color *= newLum / max(origLum, 0.0001);
      }

      if (clarity > 0.0) {
        float origLum = luminance(color);
        float localContrast = origLum - blurLum;
        float clarityGate = smoothstep(.009, .045, abs(localContrast));
        float newLum = clamp(origLum + localContrast * clarity * 2.0 * clarityGate, 0.0, 1.0);
        color *= newLum / max(origLum, 0.0001);
      }

      float gray = luminance(color);
      color = mix(vec3(gray), color, saturation);
      color = clamp((color - 0.5) * contrast + 0.5, 0.0, 1.0);

      vec3 white = kelvinToRGB(temp);
      color /= max(white, vec3(0.0001));
      return clamp(color, 0.0, 1.0);
    }

  `;

  S360.createPostProgram = function (gl) {
    const vsSource = S360.QUAD_VS;

    const fsSource = `#version 300 es
      precision highp float;
      in vec2 v_uv;
      out vec4 fragColor;
      uniform sampler2D u_texture;
      uniform sampler2D u_blurLum;      // half-res blurred luminance
      uniform float u_exposure;
      uniform float u_gamma;
      uniform float u_sharpen;
      uniform float u_clarity;
      uniform float u_saturation;
      uniform float u_contrast;
      uniform float u_temp;       // colour temperature in Kelvin (e.g. 2000..12000)
      ${S360.POST_GLSL}

      void main() {
        vec3 color = texture(u_texture, v_uv).rgb;
        float blurLum = 0.0;
        if (u_sharpen > 0.0 || u_clarity > 0.0) blurLum = texture(u_blurLum, v_uv).r;
        color = s360ApplyPost(color, blurLum, u_exposure, u_gamma, u_sharpen, u_clarity,
                              u_saturation, u_contrast, u_temp);
        fragColor = vec4(color, 1.0);
      }
    `;

    return S360.createProgram(gl, vsSource, fsSource);
  };

  // Passthrough copy shader for already-stitched (equirectangular) sources.
  // Flips Y so north pole lands at the top of the FBO (matching readFboToCanvas).
  S360.COPY_VS = `#version 300 es
    layout(location = 0) in vec2 a_pos;
    out vec2 v_uv;
    void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }`;

  S360.COPY_FS = `#version 300 es
    precision highp float;
    in vec2 v_uv;
    out vec4 fragColor;
    uniform sampler2D u_tex;
    uniform float u_grainStrength;
    uniform float u_chromaCleanup;
    uniform float u_focusRecovery;
    uniform float u_focusRadius;
    ${S360.CLEANUP_GLSL}
    void main() {
      vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y);
      vec2 texel = 1.0 / vec2(textureSize(u_tex, 0));
      vec3 color = s360CleanupSample(u_tex, u_tex, uv, texel,
          u_grainStrength, u_chromaCleanup, 0, 1);
      fragColor = vec4(s360FocusRecover(u_tex, uv, texel, color,
          u_focusRecovery, u_focusRadius, 1), 1.0);
    }`;

  // Equidistant "little planet" projection: equirectangular -> square.
  // Consumed by lp-modal.js (which owns renderLittlePlanetPixels).
  S360.LITTLE_PLANET_VS = S360.QUAD_VS;

  S360.LITTLE_PLANET_FS = `#version 300 es
    precision highp float;
    in vec2 v_uv;
    out vec4 fragColor;
    uniform sampler2D u_tex;
    uniform float u_zoom;
    uniform float u_yaw;
    uniform float u_aspect;
    uniform float u_mirror;
    // Projection type: 0 = equidistant (r = theta), 1 = stereographic (r = 2*tan(theta/2)),
    // 2 = orthographic (r = sin(theta)).
    uniform int u_projType;
    // Projection flip: 0 = standard little planet (nadir at the disc centre),
    // 1 = inverted (zenith — the top of the 2:1 source — at the centre, as if
    // the source had been ROTATED 180 degrees; see the sampling note below).
    uniform float u_flip;
    // Uniform crop scale (>= 1): scales the whole render past the canvas edge
    // so the outer ring of the disc is clipped off — unlike u_zoom, which
    // magnifies the centre while the disc edge stays glued to the corners.
    // Driven by the Crop slider; used to trim tripod/horizon clutter.
    uniform float u_crop;
    // Watermark (pole decal) uniforms — nadir/bottom (*_B) and zenith/top (*_T).
    uniform float u_wmBOn;
    uniform sampler2D u_wmB;
    uniform float u_wmBSize;
    uniform float u_wmBAlpha;
    uniform float u_wmBRot;
    uniform float u_wmTOn;
    uniform sampler2D u_wmT;
    uniform float u_wmTSize;
    uniform float u_wmTAlpha;
    uniform float u_wmTRot;
    // Use LP_PI instead of #define PI to avoid the preprocessor expanding PI
    // inside WM_GLSL's own const-float-PI declaration.
    const float LP_PI = 3.14159265358979323846;

    ${S360.WM_GLSL}

    void main() {
      // Normalized canvas coords in [-1, 1].
      vec2 c_norm = (v_uv - 0.5) * 2.0;

      // Projection coords (aspect-corrected, mirrored).
      vec2 c = vec2(c_norm.x * u_aspect, c_norm.y);
      if (u_mirror > 0.0) c.x = -c.x;

      // rn: 0 at centre, 1.0 at the canvas corners (circle edge).
      float rn = length(c) * 0.7071067811865475;

      // Ease-out zoom from centre: (1-rn)^2 scaled to 50% effect.
      // Centre gets half zoom, edges stay glued to the corners; u_crop then
      // scales the whole result past the canvas edge (uniform clip).
      float blend = 0.5 * (1.0 - rn) * (1.0 - rn);
      float rnZ = rn * mix(1.0, 1.0 / u_zoom, blend) / u_crop;

      // Convert normalized radius rnZ [0,1] to polar angle theta [0, pi/2].
      // For the disc, rnZ=1 corresponds to theta=pi/2 (equator).
      float theta = rnZ * (LP_PI / 2.0);

      // Apply projection type to compute the sampling radius in the equirectangular.
      // u_projType: 0 = equidistant (r = theta), 1 = stereographic (r = 2*tan(theta/2)),
      // 2 = orthographic (r = sin(theta)).
      float r;
      if (u_projType == 1) {
        // Stereographic: projects sphere from pole to plane.
        r = 2.0 * tan(theta * 0.5);
      } else if (u_projType == 2) {
        // Orthographic: parallel projection (like a distant camera).
        r = sin(theta);
      } else {
        // Equidistant (default): linear in angle.
        r = theta;
      }

      // Latitude: nadir (v=1) at centre, zenith (v=0) at circle edge.
      float v = 1.0 - r;

      // Azimuth.
      float thetaAz = atan(c.x, -c.y);
      float u = fract((thetaAz + LP_PI + u_yaw) / (2.0 * LP_PI));

      // Standard little planet: u_flip inverts latitude AND mirrors azimuth
      // (producing the view of a source rotated 180 degrees).
      vec4 color = texture(u_tex, vec2(u_flip > 0.5 ? 1.0 - u : u, u_flip > 0.5 ? (1.0 - v) : v));

      // Watermark: fixed size, uses un-zoomed rn so it does not scale.  Keyed
      // on screen space (theta, rn), so the decal stays at the centre of the
      // image in BOTH projections (in flipped mode it covers the zenith
      // content at the centre).
      if (u_wmBOn > 0.5 || u_wmTOn > 0.5) {
        float wm_u2 = fract((theta + LP_PI) / (2.0 * LP_PI));
        float wm_v2 = 1.0 - rn;
        vec2 wm_uv2 = vec2(wm_u2, 1.0 - wm_v2);
        if (u_wmBOn > 0.5) {
          color = vec4(s360CompositeWM(color.rgb, u_wmB, wm_uv2, u_wmBSize, u_wmBAlpha, u_wmBRot, 0.0), color.a);
        }
        if (u_wmTOn > 0.5) {
          color = vec4(s360CompositeWM(color.rgb, u_wmT, wm_uv2, u_wmTSize, u_wmTAlpha, u_wmTRot, 1.0), color.a);
        }
      }

      fragColor = color;
    }`;
})(window.S360);
