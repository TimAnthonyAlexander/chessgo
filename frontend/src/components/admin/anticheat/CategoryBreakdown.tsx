import { Box, Typography } from '@mui/material'
import { Panel, PanelHead } from '../../home/Panel'
import { CATEGORIES, CATEGORY_META, categoryLabel } from './shared'

/** The account's flags split across the five signals — one labelled bar per
 * category, scaled to the busiest, each in its signal accent. A zero-count signal
 * stays visible (dimmed) so the shape of the account's suspicion reads at a glance. */
export default function CategoryBreakdown({ counts }: { counts: Record<string, number> }) {
    const max = Math.max(1, ...CATEGORIES.map((c) => counts[c] ?? 0))
    return (
        <Panel>
            <PanelHead title="Signal breakdown" sub="Flag events by detection category" />
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
                {CATEGORIES.map((cat) => {
                    const n = counts[cat] ?? 0
                    const { icon: Icon, color } = CATEGORY_META[cat]
                    const pct = (n / max) * 100
                    const active = n > 0
                    return (
                        <Box key={cat}>
                            <Box
                                sx={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 0.75,
                                    mb: 0.5,
                                }}
                            >
                                <Box
                                    sx={{
                                        display: 'flex',
                                        color: active ? color : 'var(--muted)',
                                        flexShrink: 0,
                                    }}
                                >
                                    <Icon size={14} />
                                </Box>
                                <Typography
                                    sx={{ fontSize: 12.5, color: 'var(--text-dim)', flex: 1 }}
                                >
                                    {categoryLabel(cat)}
                                </Typography>
                                <Typography
                                    sx={{
                                        fontFamily: 'var(--font-mono)',
                                        fontSize: 13,
                                        fontWeight: 700,
                                        color: active ? 'var(--text)' : 'var(--muted)',
                                    }}
                                >
                                    {n}
                                </Typography>
                            </Box>
                            <Box
                                sx={{
                                    height: 7,
                                    borderRadius: '999px',
                                    bgcolor: 'var(--surface-2)',
                                    overflow: 'hidden',
                                }}
                            >
                                <Box
                                    sx={{
                                        width: `${active ? Math.max(pct, 4) : 0}%`,
                                        height: '100%',
                                        bgcolor: color,
                                        borderRadius: '999px',
                                        transition: 'width .3s ease',
                                    }}
                                />
                            </Box>
                        </Box>
                    )
                })}
            </Box>
        </Panel>
    )
}
