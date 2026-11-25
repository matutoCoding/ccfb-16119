// 由空间模型构建三角面网格 + 材质。CPU 光线求交与 GPU BVH 打包共用同一份数据。
import type { Space, SceneObj, TubeInstance, TubeParamTable } from './types';
import type { Vec3 } from './math3d';
import { mat4RotationY, mat4Translation, mat4Multiply, transformPoint } from './math3d';

export interface Material {
  name: string;
  /** 反照率 0~1（线性） */
  albedo: Vec3;
  /** 反射率（标量，用于能量校核） */
  reflectance: number;
  kind: 'diffuse' | 'emitter' | 'glass';
  /** 发射辐亮度系数（emitter） */
  emission?: Vec3;
  /** 玻璃透射比 */
  transmittance?: number;
}

export interface Triangle {
  v0: Vec3;
  v1: Vec3;
  v2: Vec3;
  normal: Vec3;
  mat: number;
}

export interface TubeLight {
  id: string;
  position: Vec3; // 漫射器中心（发光面）
  /** 朝下的发光面尺寸（近似方形边长 m） */
  size: Vec3;
  fluxLumens: number;
  /** 配光指数：lambert=1, wide=0.7?, narrow=2 */
  exponent: number;
  diffuserId: string;
}

export interface SceneMesh {
  triangles: Triangle[];
  materials: Material[];
  lights: TubeLight[];
  min: Vec3;
  max: Vec3;
}

const EPS = 1e-4;

function addTriangle(
  tris: Triangle[],
  a: Vec3,
  b: Vec3,
  c: Vec3,
  n: Vec3,
  mat: number,
  M?: Float32Array,
): void {
  if (M) {
    a = transformPoint(M, a);
    b = transformPoint(M, b);
    c = transformPoint(M, c);
  }
  tris.push({ v0: a, v1: b, v2: c, normal: n, mat });
}

/** 添加一个轴对齐/经 M 变换的盒体（中心 cx,cy,cz，全尺寸 sx,sy,sz） */
export function addBox(
  tris: Triangle[],
  cx: number,
  cy: number,
  cz: number,
  sx: number,
  sy: number,
  sz: number,
  mat: number,
  rotY = 0,
): void {
  const M = mat4Multiply(mat4Translation(cx, cy, cz), mat4RotationY(rotY));
  const x = sx / 2,
    y = sy / 2,
    z = sz / 2;
  // 8 角（局部）
  const p: Vec3[] = [
    [-x, -y, -z],
    [x, -y, -z],
    [x, y, -z],
    [-x, y, -z],
    [-x, -y, z],
    [x, -y, z],
    [x, y, z],
    [-x, y, z],
  ];
  const W = (i: number): Vec3 => transformPoint(M, p[i]);
  // 各面（逆时针，外法线）
  const faces: [number, number, number, Vec3][] = [
    [1, 5, 6, [1, 0, 0]], // +X
    [1, 6, 2, [1, 0, 0]],
    [0, 3, 7, [-1, 0, 0]], // -X
    [0, 7, 4, [-1, 0, 0]],
    [4, 7, 6, [0, 0, 1]], // +Z
    [4, 6, 5, [0, 0, 1]],
    [0, 1, 2, [0, 0, -1]], // -Z
    [0, 2, 3, [0, 0, -1]],
    [3, 2, 6, [0, 1, 0]], // +Y top
    [3, 6, 7, [0, 1, 0]],
    [0, 4, 5, [0, -1, 0]], // -Y bottom
    [0, 5, 1, [0, -1, 0]],
  ];
  // 旋转法线
  const c = Math.cos(rotY),
    s = Math.sin(rotY);
  for (const [a, b, cc, n0] of faces) {
    const n: Vec3 = [n0[0] * c + n0[2] * s, n0[1], -n0[0] * s + n0[2] * c];
    addTriangle(tris, W(a), W(b), W(cc), n, mat);
  }
}

/** 水平/竖直四边形 */
function addQuad(
  tris: Triangle[],
  a: Vec3,
  b: Vec3,
  c: Vec3,
  d: Vec3,
  n: Vec3,
  mat: number,
): void {
  addTriangle(tris, a, b, c, n, mat);
  addTriangle(tris, a, c, d, n, mat);
}

function tint(r: number, g: number, b: number, k: number): Vec3 {
  return [
    Math.min(1, r * k),
    Math.min(1, g * k),
    Math.min(1, b * k),
  ];
}

/** 由空间 + 方案管道构建网格。exteriorLux 用于确定发光面通量。 */
export function buildSceneMesh(
  space: Space,
  tubes: TubeInstance[],
  tables: TubeParamTable[],
  exteriorLux: number,
): SceneMesh {
  const tris: Triangle[] = [];
  const R = space.reflectance;
  const mats: Material[] = [
    { name: '地面', albedo: tint(0.82, 0.83, 0.85, R.floor / 0.55), reflectance: R.floor, kind: 'diffuse' },
    { name: '墙面', albedo: tint(0.93, 0.92, 0.88, R.wall / 0.8), reflectance: R.wall, kind: 'diffuse' },
    { name: '顶棚', albedo: tint(0.95, 0.95, 0.94, R.ceiling / 0.85), reflectance: R.ceiling, kind: 'diffuse' },
    { name: '货架', albedo: tint(0.72, 0.55, 0.38, R.shelf / 0.5), reflectance: R.shelf, kind: 'diffuse' },
    { name: '玻璃', albedo: [0.8, 0.9, 0.95], reflectance: 0.08, kind: 'glass', transmittance: 0.7 },
    { name: '漫射器发光面', albedo: [0.9, 0.9, 0.86], reflectance: 0.2, kind: 'emitter', emission: [1, 0.96, 0.88] },
    { name: '柱/梁', albedo: [0.78, 0.78, 0.8], reflectance: 0.5, kind: 'diffuse' },
  ];
  const MAT_FLOOR = 0,
    MAT_WALL = 1,
    MAT_CEIL = 2,
    MAT_SHELF = 3,
    MAT_GLASS = 4,
    MAT_EMIT = 5,
    MAT_CONC = 6;

  const W = space.width;
  const D = space.depth;
  const H = space.height;
  const t = 0.2; // 墙厚

  // 地面 / 顶棚（双面：地面法线朝上，顶棚朝下）
  addQuad(
    tris,
    [-W / 2, 0, -D / 2],
    [-W / 2, 0, D / 2],
    [W / 2, 0, D / 2],
    [W / 2, 0, -D / 2],
    [0, 1, 0],
    MAT_FLOOR,
  );
  addQuad(
    tris,
    [-W / 2, H, -D / 2],
    [W / 2, H, -D / 2],
    [W / 2, H, D / 2],
    [-W / 2, H, D / 2],
    [0, -1, 0],
    MAT_CEIL,
  );

  // ---- 外墙（带窗洞）----
  const windows = space.objects.filter((o) => o.kind === 'window') as Extract<
    SceneObj,
    { kind: 'window' }
  >[];

  interface Opening {
    c: number;
    w: number;
    sill: number;
    h: number;
  }
  const openingsFor = (wall: string): Opening[] =>
    windows
      .filter((wn) => wn.wall === wall)
      .map((wn) => {
        // 沿墙方向中心
        const c = wall === 'north' || wall === 'south' ? wn.x : wn.z;
        return { c, w: wn.width, sill: wn.sill, h: wn.height };
      });

  // 沿 U 轴布墙；fixed 为固定坐标，axis 'x' 表示墙沿 X（南北墙），'z' 表示沿 Z
  const buildWall = (
    axis: 'x' | 'z',
    fixed: number,
    length: number,
    openings: Opening[],
  ): void => {
    const half = length / 2;
    // 合并沿 U 的开洞区间
    const intervals = openings
      .map((o) => ({ lo: Math.max(-half, o.c - o.w / 2), hi: Math.min(half, o.c + o.w / 2), o }))
      .filter((v) => v.hi > v.lo)
      .sort((a, b) => a.lo - b.lo);

    const box = (uCenter: number, uLen: number, y0: number, y1: number): void => {
      if (uLen <= EPS || y1 - y0 <= EPS) return;
      const yc = (y0 + y1) / 2;
      if (axis === 'x') addBox(tris, uCenter, yc, fixed, uLen, y1 - y0, t, MAT_WALL);
      else addBox(tris, fixed, yc, uCenter, t, y1 - y0, uLen, MAT_WALL);
    };

    let cursor = -half;
    for (const it of intervals) {
      if (it.lo > cursor) box((cursor + it.lo) / 2, it.lo - cursor, 0, H); // 全高墙垛
      // 窗下 / 窗上
      box(it.o.c, it.hi - it.lo, 0, Math.min(it.o.sill, H));
      box(it.o.c, it.hi - it.lo, Math.min(it.o.sill + it.o.h, H), H);
      cursor = Math.max(cursor, it.hi);
    }
    if (cursor < half) box((cursor + half) / 2, half - cursor, 0, H);

    // 玻璃
    for (const o of openings) {
      const y0 = o.sill,
        y1 = Math.min(o.sill + o.h, H);
      if (y1 <= y0) continue;
      const u0 = o.c - o.w / 2,
        u1 = o.c + o.w / 2;
      if (axis === 'x') {
        // 竖直四边形，法线朝室内（按 fixed 方向）
        const n: Vec3 = fixed < 0 ? [0, 0, 1] : [0, 0, -1];
        addQuad(
          tris,
          [u0, y0, fixed],
          [u1, y0, fixed],
          [u1, y1, fixed],
          [u0, y1, fixed],
          n,
          MAT_GLASS,
        );
      } else {
        const n: Vec3 = fixed < 0 ? [1, 0, 0] : [-1, 0, 0];
        addQuad(
          tris,
          [fixed, y0, u0],
          [fixed, y0, u1],
          [fixed, y1, u1],
          [fixed, y1, u0],
          n,
          MAT_GLASS,
        );
      }
    }
  };

  buildWall('x', -D / 2, W, openingsFor('south')); // z-
  buildWall('x', D / 2, W, openingsFor('north')); // z+
  buildWall('z', -W / 2, D, openingsFor('west')); // x-
  buildWall('z', W / 2, D, openingsFor('east')); // x+

  // ---- 柱网（仅内部交点，边界由外墙承担）----
  const g = space.grid;
  if (g.columns) {
    const totalX = g.baysX * g.spanX;
    const totalZ = g.baysZ * g.spanZ;
    const x0 = -totalX / 2;
    const z0 = -totalZ / 2;
    for (let ix = 1; ix < g.baysX; ix++) {
      for (let iz = 1; iz < g.baysZ; iz++) {
        addBox(
          tris,
          x0 + ix * g.spanX,
          H / 2,
          z0 + iz * g.spanZ,
          g.columnSize,
          H,
          g.columnSize,
          MAT_CONC,
        );
      }
    }
  }

  // ---- 对象 ----
  for (const o of space.objects) {
    switch (o.kind) {
      case 'shelf': {
        // 四立柱 + 层板
        const post = 0.06;
        const hx = o.length / 2 - post / 2;
        const hz = o.depth / 2 - post / 2;
        for (const sx of [-1, 1])
          for (const sz of [-1, 1])
            addBox(
              tris,
              o.x + sx * hx,
              o.height / 2,
              o.z + sz * hz,
              post,
              o.height,
              post,
              MAT_SHELF,
              o.rotation,
            );
        const boardT = 0.05;
        for (let lv = 0; lv <= o.levels; lv++) {
          const y = 0.1 + (lv * (o.height - 0.2)) / Math.max(1, o.levels);
          addBox(tris, o.x, y, o.z, o.length, boardT, o.depth, MAT_SHELF, o.rotation);
        }
        // 顶部纵梁/横撑
        addBox(tris, o.x, o.height - 0.05, o.z, o.length, 0.08, 0.08, MAT_SHELF, o.rotation);
        break;
      }
      case 'partition': {
        addBox(
          tris,
          o.x,
          o.height / 2,
          o.z,
          o.length,
          o.height,
          o.thickness,
          MAT_WALL,
          o.rotation,
        );
        break;
      }
      case 'beam': {
        addBox(
          tris,
          o.x,
          H - o.drop / 2,
          o.z,
          o.length,
          o.drop,
          o.width,
          MAT_CONC,
          o.rotation,
        );
        break;
      }
      case 'column': {
        addBox(tris, o.x, o.height / 2, o.z, o.size, o.height, o.size, MAT_CONC, o.rotation);
        break;
      }
      case 'window':
        break; // 已在外墙处理
    }
  }

  // ---- 导光管漫射器（发光面）+ 光源 ----
  const lights: TubeLight[] = [];
  for (const tube of tubes) {
    if (!tube.enabled) continue;
    const table = tables.find((t) => t.id === tube.tableId);
    const flux = computeTubeFlux(tube, table, exteriorLux);
    const size = tube.diameter / 1000;
    // 发光四边形（朝下），略低于顶棚
    const y = H - 0.02;
    const hs = size / 2;
    addQuad(
      tris,
      [tube.x - hs, y, tube.z - hs],
      [tube.x - hs, y, tube.z + hs],
      [tube.x + hs, y, tube.z + hs],
      [tube.x + hs, y, tube.z - hs],
      [0, -1, 0],
      MAT_EMIT,
    );
    const dist = table?.diffusers.find((d) => d.id === tube.diffuserId)?.distribution ?? 'lambert';
    const exponent = dist === 'narrow' ? 2.2 : dist === 'wide' ? 0.65 : 1.0;
    lights.push({
      id: tube.id,
      position: [tube.x, y - 0.05, tube.z],
      size: [size, 0.05, size],
      fluxLumens: flux,
      exponent,
      diffuserId: tube.diffuserId,
    });
  }

  // 包围盒
  let min: Vec3 = [Infinity, Infinity, Infinity];
  let max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const tr of tris) {
    for (const v of [tr.v0, tr.v1, tr.v2]) {
      min = [Math.min(min[0], v[0]), Math.min(min[1], v[1]), Math.min(min[2], v[2])];
      max = [Math.max(max[0], v[0]), Math.max(max[1], v[1]), Math.max(max[2], v[2])];
    }
  }
  if (!isFinite(min[0])) {
    min = [-W / 2, 0, -D / 2];
    max = [W / 2, H, D / 2];
  }
  return { triangles: tris, materials: mats, lights, min, max };
}

/** 查厂家参数表，计算一根导光管输出光通量 lm */
export function computeTubeFlux(
  tube: TubeInstance,
  table: TubeParamTable | undefined,
  exteriorHorizontalLux: number,
): number {
  const D = tube.diameter / 1000;
  const captureArea = Math.PI * (D / 2) * (D / 2);
  // 采光罩入口光通量 = 室外水平面照度 × 集光面积（采光罩近似水平集光）
  let fluxIn = exteriorHorizontalLux * captureArea;

  let domeT = 0.92;
  let diffT = 0.86;
  let maint = 0.9;
  let elbowF = 0.92;
  let tubeEff = 0.9;

  if (table) {
    const dome = table.domes.find((d) => d.id === tube.domeId);
    const diff = table.diffusers.find((d) => d.id === tube.diffuserId);
    if (dome) domeT = dome.transmittance;
    if (diff) diffT = diff.transmittance;
    maint = table.maintenanceFactor;
    elbowF = table.elbowFactor;
    const series = table.transmission[String(tube.diameter)];
    if (series && series.length) {
      tubeEff = interpEfficiency(series, tube.length);
    } else {
      // 无表时按管壁反射率经验：每次反射损失，长径比估算反射次数
      const rho = 0.995;
      const reflections = Math.max(1, Math.round((tube.length / D) * 0.9));
      tubeEff = Math.pow(rho, reflections);
    }
  }

  const elbowEff = Math.pow(elbowF, tube.elbows);
  const fluxOut = fluxIn * domeT * tubeEff * elbowEff * diffT * maint;
  return Math.max(0, fluxOut);
}

export function interpEfficiency(
  series: { length: number; efficiency: number }[],
  length: number,
): number {
  const s = [...series].sort((a, b) => a.length - b.length);
  if (length <= s[0].length) return s[0].efficiency;
  if (length >= s[s.length - 1].length) {
    // 外推：用最后两点的对数斜率，限制不低于 0.2
    const a = s[s.length - 2] ?? s[s.length - 1];
    const b = s[s.length - 1];
    const k = Math.log(b.efficiency / a.efficiency) / Math.max(1e-3, b.length - a.length);
    return Math.max(0.2, b.efficiency * Math.exp(k * (length - b.length)));
  }
  for (let i = 0; i < s.length - 1; i++) {
    if (length >= s[i].length && length <= s[i + 1].length) {
      const t = (length - s[i].length) / (s[i + 1].length - s[i].length);
      // 在对数域插值更符合指数衰减
      const le0 = Math.log(Math.max(1e-4, s[i].efficiency));
      const le1 = Math.log(Math.max(1e-4, s[i + 1].efficiency));
      return Math.exp(le0 + (le1 - le0) * t);
    }
  }
  return s[s.length - 1].efficiency;
}

/** 供 UI 预览：返回各环节效率 */
export function tubeLossBreakdown(
  tube: TubeInstance,
  table: TubeParamTable | undefined,
): { label: string; factor: number }[] {
  let domeT = 0.92,
    diffT = 0.86,
    maint = 0.9,
    elbowF = 0.92,
    tubeEff = 0.9;
  if (table) {
    domeT = table.domes.find((d) => d.id === tube.domeId)?.transmittance ?? domeT;
    diffT = table.diffusers.find((d) => d.id === tube.diffuserId)?.transmittance ?? diffT;
    maint = table.maintenanceFactor;
    elbowF = table.elbowFactor;
    const series = table.transmission[String(tube.diameter)];
    if (series?.length) tubeEff = interpEfficiency(series, tube.length);
  }
  return [
    { label: '采光罩透射', factor: domeT },
    { label: '管段沿程传输', factor: tubeEff },
    { label: `弯头×${tube.elbows}`, factor: Math.pow(elbowF, tube.elbows) },
    { label: '漫射器透射', factor: diffT },
    { label: '维护系数', factor: maint },
  ];
}
