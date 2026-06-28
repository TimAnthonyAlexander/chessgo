import { createTheme } from '@mui/material/styles'

// MUI theme mirrors the CSS variables in styles.css so MUI primitives sit
// seamlessly in the editorial-minimalist look (no stock MUI blue/elevation).
const theme = createTheme({
    palette: {
        mode: 'dark',
        background: { default: '#131419', paper: '#1d2029' },
        primary: { main: '#d8a657', contrastText: '#16140f' },
        text: { primary: '#ece9e1', secondary: '#9fa1ac' },
        divider: '#2c313d',
    },
    shape: { borderRadius: 12 },
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
                root: { borderRadius: 10, paddingInline: 18, paddingBlock: 9 },
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
    },
})

export default theme
