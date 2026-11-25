// WebGL2 三维场景光栅视图（建模页）。着色器手写，简单 Lambert + 头灯 + 雾。
import type { SceneMesh } from '../core/geometry';
import type { ProbeLayout } from '../core/grid';
import { OrbitCamera, type Mat4 } from '../core/math3d';

const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec3 aColor;
layout(location=3) in float aEmissive;
uniform mat4 uVP;
out vec3 vN; out vec3 vC; out float vE; out vec3 vW;
void main(){
  vN = aNormal; vC = aColor; vE = aEmissive; vW = aPos;
  gl_Position = uVP * vec4(aPos,1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec3 vN; in vec3 vC; in float vE; in vec3 vW;
uniform vec3 uEye;
uniform vec3 uLightDir;
out vec4 outColor;
void main(){
  vec3 n = normalize(vN);
  if(!gl_FrontFacing) n = -n;
  vec3 L = normalize(uLightDir);
  float diff = max(dot(n,L),0.0);
  // 头灯补光
  vec3 V = normalize(uEye - vW);
  float head = max(dot(n,V),0.0)*0.28;
  float hemi = 0.34 + 0.22*(n.y*0.5+0.5);
  vec3 col = vC * (hemi + diff*0.62 + head);
  if(vE > 0.5){ col = vC * 1.6; }
  // 距离雾，融入深色背景
  float d = length(uEye - vW);
  float fog = smoothstep(70.0, 150.0, d);
  col = mix(col, vec3(0.047,0.075,0.135), fog);
  outColor = vec4(pow(clamp(col,0.0,1.0), vec3(0.4545)), 1.0);
}`;

const LINE_VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
uniform mat4 uVP;
void main(){ gl_Position = uVP*vec4(aPos,1.0); }`;
const LINE_FRAG = `#version 300 es
precision highp float;
uniform vec4 uColor; out vec4 o;
void main(){ o = uColor; }`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('Shader error: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}
function program(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link error: ' + gl.getProgramInfoLog(p));
  return p;
}

export class SceneRenderer {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  cam = new OrbitCamera();
  private prog: WebGLProgram;
  private lineProg: WebGLProgram;
  private vao: WebGLVertexArrayObject | null = null;
  private vbo: WebGLBuffer | null = null;
  private vertexCount = 0;
  private lineVAO: WebGLVertexArrayObject | null = null;
  private lineVBO: WebGLBuffer | null = null;
  private lineCount = 0;
  private probeVAO: WebGLVertexArrayObject | null = null;
  private probeVBO: WebGLBuffer | null = null;
  private probeCount = 0;
  private probeAge: Float32Array | null = null;
  private probeAgeBuf: WebGLBuffer | null = null;
  private raf = 0;
  private uVP: WebGLUniformLocation | null;
  private uEye: WebGLUniformLocation | null;
  private uLD: WebGLUniformLocation | null;
  private lVP: WebGLUniformLocation | null;
  private lColor: WebGLUniformLocation | null;
  private resizeObs: ResizeObserver;
  private disposers: (() => void)[] = [];
  selectedBox: { min: [number, number, number]; max: [number, number, number] } | null = null;
  showGrid = true;
  showProbes = true;
  controlsEnabled = true;
  onFrame?: (fps: number) => void;
  private fpsAcc = 0;
  private fpsN = 0;
  private fpsLast = performance.now();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
    if (!gl) throw new Error('当前浏览器不支持 WebGL2');
    this.gl = gl;
    this.prog = program(gl, VERT, FRAG);
    this.lineProg = program(gl, LINE_VERT, LINE_FRAG);
    this.uVP = gl.getUniformLocation(this.prog, 'uVP');
    this.uEye = gl.getUniformLocation(this.prog, 'uEye');
    this.uLD = gl.getUniformLocation(this.prog, 'uLightDir');
    this.lVP = gl.getUniformLocation(this.lineProg, 'uVP');
    this.lColor = gl.getUniformLocation(this.lineProg, 'uColor');

    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0.047, 0.075, 0.135, 1);

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(canvas.parentElement ?? canvas);
    this.resize();
    this.bindControls();
    this.loop();
  }

  private resize(): void {
    const parent = this.canvas.parentElement;
    const w = parent?.clientWidth ?? this.canvas.clientWidth;
    const h = parent?.clientHeight ?? this.canvas.clientHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(2, Math.round(w * dpr));
    this.canvas.height = Math.max(2, Math.round(h * dpr));
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  get aspect(): number {
    return this.canvas.width / Math.max(1, this.canvas.height);
  }

  setMesh(mesh: SceneMesh): void {
    const gl = this.gl;
    // 每顶点: pos3 normal3 color3 emissive1 = 10 floats
    const data: number[] = [];
    const pushTri = (
      a: [number, number, number],
      b: [number, number, number],
      c: [number, number, number],
      n: [number, number, number],
      color: [number, number, number],
      emissive: number,
    ) => {
      for (const p of [a, b, c]) data.push(...p, ...n, ...color, emissive);
    };
    for (const t of mesh.triangles) {
      // 建模视图隐藏顶棚（mat=2），像专业设计软件一样“揭盖”看室内
      if (t.mat === 2) continue;
      const m = mesh.materials[t.mat];
      let col = m.albedo;
      let em = 0;
      if (m.kind === 'glass') col = [0.45, 0.62, 0.72];
      if (m.kind === 'emitter') {
        col = [1.0, 0.93, 0.72];
        em = 1;
      }
      pushTri(t.v0, t.v1, t.v2, t.normal, col, em);
    }
    this.vertexCount = data.length / 10;
    if (!this.vao) this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    if (!this.vbo) this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
    const stride = 40;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, stride, 24);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 36);
    gl.bindVertexArray(null);

    // 相机取景
    const cx = (mesh.min[0] + mesh.max[0]) / 2;
    const cz = (mesh.min[2] + mesh.max[2]) / 2;
    const size = Math.max(mesh.max[0] - mesh.min[0], mesh.max[2] - mesh.min[2]);
    this.cam.target = [cx, Math.min(2.2, (mesh.max[1] - mesh.min[1]) * 0.28), cz];
    this.cam.distance = size * 0.92;
    this.cam.elevation = 0.52;
  }

  setProbes(layout: ProbeLayout | null, age?: Float32Array): void {
    const gl = this.gl;
    this.probeCount = layout?.count ?? 0;
    this.probeAge = age ?? null;
    if (!layout) return;
    if (!this.probeVAO) this.probeVAO = gl.createVertexArray();
    gl.bindVertexArray(this.probeVAO);
    if (!this.probeVBO) this.probeVBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.probeVBO);
    gl.bufferData(gl.ARRAY_BUFFER, layout.positions, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
    gl.bindVertexArray(null);
  }

  updateProbeAge(age: Float32Array): void {
    this.probeAge = age;
  }

  setSelectionBox(box: SceneRenderer['selectedBox']): void {
    this.selectedBox = box;
    if (!box) {
      this.lineCount = 0;
      return;
    }
    const { min, max } = box;
    const c = [
      [min[0], min[1], min[2]], [max[0], min[1], min[2]],
      [max[0], min[1], max[2]], [min[0], min[1], max[2]],
      [min[0], max[1], min[2]], [max[0], max[1], min[2]],
      [max[0], max[1], max[2]], [min[0], max[1], max[2]],
    ];
    const edges = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
    const pts: number[] = [];
    for (const [a, b] of edges) pts.push(...c[a], ...c[b]);
    this.lineCount = pts.length / 3;
    const gl = this.gl;
    if (!this.lineVAO) this.lineVAO = gl.createVertexArray();
    gl.bindVertexArray(this.lineVAO);
    if (!this.lineVBO) this.lineVBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVBO);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pts), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
    gl.bindVertexArray(null);
  }

  private bindControls(): void {
    const el = this.canvas;
    let mode: 'orbit' | 'pan' | null = null;
    let lx = 0, ly = 0;
    const down = (e: PointerEvent) => {
      el.setPointerCapture(e.pointerId);
      lx = e.clientX; ly = e.clientY;
      downX = e.clientX; downY = e.clientY;
      if (!this.controlsEnabled) { this.onPointerDown?.(e); return; }
      mode = e.button === 2 || e.shiftKey ? 'pan' : 'orbit';
      this.onPointerDown?.(e);
    };
    let downX = 0, downY = 0;
    const move = (e: PointerEvent) => {
      if (!mode) return;
      const dx = e.clientX - lx, dy = e.clientY - ly;
      lx = e.clientX; ly = e.clientY;
      if (mode === 'orbit') this.cam.rotate(dx, dy);
      else this.cam.pan(dx, dy);
    };
    const up = (e: PointerEvent) => {
      const moved = Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY);
      const wasClick = moved < 5;
      mode = null;
      if (wasClick) this.onClick?.(e);
      this.onPointerUp?.(e);
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      this.cam.zoom(Math.sign(e.deltaY) * 0.08);
    };
    const ctx = (e: Event) => e.preventDefault();
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('contextmenu', ctx);
    this.disposers.push(() => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('contextmenu', ctx);
    });
  }

  onClick?: (e: MouseEvent) => void;
  onPointerDown?: (e: PointerEvent) => void;
  onPointerUp?: (e: PointerEvent) => void;

  /** 鼠标事件 -> 地面 y 交点（世界坐标） */
  eventToGround(e: MouseEvent, planeY = 0): [number, number, number] | null {
    const rect = this.canvas.getBoundingClientRect();
    const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
    return this.cam.screenToGround(nx, ny, this.aspect, planeY);
  }

  private gridBuffer(): number {
    // 24m 间距网格由调用方空间决定，这里画 2m 细网格 + 8m 粗网格
    return 0;
  }

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    const gl = this.gl;
    const { vp, eye } = this.cam.viewProj(this.aspect);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.uVP, false, vp as unknown as Float32Array);
    gl.uniform3fv(this.uEye, eye);
    gl.uniform3f(this.uLD, 0.45, 0.85, 0.35);
    if (this.vao && this.vertexCount) {
      gl.bindVertexArray(this.vao);
      gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);
      gl.bindVertexArray(null);
    }
    // 选中框
    if (this.lineVAO && this.lineCount) {
      gl.useProgram(this.lineProg);
      gl.uniformMatrix4fv(this.lVP, false, vp as unknown as Float32Array);
      gl.uniform4f(this.lColor, 0.35, 0.75, 1, 1);
      gl.bindVertexArray(this.lineVAO);
      gl.drawArrays(gl.LINES, 0, this.lineCount);
      gl.bindVertexArray(null);
    }
    // 探针点（按收敛度着色需要额外属性，这里统一青色）
    if (this.showProbes && this.probeVAO && this.probeCount) {
      gl.useProgram(this.lineProg);
      gl.uniformMatrix4fv(this.lVP, false, vp as unknown as Float32Array);
      gl.uniform4f(this.lColor, 0.3, 0.95, 0.85, 0.9);
      gl.bindVertexArray(this.probeVAO);
      gl.drawArrays(gl.POINTS, 0, this.probeCount);
      gl.bindVertexArray(null);
    }

    // fps
    const now = performance.now();
    const dt = now - this.fpsLast;
    this.fpsLast = now;
    this.fpsAcc += 1000 / Math.max(1, dt);
    this.fpsN++;
    if (this.fpsN >= 20) {
      this.onFrame?.(this.fpsAcc / this.fpsN);
      this.fpsAcc = 0; this.fpsN = 0;
    }
  };

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.resizeObs.disconnect();
    this.disposers.forEach((d) => d());
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
