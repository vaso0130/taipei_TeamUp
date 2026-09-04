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
  ExpandUrlResult,
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

interface RequestOptions {
  method?: string
  token?: string
  body?: unknown
  captcha?: string | undefined
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {}
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
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
    throw new ApiError(res.status, code)
  }
  return (await res.json()) as T
}

const slugPath = (slug: string) => `/api/events/${encodeURIComponent(slug)}`

export const api = {
  listEvents: () => request<{ events: EventSummary[] }>('/api/events'),
  getEvent: (slug: string) => request<EventDetail>(slugPath(slug)),

  getMe: (token: string) => request<MeView>('/api/me', { token }),
  updateMe: (token: string, displayName: string) =>
    request<{ displayName: string }>('/api/me', { method: 'PATCH', token, body: { displayName } }),
  exportMe: (token: string) => request<Record<string, unknown>>('/api/me/export', { token }),
  deleteMe: (token: string) =>
    request<{ deleted: boolean }>('/api/me', { method: 'DELETE', token }),

  getParticipation: async (token: string, slug: string): Promise<ParticipationView | null> => {
    try {
      return await request<ParticipationView>(`${slugPath(slug)}/participation`, { token })
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null
      throw err
    }
  },
  putParticipation: (token: string, slug: string, input: ParticipationInput) =>
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
  createTeam: (token: string, slug: string, input: CreateTeamInput, captcha?: string) =>
    request<TeamDetail>(`${slugPath(slug)}/teams`, { method: 'POST', token, body: input, captcha }),
  myTeam: (token: string, slug: string) =>
    request<{ team: TeamDetail | null }>(`${slugPath(slug)}/my-team`, { token }),
  getTeam: (id: string, token?: string) =>
    request<TeamDetail>(`/api/teams/${encodeURIComponent(id)}`, token ? { token } : {}),
  updateTeam: (token: string, id: string, input: UpdateTeamInput) =>
    request<TeamDetail>(`/api/teams/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      token,
      body: input,
    }),
  putContacts: (token: string, id: string, input: ContactsInput) =>
    request<TeamDetail>(`/api/teams/${encodeURIComponent(id)}/contacts`, {
      method: 'PUT',
      token,
      body: input,
    }),
  leaveTeam: (token: string, id: string) =>
    request<{ left: boolean }>(`/api/teams/${encodeURIComponent(id)}/leave`, {
      method: 'POST',
      token,
    }),
  deleteTeam: (token: string, id: string) =>
    request<{ deleted: boolean }>(`/api/teams/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      token,
    }),

  applyToTeam: (token: string, teamId: string, message: string, captcha?: string) =>
    request<ApplicationView>(`/api/teams/${encodeURIComponent(teamId)}/applications`, {
      method: 'POST',
      token,
      body: { message },
      captcha,
    }),
  inviteToTeam: (token: string, teamId: string, userId: string, message: string) =>
    request<ApplicationView>(`/api/teams/${encodeURIComponent(teamId)}/invitations`, {
      method: 'POST',
      token,
      body: { userId, message },
    }),
  listTeamApplications: (token: string, teamId: string) =>
    request<{ applications: ApplicationView[] }>(
      `/api/teams/${encodeURIComponent(teamId)}/applications`,
      { token },
    ),
  myApplications: (token: string, slug: string) =>
    request<{ applications: ApplicationView[] }>(`${slugPath(slug)}/my-applications`, { token }),
  respondApplication: (token: string, id: string, action: RespondInput['action']) =>
    request<ApplicationView>(`/api/applications/${encodeURIComponent(id)}/respond`, {
      method: 'POST',
      token,
      body: { action },
    }),
  withdrawApplication: (token: string, id: string) =>
    request<{ withdrawn: boolean }>(`/api/applications/${encodeURIComponent(id)}/withdraw`, {
      method: 'POST',
      token,
    }),

  adminListPending: (token: string) =>
    request<{ items: PendingModerationItem[] }>('/api/admin/moderation/pending', { token }),
  adminDecide: (token: string, input: AdminDecideInput) =>
    request<{ decided: boolean }>('/api/admin/moderation/decide', {
      method: 'POST',
      token,
      body: input,
    }),
  adminStats: (token: string, eventSlug: string) =>
    request<AdminStats>(`/api/admin/stats?event=${encodeURIComponent(eventSlug)}`, { token }),
  adminListRisk: (token: string) =>
    request<{ items: RiskMessageItem[] }>('/api/admin/messages/risk', { token }),
  adminGetThread: (token: string, threadId: string) =>
    request<AdminThreadDetail>(`/api/admin/threads/${encodeURIComponent(threadId)}`, { token }),
  adminUserModeration: (token: string, userId: string) =>
    request<UserModerationHistory>(`/api/admin/users/${encodeURIComponent(userId)}/moderation`, {
      token,
    }),
  adminReactivate: (token: string, userId: string) =>
    request<{ reactivated: boolean }>(
      `/api/admin/users/${encodeURIComponent(userId)}/reactivate`,
      { method: 'POST', token },
    ),
  adminSuspend: (token: string, userId: string) =>
    request<{ suspended: boolean }>(`/api/admin/users/${encodeURIComponent(userId)}/suspend`, {
      method: 'POST',
      token,
    }),
  adminListUsers: (token: string, eventSlug: string) =>
    request<{ items: AdminUserItem[] }>(
      `/api/admin/users?event=${encodeURIComponent(eventSlug)}`,
      { token },
    ),
  adminListTeams: (token: string, eventSlug: string) =>
    request<{ items: AdminTeamItem[] }>(
      `/api/admin/teams?event=${encodeURIComponent(eventSlug)}`,
      { token },
    ),
  adminDeleteTeam: (token: string, teamId: string) =>
    request<{ deleted: boolean }>(`/api/admin/teams/${encodeURIComponent(teamId)}`, {
      method: 'DELETE',
      token,
    }),

  listThreads: (token: string, slug: string) =>
    request<{ threads: ThreadView[] }>(`${slugPath(slug)}/threads`, { token }),
  startThread: (token: string, slug: string, toUserId: string, body: string) =>
    request<{ thread: ThreadView; message: MessageView }>(`${slugPath(slug)}/threads`, {
      method: 'POST',
      token,
      body: { toUserId, body },
    }),
  listMessages: (token: string, threadId: string) =>
    request<{ messages: MessageView[] }>(
      `/api/threads/${encodeURIComponent(threadId)}/messages`,
      { token },
    ),
  sendMessage: (token: string, threadId: string, body: string) =>
    request<MessageView>(`/api/threads/${encodeURIComponent(threadId)}/messages`, {
      method: 'POST',
      token,
      body: { body },
    }),
  reportMessage: (token: string, messageId: string, reason: string) =>
    request<{ reported: boolean }>(`/api/messages/${encodeURIComponent(messageId)}/report`, {
      method: 'POST',
      token,
      body: { reason },
    }),
  reportTeam: (token: string, teamId: string, reason: string) =>
    request<{ reported: boolean }>(`/api/teams/${encodeURIComponent(teamId)}/report`, {
      method: 'POST',
      token,
      body: { reason },
    }),
  /** Public anti-scam tool — no login needed. */
  expandUrl: (url: string) =>
    request<ExpandUrlResult>('/api/tools/expand-url', { method: 'POST', body: { url } }),
  reportParticipant: (token: string, eventSlug: string, userId: string, reason: string) =>
    request<{ reported: boolean }>(
      `/api/events/${encodeURIComponent(eventSlug)}/participants/${encodeURIComponent(userId)}/report`,
      { method: 'POST', token, body: { reason } },
    ),
}
