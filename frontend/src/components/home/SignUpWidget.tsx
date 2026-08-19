import { Box, Button, Typography } from '@mui/material'
import { BarChart3, Save, Trophy } from 'lucide-react'
import { useOutletContext } from 'react-router-dom'
import { useAuth } from '../../lib/auth'
import type { LayoutOutletContext } from '../Layout'
import { Panel, PanelHead } from './Panel'

// The value props an account unlocks — anonymous play is casual/unpersisted, so
// these are exactly the things a guest is missing.
const PERKS: { icon: typeof Save; text: string }[] = [
    { icon: Save, text: 'Save every game to your profile' },
    { icon: BarChart3, text: 'Earn a real rating in each time control' },
    { icon: Trophy, text: 'Climb the leaderboard' },
]

/** Anonymous-only sidebar CTA that mirrors the height of RecentGamesWidget (its
 * logged-in counterpart). Renders nothing once signed in. Opens the shared auth
 * modal straight to the requested tab via the router Outlet context. */
export default function SignUpWidget() {
    const { user } = useAuth()
    const { openAuth } = useOutletContext<LayoutOutletContext>()

    if (user) return null

    return (
        <Panel>
            <PanelHead title="Play for keeps" sub="You're playing as a guest" />

            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25, mb: 2.25 }}>
                {PERKS.map(({ icon: Icon, text }) => (
                    <Box key={text} sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
                        <Box
                            sx={{
                                width: 28,
                                height: 28,
                                flexShrink: 0,
                                borderRadius: 'var(--radius)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                color: 'var(--accent)',
                                bgcolor: 'var(--accent-soft)',
                            }}
                        >
                            <Icon size={15} />
                        </Box>
                        <Typography sx={{ fontSize: 13.5, color: 'var(--text-dim)' }}>
                            {text}
                        </Typography>
                    </Box>
                ))}
            </Box>

            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Button
                    variant="contained"
                    fullWidth
                    onClick={() => openAuth('signup')}
                    sx={{ textTransform: 'none', fontWeight: 600 }}
                >
                    Create account
                </Button>
                <Button
                    color="inherit"
                    onClick={() => openAuth('login')}
                    sx={{
                        textTransform: 'none',
                        color: 'var(--text-dim)',
                        flexShrink: 0,
                        '&:hover': { color: 'var(--accent)' },
                    }}
                >
                    Log in
                </Button>
            </Box>
        </Panel>
    )
}
