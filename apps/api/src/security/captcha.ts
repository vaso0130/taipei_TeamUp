/**
 * Bot protection (spec §8): reCAPTCHA Enterprise assessments on
 * abuse-prone writes. When no verifier is configured (local dev), the
 * check is skipped entirely — never half-enforced.
 */
export interface CaptchaVerifier {
  verify(token: string, expectedAction: string): Promise<boolean>
}

export interface RecaptchaOptions {
  projectId: string
  siteKey: string
  tokenProvider: () => Promise<string>
  minScore?: number
  fetchImpl?: typeof fetch
}

export class RecaptchaEnterpriseVerifier implements CaptchaVerifier {
  private readonly fetchImpl: typeof fetch
  private readonly minScore: number

  constructor(private readonly opts: RecaptchaOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.minScore = opts.minScore ?? 0.5
  }

  async verify(token: string, expectedAction: string): Promise<boolean> {
    const res = await this.fetchImpl(
      `https://recaptchaenterprise.googleapis.com/v1/projects/${this.opts.projectId}/assessments`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await this.opts.tokenProvider()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          event: { token, siteKey: this.opts.siteKey, expectedAction },
        }),
      },
    )
    if (!res.ok) return false
    const body = (await res.json()) as {
      tokenProperties?: { valid?: boolean; action?: string }
      riskAnalysis?: { score?: number }
    }
    return (
      body.tokenProperties?.valid === true &&
      body.tokenProperties.action === expectedAction &&
      (body.riskAnalysis?.score ?? 0) >= this.minScore
    )
  }
}
