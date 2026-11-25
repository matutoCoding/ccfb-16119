// 漏光 / 过亮 / 眩光点检测 + “隔墙/货架不透光”自检
import type { Project, IlluminanceGrid, LeakPoint } from './types';
import type { BuiltScene } from './solver';
import { traceRay } from './bvh';
import { v3, type Vec3 } from './math3d';
import { estimateIrradiance } from './integrator';
import { buildBVH } from './bvh';
import type { SceneMesh, Material } from './geometry';

/** 判断某点是否能直线看到任意光源（无遮挡），返回可见灯数 */
function visibleLightCount(built: BuiltScene, p: Vec3): number {
  let n = 0;
  for (const l of built.mesh.lights) {
    const dir = v3.sub(l.position, p);
    const dist = v3.len(dir);
    const d = v3.scale(dir, 1 / dist);
    const hit = traceRay(built.mesh, built.bvh, v3.add(p, [0, 0.05, 0]), d, dist - 0.1);
    if (!hit) n++;
  }
  return n;
}

/**
 * 基于结果网格 + BVH 的问题清单。
 * leak：局部异常亮斑且对所有光源都无视线（疑似 GI 漏光/插值穿透）。
 * overbright：超过过亮阈值（默认 3×标准 或 2000lx 取小者附近）。
 * glare：UGR 近似超限的灯具/观察点。
 */
export function analyzeIssues(project: Project, grid: IlluminanceGrid, built: BuiltScene): LeakPoint[] {
  const issues: LeakPoint[] = [];
  const std = project.standard.requiredAvg;
  const overThresh = Math.max(std * 3, 800);

  const at = (c: number, r: number) => grid.values[r * grid.cols + c];

  for (let r = 1; r < grid.rows - 1; r += 2) {
    for (let c = 1; c < grid.cols - 1; c += 2) {
      const v = at(c, r);
      const x = grid.x0 + (c + 0.5) * grid.dx;
      const z = grid.z0 + (r + 0.5) * grid.dz;
      // 邻域最小/均值
      let minN = Infinity;
      let sumN = 0;
      let cnt = 0;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
        const vv = at(c + dc, r + dr);
        minN = Math.min(minN, vv);
        sumN += vv;
        cnt++;
      }
      const avgN = sumN / cnt;

      // 过亮
      if (v > overThresh) {
        issues.push({
          x, z, lux: v, kind: 'overbright', severity: v > overThresh * 1.6 ? 'high' : 'mid',
          message: `照度过高 ${Math.round(v)} lx（阈值 ${Math.round(overThresh)}），可能产生光斑/能源浪费`,
        });
      }

      // 疑似漏光：比邻域最暗处亮很多，且看不到任何灯
      if (v > 120 && v > minN * 4 && v > avgN * 1.8) {
        const vis = visibleLightCount(built, [x, project.space.workPlaneHeight + 0.1, z]);
        if (vis === 0) {
          issues.push({
            x, z, lux: v, kind: 'leak', severity: 'high',
            message: `无光源视线却出现局部亮斑 ${Math.round(v)} lx（邻域最低 ${Math.round(minN)}），疑似 GI 漏光/探针插值穿透`,
          });
        }
      }
    }
  }

  // 眩光：在几个典型观察点估算 UGR
  const viewpoints: Vec3[] = [
    [0, 1.2, 0],
    [-project.space.width / 4, 1.2, 0],
    [project.space.width / 4, 1.2, 0],
  ];
  for (const eye of viewpoints) {
    let sum = 0;
    let bgLum = 0.05;
    for (const l of built.mesh.lights) {
      const D = l.size[0];
      const area = Math.PI * (D / 2) * (D / 2);
      const Le = l.fluxLumens / (Math.PI * area); // cd/m2
      const toL = v3.sub(l.position, eye);
      const dist = v3.len(toL);
      const dir = v3.scale(toL, 1 / dist);
      // 灯具对观察者的立体角（近似投影面积/dist²）
      const omega = (area * Math.max(0.2, -dir[1])) / (dist * dist);
      // Guth 位置指数近似：随偏离视线增大
      const forward = [0, -0.35, -1];
      const f = v3.norm(forward as Vec3);
      const cosView = Math.max(0.05, v3.dot(dir, f));
      const pIndex = 1 / Math.pow(cosView, 3);
      sum += (Le * Le * omega) / (pIndex * pIndex);
      bgLum += Le * omega * 0.02;
    }
    if (sum > 0) {
      const ugr = 8 * Math.log10(Math.max(1e-6, (0.25 / bgLum) * sum));
      if (ugr > (project.standard.ugrLimit ?? 25)) {
        issues.push({
          x: eye[0], z: eye[2], lux: ugr, kind: 'glare', severity: ugr > 28 ? 'high' : 'mid',
          message: `该视点估算 UGR≈${ugr.toFixed(1)}，超过限值 ${project.standard.ugrLimit ?? 25}，建议加防眩格栅/选宽配光漫射器`,
        });
      }
    }
  }

  // 限制数量，按严重度
  const rank = { high: 0, mid: 1, low: 2 } as const;
  return issues.sort((a, b) => rank[a.severity] - rank[b.severity]).slice(0, 60);
}

// ---------------- 漏光自检（积分器/BVH） ----------------

function quad(tris: SceneMesh['triangles'], a: Vec3, b: Vec3, c: Vec3, d: Vec3, n: Vec3, mat: number) {
  tris.push({ v0: a, v1: b, v2: c, normal: n, mat });
  tris.push({ v0: a, v1: c, v2: d, normal: n, mat });
}

/**
 * 两个相邻封闭房间，中间整面实墙，仅左室有灯。
 * 右室测点应几乎为 0（无漏光）。再测货架薄板阴影。
 */
export function runLeakSelfTest(): { sealedLux: number; litLux: number; ratio: number; pass: boolean; shelfShadowRatio: number } {
  const W = 10, D = 6, H = 3.5;
  const mat: Material = { name: 'w', albedo: [0.8, 0.8, 0.8], reflectance: 0.8, kind: 'diffuse' };
  const mesh: SceneMesh = { triangles: [], materials: [mat], lights: [], min: [-W / 2, 0, -D / 2], max: [W / 2, H, D / 2] };
  // 围护
  quad(mesh.triangles, [-W / 2, 0, -D / 2], [-W / 2, 0, D / 2], [W / 2, 0, D / 2], [W / 2, 0, -D / 2], [0, 1, 0], 0);
  quad(mesh.triangles, [-W / 2, H, -D / 2], [W / 2, H, -D / 2], [W / 2, H, D / 2], [-W / 2, H, D / 2], [0, -1, 0], 0);
  quad(mesh.triangles, [-W / 2, 0, -D / 2], [W / 2, 0, -D / 2], [W / 2, H, -D / 2], [-W / 2, H, -D / 2], [0, 0, 1], 0);
  quad(mesh.triangles, [-W / 2, 0, D / 2], [-W / 2, H, D / 2], [W / 2, H, D / 2], [W / 2, 0, D / 2], [0, 0, -1], 0);
  quad(mesh.triangles, [-W / 2, 0, -D / 2], [-W / 2, H, -D / 2], [-W / 2, H, D / 2], [-W / 2, 0, D / 2], [1, 0, 0], 0);
  quad(mesh.triangles, [W / 2, 0, -D / 2], [W / 2, 0, D / 2], [W / 2, H, D / 2], [W / 2, H, -D / 2], [-1, 0, 0], 0);
  // 中间隔墙 x=0，整面到顶（用薄盒的两个面即可，这里用双面 quad：两个三角形顺序各给法线，求交为双面处理靠 faceforward）
  quad(mesh.triangles, [0, 0, -D / 2], [0, 0, D / 2], [0, H, D / 2], [0, H, -D / 2], [1, 0, 0], 0);
  quad(mesh.triangles, [0, 0, -D / 2], [0, H, -D / 2], [0, H, D / 2], [0, 0, D / 2], [-1, 0, 0], 0);

  mesh.lights.push({ id: 'L', position: [-2.5, H - 0.1, 0], size: [0.8, 0.05, 0.8], fluxLumens: 20000, exponent: 1, diffuserId: '' });
  const bvh = buildBVH(mesh, 4);

  const litLux = estimateIrradiance(mesh, bvh, [-2.5, 0.75, 0], [0, 1, 0], { samples: 64, bounces: 6 }, 7);
  const sealedLux = estimateIrradiance(mesh, bvh, [2.5, 0.75, 0], [0, 1, 0], { samples: 64, bounces: 6 }, 9);
  const ratio = sealedLux / Math.max(1, litLux);

  // 货架薄板阴影：灯在上方，水平薄板遮挡测点
  const mesh2: SceneMesh = { triangles: [], materials: [mat], lights: [], min: [-2, 0, -2], max: [2, 3, 2] };
  quad(mesh2.triangles, [-2, 0, -2], [-2, 0, 2], [2, 0, 2], [2, 0, -2], [0, 1, 0], 0);
  // 货架层板 y=1.2
  quad(mesh2.triangles, [-1, 1.2, -0.4], [-1, 1.2, 0.4], [1, 1.2, 0.4], [1, 1.2, -0.4], [0, 1, 0], 0);
  mesh2.lights.push({ id: 'L2', position: [0, 2.8, 0], size: [0.5, 0.05, 0.5], fluxLumens: 12000, exponent: 1, diffuserId: '' });
  const bvh2 = buildBVH(mesh2, 4);
  const underShelf = estimateIrradiance(mesh2, bvh2, [0, 0.8, 0], [0, 1, 0], { samples: 48, bounces: 4 }, 3);
  const besideShelf = estimateIrradiance(mesh2, bvh2, [1.7, 0.8, 0], [0, 1, 0], { samples: 48, bounces: 4 }, 5);
  const shelfShadowRatio = underShelf / Math.max(1, besideShelf);

  // 隔墙后照度比 < 2% 视为无漏光
  const pass = ratio < 0.02 && shelfShadowRatio < 0.5;
  return { sealedLux, litLux, ratio, pass, shelfShadowRatio };
}
