// 方案 -> 场景/BVH/室外照度 -> 工作面照度网格（CPU 精算，确定性）
import type { Project, Scheme, TubeParamTable, IlluminanceGrid } from './types';
import { buildSceneMesh, type SceneMesh } from './geometry';
import { buildBVH, type BVH } from './bvh';
import { exteriorIlluminance, makeSkyEnv, type ExteriorLight } from './sky';
import { estimateIrradiance } from './integrator';
import { computeStats, smoothGrid } from './grid';

export interface BuiltScene {
  mesh: SceneMesh;
  bvh: BVH;
  ext: ExteriorLight;
  exteriorLux: number;
}

export function buildProjectScene(
  project: Project,
  scheme: Scheme,
  tables: TubeParamTable[],
  exteriorOverride?: number,
): BuiltScene {
  const sky = { ...project.sky };
  if (exteriorOverride !== undefined) sky.overrideExteriorLux = exteriorOverride;
  const ext = exteriorIlluminance(sky);
  const exteriorLux = ext.horizontalLux;
  const mesh = buildSceneMesh(project.space, scheme.tubes, tables, exteriorLux);
  const bvh = buildBVH(mesh, 4);
  return { mesh, bvh, ext, exteriorLux };
}

export interface SolveOptions {
  /** 长边网格数 */
  resolution?: number;
  samples?: number;
  bounces?: number;
  smoothing?: number;
  useSky?: boolean;
  onProgress?: (p: number, label?: string) => void;
  /** 每处理多少行让出主线程 */
  yieldEveryRows?: number;
}

const nextFrame = () => new Promise((r) => setTimeout(r, 0));

export async function solveWorkplane(
  built: BuiltScene,
  project: Project,
  opts: SolveOptions = {},
): Promise<IlluminanceGrid> {
  const t0 = performance.now();
  const { space, standard } = project;
  const longRes = opts.resolution ?? 72;
  const samples = opts.samples ?? 24;
  const W = space.width;
  const D = space.depth;
  const cols = longRes;
  const rows = Math.max(8, Math.round((longRes * D) / W));
  const x0 = -W / 2;
  const z0 = -D / 2;
  const dx = W / cols;
  const dz = D / rows;
  const values = new Float32Array(cols * rows);

  const env = opts.useSky === false ? null : makeSkyEnv(project.sky, built.ext);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = x0 + (c + 0.5) * dx;
      const z = z0 + (r + 0.5) * dz;
      const p: [number, number, number] = [x, space.workPlaneHeight, z];
      // 若点位于货架实体内部，给出降低值（货架内部非工作面），仍计算
      const seed = (r * cols + c + 1) * 2654435761;
      const e = estimateIrradiance(
        built.mesh,
        built.bvh,
        p,
        [0, 1, 0],
        { samples, bounces: 4, env },
        seed >>> 0,
      );
      values[r * cols + c] = e;
    }
    if (r % (opts.yieldEveryRows ?? 2) === 0) {
      opts.onProgress?.(r / rows, `工作面光线积分 ${Math.round((r / rows) * 100)}%`);
      await nextFrame();
    }
  }

  const passes = opts.smoothing ?? 1;
  const smoothed = smoothGrid(values, cols, rows, passes);

  // 货架占地掩膜：这些格点属于储物区而非通行/工作面，不参与照度指标
  const masked = new Uint8Array(cols * rows);
  const shelves = space.objects.filter((o) => o.kind === 'shelf');
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = x0 + (c + 0.5) * dx;
      const z = z0 + (r + 0.5) * dz;
      if (insideAnyShelf(x, z, shelves as Extract<(typeof space.objects)[number], { kind: 'shelf' }>[])) {
        masked[r * cols + c] = 1;
      }
    }
  }

  const deficient = new Uint8Array(cols * rows);
  for (let i = 0; i < smoothed.length; i++) {
    if (masked[i]) continue;
    // 低于平均照度标准即判为不达标区域
    deficient[i] = smoothed[i] < standard.requiredAvg ? 1 : 0;
  }
  const cellArea = dx * dz;
  const stats = computeStats(smoothed, deficient, cols, rows, cellArea, standard.requiredAvg, masked);
  opts.onProgress?.(1, '完成');

  return {
    cols,
    rows,
    x0,
    z0,
    dx,
    dz,
    values: smoothed,
    stats,
    deficient,
    masked,
    probeCount: 0,
    engine: `CPU 路径积分 ×${samples}spp`,
    elapsedMs: performance.now() - t0,
  };
}

/** 点是否落在任一货架占地（含旋转的局部 OBB）内，略微外扩 0.15m */
function insideAnyShelf(
  x: number,
  z: number,
  shelves: Extract<import('./types').SceneObj, { kind: 'shelf' }>[],
): boolean {
  for (const s of shelves) {
    const dx = x - s.x;
    const dz = z - s.z;
    const cos = Math.cos(s.rotation);
    const sin = Math.sin(s.rotation);
    // 逆旋转到货架局部坐标
    const lx = dx * cos + dz * sin;
    const lz = -dx * sin + dz * cos;
    if (Math.abs(lx) <= s.length / 2 + 0.15 && Math.abs(lz) <= s.depth / 2 + 0.15) return true;
  }
  return false;
}

/**
 * 计算采光系数网格（DC = 室内照度 / 室外水平面照度，典型全阴天）。
 * 年度逐时直接用 DC × 逐时室外照度，保证 8760 次飞快。
 */
export async function solveDaylightCoefficient(
  project: Project,
  scheme: Scheme,
  tables: TubeParamTable[],
  onProgress?: (p: number) => void,
): Promise<{ dc: Float32Array; cols: number; rows: number; x0: number; z0: number; dx: number; dz: number; refLux: number }> {
  const REF = 20000;
  const skyBackup = project.sky.type;
  project.sky.type = 'overcast';
  const built = buildProjectScene(project, scheme, tables, REF);
  const grid = await solveWorkplane(built, project, {
    resolution: 56,
    samples: 16,
    smoothing: 1,
    onProgress: (p) => onProgress?.(p * 0.9),
  });
  project.sky.type = skyBackup;
  const dc = new Float32Array(grid.values.length);
  for (let i = 0; i < dc.length; i++) dc[i] = grid.values[i] / REF;
  return { dc, cols: grid.cols, rows: grid.rows, x0: grid.x0, z0: grid.z0, dx: grid.dx, dz: grid.dz, refLux: REF };
}
