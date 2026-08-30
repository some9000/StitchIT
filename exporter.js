// exporter.js
window.S360 = window.S360 || {};
(function (S360) {
  S360.clampToGpuLimits = function (gl, desiredW, desiredH) {
       const maxDim = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_VIEWPORT_DIMS)[0]);
       const w = Math.min(desiredW, maxDim) - (Math.min(desiredW, maxDim) % 2);
       const h = Math.floor(w / 2);
       return { w: h * 2, h };
   };

  S360.getSafeRenderSize = function (gl, panoramaCanvas, desiredW, desiredH) {
      let { w: finalW, h } = S360.clampToGpuLimits(gl, desiredW, desiredH);
      // Only assign width/height when they actually change: setting a canvas's
      // width or height resets (clears) its drawing buffer even when the value
      // is identical, which caused visible flicker of stale/unprocessed frames
      // while dragging processing sliders.
      if (panoramaCanvas.width !== finalW) panoramaCanvas.width = finalW;
      if (panoramaCanvas.height !== h) panoramaCanvas.height = h;

      if (gl.drawingBufferWidth < finalW || gl.drawingBufferHeight < h) {
          h = Math.min(h, gl.drawingBufferHeight, Math.floor(gl.drawingBufferWidth / 2));
          finalW = h * 2;
          if (panoramaCanvas.width !== finalW) panoramaCanvas.width = finalW;
          if (panoramaCanvas.height !== h) panoramaCanvas.height = h;
      }

      const clamped = finalW !== desiredW || h !== desiredH;
      return { w: finalW, h, clamped };
  };

  S360.injectXMPMetadata = function (blob, width, height) {
      return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = function (e) {
              const uint8Array = new Uint8Array(e.target.result);
              if (uint8Array[0] !== 0xFF || uint8Array[1] !== 0xD8) {
                  return reject(new Error('File is not a valid JPEG.'));
              }

              const xmp = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
   <x:xmpmeta xmlns:x="adobe:ns:meta/">
     <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
       <rdf:Description rdf:about=""
         xmlns:GPano="http://ns.google.com/photos/1.0/panorama/">
         <GPano:UsePanoramaViewer>True</GPano:UsePanoramaViewer>
         <GPano:ProjectionType>equirectangular</GPano:ProjectionType>
         <GPano:CroppedAreaLeftPixels>0</GPano:CroppedAreaLeftPixels>
         <GPano:CroppedAreaTopPixels>0</GPano:CroppedAreaTopPixels>
         <GPano:CroppedAreaImageWidthPixels>${width}</GPano:CroppedAreaImageWidthPixels>
         <GPano:CroppedAreaImageHeightPixels>${height}</GPano:CroppedAreaImageHeightPixels>
         <GPano:FullPanoWidthPixels>${width}</GPano:FullPanoWidthPixels>
         <GPano:FullPanoHeightPixels>${height}</GPano:FullPanoHeightPixels>
       </rdf:Description>
     </rdf:RDF>
   </x:xmpmeta>
   <?xpacket end="w"?>`;

              const xmpBytes = new TextEncoder().encode(xmp);
              const xmpHeader = new TextEncoder().encode('http://ns.adobe.com/xap/1.0/\0');

              const totalLen = 2 + xmpHeader.length + xmpBytes.length;
              const marker = new Uint8Array([0xFF, 0xE1, (totalLen >> 8) & 0xFF, totalLen & 0xFF]);

              const combined = new Uint8Array(marker.length + xmpHeader.length + xmpBytes.length);
              combined.set(marker, 0);
              combined.set(xmpHeader, marker.length);
              combined.set(xmpBytes, marker.length + xmpHeader.length);

              // Insert XMP as APP1 immediately after SOI (standard, robust placement).
              // This avoids fragile scanning for the "right" insertion point and works
              // with any JPEG marker ordering.
              let insertOffset = 2;

              const newData = new Uint8Array(uint8Array.length + combined.length);
              newData.set(uint8Array.subarray(0, insertOffset), 0);
              newData.set(combined, insertOffset);
              newData.set(uint8Array.subarray(insertOffset), insertOffset + combined.length);

              resolve(new Blob([newData], { type: 'image/jpeg' }));
          };

          reader.onerror = reject;
          reader.readAsArrayBuffer(blob);
      });
  };

  S360.generateExportCanvas = function (gl, panoramaCanvas, renderOffscreenPixels, targetWidth, targetHeight) {
      const { w, h } = S360.clampToGpuLimits(gl, targetWidth, targetHeight);
      // renderOffscreenPixels now renders off-screen and returns a canvas via a
      // tiled (memory-bounded) FBO readback, so no extra buffer->canvas copy here.
      return renderOffscreenPixels(w, h);
  };

  S360.renderFullAndExport = async function (gl, panoramaCanvas, currentImg, renderOffscreenPixels, injectXMPMetadata, mime, quality, injectXMP = false) {
      const fullW = currentImg.width;
      const fullH = Math.round(fullW / 2);

      const exportCanvas = S360.generateExportCanvas(gl, panoramaCanvas, renderOffscreenPixels, fullW, fullH);
      const actualW = exportCanvas.width;
      const actualH = exportCanvas.height;

      let blob;
      // Encode off the main thread when the browser supports OffscreenCanvas
      // encoding — a 16K PNG/JPEG otherwise stalls the UI for seconds.
      if (typeof OffscreenCanvas !== 'undefined' && OffscreenCanvas.prototype.convertToBlob) {
        const off = new OffscreenCanvas(exportCanvas.width, exportCanvas.height);
        off.getContext('2d').drawImage(exportCanvas, 0, 0);
        blob = await off.convertToBlob({ type: mime, quality });
      } else {
        blob = await new Promise((resolve, reject) => {
          exportCanvas.toBlob(b => b ? resolve(b) : reject(new Error('Export failed')), mime, quality);
        });
      }

      if (injectXMP && mime === 'image/jpeg') {
          return { blob: await injectXMPMetadata(blob, actualW, actualH), actualW, actualH };
      }
      return { blob, actualW, actualH };
  };
})(window.S360);
