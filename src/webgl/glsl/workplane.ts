// 工作面照度分析：俯视正交网格，在工作面高度采样 DDGI 辐照度，输出 lux / 伪彩 / 达标掩膜
import { GLSL_COMMON } from './common';

export const WORKPLANE_VERT = /* glsl */ `#version 300 es
precision highp float;
void main() {
  vec2 pos = vec2(float(gl_VertexID & 1) * 2.0 - 1.0, float((gl_VertexID >> 1) & 1) * 2.0 - 1.0);
  gl_Position = vec4(pos, 0.0, 1.0);
}
`;

export const WORKPLANE_FRAG = /* glsl */ `#version 300 es
${GLSL_COMMON}
uniform vec2 uRoomXZ;       // 房间宽深
uniform vec2 uGridSize;     // 分析网格分辨率
uniform float uWorkY;
uniform int uMode;          // 0=lux 浮点 1=伪彩 2=达标掩膜
uniform float uMaxLux;
uniform float uThreshold;
out vec4 outColor;

vec3 falseColor(float t) {
  t = clamp(t, 0.0, 1.0);
  if (t < 0.25) return mix(vec3(0.08, 0.12, 0.55), vec3(0.1, 0.6, 0.85), t / 0.25);
  if (t < 0.5) return mix(vec3(0.1, 0.6, 0.85), vec3(0.25, 0.8, 0.35), (t - 0.25) / 0.25);
  if (t < 0.75) return mix(vec3(0.25, 0.8, 0.35), vec3(0.95, 0.85, 0.2), (t - 0.5) / 0.25);
  return mix(vec3(0.95, 0.85, 0.2), vec3(0.9, 0.15, 0.1), (t - 0.75) / 0.25);
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5) / uGridSize;
  vec3 p = vec3(uv.x * uRoomXZ.x, uWorkY, (1.0 - uv.y) * uRoomXZ.y);
  vec3 irr = sampleIrradiance(p + vec3(0.0, 0.02, 0.0), vec3(0.0, 1.0, 0.0));
  float lux = dot(irr, vec3(0.2126, 0.7152, 0.0722));
  if (uMode == 0) {
    outColor = vec4(lux, lux, lux, 1.0);
  } else if (uMode == 1) {
    outColor = vec4(falseColor(lux / max(uMaxLux, 1.0)), 1.0);
  } else {
    outColor = vec4(lux >= uThreshold ? 1.0 : 0.0, 0.0, lux >= uThreshold ? 0.0 : 1.0, 1.0);
  }
}
`;
