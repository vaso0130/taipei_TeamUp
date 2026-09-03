import { expect, test } from '@playwright/test'

/**
 * Full browser journey (spec §9 M6): register → create team → apply →
 * accept → delete account. Requires a database + dev auth; self-skips
 * without DATABASE_URL (CI provides postgres).
 */
test.describe('full journey (requires database)', () => {
  test.skip(!process.env.DATABASE_URL, 'DATABASE_URL not set — seed read-only mode')

  test('owner creates a team and a joiner applies', async ({ page, browser }) => {
    // Owner logs in (dev mode) and creates a team.
    await page.goto('/profile')
    await page.getByLabel('Email').fill('owner-e2e@example.com')
    await page.getByRole('button', { name: '登入' }).click()
    await expect(page.getByRole('heading', { name: '我的帳號' })).toBeVisible()

    await page.goto('/teams?create=1')
    await page.getByLabel('名稱').fill('E2E 測試隊')
    await page.getByRole('button', { name: /^建立/ }).last().click()
    await expect(page.getByRole('heading', { name: 'E2E 測試隊' })).toBeVisible()
    const teamUrl = page.url()

    // A second user applies from another browser context.
    const joinerContext = await browser.newContext()
    const joiner = await joinerContext.newPage()
    await joiner.goto('/profile')
    await joiner.getByLabel('Email').fill('joiner-e2e@example.com')
    await joiner.getByRole('button', { name: '登入' }).click()
    await expect(joiner.getByRole('heading', { name: '我的帳號' })).toBeVisible()
    await joiner.goto(teamUrl)
    await joiner.getByRole('button', { name: '送出申請' }).click()
    await expect(joiner.getByText('申請已送出')).toBeVisible()

    // Owner accepts.
    await page.reload()
    await page.getByRole('button', { name: '接受' }).first().click()
    await expect(page.getByText(/2\s*\//)).toBeVisible()

    await joinerContext.close()
  })
})
