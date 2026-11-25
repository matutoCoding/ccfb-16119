// 轻量 vec3 / mat4 工具（避免依赖）
export type Vec3 = [number, number, number];

export const v3 = {
  create: (x = 0, y = 0, z = 0): Vec3 => [x, y, z],
  add: (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s],
  mul: (a: Vec3, b: Vec3): Vec3 => [a[0] * b[0], a[1] * b[1], a[2] * b[2]],
  dot: (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ],
  len: (a: Vec3): number => Math.hypot(a[0], a[1], a[2]),
  norm: (a: Vec3): Vec3 => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
  min: (a: Vec3, b: Vec3): Vec3 => [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.min(a[2], b[2]),
  ],
  max: (a: Vec3, b: Vec3): Vec3 => [
    Math.max(a[0], b[0]),
    Math.max(a[1], b[1]),
    Math.max(a[2], b[2]),
  ],
  lerp: (a: Vec3, b: Vec3, t: number): Vec3 => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ],
};

/** 4x4 列主序矩阵（与 WebGL 一致） */
export type Mat4 = Float32Array;

export function mat4Identity(): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function mat4Multiply(a: Mat4, b: Mat4): Mat4 {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

export function mat4Translation(x: number, y: number, z: number): Mat4 {
  const m = mat4Identity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

export function mat4RotationY(rad: number): Mat4 {
  const m = mat4Identity();
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  m[0] = c;
  m[2] = -s;
  m[8] = s;
  m[10] = c;
  return m;
}

export function mat4Scale(x: number, y: number, z: number): Mat4 {
  const m = mat4Identity();
  m[0] = x;
  m[5] = y;
  m[10] = z;
  return m;
}

/** 变换点（w=1） */
export function transformPoint(m: Mat4, p: Vec3): Vec3 {
  const x = p[0],
    y = p[1],
    z = p[2];
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

/** 变换方向（不取平移），并归一化 */
export function transformDir(m: Mat4, p: Vec3): Vec3 {
  const x = p[0],
    y = p[1],
    z = p[2];
  return v3.norm([
    m[0] * x + m[4] * y + m[8] * z,
    m[1] * x + m[5] * y + m[9] * z,
    m[2] * x + m[6] * y + m[10] * z,
  ]);
}

export function mat4Perspective(fovy: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) * nf;
  m[11] = -1;
  m[14] = 2 * far * near * nf;
  return m;
}

export function mat4LookAt(eye: Vec3, center: Vec3, up: Vec3): Mat4 {
  const z = v3.norm(v3.sub(eye, center));
  const x = v3.norm(v3.cross(up, z));
  const y = v3.cross(z, x);
  const m = mat4Identity();
  m[0] = x[0];
  m[1] = y[0];
  m[2] = z[0];
  m[4] = x[1];
  m[5] = y[1];
  m[6] = z[1];
  m[8] = x[2];
  m[9] = y[2];
  m[10] = z[2];
  m[12] = -v3.dot(x, eye);
  m[13] = -v3.dot(y, eye);
  m[14] = -v3.dot(z, eye);
  return m;
}

/** 轨道相机 */
export class OrbitCamera {
  target: Vec3 = [0, 1.5, 0];
  azimuth = -Math.PI / 4;
  elevation = 0.62;
  distance = 30;
  minDist = 2;
  maxDist = 200;

  eye(): Vec3 {
    const ce = Math.cos(this.elevation);
    return [
      this.target[0] + this.distance * ce * Math.sin(this.azimuth),
      this.target[1] + this.distance * Math.sin(this.elevation),
      this.target[2] + this.distance * ce * Math.cos(this.azimuth),
    ];
  }

  viewProj(aspect: number): { view: Mat4; proj: Mat4; vp: Mat4; eye: Vec3 } {
    const eye = this.eye();
    const view = mat4LookAt(eye, this.target, [0, 1, 0]);
    const proj = mat4Perspective((50 * Math.PI) / 180, aspect, 0.1, 400);
    return { view, proj, vp: mat4Multiply(proj, view), eye };
  }

  rotate(dx: number, dy: number): void {
    this.azimuth -= dx * 0.005;
    this.elevation = Math.max(0.05, Math.min(1.45, this.elevation + dy * 0.005));
  }

  pan(dx: number, dy: number): void {
    const eye = this.eye();
    const fwd = v3.norm(v3.sub(this.target, eye));
    const right = v3.norm(v3.cross(fwd, [0, 1, 0]));
    const up = v3.norm(v3.cross(right, fwd));
    const s = this.distance * 0.0016;
    this.target = v3.add(
      this.target,
      v3.add(v3.scale(right, -dx * s), v3.scale(up, dy * s)),
    );
  }

  zoom(delta: number): void {
    this.distance = Math.max(this.minDist, Math.min(this.maxDist, this.distance * (1 + delta)));
  }

  /** 屏幕坐标 -> 地面 y=planeY 交点（用于放置/拖动） */
  screenToGround(
    nx: number,
    ny: number,
    aspect: number,
    planeY = 0,
  ): Vec3 | null {
    const { vp } = this.viewProj(aspect);
    // 逆 vp 求射线（简化：用 eye + 方向反投影）
    const eye = this.eye();
    // 由 vp 矩阵反算远/近点较繁，这里用相机基向量构造
    const fwd = v3.norm(v3.sub(this.target, eye));
    const right = v3.norm(v3.cross(fwd, [0, 1, 0]));
    const up = v3.norm(v3.cross(right, fwd));
    const tan = Math.tan((50 * Math.PI) / 180 / 2);
    const dir = v3.norm(
      v3.add(
        fwd,
        v3.add(v3.scale(right, nx * tan * aspect), v3.scale(up, ny * tan)),
      ),
    );
    if (Math.abs(dir[1]) < 1e-6) return null;
    const t = (planeY - eye[1]) / dir[1];
    if (t < 0) return null;
    return v3.add(eye, v3.scale(dir, t));
  }
}
