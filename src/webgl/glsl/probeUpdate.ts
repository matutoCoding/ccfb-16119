import { GLSL_COMMON } from './common';

// 探针更新片元着色器：FBO 宽 = 探针数，高 = 9（辐照度）或 3（深度）。
// 轮转：uUpdateOffset/uUpdateCount 决定本帧刷新哪些探针；其余探针原样回写。
// 光线：半球 fibonacci → BVH 求交 → 发光面取 emissive，否则 albedo·邻近探针辐照度/π。

export const PROBE_UPDATE_FRAG = /* glsl */ `#version 300 es
${GLSL_COMMON}

uniform int uMode;          // 0=辐照度 1=深度矩
uniform int uUpdateOffset;
uniform int uUpdateCount;
uniform int uRayCount;
uniform float uBlend;       // 指数滑动平均系数
uniform float uProbeMaxDist;
out vec4 fragColor;

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  int probe = px.x;
  int row = px.y;
  int gx = probe % uGridCount.x;
  int gz = (probe / uGridCount.x) % uGridCount.z;
  int gy = probe / (uGridCount.x * uGridCount.z);
  vec3 origin = uGridOrigin + vec3(float(gx), float(gy), float(gz)) * uGridSpacing;

  bool inBatch = probe >= uUpdateOffset && probe < uUpdateOffset + uUpdateCount;

  if (uMode == 1) {
    vec4 prev = fetchTex(uDepthTex, uProbeCount * 3, probe * 3 + row);
    if (!inBatch) { fragColor = prev; return; }
    // 每纹素打包 2 个轴的 (mean, meanSq)
    vec4 out4 = vec4(0.0);
    for (int a = 0; a < 2; a++) {
      int axis = row * 2 + a;
      vec3 d = vec3(0.0);
      d[axis / 2] = axis % 2 == 0 ? 1.0 : -1.0;
      Hit h = traceScene(Ray(origin + d * 0.05, d));
      float dist = h.tri < 0 ? uProbeMaxDist : min(h.t, uProbeMaxDist);
      out4[a * 2] = dist;
      out4[a * 2 + 1] = dist * dist;
    }
    fragColor = mix(prev, out4, uBlend);
    return;
  }
  vec4 prev = fetchTex(uIrrTex, uProbeCount * 9, probe * 9 + row);
  if (!inBatch) { fragColor = prev; return; }

  // row: 0..2 R 通道 SH9，3..5 G，6..8 B
  int channel = row / 3;
  int local = row - channel * 3;
  vec4 shPacked = vec4(0.0);
  float weight = (2.0 * PI) / float(uRayCount);
  float b[9];
  for (int r = 0; r < 256; r++) {
    if (r >= uRayCount) break;
    vec3 dir = fibDir(r, uRayCount);
    Hit h = traceScene(Ray(origin + dir * 0.05, dir));
    float rad;
    if (h.tri < 0) {
      rad = 0.0;
    } else {
      int m = hitMaterial(h);
      vec3 em = materialEmissive(m);
      float emMono = em[channel];
      if (emMono > 0.02) {
        rad = emMono;
      } else {
        vec3 hp = origin + dir * h.t;
        vec3 albedo = materialAlbedo(m);
        vec3 irr = sampleIrradiance(hp, h.n);
        rad = albedo[channel] * irr[channel] / PI;
      }
    }
    shBasis(dir, b);
    for (int lane = 0; lane < 4; lane++) {
      int k = local * 4 + lane;
      if (k < 9) shPacked[lane] += rad * b[k] * weight;
    }
  }
  // 发光面片解析直接光：固定次数循环（无 break），保证采样器被静态激活不被编译器剔除
  for (int li = 0; li < MAX_LIGHTS; li++) {
    float isActive = (li < uLightCount) ? 1.0 : 0.0;
    LightPatch lp = readLight(li);
    for (int sx = 0; sx < 2; sx++) {
      for (int sz = 0; sz < 2; sz++) {
        vec3 sp = patchPoint(lp, float(sx) * 0.5 + 0.25, float(sz) * 0.5 + 0.25);
        vec3 to = sp - origin;
        float dist = length(to);
        if (dist < 0.01 || isActive < 0.5) continue;
        vec3 sdir = to / dist;
        if (occluded(Ray(origin + sdir * 0.05, sdir), dist - 0.05)) continue;
        float cosL = max(0.0, dot(-sdir, lp.normal));
        float cosW = max(0.0, sdir.y);
        // 每采样点代表 A/4 面积；E = L·(A/4)·cosL·cosW/d²
        float denom = max(0.01, dist * dist);
        float pointE = lp.radiance[channel] * (max(0.0, lp.area) * 0.25) * cosL * cosW / denom;
        if (isnan(pointE) || pointE <= 0.0) continue;
        shBasis(sdir, b);
        for (int lane = 0; lane < 4; lane++) {
          int k = local * 4 + lane;
          if (k < 9) shPacked[lane] += pointE * b[k];
        }
      }
    }
  }
  // 冷启动：探针此前为零则直接赋值（blend=1），否则按 EMA 平滑
  float effBlend = (dot(prev, prev) < 1e-12) ? 1.0 : uBlend;
  fragColor = mix(prev, shPacked, effBlend);
}
`;

export const QUAD_VERT = /* glsl */ `#version 300 es
precision highp float;
void main() {
  vec2 pos = vec2(float(gl_VertexID & 1) * 2.0 - 1.0, float((gl_VertexID >> 1) & 1) * 2.0 - 1.0);
  gl_Position = vec4(pos, 0.0, 1.0);
}
`;
