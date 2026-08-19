import { Box, Typography } from '@mui/material'
import type { ProfileRecord } from '../../api/client'
import { OUTCOME_STYLE } from './shared'

const WIN = OUTCOME_STYLE.win.color
const LOSS = OUTCOME_STYLE.loss.color

/** The player's overall record: a big win-rate headline over a single
 * proportional W/L/D bar (replaces the old five-pill row — same data, read at
 * a glance instead of by mental arithmetic). Plain section, no card border —
 * it's read-only, so a bounded box would just be chrome around text. */
export default function RecordPanel({ record }: { record: ProfileRecord }) {
    const { wins, losses, draws, total } = record
    const winRate = total > 0 ? Math.round((wins / total) * 100) : 0
    const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0)

    return (
        <Box>
            <Typography
                sx={{
                    fontFamily: 'var(--font-display)',
                    fontSize: 18,
                    fontWeight: 700,
                    lineHeight: 1.1,
                    mb: 1.5,
                }}
            >
                Record
            </Typography>

            <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mb: 1.5 }}>
                <Typography
                    sx={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 32,
                        fontWeight: 700,
                        lineHeight: 1,
                        color: 'var(--accent)',
                        fontVariantNumeric: 'tabular-nums',
                    }}
                >
                    {winRate}%
                </Typography>
                <Typography sx={{ fontSize: 12.5, color: 'var(--muted)' }}>
                    win rate · {total} {total === 1 ? 'game' : 'games'}
                </Typography>
            </Box>

            {/* Proportional bar */}
            <Box
                sx={{
                    display: 'flex',
                    height: 8,
                    borderRadius: 'var(--radius)',
                    overflow: 'hidden',
                    bgcolor: 'var(--surface-2)',
                }}
            >
                {total > 0 ? (
                    <>
                        <Box sx={{ width: `${pct(wins)}%`, bgcolor: WIN }} />
                        <Box sx={{ width: `${pct(draws)}%`, bgcolor: 'var(--line)' }} />
                        <Box sx={{ width: `${pct(losses)}%`, bgcolor: LOSS }} />
                    </>
                ) : null}
            </Box>

            {/* Legend */}
            <Box sx={{ display: 'flex', gap: 2, mt: 1.5 }}>
                <Legend color={WIN} label="Wins" value={wins} />
                <Legend color="var(--text-dim)" label="Draws" value={draws} />
                <Legend color={LOSS} label="Losses" value={losses} />
            </Box>
        </Box>
    )
}

function Legend({ color, label, value }: { color: string; label: string; value: number }) {
    return (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
            <Box sx={{ width: 8, height: 8, borderRadius: 'var(--radius)', bgcolor: color, flexShrink: 0 }} />
            <Typography
                component="span"
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 13,
                    fontWeight: 700,
                    fontVariantNumeric: 'tabular-nums',
                }}
            >
                {value}
            </Typography>
            <Typography component="span" sx={{ fontSize: 11.5, color: 'var(--muted)' }}>
                {label}
            </Typography>
        </Box>
    )
}
