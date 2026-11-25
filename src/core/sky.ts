// 太阳位置 + CIE 标准全阴天/晴天天空 + 室外水平面照度
import type { SkyConfig } from './types';
import type { Vec3 } from './math3d';

export function dayOfYear(month: number, day: number): number {
  const days = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  return days[month - 1] + day;
}

export interface SunPos {
  elevation: number; // 弧度
  azimuth: number; // 弧度，南=0，西向正
  zenith: number; // 弧度
  sinElev: number;
}

/** NOAA 近似太阳位置 */
export function sunPosition(
  lat: number,
  lon: number,
  month: number,
  day: number,
  hour: number,
  tzMeridian?: number,
): SunPos {
  const doy = dayOfYear(month, day);
  const gamma = (2 * Math.PI) / 365 * (doy - 1 + (hour - 12) / 24);
  const decl =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma);

  const eotMin =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma));

  const meridian = tzMeridian ?? 15 * Math.round(lon / 15);
  // 真太阳时（分钟）= 地方标准时 + 4 min/° × (当地经度 − 时区中央经线) + 时差
  const timeOffset = eotMin + 4 * (lon - meridian);
  const trueSolarMin = hour * 60 + timeOffset;
  const hourAngleDeg = trueSolarMin / 4 - 180; // 上午为负
  const ha = (hourAngleDeg * Math.PI) / 180;
  const latR = (lat * Math.PI) / 180;

  const cosZen =
    Math.sin(latR) * Math.sin(decl) + Math.cos(latR) * Math.cos(decl) * Math.cos(ha);
  const zenith = Math.acos(Math.max(-1, Math.min(1, cosZen)));
  const elevation = Math.PI / 2 - zenith;
  const sinElev = Math.max(0, Math.sin(elevation));

  // 方位角（从南起算，下午偏西为正）
  const cosAz =
    (Math.sin(decl) * Math.cos(latR) - Math.cos(decl) * Math.sin(latR) * Math.cos(ha)) /
    Math.max(1e-6, Math.sin(zenith));
  let az = Math.acos(Math.max(-1, Math.min(1, cosAz)));
  if (ha > 0) az = -az; // 上午符号（保持约定即可）
  // 转为常用：北=0 顺时针
  const azimuthNorth = az + Math.PI;
  return { elevation, azimuth: azimuthNorth, zenith, sinElev };
}

/** Kasten-Young 大气质量 */
export function airMass(sinElev: number): number {
  const elevDeg = Math.asin(Math.max(1e-4, sinElev)) * 180 / Math.PI;
  return 1 / (sinElev + 0.50572 * Math.pow(elevDeg + 6.07995, -1.6364));
}

export interface ExteriorLight {
  horizontalLux: number;
  directNormalLux: number;
  diffuseHorizontalLux: number;
  sun: SunPos;
}

/** 计算室外水平面照度 (lx) */
export function exteriorIlluminance(sky: SkyConfig): ExteriorLight {
  if (sky.overrideExteriorLux && sky.overrideExteriorLux > 0) {
    const sun = sunPosition(
      sky.location.latitude,
      sky.location.longitude,
      sky.month,
      sky.day,
      sky.hour,
      sky.location.tzMeridian,
    );
    return {
      horizontalLux: sky.overrideExteriorLux,
      directNormalLux: sky.overrideExteriorLux * 0.6,
      diffuseHorizontalLux: sky.overrideExteriorLux * 0.4,
      sun,
    };
  }
  const sun = sunPosition(
    sky.location.latitude,
    sky.location.longitude,
    sky.month,
    sky.day,
    sky.hour,
    sky.location.tzMeridian,
  );
  if (sun.elevation <= 0) {
    return { horizontalLux: 0, directNormalLux: 0, diffuseHorizontalLux: 0, sun };
  }
  const m = Math.min(40, airMass(sun.sinElev));
  const T = sky.turbidity ?? 2.5;

  // 大气上界太阳照度常数 ~127.5 klx
  const I0 = 127500;
  let dni: number;
  let dhi: number;
  if (sky.type === 'clear') {
    // 简化晴天法向直射照度（含浑浊度）
    const trans = Math.exp(-0.11 * m * (T / 2.5));
    dni = I0 * Math.pow(trans, 0.8) * Math.exp(-0.012 * m);
    // 晴天散射水平照度
    dhi = 0.08 * I0 * sun.sinElev * Math.exp(-0.05 * m) * (0.6 + T / 5);
  } else {
    // CIE 全阴天：几乎无直射，水平照度经验式
    dni = 0;
    // 最亮阴天约 21.5 klx，低太阳高度按 0.6 次幂衰减
    dhi = 21500 * Math.pow(sun.sinElev, 0.55) * (2.5 / T) * 0.9 + 1500 * sun.sinElev;
  }
  const directH = dni * sun.sinElev;
  const horizontalLux = Math.max(0, directH + dhi);
  return { horizontalLux, directNormalLux: dni, diffuseHorizontalLux: dhi, sun };
}

// ---- CIE 天空相对亮度分布（CPU 参考；GLSL 中有对应实现）----

/** 天顶到方向 dir 的角距离等，dir 为单位向量 y 朝上 */
export function cieRelativeLuminance(
  type: 'overcast' | 'clear',
  dir: Vec3,
  sunDir: Vec3,
): number {
  const y = Math.max(0, dir[1]);
  if (y <= 0) return 0.05; // 地面以下给一点环境
  const cosZ = y; // 与天顶夹角余弦
  if (type === 'overcast') {
    // L/Lz = (1+2 cosZ)/3
    return (1 + 2 * cosZ) / 3;
  }
  // 晴天 Kittler
  const cosGamma = Math.max(-1, Math.min(1, dir[0] * sunDir[0] + dir[1] * sunDir[1] + dir[2] * sunDir[2]));
  const gamma = Math.acos(cosGamma);
  const zS = Math.acos(Math.max(-1, Math.min(1, sunDir[1])));
  const eps = Math.acos(Math.max(-1, Math.min(1, cosZ)));
  const phi = (z: number, g: number) =>
    0.91 + 10 * Math.exp(-3 * g) + 0.45 * Math.cos(g) * Math.cos(g);
  const fz = (e: number) => 1 - Math.exp(-0.32 / Math.max(0.05, Math.cos(e)));
  const num = fz(eps) * phi(0, gamma);
  const den = fz(0) * phi(0, zS);
  return Math.max(0, num / Math.max(1e-4, den));
}

/** 太阳方向向量 */
export function sunDirection(sun: SunPos): Vec3 {
  // azimuth 北=0 顺时针；x=东, z=南? 我们用 x 右、z 朝向... 统一：
  // 取 x = sin(az)*cos(el), y=sin(el), z = cos(az)*cos(el)
  const ce = Math.cos(sun.elevation);
  return [
    Math.sin(sun.azimuth) * ce,
    Math.sin(sun.elevation),
    Math.cos(sun.azimuth) * ce,
  ];
}

/**
 * 数值积分求天空亮度归一化系数 Lz，使 ∫ L·cosθ dΩ = targetHorizontalLux。
 * 返回 Lz (cd/m²)。
 */
export function skyZenithScale(
  type: 'overcast' | 'clear',
  sunDir: Vec3,
  targetHorizontalLux: number,
): number {
  // 阴天有解析：E = 7π/9 · Lz
  if (type === 'overcast') return (9 * targetHorizontalLux) / (7 * Math.PI);
  // 晴天数值积分
  let integral = 0;
  const NA = 64;
  const NE = 32;
  for (let ie = 0; ie < NE; ie++) {
    const theta = ((ie + 0.5) / NE) * (Math.PI / 2); // 天顶角
    const sinT = Math.sin(theta);
    const cosT = Math.cos(theta);
    for (let ia = 0; ia < NA; ia++) {
      const phi = ((ia + 0.5) / NA) * 2 * Math.PI;
      const dir: Vec3 = [sinT * Math.cos(phi), cosT, sinT * Math.sin(phi)];
      const rel = cieRelativeLuminance('clear', dir, sunDir);
      const dOmega = (Math.PI / 2 / NE) * (2 * Math.PI / NA) * sinT;
      integral += rel * cosT * dOmega;
    }
  }
  return targetHorizontalLux / Math.max(1e-3, integral);
}

/** 生成环境辐射亮度函数（供 CPU 积分器） */
export function makeSkyEnv(sky: SkyConfig, ext: ExteriorLight): (dir: Vec3) => Vec3 {
  const sunDir = sunDirection(ext.sun);
  const lz = skyZenithScale(sky.type, sunDir, ext.diffuseHorizontalLux || ext.horizontalLux);
  return (dir: Vec3): Vec3 => {
    if (dir[1] < -0.02) {
      // 朝下射线打到“地面”——由几何接管；miss 时给微弱地面反弹
      const g = ext.horizontalLux * 0.2;
      return [g / Math.PI, g / Math.PI, g / Math.PI];
    }
    const rel = cieRelativeLuminance(sky.type, dir, sunDir);
    const L = lz * rel;
    // 太阳盘高光（晴天）
    const cosSun = dir[0] * sunDir[0] + dir[1] * sunDir[1] + dir[2] * sunDir[2];
    let sunBoost = 0;
    if (sky.type === 'clear' && cosSun > 0.9996) sunBoost = ext.directNormalLux / (4 * Math.PI);
    return [L + sunBoost, L * 0.97 + sunBoost * 0.95, L * 0.92 + sunBoost * 0.9];
  };
}
