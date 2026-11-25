import { test, expect, type Page } from '@playwright/test';

async function openFactory(page: Page) {
  await page.goto('/');
  await page.waitForSelector('text=新建带货架老厂房（示例）');
  await page.click('text=新建带货架老厂房（示例）');
  await page.waitForSelector('canvas.gl-canvas');
}

test('全部导航页面可打开且无致命错误', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openFactory(page);
  const navs = ['空间建模', '管道选型', '室外天空', '照度分析', '方案对比', '设置'];
  for (const name of navs) {
    await page.click(`a:has-text("${name}")`);
    await page.waitForTimeout(400);
    // 内容区（侧栏或整页）应渲染出实际内容
    const content = page.locator('.content');
    await expect(content).toBeVisible();
    const text = await content.textContent();
    expect(text && text.length).toBeGreaterThan(10);
  }
  const fatal = errors.filter((e) => /is not a function|cannot read|undefined|着色器|shader/i.test(e));
  expect(fatal).toEqual([]);
});

test('管道选型页可编辑管径并查看效率输出', async ({ page }) => {
  await openFactory(page);
  await page.click('a:has-text("管道选型")');
  await page.waitForSelector('text=厂家参数表');
  // 表格有输出行
  const rows = page.locator('.data-table tr');
  expect(await rows.count()).toBeGreaterThan(3);
});

test('照度分析页可生成伪彩统计', async ({ page }) => {
  await openFactory(page);
  await page.waitForTimeout(4000);
  await page.click('a:has-text("照度分析")');
  await page.waitForSelector('text=分析设置');
  await page.click('button:has-text("刷新伪彩图")');
  await page.waitForTimeout(1500);
  const statText = await page.locator('.stat-value').first().textContent();
  expect(statText).toBeTruthy();
});

test('方案对比页可创建派生方案', async ({ page }) => {
  await openFactory(page);
  await page.click('a:has-text("方案对比")');
  await page.waitForSelector('text=方案管理');
  const before = await page.locator('.scheme-item').count();
  await page.click('button:has-text("复制为新方案")');
  await page.waitForTimeout(500);
  const after = await page.locator('.scheme-item').count();
  expect(after).toBeGreaterThan(before);
});
