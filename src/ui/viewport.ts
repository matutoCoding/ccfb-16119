import { h, type VNode } from './dom';
import { store } from './store';
import { GlEngine } from '../webgl/glEngine';
import { OrbitCamera } from '../webgl/orbitCamera';
import { buildSimulation, uploadEmissives, type SimSnapshot } from '../webgl/simController';

export interface ViewportHud {
  fps: number;
  convergence: number;
  probeCount: number;
  totalLumens: number;
  eh: number;
}

/**
 * 共享 WebGL 视口。
 * rebuildKey 变化（几何/反射率/管道/探针参数）时重建 BVH+探针并重新收敛；
 * skyKey 变化（天空时刻）只刷发光面，不重置收敛。
 */
export class Viewport {
  el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private engine: GlEngine | null = null;
  private camera: OrbitCamera;
  private raf = 0;
  private resizeObs: ResizeObserver;
  private snap: SimSnapshot | null = null;
  viz: 0 | 1 | 2 = 0;
  private hudEl: HTMLElement;
  private statusEl: HTMLElement;
  onHud: ((h: ViewportHud) => void) | null = null;
  private lastProjectId = '';
  private geometrySig = '';
  private running = false;

  constructor() {
    this.canvas = h('canvas', { class: 'gl-canvas' }) as HTMLCanvasElement;
    this.hudEl = h('div', { class: 'viewport-hud' });
    this.statusEl = h('div', { class: 'viewport-status' }, text2('初始化 WebGL2…'));
    this.el = h('div', { class: 'viewport' }, this.canvas, this.hudEl, this.statusEl);
    this.camera = new OrbitCamera(this.canvas);
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(this.el);
    // 调试/自动化验收钩子（E2E 读取 FPS、收敛度、探针数与工作面采样）
    (window as unknown as Record<string, unknown>).__tds = this;
  }

  setViz(v: 0 | 1 | 2): void {
    this.viz = v;
  }

  get snapshot(): SimSnapshot | null {
    return this.snap;
  }

  get glEngine(): GlEngine | null {
    return this.engine;
  }

  private ensureEngine(): GlEngine {
    if (this.engine) return this.engine;
    this.engine = new GlEngine(this.canvas);
    return this.engine;
  }

  private geometrySignature(): string {
    const p = store.current;
    if (!p) return '';
    return JSON.stringify({
      r: p.room,
      o: p.objects.map((o) => [o.center, o.size, o.rotationY, o.reflectance, o.kind]),
      pipes: p.schemes.find((s) => s.id === p.activeSchemeId)?.pipes.map((x) => [
        x.x, x.z, x.diameter, x.length, x.elbowCount, x.enabled, x.domeModel, x.diffuserModel,
      ]),
      probe: p.probe,
      active: p.activeSchemeId,
    });
  }

  /** 每帧检查项目状态，按需重建 */
  sync(): void {
    const p = store.current;
    if (!p) return;
    const sig = this.geometrySignature();
    try {
      if (p.id !== this.lastProjectId || sig !== this.geometrySig || !this.snap) {
        const engine = this.ensureEngine();
        this.snap = buildSimulation(p, store.catalog);
        engine.setScene(
          this.snap.mesh,
          this.snap.bvh,
          this.snap.grid,
          p.probe.raysPerProbe,
          p.probe.probesPerFrame,
        );
        uploadEmissives(engine, p, this.snap);
        if (p.id !== this.lastProjectId) this.camera.frameRoom(p.room);
        this.lastProjectId = p.id;
        this.geometrySig = sig;
        this.statusEl.textContent = `探针 ${this.snap.grid.positions.length} 个 · 三角面 ${this.snap.mesh.tris.length} · 重新收敛中…`;
      } else {
        // 天空/参数表变化：只刷发光面
        const skySig = JSON.stringify(p.sky) + store.catalog.id;
        if (skySig !== this.lastSkySig) {
          this.snap = buildSimulation(p, store.catalog);
          if (this.engine) uploadEmissives(this.engine, p, this.snap);
          this.lastSkySig = skySig;
        }
      }
      this.statusEl.style.display = this.engine && this.engine.convergence > 0.02 ? 'block' : 'none';
    } catch (err) {
      this.statusEl.textContent = `仿真错误: ${(err as Error).message}`;
      this.statusEl.style.display = 'block';
    }
  }

  private lastSkySig = '';

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = (): void => {
      this.raf = requestAnimationFrame(loop);
      this.sync();
      const engine = this.engine;
      if (!engine || !this.snap) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const w = Math.max(2, Math.floor(this.canvas.clientWidth * dpr));
      const h = Math.max(2, Math.floor(this.canvas.clientHeight * dpr));
      engine.renderScene(this.camera.camera, w, h, this.viz);
      const hud: ViewportHud = {
        fps: engine.fps,
        convergence: engine.convergence,
        probeCount: this.snap.grid.positions.length,
        totalLumens: this.snap.totalLumens,
        eh: this.snap.sky.horizontalEh,
      };
      this.renderHud(hud);
      this.onHud?.(hud);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private renderHud(h: ViewportHud): void {
    const convPct = (h.convergence * 100).toFixed(2);
    const state = h.convergence < 0.01 ? '已收敛' : '收敛中';
    this.hudEl.innerHTML =
      `<span>${h.fps.toFixed(0)} FPS</span>` +
      `<span>探针 ${h.probeCount}</span>` +
      `<span>${state} Δ${convPct}%</span>` +
      `<span>室外 ${h.eh.toFixed(0)} lx</span>` +
      `<span>管输出 ${h.totalLumens.toFixed(0)} lm</span>`;
  }

  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.canvas.width = Math.max(2, Math.floor(this.canvas.clientWidth * dpr));
    this.canvas.height = Math.max(2, Math.floor(this.canvas.clientHeight * dpr));
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  dispose(): void {
    this.stop();
    this.resizeObs.disconnect();
    this.camera.dispose();
    this.engine?.dispose();
    this.el.remove();
  }
}

function text2(s: string): Text {
  return document.createTextNode(s);
}

export function emptyHint(): VNode {
  return h('div', { class: 'empty-hint' },
    h('p', {}, text2('请先在「项目列表」打开或新建一个项目')),
  );
}
