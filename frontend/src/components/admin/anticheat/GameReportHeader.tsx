import { Box, Typography } from '@mui/material'
import { Bot, ScanLine, ShieldAlert } from 'lucide-react'
import type { Color, GameSummaryRow } from '../../../api/client'
import { Panel } from '../../home/Panel'
import { fmtDate } from '../../profile/shared'
import { statusLabel } from '../../../lib/chess'

/** The game report hero: the two players (flagged side marked), the result, and
 * the game's category / rated / scanned metadata. */
export default function GameReportHeader({
    game,
    scanned,
    flaggedColor,
}: {
    game: GameSummaryRow
    scanned: boolean
    flaggedColor: Color | null
}) {
    return (
        <Panel>
            <Box
                sx={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 2,
                }}
            >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, minWidth: 0 }}>
                    <PlayerName
                        name={game.white_name}
                        bot={game.white_is_bot}
                        flagged={flaggedColor === 'w'}
                        dot="#e9ecf2"
                    />
                    <Typography sx={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--muted)' }}>
                        vs
                    </Typography>
                    <PlayerName
                        name={game.black_name}
                        bot={game.black_is_bot}
                        flagged={flaggedColor === 'b'}
                        dot="#4a4f5e"
                    />
                </Box>

                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                    <Meta label={game.result || '—'} mono />
                    <Meta label={game.category || 'game'} />
                    <Meta label={game.rated ? 'Rated' : 'Casual'} accent={game.rated} />
                    <Meta
                        icon={<ScanLine size={12} />}
                        label={scanned ? 'Scanned' : 'Unscanned'}
                        accent={scanned}
                    />
                </Box>
            </Box>

            {(game.reason || game.created_at) && (
                <Typography sx={{ fontSize: 11.5, color: 'var(--muted)', mt: 1.25 }}>
                    {statusLabel(game.reason) || game.reason}
                    {game.reason && game.created_at ? ' · ' : ''}
                    {game.created_at ? fmtDate(game.created_at) : ''}
                </Typography>
            )}
        </Panel>
    )
}

function PlayerName({
    name,
    bot,
    flagged,
    dot,
}: {
    name: string
    bot: boolean
    flagged: boolean
    dot: string
}) {
    return (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
            <Box
                sx={{
                    width: 10,
                    height: 10,
                    borderRadius: '50%',
                    bgcolor: dot,
                    border: '1px solid var(--line)',
                    flexShrink: 0,
                }}
            />
            <Typography
                sx={{
                    fontFamily: 'var(--font-display)',
                    fontSize: 17,
                    fontWeight: 700,
                    color: flagged ? '#e06a6a' : 'var(--text)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                }}
            >
                {name}
            </Typography>
            {bot && <Bot size={14} style={{ color: 'var(--muted)', flexShrink: 0 }} />}
            {flagged && <ShieldAlert size={14} style={{ color: '#e06a6a', flexShrink: 0 }} />}
        </Box>
    )
}

function Meta({
    label,
    mono,
    accent,
    icon,
}: {
    label: string
    mono?: boolean
    accent?: boolean
    icon?: React.ReactNode
}) {
    return (
        <Box
            sx={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 0.5,
                px: 1,
                py: 0.5,
                borderRadius: '7px',
                bgcolor: accent ? 'var(--accent-soft)' : 'var(--surface-2)',
                border: '1px solid',
                borderColor: accent ? 'var(--accent-line)' : 'var(--line-soft)',
                color: accent ? 'var(--accent)' : 'var(--text-dim)',
            }}
        >
            {icon}
            <Typography
                sx={{
                    fontFamily: mono ? 'var(--font-mono)' : 'var(--font-ui)',
                    fontSize: 11.5,
                    fontWeight: 700,
                    letterSpacing: mono ? 0 : '0.04em',
                    textTransform: mono ? 'none' : 'capitalize',
                    color: 'inherit',
                }}
            >
                {label}
            </Typography>
        </Box>
    )
}
