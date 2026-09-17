// Pure source-pixel projection for edits. Requires geometry.js; worker-safe.
globalThis.S360 = globalThis.S360 || {};
(function (S360) {
'use strict';
  const PI = Math.PI, TILE = 64;
  function* tiles(args) {
    const { overlayPixels: pixels, overlayW: w, overlayH: h, source, yaw, pitch, fov, mirror } = args;
    const s = args.proj ?? 1, edge = Math.tan(s * fov / 2), aspect = w / h;
    const cp = Math.cos(pitch), sp = Math.sin(pitch), cy = Math.cos(yaw), sy = Math.sin(yaw);
    const forward = [cp * sy, sp, cp * cy], right = [-cy, 0, sy], up = [-sy * sp, cp, -cy * sp];
    // Conservative angular bound for the painted rectangle and sampling fringe.
    let minX=w,minY=h,maxX=-1,maxY=-1;
    for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(pixels[(y*w+x)*4+3]){
      minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
    }
    if(maxX<0)return;
    const qx=((minX+maxX+1)/w-1)*aspect,qy=1-(minY+maxY+1)/h;
    const qr=Math.hypot(qx,qy),qt=Math.atan(qr*edge)/s,qk=qr>1e-12?Math.sin(qt)/qr:0;
    const cap=forward.map((v,i)=>v*Math.cos(qt)+(right[i]*qx+up[i]*qy)*qk);
    if(mirror)cap[0]=-cap[0];
    // Inverse projection is angularly Lipschitz with bound edge/s.
    const capRadius=Math.min(PI,edge/s*Math.hypot(maxX-minX+2,maxY-minY+2)/h);
    function intersects(dx,dy,dz,radius){
      const total=capRadius+radius;
      return total>=PI || dx*cap[0]+dy*cap[1]+dz*cap[2]>=Math.cos(total)-1e-12;
    }
    const W = source.width, H = source.height, neutral = [1, 1, 1];
    let lenses = null;
    if (!source.stitched) {
      const cfg = source.cfg, lens = S360.lensParams(cfg, Math.min(W / 4, H / 2));
      lenses = ['left', 'right'].map((key, i) => ({
        basis: S360.lensBasis(!!i, cfg), center: [cfg.centers[key][0] * W, cfg.centers[key][1] * H],
        width: 1 - cfg.width[key] / 100, height: 1 - (cfg.height?.[key] ?? 0) / 100,
        angle: cfg.angle[key] * PI / 180, ...lens, gain: i ? source.gain : neutral
      }));
    }
    const vector = [];
    for (let y = 0; y < H; y += TILE) for (let x = 0; x < W; x += TILE) {
      const width = Math.min(TILE, W - x), height = Math.min(TILE, H - y);
      // Tile caps remain conservative at poles, longitude wrap and lens rims.
      if(source.stitched){
        const lon=((x+width/2)/W-.5)*2*PI,lat=(.5-(y+height/2)/H)*PI;
        if(!intersects(Math.sin(lon)*Math.cos(lat),Math.sin(lat),Math.cos(lon)*Math.cos(lat),
          Math.hypot(PI*width/W,PI*height/(2*H)))){yield null;continue;}
      }else{
        let hit=false;
        for(const l of lenses){
          S360.sourceDirection(x+width/2,H-y-height/2,l.basis,l.center,Infinity,Infinity,l.f,l.width,l.angle,l.height,vector);
          const radius=Math.hypot(width,height)/2/(l.f*Math.min(l.width,l.height));
          if(intersects(-vector[1],-vector[2],-vector[0],radius)){hit=true;break;}
        }
        if(!hit){yield null;continue;}
      }
      let data = null;
      for (let ty = 0; ty < height; ty++) for (let tx = 0; tx < width; tx++) {
        const px = x + tx + .5, py = y + ty + .5;
        let dx, dy, dz, gain = neutral;
        if (source.stitched) {
          const lon = (px / W - .5) * 2 * PI, lat = (.5 - py / H) * PI;
          dx = Math.sin(lon) * Math.cos(lat); dy = Math.sin(lat); dz = Math.cos(lon) * Math.cos(lat);
        } else {
          // Raw Y is inverted by sampleSource. Stitch XYZ maps into viewer
          // XYZ as (-y,-z,-x); both orientation inversions must be retained.
          const a = lenses[0], b = lenses[1];
          const l = Math.hypot(px-a.center[0], H-py-a.center[1]) <= Math.hypot(px-b.center[0], H-py-b.center[1]) ? a : b;
          if (!S360.sourceDirection(px, H-py, l.basis, l.center, l.radiusOuter, l.halfFov, l.f, l.width, l.angle, l.height, vector)) continue;
          dx = -vector[1]; dy = -vector[2]; dz = -vector[0]; gain = l.gain || neutral;
        }
        if (mirror) dx = -dx;
        const dot = Math.max(-1, Math.min(1, dx*forward[0]+dy*forward[1]+dz*forward[2]));
        const theta = Math.acos(dot);
        if (s * theta >= PI / 2 || theta >= PI - 1e-7) continue;
        const k = theta < 1e-7 ? s / edge : Math.tan(s * theta) / (Math.sin(theta) * edge);
        const sx = ((dx*right[0]+dz*right[2])*k/aspect+1)*.5*w-.5;
        const sy = (1-(dx*up[0]+dy*up[1]+dz*up[2])*k)*.5*h-.5;
        if (sx < -.5 || sx >= w-.5 || sy < -.5 || sy >= h-.5) continue;
        // Interpolate premultiplied colour so soft edges do not acquire black fringes.
        const ix = Math.floor(sx), iy = Math.floor(sy), fx = sx-ix, fy = sy-iy;
        let alpha=0, r=0, g=0, b=0;
        for(let oy=0;oy<2;oy++)for(let ox=0;ox<2;ox++){
          const xx=ix+ox, yy=iy+oy;if(xx<0||xx>=w||yy<0||yy>=h)continue;
          const i=(yy*w+xx)*4, weight=(ox?fx:1-fx)*(oy?fy:1-fy), a=pixels[i+3]*weight;
          alpha+=a;r+=pixels[i]*a;g+=pixels[i+1]*a;b+=pixels[i+2]*a;
        }
        if(alpha<.5)continue;
        if(!data)data=new Uint8ClampedArray(width*height*4);
        const i=(ty*width+tx)*4;
        data[i]=r/alpha/Math.max(.001,gain[0]);data[i+1]=g/alpha/Math.max(.001,gain[1]);data[i+2]=b/alpha/Math.max(.001,gain[2]);data[i+3]=alpha;
      }
      yield data ? {x,y,width,height,data} : null;
    }
  }
  function project(args) { return { patches: [...tiles(args)].filter(Boolean) }; }

  // Project one selected raw fisheye lens through a view-space inverse warp.
  // Only tiles intersecting the swept brush cap are visited, preserving the
  // large-source behavior of the normal drawing path.
  function* warpTiles(args) {
    const { map, steps, mapW: w, mapH: h, source, sourcePixels, sourceReader, lens: lensName,
      yaw, pitch, fov, mirror } = args;
    if (source.stitched) return;
    const isPanorama=args.mapProjection==='equirect';
    const s=args.proj??1, edge=Math.tan(s*fov/2), aspect=w/h;
    const cp=Math.cos(pitch),sp=Math.sin(pitch),cy=Math.cos(yaw),sy=Math.sin(yaw);
    const forward=[cp*sy,sp,cp*cy],right=[-cy,0,sy],up=[-sy*sp,cp,-cy*sp];
    let minX=w,minY=h,maxX=-1,maxY=-1;
    if(steps){for(const step of steps){
      const pad=step.radius+Math.hypot(step.delta[0],step.delta[1])*Math.abs(step.strength);
      minX=Math.min(minX,step.center.x-pad);maxX=Math.max(maxX,step.center.x+pad);
      minY=Math.min(minY,step.center.y-pad);maxY=Math.max(maxY,step.center.y+pad);
    }}else for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const i=(y*w+x)*2;if(Math.abs(map[i]-x)>.05||Math.abs(map[i+1]-y)>.05){minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}
    }
    minX=Math.max(0,minX);minY=Math.max(0,minY);maxX=Math.min(w-1,maxX);maxY=Math.min(h-1,maxY);
    if(maxX<0)return;
    const qx=((minX+maxX+1)/w-1)*aspect,qy=1-(minY+maxY+1)/h;
    const qr=Math.hypot(qx,qy),qt=Math.atan(qr*edge)/s,qk=qr>1e-12?Math.sin(qt)/qr:0;
    const cap=forward.map((v,i)=>v*Math.cos(qt)+(right[i]*qx+up[i]*qy)*qk);
    if(mirror)cap[0]=-cap[0];
    const capRadius=Math.min(PI,edge/s*Math.hypot(maxX-minX+2,maxY-minY+2)/h);
    const W=source.width,H=source.height,cfg=source.cfg;
    const lensGeom=S360.lensParams(cfg,Math.min(W/4,H/2));
    const key=lensName==='right'?'right':'left';
    const lens={basis:S360.lensBasis(key==='right',cfg),center:[cfg.centers[key][0]*W,cfg.centers[key][1]*H],
      width:1-cfg.width[key]/100,height:1-(cfg.height?.[key]??0)/100,angle:cfg.angle[key]*PI/180,...lensGeom};
    const vector=[],sampled=[],mapped=[];
    function viewPoint(dx,dy,dz,out){
      if(mirror)dx=-dx;
      const dot=Math.max(-1,Math.min(1,dx*forward[0]+dy*forward[1]+dz*forward[2]));
      const theta=Math.acos(dot);if(s*theta>=PI/2||theta>=PI-1e-7)return null;
      const k=theta<1e-7?s/edge:Math.tan(s*theta)/(Math.sin(theta)*edge);
      out[0]=((dx*right[0]+dz*right[2])*k/aspect+1)*.5*w-.5;
      out[1]=(1-(dx*up[0]+dy*up[1]+dz*up[2])*k)*.5*h-.5;
      return out;
    }
    function sourceSample(x,y,out){
      if(sourceReader)return sourceReader.sample(x,y,out);
      x=Math.max(0,Math.min(W-1,x));y=Math.max(0,Math.min(H-1,y));
      const x0=Math.floor(x),y0=Math.floor(y),x1=Math.min(W-1,x0+1),y1=Math.min(H-1,y0+1),tx=x-x0,ty=y-y0;
      for(let c=0;c<4;c++){
        const a=sourcePixels[(y0*W+x0)*4+c]*(1-tx)+sourcePixels[(y0*W+x1)*4+c]*tx;
        const b=sourcePixels[(y1*W+x0)*4+c]*(1-tx)+sourcePixels[(y1*W+x1)*4+c]*tx;
        out[c]=a*(1-ty)+b*ty;
      }
    }
    for(let y=0;y<H;y+=TILE)for(let x=0;x<W;x+=TILE){
      const width=Math.min(TILE,W-x),height=Math.min(TILE,H-y);
      if(!S360.sourceDirection(x+width/2,H-y-height/2,lens.basis,lens.center,Infinity,Infinity,lens.f,lens.width,lens.angle,lens.height,vector)){yield null;continue;}
      const dx=-vector[1],dy=-vector[2],dz=-vector[0];
      const angular=Math.hypot(width,height)/2/(lens.f*Math.min(lens.width,lens.height));
      if(!isPanorama&&capRadius+angular<PI&&dx*cap[0]+dy*cap[1]+dz*cap[2]<Math.cos(capRadius+angular)-1e-12){yield null;continue;}
      let data=null;
      for(let ty=0;ty<height;ty++)for(let tx=0;tx<width;tx++){
        const px=x+tx+.5,py=y+ty+.5;
        if(!S360.sourceDirection(px,H-py,lens.basis,lens.center,lens.radiusOuter,lens.halfFov,lens.f,lens.width,lens.angle,lens.height,vector))continue;
        const worldX=-vector[1],worldY=-vector[2],worldZ=-vector[0];
        if(isPanorama){mapped[0]=(.5+Math.atan2(worldX,worldZ)/(2*PI))*w-.5;mapped[1]=(.5-Math.asin(Math.max(-1,Math.min(1,worldY)))/PI)*h-.5;}
        else if(!viewPoint(worldX,worldY,worldZ,mapped))continue;
        const vx=mapped[0],vy=mapped[1];
        if(vx<minX-.5||vx>maxX+.5||vy<minY-.5||vy>maxY+.5)continue;
        if(steps)S360.warpProjection.sampleSteps(steps,vx,vy,mapped);
        else S360.warpProjection.sample(map,w,h,vx,vy,mapped);
        if(args.taperToLensCenter){
          const radial=Math.hypot(px-lens.center[0],H-py-lens.center[1])/Math.max(1,lens.radiusOuter);
          const t=Math.max(0,Math.min(1,radial/.8)),taper=t*t*(3-2*t);
          mapped[0]=vx+(mapped[0]-vx)*taper;mapped[1]=vy+(mapped[1]-vy)*taper;
        }
        if(Math.abs(mapped[0]-vx)<.05&&Math.abs(mapped[1]-vy)<.05)continue;
        let odx,ody,odz;
        if(isPanorama){
          const lon=((mapped[0]+.5)/w-.5)*2*PI,lat=(.5-(mapped[1]+.5)/h)*PI,cosLat=Math.cos(lat);
          odx=Math.sin(lon)*cosLat;ody=Math.sin(lat);odz=Math.cos(lon)*cosLat;
        }else{
          const oqx=((mapped[0]+.5)/w*2-1)*aspect,oqy=1-(mapped[1]+.5)/h*2,oqr=Math.hypot(oqx,oqy);
          const theta=oqr>1e-12?Math.atan(oqr*edge)/s:0,k=oqr>1e-12?Math.sin(theta)/oqr:0;
          odx=forward[0]*Math.cos(theta)+(right[0]*oqx+up[0]*oqy)*k;
          ody=forward[1]*Math.cos(theta)+(right[1]*oqx+up[1]*oqy)*k;
          odz=forward[2]*Math.cos(theta)+(right[2]*oqx+up[2]*oqy)*k;
          if(mirror)odx=-odx;
        }
        const origin=S360.sourcePoint([-odz,-odx,-ody],lens.basis,lens.center,lens.radiusOuter,lens.halfFov,lens.f,lens.width,lens.angle,lens.height);
        if(!origin)continue;
        sourceSample(origin.x,H-origin.y,sampled);
        if(!data)data=new Uint8ClampedArray(width*height*4);
        const o=(ty*width+tx)*4;data[o]=sampled[0];data[o+1]=sampled[1];data[o+2]=sampled[2];data[o+3]=255;
      }
      yield data?{x,y,width,height,data}:null;
    }
  }
  S360.drawingProjection = { tiles, warpTiles, projectPatches: project };
})(globalThis.S360);
