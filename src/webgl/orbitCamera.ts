import type { Vec3 } from '../types';
import { v3 } from '../core/math/vec3';
import type { EngineCamera } from './glEngine';

// 轨道相机：左键旋转、右键平移、滚轮缩放
export class OrbitCamera {
  yaw = -0.7;
  pitch = 0.55;
  distance = 38;
  target: Vec3 = [15, 2, 9];
  fov = Math.PI / 4;
  minDist = 2;
  maxDist = 160;

  private el: HTMLElement;
  private dragging: 0 | 1 | 2 = 0;
  private lastX = 0;
  private lastY = 0;

  constructor(el: HTMLElement) {
    this.el = el;
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  frameRoom(room: { width: number; depth: number; height: number }): void {
    this.target = [room.width / 2, room.height * 0.35, room.depth / 2];
    this.distance = Math.max(room.width, room.depth) * 1.25;
  }

  private onDown = (e: PointerEvent): void => {
    this.dragging = (e.button === 2 ? 2 : 1) as 0 | 1 | 2;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.el.setPointerCapture(e.pointerId);
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    if (this.dragging === 1) {
      this.yaw -= dx * 0.006;
      this.pitch = Math.max(-1.3, Math.min(1.45, this.pitch + dy * 0.006));
    } else {
      const scale = this.distance * 0.0012;
      const right: Vec3 = [Math.cos(this.yaw), 0, -Math.sin(this.yaw)];
      const fwd: Vec3 = [Math.sin(this.yaw), 0, Math.cos(this.yaw)];
      this.target = v3.add(this.target, v3.scale(right, -dx * scale));
      this.target = v3.add(this.target, v3.scale(fwd, dy * scale));
    }
  };

  private onUp = (): void => {
    this.dragging = 0;
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.distance = Math.max(
      this.minDist,
      Math.min(this.maxDist, this.distance * (1 + Math.sign(e.deltaY) * 0.08)),
    );
  };

  get camera(): EngineCamera {
    const cp = Math.cos(this.pitch);
    const eye: Vec3 = [
      this.target[0] + this.distance * cp * Math.sin(this.yaw),
      this.target[1] + this.distance * Math.sin(this.pitch),
      this.target[2] + this.distance * cp * Math.cos(this.yaw),
    ];
    return { eye, target: this.target, fov: this.fov };
  }

  dispose(): void {
    this.el.removeEventListener('pointerdown', this.onDown);
    this.el.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    this.el.removeEventListener('wheel', this.onWheel);
  }
}
