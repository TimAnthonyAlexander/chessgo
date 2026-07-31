import { useEffect, useRef, useState } from 'react'
import { Box, IconButton, Tooltip, Typography } from '@mui/material'
import { Bell, CheckCheck } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import {
    acceptChallenge,
    acceptFriendRequest,
    declineChallenge,
    declineFriendRequest,
    getChallenges,
    getFriendRequests,
    getFriends,
    getNotifications,
    markAllNotificationsRead,
    markNotificationsRead,
    type NotificationItem,
} from '../../api/client'
import { useAuth } from '../../lib/auth'
import NotificationRow, { type NotificationContext } from './NotificationRow'

const POLL_MS = 20_000

/** Nav bell: unread badge + a dropdown of recent notifications. Polls
 * GET /notifications on a ~20s cadence, paused while the tab is hidden (and
 * caught up immediately when it becomes visible again). Logged-in only —
 * render nothing for guests, same as NavStreak. */
export default function NotificationBell() {
    const { user } = useAuth()
    const navigate = useNavigate()

    const [items, setItems] = useState<NotificationItem[]>([])
    const [unread, setUnread] = useState(0)
    const [open, setOpen] = useState(false)
    const [ctxById, setCtxById] = useState<Record<string, NotificationContext>>({})
    const wrapRef = useRef<HTMLDivElement | null>(null)

    // --- polling (paused while hidden, caught up on visible) ---
    useEffect(() => {
        if (!user) return
        let cancelled = false
        let timer: number | undefined

        const fetchNow = () => {
            getNotifications()
                .then((r) => {
                    if (cancelled) return
                    setItems(r.items)
                    setUnread(r.unread)
                })
                .catch(() => {
                    /* transient — next poll retries */
                })
        }

        const schedule = () => {
            timer = window.setTimeout(() => {
                if (document.visibilityState === 'visible') fetchNow()
                schedule()
            }, POLL_MS)
        }

        fetchNow()
        schedule()

        const onVisible = () => {
            if (document.visibilityState === 'visible') fetchNow()
        }
        document.addEventListener('visibilitychange', onVisible)

        return () => {
            cancelled = true
            if (timer) window.clearTimeout(timer)
            document.removeEventListener('visibilitychange', onVisible)
        }
    }, [user])

    // --- close on outside click / Escape ---
    useEffect(() => {
        if (!open) return
        const onDown = (e: MouseEvent) => {
            if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
        }
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
            document.removeEventListener('mousedown', onDown)
            document.removeEventListener('keydown', onKey)
        }
    }, [open])

    // --- opening: resolve display names + the FriendLink id friend_request
    // notifications need for inline accept/decline (neither is in the
    // notification payload, which only ever carries a raw user id), then
    // mark whatever's visible read. ---
    const onOpen = () => {
        setOpen(true)

        void Promise.all([getFriendRequests(), getChallenges(), getFriends()])
            .then(([reqs, challenges, friends]) => {
                const byUser: Record<string, NotificationContext> = {}
                const put = (userId: string, name: string | null, title: string | null) => {
                    byUser[userId] = { name, title, friendLinkId: byUser[userId]?.friendLinkId ?? null }
                }
                for (const r of reqs.incoming) {
                    put(r.userId, r.name, r.title)
                    byUser[r.userId].friendLinkId = r.id
                }
                for (const r of reqs.outgoing) put(r.userId, r.name, r.title)
                for (const c of challenges.incoming) put(c.userId, c.name, null)
                for (const c of challenges.outgoing) put(c.userId, c.name, null)
                for (const f of friends.friends) put(f.userId, f.name, f.title)
                setCtxById(byUser)
            })
            .catch(() => {
                /* best-effort — rows fall back to "Someone" */
            })

        const unreadIds = items.filter((i) => i.read_at === null).map((i) => i.id)
        if (unreadIds.length > 0) {
            const now = new Date().toISOString()
            setItems((prev) =>
                prev.map((i) => (unreadIds.includes(i.id) ? { ...i, read_at: i.read_at ?? now } : i)),
            )
            setUnread(0)
            void markNotificationsRead(unreadIds).catch(() => {
                /* best-effort — the poll will reconcile */
            })
        }
    }

    const markAllRead = () => {
        const now = new Date().toISOString()
        setItems((prev) => prev.map((i) => ({ ...i, read_at: i.read_at ?? now })))
        setUnread(0)
        void markAllNotificationsRead().catch(() => {
            /* best-effort */
        })
    }

    const openCode = (code: string) => {
        setOpen(false)
        navigate(`/challenge/${code}`)
    }

    if (!user) return null

    return (
        <Box ref={wrapRef} sx={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <Tooltip title="Notifications">
                <IconButton
                    aria-label="Notifications"
                    size="small"
                    onClick={() => (open ? setOpen(false) : onOpen())}
                    sx={{ color: open ? 'var(--accent)' : 'var(--text-dim)', '&:hover': { color: 'var(--accent)' } }}
                >
                    <Box sx={{ position: 'relative', display: 'flex' }}>
                        <Bell size={18} />
                        {unread > 0 && (
                            <Box
                                sx={{
                                    position: 'absolute',
                                    top: -5,
                                    right: -7,
                                    minWidth: 14,
                                    height: 14,
                                    px: '3px',
                                    borderRadius: '7px',
                                    bgcolor: 'var(--accent)',
                                    color: 'var(--on-accent)',
                                    fontSize: 9.5,
                                    fontWeight: 700,
                                    fontFamily: 'var(--font-mono)',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    lineHeight: 1,
                                }}
                            >
                                {unread > 99 ? '99+' : unread}
                            </Box>
                        )}
                    </Box>
                </IconButton>
            </Tooltip>

            {open && (
                <Box sx={{ position: 'absolute', top: '100%', right: 0, pt: 1, zIndex: 40 }}>
                    <Box
                        sx={{
                            width: 340,
                            maxHeight: 420,
                            display: 'flex',
                            flexDirection: 'column',
                            bgcolor: 'var(--surface)',
                            border: '1px solid var(--line)',
                            borderRadius: '11px',
                            boxShadow: '0 20px 50px -24px rgba(0,0,0,0.85)',
                            overflow: 'hidden',
                        }}
                    >
                        <Box
                            sx={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                px: 1.5,
                                py: 1,
                                borderBottom: '1px solid var(--line-soft)',
                            }}
                        >
                            <Typography sx={{ fontSize: 13, fontWeight: 700 }}>Notifications</Typography>
                            <IconButton
                                aria-label="Mark all read"
                                size="small"
                                onClick={markAllRead}
                                disabled={items.every((i) => i.read_at !== null)}
                                sx={{ color: 'var(--text-dim)', '&:hover': { color: 'var(--accent)' } }}
                            >
                                <CheckCheck size={15} />
                            </IconButton>
                        </Box>

                        <Box sx={{ overflowY: 'auto' }}>
                            {items.length === 0 ? (
                                <Typography sx={{ fontSize: 13, color: 'var(--text-dim)', px: 1.5, py: 3, textAlign: 'center' }}>
                                    Nothing yet.
                                </Typography>
                            ) : (
                                items.map((item, i) => (
                                    <Box key={item.id} sx={{ borderTop: i > 0 ? '1px solid var(--line-soft)' : 'none' }}>
                                        <NotificationRow
                                            item={item}
                                            ctx={ctxById[item.payload.userId ?? ''] ?? { name: null, title: null, friendLinkId: null }}
                                            onAcceptFriend={async (linkId) => {
                                                await acceptFriendRequest(linkId)
                                            }}
                                            onDeclineFriend={async (linkId) => {
                                                await declineFriendRequest(linkId)
                                            }}
                                            onAcceptChallenge={async (challengeId) => {
                                                const r = await acceptChallenge(challengeId)
                                                setOpen(false)
                                                navigate(`/challenge/${r.code}`)
                                            }}
                                            onDeclineChallenge={async (challengeId) => {
                                                await declineChallenge(challengeId)
                                            }}
                                            onOpenCode={openCode}
                                        />
                                    </Box>
                                ))
                            )}
                        </Box>
                    </Box>
                </Box>
            )}
        </Box>
    )
}
