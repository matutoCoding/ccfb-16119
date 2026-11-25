import type { BoxObject, Project, Vec3 } from '../../types';
import { v3 } from '../math/vec3';

export interface Material {
  id: number;
  name: string;
  albedo: Vec3;
  emissive: Vec3; // 动态发光（窗/漫射器）每帧更新
  roughness: number;
}

export interface Tri {
  v0: Vec3;
  e1: Vec3; // v1-v0
  e2: Vec3; // v2-v0
  mat: number;
}

export interface SurfacePatch {
  // 发光面（窗 / 漫射器）描述，供光通量计算
  id: string;
  kind: 'window' | 'diffuser';
  center: Vec3;
  normal: Vec3;
  area: number;
  matId: number;
  refId?: string;
}

export interface RenderInstance {
  center: Vec3;
  size: Vec3;
  rotationY: number;
  matId: number;
}

export interface MeshData {
  tris: Tri[];
  materials: Material[];
  patches: SurfacePatch[];
  instances: RenderInstance[];
  bounds: { min: Vec3; max: Vec3 };
}

function addQuad(
  tris: Tri[],
  a: Vec3,
  b: Vec3,
  c: Vec3,
  d: Vec3,
  mat: number,
): void {
  tris.push({ v0: a, e1: v3.sub(b, a), e2: v3.sub(c, a), mat });
  tris.push({ v0: a, e1: v3.sub(c, a), e2: v3.sub(d, a), mat });
}

function boxCorners(center: Vec3, size: Vec3, rotY: number): Vec3[] {
  const h: Vec3 = [size[0] / 2, size[1] / 2, size[2] / 2];
  const local: Vec3[] = [
    [-h[0], -h[1], -h[2]], [h[0], -h[1], -h[2]],
    [h[0], -h[1], h[2]], [-h[0], -h[1], h[2]],
    [-h[0], h[1], -h[2]], [h[0], h[1], -h[2]],
    [h[0], h[1], h[2]], [-h[0], h[1], h[2]],
  ];
  const cs = Math.cos(rotY);
  const sn = Math.sin(rotY);
  return local.map((p): Vec3 => [
    center[0] + cs * p[0] + sn * p[2],
    center[1] + p[1],
    center[2] - sn * p[0] + cs * p[2],
  ]);
}

function addBox(tris: Tri[], corners: Vec3[], mat: number): void {
  const f = [
    [0, 1, 2, 3], // 底
    [4, 7, 6, 5], // 顶
    [0, 4, 5, 1],
    [1, 5, 6, 2],
    [2, 6, 7, 3],
    [3, 7, 4, 0],
  ];
  for (const q of f) addQuad(tris, corners[q[0]], corners[q[1]], corners[q[2]], corners[q[3]], mat);
}

/** 由项目定义生成全部三角面（房间围护 + 柱网梁柱货架 + 窗 + 漫射器） */
export function buildSceneMesh(project: Project, schemePipes = project.schemes.find(
  (s) => s.id === project.activeSchemeId,
)?.pipes ?? []): MeshData {
  const { room } = project;
  const W = room.width;
  const D = room.depth;
  const H = room.height;
  const tris: Tri[] = [];
  const materials: Material[] = [];
  const patches: SurfacePatch[] = [];
  const instances: RenderInstance[] = [];

  const mat = (name: string, albedo: Vec3, roughness = 0.9): number => {
    const id = materials.length;
    materials.push({ id, name, albedo, emissive: [0, 0, 0], roughness });
    return id;
  };

  const floorMat = mat('地面', [room.floorReflectance, room.floorReflectance, room.floorReflectance], 0.95);
  const ceilMat = mat('顶棚', [room.ceilingReflectance, room.ceilingReflectance, room.ceilingReflectance], 0.9);
  const wallMat = mat('墙面', [room.wallReflectance, room.wallReflectance, room.wallReflectance], 0.92);

  // 围护结构：底面 y=0、顶面 y=H、四面墙
  const t = 0.2;
  addQuad(tris, [0, 0, 0], [0, 0, D], [W, 0, D], [W, 0, 0], floorMat);
  addQuad(tris, [0, H, 0], [W, H, 0], [W, H, D], [0, H, D], ceilMat);
  addQuad(tris, [0, 0, 0], [W, 0, 0], [W, H, 0], [0, H, 0], wallMat); // z=0
  addQuad(tris, [W, 0, 0], [W, 0, D], [W, H, D], [W, H, 0], wallMat);
  addQuad(tris, [W, 0, D], [0, 0, D], [0, H, D], [W, H, D], wallMat);
  addQuad(tris, [0, 0, D], [0, 0, 0], [0, H, 0], [0, H, D], wallMat);
  instances.push(
    { center: [W / 2, -t / 2, D / 2], size: [W + 2 * t, t, D + 2 * t], rotationY: 0, matId: floorMat },
    { center: [W / 2, H + t / 2, D / 2], size: [W + 2 * t, t, D + 2 * t], rotationY: 0, matId: ceilMat },
    { center: [W / 2, H / 2, -t / 2], size: [W + 2 * t, H, t], rotationY: 0, matId: wallMat },
    { center: [W / 2, H / 2, D + t / 2], size: [W + 2 * t, H, t], rotationY: 0, matId: wallMat },
    { center: [-t / 2, H / 2, D / 2], size: [t, H, D + 2 * t], rotationY: 0, matId: wallMat },
    { center: [W + t / 2, H / 2, D / 2], size: [t, H, D + 2 * t], rotationY: 0, matId: wallMat },
  );

  // 场景物体
  for (const obj of project.objects) {
    if (obj.kind === 'window') {
      // 窗：贴在内墙表面的发光面板（避免在墙上开洞的 CSG），比墙内移 5mm
      const m = mat(`窗-${obj.name}`, [0.1, 0.1, 0.1], 0.2);
      const c = obj.center;
      const hx = obj.size[0] / 2;
      const hy = obj.size[1] / 2;
      // 依据位置判断朝向哪面墙
      const eps = 0.005;
      let corners: Vec3[];
      if (Math.abs(c[2] - 0) < 0.2 || Math.abs(c[2] - D) < 0.2) {
        const z = c[2] < D / 2 ? eps : D - eps;
        corners = [
          [c[0] - hx, c[1] - hy, z], [c[0] + hx, c[1] - hy, z],
          [c[0] + hx, c[1] + hy, z], [c[0] - hx, c[1] + hy, z],
        ];
      } else {
        const x = c[0] < W / 2 ? eps : W - eps;
        corners = [
          [x, c[1] - hy, c[2] - hx], [x, c[1] - hy, c[2] + hx],
          [x, c[1] + hy, c[2] + hx], [x, c[1] + hy, c[2] - hx],
        ];
      }
      addQuad(tris, corners[0], corners[1], corners[2], corners[3], m);
      instances.push({
        center: [...c] as Vec3,
        size: [obj.size[0], obj.size[1], Math.max(obj.size[2], 0.02)],
        rotationY: obj.rotationY,
        matId: m,
      });
      patches.push({
        id: obj.id,
        kind: 'window',
        center: [...c] as Vec3,
        normal: [0, 0, 0],
        area: obj.size[0] * obj.size[1],
        matId: m,
      });
      continue;
    }
    const m = mat(`${obj.kind}-${obj.name}`, obj.color, obj.kind === 'beam' ? 0.85 : 0.9);
    addBox(tris, boxCorners(obj.center, obj.size, obj.rotationY), m);
    instances.push({
      center: [...obj.center] as Vec3,
      size: [...obj.size] as Vec3,
      rotationY: obj.rotationY,
      matId: m,
    });
  }

  // 导光管漫射器：顶棚下 3cm 的发光圆盘（用四边形近似），每管独立发光材质
  for (const pipe of schemePipes) {
    if (!pipe.enabled) continue;
    const m = mat(`漫射器-${pipe.name}`, [0.8, 0.8, 0.8], 0.4);
    const r = pipe.diameter / 2;
    const y = H - 0.03;
    const c: Vec3 = [pipe.x, y, pipe.z];
    addQuad(
      tris,
      [pipe.x - r, y, pipe.z - r],
      [pipe.x + r, y, pipe.z - r],
      [pipe.x + r, y, pipe.z + r],
      [pipe.x - r, y, pipe.z + r],
      m,
    );
    patches.push({
      id: pipe.id,
      kind: 'diffuser',
      center: c,
      normal: [0, -1, 0],
      area: Math.PI * r * r,
      matId: m,
      refId: pipe.id,
    });
    instances.push({
      center: c,
      size: [pipe.diameter, 0.02, pipe.diameter],
      rotationY: 0,
      matId: m,
    });
  }

  return {
    tris,
    materials,
    patches,
    instances,
    bounds: { min: [0, 0, 0], max: [W, H, D] },
  };
}
