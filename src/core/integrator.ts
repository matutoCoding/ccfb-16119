// 物理积分器：在指定点/法线上估计照度(lux)。
// 直接光：对每个光源在发光面采样 + BVH 阴影；间接光：余弦加权路径，多级漫反射。
// 推导：E = ∫ L cosθ dΩ；余弦 pdf=cosθ/π ⇒ E_ind ≈ π·avg(L)；
// 漫反射 L = ρ/π·E ⇒ π·L_hit = ρ·E_hit（递归）。
import type { Vec3 } from './math3d';
import { v3 } from './math3d';
import type { SceneMesh, TubeLight } from './geometry';
import type { BVH } from './bvh';
import { traceRay } from './bvh';

export type EnvRadiance = (dir: Vec3) => Vec3; // 返回亮度 cd/m²（RGB）

export interface IntegratorOptions {
  samples: number;
  bounces: number;
  env?: EnvRadiance | null;
  /** 每样本每光源面积采样数（默认1） */
  lightSamples?: number;
}

const EPS = 1.5e-3;

/** 余弦加权半球方向（给定法线 n） */
function cosineHemi(n: Vec3, rng: () => number): Vec3 {
  const r1 = rng();
  const r2 = rng();
  const phi = 2 * Math.PI * r1;
  const r = Math.sqrt(r2);
  const x = r * Math.cos(phi);
  const z = r * Math.sin(phi);
  const y = Math.sqrt(Math.max(0, 1 - r2));
  // 构造正交基
  const up: Vec3 = Math.abs(n[1]) < 0.999 ? [0, 1, 0] : [1, 0, 0];
  const t = v3.norm(v3.cross(up, n));
  const b = v3.cross(n, t);
  return v3.norm([
    t[0] * x + n[0] * y + b[0] * z,
    t[1] * x + n[1] * y + b[1] * z,
    t[2] * x + n[2] * y + b[2] * z,
  ]);
}

function faceForwardNormal(rawN: Vec3, dir: Vec3): Vec3 {
  // dir 是光线传播方向；若法线与 dir 同向，说明命中背面，翻转
  return v3.dot(rawN, dir) > 0 ? v3.scale(rawN, -1) : rawN;
}

/** 玻璃透射阴影：返回透射比；遇到不透明返回 0 */
function shadowFactor(
  mesh: SceneMesh,
  bvh: BVH,
  p: Vec3,
  n: Vec3,
  q: Vec3,
): number {
  let dir = v3.sub(q, p);
  const dist = v3.len(dir);
  if (dist < 1e-6) return 1;
  dir = v3.scale(dir, 1 / dist);
  let o = v3.add(p, v3.scale(n, EPS));
  let remain = dist - EPS * 2;
  let through = 1;
  for (let i = 0; i < 4; i++) {
    const hit = traceRay(mesh, bvh, o, dir, remain);
    if (!hit) return through;
    const mat = mesh.materials[hit.mat];
    if (mat.kind === 'glass') {
      through *= mat.transmittance ?? 0.7;
      const n2 = faceForwardNormal(hit.normal, dir);
      o = v3.add(hit.point, v3.scale(n2, EPS));
      remain -= hit.t;
      if (remain <= 0) return through;
      continue;
    }
    return 0;
  }
  return 0;
}

/** 单光源直接照度估计（一个面积样本） */
function directLightOne(
  mesh: SceneMesh,
  bvh: BVH,
  p: Vec3,
  n: Vec3,
  light: TubeLight,
  rng: () => number,
): number {
  const D = light.size[0];
  const area = D * D; // 采样的方形发光面面积，与采样域一致
  const lx = light.position[0] + (rng() - 0.5) * D;
  const lz = light.position[2] + (rng() - 0.5) * D;
  const ly = light.position[1];
  const q: Vec3 = [lx, ly, lz];
  const Lvec = v3.sub(q, p);
  const r2 = v3.dot(Lvec, Lvec);
  const r = Math.sqrt(r2);
  if (r < 1e-5) return 0;
  const Ldir = v3.scale(Lvec, 1 / r);
  const cosP = v3.dot(n, Ldir);
  if (cosP <= 0) return 0;
  const nL: Vec3 = [0, -1, 0];
  const cosQ = v3.dot(nL, v3.scale(Ldir, -1));
  if (cosQ <= 0) return 0;
  const vis = shadowFactor(mesh, bvh, p, n, q);
  if (vis <= 0) return 0;
  const Le = light.fluxLumens / (Math.PI * area); // cd/m²（朗伯体 Φ=π·Le·A）
  // 面积采样估计：(1/N)Σ Le·cosP·cosQ/r²·V·A
  return (Le * cosP * cosQ * vis * area) / r2;
}

/**
 * 估计一点的照度（单次随机路径，含每级 NEE）。
 * 返回 RGB 照度权重；这里主要用标量（反照率近似同色），保留通道以便彩色。
 */
function irradiancePath(
  mesh: SceneMesh,
  bvh: BVH,
  p: Vec3,
  n: Vec3,
  lights: TubeLight[],
  opt: IntegratorOptions,
  rng: () => number,
  bounce: number,
): number {
  let E = 0;

  // 直接光源：每条路径随机选一盏灯做面积采样（×灯数，无偏），避免逐灯阴影求交
  if (lights.length > 0) {
    const li = Math.min(lights.length - 1, Math.floor(rng() * lights.length));
    E += lights.length * directLightOne(mesh, bvh, p, n, lights[li], rng);
  }

  // 间接
  if (bounce < 64) {
    const dir = cosineHemi(n, rng);
    const o = v3.add(p, v3.scale(n, EPS));
    const hit = traceRay(mesh, bvh, o, dir, 1e4);
    if (!hit) {
      if (opt.env) {
        const Le = opt.env(dir);
        E += Math.PI * (0.2126 * Le[0] + 0.7152 * Le[1] + 0.0722 * Le[2]);
      }
    } else {
      const mat = mesh.materials[hit.mat];
      if (mat.kind === 'emitter') {
        // 直视发光面的贡献已由 NEE 覆盖，这里不重复计
      } else if (mat.kind === 'glass') {
        const n2 = faceForwardNormal(hit.normal, dir);
        const o2 = v3.add(hit.point, v3.scale(n2, EPS));
        const E2 = irradiancePath(mesh, bvh, o2, n2, lights, opt, rng, bounce + 1);
        E += (mat.transmittance ?? 0.7) * E2;
      } else {
        const n2 = faceForwardNormal(hit.normal, dir);
        const Ehit = irradiancePath(mesh, bvh, hit.point, n2, lights, opt, rng, bounce + 1);
        const rho = mat.reflectance;
        if (bounce < 3) {
          // 前几级完整权重
          E += rho * Ehit;
        } else {
          // 俄罗斯轮盘：以概率 p 继续，权重 rho/p，无偏地补足无限弹射尾项
          const p = Math.min(0.95, Math.max(0.25, rho));
          if (rng() < p) E += (rho / p) * Ehit;
        }
      }
    }
  }
  return E;
}

/** 多点平均照度 */
export function estimateIrradiance(
  mesh: SceneMesh,
  bvh: BVH,
  p: Vec3,
  normal: Vec3,
  opt: IntegratorOptions,
  seed = 1,
): number {
  const rng = makeSeeded(seed);
  let sum = 0;
  const spp = opt.samples;
  for (let i = 0; i < spp; i++) {
    sum += irradiancePath(mesh, bvh, p, normal, mesh.lights, opt, rng, 0);
  }
  return sum / spp;
}

// 每个调用独立 rng，避免共享序列偏差
function makeSeeded(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
