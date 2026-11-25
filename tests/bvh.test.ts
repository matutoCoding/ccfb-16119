import { describe, it, expect } from 'vitest';
import { buildBvh, traceRay, occluded, packBvhTextures } from '../src/core/geometry/bvh';
import type { Tri } from '../src/core/geometry/mesh';

function tri(v0: [number, number, number], e1: [number, number, number], e2: [number, number, number], mat = 0): Tri {
  return { v0, e1, e2, mat };
}

// 一个 10×10×10 封闭盒（12 三角），原点在地面角点
function roomTris(): Tri[] {
  const T: Tri[] = [];
  const q = (a: any, b: any, c: any, d: any) => {
    T.push(tri(a, [b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]));
    T.push(tri(a, [c[0] - a[0], c[1] - a[1], c[2] - a[2]], [d[0] - a[0], d[1] - a[1], d[2] - a[2]]));
  };  q([0, 0, 0], [0, 0, 10], [10, 0, 10], [10, 0, 0]); // 地
  q([0, 10, 0], [10, 10, 0], [10, 10, 10], [0, 10, 10]); // 顶
  q([0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]);
  q([10, 0, 0], [10, 0, 10], [10, 10, 10], [10, 10, 0]);
  q([10, 0, 10], [0, 0, 10], [0, 10, 10], [10, 10, 10]);
  q([0, 0, 10], [0, 0, 0], [0, 10, 0], [0, 10, 10]);
  return T;
}

describe('BVH', () => {
  it('构建并射线命中墙面', () => {
    const tris = roomTris();
    const bvh = buildBvh(tris);
    expect(bvh.nodes.length).toBeGreaterThan(1);
    // 从中心朝上打 → 命中顶棚 t≈5
    const hit = traceRay(bvh, tris, { origin: [5, 5, 5], dir: [0, 1, 0], tmin: 0.01, tmax: 100 });
    expect(hit).not.toBeNull();
    expect(hit!.t).toBeCloseTo(5, 4);
  });

  it('封闭房间任意方向都命中（无漏射线）', () => {
    const tris = roomTris();
    const bvh = buildBvh(tris);
    const dirs = [
      [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
      [0.3, 0.8, 0.5], [-0.4, 0.2, -0.9],
    ];
    for (const d of dirs) {
      const l = Math.hypot(...d);
      const dir = d.map((x) => x / l) as [number, number, number];
      const hit = traceRay(bvh, tris, { origin: [5, 5, 5], dir, tmin: 0.01, tmax: 100 });
      expect(hit, `方向 ${d} 必须命中`).not.toBeNull();
    }
  });

  it('遮挡查询：中间放隔板后两侧互不可见', () => {
    const tris = roomTris();
    // x=5 处竖一块覆盖 y/z 全范围的隔板（两个三角，非退化绕序）
    tris.push(tri([5, 0, 0], [0, 10, 0], [0, 10, 10]));
    tris.push(tri([5, 0, 0], [0, 10, 10], [0, 0, 10]));
    const bvh = buildBvh(tris);
    // 隔板左侧 (2,5,5) 朝右打 4m：在 x=5 处被挡
    expect(occluded(bvh, tris, [2, 5, 5], [1, 0, 0], 4)).toBe(true);
    // 隔板右侧 (8,5,5) 朝左打：同样被挡
    expect(occluded(bvh, tris, [8, 5, 5], [-1, 0, 0], 4)).toBe(true);
    // 沿 z 向不跨隔板：2m 内无遮挡
    expect(occluded(bvh, tris, [2, 5, 5], [0, 0, 1], 2)).toBe(false);
  });

  it('纹理打包字段与节点一致', () => {
    const tris = roomTris();
    const bvh = buildBvh(tris);
    const packed = packBvhTextures(bvh, tris);
    expect(packed.nodeTex.length).toBe(bvh.nodes.length * 8);
    expect(packed.triTex.length).toBe(tris.length * 12);
    // 根节点包围盒覆盖 0..10
    expect(packed.nodeTex[0]).toBe(0);
    expect(packed.nodeTex[4 + 0]).toBe(10);
  });
});
