import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  customType,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import {
  APPLICATION_DIRECTIONS,
  APPLICATION_STATUSES,
  CONTENT_VISIBILITIES,
  EVENT_STATUSES,
  PARTICIPANT_INTENTS,
  TEAM_STATUSES,
} from '@teamup/shared'

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea'
  },
})

export const eventStatusEnum = pgEnum('event_status', EVENT_STATUSES)

/**
 * Everything about an event that used to be "a hardcoded rule" lives
 * here as data: member limits, exclusivity, contact requirements, UI
 * terminology, retention. See spec §0.1 / §4.
 */
export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    recruitClosesAt: timestamp('recruit_closes_at', { withTimezone: true }).notNull(),
    minMembers: integer('min_members').notNull(),
    maxMembers: integer('max_members').notNull(),
    exclusiveMembership: boolean('exclusive_membership').notNull(),
    requiredContacts: integer('required_contacts').notNull().default(0),
    requiresAdultCheck: boolean('requires_adult_check').notNull().default(false),
    termTeam: text('term_team').notNull().default('隊伍'),
    termMember: text('term_member').notNull().default('成員'),
    status: eventStatusEnum('status').notNull().default('draft'),
    retentionDays: integer('retention_days').notNull().default(90),
    /** 0 = participants may not add free-form tags in this event. */
    maxCustomTags: integer('max_custom_tags').notNull().default(0),
    customTagMaxLength: integer('custom_tag_max_length').notNull().default(16),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('events_slug_idx').on(t.slug),
    check('events_members_range', sql`${t.maxMembers} >= ${t.minMembers}`),
    check('events_min_members_positive', sql`${t.minMembers} >= 1`),
    check(
      'events_contacts_within_members',
      sql`${t.requiredContacts} >= 0 AND ${t.requiredContacts} <= ${t.maxMembers}`,
    ),
  ],
)

const dictionaryColumns = {
  id: uuid('id').primaryKey(),
  eventId: uuid('event_id')
    .notNull()
    .references(() => events.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  label: text('label').notNull(),
  category: text('category'),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
}

/** Per-event role dictionary (spec: never a global enum). */
export const eventRoleOptions = pgTable('event_role_options', dictionaryColumns, (t) => [
  uniqueIndex('event_role_options_event_key_idx').on(t.eventId, t.key),
])

/** Per-event skill dictionary. */
export const eventSkillOptions = pgTable('event_skill_options', dictionaryColumns, (t) => [
  uniqueIndex('event_skill_options_event_key_idx').on(t.eventId, t.key),
])

export const userStatusEnum = pgEnum('user_status', ['active', 'suspended', 'deleted'])

/**
 * Account data only — nothing event-specific lives here. Plaintext
 * email never touches this table: ciphertext + HMAC lookup only
 * (spec §4 users, §7.3).
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    emailCiphertext: bytea('email_ciphertext').notNull(),
    emailLookup: bytea('email_lookup').notNull(),
    displayName: text('display_name').notNull(),
    status: userStatusEnum('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('users_email_lookup_idx').on(t.emailLookup)],
)

export const participantIntentEnum = pgEnum('participant_intent', PARTICIPANT_INTENTS)
export const contentVisibilityEnum = pgEnum('content_visibility', CONTENT_VISIBILITIES)

/**
 * Per-event profile: what a user is/wants within one event. The same
 * person joining two events produces two rows (spec §4).
 */
export const eventParticipants = pgTable(
  'event_participants',
  {
    id: uuid('id').primaryKey(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    intent: participantIntentEnum('intent').notNull().default('browsing'),
    preferredRoles: text('preferred_roles')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    skills: text('skills')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    blurb: text('blurb').notNull().default(''),
    /** Free-form tags — reviewed together with the blurb (one visibility). */
    customTags: text('custom_tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    blurbVisibility: contentVisibilityEnum('blurb_visibility').notNull().default('pending_review'),
    isAdult: boolean('is_adult'),
    guardianConsentConfirmed: boolean('guardian_consent_confirmed').notNull().default(false),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('event_participants_event_user_idx').on(t.eventId, t.userId)],
)

export const teamStatusEnum = pgEnum('team_status', TEAM_STATUSES)

export const teams = pgTable(
  'teams',
  {
    id: uuid('id').primaryKey(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    pitch: text('pitch').notNull().default(''),
    pitchVisibility: contentVisibilityEnum('pitch_visibility').notNull().default('pending_review'),
    neededRoles: text('needed_roles')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    neededSkills: text('needed_skills')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: teamStatusEnum('status').notNull().default('recruiting'),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id),
    // Maintained transactionally under SELECT ... FOR UPDATE; the cap
    // itself comes from events.max_members, never from code.
    memberCount: integer('member_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('teams_event_idx').on(t.eventId),
    check('teams_member_count_nonnegative', sql`${t.memberCount} >= 0`),
  ],
)

/**
 * Membership. The one-team-per-person rule (spec §4 team_members) is a
 * partial unique index on (exclusivity_key, user_id) WHERE left_at IS
 * NULL, with exclusivity_key = event_id for exclusive events and
 * team_id otherwise — one index serves both modes.
 */
export const teamMembers = pgTable(
  'team_members',
  {
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    exclusivityKey: uuid('exclusivity_key').notNull(),
    role: text('role'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    leftAt: timestamp('left_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.userId] }),
    uniqueIndex('team_members_exclusivity_idx')
      .on(t.exclusivityKey, t.userId)
      .where(sql`${t.leftAt} IS NULL`),
    index('team_members_user_idx').on(t.userId),
  ],
)

/** Contact persons; how many are required comes from events.required_contacts. */
export const teamContacts = pgTable(
  'team_contacts',
  {
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    rank: integer('rank').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.rank] }),
    uniqueIndex('team_contacts_team_user_idx').on(t.teamId, t.userId),
  ],
)

export const applicationDirectionEnum = pgEnum('application_direction', APPLICATION_DIRECTIONS)
export const applicationStatusEnum = pgEnum('application_status', APPLICATION_STATUSES)

export const applications = pgTable(
  'applications',
  {
    id: uuid('id').primaryKey(),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    /** For invites this is the invitee — always "the person who would join". */
    applicantId: uuid('applicant_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    direction: applicationDirectionEnum('direction').notNull(),
    messageCiphertext: bytea('message_ciphertext'),
    messageVisibility: contentVisibilityEnum('message_visibility')
      .notNull()
      .default('pending_review'),
    status: applicationStatusEnum('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('applications_pending_team_user_idx')
      .on(t.teamId, t.applicantId)
      .where(sql`${t.status} = 'pending'`),
    index('applications_applicant_idx').on(t.applicantId),
  ],
)

/**
 * 1:1 conversation between two users within one event. The pair is
 * stored in normalized order (user_a_id < user_b_id) so each pair has
 * exactly one thread per event.
 */
export const messageThreads = pgTable(
  'message_threads',
  {
    id: uuid('id').primaryKey(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    userAId: uuid('user_a_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    userBId: uuid('user_b_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('message_threads_event_pair_idx').on(t.eventId, t.userAId, t.userBId),
    index('message_threads_user_a_idx').on(t.userAId),
    index('message_threads_user_b_idx').on(t.userBId),
    check('message_threads_pair_ordered', sql`${t.userAId} < ${t.userBId}`),
  ],
)

/** Message bodies are envelope-encrypted; visibility is moderation-driven. */
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey(),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => messageThreads.id, { onDelete: 'cascade' }),
    senderId: uuid('sender_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    bodyCiphertext: bytea('body_ciphertext').notNull(),
    visibility: contentVisibilityEnum('visibility').notNull().default('pending_review'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('messages_thread_idx').on(t.threadId, t.createdAt)],
)

/**
 * User reports against messages (spec §5 extension). A report hides the
 * message for re-review by the escalation moderator; one report per
 * (message, reporter). Rows cascade away with the message or reporter.
 */
export const messageReports = pgTable(
  'message_reports',
  {
    id: uuid('id').primaryKey(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    reporterUserId: uuid('reporter_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reason: text('reason').notNull(),
    status: text('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('message_reports_message_reporter_idx').on(t.messageId, t.reporterUserId),
    index('message_reports_reporter_idx').on(t.reporterUserId),
  ],
)

/**
 * User reports against non-message public content: a team (name +
 * pitch) or an event participant (nickname + blurb + tags). targetId
 * is polymorphic text — the team id, or `eventSlug/userId` — so rows
 * outlive their target (an already-resolved report is history, not a
 * dangling pointer). One report per (targetType, targetId, reporter).
 */
export const contentReports = pgTable(
  'content_reports',
  {
    id: uuid('id').primaryKey(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    reporterUserId: uuid('reporter_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reason: text('reason').notNull(),
    status: text('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('content_reports_target_reporter_idx').on(
      t.targetType,
      t.targetId,
      t.reporterUserId,
    ),
    index('content_reports_target_idx').on(t.targetType, t.targetId),
  ],
)

export const riskLevelEnum = pgEnum('risk_level', ['low', 'medium', 'high'])

/**
 * Moderation verdicts (spec §4). Stores the decision and a SHA-256 of
 * the content — NEVER the content itself. subject_user_id is internal
 * (drives the 3-high-strikes suspension rule) and is never sent to the
 * moderation model (spec §5.6).
 */
export const moderationRecords = pgTable(
  'moderation_records',
  {
    id: uuid('id').primaryKey(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    contentSha256: text('content_sha256').notNull(),
    riskLevel: riskLevelEnum('risk_level').notNull(),
    categories: text('categories')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    rationale: text('rationale').notNull().default(''),
    modelId: text('model_id').notNull(),
    promptVersion: text('prompt_version').notNull(),
    /** 'auto' or 'human:<user uuid>'. */
    decidedBy: text('decided_by').notNull(),
    subjectUserId: uuid('subject_user_id').references(() => users.id, { onDelete: 'set null' }),
    /**
     * Spot-check flag: published as low risk, but rule signals or low
     * model confidence make it worth an after-the-fact human look.
     */
    flagged: boolean('flagged').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('moderation_records_target_idx').on(t.targetType, t.targetId),
    index('moderation_records_subject_idx').on(t.subjectUserId, t.createdAt),
  ],
)

/**
 * Who did what to which data, when (spec §4): decrypt-reads by admins,
 * human moderation decisions, data exports, account deletions.
 * Retained 180 days, purged by the cleanup job.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey(),
    /** Null for system actions (scheduled cleanup). */
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    targetType: text('target_type').notNull().default(''),
    targetId: text('target_id').notNull().default(''),
    detail: text('detail').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_logs_actor_idx').on(t.actorUserId, t.createdAt),
    index('audit_logs_created_idx').on(t.createdAt),
  ],
)
