import { createTheme, type Theme } from '@mui/material/styles'
import type { MuiSeed } from './lib/siteTheme'

// The MUI theme mirrors the site CSS variables (lib/siteTheme.ts) so MUI
// primitives sit seamlessly in the editorial-minimalist look (no stock MUI
// blue/elevation). It is REBUILT from the active palette seed whenever the site
// theme changes (see SiteThemeProvider), so MUI-internal colors — contained
// buttons, hover/disabled states, default text — track light/dark and the accent.
//
// Component overrides keep referencing the `var(--…)` tokens directly, so those
// pieces (tooltips, dialogs, papers) repaint for free on any theme change without
// a rebuild; only the palette-derived internals need this factory.
export function buildTheme(seed: MuiSeed): Theme {
    return createTheme({
        palette: {
            mode: seed.mode,
            background: { default: seed.bg, paper: seed.paper },
            primary: { main: seed.primary, contrastText: seed.onPrimary },
            text: { primary: seed.text, secondary: seed.textSecondary },
            divider: seed.divider,
        },
        // Square corners everywhere. This one line squares off every MUI primitive
        // that derives from theme.shape (Paper, Card, Menu, Chip, inputs, …); the
        // overrides below cover the components that hardcode their own radius.
        shape: { borderRadius: 0 },
        typography: {
            fontFamily: "'Hanken Grotesk', system-ui, sans-serif",
            h1: { fontFamily: "'Fraunces', Georgia, serif", fontWeight: 600, letterSpacing: '-0.01em' },
            h2: { fontFamily: "'Fraunces', Georgia, serif", fontWeight: 600, letterSpacing: '-0.01em' },
            h3: { fontFamily: "'Fraunces', Georgia, serif", fontWeight: 600 },
            h4: { fontFamily: "'Fraunces', Georgia, serif", fontWeight: 600 },
            button: { textTransform: 'none', fontWeight: 600, letterSpacing: '0.01em' },
            overline: { letterSpacing: '0.18em', fontWeight: 600 },
        },
        components: {
            MuiButton: {
                defaultProps: { disableElevation: true },
                styleOverrides: {
                    root: { borderRadius: 0, paddingInline: 18, paddingBlock: 9 },
                },
            },
            MuiPaper: {
                styleOverrides: {
                    root: {
                        backgroundImage: 'none',
                        border: '1px solid var(--line-soft)',
                    },
                },
            },
            MuiTooltip: {
                styleOverrides: {
                    tooltip: {
                        background: 'var(--surface)',
                        border: '1px solid var(--line)',
                        color: 'var(--text)',
                        fontFamily: 'var(--font-mono)',
                        fontSize: 13,
                        borderRadius: 0,
                        paddingInline: 10,
                        paddingBlock: 6,
                    },
                    arrow: {
                        color: 'var(--surface)',
                        '&::before': { border: '1px solid var(--line)' },
                    },
                },
            },
            MuiDialog: {
                styleOverrides: {
                    paper: {
                        backgroundColor: 'var(--surface)',
                        backgroundImage: 'none',
                        border: '1px solid var(--line)',
                        borderRadius: 0,
                    },
                },
            },
        },
    })
}
