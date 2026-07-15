import { lazy, Suspense, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { Box, CircularProgress } from '@mui/material'
import SiteThemeProvider from './components/SiteThemeProvider'
import Layout from './components/Layout'
import Home from './pages/Home'
import LiveGame from './pages/LiveGame'
import ChallengeJoin from './pages/ChallengeJoin'
import Watch from './pages/Watch'
import Spectate from './pages/Spectate'
import Profile from './pages/Profile'
// Heavy / rare routes are split into their own chunks so the critical path
// (home, live game, layout) isn't gated on Analysis (~1.4k lines), the whole
// /admin/* subtree, the editor, or chess.js (only pulled by analysis/editor).
const BotGame = lazy(() => import('./pages/BotGame'))
const Puzzles = lazy(() => import('./pages/Puzzles'))
const Analysis = lazy(() => import('./pages/Analysis'))
const Editor = lazy(() => import('./pages/Editor'))
const EngineVsEngine = lazy(() => import('./pages/EngineVsEngine'))
const GuessTheElo = lazy(() => import('./pages/GuessTheElo'))
const Admin = lazy(() => import('./pages/Admin'))
const AdminDashboard = lazy(() => import('./pages/AdminDashboard'))
const AdminUsers = lazy(() => import('./pages/AdminUsers'))
const AdminUserDetail = lazy(() => import('./pages/AdminUserDetail'))
const AdminGames = lazy(() => import('./pages/AdminGames'))
const AdminAnticheat = lazy(() => import('./pages/AdminAnticheat'))
const AdminAnticheatUser = lazy(() => import('./pages/AdminAnticheatUser'))
const AdminAnticheatGame = lazy(() => import('./pages/AdminAnticheatGame'))
import { initTheme } from './lib/boardTheme'
import { initSettings } from './lib/settings'
import { initSiteTheme } from './lib/siteTheme'
import './styles.css'

// Apply the persisted site theme (chrome), board/piece appearance, and user
// preferences before first paint (no theme flash; every CSS-var-driven setting
// lands on <html> up front).
initSiteTheme()
initTheme()
initSettings()

// Centered spinner shown while a lazy route chunk loads. Kept inside the Layout
// content area (per-element Suspense) so the nav/header stay painted.
function RouteFallback() {
    return (
        <Box
            sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                minHeight: '60vh',
            }}
        >
            <CircularProgress size={22} sx={{ color: 'var(--muted)' }} />
        </Box>
    )
}

// Wrap a (possibly lazy) route element in a Suspense boundary so only the
// outlet content falls back to the spinner, not the whole app shell.
function suspended(node: ReactNode): ReactNode {
    return <Suspense fallback={<RouteFallback />}>{node}</Suspense>
}

const router = createBrowserRouter([
    {
        element: <Layout />,
        children: [
            { path: '/', element: <Home /> },
            { path: '/bot', element: suspended(<BotGame />) },
            { path: '/puzzles', element: suspended(<Puzzles />) },
            { path: '/guess-the-elo', element: suspended(<GuessTheElo />) },
            { path: '/game/:id', element: <LiveGame /> },
            { path: '/challenge/:code', element: <ChallengeJoin /> },
            { path: '/watch', element: <Watch /> },
            { path: '/watch/:id', element: <Spectate /> },
            { path: '/analysis', element: suspended(<Analysis />) },
            { path: '/analysis/:id', element: suspended(<Analysis />) },
            { path: '/editor', element: suspended(<Editor />) },
            { path: '/@/:name', element: <Profile /> },
            { path: '/admin/engine-vs', element: suspended(<EngineVsEngine />) },
            {
                path: '/admin',
                element: suspended(<Admin />),
                children: [
                    { index: true, element: suspended(<AdminDashboard />) },
                    { path: 'users', element: suspended(<AdminUsers />) },
                    { path: 'users/:id', element: suspended(<AdminUserDetail />) },
                    { path: 'games', element: suspended(<AdminGames />) },
                    { path: 'anticheat', element: suspended(<AdminAnticheat />) },
                    { path: 'anticheat/:userId', element: suspended(<AdminAnticheatUser />) },
                    { path: 'anticheat/game/:id', element: suspended(<AdminAnticheatGame />) },
                ],
            },
        ],
    },
])

createRoot(document.getElementById('root')!).render(
    <SiteThemeProvider>
        <RouterProvider router={router} />
    </SiteThemeProvider>,
)
