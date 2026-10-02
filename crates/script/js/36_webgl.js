// 36_webgl.js — WebGLRenderingContext and WebGL2RenderingContext (WebGL 1.0 / 2.0, OpenGL ES 2.0 / 3.0 semantics).
//
// The context keeps all GL state, validates calls like Chromium/ANGLE (error codes, `getError`),
// compiles shaders with 33..35_glsl_*.js and draws with the software pipeline of 37_glraster.js into a
// drawing buffer that is presented into the canvas (N.canvasPutImageData).
//
// What this implementation really supports is what it reports (getParameter, getSupportedExtensions,
// getShaderPrecisionFormat, getContextAttributes): no multisampling (antialias is always false),
// no compressed textures, aliased line width 1. The limits are the ones of a Chrome/ANGLE D3D11
// context where this implementation can honour them (allocation failures raise OUT_OF_MEMORY).
(function (L) {
  'use strict';
  const N = L.N;
  const INTERNAL = L.INTERNAL;
  const DOMException = L.DOMException;

  // ---------------------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------------------
  const C = {
    DEPTH_BUFFER_BIT: 0x100, STENCIL_BUFFER_BIT: 0x400, COLOR_BUFFER_BIT: 0x4000, POINTS: 0, LINES: 1, LINE_LOOP: 2, LINE_STRIP: 3, TRIANGLES: 4, TRIANGLE_STRIP: 5, TRIANGLE_FAN: 6,
    ZERO: 0, ONE: 1, SRC_COLOR: 0x300, ONE_MINUS_SRC_COLOR: 0x301, SRC_ALPHA: 0x302, ONE_MINUS_SRC_ALPHA: 0x303, DST_ALPHA: 0x304, ONE_MINUS_DST_ALPHA: 0x305, DST_COLOR: 0x306,
    ONE_MINUS_DST_COLOR: 0x307, SRC_ALPHA_SATURATE: 0x308, FUNC_ADD: 0x8006, BLEND_EQUATION: 0x8009, BLEND_EQUATION_RGB: 0x8009, BLEND_EQUATION_ALPHA: 0x883D, FUNC_SUBTRACT: 0x800A,
    FUNC_REVERSE_SUBTRACT: 0x800B, BLEND_DST_RGB: 0x80C8, BLEND_SRC_RGB: 0x80C9, BLEND_DST_ALPHA: 0x80CA, BLEND_SRC_ALPHA: 0x80CB, CONSTANT_COLOR: 0x8001, ONE_MINUS_CONSTANT_COLOR: 0x8002,
    CONSTANT_ALPHA: 0x8003, ONE_MINUS_CONSTANT_ALPHA: 0x8004, BLEND_COLOR: 0x8005, ARRAY_BUFFER: 0x8892, ELEMENT_ARRAY_BUFFER: 0x8893, ARRAY_BUFFER_BINDING: 0x8894,
    ELEMENT_ARRAY_BUFFER_BINDING: 0x8895, STREAM_DRAW: 0x88E0, STATIC_DRAW: 0x88E4, DYNAMIC_DRAW: 0x88E8, BUFFER_SIZE: 0x8764, BUFFER_USAGE: 0x8765, CURRENT_VERTEX_ATTRIB: 0x8626,
    FRONT: 0x404, BACK: 0x405, FRONT_AND_BACK: 0x408, TEXTURE_2D: 0xDE1, CULL_FACE: 0xB44, BLEND: 0xBE2, DITHER: 0xBD0, STENCIL_TEST: 0xB90, DEPTH_TEST: 0xB71, SCISSOR_TEST: 0xC11,
    POLYGON_OFFSET_FILL: 0x8037, SAMPLE_ALPHA_TO_COVERAGE: 0x809E, SAMPLE_COVERAGE: 0x80A0, NO_ERROR: 0, INVALID_ENUM: 0x500, INVALID_VALUE: 0x501, INVALID_OPERATION: 0x502,
    OUT_OF_MEMORY: 0x505, CW: 0x900, CCW: 0x901, LINE_WIDTH: 0xB21, ALIASED_POINT_SIZE_RANGE: 0x846D, ALIASED_LINE_WIDTH_RANGE: 0x846E, CULL_FACE_MODE: 0xB45, FRONT_FACE: 0xB46,
    DEPTH_RANGE: 0xB70, DEPTH_WRITEMASK: 0xB72, DEPTH_CLEAR_VALUE: 0xB73, DEPTH_FUNC: 0xB74, STENCIL_CLEAR_VALUE: 0xB91, STENCIL_FUNC: 0xB92, STENCIL_FAIL: 0xB94,
    STENCIL_PASS_DEPTH_FAIL: 0xB95, STENCIL_PASS_DEPTH_PASS: 0xB96, STENCIL_REF: 0xB97, STENCIL_VALUE_MASK: 0xB93, STENCIL_WRITEMASK: 0xB98, STENCIL_BACK_FUNC: 0x8800,
    STENCIL_BACK_FAIL: 0x8801, STENCIL_BACK_PASS_DEPTH_FAIL: 0x8802, STENCIL_BACK_PASS_DEPTH_PASS: 0x8803, STENCIL_BACK_REF: 0x8CA3, STENCIL_BACK_VALUE_MASK: 0x8CA4,
    STENCIL_BACK_WRITEMASK: 0x8CA5, VIEWPORT: 0xBA2, SCISSOR_BOX: 0xC10, COLOR_CLEAR_VALUE: 0xC22, COLOR_WRITEMASK: 0xC23, UNPACK_ALIGNMENT: 0xCF5, PACK_ALIGNMENT: 0xD05,
    MAX_TEXTURE_SIZE: 0xD33, MAX_VIEWPORT_DIMS: 0xD3A, SUBPIXEL_BITS: 0xD50, RED_BITS: 0xD52, GREEN_BITS: 0xD53, BLUE_BITS: 0xD54, ALPHA_BITS: 0xD55, DEPTH_BITS: 0xD56,
    STENCIL_BITS: 0xD57, POLYGON_OFFSET_UNITS: 0x2A00, POLYGON_OFFSET_FACTOR: 0x8038, TEXTURE_BINDING_2D: 0x8069, SAMPLE_BUFFERS: 0x80A8, SAMPLES: 0x80A9, SAMPLE_COVERAGE_VALUE: 0x80AA,
    SAMPLE_COVERAGE_INVERT: 0x80AB, COMPRESSED_TEXTURE_FORMATS: 0x86A3, DONT_CARE: 0x1100, FASTEST: 0x1101, NICEST: 0x1102, GENERATE_MIPMAP_HINT: 0x8192, BYTE: 0x1400,
    UNSIGNED_BYTE: 0x1401, SHORT: 0x1402, UNSIGNED_SHORT: 0x1403, INT: 0x1404, UNSIGNED_INT: 0x1405, FLOAT: 0x1406, DEPTH_COMPONENT: 0x1902, ALPHA: 0x1906, RGB: 0x1907, RGBA: 0x1908,
    LUMINANCE: 0x1909, LUMINANCE_ALPHA: 0x190A, UNSIGNED_SHORT_4_4_4_4: 0x8033, UNSIGNED_SHORT_5_5_5_1: 0x8034, UNSIGNED_SHORT_5_6_5: 0x8363, FRAGMENT_SHADER: 0x8B30,
    VERTEX_SHADER: 0x8B31, MAX_VERTEX_ATTRIBS: 0x8869, MAX_VERTEX_UNIFORM_VECTORS: 0x8DFB, MAX_VARYING_VECTORS: 0x8DFC, MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8B4D,
    MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0x8B4C, MAX_TEXTURE_IMAGE_UNITS: 0x8872, MAX_FRAGMENT_UNIFORM_VECTORS: 0x8DFD, SHADER_TYPE: 0x8B4F, DELETE_STATUS: 0x8B80, LINK_STATUS: 0x8B82,
    VALIDATE_STATUS: 0x8B83, ATTACHED_SHADERS: 0x8B85, ACTIVE_UNIFORMS: 0x8B86, ACTIVE_ATTRIBUTES: 0x8B89, SHADING_LANGUAGE_VERSION: 0x8B8C, CURRENT_PROGRAM: 0x8B8D, NEVER: 0x200,
    LESS: 0x201, EQUAL: 0x202, LEQUAL: 0x203, GREATER: 0x204, NOTEQUAL: 0x205, GEQUAL: 0x206, ALWAYS: 0x207, KEEP: 0x1E00, REPLACE: 0x1E01, INCR: 0x1E02, DECR: 0x1E03, INVERT: 0x150A,
    INCR_WRAP: 0x8507, DECR_WRAP: 0x8508, VENDOR: 0x1F00, RENDERER: 0x1F01, VERSION: 0x1F02, NEAREST: 0x2600, LINEAR: 0x2601, NEAREST_MIPMAP_NEAREST: 0x2700,
    LINEAR_MIPMAP_NEAREST: 0x2701, NEAREST_MIPMAP_LINEAR: 0x2702, LINEAR_MIPMAP_LINEAR: 0x2703, TEXTURE_MAG_FILTER: 0x2800, TEXTURE_MIN_FILTER: 0x2801, TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803, TEXTURE: 0x1702, TEXTURE_CUBE_MAP: 0x8513, TEXTURE_BINDING_CUBE_MAP: 0x8514, TEXTURE_CUBE_MAP_POSITIVE_X: 0x8515, TEXTURE_CUBE_MAP_NEGATIVE_X: 0x8516,
    TEXTURE_CUBE_MAP_POSITIVE_Y: 0x8517, TEXTURE_CUBE_MAP_NEGATIVE_Y: 0x8518, TEXTURE_CUBE_MAP_POSITIVE_Z: 0x8519, TEXTURE_CUBE_MAP_NEGATIVE_Z: 0x851A,
    MAX_CUBE_MAP_TEXTURE_SIZE: 0x851C, ACTIVE_TEXTURE: 0x84E0, REPEAT: 0x2901, CLAMP_TO_EDGE: 0x812F, MIRRORED_REPEAT: 0x8370, FLOAT_VEC2: 0x8B50, FLOAT_VEC3: 0x8B51,
    FLOAT_VEC4: 0x8B52, INT_VEC2: 0x8B53, INT_VEC3: 0x8B54, INT_VEC4: 0x8B55, BOOL: 0x8B56, BOOL_VEC2: 0x8B57, BOOL_VEC3: 0x8B58, BOOL_VEC4: 0x8B59, FLOAT_MAT2: 0x8B5A,
    FLOAT_MAT3: 0x8B5B, FLOAT_MAT4: 0x8B5C, SAMPLER_2D: 0x8B5E, SAMPLER_CUBE: 0x8B60, VERTEX_ATTRIB_ARRAY_ENABLED: 0x8622, VERTEX_ATTRIB_ARRAY_SIZE: 0x8623,
    VERTEX_ATTRIB_ARRAY_STRIDE: 0x8624, VERTEX_ATTRIB_ARRAY_TYPE: 0x8625, VERTEX_ATTRIB_ARRAY_NORMALIZED: 0x886A, VERTEX_ATTRIB_ARRAY_POINTER: 0x8645,
    VERTEX_ATTRIB_ARRAY_BUFFER_BINDING: 0x889F, IMPLEMENTATION_COLOR_READ_TYPE: 0x8B9A, IMPLEMENTATION_COLOR_READ_FORMAT: 0x8B9B, COMPILE_STATUS: 0x8B81, LOW_FLOAT: 0x8DF0,
    MEDIUM_FLOAT: 0x8DF1, HIGH_FLOAT: 0x8DF2, LOW_INT: 0x8DF3, MEDIUM_INT: 0x8DF4, HIGH_INT: 0x8DF5, FRAMEBUFFER: 0x8D40, RENDERBUFFER: 0x8D41, RGBA4: 0x8056, RGB5_A1: 0x8057,
    RGB565: 0x8D62, DEPTH_COMPONENT16: 0x81A5, STENCIL_INDEX8: 0x8D48, DEPTH_STENCIL: 0x84F9, RENDERBUFFER_WIDTH: 0x8D42, RENDERBUFFER_HEIGHT: 0x8D43,
    RENDERBUFFER_INTERNAL_FORMAT: 0x8D44, RENDERBUFFER_RED_SIZE: 0x8D50, RENDERBUFFER_GREEN_SIZE: 0x8D51, RENDERBUFFER_BLUE_SIZE: 0x8D52, RENDERBUFFER_ALPHA_SIZE: 0x8D53,
    RENDERBUFFER_DEPTH_SIZE: 0x8D54, RENDERBUFFER_STENCIL_SIZE: 0x8D55, FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE: 0x8CD0, FRAMEBUFFER_ATTACHMENT_OBJECT_NAME: 0x8CD1,
    FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL: 0x8CD2, FRAMEBUFFER_ATTACHMENT_TEXTURE_CUBE_MAP_FACE: 0x8CD3, COLOR_ATTACHMENT0: 0x8CE0, DEPTH_ATTACHMENT: 0x8D00,
    STENCIL_ATTACHMENT: 0x8D20, DEPTH_STENCIL_ATTACHMENT: 0x821A, NONE: 0, FRAMEBUFFER_COMPLETE: 0x8CD5, FRAMEBUFFER_INCOMPLETE_ATTACHMENT: 0x8CD6,
    FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT: 0x8CD7, FRAMEBUFFER_INCOMPLETE_DIMENSIONS: 0x8CD9, FRAMEBUFFER_UNSUPPORTED: 0x8CDD, FRAMEBUFFER_BINDING: 0x8CA6,
    RENDERBUFFER_BINDING: 0x8CA7, MAX_RENDERBUFFER_SIZE: 0x84E8, INVALID_FRAMEBUFFER_OPERATION: 0x506, UNPACK_FLIP_Y_WEBGL: 0x9240, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
    CONTEXT_LOST_WEBGL: 0x9242, UNPACK_COLORSPACE_CONVERSION_WEBGL: 0x9243, BROWSER_DEFAULT_WEBGL: 0x9244, RGB8: 0x8051, RGBA8: 0x8058,
  };
  for (let i = 0; i < 32; i++) C[`TEXTURE${i}`] = 0x84C0 + i;
  const C2 = {
    READ_BUFFER: 0x0C02, UNPACK_ROW_LENGTH: 0x0CF2, UNPACK_SKIP_ROWS: 0x0CF3, UNPACK_SKIP_PIXELS: 0x0CF4, PACK_ROW_LENGTH: 0x0D02, PACK_SKIP_ROWS: 0x0D03, PACK_SKIP_PIXELS: 0x0D04,
    COLOR: 0x1800, DEPTH: 0x1801, STENCIL: 0x1802, RED: 0x1903, RGB8: 0x8051, RGBA8: 0x8058, RGB10_A2: 0x8059, TEXTURE_BINDING_3D: 0x806A, UNPACK_SKIP_IMAGES: 0x806D,
    UNPACK_IMAGE_HEIGHT: 0x806E, TEXTURE_3D: 0x806F, TEXTURE_WRAP_R: 0x8072, MAX_3D_TEXTURE_SIZE: 0x8073, UNSIGNED_INT_2_10_10_10_REV: 0x8368, MAX_ELEMENTS_VERTICES: 0x80E8,
    MAX_ELEMENTS_INDICES: 0x80E9, TEXTURE_MIN_LOD: 0x813A, TEXTURE_MAX_LOD: 0x813B, TEXTURE_BASE_LEVEL: 0x813C, TEXTURE_MAX_LEVEL: 0x813D, MIN: 0x8007, MAX: 0x8008,
    DEPTH_COMPONENT24: 0x81A6, MAX_TEXTURE_LOD_BIAS: 0x84FD, TEXTURE_COMPARE_MODE: 0x884C, TEXTURE_COMPARE_FUNC: 0x884D, CURRENT_QUERY: 0x8865, QUERY_RESULT: 0x8866,
    QUERY_RESULT_AVAILABLE: 0x8867, STREAM_READ: 0x88E1, STREAM_COPY: 0x88E2, STATIC_READ: 0x88E5, STATIC_COPY: 0x88E6, DYNAMIC_READ: 0x88E9, DYNAMIC_COPY: 0x88EA,
    MAX_DRAW_BUFFERS: 0x8824, DRAW_BUFFER0: 0x8825, DRAW_BUFFER1: 0x8826, DRAW_BUFFER2: 0x8827, DRAW_BUFFER3: 0x8828, DRAW_BUFFER4: 0x8829, DRAW_BUFFER5: 0x882A,
    DRAW_BUFFER6: 0x882B, DRAW_BUFFER7: 0x882C, DRAW_BUFFER8: 0x882D, DRAW_BUFFER9: 0x882E, DRAW_BUFFER10: 0x882F, DRAW_BUFFER11: 0x8830, DRAW_BUFFER12: 0x8831,
    DRAW_BUFFER13: 0x8832, DRAW_BUFFER14: 0x8833, DRAW_BUFFER15: 0x8834, MAX_FRAGMENT_UNIFORM_COMPONENTS: 0x8B49, MAX_VERTEX_UNIFORM_COMPONENTS: 0x8B4A, SAMPLER_3D: 0x8B5F,
    SAMPLER_2D_SHADOW: 0x8B62, FRAGMENT_SHADER_DERIVATIVE_HINT: 0x8B8B, PIXEL_PACK_BUFFER: 0x88EB, PIXEL_UNPACK_BUFFER: 0x88EC, PIXEL_PACK_BUFFER_BINDING: 0x88ED,
    PIXEL_UNPACK_BUFFER_BINDING: 0x88EF, FLOAT_MAT2x3: 0x8B65, FLOAT_MAT2x4: 0x8B66, FLOAT_MAT3x2: 0x8B67, FLOAT_MAT3x4: 0x8B68, FLOAT_MAT4x2: 0x8B69, FLOAT_MAT4x3: 0x8B6A,
    SRGB: 0x8C40, SRGB8: 0x8C41, SRGB8_ALPHA8: 0x8C43, COMPARE_REF_TO_TEXTURE: 0x884E, RGBA32F: 0x8814, RGB32F: 0x8815, RGBA16F: 0x881A, RGB16F: 0x881B,
    VERTEX_ATTRIB_ARRAY_INTEGER: 0x88FD, MAX_ARRAY_TEXTURE_LAYERS: 0x88FF, MIN_PROGRAM_TEXEL_OFFSET: 0x8904, MAX_PROGRAM_TEXEL_OFFSET: 0x8905, MAX_VARYING_COMPONENTS: 0x8B4B,
    TEXTURE_2D_ARRAY: 0x8C1A, TEXTURE_BINDING_2D_ARRAY: 0x8C1D, R11F_G11F_B10F: 0x8C3A, UNSIGNED_INT_10F_11F_11F_REV: 0x8C3B, RGB9_E5: 0x8C3D, UNSIGNED_INT_5_9_9_9_REV: 0x8C3E,
    TRANSFORM_FEEDBACK_BUFFER_MODE: 0x8C7F, MAX_TRANSFORM_FEEDBACK_SEPARATE_COMPONENTS: 0x8C80, TRANSFORM_FEEDBACK_VARYINGS: 0x8C83, TRANSFORM_FEEDBACK_BUFFER_START: 0x8C84,
    TRANSFORM_FEEDBACK_BUFFER_SIZE: 0x8C85, TRANSFORM_FEEDBACK_PRIMITIVES_WRITTEN: 0x8C88, MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS: 0x8C8A,
    MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS: 0x8C8B, INTERLEAVED_ATTRIBS: 0x8C8C, SEPARATE_ATTRIBS: 0x8C8D, TRANSFORM_FEEDBACK_BUFFER: 0x8C8E, TRANSFORM_FEEDBACK_BUFFER_BINDING: 0x8C8F,
    TRANSFORM_FEEDBACK: 0x8E22, TRANSFORM_FEEDBACK_PAUSED: 0x8E23, TRANSFORM_FEEDBACK_ACTIVE: 0x8E24, TRANSFORM_FEEDBACK_BINDING: 0x8E25, FRAMEBUFFER_ATTACHMENT_COLOR_ENCODING: 0x8210,
    FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE: 0x8211, FRAMEBUFFER_ATTACHMENT_RED_SIZE: 0x8212, FRAMEBUFFER_ATTACHMENT_GREEN_SIZE: 0x8213, FRAMEBUFFER_ATTACHMENT_BLUE_SIZE: 0x8214,
    FRAMEBUFFER_ATTACHMENT_ALPHA_SIZE: 0x8215, FRAMEBUFFER_ATTACHMENT_DEPTH_SIZE: 0x8216, FRAMEBUFFER_ATTACHMENT_STENCIL_SIZE: 0x8217, FRAMEBUFFER_DEFAULT: 0x8218,
    DEPTH24_STENCIL8: 0x88F0, DRAW_FRAMEBUFFER_BINDING: 0x8CA6, READ_FRAMEBUFFER: 0x8CA8, DRAW_FRAMEBUFFER: 0x8CA9, READ_FRAMEBUFFER_BINDING: 0x8CAA, RENDERBUFFER_SAMPLES: 0x8CAB,
    FRAMEBUFFER_ATTACHMENT_TEXTURE_LAYER: 0x8CD4, MAX_COLOR_ATTACHMENTS: 0x8CDF, COLOR_ATTACHMENT1: 0x8CE1, COLOR_ATTACHMENT2: 0x8CE2, COLOR_ATTACHMENT3: 0x8CE3,
    COLOR_ATTACHMENT4: 0x8CE4, COLOR_ATTACHMENT5: 0x8CE5, COLOR_ATTACHMENT6: 0x8CE6, COLOR_ATTACHMENT7: 0x8CE7, COLOR_ATTACHMENT8: 0x8CE8, COLOR_ATTACHMENT9: 0x8CE9,
    COLOR_ATTACHMENT10: 0x8CEA, COLOR_ATTACHMENT11: 0x8CEB, COLOR_ATTACHMENT12: 0x8CEC, COLOR_ATTACHMENT13: 0x8CED, COLOR_ATTACHMENT14: 0x8CEE, COLOR_ATTACHMENT15: 0x8CEF,
    FRAMEBUFFER_INCOMPLETE_MULTISAMPLE: 0x8D56, MAX_SAMPLES: 0x8D57, HALF_FLOAT: 0x140B, RG: 0x8227, RG_INTEGER: 0x8228, R8: 0x8229, RG8: 0x822B, R16F: 0x822D, R32F: 0x822E,
    RG16F: 0x822F, RG32F: 0x8230, R8I: 0x8231, R8UI: 0x8232, R16I: 0x8233, R16UI: 0x8234, R32I: 0x8235, R32UI: 0x8236, RG8I: 0x8237, RG8UI: 0x8238, RG16I: 0x8239, RG16UI: 0x823A,
    RG32I: 0x823B, RG32UI: 0x823C, VERTEX_ARRAY_BINDING: 0x85B5, R8_SNORM: 0x8F94, RG8_SNORM: 0x8F95, RGB8_SNORM: 0x8F96, RGBA8_SNORM: 0x8F97, SIGNED_NORMALIZED: 0x8F9C,
    COPY_READ_BUFFER: 0x8F36, COPY_WRITE_BUFFER: 0x8F37, COPY_READ_BUFFER_BINDING: 0x8F36, COPY_WRITE_BUFFER_BINDING: 0x8F37, UNIFORM_BUFFER: 0x8A11, UNIFORM_BUFFER_BINDING: 0x8A28,
    UNIFORM_BUFFER_START: 0x8A29, UNIFORM_BUFFER_SIZE: 0x8A2A, MAX_VERTEX_UNIFORM_BLOCKS: 0x8A2B, MAX_FRAGMENT_UNIFORM_BLOCKS: 0x8A2D, MAX_COMBINED_UNIFORM_BLOCKS: 0x8A2E,
    MAX_UNIFORM_BUFFER_BINDINGS: 0x8A2F, MAX_UNIFORM_BLOCK_SIZE: 0x8A30, MAX_COMBINED_VERTEX_UNIFORM_COMPONENTS: 0x8A31, MAX_COMBINED_FRAGMENT_UNIFORM_COMPONENTS: 0x8A33,
    UNIFORM_BUFFER_OFFSET_ALIGNMENT: 0x8A34, ACTIVE_UNIFORM_BLOCKS: 0x8A36, UNIFORM_TYPE: 0x8A37, UNIFORM_SIZE: 0x8A38, UNIFORM_BLOCK_INDEX: 0x8A3A, UNIFORM_OFFSET: 0x8A3B,
    UNIFORM_ARRAY_STRIDE: 0x8A3C, UNIFORM_MATRIX_STRIDE: 0x8A3D, UNIFORM_IS_ROW_MAJOR: 0x8A3E, UNIFORM_BLOCK_BINDING: 0x8A3F, UNIFORM_BLOCK_DATA_SIZE: 0x8A40,
    UNIFORM_BLOCK_ACTIVE_UNIFORMS: 0x8A42, UNIFORM_BLOCK_ACTIVE_UNIFORM_INDICES: 0x8A43, UNIFORM_BLOCK_REFERENCED_BY_VERTEX_SHADER: 0x8A44,
    UNIFORM_BLOCK_REFERENCED_BY_FRAGMENT_SHADER: 0x8A46, INVALID_INDEX: 0xFFFFFFFF, MAX_VERTEX_OUTPUT_COMPONENTS: 0x9122, MAX_FRAGMENT_INPUT_COMPONENTS: 0x9125,
    MAX_SERVER_WAIT_TIMEOUT: 0x9111, OBJECT_TYPE: 0x9112, SYNC_CONDITION: 0x9113, SYNC_STATUS: 0x9114, SYNC_FLAGS: 0x9115, SYNC_FENCE: 0x9116, SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
    UNSIGNED_NORMALIZED: 0x8C17, MAX_CLIENT_WAIT_TIMEOUT_WEBGL: 0x9247, RASTERIZER_DISCARD: 0x8C89, UNSIGNALED: 0x9118, SIGNALED: 0x9119, ALREADY_SIGNALED: 0x911A, TIMEOUT_EXPIRED: 0x911B, CONDITION_SATISFIED: 0x911C, WAIT_FAILED: 0x911D, SYNC_FLUSH_COMMANDS_BIT: 0x1,
    VERTEX_ATTRIB_ARRAY_DIVISOR: 0x88FE, ANY_SAMPLES_PASSED: 0x8C2F, ANY_SAMPLES_PASSED_CONSERVATIVE: 0x8D6A, SAMPLER_BINDING: 0x8919, RGB10_A2UI: 0x906F, INT_2_10_10_10_REV: 0x8D9F,
    TEXTURE_IMMUTABLE_FORMAT: 0x912F, MAX_ELEMENT_INDEX: 0x8D6B, TEXTURE_IMMUTABLE_LEVELS: 0x82DF, UNSIGNED_INT_24_8: 0x84FA, FLOAT_32_UNSIGNED_INT_24_8_REV: 0x8DAD,
    DEPTH_COMPONENT32F: 0x8CAC, DEPTH32F_STENCIL8: 0x8CAD, RGBA32UI: 0x8D70, RGB32UI: 0x8D71, RGBA16UI: 0x8D76, RGB16UI: 0x8D77, RGBA8UI: 0x8D7C, RGB8UI: 0x8D7D, RGBA32I: 0x8D82,
    RGB32I: 0x8D83, RGBA16I: 0x8D88, RGB16I: 0x8D89, RGBA8I: 0x8D8E, RGB8I: 0x8D8F, RED_INTEGER: 0x8D94, RGB_INTEGER: 0x8D98, RGBA_INTEGER: 0x8D99, SAMPLER_2D_ARRAY: 0x8DC1,
    SAMPLER_2D_ARRAY_SHADOW: 0x8DC4, SAMPLER_CUBE_SHADOW: 0x8DC5, UNSIGNED_INT_VEC2: 0x8DC6, UNSIGNED_INT_VEC3: 0x8DC7, UNSIGNED_INT_VEC4: 0x8DC8, INT_SAMPLER_2D: 0x8DCA,
    INT_SAMPLER_3D: 0x8DCB, INT_SAMPLER_CUBE: 0x8DCC, INT_SAMPLER_2D_ARRAY: 0x8DCF, UNSIGNED_INT_SAMPLER_2D: 0x8DD2, UNSIGNED_INT_SAMPLER_3D: 0x8DD3,
    UNSIGNED_INT_SAMPLER_CUBE: 0x8DD4, UNSIGNED_INT_SAMPLER_2D_ARRAY: 0x8DD7, TIMEOUT_IGNORED: -1,
  };
  const C2ALL = Object.assign({}, C, C2);
  const E = { // extension constants
    UNMASKED_VENDOR_WEBGL: 0x9245, UNMASKED_RENDERER_WEBGL: 0x9246,
    VERTEX_ARRAY_BINDING_OES: 0x85B5, VERTEX_ATTRIB_ARRAY_DIVISOR_ANGLE: 0x88FE,
    MIN_EXT: 0x8007, MAX_EXT: 0x8008, FRAGMENT_SHADER_DERIVATIVE_HINT_OES: 0x8B8B,
    UNSIGNED_INT_24_8_WEBGL: 0x84FA, HALF_FLOAT_OES: 0x8D61, RGBA32F_EXT: 0x8814, RGB32F_EXT: 0x8815, FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE_EXT: 0x8211,
    UNSIGNED_NORMALIZED_EXT: 0x8C17, RGBA16F_EXT: 0x881A, RGB16F_EXT: 0x881B,
  };

  // ---------------------------------------------------------------------------------------
  // Implementation limits and identity (Chrome 140 / ANGLE D3D11)
  // ---------------------------------------------------------------------------------------
  // The limits follow what Chrome reports for the identity the context has (see `adapterInfo`):
  // the ANGLE/SwiftShader profile (values measured in Chromium 140 without a GPU) while nothing but
  // this software pipeline renders, the ANGLE/D3D11 profile when a GPU adapter is present.
  // Where this implementation cannot honour a value it reports what it can: no multisampling
  // (`maxSamples` 0), no compressed formats, aliased line width 1; uniform buffers and transform
  // feedback report 0 until they are implemented (3d_webgl2_misc.js).
  const PROFILE_SWIFTSHADER = {
    maxTextureSize: 8192, maxCubeMapSize: 16384, maxRenderbufferSize: 8192, maxViewport: 8192, maxVertexAttribs: 16,
    maxVertexUniformVectors: 4096, maxFragmentUniformVectors: 4096, maxVaryingVectors: 31, maxVertexTextureImageUnits: 32, maxTextureImageUnits: 32,
    maxCombinedTextureImageUnits: 64, maxDrawBuffers: 6, maxColorAttachments: 6, max3DTextureSize: 2048, maxArrayTextureLayers: 2048,
    pointSize: [1, 1023], lineWidth: [1, 1], maxTextureLodBias: 15, subpixelBits: 4,
    maxElementsVertices: 2147483647, maxElementsIndices: 2147483647, maxVaryingComponents: 124, maxVertexOutputComponents: 128, maxFragmentInputComponents: 128,
    maxFragUniformComponents: 16384, maxVertUniformComponents: 16384, maxCombinedFragComponents: 245760, maxCombinedVertComponents: 245760, maxElementIndex: 1073741823,
  };
  const PROFILE_D3D11 = Object.assign({}, PROFILE_SWIFTSHADER, {
    maxTextureSize: 16384, maxRenderbufferSize: 16384, maxViewport: 32767, maxVertexUniformVectors: 4095, maxFragmentUniformVectors: 1024, maxVaryingVectors: 30,
    maxVertexTextureImageUnits: 16, maxTextureImageUnits: 16, maxCombinedTextureImageUnits: 32, maxDrawBuffers: 8, maxColorAttachments: 8, pointSize: [1, 1024], subpixelBits: 8,
    maxElementsVertices: 1048575, maxElementsIndices: 150000, maxVaryingComponents: 120, maxVertexOutputComponents: 124, maxFragmentInputComponents: 120,
    maxFragUniformComponents: 4096, maxCombinedFragComponents: 200704, maxCombinedVertComponents: 212992, maxElementIndex: 4294967295,
  });
  const LIM = Object.assign({
    maxSamples: 0,
    maxUniformBufferBindings: 0, maxUniformBlockSize: 0, maxVertexUniformBlocks: 0, maxFragmentUniformBlocks: 0, maxCombinedUniformBlocks: 0,
    maxTfInterleaved: 0, maxTfSeparateAttribs: 0, maxTfSeparateComponents: 0,
  }, PROFILE_SWIFTSHADER);
  let profileApplied = false;
  // The adapter the implementation reports. A native hook may supply the real GPU adapter;
  // otherwise the renderer is what actually draws: a software rasteriser, which Chrome names SwiftShader.
  function adapterInfo() {
    let a = null;
    try { a = typeof N.gpuAdapterInfo === 'function' ? N.gpuAdapterInfo() : null; } catch (_) { a = null; }
    if (a && typeof a.name === 'string' && a.name) {
      const vendor = a.vendorName || 'Unknown';
      const hex = (v) => `0x${(v >>> 0).toString(16).padStart(8, '0').toUpperCase()}`;
      return { gpu: true, vendor: `Google Inc. (${vendor})`, renderer: `ANGLE (${vendor}, ${a.name} (${hex(a.deviceId || 0)}) Direct3D11 vs_5_0 ps_5_0, D3D11)` };
    }
    return { gpu: false, vendor: 'Google Inc. (Google)', renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)' };
  }
  function applyProfile() {
    if (profileApplied) return;
    profileApplied = true;
    if (adapterInfo().gpu) Object.assign(LIM, PROFILE_D3D11);
  }

  // ---------------------------------------------------------------------------------------
  // Texture formats. Texels are stored expanded to four channels:
  //   store 'u8' Uint8Array (normalized), 's8' Int8Array (normalized), 'f32' Float32Array (also for
  //   half float, depth), 'i32' Int32Array, 'u32' Uint32Array.
  // ---------------------------------------------------------------------------------------
  const FMT = new Map();
  function fmt(internal, base, type, store, o) {
    const f = Object.assign({ internal, base, type, store, bits: [0, 0, 0, 0, 0, 0], renderable: false, filterable: true, color: true, depth: false, stencil: false, integer: false }, o);
    f.channels = { [C2.RED]: 1, [C2.RG]: 2, [C.RGB]: 3, [C.RGBA]: 4, [C.ALPHA]: 1, [C.LUMINANCE]: 1, [C.LUMINANCE_ALPHA]: 2, [C.DEPTH_COMPONENT]: 1, [C.DEPTH_STENCIL]: 2, [C2.RED_INTEGER]: 1, [C2.RG_INTEGER]: 2, [C2.RGB_INTEGER]: 3, [C2.RGBA_INTEGER]: 4 }[base] || 4;
    FMT.set(internal, f);
    return f;
  }
  const B8 = [8, 8, 8, 8, 0, 0];
  // sized (WebGL2)
  fmt(C2.R8, C2.RED, C.UNSIGNED_BYTE, 'u8', { bits: [8, 0, 0, 0, 0, 0], renderable: true });
  fmt(C2.R8_SNORM, C2.RED, C.BYTE, 's8', { bits: [8, 0, 0, 0, 0, 0] });
  fmt(C2.RG8, C2.RG, C.UNSIGNED_BYTE, 'u8', { bits: [8, 8, 0, 0, 0, 0], renderable: true });
  fmt(C2.RG8_SNORM, C2.RG, C.BYTE, 's8', { bits: [8, 8, 0, 0, 0, 0] });
  fmt(C2.RGB8, C.RGB, C.UNSIGNED_BYTE, 'u8', { bits: [8, 8, 8, 0, 0, 0], renderable: true });
  fmt(C2.RGB8_SNORM, C.RGB, C.BYTE, 's8', { bits: [8, 8, 8, 0, 0, 0] });
  fmt(C.RGB565, C.RGB, C.UNSIGNED_SHORT_5_6_5, 'u8', { bits: [5, 6, 5, 0, 0, 0], renderable: true, quant: [31, 63, 31, 1] });
  fmt(C.RGBA4, C.RGBA, C.UNSIGNED_SHORT_4_4_4_4, 'u8', { bits: [4, 4, 4, 4, 0, 0], renderable: true, quant: [15, 15, 15, 15] });
  fmt(C.RGB5_A1, C.RGBA, C.UNSIGNED_SHORT_5_5_5_1, 'u8', { bits: [5, 5, 5, 1, 0, 0], renderable: true, quant: [31, 31, 31, 1] });
  fmt(C2.RGBA8, C.RGBA, C.UNSIGNED_BYTE, 'u8', { bits: B8, renderable: true });
  fmt(C2.RGBA8_SNORM, C.RGBA, C.BYTE, 's8', { bits: B8 });
  fmt(C2.RGB10_A2, C.RGBA, C2.UNSIGNED_INT_2_10_10_10_REV, 'f32', { bits: [10, 10, 10, 2, 0, 0], renderable: true, quant: [1023, 1023, 1023, 3] });
  fmt(C2.SRGB8, C.RGB, C.UNSIGNED_BYTE, 'u8', { bits: [8, 8, 8, 0, 0, 0], srgb: true });
  fmt(C2.SRGB8_ALPHA8, C.RGBA, C.UNSIGNED_BYTE, 'u8', { bits: B8, renderable: true, srgb: true });
  for (const [n, b, ch] of [['R', C2.RED, 1], ['RG', C2.RG, 2], ['RGB', C.RGB, 3], ['RGBA', C.RGBA, 4]]) {
    const bits16 = [16, ch > 1 ? 16 : 0, ch > 2 ? 16 : 0, ch > 3 ? 16 : 0, 0, 0];
    const bits32 = [32, ch > 1 ? 32 : 0, ch > 2 ? 32 : 0, ch > 3 ? 32 : 0, 0, 0];
    fmt(C2[`${n}16F`], b, C2.HALF_FLOAT, 'f32', { bits: bits16, renderable: n !== 'RGB', half: true });
    fmt(C2[`${n}32F`], b, C.FLOAT, 'f32', { bits: bits32, renderable: n !== 'RGB', filterable: false });
  }
  fmt(C2.R11F_G11F_B10F, C.RGB, C2.UNSIGNED_INT_10F_11F_11F_REV, 'f32', { bits: [11, 11, 10, 0, 0, 0], renderable: true, half: true });
  fmt(C2.RGB9_E5, C.RGB, C2.UNSIGNED_INT_5_9_9_9_REV, 'f32', { bits: [9, 9, 9, 0, 0, 0] });
  for (const [n, b, ch] of [['R', C2.RED_INTEGER, 1], ['RG', C2.RG_INTEGER, 2], ['RGB', C2.RGB_INTEGER, 3], ['RGBA', C2.RGBA_INTEGER, 4]]) {
    for (const [sz, ty, uty] of [[8, C.BYTE, C.UNSIGNED_BYTE], [16, C.SHORT, C.UNSIGNED_SHORT], [32, C.INT, C.UNSIGNED_INT]]) {
      const bits = [sz, ch > 1 ? sz : 0, ch > 2 ? sz : 0, ch > 3 ? sz : 0, 0, 0];
      fmt(C2[`${n}${sz}I`], b, ty, 'i32', { bits, integer: true, filterable: false, renderable: n !== 'RGB' });
      fmt(C2[`${n}${sz}UI`], b, uty, 'u32', { bits, integer: true, filterable: false, renderable: n !== 'RGB' });
    }
  }
  fmt(C2.RGB10_A2UI, C2.RGBA_INTEGER, C2.UNSIGNED_INT_2_10_10_10_REV, 'u32', { bits: [10, 10, 10, 2, 0, 0], integer: true, filterable: false, renderable: true });
  fmt(C.DEPTH_COMPONENT16, C.DEPTH_COMPONENT, C.UNSIGNED_SHORT, 'f32', { bits: [0, 0, 0, 0, 16, 0], renderable: true, depth: true, color: false });
  fmt(C2.DEPTH_COMPONENT24, C.DEPTH_COMPONENT, C.UNSIGNED_INT, 'f32', { bits: [0, 0, 0, 0, 24, 0], renderable: true, depth: true, color: false });
  fmt(C2.DEPTH_COMPONENT32F, C.DEPTH_COMPONENT, C.FLOAT, 'f32', { bits: [0, 0, 0, 0, 32, 0], renderable: true, depth: true, color: false });
  fmt(C2.DEPTH24_STENCIL8, C.DEPTH_STENCIL, C2.UNSIGNED_INT_24_8, 'f32', { bits: [0, 0, 0, 0, 24, 8], renderable: true, depth: true, stencil: true, color: false });
  fmt(C2.DEPTH32F_STENCIL8, C.DEPTH_STENCIL, C2.FLOAT_32_UNSIGNED_INT_24_8_REV, 'f32', { bits: [0, 0, 0, 0, 32, 8], renderable: true, depth: true, stencil: true, color: false });
  fmt(C.STENCIL_INDEX8, C.STENCIL_INDEX8, C.UNSIGNED_BYTE, 'u32', { bits: [0, 0, 0, 0, 0, 8], renderable: true, stencil: true, color: false, filterable: false });
  // unsized (WebGL1 and WebGL2) keyed by `base << 16 | type`
  const UNSIZED = new Map();
  function unsized(base, type, store, o) {
    const f = Object.assign({ internal: base, base, type, store, bits: [0, 0, 0, 0, 0, 0], renderable: false, filterable: true, color: true, depth: false, stencil: false, integer: false, unsized: true }, o);
    f.channels = { [C.RGB]: 3, [C.RGBA]: 4, [C.ALPHA]: 1, [C.LUMINANCE]: 1, [C.LUMINANCE_ALPHA]: 2, [C.DEPTH_COMPONENT]: 1, [C.DEPTH_STENCIL]: 2 }[base] || 4;
    UNSIZED.set(base * 65536 + type, f);
    return f;
  }
  unsized(C.RGBA, C.UNSIGNED_BYTE, 'u8', { bits: B8, renderable: true });
  unsized(C.RGBA, C.UNSIGNED_SHORT_4_4_4_4, 'u8', { bits: [4, 4, 4, 4, 0, 0], renderable: true, quant: [15, 15, 15, 15] });
  unsized(C.RGBA, C.UNSIGNED_SHORT_5_5_5_1, 'u8', { bits: [5, 5, 5, 1, 0, 0], renderable: true, quant: [31, 31, 31, 1] });
  unsized(C.RGB, C.UNSIGNED_BYTE, 'u8', { bits: [8, 8, 8, 0, 0, 0], renderable: true });
  unsized(C.RGB, C.UNSIGNED_SHORT_5_6_5, 'u8', { bits: [5, 6, 5, 0, 0, 0], renderable: true, quant: [31, 63, 31, 1] });
  unsized(C.LUMINANCE_ALPHA, C.UNSIGNED_BYTE, 'u8', { bits: [8, 8, 8, 8, 0, 0], lum: true });
  unsized(C.LUMINANCE, C.UNSIGNED_BYTE, 'u8', { bits: [8, 8, 8, 0, 0, 0], lum: true });
  unsized(C.ALPHA, C.UNSIGNED_BYTE, 'u8', { bits: [0, 0, 0, 8, 0, 0], lum: true });
  unsized(C.RGBA, C.FLOAT, 'f32', { bits: [32, 32, 32, 32, 0, 0], filterable: false, float32: true });
  unsized(C.RGB, C.FLOAT, 'f32', { bits: [32, 32, 32, 0, 0, 0], filterable: false, float32: true });
  unsized(C.LUMINANCE_ALPHA, C.FLOAT, 'f32', { bits: [32, 32, 32, 32, 0, 0], filterable: false, float32: true, lum: true });
  unsized(C.LUMINANCE, C.FLOAT, 'f32', { bits: [32, 32, 32, 0, 0, 0], filterable: false, float32: true, lum: true });
  unsized(C.ALPHA, C.FLOAT, 'f32', { bits: [0, 0, 0, 32, 0, 0], filterable: false, float32: true, lum: true });
  for (const t of [E.HALF_FLOAT_OES, C2.HALF_FLOAT]) {
    unsized(C.RGBA, t, 'f32', { bits: [16, 16, 16, 16, 0, 0], half: true });
    unsized(C.RGB, t, 'f32', { bits: [16, 16, 16, 0, 0, 0], half: true });
    unsized(C.LUMINANCE_ALPHA, t, 'f32', { bits: [16, 16, 16, 16, 0, 0], half: true, lum: true });
    unsized(C.LUMINANCE, t, 'f32', { bits: [16, 16, 16, 0, 0, 0], half: true, lum: true });
    unsized(C.ALPHA, t, 'f32', { bits: [0, 0, 0, 16, 0, 0], half: true, lum: true });
  }
  unsized(C.DEPTH_COMPONENT, C.UNSIGNED_SHORT, 'f32', { bits: [0, 0, 0, 0, 16, 0], depth: true, color: false });
  unsized(C.DEPTH_COMPONENT, C.UNSIGNED_INT, 'f32', { bits: [0, 0, 0, 0, 24, 0], depth: true, color: false });
  unsized(C.DEPTH_STENCIL, C2.UNSIGNED_INT_24_8, 'f32', { bits: [0, 0, 0, 0, 24, 8], depth: true, stencil: true, color: false });
  // The sized format that backs an unsized (format, type) pair in WebGL2 (ES 3.0 table 3.2) and the internal format of an unsized upload.
  const SIZED_OF = {
    [C.RGBA * 65536 + C.UNSIGNED_BYTE]: C2.RGBA8, [C.RGB * 65536 + C.UNSIGNED_BYTE]: C2.RGB8, [C.RGBA * 65536 + C.UNSIGNED_SHORT_4_4_4_4]: C.RGBA4,
    [C.RGBA * 65536 + C.UNSIGNED_SHORT_5_5_5_1]: C.RGB5_A1, [C.RGB * 65536 + C.UNSIGNED_SHORT_5_6_5]: C.RGB565,
  };
  void SIZED_OF;
  const PIXEL_TYPE_BYTES = { [C.UNSIGNED_BYTE]: 1, [C.BYTE]: 1, [C.UNSIGNED_SHORT]: 2, [C.SHORT]: 2, [C.UNSIGNED_INT]: 4, [C.INT]: 4, [C.FLOAT]: 4, [C2.HALF_FLOAT]: 2, [E.HALF_FLOAT_OES]: 2,
    [C.UNSIGNED_SHORT_4_4_4_4]: 2, [C.UNSIGNED_SHORT_5_5_5_1]: 2, [C.UNSIGNED_SHORT_5_6_5]: 2, [C2.UNSIGNED_INT_2_10_10_10_REV]: 4, [C2.UNSIGNED_INT_10F_11F_11F_REV]: 4,
    [C2.UNSIGNED_INT_5_9_9_9_REV]: 4, [C2.UNSIGNED_INT_24_8]: 4, [C2.FLOAT_32_UNSIGNED_INT_24_8_REV]: 8 };
  const PACKED_TYPES = new Set([C.UNSIGNED_SHORT_4_4_4_4, C.UNSIGNED_SHORT_5_5_5_1, C.UNSIGNED_SHORT_5_6_5, C2.UNSIGNED_INT_2_10_10_10_REV, C2.UNSIGNED_INT_10F_11F_11F_REV, C2.UNSIGNED_INT_5_9_9_9_REV, C2.UNSIGNED_INT_24_8, C2.FLOAT_32_UNSIGNED_INT_24_8_REV]);
  const BASE_COMPONENTS = { [C.RGB]: 3, [C.RGBA]: 4, [C.ALPHA]: 1, [C.LUMINANCE]: 1, [C.LUMINANCE_ALPHA]: 2, [C.DEPTH_COMPONENT]: 1, [C.DEPTH_STENCIL]: 1, [C2.RED]: 1, [C2.RG]: 2, [C2.RED_INTEGER]: 1, [C2.RG_INTEGER]: 2, [C2.RGB_INTEGER]: 3, [C2.RGBA_INTEGER]: 4 };

  const sizeOfStore = { u8: Uint8Array, s8: Int8Array, f32: Float32Array, i32: Int32Array, u32: Uint32Array };

  class Image {
    constructor(w, h, d, f) {
      this.w = w; this.h = h; this.d = d; this.f = f;
      const n = w * h * d * 4;
      this.data = new sizeOfStore[f.store](n);
      // texels never uploaded read as transparent black; formats without alpha read 1 (set on upload/clear)
      if (f.store === 'u8' || f.store === 's8' || f.store === 'f32' || f.store === 'i32' || f.store === 'u32') this.fillDefault();
    }
    fillDefault() {
      const f = this.f;
      const one = f.store === 'u8' ? 255 : f.store === 's8' ? 127 : 1;
      const d = this.data;
      if (f.channels < 4 && !f.depth) for (let i = 3; i < d.length; i += 4) d[i] = f.base === C.ALPHA ? 0 : one;
    }
  }

  // ---------------------------------------------------------------------------------------
  // WebGL objects
  // ---------------------------------------------------------------------------------------
  const OBJ = new WeakMap();   // object -> internal record
  const wrapObj = (ctor, ctx, rec) => { const o = Object.create(ctor.prototype); OBJ.set(o, rec); rec.ctx = ctx; rec.wrapper = o; return o; };
  function makeObjClass(name) {
    const cls = { [name]: class { constructor(token) { if (token !== INTERNAL) throw L.illegal(); } } }[name];
    return cls;
  }
  const WebGLObject = makeObjClass('WebGLObject');
  const subclass = (name) => { const c = { [name]: class extends WebGLObject { constructor(token) { super(token); } } }[name]; return c; };
  const WebGLBuffer = subclass('WebGLBuffer');
  const WebGLFramebuffer = subclass('WebGLFramebuffer');
  const WebGLProgram = subclass('WebGLProgram');
  const WebGLRenderbuffer = subclass('WebGLRenderbuffer');
  const WebGLShader = subclass('WebGLShader');
  const WebGLTexture = subclass('WebGLTexture');
  const WebGLVertexArrayObject = subclass('WebGLVertexArrayObject');
  const WebGLSampler = subclass('WebGLSampler');
  const WebGLSync = subclass('WebGLSync');
  const WebGLQuery = subclass('WebGLQuery');
  const WebGLTransformFeedback = subclass('WebGLTransformFeedback');
  class WebGLUniformLocation { constructor(token) { if (token !== INTERNAL) throw L.illegal(); } }
  class WebGLActiveInfo {
    #n; #s; #t;
    constructor(token, n, s, t) { if (token !== INTERNAL) throw L.illegal(); this.#n = n; this.#s = s; this.#t = t; }
    get size() { return this.#s; }
    get type() { return this.#t; }
    get name() { return this.#n; }
  }
  class WebGLShaderPrecisionFormat {
    #a; #b; #c;
    constructor(token, a, b, c) { if (token !== INTERNAL) throw L.illegal(); this.#a = a; this.#b = b; this.#c = c; }
    get rangeMin() { return this.#a; }
    get rangeMax() { return this.#b; }
    get precision() { return this.#c; }
  }
  class WebGLContextEvent extends L.Event {
    #msg;
    constructor(type, init) {
      if (arguments.length < 1) throw new TypeError("Failed to construct 'WebGLContextEvent': 1 argument required, but only 0 present.");
      super(type, init);
      this.#msg = init && init.statusMessage !== undefined ? `${init.statusMessage}` : '';
    }
    get statusMessage() { return this.#msg; }
  }

  // ---------------------------------------------------------------------------------------
  // Context state
  // ---------------------------------------------------------------------------------------
  const STATE = new WeakMap(); // context -> S
  const stOf = (c) => { const s = STATE.get(c); if (s === undefined) throw new TypeError('Illegal invocation'); return s; };
  const ctxByCanvas = new WeakMap(); // canvas -> {ctx, version}

  function newVaoRec(ctx, S) {
    const attribs = [];
    for (let i = 0; i < LIM.maxVertexAttribs; i++) attribs.push({ enabled: false, size: 4, type: C.FLOAT, normalized: false, stride: 0, offset: 0, buffer: null, divisor: 0, integer: false });
    return { ctx, attribs, element: null, deleted: false, everBound: false, kind: 'vao' };
  }

  function createState(ctx, version, canvasLike, attrs) {
    const S = {
      ctx, ver: version, canvas: canvasLike, attrs,
      err: 0, lost: false, restoreAllowed: false, exts: new Map(), extList: [],
      w: 0, h: 0,
      arrayBuffer: null, copyRead: null, copyWrite: null, pixelPack: null, pixelUnpack: null, uniformBuffer: null, tfBuffer: null,
      vao: null, defaultVao: null, program: null, renderbuffer: null, drawFb: null, readFb: null, tf: null,
      activeTex: 0, units: [], samplers: [],
      viewport: [0, 0, 0, 0], scissor: [0, 0, 0, 0], scissorTest: false,
      colorMask: [true, true, true, true], depthMask: true, stencilMask: [0xffffffff, 0xffffffff],
      clearColor: [0, 0, 0, 0], clearDepth: 1, clearStencil: 0,
      blend: { enabled: false, rgb: C.FUNC_ADD, alpha: C.FUNC_ADD, srcRGB: C.ONE, dstRGB: C.ZERO, srcA: C.ONE, dstA: C.ZERO, color: [0, 0, 0, 0] },
      depth: { enabled: false, func: C.LESS, near: 0, far: 1 },
      stencil: { enabled: false, func: [C.ALWAYS, C.ALWAYS], ref: [0, 0], vmask: [0xffffffff, 0xffffffff], fail: [C.KEEP, C.KEEP], zfail: [C.KEEP, C.KEEP], zpass: [C.KEEP, C.KEEP] },
      cull: false, cullMode: C.BACK, frontFace: C.CCW, lineWidth: 1, polyOffset: false, polyFactor: 0, polyUnits: 0,
      dither: true, sampleAlpha: false, sampleCoverage: false, sampleCoverageValue: 1, sampleCoverageInvert: false, rasterizerDiscard: false,
      pack: { align: 4, rowLength: 0, skipRows: 0, skipPixels: 0 },
      unpack: { align: 4, flipY: false, premul: false, colorspace: C.BROWSER_DEFAULT_WEBGL, rowLength: 0, imageHeight: 0, skipRows: 0, skipPixels: 0, skipImages: 0 },
      hints: { genMipmap: C.DONT_CARE, derivative: C.DONT_CARE },
      generic: [], drawBuffers: [C.BACK], readBuffer: C.BACK,
      queries: { anySamples: null, anySamplesCons: null, tfPrimitives: null },
      dirty: false, cleared: false, presentScheduled: false, texSerial: 1,
    };
    for (let i = 0; i < LIM.maxVertexAttribs; i++) S.generic.push({ f: new Float32Array([0, 0, 0, 1]), i: new Int32Array(4), u: new Uint32Array(4), type: C.FLOAT });
    const nUnits = LIM.maxCombinedTextureImageUnits;
    for (let i = 0; i < nUnits; i++) S.units.push({ t2d: null, cube: null, t3d: null, t2da: null, sampler: null });
    S.defaultVao = newVaoRec(ctx, S);
    S.vao = S.defaultVao;
    return S;
  }

  // ---------------------------------------------------------------------------------------
  // Helpers: errors and validation
  // ---------------------------------------------------------------------------------------
  const gerr = (S, code) => { if (S.err === 0) S.err = code; };
  const ENUM_NAMES = Object.fromEntries(Object.entries(C2ALL).map(([k, v]) => [v, k]));
  void ENUM_NAMES;
  const consoleWarn = (S, msg) => { try { if (S.warned === undefined) S.warned = 0; if (S.warned++ < 32) L.log('warn', `WebGL: ${msg}`); } catch (_) { /* ignore */ } };
  const rec = (o) => OBJ.get(o);
  const isObjOf = (S, o, ctor) => o !== null && typeof o === 'object' && o instanceof ctor && OBJ.has(o) && OBJ.get(o).ctx === S;
  // Argument conversion: WebIDL `GLenum` (unsigned long), `GLint` (long), `GLsizei` (long), `GLfloat` (unrestricted float), `GLboolean`.
  const glenum = (v) => (Number(v) >>> 0);
  const glint = (v) => (Number(v) | 0);
  const glfloat = (v) => Math.fround(Number(v));
  const glbool = (v) => !!v;
  const argsReq = (iface, method, n, got) => { if (got < n) throw new TypeError(`Failed to execute '${method}' on '${iface}': ${n} argument${n === 1 ? '' : 's'} required, but only ${got} present.`); };
  const typeErr = (iface, method, n, type) => new TypeError(`Failed to execute '${method}' on '${iface}': parameter ${n} is not of type '${type}'.`);

  const POT = (n) => n > 0 && (n & (n - 1)) === 0;
  const maxLevels = (w, h, d) => 1 + Math.floor(Math.log2(Math.max(w, h, d || 1)));

  for (const c of [WebGLObject, WebGLBuffer, WebGLFramebuffer, WebGLProgram, WebGLRenderbuffer, WebGLShader, WebGLTexture, WebGLVertexArrayObject, WebGLSampler, WebGLSync, WebGLQuery, WebGLTransformFeedback,
    WebGLUniformLocation, WebGLActiveInfo, WebGLShaderPrecisionFormat]) Object.defineProperty(c, 'length', { value: 0, configurable: true });
  Object.defineProperty(WebGLContextEvent, 'length', { value: 1, configurable: true });
  L.glInternals = { applyProfile, C, C2, C2ALL, E, LIM, FMT, UNSIZED, Image, OBJ, STATE, ctxByCanvas, wrapObj, rec, isObjOf, gerr, glenum, glint, glfloat, glbool, argsReq, typeErr, createState,
    newVaoRec, adapterInfo, PIXEL_TYPE_BYTES, PACKED_TYPES, BASE_COMPONENTS, POT, maxLevels, stOf, consoleWarn, SIZED_OF,
    classes: { WebGLObject, WebGLBuffer, WebGLFramebuffer, WebGLProgram, WebGLRenderbuffer, WebGLShader, WebGLTexture, WebGLVertexArrayObject, WebGLSampler, WebGLSync, WebGLQuery, WebGLTransformFeedback, WebGLUniformLocation, WebGLActiveInfo, WebGLShaderPrecisionFormat, WebGLContextEvent } };
  L.expose('WebGLObject', WebGLObject);
  for (const [n, c] of Object.entries({ WebGLBuffer, WebGLFramebuffer, WebGLProgram, WebGLRenderbuffer, WebGLShader, WebGLTexture, WebGLUniformLocation, WebGLActiveInfo, WebGLShaderPrecisionFormat, WebGLContextEvent })) L.expose(n, c);
  void sizeOfStore;
})(globalThis.__layer);
