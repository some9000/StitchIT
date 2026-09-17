// warp-projection.js — pure CPU inverse (reverse) deformation-map math.
// The map lives in fixed session VIEW coordinates (overlay pixels) and, for each
// RESULT point, records the ORIGINAL point to sample from. Initially W(p)=p.
// Each brush step composes in order: W_next(p) = W_prev(p - delta*strength*falloff(p)).
// Worker-safe (mirrors drawing-projection.js); this module is the reference oracle
// that the later GPU deformation (warp-gpu.js) and the final source bake replicate.
// Map format: Float32Array(width*height*2), per-pixel [srcX, srcY] on the same
// continuous view grid as the projection helpers (identity = plain ramp).
globalThis.S360 = globalThis.S360 || {};
(function (S360) {
'use strict';
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // Smooth brush falloff: 1 at the centre, 0 at/near the radius edge, with a
  // zero derivative at both ends (smoothstep complement) so strokes do not form
  // a hard crease at the brush rim.
  function falloff(dist, radius) {
    if (radius <= 0) return 0;
    const d = clamp(dist / radius, 0, 1);
    return 1 - d * d * (3 - 2 * d);
  }

  // Identity map: result pixel (i,j) sources from (i,j).
  function makeMap(width, height) {
    const map = new Float32Array(width * height * 2);
    for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
      const o = (j * width + i) * 2;
      map[o] = i; map[o + 1] = j;
    }
    return map;
  }

  // Bilinear sample of a map at a fractional view coordinate, clamp-to-edge.
  // Identity is a linear ramp, so sampling an identity map reproduces (x,y)
  // exactly. `out` optionally receives [x,y] to avoid per-pixel allocation.
  function sample(map, width, height, x, y, out) {
    if (!out) out = [0, 0];
    const cx = clamp(x, 0, width - 1), cy = clamp(y, 0, height - 1);
    const ix0 = Math.floor(cx), iy0 = Math.floor(cy);
    const ix1 = Math.min(ix0 + 1, width - 1), iy1 = Math.min(iy0 + 1, height - 1);
    const tx = cx - ix0, ty = cy - iy0;
    const a = (iy0 * width + ix0) * 2, b = (iy0 * width + ix1) * 2;
    const c = (iy1 * width + ix0) * 2, d = (iy1 * width + ix1) * 2;
    const omx = 1 - tx, omy = 1 - ty;
    out[0] = map[a] * omx * omy + map[b] * tx * omy + map[c] * omx * ty + map[d] * tx * ty;
    out[1] = map[a + 1] * omx * omy + map[b + 1] * tx * omy + map[c + 1] * omx * ty + map[d + 1] * tx * ty;
    return out;
  }

  // One brush step: compose W_next from W_prev. `step` = { center:{x,y},
  // delta:[dx,dy], strength, radius }. delta is the cursor movement for this
  // step (already subdivided by decompose(), never larger than ~half a radius).
  function applyStep(map, width, height, step) {
    const { center, delta, strength } = step;
    const next = new Float32Array(width * height * 2);
    const tmp = [0, 0];
    const sx = delta[0] * strength, sy = delta[1] * strength;
    for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
      const f = falloff(Math.hypot(i - center.x, j - center.y), step.radius);
      sample(map, width, height, i - sx * f, j - sy * f, tmp);
      const o = (j * width + i) * 2;
      next[o] = tmp[0]; next[o + 1] = tmp[1];
    }
    return next;
  }

  // Split a polyline of cursor points into brush steps small enough to avoid
  // aliasing and folds. Each substep's delta magnitude is capped by `maxStep`
  // (default a fraction of the radius). Every substep applies the same strength,
  // so the total displacement is ~delta*strength*falloff along the segment.
  function decompose(points, options) {
    const radius = options.radius, strength = options.strength ?? 1;
    const cap = options.maxStep != null ? options.maxStep : Math.max(1, radius * 0.4);
    const steps = [];
    for (let k = 0; k < points.length - 1; k++) {
      const a = points[k], b = points[k + 1];
      const dx = b.x - a.x, dy = b.y - a.y;
      const mag = Math.hypot(dx, dy);
      if (mag < 1e-9) continue;
      const n = Math.max(1, Math.ceil(mag / cap));
      for (let s = 0; s < n; s++) {
        const t0 = s / n, t1 = (s + 1) / n;
        steps.push({
          center: { x: a.x + dx * (t0 + t1) / 2, y: a.y + dy * (t0 + t1) / 2 },
          delta: [dx / n, dy / n],
          strength, radius
        });
      }
    }
    return steps;
  }

  // Remove pointer-event density without changing the visible path. Sub-pixel
  // deviations do not affect the native-image result, but retaining every raw
  // event makes final baking O(affected pixels × pointer events).
  function simplifyPoints(points, tolerance = 0.75) {
    if (!points || points.length < 3 || tolerance <= 0) return points ? points.slice() : [];
    const keep = new Uint8Array(points.length); keep[0] = keep[points.length - 1] = 1;
    const stack = [[0, points.length - 1]], limit = tolerance * tolerance;
    while (stack.length) {
      const [first, last] = stack.pop(), a = points[first], b = points[last];
      const vx = b.x - a.x, vy = b.y - a.y, length2 = vx * vx + vy * vy;
      let farthest = -1, farthest2 = limit;
      for (let i = first + 1; i < last; i++) {
        const p = points[i]; let dx, dy;
        if (length2 <= 1e-12) { dx = p.x - a.x; dy = p.y - a.y; }
        else {
          const t = clamp(((p.x - a.x) * vx + (p.y - a.y) * vy) / length2, 0, 1);
          dx = p.x - (a.x + vx * t); dy = p.y - (a.y + vy * t);
        }
        const distance2 = dx * dx + dy * dy;
        if (distance2 > farthest2) { farthest2 = distance2; farthest = i; }
      }
      if (farthest >= 0) { keep[farthest] = 1; stack.push([first, farthest], [farthest, last]); }
    }
    return points.filter((_, i) => keep[i]);
  }

  // Convenience: decompose then apply all steps in order, returning the composed map.
  function applyStroke(map, width, height, points, options) {
    let m = map;
    for (const step of decompose(points, options)) m = applyStep(m, width, height, step);
    return m;
  }

  // Evaluate the composed inverse stroke at one point without allocating a
  // dense view-sized map. Composition is traversed newest-to-oldest because
  // Wn(p) = T1(T2(...Tn(p))). This is the final-bake fast path.
  function sampleSteps(steps, x, y, out) {
    let qx=x,qy=y;
    for(let i=steps.length-1;i>=0;i--){
      const step=steps[i],dx=qx-step.center.x,dy=qy-step.center.y,r=step.radius;
      if(Math.abs(dx)>=r||Math.abs(dy)>=r)continue;
      const distance2=dx*dx+dy*dy;if(distance2>=r*r)continue;
      const t=Math.sqrt(distance2)/r,f=1-t*t*(3-2*t);
      qx-=step.delta[0]*step.strength*f;qy-=step.delta[1]*step.strength*f;
    }
    if(!out)out=[0,0];out[0]=qx;out[1]=qy;return out;
  }

  S360.warpProjection = { falloff, makeMap, sample, sampleSteps, applyStep, decompose, simplifyPoints, applyStroke };
})(globalThis.S360);
