import type { PipeCatalog, Project, Vec3 } from '../types';
import { buildSceneMesh, type MeshData } from '../core/geometry/mesh';
import { buildBvh, type BvhData } from '../core/geometry/bvh';
import { buildProbeGrid, type ProbeGrid } from '../core/gi/probes';
import { buildSkyField, verticalIlluminance, type SkyField } from '../core/sky/sky';
import { computePipeOutput } from '../core/pipes/catalog';
import { GlEngine } from './glEngine';

export interface SimSnapshot {
  mesh: MeshData;
  bvh: BvhData;
  grid: ProbeGrid;
  sky: SkyField;
  pipeOutputs: Map<string, { lumens: number; radiance: number; efficiency: number }>;
  totalLumens: number;
}

/** 由项目定义构建一整套仿真资源（不含 GPU 纹理，纹理由 engine.setScene 上传） */
export function buildSimulation(project: Project, catalog: PipeCatalog): SimSnapshot {
  const scheme = project.schemes.find((s) => s.id === project.activeSchemeId);
  const pipes = scheme?.pipes ?? [];
  const mesh = buildSceneMesh(project, pipes);
  const bvh = buildBvh(mesh.tris);
  const grid = buildProbeGrid(mesh.bounds, project.probe.spacing);
  const sky = buildSkyField(project.sky, 256);

  const pipeOutputs = new Map<string, { lumens: number; radiance: number; efficiency: number }>();
  let totalLumens = 0;
  for (const pipe of pipes) {
    if (!pipe.enabled) continue;
    const out = computePipeOutput(pipe, catalog, sky);
    pipeOutputs.set(pipe.id, {
      lumens: out.outputLumens,
      radiance: out.radiance,
      efficiency: out.totalEfficiency,
    });
    totalLumens += out.outputLumens;
  }
  return { mesh, bvh, grid, sky, pipeOutputs, totalLumens };
}

/** 计算各发光面材质 radiance（cd/m²）并推送到 GPU */
export function uploadEmissives(
  engine: GlEngine,
  project: Project,
  snap: SimSnapshot,
): Map<number, Vec3> {
  const em = new Map<number, Vec3>();
  const lights: { center: Vec3; normal: Vec3; area: number; radiance: Vec3 }[] = [];
  for (const patch of snap.mesh.patches) {
    if (patch.kind === 'diffuser') {
      const out = snap.pipeOutputs.get(patch.refId ?? patch.id);
      if (!out) continue;
      const rad: Vec3 = [out.radiance, out.radiance, out.radiance];
      em.set(patch.matId, rad);
      lights.push({ center: patch.center, normal: patch.normal, area: patch.area, radiance: rad });
    } else {
      // 窗：竖直面入射照度 → 朗伯玻璃出射亮度（玻璃透射按 0.7 计入）
      const n = windowOutwardNormal(patch.center, project);
      const ev = verticalIlluminance(snap.sky, n);
      const glassTrans = 0.7;
      const radiance = (ev * glassTrans) / Math.PI;
      const rad: Vec3 = [radiance, radiance * 0.98, radiance * 0.95];
      em.set(patch.matId, rad);
      lights.push({ center: patch.center, normal: patch.normal, area: patch.area, radiance: rad });
    }
  }
  engine.setEmissives(em);
  engine.setLightPatches(lights);
  return em;
}

function windowOutwardNormal(c: Vec3, project: Project): Vec3 {
  const { width, depth } = project.room;
  if (Math.abs(c[2]) < 0.2) return [0, 0, 1];
  if (Math.abs(c[2] - depth) < 0.2) return [0, 0, -1];
  if (Math.abs(c[0]) < 0.2) return [1, 0, 0];
  return [-1, 0, 0];
}

/** 全年评估用：改时刻后重算天空与发光面（几何不变） */
export function rebuildSkyOnly(project: Project, catalog: PipeCatalog, snap: SimSnapshot): SimSnapshot {
  const sky = buildSkyField(project.sky, 128);
  const pipeOutputs = new Map(snap.pipeOutputs);
  const scheme = project.schemes.find((s) => s.id === project.activeSchemeId);
  let totalLumens = 0;
  for (const pipe of scheme?.pipes ?? []) {
    if (!pipe.enabled) continue;
    const out = computePipeOutput(pipe, catalog, sky);
    pipeOutputs.set(pipe.id, {
      lumens: out.outputLumens,
      radiance: out.radiance,
      efficiency: out.totalEfficiency,
    });
    totalLumens += out.outputLumens;
  }
  return { ...snap, sky, pipeOutputs, totalLumens };
}
