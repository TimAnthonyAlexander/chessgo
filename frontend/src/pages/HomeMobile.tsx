import { Box } from '@mui/material'
import DailyPuzzleWidget from '../components/home/DailyPuzzleWidget'
import RecentGamesWidget from '../components/home/RecentGamesWidget'
import SignUpWidget from '../components/home/SignUpWidget'
import LiveTvWidget from '../components/home/LiveTvWidget'
import LeaderboardWidget from '../components/home/LeaderboardWidget'
import { HomeChrome, LobbyStatLines, PlayPanel, QuickPairingPanel, useHome } from './home/parts'

// The phone layout is a single column ordered by what a player reaches for
// first: play actions and quick pairing at the top, then the live-TV hook,
// then the puzzle/community cards, with the leaderboard last. (Desktop stacks
// its three columns in a different, wrong-for-mobile order — see Home.tsx.)
export default function HomeMobile() {
    const home = useHome()
    return (
        <HomeChrome home={home}>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
                <PlayPanel
                    onNavigate={home.navigate}
                    onChallenge={() => home.setChallengeOpen(true)}
                />
                <QuickPairingPanel onQueue={home.queue} />
                <LiveTvWidget />
                <DailyPuzzleWidget />
                <RecentGamesWidget />
                <SignUpWidget />
                <LeaderboardWidget />
                <LobbyStatLines stats={home.stats} />
            </Box>
        </HomeChrome>
    )
}
