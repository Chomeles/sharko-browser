// 3d_webgl2_misc.js — the remaining WebGL2 entry points: indexed buffer bindings, uniform block queries,
// transform feedback objects, internalformat queries. Uniform buffer objects and transform feedback are not
// implemented: the limits that describe them are 0 (see LIM in 36_webgl.js) and the calls that need them
// fail with the errors the spec gives for exceeded limits.
(function (L) {
  'use strict';
  const G = L.glInternals;
  const { C, C2, LIM, FMT, gerr, glenum, glint, argsReq, stOf, isObjOf, rec, wrapObj, classes } = G;
  const { M2 } = G;
  const IF2 = 'WebGL2RenderingContext';
  const { WebGLTransformFeedback, WebGLProgram } = classes;

  function indexedSlot(S, target, index) {
    if (target === C2.UNIFORM_BUFFER) { if (index >= LIM.maxUniformBufferBindings) { gerr(S, C.INVALID_VALUE); return null; } return 'ubo'; }
    if (target === C2.TRANSFORM_FEEDBACK_BUFFER) { if (index >= LIM.maxTfSeparateAttribs) { gerr(S, C.INVALID_VALUE); return null; } return 'tf'; }
    gerr(S, C.INVALID_ENUM); return null;
  }
  M2.bindBufferBase = function bindBufferBase(target, index, buffer) {
    argsReq(IF2, 'bindBufferBase', 3, arguments.length);
    const S = stOf(this); if (S.lost) return;
    const slot = indexedSlot(S, glenum(target), glenum(index)); if (slot === null) return;
    void buffer;
  };
  M2.bindBufferRange = function bindBufferRange(target, index, buffer, offset, size) {
    argsReq(IF2, 'bindBufferRange', 5, arguments.length);
    const S = stOf(this); if (S.lost) return;
    const slot = indexedSlot(S, glenum(target), glenum(index)); if (slot === null) return;
    void buffer; void offset; void size;
  };
  M2.getIndexedParameter = function getIndexedParameter(target, index) {
    argsReq(IF2, 'getIndexedParameter', 2, arguments.length);
    const S = stOf(this); if (S.lost) return null;
    target = glenum(target); index = glenum(index);
    const ok = [C2.UNIFORM_BUFFER_BINDING, C2.UNIFORM_BUFFER_START, C2.UNIFORM_BUFFER_SIZE, C2.TRANSFORM_FEEDBACK_BUFFER_BINDING, C2.TRANSFORM_FEEDBACK_BUFFER_START, C2.TRANSFORM_FEEDBACK_BUFFER_SIZE];
    if (!ok.includes(target)) { gerr(S, C.INVALID_ENUM); return null; }
    gerr(S, C.INVALID_VALUE); void index; return null;
  };
  const notProgram = (S, p) => { if (!(p instanceof WebGLProgram)) throw G.typeErr(IF2, 'program', 1, 'WebGLProgram'); if (!isObjOf(S, p, WebGLProgram) || rec(p).deleted || !rec(p).linked) { gerr(S, C.INVALID_OPERATION); return true; } return false; };
  M2.getUniformBlockIndex = function getUniformBlockIndex(p, name) { argsReq(IF2, 'getUniformBlockIndex', 2, arguments.length); const S = stOf(this); if (S.lost) return C2.INVALID_INDEX; if (notProgram(S, p)) return C2.INVALID_INDEX; void name; return C2.INVALID_INDEX; };
  M2.getActiveUniformBlockParameter = function getActiveUniformBlockParameter(p) { argsReq(IF2, 'getActiveUniformBlockParameter', 3, arguments.length); const S = stOf(this); if (S.lost) return null; if (notProgram(S, p)) return null; gerr(S, C.INVALID_VALUE); return null; };
  M2.getActiveUniformBlockName = function getActiveUniformBlockName(p) { argsReq(IF2, 'getActiveUniformBlockName', 2, arguments.length); const S = stOf(this); if (S.lost) return null; if (notProgram(S, p)) return null; gerr(S, C.INVALID_VALUE); return null; };
  M2.uniformBlockBinding = function uniformBlockBinding(p) { argsReq(IF2, 'uniformBlockBinding', 3, arguments.length); const S = stOf(this); if (S.lost) return; if (notProgram(S, p)) return; gerr(S, C.INVALID_VALUE); };
  M2.getUniformIndices = function getUniformIndices(p, names) {
    argsReq(IF2, 'getUniformIndices', 2, arguments.length);
    const S = stOf(this); if (S.lost) return null; if (notProgram(S, p)) return null;
    const act = rec(p).link.active;
    return Array.from(names, (n) => { const i = act.findIndex((lf) => lf.name === `${n}` || lf.name === `${n}[0]`); return i < 0 ? C2.INVALID_INDEX : i; });
  };
  M2.getActiveUniforms = function getActiveUniforms(p, indices, pname) {
    argsReq(IF2, 'getActiveUniforms', 3, arguments.length);
    const S = stOf(this); if (S.lost) return null; if (notProgram(S, p)) return null;
    pname = glenum(pname);
    const act = rec(p).link.active;
    const idx = Array.from(indices, (i) => Number(i) >>> 0);
    if (idx.some((i) => i >= act.length)) { gerr(S, C.INVALID_VALUE); return null; }
    switch (pname) {
      case C2.UNIFORM_TYPE: return idx.map((i) => G.GL_TYPE[act[i].t]);
      case C2.UNIFORM_SIZE: return idx.map((i) => act[i].size);
      case C2.UNIFORM_BLOCK_INDEX: return idx.map(() => -1);
      case C2.UNIFORM_OFFSET: case C2.UNIFORM_ARRAY_STRIDE: case C2.UNIFORM_MATRIX_STRIDE: return idx.map(() => -1);
      case C2.UNIFORM_IS_ROW_MAJOR: return idx.map(() => false);
      default: gerr(S, C.INVALID_ENUM); return null;
    }
  };
  // transform feedback objects: created and bound, but capturing needs the (unimplemented) buffer bindings
  M2.createTransformFeedback = function createTransformFeedback() { const S = stOf(this); if (S.lost) return null; return wrapObj(WebGLTransformFeedback, S, { kind: 'tf', active: false, paused: false, deleted: false, id: 1, target: 0 }); };
  M2.deleteTransformFeedback = function deleteTransformFeedback(t) {
    const S = stOf(this); if (S.lost || t === null || t === undefined) return;
    if (!(t instanceof WebGLTransformFeedback)) throw G.typeErr(IF2, 'deleteTransformFeedback', 1, 'WebGLTransformFeedback');
    if (!isObjOf(S, t, WebGLTransformFeedback)) return gerr(S, C.INVALID_OPERATION);
    rec(t).deleted = true; if (S.tf === rec(t)) S.tf = null;
  };
  M2.isTransformFeedback = function isTransformFeedback(t) { const S = stOf(this); return !S.lost && isObjOf(S, t, WebGLTransformFeedback) && !rec(t).deleted && rec(t).target !== 0; };
  M2.bindTransformFeedback = function bindTransformFeedback(target, t) {
    argsReq(IF2, 'bindTransformFeedback', 2, arguments.length);
    const S = stOf(this); if (S.lost) return;
    if (glenum(target) !== C2.TRANSFORM_FEEDBACK) return gerr(S, C.INVALID_ENUM);
    if (S.tf && S.tf.active && !S.tf.paused) return gerr(S, C.INVALID_OPERATION);
    if (t === null || t === undefined) { S.tf = null; return; }
    if (!isObjOf(S, t, WebGLTransformFeedback) || rec(t).deleted) return gerr(S, C.INVALID_OPERATION);
    rec(t).target = C2.TRANSFORM_FEEDBACK; S.tf = rec(t);
  };
  M2.beginTransformFeedback = function beginTransformFeedback(mode) { argsReq(IF2, 'beginTransformFeedback', 1, arguments.length); const S = stOf(this); if (S.lost) return; if (![C.POINTS, C.LINES, C.TRIANGLES].includes(glenum(mode))) return gerr(S, C.INVALID_ENUM); gerr(S, C.INVALID_OPERATION); };
  M2.endTransformFeedback = function endTransformFeedback() { const S = stOf(this); if (!S.lost) gerr(S, C.INVALID_OPERATION); };
  M2.pauseTransformFeedback = function pauseTransformFeedback() { const S = stOf(this); if (!S.lost) gerr(S, C.INVALID_OPERATION); };
  M2.resumeTransformFeedback = function resumeTransformFeedback() { const S = stOf(this); if (!S.lost) gerr(S, C.INVALID_OPERATION); };
  M2.transformFeedbackVaryings = function transformFeedbackVaryings(p, varyings, mode) {
    argsReq(IF2, 'transformFeedbackVaryings', 3, arguments.length);
    const S = stOf(this); if (S.lost) return;
    if (!(p instanceof WebGLProgram)) throw G.typeErr(IF2, 'transformFeedbackVaryings', 1, 'WebGLProgram');
    if (!isObjOf(S, p, WebGLProgram) || rec(p).deleted) return gerr(S, C.INVALID_OPERATION);
    mode = glenum(mode);
    if (mode !== C2.INTERLEAVED_ATTRIBS && mode !== C2.SEPARATE_ATTRIBS) return gerr(S, C.INVALID_ENUM);
    const names = Array.from(varyings, String);
    if (mode === C2.SEPARATE_ATTRIBS && names.length > LIM.maxTfSeparateAttribs) return gerr(S, C.INVALID_VALUE);
    rec(p).tfVaryings = names; rec(p).tfMode = mode;
  };
  M2.getTransformFeedbackVarying = function getTransformFeedbackVarying(p, index) {
    argsReq(IF2, 'getTransformFeedbackVarying', 2, arguments.length);
    const S = stOf(this); if (S.lost) return null; if (notProgram(S, p)) return null;
    gerr(S, C.INVALID_VALUE); void index; return null;
  };
  M2.getInternalformatParameter = function getInternalformatParameter(target, internalformat, pname) {
    argsReq(IF2, 'getInternalformatParameter', 3, arguments.length);
    const S = stOf(this); if (S.lost) return null;
    target = glenum(target); internalformat = glenum(internalformat); pname = glenum(pname);
    if (target !== C.RENDERBUFFER) { gerr(S, C.INVALID_ENUM); return null; }
    const f = FMT.get(internalformat);
    if (!f || f.unsized || !f.renderable) { gerr(S, C.INVALID_ENUM); return null; }
    if (pname !== C2.SAMPLES) { gerr(S, C.INVALID_ENUM); return null; }
    return new Int32Array(0); // no multisampled renderbuffers: MAX_SAMPLES is 0
  };
  void glint;
})(globalThis.__layer);
