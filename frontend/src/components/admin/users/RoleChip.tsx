import { Box } from '@mui/material'
import { Shield } from 'lucide-react'

/** A compact role pill: admins get an accent shield, regular users a muted pill.
 * Self-contained (does not import from the anti-cheat tab). */
export default function RoleChip({ role }: { role: string }) {
    const admin = role === 'admin'
    return (
        <Box
            component="span"
            sx={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 0.4,
                px: 0.9,
                py: 0.25,
                borderRadius: 'var(--radius)',
                fontFamily: 'var(--font-mono)',
                fontSize: 10.5,
                fontWeight: 700,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                lineHeight: 1.4,
                color: admin ? 'var(--accent)' : 'var(--text-dim)',
                bgcolor: admin ? 'var(--accent-soft)' : 'transparent',
                border: `1px solid ${admin ? 'var(--accent-line)' : 'var(--line-soft)'}`,
            }}
        >
            {admin && <Shield size={11} />}
            {admin ? 'Admin' : 'User'}
        </Box>
    )
}
