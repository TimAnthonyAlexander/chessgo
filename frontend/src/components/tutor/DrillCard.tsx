import { Box, Button, Typography } from '@mui/material'
import { ArrowRight } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import type { TutorDrill } from '../../api/client'
import { Panel } from '../home/Panel'
import MiniBoard from '../MiniBoard'
import { fmtDate } from './format'

/** The point of the whole feature: what to actually DO about a weakness.
 * Exactly one primary button per card — the per-position/per-game rows below
 * it are plain inline links, not competing recommendations. */
export default function DrillCard({ drill }: { drill: TutorDrill }) {
    const navigate = useNavigate()

    return (
        <Panel sx={{ mb: 2 }}>
            <Typography
                sx={{
                    fontFamily: 'var(--font-display)',
                    fontSize: 17,
                    fontWeight: 700,
                    lineHeight: 1.2,
                }}
            >
                {drill.title}
            </Typography>
            <Typography sx={{ fontSize: 13, color: 'var(--text-dim)', mt: 0.5, mb: 2 }}>
                {drill.blurb}
            </Typography>

            {drill.kind === 'puzzles' && (
                <PuzzlesBody drill={drill} onNavigate={(to) => navigate(to)} />
            )}
            {drill.kind === 'replay' && (
                <ReplayBody drill={drill} onNavigate={(to) => navigate(to)} />
            )}
            {drill.kind === 'opening' && (
                <OpeningBody drill={drill} onNavigate={(to) => navigate(to)} />
            )}
            {drill.kind === 'games' && <GamesBody drill={drill} />}
        </Panel>
    )
}

function PrimaryButton({ label, onClick }: { label: string; onClick: () => void }) {
    return (
        <Button
            variant="contained"
            onClick={onClick}
            endIcon={<ArrowRight size={15} />}
            sx={{ textTransform: 'none', fontWeight: 600 }}
        >
            {label}
        </Button>
    )
}

function PuzzlesBody({
    drill,
    onNavigate,
}: {
    drill: TutorDrill
    onNavigate: (to: string) => void
}) {
    const themes = drill.themes ?? []
    if (themes.length === 0) return null
    const rest = themes.slice(1)
    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
            <Box>
                <PrimaryButton
                    label="Drill these"
                    onClick={() => onNavigate(`/puzzles?theme=${encodeURIComponent(themes[0])}`)}
                />
            </Box>
            {rest.length > 0 && (
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
                    {rest.map((t) => (
                        <Box
                            key={t}
                            onClick={() => onNavigate(`/puzzles?theme=${encodeURIComponent(t)}`)}
                            sx={{
                                fontSize: 11.5,
                                fontFamily: 'var(--font-mono)',
                                color: 'var(--text-dim)',
                                border: '1px solid var(--line)',
                                borderRadius: '999px',
                                px: 1.1,
                                py: 0.4,
                                cursor: 'pointer',
                                '&:hover': { color: 'var(--accent)', borderColor: 'var(--accent-line)' },
                            }}
                        >
                            {t}
                        </Box>
                    ))}
                </Box>
            )}
        </Box>
    )
}

function ReplayBody({
    drill,
    onNavigate,
}: {
    drill: TutorDrill
    onNavigate: (to: string) => void
}) {
    const positions = (drill.positions ?? []).slice(0, 5)
    if (positions.length === 0) return null
    const first = positions[0]
    const botUrl = (fen: string, color: string) =>
        `/bot?fen=${encodeURIComponent(fen)}&color=${encodeURIComponent(color)}`

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
            <Box>
                <PrimaryButton
                    label="Replay these positions"
                    onClick={() => onNavigate(botUrl(first.fen, first.color))}
                />
            </Box>
            <Box
                sx={{
                    display: 'grid',
                    gridTemplateColumns: {
                        xs: 'repeat(auto-fill, minmax(96px, 1fr))',
                        sm: 'repeat(5, 96px)',
                    },
                    gap: 1.25,
                }}
            >
                {positions.map((p, i) => (
                    <Box key={`${p.gameId}-${p.ply}-${i}`} sx={{ minWidth: 0 }}>
                        <Box sx={{ width: 96 }}>
                            <MiniBoard fen={p.fen} orientation={p.color} />
                        </Box>
                        <Typography
                            sx={{
                                fontFamily: 'var(--font-mono)',
                                fontSize: 11,
                                color: 'var(--danger)',
                                mt: 0.5,
                            }}
                        >
                            -{Math.round(p.swing)} cp
                        </Typography>
                        {p.playedAt && (
                            <Typography sx={{ fontSize: 10.5, color: 'var(--muted)' }}>
                                {fmtDate(p.playedAt)}
                            </Typography>
                        )}
                        <Box
                            component="span"
                            onClick={() => onNavigate(botUrl(p.fen, p.color))}
                            sx={{
                                display: 'inline-block',
                                fontSize: 11.5,
                                color: 'var(--text-dim)',
                                cursor: 'pointer',
                                mt: 0.25,
                                '&:hover': { color: 'var(--accent)' },
                            }}
                        >
                            Play →
                        </Box>
                    </Box>
                ))}
            </Box>
        </Box>
    )
}

function OpeningBody({
    drill,
    onNavigate,
}: {
    drill: TutorDrill
    onNavigate: (to: string) => void
}) {
    if (!drill.opening) return null
    return (
        <PrimaryButton
            label="Drill this opening"
            onClick={() => onNavigate(`/bot?opening=${encodeURIComponent(drill.opening!)}`)}
        />
    )
}

function GamesBody({ drill }: { drill: TutorDrill }) {
    const games = drill.games ?? []
    if (games.length === 0) return null
    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
            {games.map((g) => (
                <Box
                    key={g.gameId}
                    component={Link}
                    to={`/analysis/${encodeURIComponent(g.gameId)}`}
                    sx={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        fontSize: 13,
                        color: 'var(--text-dim)',
                        py: 0.5,
                        '&:hover': { color: 'var(--accent)' },
                    }}
                >
                    <span>Game {g.gameId.slice(0, 8)}</span>
                    <span style={{ color: 'var(--muted)', fontSize: 11.5 }}>
                        {g.playedAt ? fmtDate(g.playedAt) : ''}
                    </span>
                </Box>
            ))}
        </Box>
    )
}
