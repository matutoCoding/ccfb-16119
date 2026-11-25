// WebGL2 光照探针烘焙器：BVH 数据纹理 + 八面体辐照度/深度矩 atlas +
// 每帧增量刷新部分探针 + Chebyshev 可见性工作面伪彩。
import type { SceneMesh } from '../core/geometry';
import type { PackedBVH } from '../core/bvh';
import type { ProbeLayout } from '../core/grid';
import {
  FULLSCREEN_VERT,
  COPY_FRAG,
  BAKE_FRAG,
  WORKPLANE_FRAG,
} from './shaders';

export interface BakerStats {
  fps: number;
  probes: number;
  updatedThisRound: number;
  totalSamples: number;
  targetSamples: number;
  progress: number;
  baking: boolean;
  gl: boolean;
}

interface Quality {
  probesPerFrame: number;
  samplesPerUpdate: number;
  targetSamples: number;
}

const ATLAS = 256;
const TILE = 16;
const MAX_LIGHTS = 64;

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) || '';
    console.error(log, src);
    throw new Error('Shader 编译失败: ' + log.split('\n')[0]);
  }
  return sh;
}
function makeProgram(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compileShader(gl, gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(p, compileShader(gl, gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('Program 链接失败: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

export class ProbeBaker {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private emptyVao: WebGLVertexArrayObject;
  private copyProg: WebGLProgram;
  private bakeProg: WebGLProgram;
  private wpProg: WebGLProgram;

  private nodeTex: WebGLTexture | null = null;
  private triTex: WebGLTexture | null = null;
  private matTex: WebGLTexture | null = null;
  private nodeDim: [number, number] = [1, 1];
  private triDim: [number, number] = [1, 1];
  private matDim: [number, number] = [1, 1];

  private irrTex: [WebGLTexture, WebGLTexture] | null = null;
  private momTex: [WebGLTexture, WebGLTexture] | null = null;
  private fbo: WebGLFramebuffer;
  private cur = 0;

  private layout: ProbeLayout | null = null;
  private lightA = new Float32Array(MAX_LIGHTS * 4);
  private lightB = new Float32Array(MAX_LIGHTS * 4);
  private lightCount = 0;

  private gridOrigin: [number, number, number] = [0, 1.5, 0];
  private gridSpacing: [number, number, number] = [3, 3, 3];
  private gridDim: [number, number, number] = [2, 1, 2];
  private bounds: [number, number, number, number] = [-10, -10, 20, 20];
  private workY = 0.75;

  private skyType = 0;
  private sunDir: [number, number, number] = [0, 1, 0];
  private skyLz = 8000;
  private maxLux = 600;
  private stdLux = 200;

  private quality: Quality = { probesPerFrame: 6, samplesPerUpdate: 4, targetSamples: 48 };
  private age: Float32Array = new Float32Array(0);
  private cursor = 0;
  private frame = 0;
  private raf = 0;
  private running = false;
  private ro: ResizeObserver;
  private alive = true;

  onStats?: (s: BakerStats) => void;
  private fpsEma = 60;
  private lastT = performance.now();
  private statTick = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WEBGL2_UNSUPPORTED 当前浏览器不支持 WebGL2');
    if (!gl.getExtension('EXT_color_buffer_float')) {
      throw new Error('WEBGL2_FLOAT_UNSUPPORTED 缺少 EXT_color_buffer_float（请用新版 Chrome/Edge）');
    }
    this.gl = gl;
    this.emptyVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.emptyVao);

    this.copyProg = makeProgram(gl, FULLSCREEN_VERT, COPY_FRAG);
    this.bakeProg = makeProgram(gl, FULLSCREEN_VERT, BAKE_FRAG);
    this.wpProg = makeProgram(gl, FULLSCREEN_VERT, WORKPLANE_FRAG);
    this.fbo = gl.createFramebuffer()!;

    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas.parentElement ?? canvas);
    this.resize();
  }

  setQuality(q: Partial<Quality>): void {
    this.quality = { ...this.quality, ...q };
  }

  setFalseColorMax(lux: number, standardLux: number): void {
    this.maxLux = lux;
    this.stdLux = standardLux;
  }

  setSky(type: 'overcast' | 'clear', sunDir: [number, number, number], skyLz: number, _extHorizontalLux?: number): void {
    this.skyType = type === 'clear' ? 1 : 0;
    this.sunDir = sunDir;
    this.skyLz = skyLz;
  }

  setScene(mesh: SceneMesh, packed: PackedBVH, layout: ProbeLayout, workY?: number): void {
    const gl = this.gl;
    this.layout = layout;
    if (workY != null) this.workY = workY;
    this.age = new Float32Array(layout.count);
    this.cursor = 0;

    // 网格 uniform
    this.gridDim = [layout.nx, layout.ny, layout.nz];
    const firstY = layout.positions[1] ?? 1.5;
    this.gridOrigin = [layout.origin[0], firstY, layout.origin[2]];
    this.gridSpacing = [layout.spacingX, layout.spacingY || 3, layout.spacingZ];
    // bounds = minX, minZ, sizeX, sizeZ
    this.bounds = [mesh.min[0], mesh.min[2], mesh.max[0] - mesh.min[0], mesh.max[2] - mesh.min[2]];

    // 灯光
    this.lightCount = Math.min(MAX_LIGHTS, mesh.lights.length);
    this.lightA.fill(0);
    this.lightB.fill(0);
    for (let i = 0; i < this.lightCount; i++) {
      const l = mesh.lights[i];
      this.lightA[i * 4 + 0] = l.position[0];
      this.lightA[i * 4 + 1] = l.position[1];
      this.lightA[i * 4 + 2] = l.position[2];
      this.lightA[i * 4 + 3] = l.size[0];
      this.lightB[i * 4 + 0] = l.fluxLumens;
      this.lightB[i * 4 + 1] = l.exponent;
    }

    // 数据纹理
    this.nodeTex = this.uploadData(packed.nodeData, packed.nodeCount * 2, this.nodeDim, 0);
    this.triTex = this.uploadData(packed.triData, packed.triCount * 4, this.triDim, 1);
    this.matTex = this.uploadData(packed.matData, packed.matCount * 3, this.matDim, 2);

    // atlas
    this.irrTex = [this.makeAtlas(gl.RGBA16F, gl.HALF_FLOAT), this.makeAtlas(gl.RGBA16F, gl.HALF_FLOAT)];
    this.momTex = [this.makeAtlas(gl.RGBA16F, gl.HALF_FLOAT), this.makeAtlas(gl.RGBA16F, gl.HALF_FLOAT)];
    this.cur = 0;
    this.clearAtlases();
  }

  private uploadData(data: Float32Array, texelCount: number, dimOut: [number, number], _unit: number): WebGLTexture {
    const gl = this.gl;
    const W = 512;
    const H = Math.max(1, Math.ceil(texelCount / W));
    dimOut[0] = W;
    dimOut[1] = H;
    const padded = new Float32Array(W * H * 4);
    padded.set(data.subarray(0, Math.min(data.length, padded.length)));
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, W, H, 0, gl.RGBA, gl.FLOAT, padded);
    return tex;
  }

  private makeAtlas(internal: number, type: number): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, ATLAS, ATLAS, 0, gl.RGBA, type, null);
    return tex;
  }

  private clearAtlases(): void {
    if (!this.irrTex || !this.momTex) return;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.irrTex[1 - this.cur], 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.momTex[1 - this.cur], 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    // 两张都清零
    for (const idx of [0, 1] as const) {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.irrTex[idx], 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.momTex[idx], 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  resetConvergence(): void {
    if (this.age) this.age.fill(0);
    this.cursor = 0;
    this.clearAtlases();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastT = performance.now();
    const loop = (): void => {
      if (!this.alive) return;
      this.raf = requestAnimationFrame(loop);
      const now = performance.now();
      const dt = Math.max(1, now - this.lastT);
      this.lastT = now;
      this.fpsEma = this.fpsEma * 0.92 + (1000 / dt) * 0.08;
      this.renderFrame();
      this.statTick++;
      if (this.statTick % 20 === 0) this.emitStats();
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private emitStats(): void {
    if (!this.onStats || !this.layout) return;
    const target = this.quality.targetSamples;
    let sum = 0;
    let updated = 0;
    for (let i = 0; i < this.age.length; i++) {
      sum += Math.min(this.age[i], target);
      if (this.age[i] > 0) updated++;
    }
    const totalTarget = this.age.length * target;
    this.onStats({
      fps: this.fpsEma,
      probes: this.layout.count,
      updatedThisRound: updated,
      totalSamples: Math.round(sum),
      targetSamples: target,
      progress: totalTarget > 0 ? Math.min(1, sum / totalTarget) : 0,
      baking: sum < totalTarget,
      gl: true,
    });
  }

  private resize(): void {
    const parent = this.canvas.parentElement;
    const cw = parent?.clientWidth ?? 640;
    const ch = parent?.clientHeight ?? 460;
    const aspect = cw / Math.max(1, ch);
    const targetW = 384;
    this.canvas.width = targetW;
    this.canvas.height = Math.max(180, Math.round(targetW / aspect));
  }

  /** 绑定 BVH/灯光/天空公共 uniform 到指定 program */
  private setCommon(prog: WebGLProgram): void {
    const gl = this.gl;
    const loc = (n: string) => gl.getUniformLocation(prog, n);
    gl.uniform1i(loc('uNodeTex'), 0);
    gl.uniform2f(loc('uNodeDim'), this.nodeDim[0], this.nodeDim[1]);
    gl.uniform1i(loc('uTriTex'), 1);
    gl.uniform2f(loc('uTriDim'), this.triDim[0], this.triDim[1]);
    gl.uniform1i(loc('uMatTex'), 2);
    gl.uniform2f(loc('uMatDim'), this.matDim[0], this.matDim[1]);
    if (this.nodeTex) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.nodeTex); }
    if (this.triTex) { gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.triTex); }
    if (this.matTex) { gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.matTex); }

    gl.uniform1i(loc('uLightCount'), this.lightCount);
    gl.uniform4fv(loc('uLightA[0]'), this.lightA);
    gl.uniform4fv(loc('uLightB[0]'), this.lightB);
    gl.uniform1i(loc('uSkyType'), this.skyType);
    gl.uniform3fv(loc('uSunDir'), this.sunDir);
    gl.uniform1f(loc('uSkyLz'), this.skyLz);
  }

  renderFrame(): void {
    if (!this.layout || !this.irrTex || !this.momTex) return;
    const gl = this.gl;
    gl.bindVertexArray(this.emptyVao);
    this.frame++;

    const read = this.cur;
    const write = 1 - this.cur;

    // ---- 1) copy read -> write ----
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.irrTex[write], 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.momTex[write], 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.viewport(0, 0, ATLAS, ATLAS);
    gl.useProgram(this.copyProg);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.irrTex[read]);
    gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, this.momTex[read]);
    gl.uniform1i(gl.getUniformLocation(this.copyProg, 'uIrr'), 3);
    gl.uniform1i(gl.getUniformLocation(this.copyProg, 'uMom'), 4);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // ---- 2) bake 若干探针到 write ----
    gl.useProgram(this.bakeProg);
    this.setCommon(this.bakeProg);
    gl.uniform1i(gl.getUniformLocation(this.bakeProg, 'uIrrSrc'), 3);
    gl.uniform1i(gl.getUniformLocation(this.bakeProg, 'uMomSrc'), 4);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.irrTex[read]);
    gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, this.momTex[read]);
    gl.uniform1f(gl.getUniformLocation(this.bakeProg, 'uAtlasPx'), ATLAS);
    gl.uniform1f(gl.getUniformLocation(this.bakeProg, 'uTilePx'), TILE);
    gl.uniform1f(gl.getUniformLocation(this.bakeProg, 'uFrame'), (this.frame % 100000) * 0.731);
    gl.uniform1i(gl.getUniformLocation(this.bakeProg, 'uSamples'), this.quality.samplesPerUpdate);

    const perFrame = this.quality.probesPerFrame;
    let done = 0;
    let attempts = 0;
    const n = this.layout.count;
    while (done < perFrame && attempts < n) {
      const idx = this.cursor % n;
      this.cursor++;
      attempts++;
      if (this.age[idx] >= this.quality.targetSamples) continue;
      done++;
      const tx = idx % 16;
      const ty = Math.floor(idx / 16);
      const p = idx * 3;
      gl.viewport(tx * TILE, ty * TILE, TILE, TILE);
      gl.uniform3f(gl.getUniformLocation(this.bakeProg, 'uProbePos'),
        this.layout.positions[p], this.layout.positions[p + 1], this.layout.positions[p + 2]);
      gl.uniform2f(gl.getUniformLocation(this.bakeProg, 'uTileOrigin'), tx * TILE, ty * TILE);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.age[idx] += this.quality.samplesPerUpdate;
    }
    this.cur = write;

    // ---- 3) 工作面到默认 framebuffer ----
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.wpProg);
    this.setCommon(this.wpProg);
    gl.uniform1i(gl.getUniformLocation(this.wpProg, 'uIrrTex'), 3);
    gl.uniform1i(gl.getUniformLocation(this.wpProg, 'uMomTex'), 4);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.irrTex[this.cur]);
    gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, this.momTex[this.cur]);
    gl.uniform3f(gl.getUniformLocation(this.wpProg, 'uGridOrigin'), ...this.gridOrigin);
    gl.uniform3f(gl.getUniformLocation(this.wpProg, 'uGridSpacing'), ...this.gridSpacing);
    gl.uniform3f(gl.getUniformLocation(this.wpProg, 'uGridDim'), ...this.gridDim);
    gl.uniform4f(gl.getUniformLocation(this.wpProg, 'uBounds'), ...this.bounds);
    gl.uniform1f(gl.getUniformLocation(this.wpProg, 'uWorkY'), this.workY);
    gl.uniform1f(gl.getUniformLocation(this.wpProg, 'uMaxLux'), this.maxLux);
    gl.uniform1f(gl.getUniformLocation(this.wpProg, 'uStdLux'), this.stdLux);
    gl.uniform1f(gl.getUniformLocation(this.wpProg, 'uViewAspect'), this.canvas.width / Math.max(1, this.canvas.height));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose(): void {
    this.alive = false;
    this.stop();
    this.ro.disconnect();
    const ext = this.gl.getExtension('WEBGL_lose_context');
    // 延迟 loseContext，避免 React 严格模式/立即重建时竞争；这里直接释放
    ext?.loseContext();
  }
}
