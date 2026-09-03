/**
 * Rule-based pre-processing (spec §5.3): cheap pattern extraction that
 * runs BEFORE the model. Matches are signals fed into the prompt as
 * context — they never block content by themselves (「抓到不代表擋」).
 */

export type SignalKind =
  | 'url'
  | 'shortlink_domain'
  | 'messenger_id'
  | 'phone_number'
  | 'financial_keyword'
  | 'pii_request'

export interface Signal {
  kind: SignalKind
  match: string
}

const URL_PATTERN = /https?:\/\/[^\s<>"']+|(?:^|[\s，。！？])(?:www\.)[^\s<>"']+/giu

const SHORTLINK_DOMAINS = [
  'bit.ly',
  'tinyurl.com',
  'reurl.cc',
  'lihi.cc',
  'lihi1.com',
  'lihi2.com',
  'pse.is',
  'ppt.cc',
  't.co',
  'goo.gl',
  'is.gd',
  'lin.ee',
]

const MESSENGER_PATTERNS: RegExp[] = [
  /(?:line|賴|ライン)\s*(?:id|帳號)?\s*[:：]?\s*@?[a-z0-9._-]{3,}/giu,
  /(?:telegram|tg|微信|wechat|whatsapp|ws)\s*(?:id|帳號|號)?\s*[:：]\s*@?[a-z0-9._-]{3,}/giu,
  /@[a-z0-9_]{4,}\s*(?:私訊|密我|聊)/giu,
]

const PHONE_PATTERN = /(?:\+?886[-\s]?|0)9\d{2}[-\s]?\d{3}[-\s]?\d{3}/g

const FINANCIAL_KEYWORDS = [
  '匯款',
  '轉帳',
  '保證金',
  '訂金',
  '押金',
  '手續費',
  '日領',
  '週領',
  '高薪',
  '被動收入',
  '投資',
  '代操',
  '穩賺',
  '博彩',
  '娛樂城',
  'usdt',
  '虛擬貨幣',
  '加密貨幣出金',
]

const PII_PATTERNS: RegExp[] = [
  /身分證(?:字號|號碼)?/gu,
  /銀行帳[號戶]/gu,
  /提款卡|金融卡/gu,
  /驗證碼/gu,
  /存摺/gu,
]

export function extractSignals(text: string): Signal[] {
  const signals: Signal[] = []
  const push = (kind: SignalKind, match: string) => {
    const trimmed = match.trim()
    if (trimmed && !signals.some((s) => s.kind === kind && s.match === trimmed)) {
      signals.push({ kind, match: trimmed })
    }
  }

  for (const match of text.matchAll(URL_PATTERN)) {
    const url = match[0].trim()
    push('url', url)
    const host = url.replace(/^https?:\/\//iu, '').split(/[/?#]/)[0]?.toLowerCase() ?? ''
    if (SHORTLINK_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) {
      push('shortlink_domain', host)
    }
  }
  for (const pattern of MESSENGER_PATTERNS) {
    for (const match of text.matchAll(pattern)) push('messenger_id', match[0])
  }
  for (const match of text.matchAll(PHONE_PATTERN)) push('phone_number', match[0])
  const lower = text.toLowerCase()
  for (const keyword of FINANCIAL_KEYWORDS) {
    if (lower.includes(keyword)) push('financial_keyword', keyword)
  }
  for (const pattern of PII_PATTERNS) {
    for (const match of text.matchAll(pattern)) push('pii_request', match[0])
  }
  return signals
}
