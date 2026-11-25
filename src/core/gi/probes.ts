import type { Vec3 } from '../../types';
import type { BvhData, HitResult } from '../geometry/bvh';
import { traceRay } from '../geometry/bvh';
import type { Tri } from '../geometry/mesh';
import { v3 } from '../math/vec3';

// DDGI 动态漫反射全局光照：规则网格探针
// 每探针：RGB 球谐 L1+L2（27 系数）+ 6 轴向深度矩（均值/二阶矩，共12）
// 着色时三线性插值，Chebyshev 不等式做可见性权重，杜绝墙后漏光。

export const SH_COEFFS = 9;
export const SH_TEXELS = 7; // 27/4 向上取整
export const DEPTH_TEXELS = 3; // 12/4
export const DEPTH_DIRS: Vec3[] = [
  [1, 0, 0], [-1, 0, 0],
  [0, 1, 0], [0, -1, 0],
  [0, 0, 1], [0, 0, -1],
];

export interface ProbeGrid {
  origin: Vec3; // 角点
  count: [number, number, number]; // nx,ny,nz
  spacing: Vec3;
  positions: Vec3[];
}

export function buildProbeGrid(
  bounds: { min: Vec3; max: Vec3 },
  spacing: number,
  margin = 0.6,
): ProbeGrid {
  const lo: Vec3 = [
    bounds.min[0] + margin,
    bounds.min[1] + margin,
    bounds.min[2] + margin,
  ];
  const hi: Vec3 = [
    bounds.max[0] - margin,
    bounds.max[1] - margin,
    bounds.max[2] - margin,
  ];
  const n: [number, number, number] = [
    Math.max(1, Math.round((hi[0] - lo[0]) / spacing) + 1),
    Math.max(1, Math.round((hi[1] - lo[1]) / spacing) + 1),
    Math.max(1, Math.round((hi[2] - lo[2]) / spacing) + 1),
  ];
  const sp: Vec3 = [
    (hi[0] - lo[0]) / (n[0] - 1 || 1),
    (hi[1] - lo[1]) / (n[1] - 1 || 1),
    (hi[2] - lo[2]) / (n[2] - 1 || 1),
  ];
  const positions: Vec3[] = [];
  for (let iy = 0; iy < n[1]; iy++) {
    for (let iz = 0; iz < n[2]; iz++) {
      for (let ix = 0; ix < n[0]; ix++) {
        positions.push([
          lo[0] + ix * sp[0],
          lo[1] + iy * sp[1],
          lo[2] + iz * sp[2],
        ]);
      }
    }
  }
  return { origin: lo, count: n, spacing: sp, positions };
}

export function probeIndex(grid: ProbeGrid, ix: number, iy: number, iz: number): number {
  const [nx, , nz] = grid.count;
  return iy * nx * nz + iz * nx + ix;
}

/** Fibonacci 半球方向（CPU/GPU 共用同一确定性序列） */
export function fibonacciHemisphere(n: number): Vec3[] {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const out: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const y = (i + 0.5) / n;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    out.push([Math.cos(theta) * r, y, Math.sin(theta) * r]);
  }
  return out;
}

/**
 * 探针 6 轴向深度矩（CPU 参考实现，供单测与 GPU 结果对账）。
 * 返回每方向 [meanDepth, meanDepthSq]。
 */
export function computeDepthMoments(
  origin: Vec3,
  bvh: BvhData,
  tris: Tri[],
  maxDist: number,
): Float32Array {
  const out = new Float32Array(12);
  DEPTH_DIRS.forEach((d, k) => {
    const hit: HitResult | null = traceRay(bvh, tris, {
      origin,
      dir: d,
      tmin: 0.05,
      tmax: maxDist,
    });
    const dist = hit ? hit.t : maxDist;
    out[k * 2] = dist;
    out[k * 2 + 1] = dist * dist;
  });
  return out;
}

/**
 * Chebyshev 可见性权重（DDGI 标准做法）。
 * depth: 沿轴的均值与二阶矩；sampleDist: 着色点到探针在该轴的投影距离。
 */
export function chebyshevWeight(mean: number, meanSq: number, sampleDist: number): number {
  if (sampleDist <= mean) return 1;
  const variance = Math.max(0, meanSq - mean * mean);
  const d = sampleDist - mean;
  return variance / (variance + d * d);
}

/** 找最近的主导轴下标（与 GLSL 实现保持一致） */
export function dominantAxis(dir: Vec3): number {
  const ax = Math.abs(dir[0]);
  const ay = Math.abs(dir[1]);
  const az = Math.abs(dir[2]);
  if (ax >= ay && ax >= az) return dir[0] > 0 ? 0 : 1;
  if (ay >= ax && ay >= az) return dir[1] > 0 ? 2 : 3;
  return dir[2] > 0 ? 4 : 5;
}

/**
 * 探针 → 着色点的可见性：取两点连线方向的主导轴深度矩做 Chebyshev。
 * moments: 12 个深度矩，布局 [x+ μ,x+ μ²,x- μ,x- μ², y+..., y-..., z+..., z-...]
 */
export function probeVisibility(moments: Float32Array, probePos: Vec3, point: Vec3): number {
  const delta = v3.sub(point, probePos);
  const dist = v3.len(delta);
  if (dist < 1e-4) return 1;
  const axis = dominantAxis(v3.scale(delta, 1 / dist));
  const axisVec = axis >> 1; // 0=x,1=y,2=z
  const positive = axis % 2 === 0;
  const sampleDist = Math.abs(delta[axisVec]);
  // 每轴 4 个 float：(μ+, μ+², μ-, μ-²)
  const base = axisVec * 4;
  const mean = positive ? moments[base] : moments[base + 2];
  const meanSq = positive ? moments[base + 1] : moments[base + 3];
  return chebyshevWeight(mean, meanSq, sampleDist);
}

/** 收敛度统计：新旧 SH 之间的相对变化（0..1，越小越收敛） */
export function convergenceDelta(oldSH: Float32Array, newSH: Float32Array): number {
  let diff = 0;
  let norm = 0;
  for (let i = 0; i < oldSH.length; i++) {
    diff += Math.abs(newSH[i] - oldSH[i]);
    norm += Math.abs(oldSH[i]) + 1e-3;
  }
  return diff / norm;
}
