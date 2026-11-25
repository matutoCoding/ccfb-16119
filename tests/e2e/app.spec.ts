import { test, expect, type Page } from '@playwright/test';

async function openFactory(page: Page) {
  await page.goto('/');
  await page.waitForSelector('text=项目列表');
  await page.click('text=新建带货架老厂房（示例）');
  await page.waitForSelector('canvas.gl-canvas');
}

async function sampleWorkPlane(page: Page) {
  return page.evaluate(() => {
    const v = (window as any).__tds;
    const engine = v?.glEngine;
    const store = (window as any).__store;
    if (!engine) return null;
    const p = store.current;
    const raw = engine.renderWorkPlane(p.probe.workPlaneHeight, 40, 30, 0, 1, p.standardMinLux);
    const lux: number[] = [];
    for (let i = 0; i < raw.length; i += 4) lux.push(raw[i]);
    return {
      max: Math.max(...lux),
      avg: lux.reduce((a: number, b: number) => a + b, 0) / lux.length,
      positive: lux.filter((x) => x > 1).length,
      finite: lux.every((x) => Number.isFinite(x) && x >= 0),
      frame: engine.frame,
      probeCount: v.snapshot.grid.positions.length,
      fps: engine.fps,
    };
  });
}

test.describe('DDGI 浏览器端验收（SwiftShader 软件渲染）', () => {
  test.beforeEach(async () => {
    // 软件渲染降低负载，保证 CI 可跑
  });

  test('探针网格建立并持续渲染，无 WebGL 致命错误', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await openFactory(page);
    await page.waitForTimeout(3000);
    const s = await sampleWorkPlane(page);
    expect(s).not.toBeNull();
    expect(s!.probeCount).toBeGreaterThan(50);
    expect(s!.frame).toBeGreaterThan(0);
    const fatal = errors.filter((e) => /着色器|shader|framebuffer|FLOAT|WebGL/i.test(e));
    expect(fatal).toEqual([]);
  });

  test('工作面照度随收敛建立，数值有限且物理合理', async ({ page }) => {
    await openFactory(page);
    // 轻负载：稀疏探针、少光线、每帧全量更新，加速软件渲染下的收敛
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      const store = (window as any).__store;
      store.mutate((p: any) => {
        p.probe.spacing = 4;
        p.probe.raysPerProbe = 48;
        p.probe.probesPerFrame = 400;
      });
    });
    await page.waitForTimeout(6000);
    const early = await sampleWorkPlane(page);
    await page.waitForTimeout(12000);
    const later = await sampleWorkPlane(page);
    console.log('EARLY', JSON.stringify(early), 'LATER', JSON.stringify(later));
    expect(later!.finite).toBe(true);
    expect(later!.max).toBeGreaterThan(5);
    expect(later!.max).toBeLessThan(30000);
    expect(later!.positive).toBeGreaterThan(0);
  });

  test('修改反射率触发场景重建与重新收敛（动态 GI 可见）', async ({ page }) => {
    await openFactory(page);
    await page.waitForTimeout(3000);
    const before = await sampleWorkPlane(page);
    await page.evaluate(() => {
      (window as any).__store.mutate((p: any) => { p.room.wallReflectance = 0.65; });
    });
    // 重建后渲染循环重新启动，验证仍在产出帧且数值有限（frame 归零是重建的正确行为）
    await page.waitForTimeout(8000);
    const after = await sampleWorkPlane(page);
    expect(after).not.toBeNull();
    expect(after!.finite).toBe(true);
    expect(after!.frame).toBeGreaterThan(0);
    expect(after!.probeCount).toBe(before!.probeCount);
  });

  test('地下车库示例同样可渲染', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('text=项目列表');
    await page.click('text=新建地下车库（示例）');
    await page.waitForSelector('canvas.gl-canvas');
    await page.waitForTimeout(3000);
    const s = await sampleWorkPlane(page);
    expect(s).not.toBeNull();
    expect(s!.probeCount).toBeGreaterThan(40);
    expect(s!.frame).toBeGreaterThan(0);
  });

  test('约 200 探针规模下渲染循环稳定（真实 GPU 应达 30FPS）', async ({ page }) => {
    await openFactory(page);
    // 默认 spacing=3，厂房探针约 200 量级；采样多帧 FPS
    await page.waitForTimeout(4000);
    const perf = await page.evaluate(() => {
      const v = (window as any).__tds;
      const engine = v?.glEngine;
      const gl = engine.gl;
      // 通过解掩码扩展拿真实后端（ANGLE 默认只返回 "WebKit WebGL"）
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
      const vendor = String(dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR));
      const software = /swiftshader|llvmpipe|software|basic render|angle \(.*swiftshader/i.test(`${renderer} ${vendor}`);
      return {
        probeCount: v.snapshot.grid.positions.length,
        triCount: v.snapshot.mesh.tris.length,
        fps: engine.fps,
        renderer,
        vendor,
        software,
      };
    });
    console.log('PERF', JSON.stringify(perf));
    expect(perf.probeCount).toBeGreaterThanOrEqual(150);
    expect(perf.probeCount).toBeLessThan(400);
    expect(perf.fps).toBeGreaterThan(0);
    // 真实 GPU（非软件渲染）要求不低于 30FPS；软件渲染仅验证循环稳定
    if (!perf.software) {
      expect(perf.fps).toBeGreaterThanOrEqual(30);
    } else {
      console.log('软件渲染环境，跳过 30FPS 硬性门槛，实测 FPS=', perf.fps.toFixed(1));
    }
  });
});
