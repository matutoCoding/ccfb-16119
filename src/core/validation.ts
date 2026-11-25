// 应用内精度校核：空房间白墙 vs 积分球解析 E=Φ/(S(1-ρ))
import type { Vec3 } from './math3d';
import type { SceneMesh, Material } from './geometry';
import { buildBVH } from './bvh';
import { estimateIrradiance } from './integrator';

export interface ValidationCase {
  label: string;
  size: string;
  rho: number;
  flux: number;
  analyticLux: number;
  simulatedLux: number;
  errorPct: number;
  pass: boolean;
}

function quad(tris: SceneMesh['triangles'], a: Vec3, b: Vec3, c: Vec3, d: Vec3, n: Vec3, mat: number) {
  tris.push({ v0: a, v1: b, v2: c, normal: n, mat });
  tris.push({ v0: a, v1: c, v2: d, normal: n, mat });
}

function makeWhiteRoom(W: number, D: number, H: number, rho: number, flux: number, nLights: number): SceneMesh {
  const mat: Material = { name: 'white', albedo: [rho, rho, rho], reflectance: rho, kind: 'diffuse' };
  const mesh: SceneMesh = { triangles: [], materials: [mat], lights: [], min: [-W / 2, 0, -D / 2], max: [W / 2, H, D / 2] };
  quad(mesh.triangles, [-W / 2, 0, -D / 2], [-W / 2, 0, D / 2], [W / 2, 0, D / 2], [W / 2, 0, -D / 2], [0, 1, 0], 0);
  quad(mesh.triangles, [-W / 2, H, -D / 2], [W / 2, H, -D / 2], [W / 2, H, D / 2], [-W / 2, H, D / 2], [0, -1, 0], 0);
  quad(mesh.triangles, [-W / 2, 0, -D / 2], [W / 2, 0, -D / 2], [W / 2, H, -D / 2], [-W / 2, H, -D / 2], [0, 0, 1], 0);
  quad(mesh.triangles, [-W / 2, 0, D / 2], [-W / 2, H, D / 2], [W / 2, H, D / 2], [W / 2, 0, D / 2], [0, 0, -1], 0);
  quad(mesh.triangles, [-W / 2, 0, -D / 2], [-W / 2, H, -D / 2], [-W / 2, H, D / 2], [-W / 2, 0, D / 2], [1, 0, 0], 0);
  quad(mesh.triangles, [W / 2, 0, -D / 2], [W / 2, 0, D / 2], [W / 2, H, D / 2], [W / 2, H, -D / 2], [-1, 0, 0], 0);
  const cols = Math.ceil(Math.sqrt(nLights * (W / D)));
  const rows = Math.ceil(nLights / cols);
  let idx = 0;
  for (let ix = 0; ix < cols; ix++) for (let iz = 0; iz < rows; iz++) {
    if (idx >= nLights) break;
    const x = -W / 2 + ((ix + 0.5) / cols) * W;
    const z = -D / 2 + ((iz + 0.5) / rows) * D;
    mesh.lights.push({ id: `L${idx}`, position: [x, H - 0.05, z], size: [0.6, 0.05, 0.6], fluxLumens: flux / nLights, exponent: 1, diffuserId: '' });
    idx++;
  }
  return mesh;
}

interface Face { area: number; sample: (a: number, b: number) => { p: Vec3; n: Vec3 } }
function faces(W: number, D: number, H: number): Face[] {
  return [
    { area: W * D, sample: (a, b) => ({ p: [-W / 2 + a * W, 0.02, -D / 2 + b * D], n: [0, 1, 0] }) },
    { area: W * D, sample: (a, b) => ({ p: [-W / 2 + a * W, H - 0.02, -D / 2 + b * D], n: [0, -1, 0] }) },
    { area: W * H, sample: (a, b) => ({ p: [-W / 2 + a * W, 0.05 + b * (H - 0.1), -D / 2 + 0.02], n: [0, 0, 1] }) },
    { area: W * H, sample: (a, b) => ({ p: [-W / 2 + a * W, 0.05 + b * (H - 0.1), D / 2 - 0.02], n: [0, 0, -1] }) },
    { area: D * H, sample: (a, b) => ({ p: [-W / 2 + 0.02, 0.05 + b * (H - 0.1), -D / 2 + a * D], n: [1, 0, 0] }) },
    { area: D * H, sample: (a, b) => ({ p: [W / 2 - 0.02, 0.05 + b * (H - 0.1), -D / 2 + a * D], n: [-1, 0, 0] }) },
  ];
}

export async function runIntegratingSphereCheck(onProgress?: (p: number) => void): Promise<{ cases: ValidationCase[]; worstError: number; pass: boolean }> {
  const defs = [
    { label: '标准校核间', W: 12, D: 9, H: 4.5, rho: 0.85, flux: 120000, lights: 6 },
    { label: '近立方体房间', W: 8, D: 8, H: 4, rho: 0.8, flux: 80000, lights: 4 },
    { label: '高大厂房', W: 20, D: 12, H: 6, rho: 0.9, flux: 260000, lights: 12 },
  ];
  const cases: ValidationCase[] = [];
  let worst = 0;
  for (let ci = 0; ci < defs.length; ci++) {
    const c = defs[ci];
    const mesh = makeWhiteRoom(c.W, c.D, c.H, c.rho, c.flux, c.lights);
    const bvh = buildBVH(mesh, 4);
    const S = 2 * (c.W * c.D + c.W * c.H + c.D * c.H);
    const analytic = c.flux / (S * (1 - c.rho));
    const fs = faces(c.W, c.D, c.H);
    const pointsPerFace = 24;
    const SPP = 80;
    let wsum = 0, areaSum = 0;
    for (let fi = 0; fi < fs.length; fi++) {
      const f = fs[fi];
      let sum = 0;
      for (let i = 0; i < pointsPerFace; i++) {
        // 分层抖动采样，覆盖均匀
        const a = ((i + 0.5) / pointsPerFace);
        const b = (Math.sin(i * 12.9898 + fi * 78.233) * 43758.5453) % 1;
        const bb = Math.abs(b);
        const { p, n } = f.sample(a, bb);
        sum += estimateIrradiance(mesh, bvh, p, n, { samples: SPP, bounces: 6 }, (ci + 1) * 100000 + fi * 1000 + i * 17);
        if (i % 5 === 0) { onProgress?.((ci + (fi / fs.length) + i / pointsPerFace / fs.length) / defs.length); await new Promise((r) => setTimeout(r, 0)); }
      }
      wsum += (sum / pointsPerFace) * f.area;
      areaSum += f.area;
    }
    const sim = wsum / areaSum;
    const errorPct = (Math.abs(sim - analytic) / analytic) * 100;
    worst = Math.max(worst, errorPct);
    cases.push({
      label: c.label, size: `${c.W}×${c.D}×${c.H}m`, rho: c.rho, flux: c.flux,
      analyticLux: analytic, simulatedLux: sim, errorPct, pass: errorPct < 5,
    });
    onProgress?.((ci + 1) / defs.length);
  }
  return { cases, worstError: worst, pass: worst < 5 };
}
