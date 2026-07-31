import { Box } from '@mui/material'
import type { Title } from '../api/client'

/** Compact uppercase-monospace title chip (GM/IM/FM/… or our own "AM" staff
 * joke title), meant to sit immediately before a player's name — muted, no
 * background colour, no per-title colour-coding. Renders nothing for a null
 * title, so callers can use it unconditionally. */
export default function TitleBadge({ title }: { title: Title | null | undefined }) {
    if (!title) return null

    return (
        <Box
            component="span"
            title={TITLE_NAMES[title] ?? title}
            sx={{
                fontFamily: 'var(--font-mono)',
                fontSize: '0.78em',
                fontWeight: 700,
                letterSpacing: '0.02em',
                color: 'var(--muted)',
                flexShrink: 0,
            }}
        >
            {title}
        </Box>
    )
}

const TITLE_NAMES: Record<Title, string> = {
    GM: 'Grandmaster',
    IM: 'International Master',
    FM: 'FIDE Master',
    CM: 'Candidate Master',
    NM: 'National Master',
    WGM: 'Woman Grandmaster',
    WIM: 'Woman International Master',
    WFM: 'Woman FIDE Master',
    WCM: 'Woman Candidate Master',
    AM: 'Admin Master',
}
