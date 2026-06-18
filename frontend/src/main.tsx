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
import './styles.css'

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <Home /> },
      { path: '/bot', element: <BotGame /> },
      { path: '/puzzles', element: <Puzzles /> },
      { path: '/game/:id', element: <LiveGame /> },
      { path: '/analysis', element: <Analysis /> },
      { path: '/analysis/:id', element: <Analysis /> },
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
