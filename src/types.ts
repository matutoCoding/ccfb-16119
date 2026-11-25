// 全局数据模型 —— 项目 / 空间 / 方案 / 参数表，全部可序列化到 IndexedDB

export type Vec3 = [number, number, number];

export type ObjectKind =
  | 'shelf'      // 货架
  | 'partition'  // 隔墙
  | 'beam'       // 梁
  | 'window'     // 侧窗（天光入口）
  | 'column'     // 柱
  | 'other';

export interface BoxObject {
  id: string;
  kind: ObjectKind;
  name: string;
  center: Vec3;
  size: Vec3;          // 全尺寸 (m)
  rotationY: number;   // 绕 Y 轴弧度
  reflectance: number; // 表面反射率 0..1（墙地顶以外物体用）
  color: Vec3;         // 线性 albedo（反射率为其亮度均值参考）
}

export interface RoomDef {
  width: number;    // X 向 (m)
  depth: number;    // Z 向 (m)
  height: number;   // 层高 Y (m)
  bayX: number;     // 柱网 X 间距
  bayZ: number;     // 柱网 Z 间距
  wallReflectance: number;
  floorReflectance: number;
  ceilingReflectance: number;
}

export interface LightPipeDef {
  id: string;
  name: string;
  x: number;          // 屋面水平位置
  z: number;
  diameter: number;   // 管径 m
  length: number;     // 管长 m
  elbowCount: number; // 90° 弯头数量
  domeModel: string;  // 采光罩型号 id
  diffuserModel: string; // 漫射器型号 id
  enabled: boolean;
}

export type SkyModel = 'overcast' | 'clear';

export interface SkySettings {
  model: SkyModel;
  latitude: number;    // 度
  longitude: number;   // 度
  timezone: number;    // UTC 偏移小时
  date: string;        // YYYY-MM-DD
  hour: number;        // 本地小时 0..24（小数）
  turbidity: number;   // 晴空 Linke 浊度
  manualEh: number | null; // 手动指定室外水平面照度 (lux)，null=自动
}

export interface ProbeSettings {
  spacing: number;          // 探针网格间距 (m)
  workPlaneHeight: number;  // 工作面高度 (m)
  raysPerProbe: number;     // 每探针光线数 64/128/256
  probesPerFrame: number;   // 每帧轮转更新探针数
}

export interface Scheme {
  id: string;
  name: string;
  createdAt: number;
  pipes: LightPipeDef[];
}

export type ProjectKind = 'factory' | 'garage' | 'custom';

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  kind: ProjectKind;
  room: RoomDef;
  objects: BoxObject[];
  schemes: Scheme[];
  activeSchemeId: string;
  sky: SkySettings;
  probe: ProbeSettings;
  catalogId: string;
  standardMinLux: number; // 采光标准最低工作面照度阈值
  notes?: string;
}

export interface CatalogModel {
  id: string;
  name: string;
  transmittance: number; // 采光罩透射比 / 漫射器输出效率 0..1
  distribution: 'lambertian' | 'batwing';
}

export interface TransmissionPoint {
  diameter: number; // m
  length: number;   // m
  efficiency: number; // 0..1
}

export interface PipeCatalog {
  id: string;
  name: string;
  builtin?: boolean;
  diameters: number[];
  transmission: TransmissionPoint[];
  elbowLoss: number; // 每个 90° 弯头的效率折减（乘子 0..1）
  domes: CatalogModel[];
  diffusers: CatalogModel[];
  designOvercastEh: number; // 设计全阴天室外水平面照度 lux
}

export interface AppSettings {
  id: 'singleton';
  defaultCatalogId: string;
  renderScale: number;
  showFps: boolean;
}

export function uid(prefix = 'id'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
