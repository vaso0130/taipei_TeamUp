/**
 * reCAPTCHA Enterprise on abuse-prone actions (spec §8). When no site
 * key is configured (local dev), tokens are simply omitted and the API
 * skips the check.
 */
declare global {
  interface Window {
    grecaptcha?: {
      enterprise: {
        ready(cb: () => void): void
        execute(siteKey: string, opts: { action: string }): Promise<string>
      }
    }
  }
}

const siteKey = import.meta.env.VITE_RECAPTCHA_SITE_KEY

let scriptLoading: Promise<void> | null = null

function loadScript(): Promise<void> {
  scriptLoading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = `https://www.google.com/recaptcha/enterprise.js?render=${encodeURIComponent(siteKey!)}`
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('failed to load reCAPTCHA'))
    document.head.appendChild(script)
  })
  return scriptLoading
}

export async function captchaToken(action: string): Promise<string | undefined> {
  if (!siteKey) return undefined
  try {
    await loadScript()
    const grecaptcha = window.grecaptcha
    if (!grecaptcha) return undefined
    await new Promise<void>((resolve) => grecaptcha.enterprise.ready(resolve))
    return await grecaptcha.enterprise.execute(siteKey, { action })
  } catch (err) {
    // Let the server decide: a missing token fails there when enforced.
    console.error(err)
    return undefined
  }
}
