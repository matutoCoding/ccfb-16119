// 手写 WebGL2 GLSL ES 3.00 着色器：BVH 遍历、NEE 直接光、多级漫反射、
// 八面体辐照度探针、深度二阶矩 Chebyshev 可见性、工作面伪彩。

export const FULLSCREEN_VERT = `#version 300 es
precision highp float;
out vec2 vUV;
void main(){
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUV = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** 公共：一维索引数据纹理读取 + BVH 最近求交 + 阴影透射 + 天空 + 灯光 */
const COMMON = `
precision highp float;
uniform sampler2D uNodeTex; uniform vec2 uNodeDim;
uniform sampler2D uTriTex;  uniform vec2 uTriDim;
uniform sampler2D uMatTex;  uniform vec2 uMatDim;

uniform int uLightCount;
uniform vec4 uLightA[64]; // xyz=位置 w=尺寸
uniform vec4 uLightB[64]; // x=通量 y=配光指数

uniform int  uSkyType;    // 0 阴 1 晴
uniform vec3 uSunDir;
uniform float uSkyLz;

vec4 fd(sampler2D t, vec2 dim, float idx){
  float x = mod(idx, dim.x);
  float y = floor(idx / dim.x);
  return textureLod(t, vec2((x + 0.5) / dim.x, (y + 0.5) / dim.y), 0.0);
}

float hash13(vec3 p){
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

// CIE 相对亮度
float cieRel(vec3 d){
  float y = max(d.y, 0.0);
  float cosZ = y;
  if(uSkyType == 0){
    return (1.0 + 2.0 * cosZ) / 3.0;
  }
  float cosGamma = clamp(dot(d, uSunDir), -1.0, 1.0);
  float gamma = acos(cosGamma);
  float zS = acos(clamp(uSunDir.y, -1.0, 1.0));
  float eps = acos(clamp(cosZ, -1.0, 1.0));
  float phiG = 0.91 + 10.0 * exp(-3.0 * gamma) + 0.45 * cosGamma * cosGamma;
  float phiS = 0.91 + 10.0 * exp(-3.0 * zS) + 0.45 * cos(zS) * cos(zS);
  float fzE = 1.0 - exp(-0.32 / max(0.08, cos(eps)));
  float fz0 = 1.0 - exp(-0.32);
  return max(0.0, (fzE * phiG) / max(1e-3, fz0 * phiS));
}

// 环境辐射亮度 cd/m2（标量近似，暖白）
vec3 skyRadiance(vec3 d){
  if(d.y < -0.02){
    float g = uSkyLz * 0.18;
    return vec3(g, g, g);
  }
  float L = uSkyLz * cieRel(d);
  float cosSun = clamp(dot(d, uSunDir), 0.0, 1.0);
  float disk = uSkyType == 1 && cosSun > 0.9995 ? uSkyLz * 60.0 : 0.0;
  return vec3(L + disk, L * 0.97 + disk * 0.95, L * 0.92 + disk * 0.9);
}

bool slab(vec3 o, vec3 d, vec3 bmin, vec3 bmax, inout float tmin, inout float tmax){
  if(abs(d.x) < 1e-9){ if(o.x < bmin.x || o.x > bmax.x) return false; }
  else { float a=(bmin.x-o.x)/d.x, b=(bmax.x-o.x)/d.x; if(a>b){float t=a;a=b;b=t;} tmin=max(tmin,a); tmax=min(tmax,b); if(tmax<tmin) return false; }
  if(abs(d.y) < 1e-9){ if(o.y < bmin.y || o.y > bmax.y) return false; }
  else { float a=(bmin.y-o.y)/d.y, b=(bmax.y-o.y)/d.y; if(a>b){float t=a;a=b;b=t;} tmin=max(tmin,a); tmax=min(tmax,b); if(tmax<tmin) return false; }
  if(abs(d.z) < 1e-9){ if(o.z < bmin.z || o.z > bmax.z) return false; }
  else { float a=(bmin.z-o.z)/d.z, b=(bmax.z-o.z)/d.z; if(a>b){float t=a;a=b;b=t;} tmin=max(tmin,a); tmax=min(tmax,b); if(tmax<tmin) return false; }
  return true;
}

struct Hit { float t; int mat; vec3 p; vec3 n; };

Hit closestHit(vec3 O, vec3 D){
  Hit h; h.t = 1e9; h.mat = -1; h.p = O; h.n = vec3(0.0,1.0,0.0);
  int stack[48]; int sp = 1; stack[0] = 0;
  for(int iter=0; iter<256; iter++){
    if(sp <= 0) break;
    int ni = stack[--sp];
    float base = float(ni) * 2.0;
    vec4 n0 = fd(uNodeTex, uNodeDim, base);
    vec4 n1 = fd(uNodeTex, uNodeDim, base + 1.0);
    float tmn = 0.0005, tmx = h.t;
    if(!slab(O, D, n0.xyz, n1.xyz, tmn, tmx)) continue;
    int lf = int(n0.w + 0.5);
    float meta = n1.w;
    if(meta > 0.0){
      int cnt = int(meta + 0.5);
      for(int k=0; k<6; k++){
        if(k >= cnt) break;
        float tb = float(lf + k) * 4.0;
        vec4 q0 = fd(uTriTex, uTriDim, tb);
        vec4 q1 = fd(uTriTex, uTriDim, tb + 1.0);
        vec4 q2 = fd(uTriTex, uTriDim, tb + 2.0);
        vec3 v0=q0.xyz, v1=q1.xyz, v2=q2.xyz;
        vec3 e1=v1-v0, e2=v2-v0;
        vec3 pv=cross(D,e2);
        float det=dot(e1,pv);
        if(abs(det) < 1e-8) continue;
        float inv=1.0/det;
        vec3 tv=O-v0;
        float u=dot(tv,pv)*inv;
        if(u<0.0 || u>1.0) continue;
        vec3 qv=cross(tv,e1);
        float v=dot(D,qv)*inv;
        if(v<0.0 || u+v>1.0) continue;
        float tt=dot(e2,qv)*inv;
        if(tt>0.0008 && tt<h.t){
          h.t=tt; h.mat=int(q0.w+0.5); h.p=O+D*tt;
          vec4 q3=fd(uTriTex,uTriDim,tb+3.0);
          h.n=q3.xyz;
        }
      }
    } else {
      int right = int(-meta) - 1;
      if(sp < 46){ stack[sp++] = lf; stack[sp++] = right; }
    }
  }
  return h;
}

vec4 matProps(int m){
  float base = float(m) * 3.0;
  return fd(uMatTex, uMatDim, base);      // rgb albedo, a reflectance
}
vec4 matProps2(int m){ return fd(uMatTex, uMatDim, float(m)*3.0 + 1.0); }
int matKind(int m){ return int(fd(uMatTex, uMatDim, float(m)*3.0 + 2.0).x + 0.5); }

// 阴影透射系数（玻璃衰减），不透明=0，无遮挡=1
float shadowFactor(vec3 O, vec3 D, float maxT){
  float through = 1.0;
  vec3 o = O + D * 0.02;
  float remain = maxT;
  for(int b=0;b<4;b++){
    Hit h = closestHit(o, D);
    if(h.t >= remain || h.mat < 0) return through;
    int kind = matKind(h.mat);
    if(kind == 2){
      through *= matProps2(h.mat).a;
      o = h.p + D * 0.02;
      remain -= h.t;
      if(remain <= 0.0 || through < 0.03) return through;
    } else {
      return 0.0;
    }
  }
  return through;
}

// 所有灯的直接照度（工作面用，稳定）
float directAll(vec3 p, vec3 n){
  float E = 0.0;
  for(int i=0;i<64;i++){
    if(i >= uLightCount) break;
    vec3 lp = uLightA[i].xyz;
    float sz = max(0.05, uLightA[i].w);
    vec3 q = lp; // 面中心，稳定
    vec3 lv = q - p;
    float r2 = dot(lv,lv);
    float r = sqrt(r2);
    if(r < 0.05 || r > 17.0) continue; // 距离裁剪，远处灯贡献可忽略
    vec3 Ld = lv / r;
    float cosP = dot(n, Ld);
    if(cosP <= 0.0) continue;
    float cosQ = dot(vec3(0.0,-1.0,0.0), -Ld);
    if(cosQ <= 0.0) continue;
    float vis = shadowFactor(p + n*0.02, Ld, r);
    if(vis <= 0.0) continue;
    float area = sz*sz;
    float Le = uLightB[i].x / (3.14159265 * area);
    E += Le * cosP * cosQ * vis * area / r2;
  }
  return E;
}

// 随机一盏灯的直接照度（烘焙用，无偏 ×count）
float directOne(vec3 p, vec3 n, inout float seed){
  if(uLightCount <= 0) return 0.0;
  float rf = hash13(vec3(seed, seed*1.7, seed*2.3)); seed += 0.137;
  int li = int(rf * float(uLightCount));
  if(li >= uLightCount) li = uLightCount - 1;
  vec3 lp = uLightA[li].xyz;
  float sz = max(0.05, uLightA[li].w);
  float j1 = hash13(vec3(seed,1.0,2.0)); seed += 0.291;
  float j2 = hash13(vec3(seed,3.0,4.0)); seed += 0.417;
  vec3 q = lp + vec3((j1-0.5)*sz, 0.0, (j2-0.5)*sz);
  vec3 lv = q - p;
  float r2 = dot(lv,lv); float r = sqrt(r2);
  if(r < 0.05) return 0.0;
  vec3 Ld = lv/r;
  float cosP = dot(n,Ld); if(cosP<=0.0) return 0.0;
  float cosQ = dot(vec3(0,-1,0), -Ld); if(cosQ<=0.0) return 0.0;
  float vis = shadowFactor(p + n*0.02, Ld, r);
  if(vis<=0.0) return 0.0;
  float area = sz*sz;
  float Le = uLightB[li].x/(3.14159265*area);
  return float(uLightCount) * Le * cosP*cosQ*vis*area/r2;
}

vec3 cosineHemi(vec3 n, inout float seed){
  float r1 = hash13(vec3(seed, 7.1, 3.7)); seed += 0.618;
  float r2 = hash13(vec3(seed, 2.3, 9.2)); seed += 0.755;
  float phi = 6.2831853*r1;
  float rr = sqrt(r2);
  vec3 up = abs(n.y) < 0.999 ? vec3(0,1,0) : vec3(1,0,0);
  vec3 t = normalize(cross(up,n));
  vec3 b = cross(n,t);
  return normalize(t*(rr*cos(phi)) + b*(rr*sin(phi)) + n*sqrt(max(0.0,1.0-r2)));
}

vec3 faceN(vec3 raw, vec3 d){ return dot(raw,d) > 0.0 ? -raw : raw; }

// 探针间接辐照度（根节点不计直接光），多级漫反射路径
float bakeIndirect(vec3 origin, vec3 n, int samples, float frameSeed){
  float E = 0.0;
  for(int s=0;s<8;s++){
    if(s>=samples) break;
    float seed = frameSeed + float(s)*12.9898;
    vec3 O = origin;
    vec3 D = cosineHemi(n, seed);
    float thr = 1.0;
    for(int b=0;b<4;b++){
      Hit h = closestHit(O,D);
      if(h.mat < 0 || h.t >= 1e8){ E += thr * 3.14159265 * dot(skyRadiance(D), vec3(0.2126,0.7152,0.0722)); break; }
      vec4 mp = matProps(h.mat);
      float rho = mp.a;
      int kind = matKind(h.mat);
      vec3 n2 = faceN(h.n, D);
      if(kind == 1){ break; } // 发光面交给 NEE
      if(kind == 2){
        thr *= matProps2(h.mat).a;
        O = h.p + D*0.03;
        continue;
      }
      thr *= rho;
      E += thr * directOne(h.p, n2, seed);
      // 继续一条余弦弹射
      D = cosineHemi(n2, seed);
      O = h.p + n2*0.02;
      if(thr < 0.05) break;
    }
  }
  return E / float(samples);
}
`;

export const COPY_FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uIrr; uniform sampler2D uMom;
layout(location=0) out vec4 oIrr;
layout(location=1) out vec4 oMom;
void main(){
  oIrr = texture(uIrr, vUV);
  oMom = texture(uMom, vUV);
}`;

export const BAKE_FRAG = `#version 300 es
${COMMON}
in vec2 vUV;
uniform vec3 uProbePos;
uniform vec2 uTileOrigin;   // 像素
uniform float uAtlasPx;     // 256
uniform float uTilePx;      // 16
uniform float uFrame;
uniform int uSamples;
uniform sampler2D uIrrSrc;
uniform sampler2D uMomSrc;
layout(location=0) out vec4 oIrr;
layout(location=1) out vec4 oMom;

vec3 octDecode(vec2 f){
  f = f*2.0 - 1.0;
  vec3 n = vec3(f.x, f.y, 1.0 - abs(f.x) - abs(f.y));
  if(n.z < 0.0){ n.xy = (1.0 - abs(n.yx)) * vec2(n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0); }
  return normalize(n);
}

void main(){
  vec3 n = octDecode(vUV);
  float seed = uFrame*1.7 + gl_FragCoord.x*0.37 + gl_FragCoord.y*0.91;
  float irr = bakeIndirect(uProbePos, n, uSamples, seed);

  // 深度矩：沿严格 n 方向求最近距离
  Hit dh = closestHit(uProbePos, n);
  float depth = dh.mat >= 0 ? dh.t : 100.0;

  vec2 atlasUV = (uTileOrigin + vec2(clamp(vUV.x*uTilePx,0.5,uTilePx-0.5), clamp(vUV.y*uTilePx,0.5,uTilePx-0.5))) / uAtlasPx;
  vec4 oldI = textureLod(uIrrSrc, atlasUV, 0.0);
  vec4 oldM = textureLod(uMomSrc, atlasUV, 0.0);
  float cnt = oldI.a;
  float k = float(uSamples);
  float newCnt = cnt + k;
  float a = 1.0 / newCnt;
  // 旧均值与本伦样本均值递推（样本均值即 irr，因为 bakeIndirect 已除 samples）
  vec3 irrMean = cnt <= 0.0 ? vec3(irr) : mix(oldI.rgb, vec3(irr), clamp(k/(cnt+k),0.0,1.0));
  float m1 = cnt <= 0.0 ? depth : mix(oldM.r, depth, k/(cnt+k));
  float d2 = depth*depth;
  float m2 = cnt <= 0.0 ? d2 : mix(oldM.g, d2, k/(cnt+k));
  oIrr = vec4(irrMean, newCnt);
  oMom = vec4(m1, m2, newCnt, 1.0);
}`;

export const WORKPLANE_FRAG = `#version 300 es
${COMMON}
precision highp float;
in vec2 vUV;
out vec4 outColor;

uniform sampler2D uIrrTex;
uniform sampler2D uMomTex;
uniform vec3 uGridOrigin;
uniform vec3 uGridSpacing;
uniform vec3 uGridDim;     // nx,ny,nz
uniform vec4 uBounds;      // minX,minZ,sizeX,sizeZ
uniform float uWorkY;
uniform float uMaxLux;
uniform float uStdLux;
uniform float uViewAspect;

vec2 octEncode(vec3 n){
  n /= (abs(n.x)+abs(n.y)+abs(n.z));
  if(n.z < 0.0){ n.xy = (1.0 - abs(n.yx)) * vec2(n.x>=0.0?1.0:-1.0, n.y>=0.0?1.0:-1.0); }
  return n.xy*0.5 + 0.5;
}
vec2 probeTileUV(int idx, vec2 oct){
  float col = float(idx - (idx/16)*16);
  float row = float(idx/16);
  vec2 local = clamp(oct*15.0 + 0.5, vec2(0.5), vec2(15.5));
  return (vec2(col*16.0, row*16.0) + local) / 256.0;
}
int probeIndex(int ix, int iy, int iz){
  return ix + int(uGridDim.x)*iz + int(uGridDim.x)*int(uGridDim.z)*iy;
}
vec3 probePos(int ix,int iy,int iz){
  return uGridOrigin + vec3(float(ix)*uGridSpacing.x, float(iy)*uGridSpacing.y, float(iz)*uGridSpacing.z);
}

float sampleIndirect(vec3 p, vec3 n){
  vec3 gf = (p - uGridOrigin)/uGridSpacing;
  vec3 f0 = floor(gf);
  vec3 fr = fract(gf);
  float sumW=0.0; vec3 sumI=vec3(0.0);
  for(int iy=0;iy<2;iy++)
  for(int iz=0;iz<2;iz++)
  for(int ix=0;ix<2;ix++){
    int gx = int(f0.x)+ix, gy=int(f0.y)+iy, gz=int(f0.z)+iz;
    if(gx<0||gy<0||gz<0) continue;
    if(gx>=int(uGridDim.x)||gy>=int(uGridDim.y)||gz>=int(uGridDim.z)) continue;
    float wx = ix==0 ? 1.0-fr.x : fr.x;
    float wy = iy==0 ? 1.0-fr.y : fr.y;
    float wz = iz==0 ? 1.0-fr.z : fr.z;
    float w = wx*wy*wz;
    vec3 pp = probePos(gx,gy,gz);
    vec3 toP = p-pp; float dd=length(toP); vec3 dv=toP/max(dd,1e-4);
    int idx = probeIndex(gx,gy,gz);
    vec2 iuv = probeTileUV(idx, octEncode(n));
    vec4 irr = textureLod(uIrrTex, iuv, 0.0);
    vec2 muv = probeTileUV(idx, octEncode(dv));
    vec4 mom = textureLod(uMomTex, muv, 0.0);
    if(mom.a <= 0.0) continue; // 尚未烘焙
    float variance = max(mom.g - mom.r*mom.r, 1e-3);
    float bias = 0.25;
    float cheb = dd <= mom.r + bias ? 1.0 : variance/(variance + (dd-mom.r-bias)*(dd-mom.r-bias));
    cheb = clamp(cheb,0.0,1.0);
    w *= clamp(cheb*1.6, 0.0, 1.0);
    // 弱法线朝向权重，减少跨层串光
    w *= 0.65 + 0.35*max(dot(n, normalize(pp-p)), 0.0);
    sumW += w;
    sumI += w*irr.rgb;
  }
  if(sumW < 1e-4) return -1.0;
  return dot(sumI/sumW, vec3(0.2126,0.7152,0.0722));
}

vec3 falseColor(float t){
  t = clamp(pow(clamp(t,0.0,1.0), 0.62), 0.0, 1.0);
  vec3 c0=vec3(0.078,0.157,0.471), c1=vec3(0.118,0.431,0.863), c2=vec3(0.118,0.784,0.863);
  vec3 c3=vec3(0.235,0.863,0.471), c4=vec3(0.941,0.863,0.235), c5=vec3(0.941,0.514,0.157), c6=vec3(0.863,0.157,0.157);
  if(t<0.2) return mix(c0,c1,t/0.2);
  if(t<0.4) return mix(c1,c2,(t-0.2)/0.2);
  if(t<0.6) return mix(c2,c3,(t-0.4)/0.2);
  if(t<0.78) return mix(c3,c4,(t-0.6)/0.18);
  if(t<0.92) return mix(c4,c5,(t-0.78)/0.14);
  return mix(c5,c6,(t-0.92)/0.08);
}

void main(){
  // 等比 contain：按房间宽深比计算可见世界范围，避免拉伸
  float roomW = uBounds.z, roomD = uBounds.w;
  float roomA = roomW / max(0.001, roomD);
  float viewA = max(0.001, uViewAspect);
  float visW, visD;
  if(viewA > roomA){ visD = roomD * 1.12; visW = visD * viewA; }
  else { visW = roomW * 1.12; visD = visW / viewA; }
  vec2 center = uBounds.xy + uBounds.zw * 0.5;
  float wx = center.x + (vUV.x - 0.5) * visW;
  float wz = center.y + (0.5 - vUV.y) * visD;
  // 房间外：深色留白
  if(wx < uBounds.x || wx > uBounds.x + roomW || wz < uBounds.y || wz > uBounds.y + roomD){
    outColor = vec4(0.055, 0.086, 0.15, 1.0);
    return;
  }
  vec3 p = vec3(wx, uWorkY, wz);
  vec3 n = vec3(0.0,1.0,0.0);
  float direct = directAll(p, n);
  float indirect = sampleIndirect(p + n*0.03, n);
  if(indirect < 0.0) indirect = 0.0;
  float lux = direct + indirect;

  vec3 col = falseColor(lux/uMaxLux);
  // 标准等照度线（fwidth 抗锯齿）
  if(uStdLux > 1.0){
    float d = abs(lux-uStdLux);
    float fw = fwidth(lux)*1.2 + 0.6;
    if(d < fw) col = mix(col, vec3(1.0), 0.9);
  }
  // 每 200 lx 的淡细等照线（对 fwidth 做上限，避免放大时变成碎纹）
  float gl2 = abs(fract(lux/200.0+0.5)-0.5)*200.0;
  float fw2 = min(fwidth(lux), 6.0) + 0.4;
  if(gl2 < fw2) col = mix(col, vec3(1.0), 0.16);
  // 房间边界暗角提示
  outColor = vec4(col, 1.0);
}`;
