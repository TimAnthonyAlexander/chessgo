import { Box, TableCell, TableRow, Tooltip, Typography } from '@mui/material'
import { Cpu } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import type { AdminGameRow } from '../../../api/client'
import { fmtRelative } from '../../profile/shared'
import { DuckGlyph } from '../../DuckGlyph'
import BotFillBadge from './BotFillBadge'
import GameResultCell from './GameResultCell'

/** One persisted-game row. The whole row deep-links into the anti-cheat per-game
 * telemetry (keyed on the summary `id` = hub game id), matching how the Users tab
 * jumps from a recent game to its scan. */
export default function GameRow({ game }: { game: AdminGameRow }) {
    const navigate = useNavigate()
    const isBotFill = game.white_is_bot || game.black_is_bot

    return (
        <TableRow
            hover
            onClick={() => navigate(`/admin/anticheat/game/${encodeURIComponent(game.id)}`)}
            sx={{
                cursor: 'pointer',
                '&:last-child td': { borderBottom: 'none' },
                '& td': { borderColor: 'var(--line-soft)' },
                '&:hover': { bgcolor: 'var(--line)' },
            }}
        >
            <TableCell>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
                    <PlayerName name={game.white_name} bot={game.white_is_bot} />
                    <Typography
                        component="span"
                        sx={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}
                    >
                        vs
                    </Typography>
                    <PlayerName name={game.black_name} bot={game.black_is_bot} />
                    {game.variant === 'duck' && (
                        <Box
                            component="span"
                            title="Duck Chess"
                            sx={{ display: 'inline-flex', fontSize: 15, flexShrink: 0 }}
                        >
                            <DuckGlyph />
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
            </TableCell>

            <TableCell align="center">
                <GameResultCell result={game.result} />
            </TableCell>

            <TableCell>{isBotFill ? <BotFillBadge /> : <HumanChip />}</TableCell>

            <TableCell>
                <RatedChip rated={game.rated} />
            </TableCell>

            <TableCell>
                <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.5, whiteSpace: 'nowrap' }}>
                    <Typography
                        component="span"
                        sx={{
                            fontSize: 12.5,
                            color: 'var(--text-dim)',
                            textTransform: 'capitalize',
                        }}
                    >
                        {game.category || '—'}
                    </Typography>
                    <Typography
                        component="span"
                        sx={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: 11,
                            color: 'var(--muted)',
                        }}
                    >
                        {game.pool || '—'}
                    </Typography>
                </Box>
            </TableCell>

            <TableCell align="right">
                <Typography
                    component="span"
                    sx={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 12.5,
                        fontWeight: 600,
                        color: 'var(--text-dim)',
                    }}
                >
                    {game.ply}
                </Typography>
            </TableCell>

            <TableCell align="right">
                <Typography
                    sx={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}
                    title={game.created_at}
                >
                    {fmtRelative(game.created_at)}
                </Typography>
            </TableCell>
        </TableRow>
    )
}

/** A player's display name, prefixed with a small CPU glyph when that side is a
 * fill-in bot. Truncates gracefully so a long name never blows out the column. */
function PlayerName({ name, bot }: { name: string; bot: boolean }) {
    return (
        <Box
            sx={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 0.4,
                minWidth: 0,
                color: bot ? 'var(--accent)' : 'var(--text)',
            }}
        >
            {bot && (
                <Tooltip title="Fill-in bot" arrow disableInteractive>
                    <Box component="span" sx={{ display: 'inline-flex', flexShrink: 0 }}>
                        <Cpu size={12} />
                    </Box>
                </Tooltip>
            )}
            <Typography
                component="span"
                sx={{
                    fontSize: 13,
                    fontWeight: 600,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    maxWidth: 140,
                }}
            >
                {name || 'Anonymous'}
            </Typography>
        </Box>
    )
}

/** The complement of a "BOT FILL" game: both sides are real players. */
function HumanChip() {
    return (
        <Box
            component="span"
            sx={{
                display: 'inline-flex',
                alignItems: 'center',
                px: 0.9,
                py: 0.25,
                borderRadius: '999px',
                fontFamily: 'var(--font-mono)',
                fontSize: 10.5,
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                lineHeight: 1.4,
                whiteSpace: 'nowrap',
                color: 'var(--text-dim)',
                border: '1px solid var(--line-soft)',
            }}
        >
            Human
        </Box>
    )
}

/** Rated vs casual indicator. Bot-fill games are always casual (unrated). */
function RatedChip({ rated }: { rated: boolean }) {
    const color = rated ? '#5b9e5b' : 'var(--muted)'
    return (
        <Box
            component="span"
            sx={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 0.5,
                px: 0.9,
                py: 0.25,
                borderRadius: '999px',
                fontFamily: 'var(--font-mono)',
                fontSize: 10.5,
                fontWeight: 700,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                lineHeight: 1.4,
                whiteSpace: 'nowrap',
                color,
                border: `1px solid ${rated ? color : 'var(--line-soft)'}`,
            }}
        >
            {rated ? 'Rated' : 'Casual'}
        </Box>
    )
}
