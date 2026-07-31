import { useState } from 'react'
import { Box, Button, Typography } from '@mui/material'
import { Link } from 'react-router-dom'
import type { NotificationItem } from '../../api/client'
import { VARIANT_LABEL } from '../../lib/variants'
import { formatRelativeTime } from './relativeTime'

/** Everything a row needs to render a person-carrying notification: the
 * resolved display name (best-effort — the notification payload only ever
 * carries a raw user id) and, for `friend_request`, the FriendLink id needed
 * to accept/decline (also not in the payload — resolved from the live
 * incoming-requests list). */
export interface NotificationContext {
    name: string | null
    title: string | null
    friendLinkId: string | null
}

export default function NotificationRow({
    item,
    ctx,
    onAcceptFriend,
    onDeclineFriend,
    onAcceptChallenge,
    onDeclineChallenge,
    onOpenCode,
}: {
    item: NotificationItem
    ctx: NotificationContext
    onAcceptFriend: (linkId: string) => Promise<void>
    onDeclineFriend: (linkId: string) => Promise<void>
    onAcceptChallenge: (challengeId: string) => Promise<void>
    onDeclineChallenge: (challengeId: string) => Promise<void>
    onOpenCode: (code: string) => void
}) {
    const [busy, setBusy] = useState(false)
    const [done, setDone] = useState<'accepted' | 'declined' | null>(null)
    const unread = item.read_at === null
    const who = ctx.name ?? 'Someone'

    const wrap = async (fn: () => Promise<void>, outcome: 'accepted' | 'declined') => {
        setBusy(true)
        try {
            await fn()
            setDone(outcome)
        } catch {
            /* left actionable — the user can retry */
        } finally {
            setBusy(false)
        }
    }

    let body: React.ReactNode
    let actions: React.ReactNode = null
    let onRowClick: (() => void) | undefined

    switch (item.type) {
        case 'friend_request': {
            body = (
                <>
                    <NameSpan ctx={ctx} /> sent you a friend request
                </>
            )
            if (done === 'accepted') {
                actions = <Muted>Accepted</Muted>
            } else if (done === 'declined') {
                actions = <Muted>Declined</Muted>
            } else if (ctx.friendLinkId) {
                const linkId = ctx.friendLinkId
                actions = (
                    <ActionRow>
                        <Button
                            size="small"
                            variant="contained"
                            disabled={busy}
                            onClick={() => void wrap(() => onAcceptFriend(linkId), 'accepted')}
                            sx={actionBtnSx}
                        >
                            Accept
                        </Button>
                        <Button
                            size="small"
                            color="inherit"
                            disabled={busy}
                            onClick={() => void wrap(() => onDeclineFriend(linkId), 'declined')}
                            sx={{ ...actionBtnSx, color: 'var(--text-dim)' }}
                        >
                            Decline
                        </Button>
                    </ActionRow>
                )
            } else {
                actions = <Muted>Already handled</Muted>
            }
            break
        }
        case 'friend_accepted': {
            body = (
                <>
                    <NameSpan ctx={ctx} /> accepted your friend request
                </>
            )
            break
        }
        case 'challenge': {
            const pool = item.payload.pool
            const variant = item.payload.variant
            body = (
                <>
                    <NameSpan ctx={ctx} /> challenged you
                    {pool ? ` · ${pool}` : ''}
                    {variant && variant !== 'standard' ? ` · ${VARIANT_LABEL[variant]}` : ''}
                </>
            )
            const challengeId = item.payload.challengeId
            if (done === 'accepted') {
                actions = <Muted>Accepted</Muted>
            } else if (done === 'declined') {
                actions = <Muted>Declined</Muted>
            } else if (challengeId) {
                actions = (
                    <ActionRow>
                        <Button
                            size="small"
                            variant="contained"
                            disabled={busy}
                            onClick={() => void wrap(() => onAcceptChallenge(challengeId), 'accepted')}
                            sx={actionBtnSx}
                        >
                            Accept
                        </Button>
                        <Button
                            size="small"
                            color="inherit"
                            disabled={busy}
                            onClick={() => void wrap(() => onDeclineChallenge(challengeId), 'declined')}
                            sx={{ ...actionBtnSx, color: 'var(--text-dim)' }}
                        >
                            Decline
                        </Button>
                    </ActionRow>
                )
            }
            break
        }
        case 'challenge_accepted': {
            body = (
                <>
                    <NameSpan ctx={ctx} /> accepted your challenge — tap to join
                </>
            )
            const code = item.payload.code
            if (code) onRowClick = () => onOpenCode(code)
            break
        }
        case 'challenge_declined': {
            body = <>Your challenge to {who} was declined</>
            break
        }
        default:
            body = <>{item.type}</>
    }

    return (
        <Box
            onClick={onRowClick}
            sx={{
                display: 'flex',
                flexDirection: 'column',
                gap: 0.5,
                px: 1.5,
                py: 1.1,
                borderLeft: unread ? '2px solid var(--accent)' : '2px solid transparent',
                cursor: onRowClick ? 'pointer' : 'default',
                '&:hover': onRowClick ? { bgcolor: 'var(--line)' } : undefined,
            }}
        >
            <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1 }}>
                <Typography
                    sx={{
                        fontSize: 13,
                        lineHeight: 1.4,
                        color: unread ? 'var(--text)' : 'var(--text-dim)',
                        fontWeight: unread ? 600 : 400,
                    }}
                >
                    {body}
                </Typography>
            </Box>
            <Typography sx={{ fontSize: 11, color: 'var(--muted)' }}>
                {formatRelativeTime(item.created_at)}
            </Typography>
            {actions}
        </Box>
    )
}

function NameSpan({ ctx }: { ctx: NotificationContext }) {
    if (!ctx.name) return <>Someone</>
    return (
        <Box
            component={Link}
            to={`/@/${encodeURIComponent(ctx.name)}`}
            onClick={(e) => e.stopPropagation()}
            sx={{
                fontWeight: 700,
                color: 'inherit',
                textDecoration: 'none',
                '&:hover': { color: 'var(--accent)' },
            }}
        >
            {ctx.name}
        </Box>
    )
}

function Muted({ children }: { children: React.ReactNode }) {
    return <Typography sx={{ fontSize: 11.5, color: 'var(--muted)' }}>{children}</Typography>
}

function ActionRow({ children }: { children: React.ReactNode }) {
    return <Box sx={{ display: 'flex', gap: 0.75, mt: 0.25 }}>{children}</Box>
}

const actionBtnSx = { textTransform: 'none', fontWeight: 600, fontSize: 12, py: 0.4, minWidth: 0 }
