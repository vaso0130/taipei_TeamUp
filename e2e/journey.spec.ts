import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

/**
 * Full browser journey (spec §9 M6): register → participation → create
 * team → apply → accept. Requires a database + dev auth; self-skips
 * without DATABASE_URL (CI provides postgres).
 */
test.describe('full journey (requires database)', () => {
  test.skip(!process.env.DATABASE_URL, 'DATABASE_URL not set — seed read-only mode')

  /** The open event the journey runs in — never hardcoded. */
  async function openEvent(request: APIRequestContext) {
    const res = await request.get('/api/events')
    const { events } = (await res.json()) as {
      events: { slug: string; name: string; status: string }[]
    }
    const event = events.find((e) => e.status === 'open')
    test.skip(!event, 'no open event in the seed')
    return event!
  }

  /** Dev-mode login on /profile. */
  async function login(page: Page, email: string) {
    await page.goto('/profile')
    await page.getByLabel('Email').fill(email)
    await page.getByRole('button', { name: '登入' }).click()
    await expect(page.getByRole('heading', { name: '我的帳號' })).toBeVisible()
  }

  /**
   * Creating a team, applying, inviting and accepting all require a
   * participation record for the event (ADR-026: participation_required),
   * including the adult answer when the event asks for it. The form
   * defaults (intent = looking for a team) are enough; only the adult
   * question needs an explicit answer, and only when the event shows it.
   * The profile shows one section per open event; pick ours by name and
   * expand it in case it is not the default-open one.
   */
  async function completeParticipation(page: Page, eventName: string) {
    const section = page.getByRole('region', { name: `我在「${eventName}」` })
    await expect(section).toBeVisible()
    const details = section.locator('details')
    if (!(await details.evaluate((el) => (el as HTMLDetailsElement).open))) {
      await section.locator('summary').click()
    }
    const adultQuestion = section.getByRole('group', { name: '你是否年滿 18 歲？' })
    if ((await adultQuestion.count()) > 0) {
      await adultQuestion.getByText('是', { exact: true }).click()
    }
    await section.getByRole('button', { name: '儲存檔案' }).click()
    await expect(section.getByRole('status')).toHaveText('已儲存')
  }

  test('owner creates a team and a joiner applies', async ({ page, browser, request }) => {
    const event = await openEvent(request)

    // Owner logs in (dev mode), completes participation and creates a team.
    await login(page, 'owner-e2e@example.com')
    await completeParticipation(page, event.name)

    await page.goto(`/e/${event.slug}/teams?create=1`)
    await page.getByLabel('名稱').fill('E2E 測試隊')
    await page.getByRole('button', { name: /^建立/ }).last().click()
    await expect(page.getByRole('heading', { name: 'E2E 測試隊' })).toBeVisible()
    const teamUrl = page.url()
    expect(teamUrl).toContain(`/e/${event.slug}/teams/`)

    // A second user applies from another browser context.
    const joinerContext = await browser.newContext()
    const joiner = await joinerContext.newPage()
    await login(joiner, 'joiner-e2e@example.com')
    await completeParticipation(joiner, event.name)
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
