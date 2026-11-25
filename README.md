# 导光管采光设计与照度仿真系统（Tube Daylight Studio）

纯浏览器运行的导光管采光设计工具：空间建模、管道选型、CIE 天空计算、
基于 WebGL2 的 DDGI 动态全局光照、工作面伪彩/等照度线分析。所有项目数据
保存在浏览器 IndexedDB，无后端、无网络依赖。

## 技术栈

- TypeScript + Vite，零运行时 UI 框架依赖
- WebGL2 手写着色器（GLSL ES 3.00），浮点纹理 + FBO 乒乓
- Vitest（CPU 数学/物理单测）+ Playwright（浏览器端 WebGL 验收）

## 运行

```bash
npm install
npm run dev        # 开发服务器
npm run build      # 类型检查 + 生产构建
npm run preview    # 预览生产构建
npm test           # CPU 单元测试（22 项）
npm run test:e2e   # 浏览器端 WebGL 验收（5 项）
```

## 核心模块

### 物理与数学（src/core）
- `sky/sky.ts`：CIE 全阴天（1+2sinγ)/3 与晴天 ISO 15469 type12，
  太阳位置（Spencer 赤纬 + 时差 + 方位角），水平面/竖直面照度
- `pipes/catalog.ts`：管径/管长/弯头的传输效率，双线性插值，
  厂家参数表 CSV 导入；采光罩/漫射器型号
- `gi/probes.ts`：探针网格、6 轴向深度矩、Chebyshev 可见性（防墙后漏光）
- `gi/cpuTracer.ts`：CPU 多弹射路径追踪（解析解对账用）、立方体辐射度
  解析解（Howell 角系数 + 高斯-约当消元）、积分球公式
- `geometry/`：三角网格、Möller–Trumbore BVH（自底向上中位划分）、纹理打包
- `analysis/illuminance.ts`：统计、Marching Squares 等照度线、全年 8760 小时

### GPU 渲染（src/webgl）
- `glsl/common.ts`：BVH 栈遍历光线求交、SH L1+L2 球谐、探针三线性插值、
  Chebyshev 可见性、发光面片解析直接光
- `glsl/probeUpdate.ts`：探针分片轮转更新（每帧只刷一部分，收敛过程可见）
- `glsl/scene.ts`：实例化盒体场景渲染 + 探针可视化
- `glsl/workplane.ts`：工作面照度浮点回读、伪彩图
- `glEngine.ts`：RGBA32F 纹理、ping-pong FBO、EMA 收敛、BVH/材质/发光面纹理

### DDGI 防漏光机制
探针存储 6 轴向深度的一阶/二阶矩，着色点通过主导轴的 Chebyshev 不等式
对 8 邻域探针加权，墙后探针的贡献被抑制，避免光从墙体背面泄漏。

## 验收对照

| 验收要求 | 实现位置 | 自动化测试 |
| --- | --- | --- |
| 白墙空房平均照度误差 <5% | `cpuTracer.pathTraceIlluminance` vs `analyticCubeRoomIlluminance` | `tests/gi.test.ts` |
| 货架移动无漏光 | Chebyshev 深度矩可见性 + BVH 遮挡查询 | `tests/gi.test.ts`、`tests/bvh.test.ts` |
| 约 200 探针渲染 | 厂房默认 231 探针 | E2E 性能测试（真实 GPU 要求 ≥30FPS） |
| 伪彩图/等照度线/统计 | `analysis/illuminance.ts` + 分析页 | E2E 工作面回读 |
| 全年采光时长 | 工作日逐时评估 + 月度柱状图 | `tests/sky.test.ts` |

说明：CI 若无物理 GPU，Playwright 经 SwiftShader 软件渲染运行，
FPS 门槛自动放宽（通过 UNMASKED_RENDERER 识别软件后端）；真实显卡上
探针分片更新设计目标为 200 探针 ≥30FPS。

## 数据与持久化

- IndexedDB：项目、方案、管道参数表（`src/core/db`）
- 支持项目 JSON 导出/导入、参数表 CSV 导入
- 内置示例：带货架老厂房、无窗地下车库
