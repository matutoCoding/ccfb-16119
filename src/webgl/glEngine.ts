import type { Vec3 } from '../types';
import type { MeshData } from '../core/geometry/mesh';
import type { BvhData } from '../core/geometry/bvh';
import { packBvhTextures } from '../core/geometry/bvh';
import type { ProbeGrid } from '../core/gi/probes';
import { mat4Perspective, mat4LookAt, mat4TRS, type Mat4 } from '../core/math/mat4';
import { PROBE_UPDATE_FRAG, QUAD_VERT } from './glsl/probeUpdate';
import { SCENE_VERT, SCENE_FRAG, PROBE_VERT, PROBE_FRAG } from './glsl/scene';
import { WORKPLANE_VERT, WORKPLANE_FRAG } from './glsl/workplane';

export interface EngineCamera {
  eye: Vec3;
  target: Vec3;
  fov: number;
}

interface Program {
  prog: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

export class GlEngine {
  readonly gl: WebGL2RenderingContext;
  private programs: Record<string, Program> = {};
  private vao: WebGLVertexArrayObject;
  private cubeVbo!: WebGLBuffer;
  private instanceVbo!: WebGLBuffer;
  private indexCount = 0;
  private instanceCount = 0;

  private nodeTex!: WebGLTexture;
  private triTex!: WebGLTexture;
  private matTex!: WebGLTexture;
  private lightTex!: WebGLTexture;
  private lightTexWidth = 1;
  private lightCount = 0;
  private matTexWidth = 1;
  private matCount = 0;
  private nodeTexWidth = 1;
  private triTexWidth = 1;
  private roomXZ: [number, number] = [1, 1];

  private probeCount = 0;
  private irrTexA!: WebGLTexture;
  private irrTexB!: WebGLTexture;
  private depthTexA!: WebGLTexture;
  private depthTexB!: WebGLTexture;
  private fboIrrA!: WebGLFramebuffer;
  private fboIrrB!: WebGLFramebuffer;
  private fboDepthA!: WebGLFramebuffer;
  private fboDepthB!: WebGLFramebuffer;
  private ping = false;

  private workTex!: WebGLTexture;
  private workFbo!: WebGLFramebuffer;
  private workW = 0;
  private workH = 0;

  grid!: ProbeGrid;
  private rayCount = 128;
  private probesPerFrame = 16;
  private updateOffset = 0;
  private probeMaxDist = 20;
  private blend = 0.25;
  private frame = 0;
  private lastConvergence = 1;
  private lastIrrSnapshot: Float32Array | null = null;

  fps = 0;
  private frameTimes: number[] = [];
  private lastT = performance.now();

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      antialias: true,
      preserveDrawingBuffer: false,
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('当前浏览器不支持 WebGL2');
    if (!gl.getExtension('EXT_color_buffer_float')) {
      throw new Error('不支持 EXT_color_buffer_float，无法做浮点探针计算');
    }
    gl.getExtension('OES_texture_float_linear');
    this.gl = gl;
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('VAO 创建失败');
    this.vao = vao;
    this.programs.probe = this.createProgram(QUAD_VERT, PROBE_UPDATE_FRAG);
    this.programs.scene = this.createProgram(SCENE_VERT, SCENE_FRAG);
    this.programs.probeViz = this.createProgram(PROBE_VERT, PROBE_FRAG);
    this.programs.work = this.createProgram(WORKPLANE_VERT, WORKPLANE_FRAG);
    this.buildCube();
  }

  private compile(type: number, src: string): WebGLShader {
    const gl = this.gl;
    const sh = gl.createShader(type);
    if (!sh) throw new Error('shader 创建失败');
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error(`着色器编译失败: ${log}\n${src.split('\n').slice(0, 30).join('\n')}`);
    }
    return sh;
  }

  private createProgram(vsSrc: string, fsSrc: string): Program {
    const gl = this.gl;
    const p = gl.createProgram();
    if (!p) throw new Error('program 创建失败');
    gl.attachShader(p, this.compile(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(p, this.compile(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(`程序链接失败: ${gl.getProgramInfoLog(p)}`);
    }
    const uniforms: Record<string, WebGLUniformLocation | null> = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      if (info) uniforms[info.name.replace('[0]', '')] = gl.getUniformLocation(p, info.name);
    }
    return { prog: p, uniforms };
  }

  private u(p: Program, name: string): WebGLUniformLocation | null {
    const loc = p.uniforms[name];
    return loc ?? null;
  }

  private makeFloatTexture(
    width: number,
    height: number,
    data: Float32Array | null,
    filter: number,
  ): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error('纹理创建失败');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private buildCube(): void {
    const gl = this.gl;
    // 单位立方体 24 顶点（带法线）+ 36 索引
    const h = 0.5;
    const faces = [
      { n: [0, 0, 1], q: [[-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]] },
      { n: [0, 0, -1], q: [[h, -h, -h], [-h, -h, -h], [-h, h, -h], [h, h, -h]] },
      { n: [1, 0, 0], q: [[h, -h, h], [h, -h, -h], [h, h, -h], [h, h, h]] },
      { n: [-1, 0, 0], q: [[-h, -h, -h], [-h, -h, h], [-h, h, h], [-h, h, -h]] },
      { n: [0, 1, 0], q: [[-h, h, h], [h, h, h], [h, h, -h], [-h, h, -h]] },
      { n: [0, -1, 0], q: [[-h, -h, -h], [h, -h, -h], [h, -h, h], [-h, -h, h]] },
    ];
    const verts: number[] = [];
    const idx: number[] = [];
    let base = 0;
    for (const f of faces) {
      for (const v of f.q) verts.push(...v, ...f.n);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      base += 4;
    }
    this.indexCount = idx.length;
    this.cubeVbo = gl.createBuffer()!;
    const ebo = gl.createBuffer()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cubeVbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    this.instanceVbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceVbo);
    const stride = 20 * 4; // mat4(16) + matId int(补到 4 float)
    for (let c = 0; c < 4; c++) {
      gl.enableVertexAttribArray(2 + c);
      gl.vertexAttribPointer(2 + c, 4, gl.FLOAT, false, stride, c * 16);
      gl.vertexAttribDivisor(2 + c, 1);
    }
    gl.enableVertexAttribArray(6);
    gl.vertexAttribIPointer(6, 1, gl.UNSIGNED_INT, stride, 64);
    gl.vertexAttribDivisor(6, 1);
    gl.bindVertexArray(null);
  }

  /** 场景重建（几何/BVH/材质/探针全部重建） */
  setScene(mesh: MeshData, bvh: BvhData, grid: ProbeGrid, rayCount: number, perFrame: number): void {
    const gl = this.gl;
    const packed = packBvhTextures(bvh, mesh.tris);
    this.nodeTexWidth = packed.nodeTexWidth;
    this.triTexWidth = packed.triTexWidth;
    this.nodeTex = this.makeFloatTexture(packed.nodeTexWidth, 1, packed.nodeTex, gl.NEAREST);
    this.triTex = this.makeFloatTexture(packed.triTexWidth, 1, packed.triTex, gl.NEAREST);

    // 材质纹理：每材质 2 纹素
    this.matCount = mesh.materials.length;
    this.matTexWidth = Math.max(1, this.matCount * 2);
    const matData = new Float32Array(this.matTexWidth * 4);
    mesh.materials.forEach((m, i) => {
      matData.set([...m.albedo, m.roughness], i * 8);
      matData.set([...m.emissive, 0], i * 8 + 4);
    });
    this.matTex = this.makeFloatTexture(this.matTexWidth, 1, matData, gl.NEAREST);

    // 实例数据
    const inst: number[] = [];
    for (const ins of mesh.instances) {
      const m = mat4TRS(ins.center, ins.rotationY, ins.size);
      inst.push(...Array.from(m), ins.matId, 0, 0, 0);
    }
    this.instanceCount = mesh.instances.length;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceVbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(inst), gl.DYNAMIC_DRAW);

    // 探针纹理（ping-pong）
    this.grid = grid;
    this.probeCount = grid.positions.length;
    this.roomXZ = [
      grid.origin[0] * 2 + (grid.count[0] - 1) * grid.spacing[0],
      grid.origin[2] * 2 + (grid.count[2] - 1) * grid.spacing[2],
    ];
    this.rayCount = rayCount;
    this.probesPerFrame = perFrame;
    this.probeMaxDist = Math.max(grid.spacing[0], grid.spacing[1], grid.spacing[2]) * 3;
    const irrW = this.probeCount;
    this.irrTexA = this.makeFloatTexture(irrW, 9, null, gl.NEAREST);
    this.irrTexB = this.makeFloatTexture(irrW, 9, null, gl.NEAREST);
    this.depthTexA = this.makeFloatTexture(irrW, 3, null, gl.NEAREST);
    this.depthTexB = this.makeFloatTexture(irrW, 3, null, gl.NEAREST);
    this.fboIrrA = this.makeFbo(this.irrTexA);
    this.fboIrrB = this.makeFbo(this.irrTexB);
    this.fboDepthA = this.makeFbo(this.depthTexA);
    this.fboDepthB = this.makeFbo(this.depthTexB);
    this.lastIrrSnapshot = null;
    this.frame = 0;
    this.updateOffset = 0;
    this.lastConvergence = 1;
  }

  private makeFbo(tex: WebGLTexture): WebGLFramebuffer {
    const gl = this.gl;
    const fbo = gl.createFramebuffer();
    if (!fbo) throw new Error('FBO 创建失败');
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('浮点 FBO 不完整');
    }
    return fbo;
  }

  /** 更新材质发光（窗天光 / 漫射器出射度），matId → radiance(cd/m²)，保留 albedo 行 */
  setEmissives(emissives: Map<number, Vec3>): void {
    const gl = this.gl;
    // 每材质 2 纹素：row0=albedo.xyz+rough，row1=emissive.xyz+0，逐材质上传避免覆盖 albedo
    emissives.forEach((v, matId) => {
      if (matId >= this.matCount) return;
      const data = new Float32Array([v[0], v[1], v[2], 0]);
      gl.bindTexture(gl.TEXTURE_2D, this.matTex);
      gl.texSubImage2D(
        gl.TEXTURE_2D, 0,
        matId * 2 + 1, 0, // x 偏移到该材质的 emissive 纹素
        1, 1,
        gl.RGBA, gl.FLOAT, data,
      );
    });
  }

  setBlend(b: number): void {
    this.blend = b;
  }

  /** 上传发光面片（每面 3 纹素：中心+面积 / 法线 / 辐射度），供探针解析直接光 */
  setLightPatches(lights: { center: Vec3; normal: Vec3; area: number; radiance: Vec3 }[]): void {
    const gl = this.gl;
    const newCount = Math.min(lights.length, 64);
    const newWidth = Math.max(1, newCount * 3);
    const data = new Float32Array(newWidth * 4);
    lights.slice(0, 64).forEach((l, i) => {
      data.set([l.center[0], l.center[1], l.center[2], l.area], i * 12);
      data.set([l.normal[0], l.normal[1], l.normal[2], 0], i * 12 + 4);
      data.set([l.radiance[0], l.radiance[1], l.radiance[2], 0], i * 12 + 8);
    });
    // 在独立单元操作，避免干扰 FBO 反馈环；先解绑旧纹理再删除
    gl.activeTexture(gl.TEXTURE6);
    if (this.lightTex) {
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.deleteTexture(this.lightTex);
    }
    this.lightTex = this.makeFloatTexture(newWidth, 1, data, gl.NEAREST);
    gl.activeTexture(gl.TEXTURE0);
    this.lightCount = newCount;
    this.lightTexWidth = newWidth;
  }

  /** 调试：回读当前辐照度纹理前若干探针的 SH0（RGB） */
  debugReadProbes(n = 3): { probe: number; sh0: [number, number, number]; row0: number[]; row1: number[] }[] {
    const gl = this.gl;
    const fbo = this.ping ? this.fboIrrB : this.fboIrrA;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    const out: { probe: number; sh0: [number, number, number]; row0: number[]; row1: number[] }[] = [];
    for (let i = 0; i < n; i++) {
      const r0 = new Float32Array(4);
      gl.readPixels(i, 0, 1, 1, gl.RGBA, gl.FLOAT, r0);
      const r1 = new Float32Array(4);
      gl.readPixels(i, 1, 1, 1, gl.RGBA, gl.FLOAT, r1);
      const pg = new Float32Array(4);
      gl.readPixels(i, 3, 1, 1, gl.RGBA, gl.FLOAT, pg);
      const pb = new Float32Array(4);
      gl.readPixels(i, 6, 1, 1, gl.RGBA, gl.FLOAT, pb);
      out.push({ probe: i, sh0: [r0[0], pg[0], pb[0]], row0: Array.from(r0), row1: Array.from(r1) });
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  /** 调试：回读发光面纹理前 n 个纹素 */
  debugReadLights(n = 6): number[][] {
    const gl = this.gl;
    const tmp = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, tmp);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.lightTex, 0);
    const out: number[][] = [];
    for (let i = 0; i < n; i++) {
      const b = new Float32Array(4);
      gl.readPixels(i, 0, 1, 1, gl.RGBA, gl.FLOAT, b);
      out.push(Array.from(b));
    }
    gl.deleteFramebuffer(tmp);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  /** 调试：回读深度矩纹理前 n 个探针 */
  debugReadDepth(n = 3): number[][] {
    const gl = this.gl;
    const fbo = this.ping ? this.fboDepthB : this.fboDepthA;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    const out: number[][] = [];
    for (let i = 0; i < n; i++) {
      const rows: number[] = [];
      for (let row = 0; row < 3; row++) {
        const b = new Float32Array(4);
        gl.readPixels(i, row, 1, 1, gl.RGBA, gl.FLOAT, b);
        rows.push(...Array.from(b));
      }
      out.push(rows);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  /** 调试：回读材质纹理，确认 albedo 与 emissive 都在 */
  debugReadMaterials(): { albedo: number[]; emissive: number[] } {
    const gl = this.gl;
    const buf = new Float32Array(this.matTexWidth * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // 材质纹理没有 FBO，用临时 FBO 读
    const tmp = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, tmp);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.matTex, 0);
    gl.readPixels(0, 0, this.matTexWidth, 1, gl.RGBA, gl.FLOAT, buf);
    gl.deleteFramebuffer(tmp);
    const albedo: number[] = [];
    const emissive: number[] = [];
    for (let i = 0; i < this.matCount; i++) {
      albedo.push(buf[i * 8]);
      emissive.push(buf[i * 8 + 4]);
    }
    return { albedo, emissive };
  }

  /** 强制全量重收敛（挪货架/改反射率后调用） */
  invalidate(): void {
    this.frame = 0;
    this.updateOffset = 0;
    this.lastConvergence = 1;
    this.lastIrrSnapshot = null;
  }

  private bindSceneTextures(p: Program): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.nodeTex);
    gl.uniform1i(this.u(p, 'uNodeTex'), 0);
    gl.uniform1i(this.u(p, 'uNodeTexWidth'), this.nodeTexWidth);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.triTex);
    gl.uniform1i(this.u(p, 'uTriTex'), 1);
    gl.uniform1i(this.u(p, 'uTriTexWidth'), this.triTexWidth);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.matTex);
    gl.uniform1i(this.u(p, 'uMatTex'), 2);
    gl.uniform1i(this.u(p, 'uMatCount'), this.matCount);
  }

  private bindProbeTextures(p: Program, irr: WebGLTexture, depth: WebGLTexture): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, irr);
    gl.uniform1i(this.u(p, 'uIrrTex'), 3);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, depth);
    gl.uniform1i(this.u(p, 'uDepthTex'), 4);
    gl.uniform3i(this.u(p, 'uGridCount'), ...this.grid.count);
    gl.uniform3fv(this.u(p, 'uGridOrigin'), this.grid.origin);
    gl.uniform3fv(this.u(p, 'uGridSpacing'), this.grid.spacing);
    gl.uniform1i(this.u(p, 'uProbeCount'), this.probeCount);
    // 发光面片纹理（单元 5）。仅 probe 程序使用该采样器，其他程序 location 为 null 属正常
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.lightTex);
    gl.uniform1i(this.u(p, 'uLightTex'), 5);
    gl.uniform1i(this.u(p, 'uLightTexWidth'), this.lightTexWidth);
    gl.uniform1i(this.u(p, 'uLightCount'), this.lightCount);
  }

  /** 每帧探针轮转更新（两个全屏 pass，分别刷深度矩和辐照度） */
  private updateProbes(): void {
    const gl = this.gl;
    const p = this.programs.probe;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    const srcIrr = this.ping ? this.irrTexB : this.irrTexA;
    const srcDepth = this.ping ? this.depthTexB : this.depthTexA;
    const dstIrr = this.ping ? this.irrTexA : this.irrTexB;
    const dstDepth = this.ping ? this.depthTexA : this.depthTexB;
    const fboIrr = this.ping ? this.fboIrrA : this.fboIrrB;
    const fboDepth = this.ping ? this.fboDepthA : this.fboDepthB;

    const batch = Math.min(this.probesPerFrame, this.probeCount);
    const offset = this.updateOffset;
    // 冷启动前两轮（每个探针至少更新一次）用 blend=1 直接建立直接光，之后 EMA 平滑
    const framesPerRound = Math.ceil(this.probeCount / batch);
    const effBlend = this.frame < framesPerRound * 2 ? 1.0 : this.blend;

    // pass 1: 深度（读 src，写 dst）
    gl.useProgram(p.prog);
    this.bindSceneTextures(p);
    this.bindProbeTextures(p, srcIrr, srcDepth);
    gl.uniform1i(this.u(p, 'uMode'), 1);
    gl.uniform1i(this.u(p, 'uUpdateOffset'), offset);
    gl.uniform1i(this.u(p, 'uUpdateCount'), batch);
    gl.uniform1i(this.u(p, 'uRayCount'), this.rayCount);
    gl.uniform1f(this.u(p, 'uBlend'), effBlend);
    gl.uniform1f(this.u(p, 'uProbeMaxDist'), this.probeMaxDist);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboDepth);
    gl.viewport(0, 0, this.probeCount, 3);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // pass 2: 辐照度（读 srcIrr + 刚写好的 dstDepth，写 dstIrr）
    // 完整重新绑定场景纹理，确保 BVH/三角/材质纹理单元不被干扰
    this.bindSceneTextures(p);
    this.bindProbeTextures(p, srcIrr, this.ping ? this.depthTexA : this.depthTexB);
    gl.uniform1i(this.u(p, 'uMode'), 0);
    gl.uniform1i(this.u(p, 'uUpdateOffset'), offset);
    gl.uniform1i(this.u(p, 'uUpdateCount'), batch);
    gl.uniform1i(this.u(p, 'uRayCount'), this.rayCount);
    gl.uniform1f(this.u(p, 'uBlend'), effBlend);
    gl.uniform1f(this.u(p, 'uProbeMaxDist'), this.probeMaxDist);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboIrr);
    gl.viewport(0, 0, this.probeCount, 9);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    this.ping = !this.ping;
    this.updateOffset = (this.updateOffset + batch) % this.probeCount;
    this.frame++;
  }

  get convergence(): number {
    return this.lastConvergence;
  }

  /** 每 30 帧回读辐照度纹理估算收敛度 */
  private measureConvergence(): void {
    if (this.frame % 30 !== 0 || this.frame === 0) return;
    const gl = this.gl;
    const cur = new Float32Array(this.probeCount * 9 * 4);
    const src = this.ping ? this.irrTexB : this.irrTexA;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.ping ? this.fboIrrB : this.fboIrrA);
    gl.readPixels(0, 0, this.probeCount, 9, gl.RGBA, gl.FLOAT, cur);
    if (this.lastIrrSnapshot) {
      let diff = 0;
      let norm = 0;
      for (let i = 0; i < cur.length; i++) {
        diff += Math.abs(cur[i] - this.lastIrrSnapshot[i]);
        norm += Math.abs(this.lastIrrSnapshot[i]) + 1e-3;
      }
      this.lastConvergence = diff / norm;
    }
    this.lastIrrSnapshot = cur;
  }

  /** 主视图渲染 */
  renderScene(cam: EngineCamera, canvasW: number, canvasH: number, viz: 0 | 1 | 2): void {
    const gl = this.gl;
    this.updateProbes();
    this.measureConvergence();

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvasW, canvasH);
    gl.clearColor(0.07, 0.08, 0.1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);

    const aspect = canvasW / Math.max(1, canvasH);
    const vp = mat4Perspective(cam.fov, aspect, 0.05, 500);
    const view = mat4LookAt(cam.eye, cam.target);
    const viewProj = mat4Mul(vp, view);

    const p = this.programs.scene;
    gl.useProgram(p.prog);
    this.bindSceneTextures(p);
    this.bindProbeTextures(p, this.ping ? this.irrTexB : this.irrTexA, this.ping ? this.depthTexB : this.depthTexA);
    gl.uniformMatrix4fv(this.u(p, 'uViewProj'), false, viewProj);
    gl.uniform3fv(this.u(p, 'uCamPos'), cam.eye);
    gl.uniform1i(this.u(p, 'uProbeVisualize'), viz);
    gl.bindVertexArray(this.vao);
    gl.drawElementsInstanced(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0, this.instanceCount);

    if (viz > 0) {
      const pv = this.programs.probeViz;
      gl.useProgram(pv.prog);
      this.bindSceneTextures(pv);
      this.bindProbeTextures(pv, this.ping ? this.irrTexB : this.irrTexA, this.ping ? this.depthTexB : this.depthTexA);
      gl.uniformMatrix4fv(this.u(pv, 'uViewProj'), false, viewProj);
      gl.uniform1i(this.u(pv, 'uProbeVisualize'), viz);
      gl.uniform1f(this.u(pv, 'uVizScale'), 0.35);
      gl.uniform1f(this.u(pv, 'uProbeMaxDist'), this.probeMaxDist);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawElementsInstanced(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0, this.probeCount);
      gl.disable(gl.BLEND);
    }
    gl.bindVertexArray(null);
    this.tickFps();
  }

  private tickFps(): void {
    const now = performance.now();
    this.frameTimes.push(now - this.lastT);
    this.lastT = now;
    if (this.frameTimes.length > 60) this.frameTimes.shift();
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.fps = 1000 / avg;
  }

  /** 工作面分析：输出 lux 网格并回读 CPU（roomXZ 在 setScene 时记录） */
  renderWorkPlane(
    workY: number,
    gridW: number,
    gridH: number,
    mode: 0 | 1 | 2,
    maxLux: number,
    threshold: number,
  ): Float32Array {
    const gl = this.gl;
    if (!this.workTex || this.workW !== gridW || this.workH !== gridH) {
      this.workW = gridW;
      this.workH = gridH;
      this.workTex = this.makeFloatTexture(gridW, gridH, null, gl.NEAREST);
      this.workFbo = this.makeFbo(this.workTex);
    }
    const p = this.programs.work;
    gl.useProgram(p.prog);
    this.bindSceneTextures(p);
    this.bindProbeTextures(p, this.ping ? this.irrTexB : this.irrTexA, this.ping ? this.depthTexB : this.depthTexA);
    gl.uniform2fv(this.u(p, 'uRoomXZ'), this.roomXZ);
    gl.uniform2f(this.u(p, 'uGridSize'), gridW, gridH);
    gl.uniform1f(this.u(p, 'uWorkY'), workY);
    gl.uniform1i(this.u(p, 'uMode'), mode);
    gl.uniform1f(this.u(p, 'uMaxLux'), maxLux);
    gl.uniform1f(this.u(p, 'uThreshold'), threshold);
    gl.disable(gl.DEPTH_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.workFbo);
    gl.viewport(0, 0, gridW, gridH);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    const out = new Float32Array(gridW * gridH * 4);
    gl.readPixels(0, 0, gridW, gridH, gl.RGBA, gl.FLOAT, out);
    return out;
  }

  dispose(): void {
    const gl = this.gl;
    Object.values(this.programs).forEach((p) => gl.deleteProgram(p.prog));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

function mat4Mul(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] +
        a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}
