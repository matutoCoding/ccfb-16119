// BVH 构建 + CPU 光线求交 + 打包为可上传纹理的紧凑数据（GPU 着色器遍历同一布局）
import type { Vec3 } from './math3d';
import { v3 } from './math3d';
import type { SceneMesh, Triangle } from './geometry';

export interface LinearNode {
  bmin: Vec3;
  bmax: Vec3;
  /** 叶：三角形起始；内部：第一个子节点（右子=leftFirst+1） */
  leftFirst: number;
  /** 叶：三角形数；内部：0 */
  triCount: number;
}

export interface BVH {
  nodes: LinearNode[];
  /** 重排后的三角形索引（叶节点引用此数组区间） */
  triIndices: number[];
}

function triBounds(t: Triangle): { min: Vec3; max: Vec3; c: Vec3 } {
  const min = v3.min(v3.min(t.v0, t.v1), t.v2);
  const max = v3.max(v3.max(t.v0, t.v1), t.v2);
  const c: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  return { min, max, c };
}

/** 中点划分 BVH，子节点在线性数组中连续 */
export function buildBVH(mesh: SceneMesh, maxLeafTris = 4): BVH {
  const tris = mesh.triangles;
  const n = tris.length;
  const triIndices = Array.from({ length: n }, (_, i) => i);
  const centroids: Vec3[] = new Array(n);
  const bounds: { min: Vec3; max: Vec3 }[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const b = triBounds(tris[i]);
    centroids[i] = b.c;
    bounds[i] = { min: b.min, max: b.max };
  }

  const nodes: LinearNode[] = [];

  function build(lo: number, hi: number): number {
    const nodeIndex = nodes.length;
    nodes.push({
      bmin: [Infinity, Infinity, Infinity],
      bmax: [-Infinity, -Infinity, -Infinity],
      leftFirst: lo,
      triCount: hi - lo,
    });
    let bmin: Vec3 = [Infinity, Infinity, Infinity];
    let bmax: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = lo; i < hi; i++) {
      const ti = triIndices[i];
      bmin = v3.min(bmin, bounds[ti].min);
      bmax = v3.max(bmax, bounds[ti].max);
    }
    const node = nodes[nodeIndex];
    node.bmin = bmin;
    node.bmax = bmax;

    const count = hi - lo;
    if (count <= maxLeafTris) {
      node.leftFirst = lo;
      node.triCount = count;
      return nodeIndex;
    }

    // 选最长轴，按质心中点划分
    const extent = v3.sub(bmax, bmin);
    let axis = 0;
    if (extent[1] > extent[axis]) axis = 1;
    if (extent[2] > extent[axis]) axis = 2;
    const mid = (bmin[axis] + bmax[axis]) / 2;

    let split = lo;
    for (let i = lo; i < hi; i++) {
      if (centroids[triIndices[i]][axis] < mid) {
        const tmp = triIndices[i];
        triIndices[i] = triIndices[split];
        triIndices[split] = tmp;
        split++;
      }
    }
    // 退化：全都在一侧，则均分
    if (split === lo || split === hi) split = lo + (count >> 1);

    node.triCount = 0;
    // 先放一个占位子节点索引，构建左、右（保证连续）
    const left = build(lo, split);
    const right = build(split, hi);
    node.leftFirst = left;
    // 连续性断言：right === left+1 不一定成立（左子树会产生多个节点）。
    // 为满足 GPU “右=leftFirst+1” 的遍历约定，改用显式 right 字段打包。
    (node as LinearNode & { right?: number }).right = right;
    return nodeIndex;
  }

  if (n > 0) build(0, n);
  else nodes.push({ bmin: [0, 0, 0], bmax: [1, 1, 1], leftFirst: 0, triCount: 0 });

  return { nodes, triIndices };
}

// ---- 打包为纹理数据 ----

export interface PackedBVH {
  /** 每节点 2 个 RGBA32F texel */
  nodeData: Float32Array;
  nodeTexWidth: number; // texel 宽（每行节点数 *2 排布由上传层决定，这里给扁平）
  nodeCount: number;
  /** 每三角形 4 texel */
  triData: Float32Array;
  triCount: number;
  /** 每材质 3 texel */
  matData: Float32Array;
  matCount: number;
}

/**
 * 节点布局（每节点 2 texel，顺序扁平）：
 *  [2i+0] = bmin.xyz, leftFirst(float)
 *  [2i+1] = bmax.xyz, meta：叶=triCount(>0)；内部= -(rightIndex+1)（编码为负）
 * 着色器：若 meta.y? 这里 alpha=meta；alpha>0 为叶且=triCount；否则 right= -alpha-1。
 * 注意 leftFirst 对内部是左子节点索引，对叶是三角形数据起始（triIndices 重排后的位置）。
 */
export function packBVH(mesh: SceneMesh, bvh: BVH): PackedBVH {
  const nodeCount = bvh.nodes.length;
  const nodeData = new Float32Array(nodeCount * 2 * 4);
  bvh.nodes.forEach((node, i) => {
    const o = i * 8;
    nodeData[o + 0] = node.bmin[0];
    nodeData[o + 1] = node.bmin[1];
    nodeData[o + 2] = node.bmin[2];
    nodeData[o + 3] = node.leftFirst;
    nodeData[o + 4] = node.bmax[0];
    nodeData[o + 5] = node.bmax[1];
    nodeData[o + 6] = node.bmax[2];
    const right = (node as LinearNode & { right?: number }).right;
    if (node.triCount > 0) {
      nodeData[o + 7] = node.triCount; // 叶 > 0
    } else {
      nodeData[o + 7] = -(right! + 1); // 内部 < 0
    }
  });

  // 三角形按重排顺序打包；叶 leftFirst 指向 triIndices 数组位置，
  // 因此 triData 也按 “重排后” 顺序写，第 k 个 texel-block 即 triIndices[k]。
  const triCount = bvh.triIndices.length;
  const triData = new Float32Array(triCount * 4 * 4);
  bvh.triIndices.forEach((origIdx, k) => {
    const t = mesh.triangles[origIdx];
    const o = k * 16;
    triData[o + 0] = t.v0[0];
    triData[o + 1] = t.v0[1];
    triData[o + 2] = t.v0[2];
    triData[o + 3] = t.mat;
    triData[o + 4] = t.v1[0];
    triData[o + 5] = t.v1[1];
    triData[o + 6] = t.v1[2];
    triData[o + 7] = 0;
    triData[o + 8] = t.v2[0];
    triData[o + 9] = t.v2[1];
    triData[o + 10] = t.v2[2];
    triData[o + 11] = 0;
    triData[o + 12] = t.normal[0];
    triData[o + 13] = t.normal[1];
    triData[o + 14] = t.normal[2];
    triData[o + 15] = 0;
  });

  const matCount = mesh.materials.length;
  const matData = new Float32Array(matCount * 3 * 4);
  mesh.materials.forEach((m, i) => {
    const o = i * 12;
    matData[o + 0] = m.albedo[0];
    matData[o + 1] = m.albedo[1];
    matData[o + 2] = m.albedo[2];
    matData[o + 3] = m.reflectance;
    const em = m.emission ?? [0, 0, 0];
    matData[o + 4] = em[0];
    matData[o + 5] = em[1];
    matData[o + 6] = em[2];
    matData[o + 7] = m.transmittance ?? 0;
    matData[o + 8] = m.kind === 'diffuse' ? 0 : m.kind === 'emitter' ? 1 : 2;
    matData[o + 9] = 0;
    matData[o + 10] = 0;
    matData[o + 11] = 0;
  });

  return { nodeData, nodeTexWidth: 0, nodeCount, triData, triCount, matData, matCount };
}

// ---------------- CPU 光线求交 ----------------

export interface RayHit {
  t: number;
  u: number;
  v: number;
  triIndex: number; // 原始 triangle 索引
  mat: number;
  point: Vec3;
  normal: Vec3;
}

interface Ray {
  ox: number;
  oy: number;
  oz: number;
  dx: number;
  dy: number;
  dz: number;
}

function rayBox(
  r: Ray,
  bmin: Vec3,
  bmax: Vec3,
  tMin: number,
  tMax: number,
): boolean {
  // 分轴 slab
  let inv = 1 / r.dx;
  let t0 = (bmin[0] - r.ox) * inv;
  let t1 = (bmax[0] - r.ox) * inv;
  if (inv < 0) [t0, t1] = [t1, t0];
  let lo = t0;
  let hi = t1;
  inv = 1 / r.dy;
  t0 = (bmin[1] - r.oy) * inv;
  t1 = (bmax[1] - r.oy) * inv;
  if (inv < 0) [t0, t1] = [t1, t0];
  lo = Math.max(lo, t0);
  hi = Math.min(hi, t1);
  if (hi < lo || hi < tMin || lo > tMax) return false;
  inv = 1 / r.dz;
  t0 = (bmin[2] - r.oz) * inv;
  t1 = (bmax[2] - r.oz) * inv;
  if (inv < 0) [t0, t1] = [t1, t0];
  lo = Math.max(lo, t0);
  hi = Math.min(hi, t1);
  return hi >= lo && hi >= tMin && lo <= tMax;
}

const EPS_T = 1e-7;

function rayTriangle(
  r: Ray,
  t: Triangle,
): { t: number; u: number; v: number } | null {
  const e1 = v3.sub(t.v1, t.v0);
  const e2 = v3.sub(t.v2, t.v0);
  const dir: Vec3 = [r.dx, r.dy, r.dz];
  const orig: Vec3 = [r.ox, r.oy, r.oz];
  const p = v3.cross(dir, e2);
  const det = v3.dot(e1, p);
  if (Math.abs(det) < 1e-9) return null;
  const invDet = 1 / det;
  const tv = v3.sub(orig, t.v0);
  const u = v3.dot(tv, p) * invDet;
  if (u < 0 || u > 1) return null;
  const q = v3.cross(tv, e1);
  const v = v3.dot(dir, q) * invDet;
  if (v < 0 || u + v > 1) return null;
  const tt = v3.dot(e2, q) * invDet;
  if (tt < EPS_T) return null;
  return { t: tt, u, v };
}

/** 最近交点；glass 也作为交点返回（由调用方决定透射） */
export function traceRay(
  mesh: SceneMesh,
  bvh: BVH,
  origin: Vec3,
  dir: Vec3,
  maxDist = 1e4,
): RayHit | null {
  const r: Ray = {
    ox: origin[0],
    oy: origin[1],
    oz: origin[2],
    dx: dir[0] || 1e-12,
    dy: dir[1] || 1e-12,
    dz: dir[2] || 1e-12,
  };
  let closest = maxDist;
  let hit: RayHit | null = null;

  // 遍历栈
  const stack: number[] = [0];
  while (stack.length) {
    const ni = stack.pop()!;
    const node = bvh.nodes[ni];
    if (!rayBox(r, node.bmin, node.bmax, 0, closest)) continue;
    if (node.triCount > 0) {
      for (let k = node.leftFirst; k < node.leftFirst + node.triCount; k++) {
        const origIdx = bvh.triIndices[k];
        const tri = mesh.triangles[origIdx];
        const h = rayTriangle(r, tri);
        if (h && h.t < closest) {
          closest = h.t;
          const p = v3.add(origin, v3.scale(dir, h.t));
          hit = {
            t: h.t,
            u: h.u,
            v: h.v,
            triIndex: origIdx,
            mat: tri.mat,
            point: p,
            normal: tri.normal,
          };
        }
      }
    } else {
      const right = (node as LinearNode & { right?: number }).right!;
      // 近的先入栈（远的先 pop 顺序优化，非必须）
      stack.push(node.leftFirst, right);
    }
  }
  return hit;
}

/** 阴影遮挡：遇到不透明材质即遮挡；玻璃按透射概率/比例衰减。返回透射系数 0~1 */
export function shadowTransmission(
  mesh: SceneMesh,
  bvh: BVH,
  origin: Vec3,
  dir: Vec3,
  maxDist: number,
  rng?: () => number,
): number {
  let throughput = 1;
  let o: Vec3 = origin;
  let d = dir;
  let remaining = maxDist;
  for (let bounce = 0; bounce < 4; bounce++) {
    const hit = traceRay(mesh, bvh, o, d, remaining);
    if (!hit) return throughput;
    const mat = mesh.materials[hit.mat];
    if (mat.kind === 'glass') {
      const T = mat.transmittance ?? 0.7;
      // 随机/确定性按比例衰减能量（这里直接乘，近似累积）
      throughput *= T;
      // 偏移后继续
      o = v3.add(hit.point, v3.scale(hit.normal, -1e-3));
      // 若法线与方向同向（背面），用 +normal
      if (v3.dot(hit.normal, d) > 0) o = v3.add(hit.point, v3.scale(hit.normal, 1e-3));
      remaining -= hit.t;
      if (remaining <= 0 || throughput < 0.02) return throughput;
      continue;
    }
    // 漫射/发光不透明
    if (rng) return 0; // 随机路径下硬遮挡
    return 0;
  }
  return throughput;
}
