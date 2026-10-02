'use strict';
// OffscreenCanvas / ImageBitmap cases (run in Sharko and Chromium, see webgl_golden.js). They are async: the
// runner awaits the returned promise. `ctx` and `rd` come from webgl_prelude.js.
module.exports = {
  async offscreen_2d() {
    const oc = new OffscreenCanvas(10, 6);
    const c = oc.getContext('2d');
    c.fillStyle = 'rgb(10, 200, 30)'; c.fillRect(2, 1, 4, 3);
    const d = c.getImageData(3, 2, 1, 1).data;
    const m = c.measureText('Hi');
    return { size: [oc.width, oc.height], pix: Array.from(d), same: oc.getContext('2d') === c, back: c.canvas === oc, other: oc.getContext('webgl'), tag: Object.prototype.toString.call(c), ctor: c.constructor.name,
      measure: m.width > 0 && typeof m.actualBoundingBoxAscent === 'number', clear: Array.from(c.getImageData(0, 0, 1, 1).data), isOff: oc instanceof EventTarget,
      resize: (oc.width = 4, [oc.width, Array.from(c.getImageData(3, 2, 1, 1).data)]) };
  },
  async offscreen_webgl() {
    const oc = new OffscreenCanvas(6, 4);
    const gl = oc.getContext('webgl', { antialias: false, preserveDrawingBuffer: true });
    gl.clearColor(0.2, 0.4, 0.8, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    const px = new Uint8Array(4); gl.readPixels(1, 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const bmp = oc.transferToImageBitmap();
    const drawn = readSource(bmp, 6, 4).slice(0, 8);
    return { px: Array.from(px), canvas: gl.canvas === oc, bmp: [bmp.width, bmp.height], drawn, tag: Object.prototype.toString.call(gl), second: oc.getContext('webgl2'), size: [gl.drawingBufferWidth, gl.drawingBufferHeight] };
  },
  async offscreen_blob_bitmap() {
    const oc = new OffscreenCanvas(3, 2);
    const gl = oc.getContext('webgl', { antialias: false }); gl.clearColor(1, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    const blob = await oc.convertToBlob();
    const id = new ImageData(new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 9, 9, 9, 255]), 2, 2);
    const b1 = await createImageBitmap(id);
    const b2 = await createImageBitmap(id, 1, 0, 1, 2);
    const b3 = await createImageBitmap(oc);
    const b4 = await createImageBitmap(id, { resizeWidth: 4, resizeHeight: 4 });
    const r = [b1.width, b1.height, b2.width, b2.height, b3.width, b3.height, b4.width, b4.height];
    const sub = readSource(b2, 1, 2);
    b1.close();
    let err; try { await createImageBitmap(b1); } catch (e) { err = e.name; }
    let err2; try { await createImageBitmap(id, 0, 0, 0, 5); } catch (e) { err2 = e.name; }
    const br = new OffscreenCanvas(2, 2); const bctx = br.getContext('bitmaprenderer'); bctx.transferFromImageBitmap(b4);
    return { blob: [blob.type, blob.size > 20], dims: r, closed: [b1.width, b1.height], sub, err, err2, bitmapCanvas: [br.width, br.height], bctxCanvas: bctx.canvas === br, tag: Object.prototype.toString.call(b2) };
  },
  async offscreen_transfer() {
    const canvas = document.createElement('canvas'); canvas.width = 5; canvas.height = 3;
    const oc = canvas.transferControlToOffscreen();
    const gl = oc.getContext('webgl', { antialias: false, preserveDrawingBuffer: true }); gl.clearColor(0, 1, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    const shown = Array.from(await new Promise((res) => { setTimeout(() => res(readSource(canvas, 5, 3).slice(0, 4)), 50); }));
    let err; try { canvas.getContext('2d'); } catch (e) { err = e.name; }
    let err2; try { canvas.transferControlToOffscreen(); } catch (e) { err2 = e.name; }
    return { size: [oc.width, oc.height], shown, err, err2, tag: Object.prototype.toString.call(oc) };
  },
};
