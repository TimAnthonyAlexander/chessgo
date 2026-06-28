import type { ReactNode } from 'react'
import { Box, Typography } from '@mui/material'
import type { SxProps, Theme } from '@mui/material'

/** The shared dashboard card chrome (surface + soft border + drop shadow).
 * Every homepage widget composes on top of this so they stay visually uniform. */
export function Panel({ children, sx }: { children: ReactNode; sx?: SxProps<Theme> }) {
    return (
        <Box
            sx={[
                {
                    bgcolor: 'var(--surface)',
                    border: '1px solid var(--line-soft)',
                    borderRadius: '14px',
                    p: { xs: 2, md: 2.5 },
                },
                ...(Array.isArray(sx) ? sx : [sx]),
            ]}
        >
            {children}
        </Box>
    )
}

/** A panel header: display-serif title, optional muted sub, optional right-aligned
 * action slot (e.g. a "See all" link or a category toggle). */
export function PanelHead({
    title,
    sub,
    action,
}: {
    title: string
    sub?: string
    action?: ReactNode
}) {
    return (
        <Box
            sx={{
                mb: 2,
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                gap: 2,
            }}
        >
            <Box sx={{ minWidth: 0 }}>
                <Typography
                    sx={{
                        fontFamily: 'var(--font-display)',
                        fontSize: 18,
                        fontWeight: 700,
                        lineHeight: 1.1,
                    }}
                >
                    {title}
                </Typography>
                {sub && (
                    <Typography sx={{ fontSize: 13, color: 'var(--muted)', mt: 0.25 }}>
                        {sub}
                    </Typography>
                )}
            </Box>
            {action && <Box sx={{ flexShrink: 0 }}>{action}</Box>}
        </Box>
    )
}
