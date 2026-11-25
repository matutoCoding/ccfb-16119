// 首次运行的种子数据：默认厂家参数表 + 老厂房(货架) + 地下车库 + 白墙校核间
import type {
  AppSettings,
  LuxStandard,
  Project,
  Scheme,
  Space,
  TubeInstance,
  TubeParamTable,
} from './types';
import { uid } from './util';

export const DEFAULT_SETTINGS: AppSettings = {
  gpuProbesPerFrame: 6,
  probeRays: 48,
  probeResolution: 16,
  heatmapGrid: 72,
  showProbes: true,
  falseColorMaxLux: 600,
  reduceMotion: false,
};

export const STANDARDS: LuxStandard[] = [
  { id: 'gb-warehouse', name: '仓库/库房 GB50034', requiredAvg: 100, uniformity: 0.4, ugrLimit: 25 },
  { id: 'gb-workshop', name: '一般机械加工厂房', requiredAvg: 200, uniformity: 0.6, ugrLimit: 22 },
  { id: 'gb-gym', name: '学校风雨操场', requiredAvg: 300, uniformity: 0.6, ugrLimit: 22 },
  { id: 'gb-garage', name: '地下停车库(车道)', requiredAvg: 75, uniformity: 0.5, ugrLimit: 28 },
  { id: 'gb-office', name: '办公/值班室', requiredAvg: 300, uniformity: 0.6, ugrLimit: 19 },
];

export function defaultParamTable(): TubeParamTable {
  const eff = (pts: [number, number][]): { length: number; efficiency: number }[] =>
    pts.map(([length, efficiency]) => ({ length, efficiency }));
  return {
    id: 'tbl-default-sd',
    name: 'SD 系列高反射导光管参数表',
    vendor: '示例厂家 · 森日光导',
    diameters: [250, 350, 530, 650],
    domes: [
      { id: 'dome-crystal', name: '水晶高透采光罩', transmittance: 0.95 },
      { id: 'dome-std', name: '标准亚克力罩', transmittance: 0.92 },
      { id: 'dome-heat', name: '隔热降噪罩', transmittance: 0.85 },
    ],
    diffusers: [
      { id: 'diff-lambert', name: '朗伯漫射器', transmittance: 0.86, distribution: 'lambert' },
      { id: 'diff-wide', name: '广角柔光漫射器', transmittance: 0.88, distribution: 'wide' },
      { id: 'diff-soft', name: '微晶柔光漫射器', transmittance: 0.8, distribution: 'wide' },
    ],
    transmission: {
      '250': eff([[0.6, 0.95], [1, 0.92], [2, 0.84], [3, 0.77], [4, 0.7], [6, 0.58], [8, 0.48], [12, 0.32]]),
      '350': eff([[0.6, 0.98], [1, 0.96], [2, 0.91], [3, 0.86], [4, 0.81], [6, 0.72], [8, 0.64], [12, 0.5]]),
      '530': eff([[0.6, 0.995], [1, 0.99], [2, 0.965], [3, 0.94], [4, 0.91], [6, 0.85], [8, 0.79], [12, 0.68]]),
      '650': eff([[0.6, 0.998], [1, 0.995], [2, 0.98], [3, 0.965], [4, 0.95], [6, 0.91], [8, 0.87], [12, 0.79]]),
    },
    elbowFactor: 0.92,
    maintenanceFactor: 0.85,
    builtin: true,
  };
}

function tube(
  tableId: string,
  x: number,
  z: number,
  diameter = 530,
  length = 3,
  elbows = 1,
): TubeInstance {
  return {
    id: uid('tube'),
    tableId,
    diameter,
    length,
    elbows,
    domeId: 'dome-crystal',
    diffuserId: 'diff-wide',
    x,
    z,
    rotation: 0,
    enabled: true,
  };
}

/** 老厂房：48×24×8，6×3 跨 ×8m 柱网，货架成排，高侧窗 */
function factorySpace(): Space {
  const objects: Space['objects'] = [];
  // 内柱由柱网自动生成；这里加货架（3 个货架区，每区两排背靠背）
  const rowZs = [-7.5, -4.5, 3.5, 6.5];
  let n = 0;
  for (const z of rowZs) {
    for (let i = 0; i < 6; i++) {
      const x = -20 + i * 8;
      // 避开中柱（柱在 x=-16,-8,0,8,16；货架中心放在跨中 x=-20,-12,... 实际跨中为 -20? 跨边界 -24..24，跨中 -20,-12,-4,4,12,20）
      objects.push({
        id: uid('sh'),
        kind: 'shelf',
        name: `重型货架 ${++n}`,
        x,
        z,
        rotation: 0,
        length: 6.2,
        depth: 1.1,
        height: 5.2,
        levels: 4,
        openness: 0.55,
      });
    }
  }
  // 一道隔墙分出工具间（左端，留 2m 门洞用两段表示）
  objects.push({ id: uid('pt'), kind: 'partition', name: '工具间隔墙-1', x: -23, z: -7, rotation: Math.PI / 2, length: 9, thickness: 0.2, height: 8 });
  objects.push({ id: uid('pt'), kind: 'partition', name: '工具间隔墙-2', x: -23, z: 6.5, rotation: Math.PI / 2, length: 7, thickness: 0.2, height: 8 });
  // 梁：沿 X 方向每跨柱线
  for (let iz = 0; iz <= 3; iz++) {
    const z = -12 + iz * 8;
    objects.push({ id: uid('bm'), kind: 'beam', name: '屋面梁', x: 0, z, rotation: 0, length: 48, width: 0.35, drop: 0.9 });
  }
  // 南北高侧窗
  for (let i = 0; i < 6; i++) {
    const x = -20 + i * 8;
    objects.push({ id: uid('wn'), kind: 'window', name: '南 high-side window', wall: 'south', x, z: -12, width: 5, height: 1.8, sill: 4.6, transmittance: 0.72, rotation: 0 });
    objects.push({ id: uid('wn'), kind: 'window', name: '北 high-side window', wall: 'north', x, z: 12, width: 5, height: 1.8, sill: 4.6, transmittance: 0.72, rotation: 0 });
  }
  return {
    width: 48,
    depth: 24,
    height: 8,
    workPlaneHeight: 0.75,
    grid: { baysX: 6, baysZ: 3, spanX: 8, spanZ: 8, columnSize: 0.5, columns: true },
    reflectance: { wall: 0.72, floor: 0.45, ceiling: 0.78, shelf: 0.5 },
    objects,
  };
}

function factorySchemes(tableId: string): Scheme[] {
  const xs9 = [-21.3, -16, -10.7, -5.3, 0, 5.3, 10.7, 16, 21.3];
  const xs8 = [-21, -15, -9, -3, 3, 9, 15, 21];
  const xs5 = [-21.3, -10.65, 0, 10.65, 21.3];
  const aisleZ6 = [-10.5, -6.3, -2.1, 2.1, 6.3, 10.5];

  const grid = (xx: number[], zz: number[], d: number, len: number, el: number): TubeInstance[] => {
    const out: TubeInstance[] = [];
    for (const z of zz) for (const x of xx) out.push(tube(tableId, x, z, d, len, el));
    return out;
  };

  const a: Scheme = {
    id: uid('sch'), name: '方案A · 30管经济', note: '5×6 均布 DN530，投资省，货架区与端头偏暗',
    createdAt: Date.now(), tubes: grid(xs5, aisleZ6, 530, 4.5, 2),
  };
  const b: Scheme = {
    id: uid('sch'), name: '方案B · 54管推荐', note: '9×6 满布并对齐货架通道，均匀度与达标面积均衡',
    createdAt: Date.now(), tubes: grid(xs9, aisleZ6, 530, 3, 1),
  };
  const c: Scheme = {
    id: uid('sch'), name: '方案C · 48管 DN650 高标', note: '8×6 大管径短管零弯头，通量最高，满足 100lx 且均匀',
    createdAt: Date.now(), tubes: grid(xs8, aisleZ6, 650, 2.2, 0),
  };
  return [a, b, c];
}

/** 地下车库：48×32×3.6，6×4 跨 ×8m，无窗，梁+柱 */
function garageSpace(): Space {
  const objects: Space['objects'] = [];
  for (let iz = 0; iz <= 4; iz++) {
    const z = -16 + iz * 8;
    objects.push({ id: uid('bm'), kind: 'beam', name: '车库主梁', x: 0, z, rotation: 0, length: 48, width: 0.4, drop: 0.7 });
  }
  for (let ix = 0; ix <= 6; ix++) {
    const x = -24 + ix * 8;
    objects.push({ id: uid('bm'), kind: 'beam', name: '车库次梁', x, z: 0, rotation: Math.PI / 2, length: 32, width: 0.3, drop: 0.5 });
  }
  return {
    width: 48,
    depth: 32,
    height: 3.8,
    workPlaneHeight: 0,
    grid: { baysX: 6, baysZ: 4, spanX: 8, spanZ: 8, columnSize: 0.6, columns: true },
    reflectance: { wall: 0.55, floor: 0.32, ceiling: 0.62, shelf: 0.4 },
    objects,
  };
}

function garageSchemes(tableId: string): Scheme[] {
  const pos: [number, number][] = [];
  for (const x of [-20, -12, -4, 4, 12, 20]) {
    for (const z of [-12, -4, 4, 12]) pos.push([x, z]);
  }
  const std: Scheme = {
    id: uid('sch'),
    name: '标准 · 24管 530',
    note: '每个车位/车道跨中心一根',
    createdAt: Date.now(),
    tubes: pos.map(([x, z]) => tube(tableId, x, z, 530, 2.2, 1)),
  };
  const eco: Scheme = {
    id: uid('sch'),
    name: '经济 · 18管 350',
    note: '减少管数与管径，车道达标、车位略低',
    createdAt: Date.now(),
    tubes: pos.filter((_, i) => i % 4 !== 3).slice(0, 18).map(([x, z]) => tube(tableId, x, z, 350, 2.5, 1)),
  };
  return [std, eco];
}

function whiteRoomProject(tableId: string): Project {
  const space: Space = {
    width: 12,
    depth: 9,
    height: 4.5,
    workPlaneHeight: 0.75,
    grid: { baysX: 3, baysZ: 2, spanX: 4, spanZ: 4.5, columnSize: 0.3, columns: false },
    reflectance: { wall: 0.85, floor: 0.85, ceiling: 0.85, shelf: 0.85 },
    objects: [],
  };
  const pos: [number, number][] = [];
  for (const x of [-3.6, 3.6]) for (const z of [-2.6, 2.6]) pos.push([x, z]);
  const scheme: Scheme = {
    id: uid('sch'),
    name: '校核 · 4管',
    note: '全表面 ρ=0.85，用于积分球解析核对',
    createdAt: Date.now(),
    tubes: pos.map(([x, z]) => tube(tableId, x, z, 650, 1.5, 0)),
  };
  const now = Date.now();
  return {
    id: 'proj-white-check',
    name: '精度校核 · 白墙标准间',
    template: 'blank',
    createdAt: now,
    updatedAt: now,
    space,
    sky: {
      type: 'overcast',
      month: 6,
      day: 21,
      hour: 12,
      location: { name: '上海', latitude: 31.23, longitude: 121.47 },
      turbidity: 2.5,
      overrideExteriorLux: 20000,
    },
    standard: STANDARDS[1],
    energy: {
      lpd: 6,
      occupiedHours: 3000,
      dayStart: 8,
      dayEnd: 18,
      electricityPrice: 0.85,
      targetLux: 200,
      dimmingK: 1,
    },
    schemes: [scheme],
    activeSchemeId: scheme.id,
    probeSpacing: 3,
  };
}

export function buildSeedProjects(table: TubeParamTable): Project[] {
  const tableId = table.id;
  const now = Date.now();

  const factorySchemesArr = factorySchemes(tableId);
  const factory: Project = {
    id: 'proj-factory-demo',
    name: '沪东机械厂 · 老厂房改仓储',
    template: 'factory',
    createdAt: now - 86400000 * 12,
    updatedAt: now - 3600000 * 3,
    space: factorySpace(),
    sky: {
      type: 'overcast',
      month: 11,
      day: 26,
      hour: 10,
      location: { name: '上海', latitude: 31.23, longitude: 121.47 },
      turbidity: 2.5,
      overrideExteriorLux: 22000,
    },
    standard: STANDARDS[0],
    energy: { lpd: 5, occupiedHours: 2800, dayStart: 8, dayEnd: 18, electricityPrice: 0.9, targetLux: 100, dimmingK: 1 },
    schemes: factorySchemesArr,
    activeSchemeId: factorySchemesArr[1].id,
    probeSpacing: 3.8,
  };

  const garageSchemesArr = garageSchemes(tableId);
  const garage: Project = {
    id: 'proj-garage-demo',
    name: '城西文体中心 · 地下车库',
    template: 'garage',
    createdAt: now - 86400000 * 6,
    updatedAt: now - 86400000,
    space: garageSpace(),
    sky: {
      type: 'clear',
      month: 6,
      day: 21,
      hour: 12,
      location: { name: '成都', latitude: 30.67, longitude: 104.07 },
      turbidity: 3,
      overrideExteriorLux: null,
    },
    standard: STANDARDS[3],
    energy: { lpd: 4, occupiedHours: 4200, dayStart: 0, dayEnd: 24, electricityPrice: 0.82, targetLux: 75, dimmingK: 1 },
    schemes: garageSchemesArr,
    activeSchemeId: garageSchemesArr[0].id,
    probeSpacing: 4.2,
  };

  return [factory, garage, whiteRoomProject(tableId)];
}
