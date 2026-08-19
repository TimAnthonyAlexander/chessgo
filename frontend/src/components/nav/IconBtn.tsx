import { type ReactNode, forwardRef } from 'react'
import { Box, Tooltip } from '@mui/material'

/** The one icon-button shape the nav uses — top bar and side rail both. A square
 *  cell on the site radius, tinted on hover, no ripple and no elevation.
 *
 *  It exists because the two navs had drifted into three different triggers (MUI
 *  `IconButton` with its own 50% radius and ripple, a hand-rolled 30px Box, and
 *  the bell's own thing), which is what made the rail's bottom strip read as a
 *  pile rather than a row. Everything that is "an icon you can click" in the nav
 *  goes through here. */
const IconBtn = forwardRef<
    HTMLButtonElement,
    {
        label: string
        onClick?: () => void
        active?: boolean
        children: ReactNode
    }
>(function IconBtn({ label, onClick, active = false, children }, ref) {
    return (
        <Tooltip title={label}>
            <Box
                ref={ref}
                component="button"
                type="button"
                aria-label={label}
                onClick={onClick}
                sx={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    width: 30,
                    height: 30,
                    p: 0,
                    border: 'none',
                    borderRadius: 'var(--radius)',
                    bgcolor: active ? 'var(--line)' : 'transparent',
                    color: active ? 'var(--accent)' : 'var(--text-dim)',
                    cursor: 'pointer',
                    transition: 'color .12s ease, background .12s ease',
                    '&:hover': { color: 'var(--accent)', bgcolor: 'var(--line)' },
                }}
            >
                {children}
            </Box>
        </Tooltip>
    )
})

export default IconBtn
