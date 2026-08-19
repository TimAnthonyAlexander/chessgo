import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Box, IconButton, Typography } from '@mui/material'
import { Bell, CheckCheck } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import IconBtn from '../nav/IconBtn'
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

const PANEL_W = 340
const PANEL_MAX_H = 420
/** Gap between the trigger and the panel, and the minimum clearance to any
 *  viewport edge. */
const GAP = 8

/** Where to put the panel, given the trigger's box and the panel's real height.
 *
 *  One rule covers both navs, which is the point — the bell does not know or care
 *  which one it is sitting in:
 *
 *  • Horizontally it right-aligns to the trigger, the normal drop-down behaviour
 *    under the top bar. In the side rail that would push a 340px panel off the
 *    left edge of the screen, so it FLIPS and opens to the RIGHT — past the rail's
 *    own edge, not just the button's, so the panel sits beside the nav instead of
 *    half on top of it. That is the chess.com side-rail behaviour.
 *  • Vertically it drops below the trigger, and when that would run past the
 *    bottom (the rail again, where the bell sits ~80px off the floor) it rides up
 *    so the panel's bottom rests just inside the viewport instead.
 *
 *  Measured off the real panel height rather than the max, so a two-item list
 *  sits against the bottom edge instead of floating 300px above it.
 *
 *  `flipFrom` is the x the flipped panel starts from — the enclosing <nav>'s right
 *  edge when there is one, the trigger's own otherwise. */
function place(rect: DOMRect, panelH: number, flipFrom: number): { top: number; left: number } {
    const vw = window.innerWidth
    const vh = window.innerHeight

    let left = rect.right - PANEL_W
    if (left < GAP) left = flipFrom + GAP
    left = Math.max(GAP, Math.min(left, vw - PANEL_W - GAP))

    let top = rect.bottom + GAP
    if (top + panelH + GAP > vh) top = vh - panelH - GAP
    top = Math.max(GAP, top)

    return { top, left }
}

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
    const panelRef = useRef<HTMLDivElement | null>(null)
    const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

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

    // --- placement ---
    // The panel is PORTALLED to the body and positioned `fixed`, for the same two
    // reasons SidebarNav's flyout is: the rail is `position: sticky`, which opens a
    // stacking context a child z-index cannot escape, and the panel has to be able
    // to leave the rail's 232px column entirely. Measured after render (a layout
    // effect, so it never paints at the wrong spot) because `place` needs the real
    // panel height.
    const reposition = useCallback(() => {
        const el = wrapRef.current
        const r = el?.getBoundingClientRect()
        if (!el || !r) return
        // The rail is the <nav> this bell lives in; in the top bar the flip never
        // fires, so which element this resolves to there does not matter.
        const nav = el.closest('nav')?.getBoundingClientRect()
        setPos(place(r, panelRef.current?.offsetHeight ?? PANEL_MAX_H, nav?.right ?? r.right))
    }, [])

    useLayoutEffect(() => {
        if (!open) {
            setPos(null)
            return
        }
        reposition()
        // Recompute rather than close: the page behind can scroll while the panel
        // is open (the rail is sticky, the content is not).
        window.addEventListener('resize', reposition)
        window.addEventListener('scroll', reposition, true)
        return () => {
            window.removeEventListener('resize', reposition)
            window.removeEventListener('scroll', reposition, true)
        }
        // `items` is in the deps because the list growing changes the panel height,
        // which changes where its bottom edge should sit.
    }, [open, items, reposition])

    // --- close on outside click / Escape ---
    useEffect(() => {
        if (!open) return
        const onDown = (e: MouseEvent) => {
            const t = e.target as Node
            // Both halves: the trigger, and the panel — which, portalled, is not a
            // DOM descendant of the trigger, so a click inside it would otherwise
            // read as "outside" and close the thing being clicked.
            if (wrapRef.current?.contains(t) || panelRef.current?.contains(t)) return
            setOpen(false)
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
        <Box ref={wrapRef} sx={{ display: 'flex', alignItems: 'center' }}>
            <IconBtn
                label="Notifications"
                active={open}
                onClick={() => (open ? setOpen(false) : onOpen())}
            >
                <Box sx={{ position: 'relative', display: 'flex' }}>
                    <Bell size={17} />
                    {unread > 0 && (
                        <Box
                            sx={{
                                position: 'absolute',
                                top: -5,
                                right: -7,
                                minWidth: 14,
                                height: 14,
                                px: '3px',
                                borderRadius: 'var(--radius)',
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
            </IconBtn>

            {open &&
                createPortal(
                    <Box
                        ref={panelRef}
                        sx={{
                            position: 'fixed',
                            top: `${pos?.top ?? 0}px`,
                            left: `${pos?.left ?? 0}px`,
                            // Hidden for the one layout pass between "rendered" and
                            // "measured", so it never flashes at 0,0.
                            visibility: pos ? 'visible' : 'hidden',
                            zIndex: 1200,
                            width: PANEL_W,
                            maxHeight: PANEL_MAX_H,
                            display: 'flex',
                            flexDirection: 'column',
                            bgcolor: 'var(--surface)',
                            border: '1px solid var(--line)',
                            borderRadius: 'var(--radius)',
                            boxShadow: 'var(--shadow)',
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
                    </Box>,
                    document.body,
                )}
        </Box>
    )
}
