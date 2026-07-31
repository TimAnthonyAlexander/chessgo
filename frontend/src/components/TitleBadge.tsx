import { Box } from '@mui/material'
import type { Title } from '../api/client'

/** Compact uppercase-monospace title chip (GM/IM/FM/… or our own "AM" staff
 * joke title), meant to sit immediately before a player's name. Solid red with
 * white text so a title reads as a title at any size and on any surface — one
 * colour for every title, no per-title colour-coding. Renders nothing for a null
 * title, so callers can use it unconditionally. */
export default function TitleBadge({ title }: { title: Title | null | undefined }) {
    if (!title) return null

    return (
        <Box
            component="span"
            title={TITLE_NAMES[title] ?? title}
            sx={{
                display: 'inline-flex',
                alignItems: 'center',
                fontFamily: 'var(--font-mono)',
                fontSize: '0.72em',
                fontWeight: 800,
                lineHeight: 1,
                letterSpacing: '0.04em',
                color: '#fff',
                bgcolor: '#b3261e',
                borderRadius: '3px',
                px: '5px',
                py: '3px',
                flexShrink: 0,
                whiteSpace: 'nowrap',
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
