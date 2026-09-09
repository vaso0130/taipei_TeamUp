import type {
  AdminDecideInput,
  AdminStats,
  AdminTeamItem,
  AdminThreadDetail,
  AdminUserItem,
  RiskMessageItem,
  UserModerationHistory,
  ApplicationView,
  ContactsInput,
  PendingModerationItem,
  CreateTeamInput,
  EventDetail,
  EventSummary,
  MeView,
  MessageView,
  ParticipationInput,
  ParticipationView,
  PublicParticipantView,
  RespondInput,
  TeamDetail,
  TeamSummary,
  ThreadView,
  UpdateTeamInput,
} from '@teamup/shared'

const base = import.meta.env.VITE_API_BASE_URL ?? ''

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(`API ${status}: ${code}`)
    this.name = 'ApiError'
  }
}

/**
 * Bearer token for an authenticated call: a literal string, or a
 * provider resolved right before the request so a Firebase ID token is
 * always fresh (the SDK renews it on demand — a cached string goes
 * stale after about an hour).
 */
export type TokenSource = string | (() => Promise<string | null>)

interface RequestOptions {
  method?: string
  token?: TokenSource
  body?: unknown
  captcha?: string | undefined
}

let unauthorizedHandler: (() => void) | null = null

/**
 * Global 401 hook: called once per rejected authenticated request so the
 * session store can clear itself and the UI can offer a re-login.
 */
export function setUnauthorizedHandler(handler: (() => void) | null) {
  unauthorizedHandler = handler
}

async function resolveToken(source: TokenSource | undefined): Promise<string | null> {
  if (!source) return null
  return typeof source === 'function' ? await source() : source
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {}
  const token = await resolveToken(opts.token)
  if (token) headers.authorization = `Bearer ${token}`
  if (opts.captcha) headers['x-recaptcha-token'] = opts.captcha
  if (opts.body !== undefined) headers['content-type'] = 'application/json'

  const init: RequestInit = { method: opts.method ?? 'GET', headers }
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body)
  const res = await fetch(`${base}${path}`, init)
  if (!res.ok) {
    let code = 'unknown_error'
    try {
      code = ((await res.json()) as { error?: string }).error ?? code
    } catch {
      // non-JSON error body — keep the generic code
    }
    if (res.status === 401 && opts.token) unauthorizedHandler?.()
    throw new ApiError(res.status, code)
  }
  return (await res.json()) as T
}

const slugPath = (slug: string) => `/api/events/${encodeURIComponent(slug)}`

export const api = {
  listEvents: () => request<{ events: EventSummary[] }>('/api/events'),
  getEvent: (slug: string) => request<EventDetail>(slugPath(slug)),

  getMe: (token: TokenSource) => request<MeView>('/api/me', { token }),
  updateMe: (token: TokenSource, displayName: string) =>
    request<{ displayName: string }>('/api/me', { method: 'PATCH', token, body: { displayName } }),
  exportMe: (token: TokenSource) => request<Record<string, unknown>>('/api/me/export', { token }),
  deleteMe: (token: TokenSource) =>
    request<{ deleted: boolean }>('/api/me', { method: 'DELETE', token }),

  getParticipation: async (token: TokenSource, slug: string): Promise<ParticipationView | null> => {
    try {
      return await request<ParticipationView>(`${slugPath(slug)}/participation`, { token })
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null
      throw err
    }
  },
  putParticipation: (token: TokenSource, slug: string, input: ParticipationInput) =>
    request<ParticipationView>(`${slugPath(slug)}/participation`, {
      method: 'PUT',
      token,
      body: input,
    }),
  listParticipants: (slug: string) =>
    request<{ participants: PublicParticipantView[] }>(`${slugPath(slug)}/participants`),

  listTeams: (slug: string, filter: { status?: string; role?: string; skill?: string } = {}) => {
    const params = new URLSearchParams()
    if (filter.status) params.set('status', filter.status)
    if (filter.role) params.set('role', filter.role)
    if (filter.skill) params.set('skill', filter.skill)
    const qs = params.toString()
    return request<{ teams: TeamSummary[] }>(`${slugPath(slug)}/teams${qs ? `?${qs}` : ''}`)
  },
  createTeam: (token: TokenSource, slug: string, input: CreateTeamInput, captcha?: string) =>
    request<TeamDetail>(`${slugPath(slug)}/teams`, { method: 'POST', token, body: input, captcha }),
  myTeam: (token: TokenSource, slug: string) =>
    request<{ team: TeamDetail | null }>(`${slugPath(slug)}/my-team`, { token }),
  getTeam: (id: string, token?: TokenSource) =>
    request<TeamDetail>(`/api/teams/${encodeURIComponent(id)}`, token ? { token } : {}),
  updateTeam: (token: TokenSource, id: string, input: UpdateTeamInput) =>
    request<TeamDetail>(`/api/teams/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      token,
      body: input,
    }),
  putContacts: (token: TokenSource, id: string, input: ContactsInput) =>
    request<TeamDetail>(`/api/teams/${encodeURIComponent(id)}/contacts`, {
      method: 'PUT',
      token,
      body: input,
    }),
  leaveTeam: (token: TokenSource, id: string) =>
    request<{ left: boolean }>(`/api/teams/${encodeURIComponent(id)}/leave`, {
      method: 'POST',
      token,
    }),
  deleteTeam: (token: TokenSource, id: string) =>
    request<{ deleted: boolean }>(`/api/teams/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      token,
    }),

  applyToTeam: (token: TokenSource, teamId: string, message: string, captcha?: string) =>
    request<ApplicationView>(`/api/teams/${encodeURIComponent(teamId)}/applications`, {
      method: 'POST',
      token,
      body: { message },
      captcha,
    }),
  inviteToTeam: (token: TokenSource, teamId: string, userId: string, message: string) =>
    request<ApplicationView>(`/api/teams/${encodeURIComponent(teamId)}/invitations`, {
      method: 'POST',
      token,
      body: { userId, message },
    }),
  listTeamApplications: (token: TokenSource, teamId: string) =>
    request<{ applications: ApplicationView[] }>(
      `/api/teams/${encodeURIComponent(teamId)}/applications`,
      { token },
    ),
  myApplications: (token: TokenSource, slug: string) =>
    request<{ applications: ApplicationView[] }>(`${slugPath(slug)}/my-applications`, { token }),
  respondApplication: (token: TokenSource, id: string, action: RespondInput['action']) =>
    request<ApplicationView>(`/api/applications/${encodeURIComponent(id)}/respond`, {
      method: 'POST',
      token,
      body: { action },
    }),
  withdrawApplication: (token: TokenSource, id: string) =>
    request<{ withdrawn: boolean }>(`/api/applications/${encodeURIComponent(id)}/withdraw`, {
      method: 'POST',
      token,
    }),

  adminListPending: (token: TokenSource) =>
    request<{ items: PendingModerationItem[] }>('/api/admin/moderation/pending', { token }),
  adminDecide: (token: TokenSource, input: AdminDecideInput) =>
    request<{ decided: boolean }>('/api/admin/moderation/decide', {
      method: 'POST',
      token,
      body: input,
    }),
  adminStats: (token: TokenSource, eventSlug: string) =>
    request<AdminStats>(`/api/admin/stats?event=${encodeURIComponent(eventSlug)}`, { token }),
  adminListRisk: (token: TokenSource) =>
    request<{ items: RiskMessageItem[] }>('/api/admin/messages/risk', { token }),
  adminGetThread: (token: TokenSource, threadId: string) =>
    request<AdminThreadDetail>(`/api/admin/threads/${encodeURIComponent(threadId)}`, { token }),
  adminUserModeration: (token: TokenSource, userId: string) =>
    request<UserModerationHistory>(`/api/admin/users/${encodeURIComponent(userId)}/moderation`, {
      token,
    }),
  adminReactivate: (token: TokenSource, userId: string) =>
    request<{ reactivated: boolean }>(
      `/api/admin/users/${encodeURIComponent(userId)}/reactivate`,
      { method: 'POST', token },
    ),
  adminSuspend: (token: TokenSource, userId: string) =>
    request<{ suspended: boolean }>(`/api/admin/users/${encodeURIComponent(userId)}/suspend`, {
      method: 'POST',
      token,
    }),
  adminListUsers: (token: TokenSource, eventSlug: string) =>
    request<{ items: AdminUserItem[] }>(
      `/api/admin/users?event=${encodeURIComponent(eventSlug)}`,
      { token },
    ),
  adminListTeams: (token: TokenSource, eventSlug: string) =>
    request<{ items: AdminTeamItem[] }>(
      `/api/admin/teams?event=${encodeURIComponent(eventSlug)}`,
      { token },
    ),
  adminDeleteTeam: (token: TokenSource, teamId: string) =>
    request<{ deleted: boolean }>(`/api/admin/teams/${encodeURIComponent(teamId)}`, {
      method: 'DELETE',
      token,
    }),

  listThreads: (token: TokenSource, slug: string) =>
    request<{ threads: ThreadView[] }>(`${slugPath(slug)}/threads`, { token }),
  startThread: (token: TokenSource, slug: string, toUserId: string, body: string) =>
    request<{ thread: ThreadView; message: MessageView }>(`${slugPath(slug)}/threads`, {
      method: 'POST',
      token,
      body: { toUserId, body },
    }),
  listMessages: (token: TokenSource, threadId: string) =>
    request<{ messages: MessageView[] }>(
      `/api/threads/${encodeURIComponent(threadId)}/messages`,
      { token },
    ),
  sendMessage: (token: TokenSource, threadId: string, body: string) =>
    request<MessageView>(`/api/threads/${encodeURIComponent(threadId)}/messages`, {
      method: 'POST',
      token,
      body: { body },
    }),
  reportMessage: (token: TokenSource, messageId: string, reason: string) =>
    request<{ reported: boolean }>(`/api/messages/${encodeURIComponent(messageId)}/report`, {
      method: 'POST',
      token,
      body: { reason },
    }),
  reportTeam: (token: TokenSource, teamId: string, reason: string) =>
    request<{ reported: boolean }>(`/api/teams/${encodeURIComponent(teamId)}/report`, {
      method: 'POST',
      token,
      body: { reason },
    }),
  reportParticipant: (token: TokenSource, eventSlug: string, userId: string, reason: string) =>
    request<{ reported: boolean }>(
      `/api/events/${encodeURIComponent(eventSlug)}/participants/${encodeURIComponent(userId)}/report`,
      { method: 'POST', token, body: { reason } },
    ),
}
