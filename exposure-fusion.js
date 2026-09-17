// Reference-guided exposure fusion. Streams aligned LDR frames through local
// consistency/recovery weighting, then applies a restrained low-frequency tone finish.
window.S360 = window.S360 || {};
(function (S360) {
'use strict';
  const FUSION_LEVELS = [{ scale: 4, level: 3 }, { scale: 1, level: 5 }];
  const _state = new WeakMap();

  function stateFor(gl) {
    let state = _state.get(gl);
    if (!state) {
      state = { accumulate: null, resolve: null };
      _state.set(gl, state);
    }
    return state;
  }

  function createAccumulateProgram(gl) {
    const vs = S360.QUAD_VS;
    const fs = `#version 300 es
      precision highp float;
      in vec2 v_uv;
      out vec4 fragColor;
      uniform sampler2D u_frame;
      uniform sampler2D u_reference;
      uniform vec2 u_imageSize;
      uniform vec2 u_offsetL;
      uniform vec2 u_offsetR;
      uniform int u_splitOffsets;
      uniform vec2 u_centerL;
      uniform vec2 u_centerR;
      uniform float u_lensRadius;
      uniform vec3 u_offsetXL;
      uniform vec3 u_offsetYL;
      uniform vec3 u_offsetXR;
      uniform vec3 u_offsetYR;
      uniform int u_wrapX;
      uniform int u_level;
      uniform int u_qualityEnabled;
      uniform float u_contrast;
      uniform float u_saturation;
      uniform float u_wellExposed;
      uniform float u_confidence;
      uniform float u_exposureCurve;
      uniform int u_isReference;

      vec2 sampleUv(vec2 uv){
        if(u_wrapX==1)uv.x=fract(uv.x);else uv.x=clamp(uv.x,0.,1.);
        return vec2(uv.x,clamp(uv.y,0.,1.));
      }
      vec3 sampleFrame(vec2 uv){return texture(u_frame,sampleUv(uv)).rgb;}
      vec3 sampleReference(vec2 uv){return texture(u_reference,sampleUv(uv)).rgb;}
      float luma(vec3 c){return dot(c,vec3(.2126,.7152,.0722));}
      float cubicInOut(float x){x=clamp(x,0.,1.);return x<.5?4.*x*x*x:1.-pow(-2.*x+2.,3.)*.5;}
      vec3 normalizedFrame(vec2 uv){
        vec3 raw=clamp(sampleFrame(uv),0.,1.);
        return raw/max(raw+u_exposureCurve*(1.-raw),vec3(1e-5));
      }
      vec3 localFrame(vec2 uv){
        vec2 p=1./u_imageSize;
        return normalizedFrame(uv)*.5+(normalizedFrame(uv+vec2(p.x,0.))+normalizedFrame(uv-vec2(p.x,0.))+
          normalizedFrame(uv+vec2(0.,p.y))+normalizedFrame(uv-vec2(0.,p.y)))*.125;
      }
      vec3 localReference(vec2 uv){
        vec2 p=1./u_imageSize;
        return sampleReference(uv)*.5+(sampleReference(uv+vec2(p.x,0.))+sampleReference(uv-vec2(p.x,0.))+
          sampleReference(uv+vec2(0.,p.y))+sampleReference(uv-vec2(0.,p.y)))*.125;
      }
      float robustSample(vec2 uv,vec2 refUv,out vec3 band){
        vec3 raw=sampleFrame(uv),c=normalizedFrame(uv),ref=sampleReference(refUv);
        vec3 cf=localFrame(uv),rf=localReference(refUv);
        float yf=luma(cf),yr=luma(rf),hfF=luma(c)-yf,hfR=luma(ref)-yr,sharedDetail=min(abs(hfF),abs(hfR));
        float refY=luma(ref),rawY=luma(raw);
        float shadowNeed=1.-smoothstep(.10,.32,refY);
        float highlightNeed=smoothstep(.72,.96,max(ref.r,max(ref.g,ref.b)));
        float recoveryNeed=max(shadowNeed,highlightNeed);
        vec3 chromaF=cf-vec3(yf),chromaR=rf-vec3(yr);
        float mismatch=mix(1.,.25,recoveryNeed)*abs(yf-yr)+mix(.65,.12,recoveryNeed)*abs(hfF-hfR)+.35*length(chromaF-chromaR);
        float tolerance=.022+.10*sharedDetail+.055*recoveryNeed+.035*(1.-min(yf,yr));
        float consistency=exp(-pow(mismatch/max(tolerance,1e-4),2.));
        float lo=smoothstep(.006,.045,min(raw.r,min(raw.g,raw.b)));
        float hi=1.-smoothstep(.965,.997,max(raw.r,max(raw.g,raw.b)));
        float usable=max(.03,lo*hi);
        float y=luma(c),well=exp(-pow((y-.5)/.34,2.));
        float shadowHelp=shadowNeed*smoothstep(refY+.025,.55,rawY);
        float highlightHelp=highlightNeed*(1.-smoothstep(refY-.18,refY-.015,rawY));
        float detailControl=cubicInOut(u_contrast*.5),colorControl=cubicInOut(u_saturation*.5);
        float balanceRange=u_wellExposed*.5;
        float balanceControl=balanceRange<=1.?cubicInOut(balanceRange):1.+cubicInOut(balanceRange-1.);
        float exposureValue=.45+well+2.*balanceControl*(shadowHelp+highlightHelp);
        float colorTrust=mix(.55,1.,mix(1.,smoothstep(.008,.10,length(chromaF)),colorControl));
        float detailTrust=mix(.6,1.,mix(1.,smoothstep(.004,.05,sharedDetail),detailControl));
        vec2 p=1./u_imageSize;
        vec2 gradF=vec2(luma(normalizedFrame(uv+vec2(p.x,0.)))-luma(c),luma(normalizedFrame(uv+vec2(0.,p.y)))-luma(c));
        vec2 gradR=vec2(luma(sampleReference(refUv+vec2(p.x,0.)))-refY,luma(sampleReference(refUv+vec2(0.,p.y)))-refY);
        float magF=length(gradF),magR=length(gradR),direction=max(dot(gradF,gradR)/max(magF*magR,1e-5),0.);
        float matchedDetail=direction*smoothstep(magR,max(magR*1.6,.012),magF)*smoothstep(.006,.035,magR);
        float recoveredDetail=recoveryNeed*smoothstep(.012,.065,magF);
        float selectedDetail=max(matchedDetail,recoveredDetail*.7);
        float gradientSelection=1.+detailControl*2.5*selectedDetail;
        vec3 referenceDetail=ref-rf,frameDetail=c-cf;
        float detailDelta=luma(frameDetail)-luma(referenceDetail);
        vec3 detailOnly=clamp(ref+vec3(detailDelta*detailControl*selectedDetail),0.,1.);
        vec3 recoveryColor=clamp(vec3(y)+chromaF*(2.*colorControl),0.,1.);
        float recoveryMix=clamp(max(shadowHelp,highlightHelp)*balanceControl*.9*usable,0.,.9);
        band=mix(detailOnly,recoveryColor,recoveryMix);
        return consistency*usable*exposureValue*colorTrust*detailTrust*gradientSelection;
      }
      void main(){
        vec2 refUv=vec2(v_uv.x,1.-v_uv.y),uv=refUv;
        vec2 frameOffset=u_offsetL;
        if(u_splitOffsets==1){
          bool right=v_uv.x>=.5;
          vec2 center=right?u_centerR:u_centerL;
          vec2 n=(uv*u_imageSize-center)/max(u_lensRadius,1.);
          vec3 q=vec3(1.,n);
          frameOffset=right?vec2(dot(u_offsetXR,q),dot(u_offsetYR,q)):
            vec2(dot(u_offsetXL,q),dot(u_offsetYL,q));
        }
        uv+=frameOffset/u_imageSize;
        vec3 band=sampleFrame(uv);
        float weight=1.;
        if(u_qualityEnabled==1){
          if(u_isReference==1)band=sampleReference(refUv);
          else weight=robustSample(uv,refUv,band);
        }
        weight=max(weight,1e-6)*mix(.25,1.,clamp(u_confidence,0.,1.));
        fragColor=vec4(band*weight,weight);
      }`;
    const program = S360.createProgram(gl, vs, fs);
    program._u = {};
    ['u_frame','u_reference','u_imageSize','u_offsetL','u_offsetR','u_splitOffsets','u_centerL','u_centerR','u_lensRadius',
      'u_offsetXL','u_offsetYL','u_offsetXR','u_offsetYR','u_wrapX','u_level','u_qualityEnabled','u_contrast','u_saturation','u_wellExposed','u_confidence','u_exposureCurve','u_isReference']
      .forEach(name => { program._u[name] = gl.getUniformLocation(program, name); });
    return program;
  }

  function createResolveProgram(gl) {
    const vs = S360.QUAD_VS;
    const fs = `#version 300 es
      precision highp float;
      in vec2 v_uv;
      out vec4 fragColor;
      uniform sampler2D u_accum;
      uniform sampler2D u_base;
      uniform sampler2D u_low;
      uniform int u_toneEnabled;
      uniform float u_detailFinish;
      vec4 linearSample(sampler2D tex,vec2 uv){
        ivec2 size=textureSize(tex,0);
        vec2 p=uv*vec2(size)-.5;
        ivec2 i=ivec2(floor(p));
        vec2 f=fract(p);
        ivec2 hi=size-1;
        vec4 a=texelFetch(tex,clamp(i,ivec2(0),hi),0);
        vec4 b=texelFetch(tex,clamp(i+ivec2(1,0),ivec2(0),hi),0);
        vec4 c=texelFetch(tex,clamp(i+ivec2(0,1),ivec2(0),hi),0);
        vec4 d=texelFetch(tex,clamp(i+ivec2(1,1),ivec2(0),hi),0);
        return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);
      }
      // Accumulate texture is built top-row-first (north pole at v=1); the output
      // reads bottom-row-first, so flip Y on the sample to match orientations.
      vec3 fusedColor(vec2 uv){vec4 a=linearSample(u_accum,vec2(clamp(uv.x,0.,1.),1.-clamp(uv.y,0.,1.)));return clamp(a.rgb/max(a.a,1e-6),0.,1.);}
      vec3 fusedLow(vec2 uv){vec4 a=linearSample(u_low,vec2(clamp(uv.x,0.,1.),1.-clamp(uv.y,0.,1.)));return clamp(a.rgb/max(a.a,1e-6),0.,1.);}
      float luma(vec3 c){return dot(c,vec3(.2126,.7152,.0722));}
      float cubicInOut(float x){x=clamp(x,0.,1.);return x<.5?4.*x*x*x:1.-pow(-2.*x+2.,3.)*.5;}
      void main(){
        vec3 color=fusedColor(v_uv);
        if(u_toneEnabled==1){
        // The low-resolution fusion preserves broad exposure decisions while
        // the full-resolution level supplies the fine detail.
        vec3 lowColor=fusedLow(v_uv);
        float colorLum=luma(color), lowLum=luma(lowColor);
        float lowRatio=lowLum/max(colorLum,1e-4);
        color*=mix(1.,clamp(lowRatio,.7,1.3),.35);
        vec3 sum=color*1.5;
        float total=1.5,y0=luma(color);vec3 chroma0=color-vec3(y0);
        vec2 p=1./vec2(textureSize(u_accum,0));
        vec2 offsets[8]=vec2[8](vec2(1,0),vec2(-1,0),vec2(0,1),vec2(0,-1),vec2(1,1),vec2(-1,1),vec2(1,-1),vec2(-1,-1));
        for(int i=0;i<8;i++){
          vec3 nearby=fusedColor(v_uv+offsets[i]*p);float yn=luma(nearby);
          float delta=abs(yn-y0)+.25*length((nearby-vec3(yn))-chroma0);
          float weight=exp(-pow(delta/.045,2.))*(i<4?1.:.7);
          sum+=nearby*weight;total+=weight;
        }
        vec3 clean=sum/total;
        float retainedDetail=1.5*cubicInOut(u_detailFinish*.5);
        color=clamp(clean+(color-clean)*retainedDetail,0.,1.);
          vec3 linear=pow(color,vec3(2.2));
          float lum=dot(linear,vec3(.2126,.7152,.0722));
          float base=max(texture(u_base,v_uv).r,1e-4);
          float shoulder=.45;
          float mapped=base*(1.+shoulder*.18)/(1.+shoulder*base);
          float newLum=clamp(mapped*clamp(lum/base,.35,2.8),0.,1.);
          linear*=newLum/max(lum,1e-4);
          color=pow(clamp(linear,0.,1.),vec3(1./2.2));
          float gray=dot(color,vec3(.2126,.7152,.0722));
          color=clamp(mix(vec3(gray),color,1.025),0.,1.);
        }
        fragColor=vec4(color,1.);
      }`;
    const program = S360.createProgram(gl, vs, fs);
    program._u = { u_accum: gl.getUniformLocation(program, 'u_accum'), u_low: gl.getUniformLocation(program, 'u_low'), u_base: gl.getUniformLocation(program, 'u_base'),
      u_toneEnabled: gl.getUniformLocation(program, 'u_toneEnabled'), u_detailFinish: gl.getUniformLocation(program, 'u_detailFinish') };
    return program;
  }

  function createBaseProgram(gl) {
    const vs = S360.QUAD_VS;
    const fs=`#version 300 es
      precision highp float;in vec2 v_uv;out vec4 fragColor;uniform sampler2D u_accum;uniform vec2 u_step;
      float L(vec2 uv){vec4 a=texture(u_accum,vec2(uv.x,1.-uv.y));vec3 c=clamp(a.rgb/max(a.a,1e-6),0.,1.);return dot(pow(c,vec3(2.2)),vec3(.2126,.7152,.0722));}
      void main(){float s=L(v_uv)*.25;s+=(L(v_uv+vec2(u_step.x,0))+L(v_uv-vec2(u_step.x,0))+L(v_uv+vec2(0,u_step.y))+L(v_uv-vec2(0,u_step.y)))*.125;
        s+=(L(v_uv+u_step)+L(v_uv-u_step)+L(v_uv+vec2(u_step.x,-u_step.y))+L(v_uv+vec2(-u_step.x,u_step.y)))*.0625;fragColor=vec4(vec3(s),1);}`;
    const program=S360.createProgram(gl,vs,fs);program._u={u_accum:gl.getUniformLocation(program,'u_accum'),u_step:gl.getUniformLocation(program,'u_step')};return program;
  }

  function createBaseBlurProgram(gl) {
    const vs = S360.QUAD_VS;
    const fs=`#version 300 es
      precision highp float;in vec2 v_uv;out vec4 fragColor;uniform sampler2D u_tex;uniform vec2 u_step;uniform int u_split;
      vec2 safeUv(vec2 uv){if(u_split==1){float lo=v_uv.x<.5?0.:.5,hi=v_uv.x<.5?.5:1.;uv.x=clamp(uv.x,lo,hi);}return vec2(uv.x,clamp(uv.y,0.,1.));}
      void main(){float w0=.227027,w1=.194595,w2=.121621,w3=.054054,w4=.016216;vec3 c=texture(u_tex,v_uv).rgb*w0;
        c+=texture(u_tex,safeUv(v_uv+u_step)).rgb*w1+texture(u_tex,safeUv(v_uv-u_step)).rgb*w1;
        c+=texture(u_tex,safeUv(v_uv+u_step*2.)).rgb*w2+texture(u_tex,safeUv(v_uv-u_step*2.)).rgb*w2;
        c+=texture(u_tex,safeUv(v_uv+u_step*3.)).rgb*w3+texture(u_tex,safeUv(v_uv-u_step*3.)).rgb*w3;
        c+=texture(u_tex,safeUv(v_uv+u_step*4.)).rgb*w4+texture(u_tex,safeUv(v_uv-u_step*4.)).rgb*w4;fragColor=vec4(c,1);}`;
    const program=S360.createProgram(gl,vs,fs);program._u={u_tex:gl.getUniformLocation(program,'u_tex'),u_step:gl.getUniformLocation(program,'u_step'),u_split:gl.getUniformLocation(program,'u_split')};return program;
  }

  function makeAccumulators(gl, w, h, qualityEnabled) {
    if (!gl.getExtension('EXT_color_buffer_float')) {
      throw new Error('Exposure Fusion requires floating-point render-target support.');
    }
    const levels = qualityEnabled ? FUSION_LEVELS : [{ scale: 1, level: 4 }];
    return levels.map(({ scale, level }) => {
      const width = Math.max(1, Math.ceil(w / scale)), height = Math.max(1, Math.ceil(h / scale));
      const target = S360.createRenderTarget(gl, width, height, `Exposure Fusion level ${level}`, gl.CLAMP_TO_EDGE,
        { internalFormat: gl.RGBA16F, bytesPerPixel: 8, filter: gl.NEAREST });
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.viewport(0, 0, width, height);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      return { ...target, level };
    });
  }

  function uploadFrame(gl, image) {
    const texture = S360.createTrackedTexture(gl, {
      width: image.width, height: image.height, label: 'Exposure frame', bytesPerPixel: 4,
    }, () => {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
    });
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  S360.invalidateExposureFusionPrograms = function (gl) {
    if (gl) _state.delete(gl);
  };

  S360.processAndMergeExposureFusion = async function (gl, cfg, fileList, setLoading, scaleSource,
      loadImageFromFile, maxFrames = 64, modeLabel = 'Exposure Fusion', shouldCancel = null, analysis = null) {
    if (!fileList?.length) return;
    if (fileList.length > maxFrames) {
      S360.uiChrome.showToast(`${modeLabel} supports up to ${maxFrames} frames; ${fileList.length} were selected.`, { type: 'warning' });
      return;
    }
    const qualityEnabled = modeLabel !== 'Stack';
    const fusion = cfg.exposureFusion || { contrast: 1, saturation: 1, wellExposed: 1 };
    const state = stateFor(gl);
    state.accumulate ||= createAccumulateProgram(gl);
    state.resolve ||= createResolveProgram(gl);
    let w = 0, h = 0, accumulators = null, outTarget = null, referenceTexture = null, baseA = null, baseB = null;
    const cancelled = () => (shouldCancel?.() || gl.isContextLost());
    const check = () => { if (cancelled()) throw new DOMException('Processing cancelled.', 'AbortError'); };
    try {
      if (qualityEnabled) {
        const referenceIndex=analysis?.referenceIndex??0;
        setLoading(true,'Preparing balanced reference...');await S360.yieldToUI();
        let decoded=null,image=null;
        try {
          decoded=await loadImageFromFile(fileList[referenceIndex]);check();image=scaleSource(decoded);
          if(image!==decoded)S360.releaseImage(decoded);decoded=null;
          S360.validateTextureSize(gl,image.width,image.height,'Exposure Fusion reference');
          w=image.width;h=image.height;accumulators=makeAccumulators(gl,w,h,true);referenceTexture=uploadFrame(gl,image);
        } finally {S360.releaseImage(decoded);S360.releaseImage(image);}
      }
      for (let index = 0; index < fileList.length; index++) {
        check(); setLoading(true, `Fusing exposure ${index + 1} of ${fileList.length}...`); await S360.yieldToUI();
        let decoded = null, image = null, texture = null;
        try {
          const isReference = qualityEnabled && index === (analysis?.referenceIndex ?? 0);
          if (isReference) {
            // The balanced reference was already decoded, HD-scaled and
            // uploaded above. Reuse it for its accumulation pass instead of
            // briefly retaining a duplicate full-resolution frame.
            texture = referenceTexture;
          } else {
            decoded = await loadImageFromFile(fileList[index]); check();
            image = scaleSource(decoded);
            if (image !== decoded) S360.releaseImage(decoded);
            decoded = null;
            S360.validateTextureSize(gl, image.width, image.height, `${modeLabel} frame ${index + 1}`);
            if (!w) { w = image.width; h = image.height; accumulators = makeAccumulators(gl, w, h, qualityEnabled); }
            else if (image.width !== w || image.height !== h) throw new Error(`${modeLabel} frame ${index + 1} is ${image.width}x${image.height}; expected ${w}x${h}.`);
            texture = uploadFrame(gl, image);
          }
          const info = analysis?.frames?.[index] || { offset: [0, 0], confidence: 1 };
          const sx = w / Math.max(1, info.sourceSize?.[0] || w), sy = h / Math.max(1, info.sourceSize?.[1] || h);
          const scaledOffset = value => info.confidence < .08 ? [0,0] : [value[0]*sx,-value[1]*sy];
          const offsetL=scaledOffset(info.lensOffsets?.left || info.offset),offsetR=scaledOffset(info.lensOffsets?.right || info.offset);
          const scaledTransform=(value,offset)=>({
            x:value?.x?.map(v=>v*sx)||[offset[0],0,0],
            y:value?.y?.map(v=>-v*sy)||[offset[1],0,0]
          });
          const transformL=scaledTransform(info.lensTransforms?.left,offsetL),transformR=scaledTransform(info.lensTransforms?.right,offsetR);
          gl.useProgram(state.accumulate); gl.bindVertexArray(S360.getQuadVAO(gl));
          gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture);
          const u = state.accumulate._u;
          gl.uniform1i(u.u_frame, 0);
          gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,referenceTexture||texture);gl.uniform1i(u.u_reference,1);
          gl.uniform2f(u.u_imageSize, w, h);
          gl.uniform2f(u.u_offsetL,offsetL[0],offsetL[1]);gl.uniform2f(u.u_offsetR,offsetR[0],offsetR[1]);
          gl.uniform1i(u.u_splitOffsets,info.lensOffsets ? 1 : 0);
          gl.uniform2f(u.u_centerL,w*(cfg.centers?.left?.[0]??.25),h*(cfg.centers?.left?.[1]??.5));
          gl.uniform2f(u.u_centerR,w*(cfg.centers?.right?.[0]??.75),h*(cfg.centers?.right?.[1]??.5));
          gl.uniform1f(u.u_lensRadius,.5*h*Math.min(1,Math.max(.8,(cfg.outerMargin??100)/100)));
          gl.uniform3fv(u.u_offsetXL,transformL.x);gl.uniform3fv(u.u_offsetYL,transformL.y);
          gl.uniform3fv(u.u_offsetXR,transformR.x);gl.uniform3fv(u.u_offsetYR,transformR.y);
          gl.uniform1i(u.u_wrapX, analysis?.stitched ? 1 : 0); gl.uniform1i(u.u_qualityEnabled, qualityEnabled ? 1 : 0);
          gl.uniform1f(u.u_contrast, fusion.contrast); gl.uniform1f(u.u_saturation, fusion.saturation);
          gl.uniform1f(u.u_wellExposed, fusion.wellExposed); gl.uniform1f(u.u_confidence, info.confidence ?? 1);
          const refMedian=analysis?.frames?.[analysis?.referenceIndex??0]?.median??.5,currentMedian=info.median??refMedian;
          const exposureCurve=currentMedian*(1-refMedian)/Math.max(refMedian*(1-currentMedian),1e-4);
          gl.uniform1f(u.u_exposureCurve,Math.min(20,Math.max(.05,exposureCurve)));
           gl.uniform1i(u.u_isReference,isReference?1:0);
          gl.enable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE, gl.ONE);
          for (const target of accumulators) {
            gl.uniform1i(u.u_level, target.level); gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
            gl.viewport(0, 0, target.width, target.height); gl.drawArrays(gl.TRIANGLES, 0, 6);
          }
          gl.disable(gl.BLEND);
        } finally {
          if (texture && texture !== referenceTexture) S360.deleteTrackedTexture(gl, texture);
          S360.releaseImage(decoded); S360.releaseImage(image);
        }
      }
      check();
      if(qualityEnabled){
        const fullAccumulator = accumulators[accumulators.length - 1];
        state.base ||= createBaseProgram(gl);state.baseBlur ||= createBaseBlurProgram(gl);
        const bw=Math.max(2,Math.ceil(w/16)),bh=Math.max(2,Math.ceil(h/16)),wrap=analysis?.stitched?gl.REPEAT:gl.CLAMP_TO_EDGE;
        baseA=S360.createRenderTarget(gl,bw,bh,'Exposure Fusion tone base',wrap,{internalFormat:gl.RGBA16F,bytesPerPixel:8});
        baseB=S360.createRenderTarget(gl,bw,bh,'Exposure Fusion tone blur',wrap,{internalFormat:gl.RGBA16F,bytesPerPixel:8});
        gl.useProgram(state.base);gl.bindVertexArray(S360.getQuadVAO(gl));gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,fullAccumulator.tex);
        gl.uniform1i(state.base._u.u_accum,0);gl.uniform2f(state.base._u.u_step,.25/bw,.25/bh);gl.bindFramebuffer(gl.FRAMEBUFFER,baseA.fbo);gl.viewport(0,0,bw,bh);gl.drawArrays(gl.TRIANGLES,0,6);
        gl.useProgram(state.baseBlur);gl.uniform1i(state.baseBlur._u.u_tex,0);gl.uniform1i(state.baseBlur._u.u_split,analysis?.stitched?0:1);
        gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,baseA.tex);gl.uniform2f(state.baseBlur._u.u_step,1/bw,0);gl.bindFramebuffer(gl.FRAMEBUFFER,baseB.fbo);gl.drawArrays(gl.TRIANGLES,0,6);
        gl.bindTexture(gl.TEXTURE_2D,baseB.tex);gl.uniform2f(state.baseBlur._u.u_step,0,1/bh);gl.bindFramebuffer(gl.FRAMEBUFFER,baseA.fbo);gl.drawArrays(gl.TRIANGLES,0,6);
      }
      outTarget = S360.createRenderTarget(gl, w, h, `${modeLabel} output`);
      gl.bindFramebuffer(gl.FRAMEBUFFER, outTarget.fbo);
      gl.useProgram(state.resolve); gl.bindVertexArray(S360.getQuadVAO(gl));
      const fullAccumulator = accumulators[accumulators.length - 1];
      const lowAccumulator = accumulators[0];
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, fullAccumulator.tex);
      gl.uniform1i(state.resolve._u.u_accum, 0);
      gl.activeTexture(gl.TEXTURE2);gl.bindTexture(gl.TEXTURE_2D,lowAccumulator.tex);gl.uniform1i(state.resolve._u.u_low,2);
      gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,baseA?.tex||fullAccumulator.tex);gl.uniform1i(state.resolve._u.u_base,1);
      gl.uniform1i(state.resolve._u.u_toneEnabled,qualityEnabled?1:0);
      gl.uniform1f(state.resolve._u.u_detailFinish,qualityEnabled?fusion.contrast:1.);
      gl.viewport(0, 0, w, h); gl.drawArrays(gl.TRIANGLES, 0, 6); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const ownedOutput = outTarget.take();
      const result = S360.createGpuImage(gl, ownedOutput.texture, ownedOutput.framebuffer, w, h, { orientation: 'fbo' });
      outTarget = null;
      return result;
    } finally {
      gl.disable(gl.BLEND); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      accumulators?.forEach(target => target.dispose());
      baseA?.dispose();baseB?.dispose();if(referenceTexture)S360.deleteTrackedTexture(gl,referenceTexture);
      outTarget?.dispose();
    }
  };

})(window.S360);
