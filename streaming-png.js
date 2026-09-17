// Owns strip-based PNG encoding, avoiding a full-resolution output canvas or pixel buffer.
// create(width, height) exposes write(strip), finish() -> Blob, and abort().
globalThis.S360 = globalThis.S360 || {};
S360.streamingPng = (() => {
  'use strict';
  const table = Uint32Array.from({ length: 256 }, (_, n) => {
    for (let k = 0; k < 8; k++) n = n&1 ? 0xedb88320^(n>>>1) : n>>>1;
    return n>>>0;
  });
  function chunk(type, data = new Uint8Array(0)) {
    const out = new Uint8Array(data.length+12), view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4+i] = type.charCodeAt(i);
    out.set(data, 8);let crc = 0xffffffff;
    for (let i = 4; i < out.length-4; i++) crc = table[(crc^out[i])&255]^(crc>>>8);
    view.setUint32(out.length-4, (crc^0xffffffff)>>>0);return out;
  }
  function create(width, height) {
    if (typeof CompressionStream === 'undefined') throw new Error('PNG streaming needs a current Chrome, Edge, Firefox or Safari browser.');
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 32768 || height > 16384)
      throw new Error('Invalid streaming PNG dimensions.');
    const header = new Uint8Array(13), view = new DataView(header.buffer);
    view.setUint32(0, width);view.setUint32(4, height);header[8] = 8;header[9] = 6;
    const parts = [new Uint8Array([137,80,78,71,13,10,26,10]), chunk('IHDR', header)];
    const stream = new CompressionStream('deflate'), writer = stream.writable.getWriter(), reader = stream.readable.getReader();
    let written = 0, stopped = false;
    const collecting = (async () => { for (;;) { const { value, done } = await reader.read();if (done) break;parts.push(chunk('IDAT', value)); } })();
    collecting.catch(() => {});
    return {
      async write({ top, rows, data }) {
        if (stopped || top !== written || rows < 1 || top+rows > height || data.length !== width*rows*4) throw new Error('PNG strips are out of sequence.');
        const stride = width*4, filtered = new Uint8Array((stride+1)*rows);
        for (let y = 0; y < rows; y++) {
          const q = y*(stride+1), p = y*stride; filtered[q] = 1;
          for (let x = 0; x < stride; x++) filtered[q+1+x] = (data[p+x]-(x >= 4 ? data[p+x-4] : 0))&255;
        }
        await writer.write(filtered);written += rows;
      },
      async finish() {
        if (stopped || written !== height) throw new Error('PNG output is incomplete.');
        await writer.close();await collecting;stopped = true;parts.push(chunk('IEND'));
        const blob = new Blob(parts, { type: 'image/png' });parts.length = 0;return blob;
      },
      async abort() { if (!stopped) { stopped = true;await writer.abort().catch(() => {});await collecting.catch(() => {}); } parts.length = 0; }
    };
  }
  return { create };
})();
