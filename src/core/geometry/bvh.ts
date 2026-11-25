import type { Vec3 } from '../../types';
import type { Tri } from './mesh';
import { v3 } from '../math/vec3';

export interface BvhNode {
  min: Vec3;
  max: Vec3;
  left: number;  // 叶子：-(triStart+1)；内部：左孩子下标
  right: number; // 叶子：-1；内部：右孩子下标
  count: number; // 0=内部节点
  triStart: number;
}

export interface BvhData {
  nodes: BvhNode[];
  triIndices: Uint32Array;
}

interface Ray {
  origin: Vec3;
  dir: Vec3;
  tmin: number;
  tmax: number;
}

export interface HitResult {
  t: number;
  triIndex: number;
  normal: Vec3;
}

function triBounds(t: Tri): { min: Vec3; max: Vec3 } {
  const v1 = v3.add(t.v0, t.e1);
  const v2 = v3.add(t.v0, t.e2);
  const min: Vec3 = [
    Math.min(t.v0[0], v1[0], v2[0]),
    Math.min(t.v0[1], v1[1], v2[1]),
    Math.min(t.v0[2], v1[2], v2[2]),
  ];
  const max: Vec3 = [
    Math.max(t.v0[0], v1[0], v2[0]),
    Math.max(t.v0[1], v1[1], v2[1]),
    Math.max(t.v0[2], v1[2], v2[2]),
  ];
  return { min, max };
}

function mergeBounds(acc: { min: Vec3; max: Vec3 }, b: { min: Vec3; max: Vec3 }): void {
  for (let k = 0; k < 3; k++) {
    acc.min[k] = Math.min(acc.min[k], b.min[k]);
    acc.max[k] = Math.max(acc.max[k], b.max[k]);
  }
}

const LEAF_SIZE = 4;

export function buildBvh(tris: Tri[]): BvhData {
  const triIndices = new Uint32Array(tris.map((_, i) => i));
  const nodes: BvhNode[] = [];
  const centers = tris.map((t) => v3.add(t.v0, v3.scale(v3.add(t.e1, t.e2), 1 / 3)));

  const makeLeaf = (start: number, count: number): number => {
    const bounds = { min: [Infinity, Infinity, Infinity] as Vec3, max: [-Infinity, -Infinity, -Infinity] as Vec3 };
    for (let i = start; i < start + count; i++) mergeBounds(bounds, triBounds(tris[triIndices[i]]));
    const idx = nodes.length;
    nodes.push({ min: bounds.min, max: bounds.max, left: -(start + 1), right: -1, count, triStart: start });
    return idx;
  };

  const recurse = (start: number, count: number): number => {
    if (count <= LEAF_SIZE) return makeLeaf(start, count);
    const bounds = { min: [Infinity, Infinity, Infinity] as Vec3, max: [-Infinity, -Infinity, -Infinity] as Vec3 };
    for (let i = start; i < start + count; i++) mergeBounds(bounds, triBounds(tris[triIndices[i]]));
    const extent: Vec3 = [
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2],
    ];
    const axis = extent[0] > extent[1] && extent[0] > extent[2] ? 0 : extent[1] > extent[2] ? 1 : 2;
    const slice = Array.from(triIndices.slice(start, start + count));
    slice.sort((a, b) => centers[a][axis] - centers[b][axis]);
    for (let i = 0; i < slice.length; i++) triIndices[start + i] = slice[i];
    // 保证两半都非空
    let mid = start + Math.max(1, Math.floor(count / 2));
    if (mid >= start + count) mid = start + count - 1;
    const leftIdx = recurse(start, mid - start);
    const rightIdx = recurse(mid, start + count - mid);
    const idx = nodes.length;
    nodes.push({ min: bounds.min, max: bounds.max, left: leftIdx, right: rightIdx, count: 0, triStart: -1 });
    return idx;
  };

  if (tris.length > 0) {
    const root = recurse(0, tris.length);
    // 自底向上构建后根节点在末尾，交换到下标 0 并修正所有孩子引用
    if (root !== 0) {
      const oldRoot = nodes[root];
      const oldZero = nodes[0];
      nodes[root] = oldZero;
      nodes[0] = oldRoot;
      for (const n of nodes) {
        if (n.count === 0) {
          if (n.left === root) n.left = 0;
          else if (n.left === 0) n.left = root;
          if (n.right === root) n.right = 0;
          else if (n.right === 0) n.right = root;
        }
      }
    }
  } else {
    nodes.push({ min: [0, 0, 0], max: [0, 0, 0], left: -1, right: -1, count: 0, triStart: 0 });
  }
  return { nodes, triIndices };
}

function intersectAABB(ray: Ray, min: Vec3, max: Vec3): boolean {
  let t0 = ray.tmin;
  let t1 = ray.tmax;
  for (let k = 0; k < 3; k++) {
    const inv = 1 / ray.dir[k];
    let ta = (min[k] - ray.origin[k]) * inv;
    let tb = (max[k] - ray.origin[k]) * inv;
    if (inv < 0) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t1 < t0) return false;
  }
  return true;
}

// Möller–Trumbore
function intersectTri(ray: Ray, t: Tri): number | null {
  const p = v3.cross(ray.dir, t.e2);
  const det = v3.dot(t.e1, p);
  if (Math.abs(det) < 1e-9) return null;
  const invDet = 1 / det;
  const tv = v3.sub(ray.origin, t.v0);
  const u = v3.dot(tv, p) * invDet;
  if (u < 0 || u > 1) return null;
  const q = v3.cross(tv, t.e1);
  const w = v3.dot(ray.dir, q) * invDet;
  if (w < 0 || u + w > 1) return null;
  const tt = v3.dot(t.e2, q) * invDet;
  if (tt < ray.tmin || tt > ray.tmax) return null;
  return tt;
}

export function traceRay(bvh: BvhData, tris: Tri[], ray: Ray): HitResult | null {
  const stack: number[] = [0];
  let bestT = ray.tmax;
  let bestTri = -1;
  while (stack.length) {
    const ni = stack.pop()!;
    const n = bvh.nodes[ni];
    if (!intersectAABB(ray, n.min, n.max)) continue;
    if (n.count > 0) {
      for (let i = n.triStart; i < n.triStart + n.count; i++) {
        const ti = bvh.triIndices[i];
        const t = intersectTri(ray, tris[ti]);
        if (t !== null && t < bestT) {
          bestT = t;
          bestTri = ti;
        }
      }
    } else {
      stack.push(n.left, n.right);
    }
  }
  if (bestTri < 0) return null;
  const tr = tris[bestTri];
  let normal = v3.cross(tr.e1, tr.e2);
  const l = v3.len(normal) || 1;
  normal = v3.scale(normal, 1 / l);
  if (v3.dot(normal, ray.dir) > 0) normal = v3.neg(normal); // 双面
  return { t: bestT, triIndex: bestTri, normal };
}

/** 阴影射线：区间内是否有遮挡 */
export function occluded(bvh: BvhData, tris: Tri[], origin: Vec3, dir: Vec3, tmax: number): boolean {
  const hit = traceRay(bvh, tris, { origin, dir, tmin: 1e-4, tmax: tmax - 1e-4 });
  return hit !== null;
}

/** 打包为纹理浮点数组：节点每节点 2 个 RGBA 纹素，三角形每三角 3 个 RGBA 纹素 */
export function packBvhTextures(bvh: BvhData, tris: Tri[]): {
  nodeTex: Float32Array; // nodes*2 * 4
  triTex: Float32Array; // tris*3 * 4
  nodeTexWidth: number;
  triTexWidth: number;
} {
  const nodeTex = new Float32Array(bvh.nodes.length * 2 * 4);
  bvh.nodes.forEach((n, i) => {
    const o = i * 8;
    nodeTex[o] = n.min[0]; nodeTex[o + 1] = n.min[1]; nodeTex[o + 2] = n.min[2];
    // 叶子：-(triStart+1)；内部：左孩子下标（非负）
    nodeTex[o + 3] = n.count > 0 ? -(n.triStart + 1) : n.left;
    nodeTex[o + 4] = n.max[0]; nodeTex[o + 5] = n.max[1]; nodeTex[o + 6] = n.max[2];
    // 叶子：count（正）；内部：右孩子下标取负再 -1，保证恒 < 0，与叶子区分
    nodeTex[o + 7] = n.count > 0 ? n.count : -n.right - 1;
  });
  const triTex = new Float32Array(tris.length * 3 * 4);
  tris.forEach((t, i) => {
    const o = i * 12;
    triTex[o] = t.v0[0]; triTex[o + 1] = t.v0[1]; triTex[o + 2] = t.v0[2]; triTex[o + 3] = t.mat;
    triTex[o + 4] = t.e1[0]; triTex[o + 5] = t.e1[1]; triTex[o + 6] = t.e1[2]; triTex[o + 7] = 0;
    triTex[o + 8] = t.e2[0]; triTex[o + 9] = t.e2[1]; triTex[o + 10] = t.e2[2]; triTex[o + 11] = 0;
  });
  return {
    nodeTex,
    triTex,
    nodeTexWidth: bvh.nodes.length * 2,
    triTexWidth: tris.length * 3,
  };
}
