// align.js - bounded-memory coarse and native-patch registration for fusion.
// Owns DOM image sampling, reference ranking, per-lens refinement, and the
// worker handoff; pure correlation math lives in frame-registration.js.
window.S360 = window.S360 || {};
(function (S360) {
'use strict';

  function medianQuickSelect(arr) {
    if (!arr.length) return 0.5;
    const k = arr.length >> 1;
    let lo = 0, hi = arr.length - 1;
    while (lo < hi) {
      const pivot = arr[lo + ((hi - lo) >> 1)];
      let i = lo, j = hi;
      while (i <= j) {
        while (arr[i] < pivot) i++;
        while (arr[j] > pivot) j--;
        if (i <= j) { const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp; i++; j--; }
      }
      if (k <= j) hi = j;
      else if (k >= i) lo = i;
      else break;
    }
    return arr[k];
  }

  function proxyFromImage(img, cfg, stitched) {
    const w = Math.min(640, img.width);
    const h = Math.max(1, Math.round(img.height * w / img.width));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const rgba = ctx.getImageData(0, 0, w, h).data;
    const gray = new Float32Array(w * h);
    const mask = new Uint8Array(w * h);
    const values = [];
    let sharpness = 0, sampled = 0, usable = 0;
    const base=Math.min(w*.25,h*.5),lens=stitched?null:S360.lensParams(cfg,base);
    const validPixel = stitched ? (()=>true) : ((x,y)=>{
      for(const side of ['left','right']){
        const center=cfg.centers[side],dx=x-w*center[0],dy=y-h*center[1],a=-cfg.angle[side]*Math.PI/180,c=Math.cos(a),s=Math.sin(a);
        const rx=(dx*c-dy*s)/(1-cfg.width[side]/100),ry=(dx*s+dy*c)/(1-cfg.height[side]/100);
        if(rx*rx+ry*ry<=lens.radiusOuter*lens.radiusOuter)return true;
      }
      return false;
    });
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x, i = p * 4;
      const r = rgba[i] / 255, g = rgba[i + 1] / 255, b = rgba[i + 2] / 255;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      gray[p] = lum;
      const valid=validPixel(x,y);mask[p]=valid?1:0;
      if (valid&&x % 5 === 0) {
        sampled++;
        if (lum > 0.006 && lum < 0.994) { values.push(lum); usable++; }
      }
    }
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      if(!mask[p]||!mask[p-1]||!mask[p+1]||!mask[p-w]||!mask[p+w])continue;
      const lap = 4 * gray[p] - gray[p - 1] - gray[p + 1] - gray[p - w] - gray[p + w];
      sharpness += lap * lap;
    }
    const median = medianQuickSelect(values);
    const { gradX, gradY } = S360.frameRegistration.computeGradients(gray, w, h);
    return { gray, gradX, gradY, w, h, sourceW: img.width, sourceH: img.height,
      sharpness: sharpness / Math.max(1, (w - 2) * (h - 2)), median,
      usableFraction: usable / Math.max(1, sampled) };
  }

  function nativePatch(img, cx, cy, size, scratch) {
    const half = size / 2;
    if (cx-half < 1 || cy-half < 1 || cx+half >= img.width-1 || cy+half >= img.height-1) return null;
    scratch.width = size; scratch.height = size;
    const context = scratch.getContext('2d', { willReadFrequently: true });
    context.clearRect(0, 0, size, size);
    context.drawImage(img, cx-half, cy-half, size, size, 0, 0, size, size);
    const rgba = context.getImageData(0, 0, size, size).data;
    const gray = new Float32Array(size*size);
    for (let p = 0, i = 0; p < gray.length; p++, i += 4) {
      const y = (.2126*rgba[i]+.7152*rgba[i+1]+.0722*rgba[i+2])/255;
      gray[p] = Math.log(.02+y); // gradients remain comparable across exposure brackets
    }
    const gradients = S360.frameRegistration.computeGradients(gray, size, size);
    let energy = 0;
    for (let p = 0; p < gray.length; p++) energy += gradients.gradX[p]**2+gradients.gradY[p]**2;
    return { gray, energy:energy/(size*size) };
  }

  function referenceLensPatches(img, side, cfg, scratch) {
    const size = Math.max(96, Math.min(160, Math.round(img.height/32)));
    const center = cfg?.centers?.[side] || [side === 'left' ? .25 : .75, .5];
    const cx = center[0]*img.width, cy = center[1]*img.height;
    const radius = .5*img.height*Math.min(1, Math.max(.8, (cfg?.outerMargin ?? 100)/100));
    const points = [[0,0]];
    for (const ring of [.28,.56]) {
      const count = ring < .4 ? 4 : 8;
      for (let i = 0; i < count; i++) {
        const angle = (i+.5*(ring>.4))*Math.PI*2/count;
        points.push([Math.cos(angle)*radius*ring,Math.sin(angle)*radius*ring]);
      }
    }
    return points.map(([x,y]) => {
      const patch = nativePatch(img,cx+x,cy+y,size,scratch);
      return patch && { ...patch, cx:cx+x, cy:cy+y, nx:x/radius, ny:y/radius, size };
    }).filter(Boolean).sort((a,b)=>b.energy-a.energy).slice(0,6);
  }

  function median(values) {
    if (!values.length) return 0;
    const sorted = values.slice().sort((a,b)=>a-b), mid = sorted.length>>1;
    return sorted.length&1 ? sorted[mid] : .5*(sorted[mid-1]+sorted[mid]);
  }

  function refineLens(img, refs, coarse, scratch) {
    const estimates = [];
    for (const ref of refs) {
      const cur = nativePatch(img,ref.cx+coarse[0],ref.cy+coarse[1],ref.size,scratch);
      if (!cur) continue;
      const fit = S360.frameRegistration.refinePatch(ref.gray,cur.gray,ref.size,ref.size);
      if (!fit.rejected) estimates.push({ x:coarse[0]+fit.dx, y:coarse[1]+fit.dy,
        nx:ref.nx,ny:ref.ny,confidence:fit.confidence });
    }
    if (estimates.length < 2) return { offset:coarse, confidence:0, count:estimates.length };
    const mx=median(estimates.map(v=>v.x)),my=median(estimates.map(v=>v.y));
    const distances=estimates.map(v=>Math.hypot(v.x-mx,v.y-my)),mad=median(distances);
    const kept=estimates.filter((v,i)=>distances[i] <= Math.max(.65,2.5*mad));
    if (kept.length < 2) return { offset:coarse, confidence:0, count:kept.length };
    let sx=0,sy=0,sw=0;
    for (const v of kept) { const weight=v.confidence*v.confidence;sx+=v.x*weight;sy+=v.y*weight;sw+=weight; }
    const offset=sw ? [sx/sw,sy/sw] : [mx,my];
    function fitAxis(key) {
      const m=[[0,0,0,0],[0,0,0,0],[0,0,0,0]];
      for(const v of kept){const q=[1,v.nx,v.ny],weight=v.confidence*v.confidence;
        for(let row=0;row<3;row++){for(let col=0;col<3;col++)m[row][col]+=weight*q[row]*q[col];m[row][3]+=weight*q[row]*v[key];}}
      for(let pivot=0;pivot<3;pivot++){
        let best=pivot;for(let row=pivot+1;row<3;row++)if(Math.abs(m[row][pivot])>Math.abs(m[best][pivot]))best=row;
        if(Math.abs(m[best][pivot])<1e-7)return null;
        [m[pivot],m[best]]=[m[best],m[pivot]];const divisor=m[pivot][pivot];for(let col=pivot;col<4;col++)m[pivot][col]/=divisor;
        for(let row=0;row<3;row++)if(row!==pivot){const factor=m[row][pivot];for(let col=pivot;col<4;col++)m[row][col]-=factor*m[pivot][col];}
      }
      return [m[0][3],m[1][3],m[2][3]];
    }
    let ax=kept.length>=4?fitAxis('x'):null,ay=kept.length>=4?fitAxis('y'):null;
    const stable=(fit,base)=>fit&&fit.every(Number.isFinite)&&Math.abs(fit[0]-base)<1.5&&Math.hypot(fit[1],fit[2])<8;
    if(!stable(ax,offset[0]))ax=null;if(!stable(ay,offset[1]))ay=null;
    return { offset, affine:{ x:ax||[offset[0],0,0], y:ay||[offset[1],0,0] },
      confidence:kept.reduce((sum,v)=>sum+v.confidence,0)/kept.length, count:kept.length };
  }

  async function refineDualFisheye(files, frames, referenceIndex, loadImage, setLoading, shouldCancel, cfg) {
    let reference = null;
    const scratch = document.createElement('canvas');
    try {
      setLoading(true, 'Preparing native lens registration...');
      reference = await loadImage(files[referenceIndex]);
      const refs = {
        left:referenceLensPatches(reference,'left',cfg,scratch),
        right:referenceLensPatches(reference,'right',cfg,scratch)
      };
      frames[referenceIndex].lensOffsets = { left:[0,0], right:[0,0] };
      frames[referenceIndex].lensTransforms = {
        left:{x:[0,0,0],y:[0,0,0]},right:{x:[0,0,0],y:[0,0,0]}
      };
      for (let i = 0; i < files.length; i++) {
        if (i === referenceIndex) continue;
        if (shouldCancel?.()) throw new DOMException('Processing cancelled.', 'AbortError');
        setLoading(true, `Refining frame ${i+1} of ${files.length} at native resolution...`);
        let image = null;
        try {
          image = await loadImage(files[i]);
          if (image.width !== reference.width || image.height !== reference.height) continue;
          const coarse = frames[i].offset;
          const left=refineLens(image,refs.left,coarse,scratch),right=refineLens(image,refs.right,coarse,scratch);
          frames[i].lensOffsets = { left:left.offset, right:right.offset };
          frames[i].lensTransforms = { left:left.affine||{x:[left.offset[0],0,0],y:[left.offset[1],0,0]},
            right:right.affine||{x:[right.offset[0],0,0],y:[right.offset[1],0,0]} };
          const nativeConfidence=Math.max(left.confidence,right.confidence);
          if (nativeConfidence) frames[i].confidence=Math.max(frames[i].confidence,nativeConfidence);
          frames[i].nativeRegistration = { leftCount:left.count, rightCount:right.count };
        } finally { S360.releaseImage(image); }
        await S360.yieldToUI();
      }
    } finally { S360.releaseImage(reference); }
  }

  async function registerInWorker(proxies, referenceIndex, stitched) {
    if (typeof Worker === 'undefined') return null;
    let worker;
    try { worker = new Worker('align-worker.js'); } catch (_) { return null; }
    const payload = proxies.map(p => ({ w: p.w, h: p.h, buffer: p.gray.slice().buffer }));
    const transfers = payload.map(p => p.buffer);
    return new Promise(resolve => {
      const timer = setTimeout(() => { worker.terminate(); resolve(null); }, 30000);
      worker.onmessage = e => {
        clearTimeout(timer); worker.terminate();
        resolve(e.data?.error ? null : e.data.registrations);
      };
      worker.onerror = () => { clearTimeout(timer); worker.terminate(); resolve(null); };
      worker.postMessage({ proxies: payload, referenceIndex, wrap: stitched }, transfers);
    });
  }

  S360.analyzeFrameFiles = async function (files, loadImage, setLoading, shouldCancel, stitched = false, cfg = null) {
    const proxies = [];
    for (let i = 0; i < files.length; i++) {
      if (shouldCancel && shouldCancel()) throw new DOMException('Processing cancelled.', 'AbortError');
      setLoading(true, `Analysing frame ${i + 1} of ${files.length}...`);
      let img = null;
      try { img = await loadImage(files[i]); proxies.push(proxyFromImage(img,cfg,stitched)); }
      finally { S360.releaseImage(img); }
      await S360.yieldToUI();
    }
    const exposureCenter=medianQuickSelect(proxies.map(p=>p.median));
    const ranked = proxies.map((p, i) => {
      const detail=Math.log1p(p.sharpness*1e5);
      const bracketBalance=Math.exp(-Math.pow((p.median-exposureCenter)/.22,2));
      const displayBalance=Math.exp(-Math.pow((p.median-.5)/.45,2));
      // Strongly deprioritize frames with low usable dynamic range (clipped).
      // usableFraction=0 (fully clipped) gets near-zero score; usableFraction<0.1
      // is heavily penalized. The square makes the drop-off quadratic.
      const usableWeight = p.usableFraction * p.usableFraction;
      return {i,score:detail*usableWeight*(.2+.8*bracketBalance)*(.5+.5*displayBalance)};
    })
      .sort((a, b) => b.score - a.score);
    const referenceIndex = ranked[0].i, ref = proxies[referenceIndex];
    const workerRegs = await registerInWorker(proxies, referenceIndex, stitched);
    const frames = proxies.map((p, i) => {
      const reg = workerRegs?.[i] || (i === referenceIndex ? { dx: 0, dy: 0, confidence: 1 } : S360.frameRegistration.register(ref, p, stitched));
      return {
        // scoreShift compares reference(x,y) with current(x+dx,y+dy), so the
        // fusion shader must sample the current frame at that SAME positive
        // displacement. The previous negation shifted X in the wrong direction.
        offset: [reg.dx * p.sourceW / p.w, reg.dy * p.sourceH / p.h],
        sourceSize: [p.sourceW, p.sourceH],
        confidence: reg.confidence, sharpness: p.sharpness, median: p.median
      };
    });
    if (!stitched) await refineDualFisheye(files,frames,referenceIndex,loadImage,setLoading,shouldCancel,cfg);
    return { referenceIndex, frames, stitched };
  };
})(window.S360);
