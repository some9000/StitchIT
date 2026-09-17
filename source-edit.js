// Owns editable source canvas and one transactional pixel undo. init({ctx,getSource}).
window.S360 = window.S360 || {};
(function (S360) {
'use strict';
  let ctx, getSource, editable = null, previous = null;
  function snapshot() {
    const { image, gain } = getSource();
    if (!image) return null;
    return { image, source: { width: image.width, height: image.height,
      stitched: ctx.getStitched(), cfg: JSON.parse(JSON.stringify(ctx.cfg)), gain: [...(gain?.gain || [1,1,1])] } };
  }
  function sourceCanvas(image) {
    if (editable === image) return editable;
    if (!image.isGpuImage) {
      const c = document.createElement('canvas'); c.width = image.width; c.height = image.height;
      c.getContext('2d', { willReadFrequently: true }).drawImage(image, 0, 0);
      return c;
    }
    // Copy the live adopted texture, since a GPU image's original handle is consumed.
    const gl = ctx.gl, target = S360.createRenderTarget(gl, image.width, image.height, 'Editable source readback');
    try {
      const program = S360.progs.getCopyProgram();
      gl.useProgram(program);gl.bindVertexArray(S360.getQuadVAO(gl));
      gl.bindFramebuffer(gl.FRAMEBUFFER,target.fbo);gl.viewport(0,0,image.width,image.height);
      gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,getSource().texture);
      gl.uniform1i(program._u.u_tex,0);
      gl.uniform1f(program._u.u_grainStrength,0);gl.uniform1f(program._u.u_chromaCleanup,0);
      gl.drawArrays(gl.TRIANGLES,0,6);
      return S360.readFboToCanvas(gl,target.fbo,image.width,image.height);
    } finally { gl.bindFramebuffer(gl.FRAMEBUFFER,null);target.dispose(); }
  }
  function commit(job, patches) {
    if (ctx.gl.isContextLost() || ctx.getCurrentImg() !== job.image) return false;
    if (!patches.length) return false;
    const canvas = sourceCanvas(job.image), paint = canvas.getContext('2d', {willReadFrequently:true});
    const before = [], edits = [];
    try {
      for (const p of patches) {
        const old = paint.getImageData(p.x,p.y,p.width,p.height);
        const next = new ImageData(new Uint8ClampedArray(old.data),p.width,p.height);
        let changed = false;
        for(let i=0;i<p.data.length;i+=4){
          const a=p.data[i+3]/255;if(!a)continue;
          const oldA=old.data[i+3]/255, outA=a+oldA*(1-a);
          for(let c=0;c<3;c++)next.data[i+c]=(p.data[i+c]*a+old.data[i+c]*oldA*(1-a))/outA;
          next.data[i+3]=outA*255;
          for(let c=0;c<4;c++)if(next.data[i+c]!==old.data[i+c])changed=true;
        }
        if(changed){before.push({x:p.x,y:p.y,pixels:old});edits.push({x:p.x,y:p.y,pixels:next,previous:old});paint.putImageData(next,p.x,p.y);}
      }
      if(!before.length){if(canvas!==editable)S360.releaseImage(canvas);return false;}
      S360.loaders.replaceEditedSource(canvas,job.image,edits);
      editable=canvas;previous=before;
    } catch(error) {
      for(const p of before)paint.putImageData(p.pixels,p.x,p.y);
      if(canvas!==editable)S360.releaseImage(canvas);
      throw error;
    }
    ctx.renderPano();return true;
  }
  function readPixels(job) {
    if (!job || ctx.gl.isContextLost() || ctx.getCurrentImg() !== job.image) throw new DOMException('Source changed.', 'AbortError');
    const canvas = sourceCanvas(job.image);
    try { return canvas.getContext('2d', {willReadFrequently:true}).getImageData(0, 0, canvas.width, canvas.height); }
    finally { if (canvas !== editable) S360.releaseImage(canvas); }
  }
  function createReader(job, blockSize=128) {
    if (!job || ctx.gl.isContextLost() || ctx.getCurrentImg() !== job.image) throw new DOMException('Source changed.', 'AbortError');
    const canvas=sourceCanvas(job.image),paint=canvas.getContext('2d',{willReadFrequently:true}),cache=new Map();
    let last=null;
    function pixel(x,y,out,offset){
      x=Math.max(0,Math.min(canvas.width-1,x));y=Math.max(0,Math.min(canvas.height-1,y));
      let block=last;
      if(!block||x<block.x||y<block.y||x>=block.x+block.width||y>=block.y+block.height){
        const bx=Math.floor(x/blockSize)*blockSize,by=Math.floor(y/blockSize)*blockSize,key=bx+','+by;
        block=cache.get(key);if(!block){
          const width=Math.min(blockSize,canvas.width-bx),height=Math.min(blockSize,canvas.height-by);
          block={data:paint.getImageData(bx,by,width,height).data,x:bx,y:by,width,height};cache.set(key,block);
        }
        last=block;
      }
      const i=((y-block.y)*block.width+x-block.x)*4;for(let c=0;c<4;c++)out[offset+c]=block.data[i+c];
    }
    const samples=new Uint8Array(16);
    return {sample(x,y,out){
      x=Math.max(0,Math.min(canvas.width-1,x));y=Math.max(0,Math.min(canvas.height-1,y));
      const x0=Math.floor(x),y0=Math.floor(y),x1=Math.min(canvas.width-1,x0+1),y1=Math.min(canvas.height-1,y0+1);
      const tx=x-x0,ty=y-y0,p=samples;pixel(x0,y0,p,0);pixel(x1,y0,p,4);pixel(x0,y1,p,8);pixel(x1,y1,p,12);
      for(let c=0;c<4;c++){const a=p[c]*(1-tx)+p[4+c]*tx,b=p[8+c]*(1-tx)+p[12+c]*tx;out[c]=a*(1-ty)+b*ty;}return out;
    },release(){last=null;cache.clear();if(canvas!==editable)S360.releaseImage(canvas);}};
  }
  function regionReader(job) {
    // Acquire the editable source canvas once and serve clamped region reads
    // from it, so callers never copy or read back the full image.
    if (!job || ctx.gl.isContextLost() || ctx.getCurrentImg() !== job.image) throw new DOMException('Source changed.', 'AbortError');
    const canvas = sourceCanvas(job.image), paint = canvas.getContext('2d', {willReadFrequently:true});
    return {
      read(x, y, w, h) {
        x=Math.max(0,Math.min(canvas.width-1,x|0));y=Math.max(0,Math.min(canvas.height-1,y|0));
        w=Math.max(1,Math.min(canvas.width-x,w|0));h=Math.max(1,Math.min(canvas.height-y,h|0));
        return paint.getImageData(x,y,w,h);
      },
      release() { if (canvas !== editable) S360.releaseImage(canvas); }
    };
  }
  function undo() {
    if(!previous || editable!==ctx.getCurrentImg() || ctx.gl.isContextLost())return false;
    const paint=editable.getContext('2d'), restore=previous;
    const redo=restore.map(p=>({x:p.x,y:p.y,pixels:paint.getImageData(p.x,p.y,p.pixels.width,p.pixels.height)}));
    try {
      for(const p of restore)paint.putImageData(p.pixels,p.x,p.y);
      S360.loaders.replaceEditedSource(editable,editable,restore.map((p,i)=>({...p,previous:redo[i].pixels})));
      previous=null;
    }catch(error){for(const p of redo)paint.putImageData(p.pixels,p.x,p.y);throw error;}
    ctx.renderPano();return true;
  }
  S360.sourceEdit={init(deps){({ctx,getSource}=deps);},snapshot,readPixels,createReader,regionReader,commit,undo,
    reset(){editable=null;previous=null;},get canUndo(){return !!previous && editable===ctx.getCurrentImg();}};
})(window.S360);
