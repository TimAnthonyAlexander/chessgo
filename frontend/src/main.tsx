import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { CssBaseline, ThemeProvider } from '@mui/material'
import theme from './theme'
import Layout from './components/Layout'
import Home from './pages/Home'
import BotGame from './pages/BotGame'
import LiveGame from './pages/LiveGame'
import Puzzles from './pages/Puzzles'
import Analysis from './pages/Analysis'
import Editor from './pages/Editor'
import Profile from './pages/Profile'
import Watch from './pages/Watch'
import Spectate from './pages/Spectate'
import EngineVsEngine from './pages/EngineVsEngine'
import './styles.css'

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <Home /> },
      { path: '/bot', element: <BotGame /> },
      { path: '/puzzles', element: <Puzzles /> },
      { path: '/game/:id', element: <LiveGame /> },
      { path: '/watch', element: <Watch /> },
      { path: '/watch/:id', element: <Spectate /> },
      { path: '/analysis', element: <Analysis /> },
      { path: '/analysis/:id', element: <Analysis /> },
      { path: '/editor', element: <Editor /> },
      { path: '/@/:name', element: <Profile /> },
      { path: '/admin/engine-vs', element: <EngineVsEngine /> },
    ],
  },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <RouterProvider router={router} />
    </ThemeProvider>
  </StrictMode>,
)
