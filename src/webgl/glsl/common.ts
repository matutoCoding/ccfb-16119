// GLSL ES 3.00 公共片段：BVH 光线求交、材质、球谐、Chebyshev 可见性
// 与 src/core 下 CPU 参考实现逐函数对应，单测对拍。

// 注意：本片段不含 #version，由各入口着色器在首行提供
export const GLSL_COMMON = /* glsl */ `
precision highp float;
precision highp int;

#define PI 3.141592653589793
#define MAX_DIST 200.0
#define NO_HIT 1e9

uniform sampler2D uNodeTex;   // x: min.xyz,left | y: max.xyz,count
uniform int uNodeTexWidth;
uniform sampler2D uTriTex;    // 每三角 3 纹素: v0.xyz,mat | e1.xyz,_ | e2.xyz,_
uniform int uTriTexWidth;
uniform sampler2D uMatTex;    // 每材质 2 纹素: albedo.xyz,rough | emissive.xyz,_
uniform int uMatCount;

struct Ray { vec3 o; vec3 d; };
struct Hit { float t; int tri; vec3 n; };

vec4 fetchTex(sampler2D tex, int width, int index) {
  int x = index % width;
  int y = index / width;
  return texelFetch(tex, ivec2(x, y), 0);
}

bool hitAABB(Ray r, vec3 bmin, vec3 bmax, float tmax) {
  float t0 = 0.001;
  float t1 = tmax;
  for (int k = 0; k < 3; k++) {
    if (abs(r.d[k]) < 1e-9) {
      // 射线平行于该轴：原点必须在盒内
      if (r.o[k] < bmin[k] || r.o[k] > bmax[k]) return false;
    } else {
      float inv = 1.0 / r.d[k];
      float ta = (bmin[k] - r.o[k]) * inv;
      float tb = (bmax[k] - r.o[k]) * inv;
      if (inv < 0.0) { float tmp = ta; ta = tb; tb = tmp; }
      t0 = max(t0, ta);
      t1 = min(t1, tb);
      if (t1 < t0) return false;
    }
  }
  return true;
}

// Möller–Trumbore，返回 t（命中）或负值
float intersectTri(Ray r, vec3 v0, vec3 e1, vec3 e2) {
  vec3 p = cross(r.d, e2);
  float det = dot(e1, p);
  if (abs(det) < 1e-9) return -1.0;
  float invDet = 1.0 / det;
  vec3 tv = r.o - v0;
  float u = dot(tv, p) * invDet;
  if (u < 0.0 || u > 1.0) return -1.0;
  vec3 q = cross(tv, e1);
  float v = dot(r.d, q) * invDet;
  if (v < 0.0 || u + v > 1.0) return -1.0;
  float t = dot(e2, q) * invDet;
  return t;
}

vec3 triNormal(vec3 e1, vec3 e2, vec3 rayDir) {
  vec3 n = cross(e1, e2);
  n = normalize(n);
  if (dot(n, rayDir) > 0.0) n = -n;
  return n;
}

Hit traceScene(Ray ray) {
  Hit result;
  result.t = MAX_DIST;
  result.tri = -1;
  result.n = vec3(0.0);
  // 固定上限 for 循环 + 显式栈，避免 SwiftShader 对 while/动态栈的兼容问题
  int stack[40];
  int sp = 1;
  stack[0] = 0;
  for (int iter = 0; iter < 60; iter++) {
    if (sp <= 0) break;
    sp--;
    int ni = stack[sp];
    vec4 a = fetchTex(uNodeTex, uNodeTexWidth, ni * 2);
    vec4 b = fetchTex(uNodeTex, uNodeTexWidth, ni * 2 + 1);
    vec3 bmin = a.xyz;
    float leftOrStart = a.w;
    vec3 bmax = b.xyz;
    int countOrNegRight = int(b.w);
    if (!hitAABB(ray, bmin, bmax, result.t)) continue;
    if (countOrNegRight > 0) {
      int count = countOrNegRight;
      int start = -int(leftOrStart) - 1;
      for (int i = 0; i < 8; i++) {
        if (i >= count) break;
        int gi = start + i;
        vec3 v0 = fetchTex(uTriTex, uTriTexWidth, gi * 3).xyz;
        vec3 e1 = fetchTex(uTriTex, uTriTexWidth, gi * 3 + 1).xyz;
        vec3 e2 = fetchTex(uTriTex, uTriTexWidth, gi * 3 + 2).xyz;
        float t = intersectTri(ray, v0, e1, e2);
        if (t > 0.001 && t < result.t) {
          result.t = t;
          result.tri = gi;
          result.n = triNormal(e1, e2, ray.d);
        }
      }
    } else {
      int leftChild = int(leftOrStart);
      int rightChild = -countOrNegRight - 1;
      stack[sp] = leftChild;
      sp++;
      stack[sp] = rightChild;
      sp++;
    }
  }
  return result;
}

bool occluded(Ray ray, float tmax) {
  int stack[40];
  int sp = 1;
  stack[0] = 0;
  for (int iter = 0; iter < 60; iter++) {
    if (sp <= 0) break;
    sp--;
    int ni = stack[sp];
    vec4 a = fetchTex(uNodeTex, uNodeTexWidth, ni * 2);
    vec4 b = fetchTex(uNodeTex, uNodeTexWidth, ni * 2 + 1);
    int countOrNegRight = int(b.w);
    if (!hitAABB(ray, a.xyz, b.xyz, tmax)) continue;
    if (countOrNegRight > 0) {
      int start = -int(a.w) - 1;
      for (int i = 0; i < 8; i++) {
        if (i >= countOrNegRight) break;
        int gi = start + i;
        vec3 v0 = fetchTex(uTriTex, uTriTexWidth, gi * 3).xyz;
        vec3 e1 = fetchTex(uTriTex, uTriTexWidth, gi * 3 + 1).xyz;
        vec3 e2 = fetchTex(uTriTex, uTriTexWidth, gi * 3 + 2).xyz;
        float t = intersectTri(ray, v0, e1, e2);
        if (t > 0.001 && t < tmax) return true;
      }
    } else {
      int leftChild = int(a.w);
      int rightChild = -countOrNegRight - 1;
      stack[sp] = leftChild;
      sp++;
      stack[sp] = rightChild;
      sp++;
    }
  }
  return false;
}

vec4 materialField(int matId, int row) {
  return fetchTex(uMatTex, max(1, uMatCount * 2), matId * 2 + row);
}
vec3 materialAlbedo(int matId) { return materialField(matId, 0).xyz; }
vec3 materialEmissive(int matId) { return materialField(matId, 1).xyz; }

// ---- 发光面片（导光管漫射器/窗），每面 3 纹素：中心+面积 / 法线+_ / 辐射度RGB ----
uniform sampler2D uLightTex;
uniform int uLightTexWidth;
uniform int uLightCount;
const int MAX_LIGHTS = 64;
struct LightPatch { vec3 center; float area; vec3 normal; vec3 radiance; };
LightPatch readLight(int i) {
  LightPatch lp;
  // 钳制索引，保证采样器始终被静态引用，避免编译器优化掉 uniform
  int idx = clamp(i, 0, max(0, uLightCount - 1));
  vec4 a = fetchTex(uLightTex, uLightTexWidth, idx * 3);
  vec4 b = fetchTex(uLightTex, uLightTexWidth, idx * 3 + 1);
  vec4 c = fetchTex(uLightTex, uLightTexWidth, idx * 3 + 2);
  lp.center = a.xyz; lp.area = a.w;
  lp.normal = b.xyz;
  lp.radiance = c.xyz;
  return lp;
}
// 发光面中心单点（稳定无 NaN）；多点采样由调用方在中心附近做小扰动近似
vec3 patchPoint(LightPatch lp, float u, float v) {
  float h = sqrt(max(0.01, lp.area)) * 0.25;
  vec3 w = abs(lp.normal.y) > 0.95 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 c1 = cross(w, lp.normal);
  vec3 t1 = length(c1) > 1e-6 ? normalize(c1) : vec3(1.0, 0.0, 0.0);
  vec3 c2 = cross(lp.normal, t1);
  vec3 t2 = length(c2) > 1e-6 ? normalize(c2) : vec3(0.0, 0.0, 1.0);
  vec3 jitter = (t1 * (u - 0.5) + t2 * (v - 0.5)) * 2.0 * h;
  return lp.center + jitter;
}
int hitMaterial(Hit h) {
  return int(fetchTex(uTriTex, uTriTexWidth, h.tri * 3).w);
}

// ---- 球谐 L1+L2（与 sh.ts 同系数） ----
void shBasis(vec3 dir, out float b[9]) {
  float x = dir.x, y = dir.y, z = dir.z;
  b[0] = 0.886227;
  b[1] = 1.023328 * y;  // 2*C2
  b[2] = 1.023328 * z;
  b[3] = 1.023328 * x;
  b[4] = 0.858086 * x * y; // 2*C1
  b[5] = 0.858086 * y * z;
  b[6] = 0.743125 * (3.0 * z * z - 1.0); // 2*C1*3
  b[7] = 0.858086 * x * z;
  b[8] = 0.429043 * (x * x - y * y);
}

// ---- DDGI 探针纹理采样 ----
// 辐照度纹理：每探针 9 纹素，纹素 0..2=R 通道 SH9，3..5=G，6..8=B，每纹素 4 系数
uniform sampler2D uIrrTex;
uniform sampler2D uDepthTex; // 每探针 3 纹素: 6 轴 (mean,meanSq)
uniform ivec3 uGridCount;
uniform vec3 uGridOrigin;
uniform vec3 uGridSpacing;
uniform int uProbeCount;

vec3 probeIrradiance(int probe, vec3 dir) {
  float b[9];
  shBasis(dir, b);
  vec3 c = vec3(0.0);
  for (int ch = 0; ch < 3; ch++) {
    for (int t = 0; t < 3; t++) {
      vec4 v = fetchTex(uIrrTex, uProbeCount * 9, probe * 9 + ch * 3 + t);
      for (int lane = 0; lane < 4; lane++) {
        int k = t * 4 + lane;
        if (k < 9) c[ch] += b[k] * v[lane];
      }
    }
  }
  return max(c, vec3(0.0));
}

int probeId(ivec3 c) {
  return (c.y * uGridCount.z + c.z) * uGridCount.x + c.x;
}

float chebyshev(float mean, float meanSq, float sampleDist) {
  if (sampleDist <= mean) return 1.0;
  float v = max(0.0, meanSq - mean * mean);
  float d = sampleDist - mean;
  return v / (v + d * d);
}

// 主导轴 → 深度纹理通道
vec4 depthMoments(int probe, int axisPair) {
  // 每探针 3 纹素存 12 个 float: 纹素0=(x+,x- 均值,二阶) 打包
  vec4 t0 = fetchTex(uDepthTex, uProbeCount * 3, probe * 3);
  vec4 t1 = fetchTex(uDepthTex, uProbeCount * 3, probe * 3 + 1);
  vec4 t2 = fetchTex(uDepthTex, uProbeCount * 3, probe * 3 + 2);
  if (axisPair == 0) return vec4(t0.x, t0.y, t0.z, t0.w);
  if (axisPair == 1) return vec4(t1.x, t1.y, t1.z, t1.w);
  return vec4(t2.x, t2.y, t2.z, t2.w);
}

// 探针在着色点方向的可见性（Chebyshev，防墙后漏光）
float probeChebyshev(int probe, vec3 point) {
  vec3 ppos = uGridOrigin + vec3(
    float(probe % uGridCount.x),
    float((probe / (uGridCount.x * uGridCount.z)) % uGridCount.y),
    float((probe / uGridCount.x) % uGridCount.z)
  ) * uGridSpacing;
  vec3 delta = point - ppos;
  vec3 ad = abs(delta);
  int axis = ad.x > ad.y && ad.x > ad.z ? 0 : (ad.y > ad.z ? 1 : 2);
  int pair = axis == 0 ? 0 : (axis == 1 ? 1 : 2);
  vec4 m = depthMoments(probe, pair);
  float sign_ = delta[axis] >= 0.0 ? 1.0 : -1.0;
  float mean = sign_ > 0.0 ? m.x : m.y;
  float meanSq = sign_ > 0.0 ? m.z : m.w;
  return chebyshev(mean, meanSq, ad[axis]);
}

// 三线性插值探针辐照度，8 邻域按 Chebyshev 权重
vec3 sampleIrradiance(vec3 point, vec3 normal) {
  vec3 f = (point - uGridOrigin) / uGridSpacing;
  vec3 base = clamp(floor(f) - 0.5, vec3(0.0), vec3(uGridCount) - 1.0);
  vec3 wsum3 = clamp(f - 0.5 - base, 0.0, 1.0);
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 8; i++) {
    ivec3 cell = ivec3(base) + ivec3(i & 1, (i >> 1) & 1, (i >> 2) & 1);
    if (any(greaterThanEqual(cell, uGridCount))) continue;
    vec3 w3 = mix(1.0 - wsum3, wsum3, vec3((i & 1), ((i >> 1) & 1), ((i >> 2) & 1)));
    float w = w3.x * w3.y * w3.z;
    int pid = probeId(cell);
    float vis = probeChebyshev(pid, point);
    vec3 dir = normalize(point - (uGridOrigin + vec3(cell) * uGridSpacing) + normal * 0.001);
    vec3 irr = probeIrradiance(pid, dir);
    acc += irr * w * vis;
    wsum += w * vis;
  }
  return wsum > 1e-4 ? acc / wsum : vec3(0.0);
}

// Fibonacci 半球方向（与 fibonacciHemisphere 同序列）
vec3 fibDir(int i, int n) {
  float fi = float(i) + 0.5;
  float y = fi / float(n);
  float r = sqrt(max(0.0, 1.0 - y * y));
  float golden = PI * (3.0 - sqrt(5.0));
  float theta = golden * float(i);
  return vec3(cos(theta) * r, y, sin(theta) * r);
}
`;
