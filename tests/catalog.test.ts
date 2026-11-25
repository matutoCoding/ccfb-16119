import { describe, it, expect } from 'vitest';
import {
  transmissionEfficiency, computePipeOutput, parseCatalogCsv, defaultCatalog,
} from '../src/core/pipes/catalog';
import { buildSkyField } from '../src/core/sky/sky';
import type { LightPipeDef, SkySettings } from '../src/types';

const sky: SkySettings = {
  model: 'overcast', latitude: 31.23, longitude: 121.47, timezone: 8,
  date: '2026-03-20', hour: 12, turbidity: 3.5, manualEh: 10000,
};

describe('导光管传输', () => {
  const cat = defaultCatalog();

  it('管长增加效率单调下降', () => {
    const e1 = transmissionEfficiency(cat, 0.53, 1);
    const e6 = transmissionEfficiency(cat, 0.53, 6);
    const e10 = transmissionEfficiency(cat, 0.53, 10);
    expect(e1).toBeGreaterThan(e6);
    expect(e6).toBeGreaterThan(e10);
  });

  it('大管径效率高于小管径', () => {
    expect(transmissionEfficiency(cat, 0.75, 4)).toBeGreaterThan(
      transmissionEfficiency(cat, 0.33, 4),
    );
  });

  it('表外超长做指数外推且不低于 2%', () => {
    const e = transmissionEfficiency(cat, 0.53, 30);
    expect(e).toBeGreaterThan(0.02);
    expect(e).toBeLessThan(transmissionEfficiency(cat, 0.53, 10));
  });

  it('整管输出 = 入口通量 × 采光罩 × 管体 × 弯头 × 漫射器', () => {
    const pipe: LightPipeDef = {
      id: 'p1', name: 't', x: 1, z: 1, diameter: 0.53, length: 4, elbowCount: 2,
      domeModel: 'dome_std', diffuserModel: 'diff_flat', enabled: true,
    };
    const field = buildSkyField(sky, 128);
    const out = computePipeOutput(pipe, cat, field);
    const body = transmissionEfficiency(cat, 0.53, 4);
    const expected = field.horizontalEh * out.apertureArea * 0.92 * body * 0.92 ** 2 * 0.86;
    expect(out.outputLumens).toBeCloseTo(expected, 0);
    expect(out.radiance).toBeCloseTo(out.exitance / Math.PI, 4);
  });

  it('CSV 导入解析与弯头参数', () => {
    const csv = [
      'diameter,length,efficiency',
      '#elbowLoss=0.9',
      '0.53,1,0.85',
      '0.53,3,0.7',
      'bad,row,x',
    ].join('\n');
    const r = parseCatalogCsv(csv);
    expect(r.transmission).toHaveLength(2);
    expect(r.elbowLoss).toBe(0.9);
    expect(r.errors.length).toBe(1);
  });
});
