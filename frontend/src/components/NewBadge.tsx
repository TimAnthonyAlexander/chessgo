import { Box } from '@mui/material'

/** A small "NEW" pill for flagging a recently-shipped feature (currently: the
 * Zugzwang engine) inline next to its label. Matches the site's gold-accent,
 * mono-uppercase pill language (see admin's StatusChip) — subtle, not garish. */
export default function NewBadge() {
    return (
        <Box
            component="span"
            sx={{
                display: 'inline-flex',
                alignItems: 'center',
                px: 0.75,
                py: 0.25,
                borderRadius: '999px',
                bgcolor: 'var(--accent-soft)',
                border: '1px solid var(--accent-line)',
                fontFamily: 'var(--font-mono)',
                fontSize: 9.5,
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: 'var(--accent)',
                lineHeight: 1,
            }}
        >
            New
        </Box>
    )
}
