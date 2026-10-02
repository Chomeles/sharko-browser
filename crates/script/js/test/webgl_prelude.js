'use strict';
// Helpers shared by the WebGL cases (as a source string: they run inside the page of Sharko or Chromium).
module.exports = `
function ctx(kind, w, h, attrs) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const gl = c.getContext(kind, Object.assign({ antialias: false, preserveDrawingBuffer: true }, attrs));
  if (!gl) throw new Error('no ' + kind);
  return gl;
}
function prog(gl, v, f) {
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s)); return s; };
  const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, v)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, f)); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
  return p;
}
function quad(gl, loc, data) {
  const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
}
function rd(gl, x, y) { const px = new Uint8Array(4); gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); return Array.from(px); }
`;
