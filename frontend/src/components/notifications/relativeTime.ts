// Compact "time ago" formatter for notification/request timestamps. Backend
// timestamps are MySQL `Y-m-d H:i:s` (UTC, no offset) — Safari/older engines
// refuse to parse that without a `T`/`Z`, so normalize before handing it to
// `Date`.
export function formatRelativeTime(input: string): string {
    const iso = input.includes('T') ? input : `${input.replace(' ', 'T')}Z`
    const then = new Date(iso).getTime()
    if (Number.isNaN(then)) return ''

    const seconds = Math.max(0, Math.round((Date.now() - then) / 1000))
    if (seconds < 45) return 'just now'

    const minutes = Math.round(seconds / 60)
    if (minutes < 60) return `${minutes}m ago`

    const hours = Math.round(minutes / 60)
    if (hours < 24) return `${hours}h ago`

    const days = Math.round(hours / 24)
    if (days < 30) return `${days}d ago`

    const months = Math.round(days / 30)
    if (months < 12) return `${months}mo ago`

    const years = Math.round(months / 12)
    return `${years}y ago`
}
