import { z } from 'zod'

/** Public anti-scam tool: expand a short URL without visiting it. */
export const ExpandUrlSchema = z.object({
  url: z.string().trim().min(1).max(2048),
})
export type ExpandUrlInput = z.infer<typeof ExpandUrlSchema>

export type ExpandWarning =
  /** Final destination is plain http. */
  | 'not_https'
  /** Long redirect chain (layered shorteners are a scam pattern). */
  | 'many_hops'
  /** A hop's host is a raw IP address. */
  | 'ip_host'
  /** URL carries user:password@ — a lookalike-domain trick. */
  | 'userinfo'
  /** Internationalized (xn--) hostname — check for homograph lookalikes. */
  | 'idn_host'
  /** The chain revisited a URL. */
  | 'redirect_loop'
  /** Gave up after the redirect budget. */
  | 'too_many_redirects'
  /** A hop could not be reached (timeout / DNS / refused). */
  | 'unreachable'
  /** A hop pointed at a private or internal address — refused. */
  | 'blocked_private'
  /** A hop used a scheme other than http(s). */
  | 'unsupported_scheme'

export interface ExpandHop {
  url: string
  /** HTTP status of this hop; null when the request itself failed. */
  status: number | null
}

export interface ExpandUrlResult {
  hops: ExpandHop[]
  /** Where the chain settled; null when it never reached a final page. */
  finalUrl: string | null
  warnings: ExpandWarning[]
  error?: 'invalid_url'
}
