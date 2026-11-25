/**
 * 物理精度校核：空房间 + 全表面同一反射率（白墙工况）
 * 积分球解析解：全内表面面积加权平均照度 E = Φ / (S·(1-ρ))
 * 运行：npm run check:physics
 */
declare const process: { exit(code?: number): void };
import { buildBVH } from '../src/core/bvh';
import { estimateIrradiance } from '../src/core/integrator';
import type { SceneMesh, Material } from '../src/core/geometry';
import type { Vec3 } from '../src/core/math3d';

function quad(tris: SceneMesh['triangles'], a: Vec3, b: Vec3, c: Vec3, d: Vec3, n: Vec3, mat: number) {
  tris.push({ v0: a, v1: b, v2: c, normal: n, mat });
  tris.push({ v0: a, v1: c, v2: d, normal: n, mat });
}

function makeWhiteRoom(W: number, D: number, H: number, rho: number, flux: number, nLights = 4) {
  const mat: Material = {
    name: 'white',
    albedo: [rho, rho, rho],
    reflectance: rho,
    kind: 'diffuse',
  };
  const mesh: SceneMesh = {
    triangles: [],
    materials: [mat],
    lights: [],
    min: [-W / 2, 0, -D / 2],
    max: [W / 2, H, D / 2],
  };
  // 地面（法线朝上）
  quad(mesh.triangles, [-W / 2, 0, -D / 2], [-W / 2, 0, D / 2], [W / 2, 0, D / 2], [W / 2, 0, -D / 2], [0, 1, 0], 0);
  // 顶棚（法线朝下）
  quad(mesh.triangles, [-W / 2, H, -D / 2], [W / 2, H, -D / 2], [W / 2, H, D / 2], [-W / 2, H, D / 2], [0, -1, 0], 0);
  // 南 z- 法线+z
  quad(mesh.triangles, [-W / 2, 0, -D / 2], [W / 2, 0, -D / 2], [W / 2, H, -D / 2], [-W / 2, H, -D / 2], [0, 0, 1], 0);
  // 北 z+ 法线-z
  quad(mesh.triangles, [-W / 2, 0, D / 2], [-W / 2, H, D / 2], [W / 2, H, D / 2], [W / 2, 0, D / 2], [0, 0, -1], 0);
  // 西 x- 法线+x
  quad(mesh.triangles, [-W / 2, 0, -D / 2], [-W / 2, H, -D / 2], [-W / 2, H, D / 2], [-W / 2, 0, D / 2], [1, 0, 0], 0);
  // 东 x+ 法线-x
  quad(mesh.triangles, [W / 2, 0, -D / 2], [W / 2, 0, D / 2], [W / 2, H, D / 2], [W / 2, H, -D / 2], [-1, 0, 0], 0);

  // 规则布置光源（顶棚漫射器），总通量 flux
  const cols = Math.ceil(Math.sqrt(nLights * (W / D)));
  const rows = Math.ceil(nLights / cols);
  let idx = 0;
  for (let ix = 0; ix < cols; ix++) {
    for (let iz = 0; iz < rows; iz++) {
      if (idx >= nLights) break;
      const x = -W / 2 + ((ix + 0.5) / cols) * W;
      const z = -D / 2 + ((iz + 0.5) / rows) * D;
      mesh.lights.push({
        id: `L${idx}`,
        position: [x, H - 0.05, z],
        size: [0.6, 0.05, 0.6],
        fluxLumens: flux / nLights,
        exponent: 1,
        diffuserId: '',
      });
      idx++;
    }
  }
  return mesh;
}

interface FaceSampler {
  area: number;
  sample: (r1: number, r2: number) => { p: Vec3; n: Vec3 };
  name: string;
}

function faceSamplers(W: number, D: number, H: number): FaceSampler[] {
  return [
    { name: 'floor', area: W * D, sample: (a, b) => ({ p: [-W / 2 + a * W, 0.02, -D / 2 + b * D], n: [0, 1, 0] }) },
    { name: 'ceil', area: W * D, sample: (a, b) => ({ p: [-W / 2 + a * W, H - 0.02, -D / 2 + b * D], n: [0, -1, 0] }) },
    { name: 'south', area: W * H, sample: (a, b) => ({ p: [-W / 2 + a * W, 0.02 + b * (H - 0.04), -D / 2 + 0.02], n: [0, 0, 1] }) },
    { name: 'north', area: W * H, sample: (a, b) => ({ p: [-W / 2 + a * W, 0.02 + b * (H - 0.04), D / 2 - 0.02], n: [0, 0, -1] }) },
    { name: 'west', area: D * H, sample: (a, b) => ({ p: [-W / 2 + 0.02, 0.02 + b * (H - 0.04), -D / 2 + a * D], n: [1, 0, 0] }) },
    { name: 'east', area: D * H, sample: (a, b) => ({ p: [W / 2 - 0.02, 0.02 + b * (H - 0.04), -D / 2 + a * D], n: [-1, 0, 0] }) },
  ];
}

async function main() {
  const cases = [
    { W: 12, D: 9, H: 4.5, rho: 0.85, flux: 120000, lights: 6 },
    { W: 8, D: 8, H: 4, rho: 0.8, flux: 80000, lights: 4 },
    { W: 20, D: 12, H: 6, rho: 0.9, flux: 260000, lights: 12 },
  ];

  let worst = 0;
  for (const c of cases) {
    const mesh = makeWhiteRoom(c.W, c.D, c.H, c.rho, c.flux, c.lights);
    const bvh = buildBVH(mesh, 4);
    const S = 2 * (c.W * c.D + c.W * c.H + c.D * c.H);
    const analytic = c.flux / (S * (1 - c.rho));

    const samplers = faceSamplers(c.W, c.D, c.H);
    const perFacePoints = 48;
    const spp = 128;
    let weightedSum = 0;
    let areaSum = 0;
    const faceMeans: Record<string, number> = {};
    let seedBase = 1000;
    for (const f of samplers) {
      let sum = 0;
      for (let i = 0; i < perFacePoints; i++) {
        const r1 = ((i * 0.61803398875) % 1);
        const r2 = (((i + 0.5) * 0.754877666) % 1);
        // 用抖动 + 种子保证覆盖
        const j1 = (Math.sin(i * 12.9898 + f.area) * 43758.5453) % 1;
        const a = (i + Math.abs(j1)) / perFacePoints;
        const { p, n } = f.sample((a % 1), r2);
        const e = estimateIrradiance(mesh, bvh, p, n, { samples: spp, bounces: 6 }, seedBase + i * 97 + Math.floor(f.area));
        sum += e;
      }
      const mean = sum / perFacePoints;
      faceMeans[f.name] = mean;
      weightedSum += mean * f.area;
      areaSum += f.area;
    }
    const envMean = weightedSum / areaSum;
    const errEnv = Math.abs(envMean - analytic) / analytic;

    // 地面平均（=工作面贴地），仅作参考：下射配光下地面会高于全表面均值
    const floorMean = faceMeans.floor;
    const errFloor = Math.abs(floorMean - analytic) / analytic;
    // 积分球公式严格预测的是“全内表面面积加权平均照度”，以此作为验收口径
    worst = Math.max(worst, errEnv);

    console.log(
      `房间 ${c.W}×${c.D}×${c.H} ρ=${c.rho} Φ=${c.flux}lm | ` +
        `积分球解析=${analytic.toFixed(1)}lx ` +
        `仿真平均=${envMean.toFixed(1)}lx ` +
        `误差 ${(errEnv * 100).toFixed(2)}% ` +
        `｜工作面(地)参考=${floorMean.toFixed(0)}lx (口径差 ${(errFloor * 100).toFixed(1)}%，配光所致)`,
    );
  }
  console.log(`\n积分球口径最大误差: ${(worst * 100).toFixed(2)}%  验收线 < 5%  => ${worst < 0.05 ? 'PASS' : 'FAIL'}`);
  process.exit(worst < 0.05 ? 0 : 1);
}

main();
