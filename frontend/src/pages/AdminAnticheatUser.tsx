import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Box, CircularProgress, Typography } from '@mui/material'
import { ChevronLeft } from 'lucide-react'
import { getFlaggedUser, type FlaggedUserDetail, type FlagStatus } from '../api/client'
import { Panel, PanelHead } from '../components/home/Panel'
import FlaggedUserHeader from '../components/admin/anticheat/FlaggedUserHeader'
import CategoryBreakdown from '../components/admin/anticheat/CategoryBreakdown'
import AntiCheatActions from '../components/admin/anticheat/AntiCheatActions'
import FlagEventTimeline from '../components/admin/anticheat/FlagEventTimeline'

/** Per-user anti-cheat review: the flagged account's rollup, its signal breakdown,
 * the admin verdict controls, and the full flag-event timeline with per-category
 * evidence. */
export default function AdminAnticheatUser() {
    const { userId } = useParams<{ userId: string }>()
    const [detail, setDetail] = useState<FlaggedUserDetail | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    // A monotonic request token: every load() bumps it, and only the latest
    // request may commit state. This guards BOTH the effect's fetch and the
    // post-verdict refetch (which calls load() directly) against staleness.
    const reqRef = useRef(0)

    const load = useCallback(() => {
        if (!userId) return
        const token = ++reqRef.current
        setLoading(true)
        setError(null)
        getFlaggedUser(userId)
            .then((d) => {
                if (reqRef.current === token) setDetail(d)
            })
            .catch((e) => {
                if (reqRef.current === token) setError((e as Error).message)
            })
            .finally(() => {
                if (reqRef.current === token) setLoading(false)
            })
    }, [userId])

    useEffect(() => {
        load()
        // Invalidate any in-flight request on unmount / userId change.
        return () => {
            reqRef.current++
        }
    }, [load])

    // On a verdict change, reconcile the header optimistically then refetch so the
    // timeline + rollup reflect any server-side side effects.
    const onVerdict = useCallback(
        (status: FlagStatus) => {
            setDetail((d) => (d ? { ...d, status } : d))
            load()
        },
        [load],
    )

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <BackLink />

            {error ? (
                <Panel>
                    <Typography sx={{ fontSize: 13.5, color: '#ca4a4a' }}>{error}</Typography>
                </Panel>
            ) : !detail ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
                    <CircularProgress size={22} sx={{ color: 'var(--accent)' }} />
                </Box>
            ) : (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, opacity: loading ? 0.7 : 1 }}>
                    <FlaggedUserHeader detail={detail} />

                    <Box
                        sx={{
                            display: 'grid',
                            gap: 2,
                            gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1fr) 300px' },
                            alignItems: 'start',
                        }}
                    >
                        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                            <Panel>
                                <PanelHead
                                    title="Flag timeline"
                                    sub={`${detail.events.length} event${detail.events.length === 1 ? '' : 's'}, newest first — expand a row for evidence`}
                                />
                                <FlagEventTimeline userId={detail.user_id} events={detail.events} />
                            </Panel>
                        </Box>

                        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                            <AntiCheatActions
                                userId={detail.user_id}
                                userName={detail.user_name}
                                status={detail.status}
                                onChanged={onVerdict}
                            />
                            <CategoryBreakdown counts={detail.counts} />
                        </Box>
                    </Box>
                </Box>
            )}
        </Box>
    )
}

function BackLink() {
    return (
        <Box
            component={Link}
            to="/admin/anticheat"
            sx={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 0.375,
                alignSelf: 'flex-start',
                color: 'var(--text-dim)',
                textDecoration: 'none',
                fontSize: 12.5,
                fontWeight: 600,
                '&:hover': { color: 'var(--accent)' },
            }}
        >
            <ChevronLeft size={15} />
            Back to queue
        </Box>
    )
}
