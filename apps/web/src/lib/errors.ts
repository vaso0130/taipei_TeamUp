import { ApiError } from '../api/client.js'

interface ErrorCopyContext {
  termTeam: string
  termMember?: string
}

/**
 * Shared user-facing copy for API error codes that can surface from any
 * write action. Pages add their own action-specific codes first and fall
 * back to this; the final fallback is the caller's generic message.
 */
export function describeApiError(
  err: unknown,
  ctx: ErrorCopyContext,
  fallback: string,
  overrides: Record<string, string> = {},
): string {
  if (!(err instanceof ApiError)) return fallback
  const specific = overrides[err.code]
  if (specific) return specific
  switch (err.code) {
    case 'rate_limited':
      return '操作太頻繁，請稍後再試'
    case 'captcha_failed':
      return '驗證失敗，請重新操作'
    case 'validation_failed':
      return '輸入內容不符合格式，請檢查欄位長度與必填項目'
    case 'payload_too_large':
      return '內容過長，請縮短後再試'
    case 'not_pending':
      return '這筆申請已處理過'
    case 'participation_required':
      return '請先到個人檔案完成參加資料（含年齡確認）'
    case 'adult_check_required':
      return '請先回答是否年滿 18 歲'
    case 'not_recruiting':
    case 'recruiting_closed':
      return `這個${ctx.termTeam}目前不接受申請或邀請`
    case 'team_full':
      return `${ctx.termTeam}已滿編`
    case 'already_in_team':
      return `已在其他${ctx.termTeam}中`
    case 'already_in_this_team':
      return `已經是這個${ctx.termTeam}的${ctx.termMember ?? '成員'}`
    case 'duplicate_application':
      return '已有一筆等待回覆的申請或邀請'
    case 'name_rejected':
      return '名稱未通過自動化篩選，請換一個'
    case 'moderation_unavailable':
      return '自動化篩選暫時無法使用，請稍後再試'
    case 'unauthorized':
      return '登入已過期，請重新登入'
    case 'forbidden':
      return '你沒有權限執行這個操作'
    // 活動管理（docs/design/admin-events.md §5）
    case 'slug_taken':
      return '這個代號已被使用'
    case 'slug_immutable':
      return '網址代號建立後不可更改'
    case 'max_members_below_existing':
      return `已有${ctx.termTeam}的人數超過這個上限`
    case 'min_members_above_existing':
      return `已有${ctx.termTeam}的人數低於這個下限`
    case 'dictionary_key_in_use':
      return '已有人選用這個選項，只能停用不能刪除'
    case 'cannot_open_incomplete':
      return '活動設定還不完整，無法開放'
    case 'invalid_status_transition':
      return '目前狀態不能直接變成這個狀態'
    case 'event_not_empty':
      return `已有參加者或${ctx.termTeam}，無法刪除`
    case 'event_not_found':
      return '找不到這場活動'
    case 'read_only_mode':
      return '目前為唯讀模式（未連接資料庫），無法修改活動設定'
    case 'unavailable':
      return '服務暫時無法使用，請稍後再試'
    default:
      break
  }
  if (err.status === 401) return '登入已過期，請重新登入'
  if (err.status === 429) return '操作太頻繁，請稍後再試'
  if (err.status === 503) return '服務暫時無法使用，請稍後再試'
  return fallback
}

/** Seed read-only mode (no database): admin writes are refused with 503. */
export function isReadOnlyMode(err: unknown): boolean {
  return err instanceof ApiError && err.status === 503
}

/** Classify a read failure for list/detail pages. */
export type LoadFailure = 'not_found' | 'unavailable' | 'failed'

export function classifyLoadError(err: unknown): LoadFailure {
  if (err instanceof ApiError) {
    if (err.status === 404) return 'not_found'
    if (err.status === 503 || err.status === 502 || err.status === 500) return 'unavailable'
  }
  return 'failed'
}
