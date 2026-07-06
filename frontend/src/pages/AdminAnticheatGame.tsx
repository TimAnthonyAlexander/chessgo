import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Box, CircularProgress, Typography } from '@mui/material'
import { ChevronLeft } from 'lucide-react'
import {
    getGameAnalysis,
    getGameAnticheat,
    type Color,
    type GameAnalysis,
    type GameAnticheat,
} from '../api/client'
import { Panel, PanelHead } from '../components/home/Panel'
import GameReportHeader from '../components/admin/anticheat/GameReportHeader'
import GameReviewBoard from '../components/admin/anticheat/GameReviewBoard'
import MoveTimeChart from '../components/admin/anticheat/MoveTimeChart'
import AcStatTiles from '../components/admin/anticheat/AcStatTiles'
import GameFlagList from '../components/admin/anticheat/GameFlagList'

/** Per-game anti-cheat report: the move-by-move board (reusing the app's analysis
 * board stack), the move-time profile, the flagged-side metrics, and the flags
 * tied to this game. Telemetry and analysis are fetched in parallel; a missing
 * analysis degrades gracefully (the telemetry is the primary evidence). */
export default function AdminAnticheatGame() {
    const { id } = useParams<{ id: string }>()
    const [ac, setAc] = useState<GameAnticheat | null>(null)
    const [analysis, setAnalysis] = useState<GameAnalysis | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        if (!id) return
        let cancelled = false
        setLoading(true)
        setError(null)
        setAc(null)
        setAnalysis(null)
        Promise.allSettled([getGameAnticheat(id), getGameAnalysis(id)])
            .then(([acRes, anRes]) => {
                if (cancelled) return
                if (acRes.status === 'fulfilled') setAc(acRes.value)
                else setError(acRes.reason?.message ?? 'Failed to load game telemetry')
                setAnalysis(anRes.status === 'fulfilled' ? anRes.value : null)
            })
            .finally(() => {
                if (!cancelled) setLoading(false)
            })
        return () => {
            cancelled = true
        }
    }, [id])

    // The flagged side of this game: the colour whose player owns a flag here.
    const flaggedColor: Color | null = (() => {
        if (!ac) return null
        for (const f of ac.flags_for_game) {
            if (f.user_id && f.user_id === ac.game.white_user_id) return 'w'
            if (f.user_id && f.user_id === ac.game.black_user_id) return 'b'
        }
        return null
    })()

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <BackLink />

            {loading && !ac ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
                    <CircularProgress size={22} sx={{ color: 'var(--accent)' }} />
                </Box>
            ) : error && !ac ? (
                <Panel>
                    <Typography sx={{ fontSize: 13.5, color: '#ca4a4a' }}>{error}</Typography>
                </Panel>
            ) : ac ? (
                <>
                    <GameReportHeader
                        game={ac.game}
                        scanned={ac.ac_scanned}
                        flaggedColor={flaggedColor}
                    />

                    <AcStatTiles
                        flags={ac.flags_for_game}
                        summary={ac.analysis_summary}
                        game={ac.game}
                    />

                    <Panel>
                        <PanelHead
                            title="Move-by-move"
                            sub="Engine best move, eval, and per-move judgment — step with ← →"
                        />
                        {analysis ? (
                            <GameReviewBoard analysis={analysis} flaggedColor={flaggedColor} />
                        ) : (
                            <Typography sx={{ fontSize: 13, color: 'var(--muted)' }}>
                                {ac.ac_scanned
                                    ? 'Analysis could not be loaded for this game.'
                                    : 'This game has not been analysed yet.'}
                            </Typography>
                        )}
                    </Panel>

                    <MoveTimeChart moveTimes={ac.move_times} />

                    <GameFlagList flags={ac.flags_for_game} />
                </>
            ) : null}
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
