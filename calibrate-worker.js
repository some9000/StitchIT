// calibrate-worker.js - auto-calibrate lens parameters in a Web Worker
// Self-contained: no DOM, no WebGL, pure math + pixel sampling.
// Receives a proxy plus cfg, runs coordinate-descent on 12 parameters,
// and posts back the calibrated cfg (or null if already aligned).

const PI = Math.PI;
const TAU = PI * 2;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// NOTE: The following functions are copies of the canonical versions in
// geometry.js.  Workers cannot import scripts, so they must be self-contained.
// When editing these functions, update ALL copies and this comment.

function rotateAroundAxis(v, axis, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const [ax, ay, az] = axis;
  const dot = v[0] * ax + v[1] * ay + v[2] * az;
  return [
    v[0] * c + s * (ay * v[2] - az * v[1]) + (1 - c) * ax * dot,
    v[1] * c + s * (az * v[0] - ax * v[2]) + (1 - c) * ay * dot,
    v[2] * c + s * (ax * v[1] - ay * v[0]) + (1 - c) * az * dot
  ];
}

function lensBasis(isRight, cfg) {
  const axis = isRight ? [1, 0, 0] : [-1, 0, 0];
  const roll = (isRight ? cfg.rollDeg.right : cfg.rollDeg.left) * PI / 180;
  return {
    axis,
    up: rotateAroundAxis([0, 0, 1], axis, roll),
    right: rotateAroundAxis(isRight ? [0, 1, 0] : [0, -1, 0], axis, roll)
  };
}

function sampleBilinear(proxy, x, y) {
  x = clamp(x, 0, proxy.w - 1); y = clamp(y, 0, proxy.h - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(proxy.w - 1, x0 + 1), y1 = Math.min(proxy.h - 1, y0 + 1);
  const tx = x - x0, ty = y - y0, d = proxy.data;
  const at = (xx, yy, c) => d[(yy * proxy.w + xx) * 4 + c];
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const a = at(x0, y0, c) * (1 - tx) + at(x1, y0, c) * tx;
    const b = at(x0, y1, c) * (1 - tx) + at(x1, y1, c) * tx;
    out[c] = a * (1 - ty) + b * ty;
  }
  return out;
}

function sourcePoint(v, basis, center, radius, halfFov, focal, heightL, heightR, centerOffL, centerOffR, srcH) {
  const dot = clamp(v[0] * basis.axis[0] + v[1] * basis.axis[1] + v[2] * basis.axis[2], -1, 1);
  const theta = Math.acos(dot);
  if (theta > halfFov) return null;
  const vu = v[0] * basis.up[0] + v[1] * basis.up[1] + v[2] * basis.up[2];
  const vr = v[0] * basis.right[0] + v[1] * basis.right[1] + v[2] * basis.right[2];
  const az = Math.atan2(vr, vu);
  const dist = focal * theta;
  const ht = (Math.sin(az) + 1) * 0.5;
  const hf = heightL * (1 - ht) + heightR * ht;
  const rawL = Math.max(0, 1 - 2 * ht);
  const rawR = Math.max(0, 2 * ht - 1);
  const wL = rawL * rawL * rawL;
  const wR = rawR * rawR * rawR;
  const co = (centerOffL * wL + centerOffR * wR) * srcH * 0.01;
  const radialFade = (theta / halfFov);
  const dx = dist * Math.sin(az), dy = -dist * Math.cos(az) / hf + co * radialFade * radialFade;
  if (dx * dx + dy * dy > radius * radius) return null;
  return { x: center[0] + dx, y: center[1] + dy };
}

function calibrate(proxy, imgWidth, imgHeight, cfg) {
  const hf = cfg.fovDeg * PI / 360;
  const f = proxy.w / (2 * hf);
  const r = proxy.w * cfg.radiusScale / 2;
  const L = lensBasis(false, cfg);
  const R = lensBasis(true, cfg);
  const cL = [cfg.centers.left[0] * proxy.scale, cfg.centers.left[1] * proxy.scale];
  const cR = [cfg.centers.right[0] * proxy.scale, cfg.centers.right[1] * proxy.scale];
  const hLL = cfg.height.ll / 100, hLR = cfg.height.lr / 100;
  const hRL = cfg.height.rl / 100, hRR = cfg.height.rr / 100;
  const cLL = cfg.centerOffset.ll, cLR = cfg.centerOffset.lr;
  const cRL = cfg.centerOffset.rl, cRR = cfg.centerOffset.rr;
  const seamExtra = (cfg.blend && cfg.blend.hfBandWidth) || 0;
  const tMin = Math.max(0.01, PI - hf - seamExtra);
  const tMax = Math.min(hf + seamExtra, PI - 0.01);
  let err = 0, n = 0;
  for (let a = 0; a < 256; a++) {
    const az = -PI + (a + 0.5) * TAU / 256;
    for (let t = 0; t < 32; t++) {
      const theta = tMin + t * (tMax - tMin) / 31;
      const st = Math.sin(theta), ct = Math.cos(theta);
      const v = [
        L.axis[0]*ct + L.up[0]*st*Math.cos(az) + L.right[0]*st*Math.sin(az),
        L.axis[1]*ct + L.up[1]*st*Math.cos(az) + L.right[1]*st*Math.sin(az),
        L.axis[2]*ct + L.up[2]*st*Math.cos(az) + L.right[2]*st*Math.sin(az)
      ];
      const pL = sourcePoint(v, L, cL, r, hf, f, hLL, hLR, cLL, cLR, proxy.h);
      const pR = sourcePoint(v, R, cR, r, hf, f, hRL, hRR, cRL, cRR, proxy.h);
      if (!pL || !pR) continue;
      const sL = sampleBilinear(proxy, pL.x, pL.y);
      const sR = sampleBilinear(proxy, pR.x, pR.y);
      const d0 = sL[0]-sR[0], d1 = sL[1]-sR[1], d2 = sL[2]-sR[2];
      err += d0*d0 + d1*d1 + d2*d2;
      n++;
    }
  }
  return n > 0 ? err / n : 1e10;
}

function evalRegCost(proxy, imgWidth, imgHeight, cfg, orig) {
  const raw = calibrate(proxy, imgWidth, imgHeight, cfg);
  const reg = 0.1 * (
    Math.pow((cfg.height.ll - orig.ll), 2) +
    Math.pow((cfg.height.lr - orig.lr), 2) +
    Math.pow((cfg.height.rl - orig.rl), 2) +
    Math.pow((cfg.height.rr - orig.rr), 2) +
    Math.pow((cfg.centerOffset.ll - orig.cll), 2) +
    Math.pow((cfg.centerOffset.lr - orig.clr), 2) +
    Math.pow((cfg.centerOffset.rl - orig.crl), 2) +
    Math.pow((cfg.centerOffset.rr - orig.crr), 2) +
    Math.pow((cfg.centers.left[0] - orig.cL) * 100, 2) +
    Math.pow((cfg.centers.right[0] - orig.cR) * 100, 2) +
    Math.pow((cfg.fovDeg - orig.fov) * 5, 2) +
    Math.pow((cfg.radiusScale - orig.radius) * 100, 2)
  );
  return raw + reg;
}

function g(obj, path) { let o = obj; for (const p of path) o = o[p]; return o; }
function s(obj, path, v) {
  let o = obj; for (let i = 0; i < path.length - 1; i++) o = o[path[i]];
  o[path[path.length - 1]] = v;
}

self.onmessage = function(e) {
  const msg = e.data;
  if (msg.type === 'calibrate') {
    try {
      const { proxy, imgWidth, imgHeight, cfg } = msg;
      const localCfg = JSON.parse(JSON.stringify(cfg));

      const initCost = calibrate(proxy, imgWidth, imgHeight, localCfg);

      if (initCost < 0.001) {
        self.postMessage({ type: 'result', aligned: false });
        return;
      }

      const orig = {
        ll: localCfg.height.ll, lr: localCfg.height.lr,
        rl: localCfg.height.rl, rr: localCfg.height.rr,
        cll: localCfg.centerOffset.ll, clr: localCfg.centerOffset.lr,
        crl: localCfg.centerOffset.rl, crr: localCfg.centerOffset.rr,
        cL: localCfg.centers.left[0], cR: localCfg.centers.right[0],
        fov: localCfg.fovDeg, radius: localCfg.radiusScale
      };

      const params = [
        { p: ['height','ll'], d: [-3,-1,-0.5, 0, 0.5, 1, 3] },
        { p: ['height','lr'], d: [-3,-1,-0.5, 0, 0.5, 1, 3] },
        { p: ['height','rl'], d: [-3,-1,-0.5, 0, 0.5, 1, 3] },
        { p: ['height','rr'], d: [-3,-1,-0.5, 0, 0.5, 1, 3] },
        { p: ['centerOffset','ll'], d: [-1,-0.3,-0.1, 0, 0.1, 0.3, 1] },
        { p: ['centerOffset','lr'], d: [-1,-0.3,-0.1, 0, 0.1, 0.3, 1] },
        { p: ['centerOffset','rl'], d: [-1,-0.3,-0.1, 0, 0.1, 0.3, 1] },
        { p: ['centerOffset','rr'], d: [-1,-0.3,-0.1, 0, 0.1, 0.3, 1] },
        { p: ['centers','left', 0], d: [-0.005,-0.002,-0.001, 0, 0.001, 0.002, 0.005] },
        { p: ['centers','right', 0], d: [-0.005,-0.002,-0.001, 0, 0.001, 0.002, 0.005] },
        { p: ['fovDeg'], d: [-1,-0.3,-0.1, 0, 0.1, 0.3, 1] },
        { p: ['radiusScale'], d: [-0.01,-0.003,-0.001, 0, 0.001, 0.003, 0.01] },
      ];

      let bestCost = evalRegCost(proxy, imgWidth, imgHeight, localCfg, orig);

      for (let pass = 0; pass < 3; pass++) {
        let passImproved = false;
        for (const { p, d } of params) {
          const origVal = g(localCfg, p);
          let bestVal = origVal;
          for (const delta of d) {
            s(localCfg, p, origVal + delta);
            const cost = evalRegCost(proxy, imgWidth, imgHeight, localCfg, orig);
            if (cost < bestCost) { bestCost = cost; bestVal = origVal + delta; passImproved = true; }
          }
          s(localCfg, p, bestVal);
        }
        // Early exit: if no parameter improved in this full pass, further
        // passes won't either — the coordinate descent has converged.
        if (!passImproved) break;
      }

      self.postMessage({
        type: 'result',
        aligned: true,
        cfg: localCfg
      });
    } catch (err) {
      self.postMessage({ type: 'error', message: err.message });
    }
  }
};
