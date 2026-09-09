import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

/**
 * Read-only smoke: works in seed mode with no database. All content
 * assertions target config-driven copy, not any specific event's data —
 * the event under test is whatever the running API lists first.
 */

interface PublicEvent {
  slug: string
  name: string
  status: 'open' | 'closed'
}

/** The public event list (open + closed) from the API behind the dev proxy. */
async function listEvents(request: APIRequestContext): Promise<PublicEvent[]> {
  const res = await request.get('/api/events')
  expect(res.ok()).toBeTruthy()
  return ((await res.json()) as { events: PublicEvent[] }).events
}

/** An event to browse: the first open one, else the first listed. */
async function anyEvent(request: APIRequestContext): Promise<PublicEvent> {
  const events = await listEvents(request)
  const event = events.find((e) => e.status === 'open') ?? events[0]
  test.skip(!event, 'no events in the seed')
  return event!
}

/** Header metrics for the 375px single-row assertion. */
async function headerMetrics(page: Page) {
  return page.locator('header').evaluate((el) => {
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
}

function expectSingleRowHeader(metrics: Awaited<ReturnType<typeof headerMetrics>>) {
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
}

test('event home renders the hero thesis and names the event in the header', async ({
  page,
  request,
}) => {
  const event = await anyEvent(request)
  await page.goto(`/e/${event.slug}`)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('先找到你的')
  // Event terminology and CTA come from event config.
  await expect(page.getByRole('link', { name: /瀏覽/ })).toBeVisible()
  // "Where you are": the header carries the event name inside the event layer.
  await expect(page.getByTestId('header-event-name')).toHaveText(event.name)
})

test('teams page is reachable and offers filters', async ({ page, request }) => {
  const event = await anyEvent(request)
  await page.goto(`/e/${event.slug}/teams`)
  await expect(page.getByLabel('狀態')).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('找')
})

test('legacy /teams redirects by the three-step rule', async ({ page, request }) => {
  // docs/design/landing-and-event-layer.md §2: VITE_EVENT_SLUG → sole open event → event list.
  const envSlug = process.env.VITE_EVENT_SLUG
  const open = (await listEvents(request)).filter((e) => e.status === 'open')
  await page.goto('/teams')
  if (envSlug) {
    await expect(page).toHaveURL(new RegExp(`/e/${envSlug}/teams$`))
  } else if (open.length === 1) {
    await expect(page).toHaveURL(new RegExp(`/e/${open[0]!.slug}/teams$`))
  } else {
    // vue-router leaves "/" unencoded in query values; accept either form.
    await expect(page).toHaveURL(/\/\?next=(%2F|\/)teams$/)
  }
})

test('unknown event slug renders the 404 page', async ({ page }) => {
  await page.goto('/e/not-exist')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('找不到這個頁面')
  await expect(page.getByRole('link', { name: '回首頁' })).toBeVisible()
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

test('signed-out "create" CTA leads to login with an explanation', async ({ page, request }) => {
  const event = await anyEvent(request)
  await page.goto(`/e/${event.slug}`)
  const cta = page.locator('main a.btn-cta')
  // The CTA only exists while recruiting is open (event config); skip otherwise.
  test.skip((await cta.count()) === 0, 'recruiting closed for the seeded event')
  await cta.first().click()
  // The CTA carries its event so login can return to the right create form.
  await expect(page).toHaveURL(new RegExp(`/profile\\?next=create-team&event=${event.slug}`))
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

  test('outside an event: one line, no overflow, 44px targets', async ({ page }) => {
    await page.goto('/')
    expectSingleRowHeader(await headerMetrics(page))
  })

  test('inside an event: event nav still fits one line', async ({ page, request }) => {
    const event = await anyEvent(request)
    await page.goto(`/e/${event.slug}`)
    await expect(page.getByRole('link', { name: '找團' })).toBeVisible()
    expectSingleRowHeader(await headerMetrics(page))
  })
})
