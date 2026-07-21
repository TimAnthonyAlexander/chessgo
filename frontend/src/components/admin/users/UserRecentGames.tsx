import { Box, Typography } from '@mui/material'
import { Bot, Skull } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import type { GameSummaryRow } from '../../../api/client'
import { Panel, PanelHead } from '../../home/Panel'
import { DuckGlyph } from '../../DuckGlyph'
import { fmtDate, gamePerspective, OUTCOME_STYLE } from './shared'

/** A compact list of the account's most recent games (result / opponent / time
 * control / date). Each row deep-links into the anti-cheat per-game telemetry so
 * an admin can jump straight from a suspicious game to its scan. Mirrors the
 * profile's game-history row idiom. */
export default function UserRecentGames({
    games,
    userId,
}: {
    games: GameSummaryRow[]
    userId: string
}) {
    const navigate = useNavigate()

    return (
        <Panel>
            <PanelHead title="Recent games" sub={`Last ${games.length} · click to inspect`} />
            {games.length === 0 ? (
                <Box sx={{ py: 3, textAlign: 'center', color: 'var(--muted)', fontSize: 13.5 }}>
                    No games played yet.
                </Box>
            ) : (
                <Box
                    sx={{
                        border: '1px solid var(--line-soft)',
                        borderRadius: '12px',
                        overflow: 'hidden',
                    }}
                >
                    {games.map((g, i) => (
                        <GameRow
                            key={g.id}
                            game={g}
                            userId={userId}
                            first={i === 0}
                            onClick={() => navigate(`/admin/anticheat/game/${encodeURIComponent(g.id)}`)}
                        />
                    ))}
                </Box>
            )}
        </Panel>
    )
}

function GameRow({
    game,
    userId,
    first,
    onClick,
}: {
    game: GameSummaryRow
    userId: string
    first: boolean
    onClick: () => void
}) {
    const { outcome, color, opponent, opponentBot } = gamePerspective(game, userId)
    const o = OUTCOME_STYLE[outcome]

    return (
        <Box
            role="button"
            tabIndex={0}
            onClick={onClick}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onClick()
                }
            }}
            sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1.5,
                px: { xs: 1.5, md: 2 },
                py: 1.15,
                cursor: 'pointer',
                borderTop: first ? 'none' : '1px solid var(--line-soft)',
                outline: 'none',
                transition: 'background .12s ease',
                '&:hover': { bgcolor: 'var(--line)' },
                '&:focus-visible': { bgcolor: 'var(--line)' },
            }}
        >
            <Box
                sx={{
                    width: 24,
                    height: 24,
                    flexShrink: 0,
                    borderRadius: '7px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontFamily: 'var(--font-mono)',
                    fontWeight: 700,
                    fontSize: 12,
                    color: o.color,
                    border: `1px solid ${o.color}`,
                }}
            >
                {o.label}
            </Box>

            <Box sx={{ minWidth: 0, flex: 1 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6 }}>
                    <Typography
                        sx={{
                            fontSize: 13.5,
                            fontWeight: 600,
                            color: 'var(--text)',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                        }}
                    >
                        vs {opponent || 'Anonymous'}
                    </Typography>
                    {opponentBot && <Bot size={12} color="var(--muted)" />}
                    {game.variant === 'duck' && (
                        <Box
                            component="span"
                            title="Duck Chess"
                            sx={{ display: 'inline-flex', fontSize: 15, flexShrink: 0 }}
                        >
                            <DuckGlyph />
                        </Box>
                    )}
                    {game.variant === 'crazyhouse' && (
                        <Box
                            component="span"
                            title="Crazyhouse"
                            sx={{
                                display: 'inline-flex',
                                fontSize: 14,
                                flexShrink: 0,
                                color: 'var(--accent)',
                            }}
                        >
                            ⇄
                        </Box>
                    )}
                    {game.variant === 'antichess' && (
                        <Box
                            component="span"
                            title="Antichess"
                            sx={{ display: 'inline-flex', flexShrink: 0, color: 'var(--text-dim)' }}
                        >
                            <Skull size={13} />
                        </Box>
                    )}
                    {game.variant === 'chess960' && (
                        <Box
                            component="span"
                            title="Chess960"
                            sx={{
                                flexShrink: 0,
                                fontFamily: 'var(--font-mono)',
                                fontSize: 9,
                                fontWeight: 700,
                                color: 'var(--accent)',
                                border: '1px solid var(--accent-line)',
                                borderRadius: '4px',
                                px: 0.4,
                                lineHeight: 1.3,
                            }}
                        >
                            960
                        </Box>
                    )}
                </Box>
                <Typography
                    sx={{ fontSize: 11, color: 'var(--muted)', textTransform: 'capitalize' }}
                >
                    {game.category || 'casual'} · {game.pool || '—'} · as {color}
                    {!game.rated && ' · casual'}
                </Typography>
            </Box>

            <Typography
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'var(--text-dim)',
                    whiteSpace: 'nowrap',
                }}
            >
                {game.result}
            </Typography>

            <Typography
                sx={{
                    fontSize: 11.5,
                    color: 'var(--muted)',
                    whiteSpace: 'nowrap',
                    minWidth: 64,
                    textAlign: 'right',
                }}
            >
                {fmtDate(game.created_at)}
            </Typography>
        </Box>
    )
}
