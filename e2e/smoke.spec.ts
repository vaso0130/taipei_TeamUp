import { expect, test } from '@playwright/test'

/**
 * Read-only smoke: works in seed mode with no database. All content
 * assertions target config-driven copy, not any specific event's data.
 */

test('home renders the seeded event with its hero thesis', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('先找到你的')
  // Event terminology and CTA come from event config.
  await expect(page.getByRole('link', { name: /瀏覽/ })).toBeVisible()
})

test('teams page is reachable and offers filters', async ({ page }) => {
  await page.goto('/teams')
  await expect(page.getByLabel('狀態')).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('找')
})

test('policy pages carry real content and are linked from the footer', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('link', { name: '隱私權政策' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('隱私權政策')
  await expect(page.getByText('一鍵匯出')).toBeVisible()

  await page.goto('/terms')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('服務條款')
})

test('keyboard focus is visible on interactive elements', async ({ page }) => {
  await page.goto('/')
  await page.keyboard.press('Tab')
  const focused = page.locator(':focus')
  await expect(focused).toBeVisible()
})

test('unknown routes render the 404 page with a way back', async ({ page }) => {
  await page.goto('/nonexistent')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('找不到這個頁面')
  await expect(page.getByRole('link', { name: '回首頁' })).toBeVisible()
})

test('signed-out "create" CTA leads to login with an explanation', async ({ page }) => {
  await page.goto('/')
  const cta = page.locator('main a.btn-cta')
  // The CTA only exists while recruiting is open (event config); skip otherwise.
  test.skip((await cta.count()) === 0, 'recruiting closed for the seeded event')
  await cta.first().click()
  await expect(page).toHaveURL(/\/profile\?next=create-team/)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('登入')
  await expect(page.getByText(/登入後即可建立/)).toBeVisible()
})

test('signed-out visit to /admin/events shows the sign-in prompt', async ({ page }) => {
  await page.goto('/admin/events')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('活動管理')
  await expect(page.getByText('僅限管理員使用，請先登入')).toBeVisible()
  await expect(page.getByRole('link', { name: '前往登入' })).toBeVisible()
})

test.describe('mobile header (375px)', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true })

  test('stays on one line, does not overflow, and keeps 44px targets', async ({ page }) => {
    await page.goto('/')
    const header = page.locator('header')
    const metrics = await header.evaluate((el) => {
      const rect = el.getBoundingClientRect()
      const items = [...el.querySelectorAll<HTMLElement>('a, button')].map((n) => {
        const r = n.getBoundingClientRect()
        return { top: Math.round(r.top), height: Math.round(r.height), right: Math.round(r.right) }
      })
      return {
        height: Math.round(rect.height),
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        docScrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        items,
      }
    })
    // Single row: header is short and every item shares the same row.
    expect(metrics.height).toBeLessThan(70)
    const tops = new Set(metrics.items.map((i) => i.top))
    expect(tops.size).toBeLessThanOrEqual(2) // roundel vs. text-only items may differ by a pixel
    // No horizontal overflow of the page or the header.
    expect(metrics.docScrollWidth).toBeLessThanOrEqual(metrics.innerWidth)
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1)
    for (const item of metrics.items) {
      expect(item.height).toBeGreaterThanOrEqual(44)
      expect(item.right).toBeLessThanOrEqual(metrics.innerWidth)
    }
  })
})
