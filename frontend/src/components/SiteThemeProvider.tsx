import { useMemo, type ReactNode } from 'react'
import { CssBaseline, ThemeProvider } from '@mui/material'
import { buildTheme } from '../theme'
import { siteThemeStore, useSiteTheme } from '../lib/siteTheme'

// Wraps the app in a MUI ThemeProvider whose theme is rebuilt from the active
// site palette + resolved mode. Subscribing here (via useSiteTheme) is what makes
// the whole MUI tree flip light/dark and re-accent when the user changes the
// theme — without it, MUI-internal colors would stay frozen at their first value.
//
// The CSS variables themselves are painted onto <html> by the store (already done
// synchronously in main.tsx before first paint), so this only needs to keep the
// MUI palette object in sync.
export default function SiteThemeProvider({ children }: { children: ReactNode }) {
    // Re-render whenever mode/palette/backdrop changes; the seed is derived from
    // the same store, so read it fresh on each render.
    const state = useSiteTheme()
    const theme = useMemo(
        () => buildTheme(siteThemeStore.getMuiSeed()),
        // Rebuild when the resolved mode or palette changes (backdrop doesn't touch
        // MUI internals, but re-deriving is cheap and keeps this honest).
        [state.resolved, state.palette],
    )

    return (
        <ThemeProvider theme={theme}>
            <CssBaseline />
            {children}
        </ThemeProvider>
    )
}
