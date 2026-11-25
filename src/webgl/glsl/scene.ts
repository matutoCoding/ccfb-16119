// 场景主视图：实例化盒体光栅化，表面着色 = 发光面 + DDGI 漫反射间接光
import { GLSL_COMMON } from './common';

export const SCENE_VERT = /* glsl */ `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;       // 单位立方体 [-0.5,0.5]
layout(location=1) in vec3 aNormal;
layout(location=2) in mat4 aModel;    // 实例矩阵
layout(location=6) in int aMat;       // 实例材质
uniform mat4 uViewProj;
out vec3 vWorld;
out vec3 vNormal;
flat out int vMat;
void main() {
  vec4 w = aModel * vec4(aPos, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(aModel) * aNormal);
  vMat = aMat;
  gl_Position = uViewProj * w;
}
`;

export const SCENE_FRAG = /* glsl */ `#version 300 es
${GLSL_COMMON}
in vec3 vWorld;
in vec3 vNormal;
flat in int vMat;
uniform vec3 uCamPos;
uniform int uShowProbes;
uniform int uProbeVisualize; // 0 关 1 辐照度球 2 深度
out vec4 outColor;

vec3 probeDebugColor(vec3 world) {
  if (uProbeVisualize == 1) return max(sampleIrradiance(world, normalize(vNormal)), vec3(0.0)) / PI * 0.01;
  return vec3(0.0);
}

void main() {
  vec3 albedo = materialAlbedo(vMat);
  vec3 emissive = materialEmissive(vMat);
  vec3 n = normalize(vNormal);
  vec3 irr = sampleIrradiance(vWorld, n);
  // 漫反射：入射辐照度 * albedo / π（lux→显示色调映射另做）
  vec3 diffuse = albedo * irr / PI;
  vec3 linear = emissive + diffuse;
  // 简单 Reinhard 色调映射 + gamma
  vec3 mapped = linear / (linear + vec3(400.0));
  vec3 color = pow(mapped, vec3(1.0 / 2.2));
  if (dot(emissive, emissive) > 1.0) color = pow(emissive / (emissive + vec3(2000.0)), vec3(1.0 / 2.2));
  outColor = vec4(color, 1.0);
}
`;

// 探针可视化（小立方体，位置由网格 uniform 计算，避免大数组 uniform）
export const PROBE_VERT = /* glsl */ `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
uniform mat4 uViewProj;
uniform float uVizScale;
uniform ivec3 uGridCount;
uniform vec3 uGridOrigin;
uniform vec3 uGridSpacing;
out vec3 vLocal;
flat out int vProbeId;
vec3 probeWorldPos(int id) {
  int gx = id % uGridCount.x;
  int gz = (id / uGridCount.x) % uGridCount.z;
  int gy = id / (uGridCount.x * uGridCount.z);
  return uGridOrigin + vec3(float(gx), float(gy), float(gz)) * uGridSpacing;
}
void main() {
  int id = gl_InstanceID;
  vProbeId = id;
  vLocal = aPos;
  gl_Position = uViewProj * vec4(probeWorldPos(id) + aPos * uVizScale, 1.0);
}
`;

export const PROBE_FRAG = /* glsl */ `#version 300 es
${GLSL_COMMON}
in vec3 vLocal;
flat in int vProbeId;
uniform int uProbeVisualize;
uniform float uProbeMaxDist;
out vec4 outColor;
void main() {
  int id = vProbeId;
  vec3 dir = normalize(vLocal);
  if (uProbeVisualize == 1) {
    vec3 irr = probeIrradiance(id, dir);
    vec3 c = irr / (irr + vec3(600.0));
    outColor = vec4(pow(c, vec3(1.0 / 2.2)), 0.9);
  } else {
    vec3 ad = abs(dir);
    int pair = ad.x > ad.y && ad.x > ad.z ? 0 : (ad.y > ad.z ? 1 : 2);
    vec4 m = depthMoments(id, pair);
    float d = dir[pair] >= 0.0 ? m.x : m.y;
    float t = clamp(d / uProbeMaxDist, 0.0, 1.0);
    outColor = vec4(t, 0.6 * (1.0 - t), 1.0 - t, 0.85);
  }
}
`;
