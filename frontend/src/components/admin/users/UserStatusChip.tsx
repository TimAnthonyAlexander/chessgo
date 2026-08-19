import { Box } from '@mui/material'

/** Active/Banned status pill. Green = active account, red = banned. */
export default function UserStatusChip({ active }: { active: boolean }) {
    const color = active ? '#5b9e5b' : '#ca4a4a'
    return (
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
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                lineHeight: 1.4,
                color,
                border: `1px solid ${color}`,
            }}
        >
            <Box
                component="span"
                sx={{ width: 6, height: 6, borderRadius: 'var(--radius)', bgcolor: color, flexShrink: 0 }}
            />
            {active ? 'Active' : 'Banned'}
        </Box>
    )
}
