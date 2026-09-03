import { z } from 'zod'
import type { ContentVisibility } from './profile.js'
import { containsControlChars } from './text.js'

export const TEAM_STATUSES = ['recruiting', 'full', 'closed'] as const
export type TeamStatus = (typeof TEAM_STATUSES)[number]

export const APPLICATION_DIRECTIONS = ['apply', 'invite'] as const
export type ApplicationDirection = (typeof APPLICATION_DIRECTIONS)[number]

export const APPLICATION_STATUSES = [
  'pending',
  'accepted',
  'rejected',
  'withdrawn',
  'blocked',
] as const
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number]

const cleanText = (max: number, message: string) =>
  z
    .string()
    .trim()
    .min(1, message)
    .max(max)
    .refine((s) => !containsControlChars(s), message)

export const CreateTeamSchema = z.object({
  name: cleanText(40, '名稱須為 1–40 個字'),
  /** Free text — moderated before it becomes public. */
  pitch: z.string().max(1000).default(''),
  neededRoles: z.array(z.string()).max(20).default([]),
  neededSkills: z.array(z.string()).max(50).default([]),
})
export type CreateTeamInput = z.infer<typeof CreateTeamSchema>

export const UpdateTeamSchema = z.object({
  name: cleanText(40, '名稱須為 1–40 個字').optional(),
  pitch: z.string().max(1000).optional(),
  neededRoles: z.array(z.string()).max(20).optional(),
  neededSkills: z.array(z.string()).max(50).optional(),
  /** Owners may close recruiting or reopen; `full` is system-managed. */
  status: z.enum(['recruiting', 'closed']).optional(),
})
export type UpdateTeamInput = z.infer<typeof UpdateTeamSchema>

export const ContactsSchema = z.object({
  contacts: z
    .array(
      z.object({
        userId: z.string().uuid(),
        /** 1 = primary, 2 = secondary, … count set by event config. */
        rank: z.number().int().min(1).max(10),
      }),
    )
    .max(10),
})
export type ContactsInput = z.infer<typeof ContactsSchema>

export const ApplySchema = z.object({
  message: z.string().max(500).default(''),
})
export type ApplyInput = z.infer<typeof ApplySchema>

export const InviteSchema = z.object({
  userId: z.string().uuid(),
  message: z.string().max(500).default(''),
})
export type InviteInput = z.infer<typeof InviteSchema>

export const RespondSchema = z.object({
  action: z.enum(['accept', 'reject']),
})
export type RespondInput = z.infer<typeof RespondSchema>

// ---- view models ----

export interface TeamSummary {
  id: string
  name: string
  /** Empty string until moderation publishes it (owners see their own). */
  pitch: string
  pitchVisibility: ContentVisibility
  neededRoles: string[]
  neededSkills: string[]
  status: TeamStatus
  memberCount: number
  createdAt: string
}

export interface TeamMemberView {
  userId: string
  displayName: string
  joinedAt: string
}

export interface TeamContactView {
  userId: string
  rank: number
}

export interface TeamDetail extends TeamSummary {
  eventSlug: string
  ownerUserId: string
  members: TeamMemberView[]
  contacts: TeamContactView[]
  /** Convenience flags computed for the requesting viewer (false if anonymous). */
  viewerIsOwner: boolean
  viewerIsMember: boolean
}

export interface ApplicationView {
  id: string
  teamId: string
  teamName: string
  direction: ApplicationDirection
  status: ApplicationStatus
  /**
   * Sender always sees their own message; the counterpart sees it only
   * once moderation publishes it (null while pending/blocked).
   */
  message: string | null
  messageVisibility: ContentVisibility
  applicantId: string
  applicantDisplayName: string
  createdAt: string
}

export interface PublicParticipantView {
  userId: string
  displayName: string
  preferredRoles: string[]
  skills: string[]
  /** Empty until moderation publishes it. */
  blurb: string
  /** Empty until moderation publishes it (reviewed with the blurb). */
  customTags: string[]
}
