import { describe, it, expect } from 'vitest';
import {
  solarPosition, buildSkyField, overcastZenithFromEh, skyLuminance, verticalIlluminance,
} from '../src/core/sky/sky';
import type { SkySettings } from '../src/types';

const base: SkySettings = {
  model: 'overcast',
  latitude: 31.23,
  longitude: 121.47,
  timezone: 8,
  date: '2026-03-20',
  hour: 12,
  turbidity: 3.5,
  manualEh: 10000,
};

describe('CIE 天空', () => {
  it('春分正午太阳在正南附近、高度角≈90-纬度', () => {
    const sun = solarPosition(base);
    expect(sun.altitude * 180 / Math.PI).toBeCloseTo(90 - 31.23, 0);
    expect(Math.abs(sun.azimuth)).toBeLessThan(0.15);
  });

  it('全阴天水平面照度等于指定设计值', () => {
    const field = buildSkyField(base, 512);
    expect(field.horizontalEh).toBeCloseTo(10000, -1);
  });

  it('全阴天亮度天顶最亮、地平线最暗，比值 3:1', () => {
    const field = buildSkyField(base, 256);
    const lz = skyLuminance([0, 1, 0], base, field.sun, field.zenithLuminance);
    const lh = skyLuminance([1, 0, 0], base, field.sun, field.zenithLuminance);
    expect(lz / lh).toBeCloseTo(3, 1);
    expect(overcastZenithFromEh(10000)).toBeCloseTo(field.zenithLuminance, 0);
  });

  it('夜间太阳高度角为负，晴空直射为 0', () => {
    const night: SkySettings = { ...base, model: 'clear', manualEh: null, hour: 23 };
    const field = buildSkyField(night, 128);
    expect(field.sun.altitude).toBeLessThan(0);
    expect(field.directNormal).toBe(0);
  });

  it('竖直墙面照度小于水平面且为正', () => {
    const field = buildSkyField(base, 512);
    const ev = verticalIlluminance(field, [0, 0, 1]);
    expect(ev).toBeGreaterThan(0);
    expect(ev).toBeLessThan(field.horizontalEh * 1.1);
  });

  it('晴天正午水平面照度高于全阴天设计值量级合理', () => {
    const clear: SkySettings = { ...base, model: 'clear', hour: 12, manualEh: null };
    const field = buildSkyField(clear, 256);
    expect(field.horizontalEh).toBeGreaterThan(20000);
  });
});
