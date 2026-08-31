// shaders.js
window.S360 = window.S360 || {};
(function (S360) {
  // Separable Gaussian blur used to precompute the low-frequency source layer.
  S360.BLUR_VS = `#version 300 es
    layout(location = 0) in vec2 a_position;
    out vec2 v_uv;
    void main() {
      v_uv = a_position * 0.5 + 0.5;
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `;

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

  // 3-lobe Lanczos upscaling shaders (separable: horizontal + vertical passes)
  S360.LANCZOS_VS = `#version 300 es
    layout(location = 0) in vec2 a_position;
    out vec2 v_uv;
    void main() {
      v_uv = a_position * 0.5 + 0.5;
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `;

  S360.LANCZOS_H_FS = `#version 300 es
    precision highp float;
    in vec2 v_uv;
    out vec4 fragColor;
    uniform sampler2D u_tex;
    uniform vec2 u_inputSize;   // input texture size in pixels
    uniform vec2 u_outputSize;  // output texture size in pixels

    const int LOBES = 3;
    const float PI = 3.14159265358979323846;

    float lanczos(float x) {
      float absx = abs(x);
      if (absx >= float(LOBES)) return 0.0;
      if (absx < 1e-6) return 1.0;
      float pix = PI * absx;
      return float(LOBES) * sin(pix) * sin(pix / float(LOBES)) / (pix * pix);
    }

    void main() {
      // Pixel-centre mapping. Evaluate the kernel at the fractional distance
      // from each real source sample (the old integer-tap evaluation made every
      // non-central sinc weight zero).
      float outX = v_uv.x * u_outputSize.x - 0.5;
      float inX = (outX + 0.5) * u_inputSize.x / u_outputSize.x - 0.5;
      float baseX = floor(inX);

      vec4 sum = vec4(0.0);
      float wSum = 0.0;

      // 3-lobe Lanczos: 7 taps (-3 to +3)
      for (int i = -3; i <= 3; i++) {
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

    const int LOBES = 3;
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

      // 3-lobe Lanczos: 7 taps (-3 to +3)
      for (int i = -3; i <= 3; i++) {
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

  S360.VS_SOURCE = `#version 300 es
  layout(location = 0) in vec2 a_position;
  out vec2 v_uv;
  void main() {
      v_uv = a_position * 0.5 + 0.5;
      gl_Position = vec4(a_position, 0.0, 1.0);
  }
  `;

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
  uniform float u_hfBandWidth;
  uniform float u_seamShift;
  uniform vec3 u_axisL;
  uniform vec3 u_upL;
  uniform vec3 u_rightL;
  uniform vec3 u_axisR;
  uniform vec3 u_upR;
  uniform vec3 u_rightR;
  uniform float u_heightLL;
  uniform float u_heightLR;
  uniform float u_heightRL;
  uniform float u_heightRR;
  uniform float u_centerLL;
  uniform float u_centerLR;
  uniform float u_centerRL;
  uniform float u_centerRR;
  uniform int u_schematicMode;
  uniform float u_rollL;
  uniform float u_rollR;
  uniform int u_guideOn;
  uniform vec2 u_guidePos;

  #define PI 3.14159265358979323846

  struct LensResult {
      vec2 sxsy;
      float w;
      float theta;
      float az;
      bool hit;
  };

  vec2 projectLens(vec3 v, vec3 axis, vec3 up, vec3 right, vec2 center,
                   float heightL, float heightR, float centerOffL, float centerOffR) {
      float dotAxis = dot(v, axis);
      float theta = acos(clamp(dotAxis, -1.0, 1.0));
      float vu = dot(v, up);
      float vr = dot(v, right);
      float az = atan(vr, vu);
      float dist = u_f * theta;
      float ht = (sin(az) + 1.0) * 0.5;
      float hf = mix(heightL, heightR, ht);
      float wL = pow(max(0.0, 1.0 - 2.0 * ht), 3.0);
      float wR = pow(max(0.0, 2.0 * ht - 1.0), 3.0);
      float co = (centerOffL * wL + centerOffR * wR) * u_srcSize.y * 0.01;
      float radialFade = theta / u_halfFov;
      radialFade *= radialFade;
      vec2 d = vec2(dist * sin(az), -dist * cos(az) / hf + co * radialFade);
      return center + d;
  }

  LensResult mapLens(vec3 v, vec3 axis, vec3 up, vec3 right, vec2 center,
                      float heightL, float heightR, float centerOffL, float centerOffR) {
      LensResult res;
      res.hit = false;
      res.w = 0.0;
      res.theta = 0.0;
      res.az = 0.0;
      res.sxsy = vec2(0.0);

      float dotAxis = dot(v, axis);
      float theta = acos(clamp(dotAxis, -1.0, 1.0));
      if (theta > u_halfFov) return res;
      vec2 s = projectLens(v, axis, up, right, center, heightL, heightR, centerOffL, centerOffR);
      if (dot(s - center, s - center) > u_radius * u_radius) return res;
      res.sxsy = s;
      res.w = clamp(1.0 - (theta / u_halfFov), 0.0, 1.0);
      res.theta = theta;
      res.az = atan(dot(v, right), dot(v, up));
      res.hit = true;
      return res;
  }

  vec4 sampleSource(vec2 pixelCoord) {
      vec2 texCoord = vec2(pixelCoord.x / u_srcSize.x, 1.0 - (pixelCoord.y / u_srcSize.y));
      return texture(u_image, texCoord);
  }

  vec3 sampleSourceLF(vec2 pixelCoord) {
      vec2 texCoord = vec2(pixelCoord.x / u_srcSize.x, 1.0 - (pixelCoord.y / u_srcSize.y));
      return texture(u_imageLF, texCoord).rgb;
  }

  float sdCircle(vec2 p, vec2 c, float r) {
      return length(p - c) - r;
  }

  float sdEllipse(vec2 p, vec2 c, vec2 radius) {
      vec2 d = p - c;
      float f = (d.x*d.x)/(radius.x*radius.x) + (d.y*d.y)/(radius.y*radius.y) - 1.0;
      vec2 grad = 2.0 * d / (radius * radius);
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

  vec3 schematicOverlay(vec3 base, vec2 px) {
      vec3 color = base;
      float lineW = 10.0;
      float r = u_radius;
      float band = clamp(r * u_hfBandWidth, 0.0, r * 0.9);
      float rIn = max(r - band, 1.0);
      float fovRadius = r * ((PI / 2.0) / max(u_halfFov, 0.001));

      vec2 halfScreen = u_srcSize * 0.5;
      vec2 leftBoxMin = vec2(0.0, 0.0);
      vec2 leftBoxMax = vec2(halfScreen.x, u_srcSize.y);
      vec2 rightBoxMin = vec2(halfScreen.x, 0.0);
      vec2 rightBoxMax = u_srcSize;

      // Left lens
      float hfL = (u_heightLL + u_heightLR) / 200.0;
      color = mixStroke(color, vec3(0.20, 0.50, 1.00), 0.25, sdCircle(px, u_centersL, r), lineW);
      color = mixStroke(color, vec3(0.20, 0.50, 1.00), 0.50, sdEllipse(px, u_centersL, vec2(rIn, rIn / hfL)), lineW);
      color = mixStroke(color, vec3(1.00, 0.55, 0.00), 1.00, sdEllipse(px, u_centersL, vec2(r, r / hfL)), lineW);
      color = mixRotatedCrossSegments(color, px, u_centersL, u_rollL, leftBoxMin, leftBoxMax, vec3(1.00, 0.55, 0.00), 0.50, lineW);

      // Right lens
      float hfR = (u_heightRL + u_heightRR) / 200.0;
      color = mixStroke(color, vec3(0.20, 0.50, 1.00), 0.25, sdCircle(px, u_centersR, r), lineW);
      color = mixStroke(color, vec3(0.20, 0.50, 1.00), 0.50, sdEllipse(px, u_centersR, vec2(rIn, rIn / hfR)), lineW);
      color = mixStroke(color, vec3(1.00, 0.55, 0.00), 1.00, sdEllipse(px, u_centersR, vec2(r, r / hfR)), lineW);
      color = mixRotatedCrossSegments(color, px, u_centersR, u_rollR, rightBoxMin, rightBoxMax, vec3(1.00, 0.55, 0.00), 0.50, lineW);

      // FOV / 180° hemisphere reference (green)
      color = mixStroke(color, vec3(0.00, 0.85, 0.20), 0.60, sdEllipse(px, u_centersL, vec2(fovRadius, fovRadius / hfL)), lineW);
      color = mixStroke(color, vec3(0.00, 0.85, 0.20), 0.60, sdEllipse(px, u_centersR, vec2(fovRadius, fovRadius / hfR)), lineW);

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
      float pyNorm = 1.0 - v_uv.y;

      float vLat = pyNorm * PI - (PI / 2.0);
      float vLon = pxNorm * 2.0 * PI;
      float cosLat = cos(vLat);
      vec3 v = vec3(cosLat * cos(vLon), cosLat * sin(vLon), sin(vLat));

      LensResult resR = mapLens(v, u_axisR, u_upR, u_rightR, u_centersR,
                                u_heightRL / 100.0, u_heightRR / 100.0, u_centerRL, u_centerRR);
      LensResult resL = mapLens(v, u_axisL, u_upL, u_rightL, u_centersL,
                                u_heightLL / 100.0, u_heightLR / 100.0, u_centerLL, u_centerLR);

      // Schematic overlay: show the raw dual-fisheye source with geometry guides
      // (ideal circles, seam blend band, rotated center axes).
      if (u_schematicMode == 1) {
          vec2 px = vec2(v_uv.x * u_srcSize.x, (1.0 - v_uv.y) * u_srcSize.y);
          vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y);
          vec3 color = texture(u_image, uv).rgb;
          color = schematicOverlay(color, px);
          fragColor = vec4(color, 1.0);
          return;
      }

      // Two-band Laplacian-style seam: low frequencies cross-fade broadly to
      // hide exposure/vignetting changes; detail chooses one lens decisively.
      // u_seamCurve contains the best left-lens angle for each azimuth around
      // the overlap belt, found from colour and gradient disagreement.

      vec3 colorL_raw = resL.hit ? sampleSource(resL.sxsy).rgb : vec3(0.0);
      vec3 colorR_raw = resR.hit ? clamp(sampleSource(resR.sxsy).rgb * u_gainR, 0.0, 1.0) : vec3(0.0);

      if (resL.hit && resR.hit) {
          float seamTheta = texture(u_seamCurve, vec2(fract((resL.az + PI) / (2.0 * PI)), 0.5)).r + u_seamShift;
          float thetaNorm = resL.theta / u_halfFov;
          float halfW = max(0.005, u_hfBandWidth);
          float wLF = 1.0 - smoothstep(seamTheta - min(0.48, halfW * 1.8),
                                       seamTheta + min(0.48, halfW * 1.8), thetaNorm);
          // Detail half-width: derived from the seam width so a single slider
          // controls both bands.  The detail band is always narrower (30% of
          // the LF width, minimum 0.004) so high-frequency content picks one
          // lens decisively while the LF cross-fade hides exposure differences.
          float detailHalfWidth = min(0.48, max(0.004, halfW * 0.3));
          float wHF = 1.0 - smoothstep(seamTheta - detailHalfWidth,
                                       seamTheta + detailHalfWidth, thetaNorm);
          vec3 colorL_lf = sampleSourceLF(resL.sxsy);
          vec3 colorR_lf = clamp(sampleSourceLF(resR.sxsy) * u_gainR, 0.0, 1.0);

          vec3 colorL_hf = colorL_raw - colorL_lf;
          vec3 colorR_hf = colorR_raw - colorR_lf;

          vec3 blendedLF = mix(colorR_lf, colorL_lf, wLF);
          vec3 blendedHF = mix(colorR_hf, colorL_hf, wHF);

          vec3 color = clamp(blendedLF + blendedHF, 0.0, 1.0);
          if (u_showSeam == 1) {
              float seamDistance = abs(thetaNorm - seamTheta);
              // A translucent band makes detail-width adjustments inspectable;
              // cyan marks the centre and orange marks each transition edge.
              if (seamDistance < detailHalfWidth) color = mix(color, vec3(0.0, 0.75, 0.68), 0.20);
              if (abs(seamDistance - detailHalfWidth) < 0.004) color = mix(color, vec3(1.0, 0.50, 0.0), 0.80);
              if (seamDistance < 0.004) color = mix(color, vec3(0.0, 1.0, 0.85), 0.80);
          }
          fragColor = vec4(color, 1.0);
      } else if (resL.hit) {
          fragColor = vec4(colorL_raw, 1.0);
      } else if (resR.hit) {
          fragColor = vec4(colorR_raw, 1.0);
      } else {
          bool useRight = v.x >= 0.0;
          vec2 s = projectLens(v,
              useRight ? u_axisR : u_axisL,
              useRight ? u_upR : u_upL,
              useRight ? u_rightR : u_rightL,
              useRight ? u_centersR : u_centersL,
              useRight ? u_heightRL / 100.0 : u_heightLL / 100.0,
              useRight ? u_heightRR / 100.0 : u_heightLR / 100.0,
              useRight ? u_centerRL : u_centerLL,
              useRight ? u_centerRR : u_centerLR);
          vec3 color = sampleSource(s).rgb;
          if (useRight) color = clamp(color * u_gainR, 0.0, 1.0);
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
      return dot(color, vec3(0.299, 0.587, 0.114));
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
                       float saturation, float contrast, float temp) {
      color *= exposure;
      color = pow(color, vec3(gamma));

      if (sharpen > 0.0) {
        float origLum = luminance(color);
        float detail = origLum - blurLum;
        float newLum = clamp(origLum + detail * sharpen, 0.0, 1.0);
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
    const vsSource = `#version 300 es
      layout(location = 0) in vec2 a_position;
      out vec2 v_uv;
      void main() {
        v_uv = a_position * 0.5 + 0.5;
        gl_Position = vec4(a_position, 0.0, 1.0);
      }
    `;

    const fsSource = `#version 300 es
      precision highp float;
      in vec2 v_uv;
      out vec4 fragColor;
      uniform sampler2D u_texture;
      uniform sampler2D u_blurLum; // half-res blurred luminance for the unsharp mask
      uniform float u_exposure;
      uniform float u_gamma;
      uniform float u_sharpen;
      uniform float u_saturation;
      uniform float u_contrast;
      uniform float u_temp;       // colour temperature in Kelvin (e.g. 2000..12000)

      ${S360.POST_GLSL}

      void main() {
        vec3 color = texture(u_texture, v_uv).rgb;
        float blurLum = texture(u_blurLum, v_uv).r;
        color = s360ApplyPost(color, blurLum, u_exposure, u_gamma, u_sharpen,
                              u_saturation, u_contrast, u_temp);
        fragColor = vec4(color, 1.0);
      }
    `;

    return S360.createProgram(gl, vsSource, fsSource);
  };
})(window.S360);
