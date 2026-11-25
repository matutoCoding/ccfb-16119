import type { Vec3 } from '../../types';
import type { BvhData } from '../geometry/bvh';
import { traceRay } from '../geometry/bvh';
import type { MeshData, SurfacePatch } from '../geometry/mesh';
import { fibonacciHemisphere } from './probes';
import { v3 } from '../math/vec3';
import { hash21 } from '../math/vec3';

// CPU 参考光追：直接面积光（窗/漫射器）+ 半球采样一次弹射。
// 用于单测、解析值对账和 GPU 结果回归，不追求速度。

export interface AreaLight {
  patch: SurfacePatch;
  radiance: Vec3; // 朗伯发光面亮度 cd/m²
}

function patchCorners(patch: SurfacePatch, mesh: MeshData): Vec3[] {
  // 通过材质 id 反找四边形（窗与漫射器均为双三角 quad）
  const triIdx = mesh.tris.findIndex((t) => t.mat === patch.matId);
  if (triIdx < 0) return [];
  const t = mesh.tris[triIdx];
  const v0 = t.v0;
  const v1 = v3.add(t.v0, t.e1);
  const v2 = v3.add(t.v0, t.e2);
  const t2 = mesh.tris[triIdx + 1];
  const v3p = v3.add(t2.v0, t2.e2);
  return [v0, v1, v2, v3p];
}

/** 直接照度（lux，标量亮度）：面积光多点采样 + BVH 遮挡 */
export function directIlluminance(
  point: Vec3,
  lights: AreaLight[],
  bvh: BvhData,
  mesh: MeshData,
  subdiv = 2,
): number {
  let total = 0;
  for (const light of lights) {
    const corners = patchCorners(light.patch, mesh);
    if (corners.length < 4) continue;
    const [a, b, c, d] = corners;
    let sum = 0;
    let samples = 0;
    for (let i = 0; i < subdiv; i++) {
      for (let j = 0; j < subdiv; j++) {
        const u = (i + 0.5) / subdiv;
        const w = (j + 0.5) / subdiv;
        const ab = v3.lerp(a, b, u);
        const dc = v3.lerp(d, c, u);
        const sp = v3.lerp(ab, dc, w);
        const to = v3.sub(sp, point);
        const dist = v3.len(to);
        if (dist < 1e-4) continue;
        const dir = v3.scale(to, 1 / dist);
        const hit = traceRay(bvh, mesh.tris, { origin: point, dir, tmin: 1e-3, tmax: dist - 1e-3 });
        if (hit) continue;
        // 法线：四边形朝向
        const normal = v3.norm(v3.cross(v3.sub(b, a), v3.sub(d, a)));
        const nDotL = Math.max(0, -(v3.dot(normal, dir)));
        const lDotN = Math.max(0, v3.dot(dir, [0, 1, 0])); // 工作面朝上
        const lum = (light.radiance[0] + light.radiance[1] + light.radiance[2]) / 3;
        sum += lum * nDotL * lDotN * light.patch.area / (subdiv * subdiv * dist * dist);
        samples++;
      }
    }
    total += samples ? sum : 0;
  }
  return total;
}

/** 一次弹射间接照度（蒙特卡洛，cosine 半球），albedo 取命中材质灰度 */
export function indirectIlluminance(
  point: Vec3,
  lights: AreaLight[],
  bvh: BvhData,
  mesh: MeshData,
  rayCount = 64,
): number {
  const dirs = fibonacciHemisphere(rayCount);
  let acc = 0;
  for (const dir of dirs) {
    const hit = traceRay(bvh, mesh.tris, { origin: point, dir, tmin: 1e-3, tmax: 200 });
    if (!hit) continue;
    const mat = mesh.materials[mesh.tris[hit.triIndex].mat];
    const em = (mat.emissive[0] + mat.emissive[1] + mat.emissive[2]) / 3;
    if (em > 0) {
      acc += em * Math.PI; // 发光面辐照度贡献
      continue;
    }
    const rho = (mat.albedo[0] + mat.albedo[1] + mat.albedo[2]) / 3;
    const hp = v3.add(point, v3.scale(dir, hit.t));
    acc += rho * directIlluminance(hp, lights, bvh, mesh, 1);
  }
  return acc / rayCount * Math.PI; // 等权立体角 → 辐照度
}

/**
 * 立方体白墙房间的解析校核（辐射度法，漫射发光顶）。
 * 六面等反射率 rho，顶面均匀发光通量 Φ。
 * E_floor = Φ/A · (1-rho)/(1-rho·平均角系数) 的精确六面形式。
 */
export function analyticCubeRoomIlluminance(
  size: number,
  rho: number,
  emittedLumens: number,
): { floor: number; ceiling: number; wall: number } {
  const A = size * size;
  // 两个等大正对平行矩形的角系数（标准公式，X=Y=a/h）
  // 立方体 a/h = 1
  // Howell 公式：两个等大正对平行矩形，无量纲 X=Y=a/h，立方体为 1
  const X = 1;
  const Y = 1;
  const Fpara =
    (2 / Math.PI) * (
      Math.log(Math.sqrt(((1 + X * X) * (1 + Y * Y)) / (1 + X * X + Y * Y)))
      + X * Math.sqrt(1 + Y * Y) * Math.atan(X / Math.sqrt(1 + Y * Y))
      + Y * Math.sqrt(1 + X * X) * Math.atan(Y / Math.sqrt(1 + X * X))
      - X * Math.atan(X) - Y * Math.atan(Y)
    );
  const Fself = 0;
  const Fadj = (1 - Fpara) / 4; // 每面 4 个相邻面
  // 辐射度线性系统（三类面：地 f、顶 c、墙 w），利用对称性
  // B = E + rho·F·B；发光顶初始出射度 E0 = Φ/A
  const E0 = emittedLumens / A;
  // rho=0 边界：无反射，地面入射照度仅来自发光顶的直接角系数传递
  if (rho < 1e-6) {
    const direct = E0 * Fpara; // 顶面出射度 E0 经角系数到地面
    return { floor: direct, ceiling: E0, wall: E0 * Fadj };
  }
  // 角系数（面类型间）
  const Ffc = Fpara;            // 地→顶
  const Ffw = 1 - Fpara;        // 地→墙总和
  const Fcf = Fpara;
  const Fcw = 1 - Fpara;
  const Fwf = Fadj;             // 墙→地
  const Fwc = Fadj;             // 墙→顶
  const Fww = 1 - 2 * Fadj;     // 墙→其他墙
  // 解方程（3 未知 Bf,Bc,Bw）
  // Bf = rho(Ffc Bc + Ffw Bw)
  // Bc = E0 + rho(Fcf Bf + Fcw Bw)
  // Bw = rho(Fwf Bf + Fwc Bc + Fww Bw)
  const a11 = 1, a12 = -rho * Ffc, a13 = -rho * Ffw;
  const a21 = -rho * Fcf, a22 = 1, a23 = -rho * Fcw;
  const a31 = -rho * Fwf, a32 = -rho * Fwc, a33 = 1 - rho * Fww;
  const b2 = E0;
  // 高斯-约当消元（含行归一化），解 B = E + ρFB
  const M = [
    [a11, a12, a13, 0],
    [a21, a22, a23, b2],
    [a31, a32, a33, 0],
  ];
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    const div = M[col][col] || 1e-12;
    for (let k = col; k < 4; k++) M[col][k] /= div;
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = M[r][col];
      for (let k = col; k < 4; k++) M[r][k] -= f * M[col][k];
    }
  }
  const Bf = M[0][3];
  const Bc = M[1][3];
  const Bw = M[2][3];
  // 非发光面辐射度 B = rho·E_in，入射照度 E_in = B/rho
  return {
    floor: Bf / rho,
    ceiling: Bc - E0,
    wall: Bw / rho,
  };
}

/** 积分球公式：平均入射照度 Eavg = Φ/(A_total) · 1/(1-rho) */
export function integratingSphereAvg(emittedLumens: number, totalArea: number, rho: number): number {
  // 封闭腔多次反射后的平均入射照度
  return (emittedLumens / totalArea) / (1 - rho);
}

/** 余弦加权半球方向（绕法线 n），pdf=cosθ/π。local.y 为法线方向分量 */
function cosineHemisphereDir(normal: Vec3, r1: number, r2: number): Vec3 {
  // 余弦加权：cosθ=sqrt(r2)（r2 均匀），径向 sinθ=sqrt(1-r2)
  const cosTheta = Math.sqrt(Math.max(0, r2));
  const sinTheta = Math.sqrt(Math.max(0, 1 - r2));
  const phi = 2 * Math.PI * r1;
  const local: Vec3 = [sinTheta * Math.cos(phi), cosTheta, sinTheta * Math.sin(phi)];
  const w = Math.abs(normal[1]) < 0.95 ? ([0, 1, 0] as Vec3) : ([1, 0, 0] as Vec3);
  const t1 = v3.norm(v3.cross(normal, w));
  // 保证右手系 t1 × t2 = normal，故 t2 = normal × t1
  const t2 = v3.cross(normal, t1);
  return v3.norm(v3.add(
    v3.add(v3.scale(t1, local[0]), v3.scale(normal, local[1])),
    v3.scale(t2, local[2]),
  ));
}

/** 每弹射独立的两维确定性随机数（hash 生成，避免低差异序列在规则几何下退化） */
function rand2(seed: number, salt: number): [number, number] {
  return [hash21(seed, salt), hash21(seed + 7919, salt * 3 + 13)];
}

/**
 * 完整多弹射路径追踪（余弦加权采样，pdf=cosθ/π）。
 * 主光线 E = (1/N) Σ π·L；弹射 throughput 只乘 albedo（余弦/pdf 解析抵消）。
 * 返回工作面朝上的入射照度 lux。
 */
export function pathTraceIlluminance(
  point: Vec3,
  bvh: BvhData,
  mesh: MeshData,
  rayCount: number,
  maxBounce = 6,
): number {
  let acc = 0;
  for (let r = 0; r < rayCount; r++) {
    // 每条路径独立随机数计数器，避免深层弹射样本相关
    let scramble = r * 2654435761;
    const next = (): [number, number] => {
      scramble = (scramble + 1) | 0;
      return [hash21(scramble, r * 7 + 3), hash21(scramble ^ 0x9e3779b9, r * 13 + 7)];
    };
    const [r1, r2] = next();
    let dir = cosineHemisphereDir([0, 1, 0], r1, r2);
    let origin: Vec3 = [point[0], point[1] + 0.002, point[2]];
    let throughput = Math.PI; // 主光线 E = π·L 估计
    for (let bounce = 0; bounce <= maxBounce; bounce++) {
      const hit = traceRay(bvh, mesh.tris, { origin, dir, tmin: 1e-3, tmax: 200 });
      if (!hit) break;
      const m = mesh.materials[mesh.tris[hit.triIndex].mat];
      const em = (m.emissive[0] + m.emissive[1] + m.emissive[2]) / 3;
      if (em > 0) {
        // 发光面：累计自发光贡献，但不终止——继续追踪其反射分量（能量守恒）
        acc += throughput * em;
      }
      const rho = (m.albedo[0] + m.albedo[1] + m.albedo[2]) / 3;
      throughput *= rho;
      if (throughput < 1e-4) break;
      const [b1, b2] = next();
      const nd = cosineHemisphereDir(hit.normal, b1, b2);
      origin = v3.add(hitPoint(origin, dir, hit.t), v3.scale(hit.normal, 0.002));
      dir = nd;
    }
  }
  return acc / rayCount;
}

function hitPoint(o: Vec3, d: Vec3, t: number): Vec3 {
  return v3.add(o, v3.scale(d, t));
}
