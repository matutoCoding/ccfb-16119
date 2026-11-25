import type { LightPipeDef, PipeCatalog, TransmissionPoint } from '../../types';
import type { SkyField } from '../sky/sky';
import { clamp } from '../math/vec3';

export interface PipeOutput {
  entranceEh: number;     // 采光罩入口水平面照度 lux
  apertureArea: number;   // 采光面积 m²
  domeTrans: number;      // 采光罩透射比
  pipeEfficiency: number; // 管体传输效率（含弯头）
  diffuserTrans: number;  // 漫射器效率
  totalEfficiency: number;
  outputLumens: number;   // 出口光通量 lm
  exitance: number;       // 漫射器出射度 lux
  radiance: number;       // 朗伯面亮度 cd/m²
}

/** 双线性插值管体效率（管径×管长），表外取最近端点并折减 */
export function transmissionEfficiency(cat: PipeCatalog, diameter: number, length: number): number {
  const pts = cat.transmission;
  const diams = [...new Set(pts.map((p) => p.diameter))].sort((a, b) => a - b);
  const d = clamp(diameter, diams[0], diams[diams.length - 1]);
  const atD = (dia: number): TransmissionPoint[] =>
    pts.filter((p) => p.diameter === dia).sort((a, b) => a.length - b.length);
  const interp1 = (dia: number): number => {
    const rows = atD(dia);
    if (length <= rows[0].length) return rows[0].efficiency;
    for (let i = 0; i < rows.length - 1; i++) {
      if (length >= rows[i].length && length <= rows[i + 1].length) {
        const t = (length - rows[i].length) / (rows[i + 1].length - rows[i].length || 1);
        return rows[i].efficiency + t * (rows[i + 1].efficiency - rows[i].efficiency);
      }
    }
    // 超长指数外推：每米损失按末段斜率
    const last = rows[rows.length - 1];
    const prev = rows[rows.length - 2] ?? last;
    const perM = prev === last ? 0.02 :
      Math.log(prev.efficiency / last.efficiency) / Math.max(0.1, last.length - prev.length);
    return last.efficiency * Math.exp(-perM * (length - last.length));
  };
  if (diams.length === 1) return clamp(interp1(diams[0]), 0.02, 1);
  let i0 = 0;
  while (i0 < diams.length - 2 && d > diams[i0 + 1]) i0++;
  const d0 = diams[i0];
  const d1 = diams[i0 + 1] ?? d0;
  const e0 = interp1(d0);
  const e1 = d1 === d0 ? e0 : interp1(d1);
  const t = d1 === d0 ? 0 : (d - d0) / (d1 - d0);
  return clamp(e0 + t * (e1 - e0), 0.02, 1);
}

export function computePipeOutput(
  pipe: LightPipeDef,
  cat: PipeCatalog,
  sky: SkyField,
): PipeOutput {
  const r = pipe.diameter / 2;
  const apertureArea = Math.PI * r * r;
  const dome = cat.domes.find((m) => m.id === pipe.domeModel) ?? cat.domes[0];
  const diff = cat.diffusers.find((m) => m.id === pipe.diffuserModel) ?? cat.diffusers[0];
  const body = transmissionEfficiency(cat, pipe.diameter, pipe.length);
  const elbow = Math.pow(cat.elbowLoss, pipe.elbowCount);
  const pipeEfficiency = body * elbow;
  const total = (dome?.transmittance ?? 0.8) * pipeEfficiency * (diff?.transmittance ?? 0.85);
  const entranceFlux = sky.horizontalEh * apertureArea;
  const outputLumens = entranceFlux * total;
  const exitance = outputLumens / apertureArea;
  return {
    entranceEh: sky.horizontalEh,
    apertureArea,
    domeTrans: dome?.transmittance ?? 0.8,
    pipeEfficiency,
    diffuserTrans: diff?.transmittance ?? 0.85,
    totalEfficiency: total,
    outputLumens,
    exitance,
    radiance: exitance / Math.PI,
  };
}

/** 内置厂家参数表（典型铝制反射管，工程默认值） */
export function defaultCatalog(): PipeCatalog {
  const diameters = [0.33, 0.53, 0.75];
  const base: Record<number, number> = { 0.33: 0.78, 0.53: 0.84, 0.75: 0.88 };
  const perMeter: Record<number, number> = { 0.33: 0.045, 0.53: 0.032, 0.75: 0.024 };
  const lengths = [1, 2, 3, 4, 6, 8, 10];
  const transmission: TransmissionPoint[] = [];
  for (const dia of diameters) {
    for (const l of lengths) {
      transmission.push({
        diameter: dia,
        length: l,
        efficiency: clamp(base[dia] * Math.exp(-perMeter[dia] * (l - 1)), 0.05, 1),
      });
    }
  }
  return {
    id: 'cat_default',
    name: '内置典型参数表（铝反射管）',
    builtin: true,
    diameters,
    transmission,
    elbowLoss: 0.92,
    domes: [
      { id: 'dome_std', name: '标准PC采光罩', transmittance: 0.92, distribution: 'lambertian' },
      { id: 'dome_prism', name: '棱镜增能采光罩', transmittance: 0.95, distribution: 'batwing' },
    ],
    diffusers: [
      { id: 'diff_flat', name: '平板漫射器', transmittance: 0.86, distribution: 'lambertian' },
      { id: 'diff_lens', name: '透镜式漫射器', transmittance: 0.9, distribution: 'batwing' },
    ],
    designOvercastEh: 10000,
  };
}

/** CSV 解析：表头 diameter,length,efficiency（可带 elbowLoss/domede 行） */
export function parseCatalogCsv(text: string): {
  transmission: TransmissionPoint[];
  elbowLoss: number | null;
  errors: string[];
} {
  const errors: string[] = [];
  const transmission: TransmissionPoint[] = [];
  let elbowLoss: number | null = null;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { transmission, elbowLoss, errors: ['空文件'] };
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const iD = header.indexOf('diameter');
  const iL = header.indexOf('length');
  const iE = header.indexOf('efficiency');
  if (iD < 0 || iL < 0 || iE < 0) {
    return { transmission, elbowLoss, errors: ['表头需包含 diameter,length,efficiency'] };
  }
  for (const line of lines.slice(1)) {
    const cells = line.split(',').map((c) => c.trim());
    if (cells[0].startsWith('#')) {
      const kv = cells[0].slice(1).split('=');
      if (kv[0]?.trim() === 'elbowLoss') elbowLoss = Number(kv[1]);
      continue;
    }
    const d = Number(cells[iD]);
    const l = Number(cells[iL]);
    const e = Number(cells[iE]);
    if ([d, l, e].some((n) => Number.isNaN(n))) {
      errors.push(`跳过无效行: ${line}`);
      continue;
    }
    transmission.push({ diameter: d, length: l, efficiency: clamp(e, 0.01, 1) });
  }
  return { transmission, elbowLoss, errors };
}
