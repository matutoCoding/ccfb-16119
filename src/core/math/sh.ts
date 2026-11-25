import type { Vec3 } from '../../types';
import { v3 } from './vec3';

// 球谐函数（L1+L2，共 9 系数），方向约定 y 向上
// 系数带归一化基函数积分权重，SH 求值即辐照度积分近似。

const C1 = 0.429043;
const C2 = 0.511664;
const C3 = 0.743125;
const C4 = 0.886227;
const C5 = 0.247708;

export const SH_COUNT = 9;

export type SH9 = Float32Array; // 长度 9（单色）；RGB 时每通道一组

export function shBasis(dir: Vec3): Float32Array {
  const [x, y, z] = dir;
  const b = new Float32Array(9);
  b[0] = C4;
  b[1] = 2 * C2 * y;
  b[2] = 2 * C2 * z;
  b[3] = 2 * C2 * x;
  b[4] = 2 * C1 * x * y;
  b[5] = 2 * C1 * y * z;
  b[6] = 2 * C1 * (3 * z * z - 1);
  b[7] = 2 * C1 * x * z;
  b[8] = C1 * (x * x - y * y);
  return b;
}

export function shProjectColor(samples: { dir: Vec3; value: Vec3 }[]): Float32Array {
  // 返回 27 个系数：r0..r8,g0..g8,b0..b8，蒙特卡洛投影（球面积 4π）
  const out = new Float32Array(SH_COUNT * 3);
  const weight = (4 * Math.PI) / Math.max(1, samples.length);
  for (const s of samples) {
    const b = shBasis(s.dir);
    for (let k = 0; k < SH_COUNT; k++) {
      out[k] += b[k] * s.value[0] * weight;
      out[SH_COUNT + k] += b[k] * s.value[1] * weight;
      out[2 * SH_COUNT + k] += b[k] * s.value[2] * weight;
    }
  }
  return out;
}

export function shProjectMono(samples: { dir: Vec3; value: number }[], hemiSphere = false): SH9 {
  const out = new Float32Array(SH_COUNT);
  // 半球采样时立体角测度为 2π，全球为 4π
  const weight = (hemiSphere ? 2 * Math.PI : 4 * Math.PI) / Math.max(1, samples.length);
  for (const s of samples) {
    const b = shBasis(s.dir);
    for (let k = 0; k < SH_COUNT; k++) out[k] += b[k] * s.value * weight;
  }
  return out;
}

/** 由 SH 系数求某方向辐照度（单色） */
export function shEvalMono(coeffs: SH9, dir: Vec3): number {
  const b = shBasis(dir);
  let s = 0;
  for (let k = 0; k < SH_COUNT; k++) s += coeffs[k] * b[k];
  return s;
}

/** 由 RGB SH（27 系数）求某方向颜色 */
export function shEvalColor(coeffs: Float32Array, dir: Vec3): Vec3 {
  const b = shBasis(dir);
  const r = [0, 0, 0] as Vec3;
  for (let k = 0; k < SH_COUNT; k++) {
    r[0] += coeffs[k] * b[k];
    r[1] += coeffs[SH_COUNT + k] * b[k];
    r[2] += coeffs[2 * SH_COUNT + k] * b[k];
  }
  return r;
}

export function shAccumMono(acc: SH9, dir: Vec3, value: number, weight: number): void {
  const b = shBasis(dir);
  for (let k = 0; k < SH_COUNT; k++) acc[k] += b[k] * value * weight;
}

/** 余弦卷积（辐射度 SH → 辐照度 SH），用于直接光注入 */
export function shConvolution(filter: number[]): number[] {
  // 标准 A 项（带与上面基函数匹配的归一化）
  const A = [Math.PI, (2 * Math.PI) / 3, Math.PI / 4];
  return filter.map((f, i) => {
    const band = i === 0 ? 0 : i <= 3 ? 1 : 2;
    return f * A[band];
  });
}

export function shMaxDir(coeffs: SH9): Vec3 {
  // 数值搜索 SH 最大方向（用于眩光/过亮方向判断）
  let best: Vec3 = [0, 1, 0];
  let bestV = -Infinity;
  const N = 24;
  for (let i = 0; i < N; i++) {
    const theta = (i / N) * Math.PI;
    for (let j = 0; j < 2 * N; j++) {
      const phi = (j / (2 * N)) * Math.PI * 2;
      const d: Vec3 = [
        Math.sin(theta) * Math.cos(phi),
        Math.cos(theta),
        Math.sin(theta) * Math.sin(phi),
      ];
      const v = shEvalMono(coeffs, d);
      if (v > bestV) {
        bestV = v;
        best = d;
      }
    }
  }
  return best;
}

export { v3 };
