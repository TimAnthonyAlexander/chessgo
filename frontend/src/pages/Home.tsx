import { Box, useMediaQuery, useTheme } from '@mui/material'
import DailyPuzzleWidget from '../components/home/DailyPuzzleWidget'
import RecentGamesWidget from '../components/home/RecentGamesWidget'
import SignUpWidget from '../components/home/SignUpWidget'
import LiveTvWidget from '../components/home/LiveTvWidget'
import LeaderboardWidget from '../components/home/LeaderboardWidget'
import { HomeChrome, LobbyStatLines, PlayBar, QuickPairingPanel, useHome } from './home/parts'
import HomeMobile from './HomeMobile'

export default function Home() {
    // The three-column dashboard reads perfectly top-to-bottom on desktop, but
    // stacks in the wrong order on a phone — mobile gets its own layout.
    const isMobile = useMediaQuery(useTheme().breakpoints.down('md'))
    if (isMobile) return <HomeMobile />
    return <HomeDesktop />
}

function HomeDesktop() {
    const home = useHome()
    return (
        <HomeChrome home={home}>
            {/* Primary actions as a slim full-width bar above the grid, so the
                three dashboard columns stay balanced in height. */}
            <PlayBar
                onNavigate={home.navigate}
                onChallenge={() => home.setChallengeOpen(true)}
            />

            {/* Dashboard: quick pairing + live/community widgets */}
            <Box
                sx={{
                    display: 'grid',
                    gridTemplateColumns: {
                        md: 'repeat(2, minmax(0, 1fr))',
                        lg: 'minmax(0, 1fr) minmax(0, 1.5fr) minmax(0, 1fr)',
                    },
                    gap: 2.5,
                    alignItems: 'start',
                }}
            >
                {/* Column: daily puzzle (left). The second card self-selects on
                    auth: recent games when signed in, a sign-up CTA for guests. */}
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, order: { lg: 1 } }}>
                    <DailyPuzzleWidget />
                    <RecentGamesWidget />
                    <SignUpWidget />
                </Box>

                {/* Column: quick pairing (center, biggest) */}
                <Box
                    sx={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 2.5,
                        order: { xs: 1, lg: 2 },
                    }}
                >
                    <QuickPairingPanel onQueue={home.queue} />
                </Box>

                {/* Column: live game + leaderboard (right) */}
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, order: { lg: 3 } }}>
                    <LiveTvWidget />
                    <LeaderboardWidget />
                    <LobbyStatLines stats={home.stats} />
                </Box>
            </Box>
        </HomeChrome>
    )
}
