import type { SkySettings, Vec3 } from '../../types';
import { clamp, deg2rad, rad2deg } from '../math/vec3';

// CIE 标准全阴天 / 晴天（ISO 15469 一般天空，晴天空 type 12 参数）
// 亮度单位 cd/m²，照度 lux。TS 与 GLSL 共用同一公式（见 glsl/chunks/sky.glsl.ts）。

export interface SunPosition {
  altitude: number; // 太阳高度角 rad
  azimuth: number;  // 方位角 rad，正南=0，西向为正
  direction: Vec3;  // 指向太阳的单位向量（y 向上，z 轴向北？约定：z+ 指向南便于方位）
}

function dayOfYear(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const base = Date.UTC(y, 0, 0);
  const cur = Date.UTC(y, m - 1, d);
  return Math.round((cur - base) / 86400000);
}

/** 太阳位置（Spencer 赤纬 + 时差，工程精度 ±0.2°） */
export function solarPosition(sky: SkySettings): SunPosition {
  const N = dayOfYear(sky.date);
  const gamma = ((2 * Math.PI) / 365) * (N - 1);
  // 赤纬（Spencer，弧度）
  const decl =
    0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
    - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma)
    - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);
  // 时差（分钟，Spencer）
  const eot =
    229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma)
      - 0.014615 * Math.cos(2 * gamma) - 0.04089 * Math.sin(2 * gamma));
  const longitudeSolar = sky.longitude - sky.timezone * 15;
  const solarTime = sky.hour + (longitudeSolar * 4 + eot) / 60;
  // 时角：正午 0，下午为正（向西）
  const H = deg2rad(15 * (solarTime - 12));
  const lat = deg2rad(sky.latitude);
  // 标准高度角公式 sin h = sinφ sinδ + cosφ cosδ cosH
  const sinAlt = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(H);
  const altitude = Math.asin(clamp(sinAlt, -1, 1));
  // 方位角：正南 0，西正东负
  const sinAz = -Math.cos(decl) * Math.sin(H) / Math.max(1e-6, Math.cos(altitude));
  const cosAz = (Math.sin(altitude) * Math.sin(lat) - Math.sin(decl)) /
    (Math.cos(altitude) * Math.cos(lat));
  const azimuth = Math.atan2(sinAz, cosAz);
  const ca = Math.cos(altitude);
  // x 东、y 上、z 南
  const direction: Vec3 = [
    ca * Math.sin(azimuth),
    Math.sin(altitude),
    ca * Math.cos(azimuth),
  ];
  return { altitude, azimuth, direction };
}

// CIE 晴天空参数（type 12）
const CLEAR = { a: -1, b: -0.32, c: 10, d: -3, e: 0.45 };

function gradation(altitude: number, a: number, b: number): number {
  const g = Math.max(altitude, 0.02);
  return 1 + a * Math.exp(b / Math.sin(g));
}

function indicatrix(chi: number, c: number, d: number, e: number): number {
  return 1 + c * (Math.exp(d * chi) - Math.exp(d * Math.PI / 2)) + e * Math.cos(chi) ** 2;
}

export interface SkySample {
  dir: Vec3;       // 天空方向（单位向量，y>=0）
  luminance: number; // cd/m²
  tint: Vec3;      // 相对色温（亮度守恒的归一化 RGB）
}

/** 天空亮度场；全阴天亮度仅与高度角有关，晴天含太阳指示函数 */
export function skyLuminance(
  dir: Vec3,
  sky: SkySettings,
  sun: SunPosition,
  zenithLuminance: number,
): number {
  const alt = Math.asin(clamp(dir[1], -1, 1));
  if (sky.model === 'overcast') {
    // CIE 全阴天：Lγ = Lz·(1+2 sinγ)/3
    return zenithLuminance * (1 + 2 * Math.sin(alt)) / 3;
  }
  const chi = Math.acos(clamp(dot3(dir, sun.direction), -1, 1));
  const num = gradation(alt, CLEAR.a, CLEAR.b) * indicatrix(chi, CLEAR.c, CLEAR.d, CLEAR.e);
  const den = gradation(Math.PI / 2, CLEAR.a, CLEAR.b) *
    indicatrix(sunZenithAngle(sun), CLEAR.c, CLEAR.d, CLEAR.e);
  return zenithLuminance * num / den;
}

function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function sunZenithAngle(sun: SunPosition): number {
  return Math.PI / 2 - sun.altitude;
}

function skyTint(dir: Vec3, sky: SkySettings, sun: SunPosition): Vec3 {
  if (sky.model === 'overcast') return [0.96, 1.0, 1.04];
  const chi = Math.acos(clamp(dot3(dir, sun.direction), -1, 1));
  const warm = Math.exp(-chi * 3) * 0.25;
  return [0.82 + warm, 0.92 + warm * 0.6, 1.08 - warm * 0.2];
}

/** Kittler 晴天空天顶亮度 (kcd/m²)，低太阳高度截断 */
export function clearZenithLuminance(turbidity: number, sun: SunPosition): number {
  if (sun.altitude < deg2rad(3)) return 200;
  const lz = (1.376 * turbidity - 1.808) * Math.tan(sun.altitude) + 0.358;
  return Math.max(0.4, lz) * 1000;
}

/** 全阴天由设计水平面照度反推天顶亮度：Eh = 7π/9 · Lz */
export function overcastZenithFromEh(eh: number): number {
  return (eh * 9) / (7 * Math.PI);
}

/** Fibonacci 半球采样序列 */
export function hemisphereSamples(n: number): Vec3[] {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const out: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const y = (i + 0.5) / n; // 均匀按高度分层
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    out.push([Math.cos(theta) * r, y, Math.sin(theta) * r]);
  }
  return out;
}

export interface SkyField {
  sun: SunPosition;
  zenithLuminance: number;
  directNormal: number; // 太阳直射法向照度 lux（晴天）
  samples: SkySample[];
  horizontalEh: number; // 水平面总照度（漫射+直射）lux
}

export function buildSkyField(sky: SkySettings, sampleCount = 256): SkyField {
  const sun = solarPosition(sky);
  let zenithLuminance: number;
  let directNormal = 0;
  const manual = sky.manualEh ?? null;
  if (sky.model === 'overcast') {
    const eh = manual ?? 10000; // CIE 全阴天设计照度
    zenithLuminance = overcastZenithFromEh(eh);
  } else {
    zenithLuminance = clearZenithLuminance(sky.turbidity, sun);
    // 直射法向照度（Nazarko 经验式，klx）
    if (sun.altitude > deg2rad(2)) {
      directNormal = 127.5 * 1000 *
        Math.exp(-0.09 * sky.turbidity * Math.pow(Math.sin(sun.altitude), -0.58));
    }
  }
  const dirs = hemisphereSamples(sampleCount);
  const weight = (2 * Math.PI) / sampleCount; // 半球立体角等权
  const samples: SkySample[] = dirs.map((dir) => ({
    dir,
    luminance: skyLuminance(dir, sky, sun, zenithLuminance),
    tint: skyTint(dir, sky, sun),
  }));
  let horizontalEh = 0;
  for (const s of samples) horizontalEh += s.luminance * s.dir[1] * weight;
  if (sky.model === 'clear' && sun.altitude > 0) {
    horizontalEh += directNormal * Math.sin(sun.altitude);
  }
  if (manual !== null && sky.model === 'clear') {
    // 手动指定时整体缩放到目标 Eh
    const k = manual / Math.max(1, horizontalEh);
    zenithLuminance *= k;
    directNormal *= k;
    for (const s of samples) s.luminance *= k;
    horizontalEh = manual;
  }
  return { sun, zenithLuminance, directNormal, samples, horizontalEh };
}

/**
 * 竖直面（窗）入射照度：对朝外半球做数值积分 + 太阳直射。
 * outwardNormal 为墙面外法线。
 */
export function verticalIlluminance(field: SkyField, outwardNormal: Vec3): number {
  const weight = (2 * Math.PI) / field.samples.length;
  let e = 0;
  for (const s of field.samples) {
    const cosi = -(s.dir[0] * outwardNormal[0] + s.dir[1] * outwardNormal[1] + s.dir[2] * outwardNormal[2]);
    if (cosi > 0) e += s.luminance * cosi * weight;
  }
  const sunCos = -(field.sun.direction[0] * outwardNormal[0] +
    field.sun.direction[1] * outwardNormal[1] +
    field.sun.direction[2] * outwardNormal[2]);
  if (sunCos > 0 && field.directNormal > 0) e += field.directNormal * sunCos;
  return e;
}

export function formatAngle(r: number): string {
  return `${rad2deg(r).toFixed(1)}°`;
}
