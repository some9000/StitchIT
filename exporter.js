// exporter.js
window.S360 = window.S360 || {};
(function (S360) {
'use strict';
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

  // ── XMP (GPano) APP1 handling ────────────────────────────────────────────
  // The XMP APP1 payload is the NUL-terminated Adobe namespace string
  // followed by the XMP packet; the 2-byte segment length includes itself.
  const XMP_NS = 'http://ns.adobe.com/xap/1.0/\0';

  function matchesXmpNs(u8, at) {
      for (let i = 0; i < XMP_NS.length; i++) {
          if (u8[at + i] !== XMP_NS.charCodeAt(i)) return false;
      }
      return true;
  }

  // Collect [markerStart, segmentEnd) byte spans of every XMP APP1 segment.
  // Only real header segments are walked: scanning stops at SOS (after it,
  // 0xFF bytes are entropy-coded image data, not markers) or EOI, and
  // standalone markers without a length field are skipped correctly.
  function findXmpSpans(u8) {
      const spans = [];
      let off = 2; // skip SOI
      while (off + 4 <= u8.length) {
          if (u8[off] !== 0xFF) break; // not a marker — stop before misreading data
          const m = u8[off + 1];
          if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { // no length field
              off += 2;
              continue;
          }
          if (m === 0xD9 || m === 0xDA) break; // EOI / start of scan
          const segLen = (u8[off + 2] << 8) | u8[off + 3]; // includes its own 2 bytes
          if (segLen < 2) break; // corrupt length — don't advance into image data
          if (m === 0xE1 && segLen >= 2 + XMP_NS.length && matchesXmpNs(u8, off + 4)) {
              spans.push([off, off + 2 + segLen]);
          }
          off += 2 + segLen;
      }
      return spans;
  }

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
              const xmpHeader = new TextEncoder().encode(XMP_NS);

              const totalLen = 2 + xmpHeader.length + xmpBytes.length;
              if (totalLen > 0xFFFF) {
                  return reject(new Error('XMP packet too large for a JPEG APP1 segment.'));
              }
              const marker = new Uint8Array([0xFF, 0xE1, (totalLen >> 8) & 0xFF, totalLen & 0xFF]);

              const combined = new Uint8Array(marker.length + xmpHeader.length + xmpBytes.length);
              combined.set(marker, 0);
              combined.set(xmpHeader, marker.length);
              combined.set(xmpBytes, marker.length + xmpHeader.length);

              // Keep exactly one, current GPano record in the file:
              //  • No existing XMP → insert as APP1 immediately after SOI,
              //    before any other metadata (JFIF APP0 / EXIF APP1). This works
              //    with any marker ordering and never touches the entropy-coded
              //    data that follows SOS.
              //  • Existing XMP (i.e. re-exporting a previously exported file,
              //    loaded back as a "Stitched" source) → replace the first XMP
              //    APP1 in place, preserving the source segment ordering, and
              //    strip any additional stale duplicates left behind by earlier
              //    exports. Without this the file accumulates one XMP segment
              //    per export, and viewers read the first (stale) one.
              const spans = findXmpSpans(uint8Array);
              const parts = [];
              if (spans.length === 0) {
                  parts.push(uint8Array.subarray(0, 2), combined, uint8Array.subarray(2));
              } else {
                  let cursor = 0;
                  for (let i = 0; i < spans.length; i++) {
                      parts.push(uint8Array.subarray(cursor, spans[i][0]));
                      cursor = spans[i][1];
                      if (i === 0) parts.push(combined);
                  }
                  parts.push(uint8Array.subarray(cursor));
              }

              resolve(new Blob(parts, { type: 'image/jpeg' }));
          };

          reader.onerror = reject;
          reader.readAsArrayBuffer(blob);
      });
  };

  S360.generateExportCanvas = function (gl, panoramaCanvas, renderOffscreenPixels, targetWidth, targetHeight) {
      const { w, h } = S360.clampToGpuLimits(gl, targetWidth, targetHeight);
      // renderOffscreenPixels now renders off-screen and returns a canvas via a
      // tiled (memory-bounded) FBO readback, so no extra buffer->canvas copy here.
      // skipPost=true: exports are "clean" (no post-processing, no live decals) so
      // that re-loading an exported stitched source doesn't double-apply them.
      return renderOffscreenPixels(w, h, true);
  };

  S360.renderFullAndExport = async function (gl, panoramaCanvas, currentImg, renderOffscreenPixels, injectXMPMetadata, mime, quality, injectXMP = false, outputScale = 1) {
      const fullW = Math.round(currentImg.width * outputScale);
      const fullH = Math.round(fullW / 2);

      const exportCanvas = S360.generateExportCanvas(gl, panoramaCanvas, renderOffscreenPixels, fullW, fullH);
      const actualW = exportCanvas.width;
      const actualH = exportCanvas.height;

      let blob = await S360.encodeExportCanvas(exportCanvas, mime, quality);

      if (injectXMP && mime === 'image/jpeg') {
          return { blob: await injectXMPMetadata(blob, actualW, actualH), actualW, actualH };
      }
      return { blob, actualW, actualH };
  };

  // Shared encoder for full panorama and patch experiment exports.
  S360.encodeExportCanvas = async function (exportCanvas, mime, quality) {
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

      return blob;
  };
})(window.S360);
