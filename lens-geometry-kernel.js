// lens-geometry-kernel.js — pure radial lens-geometry calibration.
// Correlates world-space patches to recover the 180-degree ring, scans inward
// from the raw 100% lens border for the capture margin, then sizes the feather.
// Worker-safe; geometry.js must be loaded first.
globalThis.S360 = globalThis.S360 || {};
(function (S360) {
'use strict';
  const PI=Math.PI,TAU=PI*2;
  const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
  const AZIMUTHS=72;
  const RADIAL_OFFSETS=[-3,-1.5,0,1.5,3];
  const MIN_OVERLAP=1,MAX_OVERLAP=10;

  function percentile(values,p){
    if(!values.length)return -1;
    const sorted=values.slice().sort((a,b)=>a-b);
    return sorted[Math.max(0,Math.min(sorted.length-1,Math.floor((sorted.length-1)*p)))];
  }
  function luma(c){return Math.log(.02+.2126*c[0]+.7152*c[1]+.0722*c[2]);}

  function geometry(cfg,imgWidth,imgHeight,proxy,radius,outerMargin,gain){
    const candidate={...cfg,radius,outerMargin};
    const base=Math.min(imgWidth*.25,imgHeight*.5),lens=S360.lensParams(candidate,base);
    const scale=proxy.scale,lb=S360.lensBasis(false,candidate),rb=S360.lensBasis(true,candidate);
    return {candidate,base,lens,scale,lb,rb,gain:gain||[1,1,1],
      centers:{left:[imgWidth*cfg.centers.left[0]*scale,imgHeight*cfg.centers.left[1]*scale],
        right:[imgWidth*cfg.centers.right[0]*scale,imgHeight*cfg.centers.right[1]*scale]},
      radiusPx:lens.radiusOuter*scale,focal:lens.f*scale,
      width:{left:1-cfg.width.left/100,right:1-cfg.width.right/100},
      height:{left:1-(cfg.height?.left??0)/100,right:1-(cfg.height?.right??0)/100},
      angle:{left:cfg.angle.left*PI/180,right:cfg.angle.right*PI/180}};
  }

  function direction(g,theta,az){
    const s=Math.sin(theta),c=Math.cos(theta),ca=Math.cos(az),sa=Math.sin(az),b=g.lb;
    return [b.axis[0]*c+b.up[0]*s*ca+b.right[0]*s*sa,
      b.axis[1]*c+b.up[1]*s*ca+b.right[1]*s*sa,
      b.axis[2]*c+b.up[2]*s*ca+b.right[2]*s*sa];
  }

  // A 3x3 patch in angular/world coordinates follows the same object through
  // fisheye distortion. Correlation handles exposure; mean RGB distance keeps
  // the outward margin search on genuinely shared image content.
  function patchMetrics(proxy,g,theta,az){
    const step=2/Math.max(8,g.focal),azStep=step/Math.max(.2,Math.sin(theta));
    const left=[],right=[],bufL=[0,0,0],bufR=[0,0,0],meanL=[0,0,0],meanR=[0,0,0];
    for(let iy=-1;iy<=1;iy++)for(let ix=-1;ix<=1;ix++){
      const t=theta+iy*step,a=az+ix*azStep,v=direction(g,t,a);
      const pL=S360.sourcePoint(v,g.lb,g.centers.left,g.radiusPx,g.lens.halfFov,g.focal,
        g.width.left,g.angle.left,g.height.left);
      const pR=S360.sourcePoint(v,g.rb,g.centers.right,g.radiusPx,g.lens.halfFov,g.focal,
        g.width.right,g.angle.right,g.height.right);
      if(!pL||!pR)return null;
      S360.sampleBilinear(proxy,pL.x,pL.y,bufL);S360.sampleBilinear(proxy,pR.x,pR.y,bufR);
      for(let c=0;c<3;c++)bufR[c]=clamp(bufR[c]*g.gain[c],0,1);
      for(let c=0;c<3;c++){meanL[c]+=bufL[c];meanR[c]+=bufR[c];}
      left.push(luma(bufL));right.push(luma(bufR));
    }
    for(let c=0;c<3;c++){meanL[c]/=left.length;meanR[c]/=right.length;}
    const colorDiff=Math.hypot(meanL[0]-meanR[0],meanL[1]-meanR[1],meanL[2]-meanR[2])/Math.sqrt(3);
    let ml=0,mr=0;for(let i=0;i<left.length;i++){ml+=left[i];mr+=right[i];}
    ml/=left.length;mr/=right.length;
    let vl=0,vr=0,cov=0;
    for(let i=0;i<left.length;i++){const dl=left[i]-ml,dr=right[i]-mr;vl+=dl*dl;vr+=dr*dr;cov+=dl*dr;}
    const correlation=vl<2e-4||vr<2e-4?null:clamp(cov/Math.sqrt(vl*vr),-1,1);
    return {correlation,colorDiff};
  }

  function patchCorrelation(proxy,g,theta,az){
    return patchMetrics(proxy,g,theta,az)?.correlation??null;
  }

  function scoreRadius(proxy,imgWidth,imgHeight,cfg,radius,gain){
    const g=geometry(cfg,imgWidth,imgHeight,proxy,radius,100,gain),values=[];
    for(let ia=0;ia<AZIMUTHS;ia++){
      const az=-PI+(ia+.5)*TAU/AZIMUTHS;
      for(const offset of RADIAL_OFFSETS){
        const theta=PI*.5+offset/Math.max(radius,1)*PI*.5;
        const corr=patchCorrelation(proxy,g,theta,az);if(corr!==null)values.push(corr);
      }
    }
    const coverage=values.length/(AZIMUTHS*RADIAL_OFFSETS.length);
    return {radius,median:percentile(values,.5),lower:percentile(values,.25),coverage,count:values.length,
      score:percentile(values,.5)+.18*coverage+.08*percentile(values,.25)};
  }

  function scanRadius(proxy,imgWidth,imgHeight,cfg,options,onProgress){
    const lo=clamp(options?.radiusMin??80,80,100),hi=clamp(options?.radiusMax??100,lo,100);
    const coarseStep=options?.local?.05:.25,fineStep=options?.local?.01:.05,coarse=[];
    for(let radius=lo;radius<=hi+1e-6;radius+=coarseStep){
      coarse.push(scoreRadius(proxy,imgWidth,imgHeight,cfg,Number(radius.toFixed(3)),options?.gain));
      onProgress?.((radius-lo)/Math.max(coarseStep,hi-lo));
    }
    coarse.sort((a,b)=>b.score-a.score);const seed=coarse[0],fine=[];
    for(let radius=Math.max(lo,seed.radius-coarseStep);radius<=Math.min(hi,seed.radius+coarseStep)+1e-6;radius+=fineStep){
      fine.push(scoreRadius(proxy,imgWidth,imgHeight,cfg,Number(radius.toFixed(3)),options?.gain));
    }
    fine.sort((a,b)=>b.score-a.score);const best=fine[0];
    const alternatives=coarse.slice(1,Math.min(8,coarse.length)).map(x=>x.score);
    best.uniqueness=Math.max(0,best.score-percentile(alternatives,.5));
    return best;
  }

  function sampleRawRing(proxy,g,pct){
    const samples=[],radius=g.base*g.scale*pct/100,buf=[0,0,0];
    for(const side of ['left','right']){
      const center=g.centers[side],angle=g.angle[side],ca=Math.cos(angle),sa=Math.sin(angle);
      for(let ia=0;ia<AZIMUTHS;ia++){
        const az=-PI+(ia+.5)*TAU/AZIMUTHS;
        const dx=radius*Math.sin(az)*g.width[side],dy=-radius*Math.cos(az)*g.height[side];
        const x=center[0]+dx*ca-dy*sa,y=center[1]+dx*sa+dy*ca;
        S360.sampleBilinear(proxy,x,y,buf);
        const gain=side==='right'?g.gain:[1,1,1];
        samples.push(clamp(buf[0]*gain[0],0,1),clamp(buf[1]*gain[1],0,1),clamp(buf[2]*gain[2],0,1));
      }
    }
    return samples;
  }

  function scanOuterMargin(proxy,imgWidth,imgHeight,cfg,radius,options,onProgress){
    const g=geometry(cfg,imgWidth,imgHeight,proxy,radius,100,options?.gain);
    const reference=sampleRawRing(proxy,g,100),profile=[];
    const lower=Math.min(100,radius+MIN_OVERLAP);
    let natural=lower;
    for(let pct=99.75;pct>=lower-1e-6;pct-=.25){
      const ring=sampleRawRing(proxy,g,pct),diffs=[];let matching=0;
      for(let i=0;i<ring.length;i+=3){
        const diff=Math.hypot(ring[i]-reference[i],ring[i+1]-reference[i+1],ring[i+2]-reference[i+2])/Math.sqrt(3);
        diffs.push(diff);
        if(diff<=.05){
          matching++;
          reference[i]=ring[i];reference[i+1]=ring[i+1];reference[i+2]=ring[i+2];
        }
      }
      const matchFraction=matching/(AZIMUTHS*2);
      profile.push({radius:Number(pct.toFixed(2)),matchFraction,medianDiff:percentile(diffs,.5)});
      natural=pct;
      onProgress?.((100-pct)/Math.max(.25,100-lower));
      if(matchFraction<.50)break;
    }
    const outerHi=Math.min(radius+MAX_OVERLAP,options?.outerMax??100,100);
    const naturalLo=Math.min(100,radius+MIN_OVERLAP);
    const outerLo=Math.min(outerHi,Math.max(naturalLo,options?.outerMin??naturalLo));
    return {outerMargin:Number(clamp(natural,outerLo,outerHi).toFixed(1)),profile};
  }

  function overlapProfile(proxy,imgWidth,imgHeight,cfg,radius,outerMargin,options,onProgress){
    const g=geometry(cfg,imgWidth,imgHeight,proxy,radius,100,options?.gain),profile=[];
    const maxDepth=Math.max(0,outerMargin-radius);
    for(let depth=0;depth<=maxDepth+1e-6;depth+=.25){
      const values=[],colors=[],theta=PI*.5+depth/Math.max(radius,1)*PI*.5;
      let matching=0;
      for(let ia=0;ia<AZIMUTHS;ia++){
        const metrics=patchMetrics(proxy,g,theta,-PI+(ia+.5)*TAU/AZIMUTHS);
        if(!metrics)continue;
        colors.push(metrics.colorDiff);
        if(metrics.correlation!==null)values.push(metrics.correlation);
        if(metrics.correlation!==null&&metrics.correlation>=.12&&metrics.colorDiff<=.2)matching++;
      }
      profile.push({depth:Number(depth.toFixed(2)),coverage:values.length/AZIMUTHS,
        sampleCoverage:colors.length/AZIMUTHS,median:percentile(values,.5),lower:percentile(values,.25),
        colorDiff:percentile(colors,.5),matchFraction:matching/AZIMUTHS,count:values.length});
      onProgress?.(depth/Math.max(.25,maxDepth));
    }
    return profile;
  }

  function finish(best,margin,profile,options){
    const near=profile.slice(0,Math.min(3,profile.length)).filter(p=>p.count>=6);
    const seamQuality=near.length?percentile(near.map(p=>p.median),.5):best.median;
    const baselineColor=near.length?percentile(near.map(p=>p.colorDiff),.5):.08;
    const loose=Math.max(.08,seamQuality*.35),strong=Math.max(.24,seamQuality*.6);
    const colorLimit=clamp(baselineColor*1.7+.035,.08,.22);
    let reliableDepth=0;
    for(const p of profile){
      const close=p.matchFraction>=.5&&p.sampleCoverage>=.65&&p.median>=loose&&p.colorDiff<=colorLimit;
      if(!close)break;
      if(p.coverage>=.32&&p.median>=strong&&p.colorDiff<=colorLimit*.8)reliableDepth=p.depth;
    }
    const outerMargin=margin.outerMargin;
    const usable=Math.max(.5,outerMargin-best.radius);
    const estimatedSeam=(reliableDepth/usable)*80;
    const seamWidth=Math.round(clamp(estimatedSeam,options?.seamMin??20,options?.seamMax??90));
    const confidence=clamp(best.coverage*.45+Math.max(0,best.median)*.35+best.uniqueness*1.5,0,1);
    return {params:{radius:Number(best.radius.toFixed(1)),outerMargin,seamWidth},confidence,
      matches:best.count,correlation:best.median,uniqueness:best.uniqueness,colorLimit,
      marginProfile:margin.profile,profile};
  }

  function optimize(proxy,imgWidth,imgHeight,cfg,options,onProgress){
    const best=scanRadius(proxy,imgWidth,imgHeight,cfg,options,f=>onProgress?.(f*.65));
    const margin=scanOuterMargin(proxy,imgWidth,imgHeight,cfg,best.radius,options,f=>onProgress?.(.65+f*.15));
    const profile=overlapProfile(proxy,imgWidth,imgHeight,cfg,best.radius,margin.outerMargin,options,f=>onProgress?.(.8+f*.2));
    onProgress?.(1);return finish(best,margin,profile,options);
  }

  // Main-thread fallback yields between the two bounded searches. The worker
  // uses optimize(); file:// still gets the identical kernel and result.
  async function optimizeAsync(proxy,imgWidth,imgHeight,cfg,options,onProgress,yieldFn){
    onProgress?.(.02);await yieldFn?.();
    const best=scanRadius(proxy,imgWidth,imgHeight,cfg,options,f=>onProgress?.(.02+f*.63));
    await yieldFn?.();
    const margin=scanOuterMargin(proxy,imgWidth,imgHeight,cfg,best.radius,options,f=>onProgress?.(.65+f*.15));
    await yieldFn?.();
    const profile=overlapProfile(proxy,imgWidth,imgHeight,cfg,best.radius,margin.outerMargin,options,f=>onProgress?.(.8+f*.2));
    onProgress?.(1);return finish(best,margin,profile,options);
  }

  S360.lensGeometryKernel={optimize,optimizeAsync,scoreRadius,patchCorrelation,patchMetrics,scanOuterMargin};
})(globalThis.S360);
