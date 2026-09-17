// Prepare a complete source before replacing the currently displayed image.
window.S360 = window.S360 || {};
(function (S360) {
'use strict';
  S360.prepareSourceTexture = function (gl, image, cfg, preservedGain, options = {}) {
    let texture = null, lf = null, scratch = null;
    const sourceWidth=image.width,sourceHeight=image.height;
    const lowFrequency = options.lowFrequency !== false;
    function updateEdits(edits) {
      const w=Math.max(1,sourceWidth>>1),h=Math.max(1,sourceHeight>>1);
      // Recompute only the changed blur regions, with a four-tap sampling halo.
      function apply(previous) {
        gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
        for(const e of edits){const p=previous?e.previous:e.pixels;
          gl.texSubImage2D(gl.TEXTURE_2D,0,e.x,e.y,p.width,p.height,gl.RGBA,gl.UNSIGNED_BYTE,p.data);
        }
        if (!lf) return;
        const prog=S360.progs.getLfProgram();
        gl.useProgram(prog);gl.bindVertexArray(S360.getQuadVAO(gl));gl.viewport(0,0,w,h);
        gl.uniform1i(prog._u.u_tex,0);gl.uniform2f(prog._u.u_texel,1/w,1/h);
        gl.enable(gl.SCISSOR_TEST);
        for(const e of edits){
          const x=Math.max(0,Math.floor(e.x*w/sourceWidth)-6),y=Math.max(0,Math.floor(e.y*h/sourceHeight)-6);
          const right=Math.min(w,Math.ceil((e.x+e.pixels.width)*w/sourceWidth)+6);
          const top=Math.min(h,Math.ceil((e.y+e.pixels.height)*h/sourceHeight)+6);
          if(right<=x||top<=y)continue; // sub-pixel edit region in the LF texture: nothing to blur
          const sy=Math.max(0,y-5),st=Math.min(h,top+5);
          gl.scissor(x,sy,right-x,st-sy);gl.bindFramebuffer(gl.FRAMEBUFFER,scratch.fbo);
          gl.bindTexture(gl.TEXTURE_2D,texture);gl.uniform2f(prog._u.u_dir,1,0);gl.drawArrays(gl.TRIANGLES,0,6);
          gl.scissor(x,y,right-x,top-y);gl.bindFramebuffer(gl.FRAMEBUFFER,lf.fbo);
          gl.bindTexture(gl.TEXTURE_2D,scratch.tex);gl.uniform2f(prog._u.u_dir,0,1);gl.drawArrays(gl.TRIANGLES,0,6);
        }
      }
      if (!lf) {
        try {
          apply(false);
          const error=gl.getError();
          if(gl.isContextLost()||error!==gl.NO_ERROR)throw new Error(`Source edit failed on the GPU (${error}).`);
        } catch(error) {
          if(!gl.isContextLost())apply(true);
          throw error;
        }
        return;
      }
      try {
        scratch=S360.createRenderTarget(gl,w,h,'Source edit blur scratch');
        apply(false);
        const error=gl.getError();
        if(gl.isContextLost()||error!==gl.NO_ERROR)throw new Error(`Source edit failed on the GPU (${error}).`);
      } catch(error) {
        if(scratch&&!gl.isContextLost())apply(true);
        throw error;
      } finally {gl.disable(gl.SCISSOR_TEST);gl.bindFramebuffer(gl.FRAMEBUFFER,null);scratch?.dispose();scratch=null;}
    }
    function dispose() {
      if (texture) S360.deleteTrackedTexture(gl, texture);
      texture = null;
      lf?.dispose(); lf = null;
      scratch?.dispose(); scratch = null;
    }
    try {
      S360.validateTextureSize(gl, image.width, image.height, 'Source image');
      const gain = preservedGain || (lowFrequency ? S360.estimateGainRFromSource(gl, image, cfg) : { gain: [1, 1, 1] });
      if (image.isGpuImage) {
        texture = image.takeTexture();
        S360.relabelTrackedTexture(texture, 'Source texture');
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture);
      } else {
        texture = S360.createTrackedTexture(gl, {
          width: image.width, height: image.height, label: 'Source texture', bytesPerPixel: 4,
        }, () => {
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
          gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, image.width, image.height);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, image);
        });
      }
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      if (lowFrequency) {
        const w = Math.max(1, image.width >> 1), h = Math.max(1, image.height >> 1);
        lf = S360.createRenderTarget(gl, w, h, 'Source low frequency');
        scratch = S360.createRenderTarget(gl, w, h, 'Source blur scratch');
        const prog = S360.progs.getLfProgram();
        gl.useProgram(prog); gl.bindVertexArray(S360.getQuadVAO(gl));
        gl.viewport(0, 0, w, h);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.uniform1i(prog._u.u_tex, 0);
        gl.uniform2f(prog._u.u_texel, 1 / w, 1 / h);
        gl.uniform2f(prog._u.u_dir, 1, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, scratch.fbo);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        gl.bindTexture(gl.TEXTURE_2D, scratch.tex);
        gl.uniform2f(prog._u.u_dir, 0, 1);
        gl.bindFramebuffer(gl.FRAMEBUFFER, lf.fbo);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
      const error = gl.getError();
      if (gl.isContextLost() || error !== gl.NO_ERROR) throw new Error(`Source preparation failed on the GPU (${error}).`);
      scratch?.dispose(); scratch = null;
      return { image, texture, gain, lfTex: lf?.tex || null, dispose, updateEdits };
    } catch (error) { dispose(); throw error; }
    finally { gl.bindFramebuffer(gl.FRAMEBUFFER, null); }
  };
})(window.S360);
