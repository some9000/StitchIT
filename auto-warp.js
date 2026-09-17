// auto-warp.js — local view-space lens matching and smooth inverse-map fitting.
// Receives the two already-projected lens layers, finds conservative gradient
// patch correspondences, rejects inconsistent motion, and returns the same
// Float32 inverse-map format consumed by drawing-projection.js's warp bake.
// Pure CPU math; init is unnecessary. frame-registration.js must load first.
globalThis.S360 = globalThis.S360 || {};
(function (S360) {
'use strict';
  const PI = Math.PI;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function sampleLayer(layer, u, v, out) {
    const w=layer.width,h=layer.height,data=layer.data;
    let x=(u-Math.floor(u))*w-.5,y=clamp(1-v,0,1)*h-.5;
    const x0=Math.floor(x),y0=clamp(Math.floor(y),0,h-1),x1=x0+1,y1=Math.min(h-1,y0+1);
    const fx=x-x0,fy=y-Math.floor(y),wrap=a=>((a%w)+w)%w;
    const ax=wrap(x0),bx=wrap(x1),a=(y0*w+ax)*4,b=(y0*w+bx)*4,c=(y1*w+ax)*4,d=(y1*w+bx)*4;
    for(let channel=0;channel<4;channel++){
      const top=data[a+channel]*(1-fx)+data[b+channel]*fx;
      const bottom=data[c+channel]*(1-fx)+data[d+channel]*fx;
      out[channel]=(top*(1-fy)+bottom*fy)/255;
    }
    return out;
  }

  function projectLayers(selected, other, camera, viewW, viewH) {
    const width=Math.max(96,Math.min(640,viewW|0));
    const height=Math.max(64,Math.round(viewH*width/Math.max(1,viewW)));
    const graySelected=new Float32Array(width*height),grayOther=new Float32Array(width*height);
    const alphaSelected=new Float32Array(width*height),alphaOther=new Float32Array(width*height);
    const cy=Math.cos(camera.yaw),sy=Math.sin(camera.yaw),cp=Math.cos(camera.pitch),sp=Math.sin(camera.pitch);
    const forward=[cp*sy,sp,cp*cy],right=[-cy,0,sy],up=[-sp*sy,cp,-sp*cy];
    const s=camera.proj??1,edge=Math.tan(s*camera.fov/2),aspect=width/height;
    const a=[0,0,0,0],b=[0,0,0,0];
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      const qx=(2*(x+.5)/width-1)*aspect,qy=1-2*(y+.5)/height,r=Math.hypot(qx,qy);
      const theta=Math.atan(r*edge)/s;
      if(theta>=PI-1e-7)continue;
      const k=r>1e-8?Math.sin(theta)/r:0;
      let dx=forward[0]*Math.cos(theta)+(right[0]*qx+up[0]*qy)*k;
      const dy=forward[1]*Math.cos(theta)+(right[1]*qx+up[1]*qy)*k;
      const dz=forward[2]*Math.cos(theta)+(right[2]*qx+up[2]*qy)*k;
      if(camera.mirror)dx=-dx;
      const u=.5+Math.atan2(dx,dz)/(2*PI),v=.5+Math.asin(clamp(dy,-1,1))/PI;
      sampleLayer(selected,u,v,a);sampleLayer(other,u,v,b);
      const i=y*width+x;
      graySelected[i]=.2126*a[0]+.7152*a[1]+.0722*a[2];
      grayOther[i]=.2126*b[0]+.7152*b[1]+.0722*b[2];
      alphaSelected[i]=a[3];alphaOther[i]=b[3];
    }
    return {width,height,graySelected,grayOther,alphaSelected,alphaOther};
  }

  function panoramaLayers(selected,other,maxWidth=3072) {
    const width=Math.max(256,Math.min(maxWidth,selected.width,other.width));
    const height=Math.max(128,Math.round(width/2));
    const graySelected=new Float32Array(width*height),grayOther=new Float32Array(width*height);
    const alphaSelected=new Float32Array(width*height),alphaOther=new Float32Array(width*height);
    const a=[0,0,0,0],b=[0,0,0,0];
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      const u=(x+.5)/width,v=1-(y+.5)/height,i=y*width+x;
      sampleLayer(selected,u,v,a);sampleLayer(other,u,v,b);
      graySelected[i]=.2126*a[0]+.7152*a[1]+.0722*a[2];grayOther[i]=.2126*b[0]+.7152*b[1]+.0722*b[2];
      alphaSelected[i]=a[3];alphaOther[i]=b[3];
    }
    return {width,height,graySelected,grayOther,alphaSelected,alphaOther};
  }

  function reduceView(view,maxWidth=512) {
    if(view.width<=maxWidth)return {view,scale:1};
    const scale=maxWidth/view.width,w=maxWidth,h=Math.max(64,Math.round(view.height*scale));
    const out={width:w,height:h};
    for(const name of ['graySelected','grayOther','alphaSelected','alphaOther']){
      const src=view[name],dst=out[name]=new Float32Array(w*h);
      for(let y=0;y<h;y++)for(let x=0;x<w;x++)dst[y*w+x]=src[Math.min(view.height-1,Math.round(y/scale))*view.width+Math.min(view.width-1,Math.round(x/scale))];
    }
    return {view:out,scale};
  }

  function patch(source,w,cx,cy,size) {
    const half=size>>1,out=new Float32Array(size*size);
    for(let y=0;y<size;y++){
      const from=(cy-half+y)*w+cx-half;
      out.set(source.subarray(from,from+size),y*size);
    }
    return out;
  }

  function coverage(alphaA,alphaB,w,ax,ay,bx,by,size) {
    const half=size>>1;let valid=0,total=0;
    for(let oy=-half;oy<half;oy+=2)for(let ox=-half;ox<half;ox+=2){
      const a=(ay+oy)*w+ax+ox,b=(by+oy)*w+bx+ox;
      total++;if(alphaA[a]>.08&&alphaB[b]>.08)valid++;
    }
    return valid/Math.max(1,total);
  }

  function shiftScore(view, dx, dy, step) {
    const {width:w,height:h,grayOther,graySelected,alphaOther,alphaSelected}=view,margin=2;
    let sum=0,sumR=0,sumC=0,sumRR=0,sumCC=0,n=0;
    const x0=Math.max(margin,margin-dx),x1=Math.min(w-margin,w-margin-dx);
    const y0=Math.max(margin,margin-dy),y1=Math.min(h-margin,h-margin-dy);
    for(let y=y0;y<y1;y+=step)for(let x=x0;x<x1;x+=step){
      const rp=y*w+x,cp=(y+dy)*w+x+dx;
      if(alphaOther[rp]<=.08||alphaSelected[cp]<=.08)continue;
      const r=grayOther[rp],c=graySelected[cp];
      sum+=r*c;sumR+=r;sumC+=c;sumRR+=r*r;sumCC+=c*c;n++;
    }
    if(n<64)return -Infinity;
    const cov=sum-sumR*sumC/n;
    return cov/Math.sqrt(Math.max(1e-12,(sumRR-sumR*sumR/n)*(sumCC-sumC*sumC/n)));
  }

  function blurGray(source,w,h,radius=5) {
    const tmp=new Float32Array(w*h),out=new Float32Array(w*h);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      let sum=0,n=0;for(let ox=-radius;ox<=radius;ox++){const sx=x+ox;if(sx>=0&&sx<w){sum+=source[y*w+sx];n++;}}
      tmp[y*w+x]=sum/n;
    }
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      let sum=0,n=0;for(let oy=-radius;oy<=radius;oy++){const sy=y+oy;if(sy>=0&&sy<h){sum+=tmp[sy*w+x];n++;}}
      out[y*w+x]=sum/n;
    }
    return out;
  }

  function highPass(source,w,h) {
    const low=blurGray(source,w,h,3),out=new Float32Array(source.length);
    for(let i=0;i<out.length;i++)out[i]=source[i]-low[i];
    return out;
  }

  function edgeOrientation(grad,w,cx,cy,size) {
    const half=size>>1;let xx=0,xy=0,yy=0,energy=0,n=0;
    for(let y=cy-half+1;y<cy+half-1;y+=2)for(let x=cx-half+1;x<cx+half-1;x+=2){
      const i=y*w+x,gx=grad.gradX[i],gy=grad.gradY[i];
      xx+=gx*gx;xy+=gx*gy;yy+=gy*gy;energy+=gx*gx+gy*gy;n++;
    }
    const angle=.5*Math.atan2(2*xy,xx-yy);
    return {nx:Math.cos(angle),ny:Math.sin(angle),energy:energy/Math.max(1,n)};
  }

  function detailScore(ref,cur,w,rx,ry,cx,cy,size,dx,dy) {
    const half=size>>1;let dot=0,rr=0,cc=0,n=0;
    for(let oy=-half+1;oy<half-1;oy+=2)for(let ox=-half+1;ox<half-1;ox+=2){
      const a=(ry+oy)*w+rx+ox,b=(cy+dy+oy)*w+cx+dx+ox;
      const ax=ref.gradX[a],ay=ref.gradY[a],bx=cur.gradX[b],by=cur.gradY[b];
      const ar=Math.hypot(ax,ay),br=Math.hypot(bx,by);
      if(ar<.002||br<.002)continue;
      const weight=Math.sqrt(ar*br);dot+=weight*(ax*bx+ay*by);rr+=weight*(ax*ax+ay*ay);cc+=weight*(bx*bx+by*by);n++;
    }
    return n<12?-Infinity:dot/Math.sqrt(Math.max(1e-12,rr*cc));
  }

  function detailOneWay(ref,cur,w,rx,ry,cx,cy,size,radius) {
    const orientation=edgeOrientation(ref,w,rx,ry,size);
    if(orientation.energy<2e-6)return null;
    const candidates=[],seen=new Set();
    for(let d=-radius;d<=radius;d++){
      const dx=Math.round(d*orientation.nx),dy=Math.round(d*orientation.ny),key=dx+','+dy;
      if(seen.has(key))continue;seen.add(key);
      const score=detailScore(ref,cur,w,rx,ry,cx,cy,size,dx,dy);
      candidates.push({dx,dy,score,rank:score-.008*Math.abs(dx)/radius});
    }
    candidates.sort((a,b)=>b.rank-a.rank);const best=candidates[0];
    const second=candidates.find(c=>Math.hypot(c.dx-best.dx,c.dy-best.dy)>2);
    const unique=best.score-(second?.score??-1);
    if(!Number.isFinite(best.score)||best.score<.18||unique<.003||Math.hypot(best.dx,best.dy)>=radius-.25)return null;
    return {...best,unique};
  }

  function refineDetail(refGrad,curGrad,w,rx,ry,cx,cy,size,radius=6) {
    const forward=detailOneWay(refGrad,curGrad,w,rx,ry,cx,cy,size,radius);
    const reverse=detailOneWay(curGrad,refGrad,w,cx,cy,rx,ry,size,radius);
    if(!forward||!reverse||Math.hypot(forward.dx+reverse.dx,forward.dy+reverse.dy)>1.25)return null;
    return {dx:.5*(forward.dx-reverse.dx),dy:.5*(forward.dy-reverse.dy),
      confidence:Math.min(1,Math.min(forward.score,reverse.score)+Math.min(.2,forward.unique*2))};
  }

  function matchDetailPatch(refGray,curGray,w,h,cx,cy,size=32,radius=6) {
    const ref=S360.frameRegistration.computeGradients(highPass(refGray,w,h),w,h);
    const cur=S360.frameRegistration.computeGradients(highPass(curGray,w,h),w,h);
    return refineDetail(ref,cur,w,cx,cy,cx,cy,size,radius);
  }

  async function estimateDominantShift(view,onProgress,yieldFn) {
    const originalWidth=view.width,reduced=reduceView(view),scale=reduced.scale;view=reduced.view;
    const {width:w,height:h}=view,reach=Math.max(8,Math.floor(w/3));
    const limitX=Math.min(reach,w-8),limitY=Math.min(reach,h-8);
    const broad={...view,grayOther:blurGray(view.grayOther,w,h),graySelected:blurGray(view.graySelected,w,h)};
    const adjusted=(score,dx,dy)=>score-.03*Math.abs(dx)/reach-.004*Math.abs(dy)/reach;
    let best={dx:0,dy:0,score:shiftScore(broad,0,0,7)};
    best.adjusted=adjusted(best.score,0,0);
    const coarse=8,totalRows=Math.floor(2*limitY/coarse)+1;let row=0;
    for(let dy=-limitY;dy<=limitY;dy+=coarse){
      for(let dx=-limitX;dx<=limitX;dx+=coarse){
        const score=shiftScore(broad,dx,dy,7),rank=adjusted(score,dx,dy);
        if(rank>best.adjusted)best={dx,dy,score,adjusted:rank};
      }
      row++;onProgress?.(.06+.16*row/totalRows);if(yieldFn&&(row&3)===0)await yieldFn();
    }
    for(const stride of [4,2,1]){
      const start={...best};
      for(let dy=start.dy-2*stride;dy<=start.dy+2*stride;dy+=stride)for(let dx=start.dx-2*stride;dx<=start.dx+2*stride;dx+=stride){
        if(Math.abs(dx)>limitX||Math.abs(dy)>limitY)continue;
        const score=shiftScore(stride===1?view:broad,dx,dy,stride===1?3:5),rank=adjusted(score,dx,dy);
        if(rank>best.adjusted)best={dx,dy,score,adjusted:rank};
      }
      if(yieldFn)await yieldFn();
    }
    const zero=shiftScore(view,0,0,3);
    const resultReach=Math.floor(originalWidth/3);
    if(!Number.isFinite(best.score)||best.score<.2||best.adjusted<zero+.008)return {dx:0,dy:0,confidence:zero,reach:resultReach};
    return {dx:Math.round(best.dx/scale),dy:Math.round(best.dy/scale),confidence:best.score,reach:resultReach};
  }

  const median = values => {
    const sorted=values.slice().sort((a,b)=>a-b),n=sorted.length;
    return n?sorted[n>>1]:0;
  };

  function horizontalHalf(view,zone) {
    const w=view.width>>1,h=view.height,start=zone*w,out={width:w,height:h};
    for(const name of ['graySelected','grayOther','alphaSelected','alphaOther']){
      const src=view[name],dst=out[name]=new Float32Array(w*h);
      for(let y=0;y<h;y++)dst.set(src.subarray(y*view.width+start,y*view.width+start+w),y*w);
    }
    return out;
  }

  function focusRegion(view,focus) {
    const sx=view.width/Math.max(1,focus.viewW),sy=view.height/Math.max(1,focus.viewH);
    const cx=focus.x*sx,cy=focus.y*sy,radiusX=Math.max(4,focus.radiusX*sx),radiusY=Math.max(4,focus.radiusY*sy);
    const padX=Math.ceil(radiusX+48),padY=Math.ceil(radiusY+48);
    const x0=Math.max(0,Math.floor(cx-padX)),x1=Math.min(view.width,Math.ceil(cx+padX));
    const y0=Math.max(0,Math.floor(cy-padY)),y1=Math.min(view.height,Math.ceil(cy+padY)),w=x1-x0,h=y1-y0;
    const out={width:w,height:h};
    for(const name of ['graySelected','grayOther','alphaSelected','alphaOther']){
      const src=view[name],dst=out[name]=new Float32Array(w*h);
      for(let y=0;y<h;y++)dst.set(src.subarray((y+y0)*view.width+x0,(y+y0)*view.width+x1),y*w);
    }
    return {view:out,cx,cy,radiusX,radiusY};
  }

  async function buildMap({selected,other,camera,viewW,viewH,strength=1,fullPanorama=false,focus=null,onProgress,yieldFn}) {
    if(!selected?.data||!other?.data)throw new Error('Lens previews are unavailable.');
    if(!S360.frameRegistration?.refinePatch)throw new Error('Patch registration is unavailable.');
    onProgress?.(0.05);
    const view=fullPanorama?panoramaLayers(selected,other):projectLayers(selected,other,camera,viewW,viewH);
    const {width:w,height:h}=view,patchSize=40,half=patchSize>>1,highDetail=fullPanorama&&!focus;
    const spacing=focus?16:(highDetail?24:32),searchRadius=focus?10:(highDetail?9:6);
    const focused=focus?focusRegion(view,{...focus,viewW:focus.viewW||viewW,viewH:focus.viewH||viewH}):null;
    if(focused){
      let overlap=0,total=0;
      for(let y=Math.max(0,focused.cy-focused.radiusY);y<Math.min(h,focused.cy+focused.radiusY);y+=4)
        for(let x=Math.max(0,focused.cx-focused.radiusX);x<Math.min(w,focused.cx+focused.radiusX);x+=4){
          if(((x-focused.cx)/focused.radiusX)**2+((y-focused.cy)/focused.radiusY)**2>1)continue;
          const i=(y|0)*w+(x|0);total++;if(view.alphaOther[i]>.08&&view.alphaSelected[i]>.08)overlap++;
        }
      if(overlap/Math.max(1,total)<.12)return {map:null,width:w,height:h,matches:0,moved:false,overlap:false};
    }
    const measuredDominants=focused
      ? [await estimateDominantShift(focused.view,onProgress,yieldFn)]
      : fullPanorama
      ? [await estimateDominantShift(horizontalHalf(view,0),f=>onProgress?.(.05+.09*f),yieldFn),
         await estimateDominantShift(horizontalHalf(view,1),f=>onProgress?.(.14+.09*f),yieldFn)]
      : [await estimateDominantShift(view,onProgress,yieldFn)];
    // The broad scan is only a search seed. A repeated or nearly empty region can
    // correlate at a remote location, so never let that seed authorize a large
    // automatic deformation. Local patch agreement below must still support it.
    const automaticCandidateLimit=Math.max(12,w*.025);
    const dominants=fullPanorama?measuredDominants.map(d=>
      d.confidence>=.32&&Math.hypot(d.dx,d.dy)<=automaticCandidateLimit?d:{...d,dx:0,dy:0,rejected:true}
    ):measuredDominants;
    const focusZone=focused&&fullPanorama?(focused.cx<w/2?0:1):0;
    const zoneForX=x=>focused?0:(fullPanorama?(x<w/2?0:1):0);
    const matches=[];let rows=0,totalRows=Math.max(1,Math.floor((h-2*(half+searchRadius))/spacing)+1);
    for(let cy=half+searchRadius;cy<h-half-searchRadius;cy+=spacing){
      for(let cx=half+searchRadius;cx<w-half-searchRadius;cx+=spacing){
        if(focused&&((cx-focused.cx)/focused.radiusX)**2+((cy-focused.cy)/focused.radiusY)**2>1)continue;
        const zone=zoneForX(cx),baseX=dominants[zone].dx,baseY=dominants[zone].dy;
        const sx=cx+baseX,sy=cy+baseY;
        if(sx<half+searchRadius||sx>=w-half-searchRadius||sy<half+searchRadius||sy>=h-half-searchRadius)continue;
        if(coverage(view.alphaOther,view.alphaSelected,w,cx,cy,sx,sy,patchSize)<.7)continue;
        const ref=patch(view.grayOther,w,cx,cy,patchSize);
        const cur=patch(view.graySelected,w,sx,sy,patchSize);
        const fit=S360.frameRegistration.refinePatch(ref,cur,patchSize,patchSize,searchRadius);
        const dx=baseX+fit.dx,dy=baseY+fit.dy;
        if(!fit.rejected&&fit.confidence>.3&&Math.hypot(dx,dy)>.08&&(!fullPanorama||Math.hypot(dx,dy)<=automaticCandidateLimit)){
          matches.push({x:cx,y:cy,dx,dy,confidence:fit.confidence,zone:focused?focusZone:zone});
        }
      }
      rows++;onProgress?.(.23+.37*rows/totalRows);if(yieldFn)await yieldFn();
    }
    // Thin lines occupy too little of a large brightness patch to influence it.
    // A denser pass removes the local background and matches edge direction;
    // uncertain movement along a line is ignored by its normal-axis uniqueness gate.
    const detailSize=32,detailHalf=detailSize>>1,detailSpacing=focus?8:(highDetail?12:16);
    const refHigh=highPass(view.grayOther,w,h),curHigh=highPass(view.graySelected,w,h);
    const refDetail=S360.frameRegistration.computeGradients(refHigh,w,h);
    const curDetail=S360.frameRegistration.computeGradients(curHigh,w,h);
    let detailRows=0,detailMatches=0,totalDetailRows=Math.max(1,Math.floor((h-2*(detailHalf+searchRadius))/detailSpacing)+1);
    for(let cy=detailHalf+searchRadius;cy<h-detailHalf-searchRadius;cy+=detailSpacing){
      for(let cx=detailHalf+searchRadius;cx<w-detailHalf-searchRadius;cx+=detailSpacing){
        if(focused&&((cx-focused.cx)/focused.radiusX)**2+((cy-focused.cy)/focused.radiusY)**2>1)continue;
        const zone=zoneForX(cx),baseX=dominants[zone].dx,baseY=dominants[zone].dy;
        const sx=cx+baseX,sy=cy+baseY;
        if(sx<detailHalf+searchRadius||sx>=w-detailHalf-searchRadius||sy<detailHalf+searchRadius||sy>=h-detailHalf-searchRadius)continue;
        if(coverage(view.alphaOther,view.alphaSelected,w,cx,cy,sx,sy,detailSize)<.75)continue;
        const fit=refineDetail(refDetail,curDetail,w,cx,cy,sx,sy,detailSize,searchRadius);
        if(!fit)continue;
        const dx=baseX+fit.dx,dy=baseY+fit.dy;
        if(fit.confidence>.28&&Math.hypot(dx,dy)>.08&&(!fullPanorama||Math.hypot(dx,dy)<=automaticCandidateLimit)){
          matches.push({x:cx,y:cy,dx,dy,confidence:fit.confidence,detail:true,zone:focused?focusZone:zone});detailMatches++;
        }
      }
      detailRows++;onProgress?.(.6+.12*detailRows/totalDetailRows);if(yieldFn)await yieldFn();
    }
    if(matches.length<4)return {map:null,width:w,height:h,matches:matches.length,moved:false};

    // Each physical seam gets its own robust motion gate. Opposite lens halves
    // can therefore disagree without one side rejecting or dragging the other.
    const reliable=[];
    const robustZones=focused?[focusZone]:dominants.map((_,i)=>i);
    for(const zone of robustZones){
      const group=matches.filter(m=>m.zone===zone);if(!group.length)continue;
      const mdx=median(group.map(m=>m.dx)),mdy=median(group.map(m=>m.dy));
      const residuals=group.map(m=>Math.hypot(m.dx-mdx,m.dy-mdy));
      const mad=median(residuals),limit=Math.max(1.5,3*mad);
      reliable.push(...group.filter((m,i)=>residuals[i]<=limit));
    }
    if(reliable.length<4)return {map:null,width:w,height:h,matches:reliable.length,moved:false};

    const map=new Float32Array(w*h*2),radius=focused?Math.max(focused.radiusX,focused.radiusY):(fullPanorama?Math.max(64,w/24):w/3),radius2=radius*radius;
    const amount=clamp(strength,.1,2)*(focused?.55:(fullPanorama?.75:1));
    const maxMove=focused?Math.min(Math.min(focused.radiusX,focused.radiusY)*.35,w*.015):(fullPanorama?Math.max(2,w*.015):radius*.9);
    const fieldStep=highDetail?24:16,gw=Math.ceil((w-1)/fieldStep)+1,gh=Math.ceil((h-1)/fieldStep)+1;
    const fieldX=new Float32Array(gw*gh),fieldY=new Float32Array(gw*gh);
    for(let gy=0;gy<gh;gy++)for(let gx=0;gx<gw;gx++){
      const x=Math.min(w-1,gx*fieldStep),y=Math.min(h-1,gy*fieldStep);let sum=0,dx=0,dy=0,sumSq=0,support=0;
      if(focused&&((x-focused.cx)/focused.radiusX)**2+((y-focused.cy)/focused.radiusY)**2>=1)continue;
      for(const match of reliable){
        if(fullPanorama&&match.zone!==(focused?focusZone:zoneForX(x)))continue;
        const ox=x-match.x,oy=y-match.y;
        const d2=focused?(ox*ox/(focused.radiusX*focused.radiusX)+oy*oy/(focused.radiusY*focused.radiusY)):(ox*ox+oy*oy)/radius2;
        if(d2>=1)continue;
        const t=Math.sqrt(d2),fall=focused?.5+.5*Math.cos(Math.PI*t):1-t*t*(3-2*t),weight=fall*fall*Math.max(.1,match.confidence);
        sum+=weight;dx+=weight*match.dx;dy+=weight*match.dy;sumSq+=weight*(match.dx*match.dx+match.dy*match.dy);support++;
      }
      const i=gy*gw+gx,coverageWeight=Math.min(1,sum/1.5);
      if(sum>1e-8){
        const meanX=dx/sum,meanY=dy/sum;
        const scatter=Math.sqrt(Math.max(0,sumSq/sum-meanX*meanX-meanY*meanY));
        // Full Auto Morphing needs several nearby correspondences that agree.
        // Isolated matches and mixed motion leave this part of the lens untouched.
        if(!fullPanorama||support>=4&&scatter<=Math.max(2,1+.4*Math.hypot(meanX,meanY))){
          fieldX[i]=clamp(meanX*coverageWeight*amount,-maxMove,maxMove);
          fieldY[i]=clamp(meanY*coverageWeight*amount,-maxMove,maxMove);
        }
      }
    }
    for(let y=0;y<h;y++){
      for(let x=0;x<w;x++){
        const fx=x/fieldStep,fy=y/fieldStep,x0=Math.floor(fx),y0=Math.floor(fy),x1=Math.min(gw-1,x0+1),y1=Math.min(gh-1,y0+1),tx=fx-x0,ty=fy-y0;
        const a=y0*gw+x0,b=y0*gw+x1,c=y1*gw+x0,d=y1*gw+x1;
        const ax=(1-tx)*(1-ty),bx=tx*(1-ty),cx=(1-tx)*ty,dxw=tx*ty;
        let dx=fieldX[a]*ax+fieldX[b]*bx+fieldX[c]*cx+fieldX[d]*dxw;
        let dy=fieldY[a]*ax+fieldY[b]*bx+fieldY[c]*cx+fieldY[d]*dxw;
        if(focused){
          const d2=((x-focused.cx)/focused.radiusX)**2+((y-focused.cy)/focused.radiusY)**2;
          const mask=d2>=1?0:.5+.5*Math.cos(Math.PI*Math.sqrt(d2));dx*=mask;dy*=mask;
        }
        const i=(y*w+x)*2;map[i]=x+dx;map[i+1]=y+dy;
      }
      if((y&15)===0){onProgress?.(.72+.23*y/h);if(yieldFn)await yieldFn();}
    }
    onProgress?.(.95);
    return {map,width:w,height:h,matches:reliable.length,detailMatches,moved:true,overlap:true,dominant:dominants[0],dominants};
  }

  S360.autoWarp={buildMap,projectLayers,panoramaLayers,estimateDominantShift,matchDetailPatch};
})(globalThis.S360);
