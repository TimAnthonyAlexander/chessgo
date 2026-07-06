import { Box, Tooltip } from '@mui/material'
import { FlaskConical } from 'lucide-react'

/** A muted "SEEDED" chip stamped on a locally-seeded dev game (`hub_game_id`
 * prefixed `seedgame-`, from scripts/seed_games.php). Such games are hidden by
 * default; when the "Show seeded" toggle reveals them this marks them so they
 * are never mistaken for real play. Sits beside the "BOT FILL" chip in the Type
 * cell, mirroring {@link BotFillBadge}. */
export default function SeededBadge() {
    return (
        <Tooltip title="Locally-seeded dev game" arrow disableInteractive>
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
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    lineHeight: 1.4,
                    whiteSpace: 'nowrap',
                    color: 'var(--muted)',
                    border: '1px solid var(--line-soft)',
                }}
            >
                <FlaskConical size={11} />
                Seeded
            </Box>
        </Tooltip>
    )
}
