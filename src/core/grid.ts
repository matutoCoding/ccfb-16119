// 探针网格布置 + 工作面网格统计 + 平滑 + 等照度线提取
import type { IlluminanceGrid, GridStats } from './types';
import { clamp } from './util';

export interface ProbeLayout {
  nx: number;
  ny: number;
  nz: number;
  spacingX: number;
  spacingY: number;
  spacingZ: number;
  positions: Float32Array; // xyz * count
  count: number;
  origin: [number, number, number];
}

/**
 * 在室内按间距布 3D 探针。为保证厂房约 200 个，自动按目标上限微调。
 * 探针在 XZ 平面铺满，Y 方向按高度分 1~3 层。
 */
export function buildProbeLayout(
  width: number,
  depth: number,
  height: number,
  requestedSpacing: number,
  maxProbes = 256,
): ProbeLayout {
  let spacing = requestedSpacing;
  // Y 层数
  const ny = height > 6 ? 2 : 1;
  const yPositions: number[] = [];
  if (ny === 1) yPositions.push(clamp(height * 0.55, 1.2, height - 0.6));
  else {
    yPositions.push(1.4, Math.min(height - 1.2, height * 0.62));
  }

  const compute = (sp: number) => {
    const nx = Math.max(2, Math.round(width / sp) + 1);
    const nz = Math.max(2, Math.round(depth / sp) + 1);
    return { nx, nz };
  };
  let { nx, nz } = compute(spacing);
  while (nx * nz * ny > maxProbes && spacing < 12) {
    spacing *= 1.12;
    ({ nx, nz } = compute(spacing));
  }
  // 边距 0.6m，避免探针穿墙
  const margin = 0.8;
  const usableW = width - margin * 2;
  const usableD = depth - margin * 2;
  const sx = nx > 1 ? usableW / (nx - 1) : 0;
  const sz = nz > 1 ? usableD / (nz - 1) : 0;
  const origin: [number, number, number] = [-width / 2 + margin, 0, -depth / 2 + margin];

  const count = nx * nz * ny;
  const positions = new Float32Array(count * 3);
  let k = 0;
  for (let iy = 0; iy < ny; iy++) {
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        positions[k * 3 + 0] = origin[0] + ix * sx;
        positions[k * 3 + 1] = yPositions[iy];
        positions[k * 3 + 2] = origin[2] + iz * sz;
        k++;
      }
    }
  }
  return {
    nx,
    ny,
    nz,
    spacingX: sx,
    spacingY: ny > 1 ? yPositions[1] - yPositions[0] : height,
    spacingZ: sz,
    positions,
    count,
    origin,
  };
}

export function computeStats(
  values: Float32Array,
  deficient: Uint8Array,
  cols: number,
  rows: number,
  cellArea: number,
  standardAvg: number,
  mask?: Uint8Array,
): GridStats {
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  let defCells = 0;
  let eligible = 0;
  const n = values.length;
  for (let i = 0; i < n; i++) {
    if (mask && mask[i]) continue;
    eligible++;
    const v = values[i];
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
    if (deficient[i]) defCells++;
  }
  const avg = sum / Math.max(1, eligible);
  return {
    avg,
    min: isFinite(min) ? min : 0,
    max: isFinite(max) ? max : 0,
    uniformity: avg > 0 ? min / avg : 0,
    uniformityMax: max > 0 ? min / max : 0,
    compliantAreaRatio: 1 - defCells / Math.max(1, eligible),
    stdAvg: standardAvg,
  };
}

/** 3×3 可分离平滑，降低蒙特卡洛噪点；保持均值近似 */
export function smoothGrid(values: Float32Array, cols: number, rows: number, passes = 1): Float32Array {
  let src = values;
  for (let p = 0; p < passes; p++) {
    const tmp = new Float32Array(src.length);
    const dst = new Float32Array(src.length);
    // 水平 [1,2,1]/4
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const c0 = Math.max(0, c - 1);
        const c2 = Math.min(cols - 1, c + 1);
        const i = r * cols + c;
        tmp[i] = (src[r * cols + c0] + 2 * src[i] + src[r * cols + c2]) / 4;
      }
    }
    // 垂直
    for (let r = 0; r < rows; r++) {
      const r0 = Math.max(0, r - 1);
      const r2 = Math.min(rows - 1, r + 1);
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        dst[i] = (tmp[r0 * cols + c] + 2 * tmp[i] + tmp[r2 * cols + c]) / 4;
      }
    }
    src = dst;
  }
  return src;
}

/** marching squares 提取等值线，返回线段数组（网格坐标） */
export interface IsoSegment {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  level: number;
}

export function extractIsolines(grid: IlluminanceGrid, levels: number[]): IsoSegment[] {
  const { cols, rows, values, x0, z0, dx, dz } = grid;
  const segs: IsoSegment[] = [];
  for (const level of levels) {
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const i00 = r * cols + c;
        const i10 = i00 + 1;
        const i01 = i00 + cols;
        const i11 = i01 + 1;
        const v00 = values[i00];
        const v10 = values[i10];
        const v01 = values[i01];
        const v11 = values[i11];
        let idx = 0;
        if (v00 > level) idx |= 1;
        if (v10 > level) idx |= 2;
        if (v11 > level) idx |= 4;
        if (v01 > level) idx |= 8;
        if (idx === 0 || idx === 15) continue;

        const x = (cc: number) => x0 + cc * dx;
        const z = (rr: number) => z0 + rr * dz;
        // 边插值点（top 00-10, right 10-11, bottom 01-11, left 00-01）
        const interp = (a: number, b: number) => {
          const t = clamp((level - a) / (b - a || 1e-6), 0, 1);
          return t;
        };
        const top = (): [number, number] => [x(c + interp(v00, v10)), z(r)];
        const right = (): [number, number] => [x(c + 1), z(r + interp(v10, v11))];
        const bottom = (): [number, number] => [x(c + interp(v01, v11)), z(r + 1)];
        const left = (): [number, number] => [x(c), z(r + interp(v00, v01))];

        const add = (a: [number, number], b: [number, number]) =>
          segs.push({ x1: a[0], z1: a[1], x2: b[0], z2: b[1], level });

        switch (idx) {
          case 1: case 14: add(left(), top()); break;
          case 2: case 13: add(top(), right()); break;
          case 3: case 12: add(left(), right()); break;
          case 4: case 11: add(right(), bottom()); break;
          case 6: case 9: add(top(), bottom()); break;
          case 7: case 8: add(left(), bottom()); break;
          case 5: add(left(), top()); add(right(), bottom()); break;
          case 10: add(top(), right()); add(left(), bottom()); break;
        }
      }
    }
  }
  return segs;
}

/** 伪彩色带（蓝→青→绿→黄→红），t 0~1，返回 [r,g,b] 0~255 */
export function falseColor(t: number): [number, number, number] {
  t = clamp(t, 0, 1);
  const stops: [number, [number, number, number]][] = [
    [0.0, [20, 40, 120]],
    [0.2, [30, 110, 220]],
    [0.4, [30, 200, 220]],
    [0.6, [60, 220, 120]],
    [0.78, [240, 220, 60]],
    [0.92, [240, 130, 40]],
    [1.0, [220, 40, 40]],
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i];
    const [t1, c1] = stops[i + 1];
    if (t >= t0 && t <= t1) {
      const k = (t - t0) / (t1 - t0);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * k),
        Math.round(c0[1] + (c1[1] - c0[1]) * k),
        Math.round(c0[2] + (c1[2] - c0[2]) * k),
      ];
    }
  }
  return [220, 40, 40];
}
