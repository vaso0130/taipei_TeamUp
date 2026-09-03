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
