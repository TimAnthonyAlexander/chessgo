import { Box, Typography } from '@mui/material'
import { useNavigate } from 'react-router-dom'
import type { TutorThemeProfile } from '../../api/client'
import { themeLabel } from './format'

/** The report's second, independent line of tactical evidence — solve rate per
 * theme from the player's own puzzle history, weakest first. `comparable` is
 * always false and this component must respect it: the puzzle set carries
 * puzzle ratings but not other players' per-theme results, so there is NO peer
 * column, NO percentile, and NO "vs other players" framing anywhere here —
 * only `note`, verbatim from the backend, explaining why. Player-level (the
 * puzzle pool has no time control), so it renders once per report, not once
 * per category. */
export default function ThemeProfileSection({ profile }: { profile?: TutorThemeProfile }) {
    const navigate = useNavigate()
    if (!profile) return null

    return (
        <Box>
            <Typography
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11.5,
                    letterSpacing: '0.12em',
                    textTransform: 'uppercase',
                    color: 'var(--muted)',
                    mb: 1,
                }}
            >
                Tactical themes
            </Typography>
            <Typography sx={{ fontSize: 12.5, color: 'var(--text-dim)', mb: 1.5, maxWidth: 640, lineHeight: 1.5 }}>
                {profile.note}
            </Typography>

            {profile.themes.length > 0 && (
                <Box sx={{ overflowX: 'auto' }}>
                    <Box component="table" sx={{ width: '100%', borderCollapse: 'collapse', minWidth: 380 }}>
                        <Box component="thead">
                            <Box component="tr">
                                <Th align="left">Theme</Th>
                                <Th>Solve rate</Th>
                                <Th align="right">Solved / attempts</Th>
                            </Box>
                        </Box>
                        <Box component="tbody">
                            {profile.themes.map((t) => (
                                <Box
                                    component="tr"
                                    key={t.theme}
                                    onClick={() => navigate(`/puzzles?theme=${encodeURIComponent(t.theme)}`)}
                                    sx={{ cursor: 'pointer', '&:hover': { bgcolor: 'var(--surface-2)' } }}
                                >
                                    <Td align="left">{themeLabel(t.theme)}</Td>
                                    <Td>{t.rate.toFixed(1)}%</Td>
                                    <Td align="right">
                                        {t.solved} / {t.attempts}
                                    </Td>
                                </Box>
                            ))}
                        </Box>
                    </Box>
                </Box>
            )}
        </Box>
    )
}

function Th({ children, align = 'center' }: { children: React.ReactNode; align?: 'left' | 'right' | 'center' }) {
    return (
        <Box
            component="th"
            sx={{
                textAlign: align,
                fontSize: 11,
                fontFamily: 'var(--font-mono)',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                color: 'var(--muted)',
                fontWeight: 600,
                py: 0.75,
                px: 1,
                borderBottom: '1px solid var(--line-soft)',
                whiteSpace: 'nowrap',
            }}
        >
            {children}
        </Box>
    )
}

function Td({ children, align = 'center' }: { children: React.ReactNode; align?: 'left' | 'right' | 'center' }) {
    return (
        <Box
            component="td"
            sx={{
                textAlign: align,
                fontSize: 12.5,
                fontFamily: align === 'left' ? 'inherit' : 'var(--font-mono)',
                color: align === 'left' ? 'var(--text)' : 'var(--text-dim)',
                py: 0.75,
                px: 1,
                borderBottom: '1px solid var(--line-soft)',
                whiteSpace: 'nowrap',
            }}
        >
            <Typography component="span" sx={{ fontSize: 'inherit', fontFamily: 'inherit' }}>
                {children}
            </Typography>
        </Box>
    )
}
