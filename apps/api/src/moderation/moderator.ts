export type RiskLevel = 'low' | 'medium' | 'high'

export const MODERATION_CATEGORIES = [
  'financial_scam',
  'phishing_link',
  'pii_request',
  'pii_disclosure',
  'off_platform_contact',
  'harassment',
  'spam',
  'none',
] as const
export type ModerationCategory = (typeof MODERATION_CATEGORIES)[number]

export interface ModerationVerdict {
  riskLevel: RiskLevel
  categories: ModerationCategory[]
  /** Short model-provided reason; must never contain the original text. */
  rationale?: string
  confidence?: number
}

/**
 * Who is talking to whom — context the model needs to judge correctly:
 * teammates exchanging LINE ids after forming a team is normal
 * coordination; a stranger luring someone off-platform is not
 * (see ADR-010).
 */
export interface ModerationContext {
  contentType: 'bio' | 'pitch' | 'message' | 'application_message' | 'name'
  relationship?: 'teammates' | 'applicant_owner' | 'strangers'
  /**
   * Present when a user reported the content — the reasons they chose.
   * Never contains free text (enum values only, spec data minimization).
   */
  reportReasons?: string[]
}

/**
 * Content moderation boundary. Production uses the Gemini pipeline
 * (rule pre-processing + Vertex AI, spec §5); local development uses
 * MockModerator. Callers must treat any thrown error as fail-closed
 * (pending review, never publish).
 */
export interface Moderator {
  review(text: string, context?: ModerationContext): Promise<ModerationVerdict>
}

/** Local development / test moderator: never calls any external API. */
export class MockModerator implements Moderator {
  review(): Promise<ModerationVerdict> {
    return Promise.resolve({ riskLevel: 'low', categories: [] })
  }
}

export const visibilityFor = (verdict: ModerationVerdict) =>
  verdict.riskLevel === 'low'
    ? ('published' as const)
    : verdict.riskLevel === 'medium'
      ? ('pending_review' as const)
      : ('blocked' as const)
