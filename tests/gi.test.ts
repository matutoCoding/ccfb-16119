import { describe, it, expect } from 'vitest';
import { buildBvh, traceRay, occluded } from '../src/core/geometry/bvh';
import type { Material, MeshData, Tri } from '../src/core/geometry/mesh';
import { pathTraceIlluminance, analyticCubeRoomIlluminance, integratingSphereAvg } from '../src/core/gi/cpuTracer';
import {
  buildProbeGrid, computeDepthMoments, chebyshevWeight, probeVisibility,
} from '../src/core/gi/probes';
import { shProjectMono, shEvalMono } from '../src/core/math/sh';
import type { Vec3 } from '../src/types';
import { v3 } from '../src/core/math/vec3';

function quad(tris: Tri[], a: Vec3, b: Vec3, c: Vec3, d: Vec3, mat: number): void {
  // 标准绕序 a-b-c + a-c-d
  tris.push({ v0: a, e1: v3.sub(b, a), e2: v3.sub(c, a), mat });
  tris.push({ v0: a, e1: v3.sub(c, a), e2: v3.sub(d, a), mat });
}
function whiteRoom(size: number, rho: number, ceilingRadiance: number): { mesh: MeshData; bvh: ReturnType<typeof buildBvh> } {
  const materials: Material[] = [
    { id: 0, name: '墙地', albedo: [rho, rho, rho], emissive: [0, 0, 0], roughness: 0.95 },
    { id: 1, name: '发光顶', albedo: [rho, rho, rho], emissive: [ceilingRadiance, ceilingRadiance, ceilingRadiance], roughness: 0.9 },
  ];
  const tris: Tri[] = [];
  const s = size;
  quad(tris, [0, 0, 0], [0, 0, s], [s, 0, s], [s, 0, 0], 0);
  quad(tris, [0, s, 0], [s, s, 0], [s, s, s], [0, s, s], 1);
  quad(tris, [0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], 0);
  quad(tris, [s, 0, 0], [s, 0, s], [s, s, s], [s, s, 0], 0);
  quad(tris, [s, 0, s], [0, 0, s], [0, s, s], [s, s, s], 0);
  quad(tris, [0, 0, s], [0, 0, 0], [0, s, 0], [0, s, s], 0);
  const mesh: MeshData = {
    tris, materials, patches: [], instances: [],
    bounds: { min: [0, 0, 0], max: [s, s, s] },
  };
  return { mesh, bvh: buildBvh(tris) };
}

describe('白墙空房解析值对账（验收：平均照度误差 <5%）', () => {
  it('8m 立方体、rho=0.7、发光顶 L=200 cd/m²：工作面平均误差 <5%（地面解析解对账）', () => {
    const s = 8;
    const rho = 0.7;
    const L = 200;
    const { mesh, bvh } = whiteRoom(s, rho, L);
    const emittedLumens = L * Math.PI * s * s;
    const analytic = analyticCubeRoomIlluminance(s, rho, emittedLumens);

    // 贴近地面的工作面 5×5 网格（y=0.05，与地面解析角系数同口径），足够弹射深度
    const samples: number[] = [];
    for (let ix = 0; ix < 5; ix++) {
      for (let iz = 0; iz < 5; iz++) {
        const p: Vec3 = [s * (ix + 0.5) / 5, 0.05, s * (iz + 0.5) / 5];
        samples.push(pathTraceIlluminance(p, bvh, mesh, 4000, 16));
      }
    }
    const tracerAvg = samples.reduce((a, b) => a + b, 0) / samples.length;
    const err = Math.abs(tracerAvg - analytic.floor) / analytic.floor;
    console.log({
      tracerWorkPlane: tracerAvg.toFixed(1),
      analyticFloor: analytic.floor.toFixed(1),
      errorPct: (err * 100).toFixed(2) + '%',
    });
    expect(err).toBeLessThan(0.05);
  });

  it('高反射 rho=0.85 仍收敛且误差 <8%（多次弹射主导，地面对账）', () => {
    const s = 6;
    const rho = 0.85;
    const L = 150;
    const { mesh, bvh } = whiteRoom(s, rho, L);
    const emittedLumens = L * Math.PI * s * s;
    const analytic = analyticCubeRoomIlluminance(s, rho, emittedLumens);
    // 贴近地面工作面 3×3 平均，弹射深度 20 保证高反射收敛
    const samples: number[] = [];
    for (let ix = 0; ix < 3; ix++) {
      for (let iz = 0; iz < 3; iz++) {
        samples.push(pathTraceIlluminance(
          [s * (ix + 0.5) / 3, 0.05, s * (iz + 0.5) / 3], bvh, mesh, 6000, 20,
        ));
      }
    }
    const tracer = samples.reduce((a, b) => a + b, 0) / samples.length;
    const err = Math.abs(tracer - analytic.floor) / analytic.floor;
    console.log({ rho, tracer: tracer.toFixed(1), analytic: analytic.floor.toFixed(1), errPct: (err * 100).toFixed(2) });
    expect(err).toBeLessThan(0.08);
  });
});

describe('DDGI 探针与 Chebyshev 可见性', () => {
  it('深度矩记录到墙距离，墙后点 Chebyshev 权重趋近 0', () => {
    const s = 10;
    const { mesh, bvh } = whiteRoom(s, 0.5, 100);
    const grid = buildProbeGrid(mesh.bounds, 4, 0.6);
    const probe = grid.positions[0];
    const moments = computeDepthMoments(probe, bvh, mesh.tris, 30);
    // 探针离 x=0 墙的距离
    const distToWall = probe[0];
    expect(moments[2]).toBeCloseTo(distToWall, 0); // -x 方向均值
    // 墙后面的点（探针与墙之间隔了整面墙）：可见性权重应很低
    const behind: Vec3 = [probe[0] - distToWall - 1.5, probe[1], probe[2]];
    const w = probeVisibility(moments, probe, behind);
    expect(w).toBeLessThan(0.25);
    // 同侧邻近点权重接近 1
    const near: Vec3 = [probe[0] + 0.5, probe[1], probe[2]];
    expect(probeVisibility(moments, probe, near)).toBeGreaterThan(0.9);
  });

  it('Chebyshev 不等式基本性质', () => {
    expect(chebyshevWeight(5, 26, 3)).toBe(1); // 距离小于均值
    const w = chebyshevWeight(5, 26, 8); // 方差1，d=3 → 1/10
    expect(w).toBeCloseTo(0.1, 4);
  });

  it('SH 投影/求值对常数场还原一致（半球采样，0 阶主导）', () => {
    const dirs: Vec3[] = [];
    for (let i = 0; i < 400; i++) {
      const y = (i + 0.5) / 400;
      const r = Math.sqrt(1 - y * y);
      const th = i * 2.39996;
      dirs.push([r * Math.cos(th), y, r * Math.sin(th)]);
    }
    // 常数辐射亮度 L=300，半球 SH 投影（权重 2π）
    const coeffs = shProjectMono(dirs.map((dir) => ({ dir, value: 300 })), true);
    // 0 阶系数 = 2π·L·Y00，是主导项，误差 <2%
    const expected0 = 2 * Math.PI * 300 * 0.886227;
    expect(Math.abs(coeffs[0] - expected0) / expected0).toBeLessThan(0.02);
    // 0 阶系数绝对值应大于任一高阶系数（常数场能量集中在 DC 项）
    for (let k = 1; k < 9; k++) {
      expect(Math.abs(coeffs[k])).toBeLessThan(Math.abs(coeffs[0]));
    }
  });
});

describe('货架遮挡（验收：挪完货架不能有漏光）', () => {
  it('货架背光面直射光被完全遮挡', () => {
    const s = 12;
    const { mesh, bvh } = whiteRoom(s, 0.4, 0);
    // 插入一块货架板（高 4m、长 8m、厚 0.2），居中
    const shelfMat = mesh.materials.length;
    mesh.materials.push({ id: shelfMat, name: '货架', albedo: [0.3, 0.3, 0.3], emissive: [0, 0, 0], roughness: 0.9 });
    const c: Vec3 = [s / 2, 2, s / 2];
    const hx = 0.1, hy = 2, hz = 4;
    const corners: Vec3[] = [
      [c[0] - hx, c[1] - hy, c[2] - hz], [c[0] + hx, c[1] - hy, c[2] - hz],
      [c[0] + hx, c[1] + hy, c[2] - hz], [c[0] - hx, c[1] + hy, c[2] - hz],
      [c[0] - hx, c[1] - hy, c[2] + hz], [c[0] + hx, c[1] - hy, c[2] + hz],
      [c[0] + hx, c[1] + hy, c[2] + hz], [c[0] - hx, c[1] + hy, c[2] + hz],
    ];
    const faces = [
      [0, 1, 2, 3], [4, 7, 6, 5], [0, 4, 5, 1],
      [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0],
    ];
    for (const f of faces) quad(mesh.tris, corners[f[0]], corners[f[1]], corners[f[2]], corners[f[3]], shelfMat);
    const bvh2 = buildBvh(mesh.tris);
    // 从货架左侧一点朝右打，必须命中货架，且命中距离≈到板面距离
    const origin: Vec3 = [c[0] - 3, 2, c[2]];
    const hit = traceRay(bvh2, mesh.tris, {
      origin, dir: [1, 0, 0], tmin: 0.01, tmax: 10,
    });
    expect(hit).not.toBeNull();
    expect(hit!.triIndex).toBeGreaterThanOrEqual(mesh.tris.length - 12);
    expect(hit!.t).toBeCloseTo(3 - hx, 1);
    // 背光侧工作台朝货架方向的射线被挡住
    const back: Vec3 = [c[0] + 1, 1, c[2]];
    const blocked = occluded(bvh2, mesh.tris, back, [-1, 0, 0], 2);
    expect(blocked).toBe(true);
  });
});
