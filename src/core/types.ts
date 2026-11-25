// ============================================================================
// 全局数据模型 —— 所有项目数据持久化到 IndexedDB
// 坐标：X 横向（开间），Z 纵向（进深），Y 高度；单位 m
// ============================================================================

export type ID = string;

/** 表面反射率集合（0~1） */
export interface Reflectances {
  wall: number;
  floor: number;
  ceiling: number;
  shelf: number;
}

/** 柱网 */
export interface ColumnGrid {
  /** 开间方向跨数（X） */
  baysX: number;
  /** 进深方向跨数（Z） */
  baysZ: number;
  /** 单跨 X  m */
  spanX: number;
  /** 单跨 Z  m */
  spanZ: number;
  /** 柱截面边长 m */
  columnSize: number;
  /** 是否显示/生成柱 */
  columns: boolean;
}

export type ObjKind = 'shelf' | 'partition' | 'beam' | 'window' | 'column';

export interface BaseObj {
  id: ID;
  kind: ObjKind;
  name: string;
  x: number; // 中心 X
  z: number; // 中心 Z
  y?: number; // 底部高度（默认 0；梁为梁底）
  rotation: number; // 绕 Y 弧度
}

/** 货架：长边沿局部 X，进深沿局部 Z */
export interface ShelfObj extends BaseObj {
  kind: 'shelf';
  length: number;
  depth: number;
  height: number;
  levels: number; // 层数（影响遮挡/材质，简化为整体多孔货架系数）
  /** 货架通透率 0~1（真实货架非实心，光线可部分穿过） */
  openness: number;
}

export interface PartitionObj extends BaseObj {
  kind: 'partition';
  length: number;
  thickness: number;
  height: number;
}

export interface BeamObj extends BaseObj {
  kind: 'beam';
  length: number;
  width: number;
  /** 梁下垂高度 */
  drop: number;
}

/** 侧窗，挂在某面外墙 */
export interface WindowObj extends BaseObj {
  kind: 'window';
  wall: 'north' | 'south' | 'east' | 'west';
  width: number;
  height: number;
  sill: number; // 窗台高
  transmittance: number; // 玻璃透射比
}

export interface ColumnObj extends BaseObj {
  kind: 'column';
  size: number;
  height: number;
}

export type SceneObj = ShelfObj | PartitionObj | BeamObj | WindowObj | ColumnObj;

/** 空间模型 */
export interface Space {
  width: number; // X 总宽
  depth: number; // Z 总深
  height: number; // 层高
  workPlaneHeight: number; // 工作面高度
  grid: ColumnGrid;
  reflectance: Reflectances;
  objects: SceneObj[];
}

/** 采光罩型号 */
export interface DomeModel {
  id: ID;
  name: string;
  /** 透射比/效率 */
  transmittance: number;
}

/** 漫射器型号 */
export interface DiffuserModel {
  id: ID;
  name: string;
  transmittance: number;
  /** 配光：朗伯 / 宽配光 / 窄配光 */
  distribution: 'lambert' | 'wide' | 'narrow';
}

/**
 * 厂家传输参数表（可导入 CSV/JSON）。
 * transmissionTable: 管长 m -> 沿程传输效率（0~1），按管径分档。
 * 也支持直接给 “每米损失率” 与 “每个弯头损失系数”。
 */
export interface TubeParamTable {
  id: ID;
  name: string;
  vendor: string;
  /** 适用管径 mm 列表 */
  diameters: number[];
  domes: DomeModel[];
  diffusers: DiffuserModel[];
  /** 按管径(mm) -> 管长/效率 数据点 */
  transmission: Record<
    string,
    { length: number; efficiency: number }[]
  >;
  /** 弯头单次传输系数（如 0.92），按管径可选覆盖 */
  elbowFactor: number;
  /** 采光罩清洁/老化系数等维护系数 */
  maintenanceFactor: number;
  importedAt?: number;
  builtin?: boolean;
}

/** 一根导光管的选型与位置（属于某个方案） */
export interface TubeInstance {
  id: ID;
  /** 关联参数表 */
  tableId: ID;
  diameter: number; // mm
  length: number; // m
  elbows: number;
  domeId: ID;
  diffuserId: ID;
  x: number;
  z: number;
  rotation: number;
  enabled: boolean;
}

/** CIE 天空类型 */
export type SkyType = 'overcast' | 'clear';

export interface GeoLocation {
  name: string;
  latitude: number;
  longitude: number;
  /** 时区中央经线（用于真太阳时），默认按经度/15 取整 */
  tzMeridian?: number;
}

export interface SkyConfig {
  type: SkyType;
  /** 月份 1-12 / 日 1-31 / 时 0-23（真太阳时近似） */
  month: number;
  day: number;
  hour: number;
  location: GeoLocation;
  /** 大气透明度系数（晴天） */
  turbidity: number;
  /** 室外水平面总照度覆盖值；>0 时直接使用，否则按 CIE 模型计算 */
  overrideExteriorLux: number | null;
}

/** 照度标准 */
export interface LuxStandard {
  id: ID;
  name: string;
  requiredAvg: number; // 平均照度标准 lx
  uniformity: number; // 最低均匀度 Emin/Eavg
  ugrLimit?: number;
}

/** 一个对比方案 */
export interface Scheme {
  id: ID;
  name: string;
  note: string;
  tubes: TubeInstance[];
  /** 方案可覆盖天空工况；不填用项目默认 */
  sky?: Partial<SkyConfig>;
  createdAt: number;
}

/** 年度能耗估算参数 */
export interface EnergyConfig {
  /** 电气照明装机功率密度 W/m² */
  lpd: number;
  /** 全年工作小时（用于节能估算） */
  occupiedHours: number;
  /** 白天可利用采光时段起点/终点 */
  dayStart: number;
  dayEnd: number;
  /** 电价 元/kWh */
  electricityPrice: number;
  /** 采光达标照度阈值（通常取标准值） */
  targetLux: number;
  /** 光电控制/调光比例系数：照度每超过阈值多少折算关灯比例 */
  dimmingK: number;
}

export interface Project {
  id: ID;
  name: string;
  template: 'factory' | 'garage' | 'blank';
  createdAt: number;
  updatedAt: number;
  space: Space;
  sky: SkyConfig;
  standard: LuxStandard;
  energy: EnergyConfig;
  schemes: Scheme[];
  activeSchemeId: ID;
  /** 探针间距 m（自动取整到网格数） */
  probeSpacing: number;
}

/** 设置（全局，IndexedDB kv） */
export interface AppSettings {
  gpuProbesPerFrame: number;
  probeRays: number;
  probeResolution: number; // octahedral tile 边长
  heatmapGrid: number; // 工作面网格长边
  showProbes: boolean;
  falseColorMaxLux: number;
  reduceMotion: boolean;
}

// ---- 仿真结果类型 ----

export interface GridStats {
  avg: number;
  min: number;
  max: number;
  uniformity: number; // min/avg
  uniformityMax: number; // min/max
  compliantAreaRatio: number; // 达到标准的面积比例
  stdAvg: number;
}

export interface IlluminanceGrid {
  cols: number;
  rows: number;
  /** 对应 x0 + (i+0.5)*dx */
  x0: number;
  z0: number;
  dx: number;
  dz: number;
  values: Float32Array;
  stats: GridStats;
  /** 每个格点是否被判定为不达标 */
  deficient: Uint8Array;
  /** 位于货架占地内、不参与工作面指标统计的格点 */
  masked?: Uint8Array;
  probeCount: number;
  engine: string;
  elapsedMs: number;
}

export interface LeakPoint {
  x: number;
  z: number;
  lux: number;
  kind: 'leak' | 'overbright' | 'glare';
  message: string;
  severity: 'high' | 'mid' | 'low';
}

export interface AnnualResult {
  hours: number[]; // 8760 室内平均照度
  occupiedMetHours: number;
  occupiedTotalHours: number;
  daylightAutonomy: number; // 达标时长占工作时段比例
  lightingEnergyKwh: number; // 电气照明能耗
  savedKwh: number;
  savedCost: number;
  co2Kg: number;
  monthlyMet: number[]; // 12 月达标小时
  monthlyHours: number[];
}
