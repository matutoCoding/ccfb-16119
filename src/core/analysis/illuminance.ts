import type { Project } from '../../types';

// 工作面照度网格统计、等照度线、采光标准判定、全年 8760 小时估算。

export interface IlluminanceStats {
  avg: number;
  min: number;
  max: number;
  uniformity: number; // min/avg
  area: number;       // 工作面面积 m²
  compliantArea: number;
  complianceRatio: number; // 达标面积比例
  belowCells: [number, number][]; // 不达标网格坐标（供伪彩图圈选）
}

export function computeStats(
  grid: Float32Array, // 行优先 lux
  nx: number,
  nz: number,
  cellArea: number,
  thresholdLux: number,
): IlluminanceStats {
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  const belowCells: [number, number][] = [];
  for (let z = 0; z < nz; z++) {
    for (let x = 0; x < nx; x++) {
      const v = grid[z * nx + x];
      sum += v;
      min = Math.min(min, v);
      max = Math.max(max, v);
      if (v < thresholdLux) belowCells.push([x, z]);
    }
  }
  const count = nx * nz;
  const avg = sum / count;
  return {
    avg,
    min: isFinite(min) ? min : 0,
    max,
    uniformity: avg > 0 ? min / avg : 0,
    area: count * cellArea,
    compliantArea: (count - belowCells.length) * cellArea,
    complianceRatio: (count - belowCells.length) / count,
    belowCells,
  };
}

/** Marching squares 提取等照度线，返回线段数组（归一化 0..1 坐标） */
export function isolines(
  grid: Float32Array,
  nx: number,
  nz: number,
  level: number,
): [number, number, number, number][] {
  const segs: [number, number, number, number][] = [];
  const at = (x: number, z: number) => grid[z * nx + x];
  const interp = (a: number, b: number) => (level - a) / (b - a || 1e-9);
  for (let z = 0; z < nz - 1; z++) {
    for (let x = 0; x < nx - 1; x++) {
      const tl = at(x, z);
      const tr = at(x + 1, z);
      const br = at(x + 1, z + 1);
      const bl = at(x, z + 1);
      const idx = (tl > level ? 1 : 0) | (tr > level ? 2 : 0) |
        (br > level ? 4 : 0) | (bl > level ? 8 : 0);
      if (idx === 0 || idx === 15) continue;
      // 四边中点参数
      const pts: Record<number, [number, number]> = {
        0: [x + interp(tl, tr), z],
        1: [x + 1, z + interp(tr, br)],
        2: [x + interp(bl, br), z + 1],
        3: [x, z + interp(tl, bl)],
      };
      const edges: Record<number, [number, number][]> = {
        1: [pts[3], pts[0]], 2: [pts[0], pts[1]], 3: [pts[3], pts[1]],
        4: [pts[1], pts[2]], 5: [[pts[3][0], pts[3][1]], [pts[0][0], pts[0][1]]],
        6: [pts[0], pts[2]], 7: [pts[3], pts[2]],
        8: [pts[2], pts[3]], 9: [pts[2], pts[0]],
        10: [[pts[0][0], pts[0][1]], [pts[1][0], pts[1][1]]],
        11: [pts[1], pts[2]], 12: [pts[1], pts[3]],
        13: [pts[0], pts[1]], 14: [pts[3], pts[0]],
      };
      const pairs = edges[idx] ?? [];
      // 鞍点 5/10 两条线
      const push = (p: [number, number], q: [number, number]) =>
        segs.push([p[0] / (nx - 1), p[1] / (nz - 1), q[0] / (nx - 1), q[1] / (nz - 1)]);
      if (idx === 5 || idx === 10) {
        push(pts[3], pts[0]);
        push(pts[1], pts[2]);
      } else if (pairs.length === 2) {
        push(pairs[0], pairs[1]);
      }
    }
  }
  return segs;
}

export interface AnnualResult {
  totalDaylightHours: number; // 采光达标小时数（工作时段）
  evaluatedHours: number;
  savedElectricHours: number; // 可关闭电气照明的估算小时
  monthly: { month: number; hours: number }[];
  avgCompliance: number;
}

export interface DaylightEvaluator {
  /** 给定日期/小时返回工作面平均照度（由仿真层注入） */
  evaluate: (date: string, hour: number) => number;
  workStart: number;
  workEnd: number;
  thresholdLux: number;
}

/** 全年逐时（工作日 8:00-18:00）跑评估器 */
export function annualDaylight(project: Project, ev: DaylightEvaluator): AnnualResult {
  const monthly = Array.from({ length: 12 }, (_, m) => ({ month: m + 1, hours: 0 }));
  let total = 0;
  let evaluated = 0;
  let complianceSum = 0;
  const year = Number(project.sky.date.split('-')[0]);
  for (let month = 1; month <= 12; month++) {
    const days = new Date(year, month, 0).getDate();
    for (let day = 1; day <= days; day++) {
      const dow = new Date(year, month - 1, day).getDay();
      if (dow === 0 || dow === 6) continue;
      const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      for (let h = ev.workStart; h < ev.workEnd; h++) {
        const lux = ev.evaluate(date, h + 0.5);
        evaluated++;
        if (lux >= ev.thresholdLux) {
          total++;
          monthly[month - 1].hours++;
        }
        complianceSum += Math.min(1, lux / ev.thresholdLux);
      }
    }
  }
  return {
    totalDaylightHours: total,
    evaluatedHours: evaluated,
    savedElectricHours: total,
    monthly,
    avgCompliance: evaluated ? complianceSum / evaluated : 0,
  };
}

/** 伪彩色映射（蓝→青→绿→黄→红），输入归一化照度 */
export function falseColor(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t));
  const stops: [number, [number, number, number]][] = [
    [0.0, [0.08, 0.12, 0.55]],
    [0.25, [0.1, 0.6, 0.85]],
    [0.5, [0.25, 0.8, 0.35]],
    [0.75, [0.95, 0.85, 0.2]],
    [1.0, [0.9, 0.15, 0.1]],
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i];
    const [t1, c1] = stops[i + 1];
    if (x <= t1) {
      const k = (x - t0) / (t1 - t0);
      return [
        c0[0] + (c1[0] - c0[0]) * k,
        c0[1] + (c1[1] - c0[1]) * k,
        c0[2] + (c1[2] - c0[2]) * k,
      ];
    }
  }
  return stops[stops.length - 1][1];
}
