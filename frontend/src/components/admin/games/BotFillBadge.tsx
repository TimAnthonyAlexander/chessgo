import { Box, Tooltip } from '@mui/material'
import { Cpu } from 'lucide-react'

/** The centrepiece marker for this tab: a prominent "BOT FILL" chip stamped on
 * any persisted game where a side is a fill-in backfill bot (`white_is_bot` or
 * `black_is_bot`). Such games are stored one-sided-rated=false, so the tooltip
 * calls out that the opponent was a bot and the game is unrated. */
export default function BotFillBadge() {
    return (
        <Tooltip title="Fill-in bot opponent (unrated)" arrow disableInteractive>
            <Box
                component="span"
                sx={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 0.5,
                    px: 0.9,
                    py: 0.25,
                    borderRadius: 'var(--radius)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10.5,
                    fontWeight: 700,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    lineHeight: 1.4,
                    whiteSpace: 'nowrap',
                    color: 'var(--accent)',
                    bgcolor: 'var(--accent-soft)',
                    border: '1px solid var(--accent-line)',
                }}
            >
                <Cpu size={11} />
                Bot fill
            </Box>
        </Tooltip>
    )
}
