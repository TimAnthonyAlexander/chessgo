import { Box, Tooltip, Typography } from '@mui/material'
import { CATEGORIES, CATEGORY_META, categoryLabel } from './shared'

/** A fixed row of five signal pills — one per detection category — showing the
 * per-category flag count from a rollup's `counts`. A category with zero flags is
 * dimmed; a firing one lights up in its signal accent. Each pill is tooltipped
 * with the human category label + count. */
export default function CategoryPills({ counts }: { counts: Record<string, number> }) {
    return (
        <Box sx={{ display: 'flex', gap: 0.5 }}>
            {CATEGORIES.map((cat) => {
                const n = counts[cat] ?? 0
                const active = n > 0
                const { icon: Icon, color } = CATEGORY_META[cat]
                return (
                    <Tooltip
                        key={cat}
                        arrow
                        title={`${categoryLabel(cat)} — ${n} flag${n === 1 ? '' : 's'}`}
                    >
                        <Box
                            sx={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 0.375,
                                px: 0.625,
                                height: 22,
                                borderRadius: 'var(--radius)',
                                bgcolor: active
                                    ? `color-mix(in srgb, ${color} 16%, transparent)`
                                    : 'var(--surface-2)',
                                border: '1px solid',
                                borderColor: active
                                    ? `color-mix(in srgb, ${color} 40%, transparent)`
                                    : 'var(--line-soft)',
                                color: active ? color : 'var(--muted)',
                                opacity: active ? 1 : 0.55,
                            }}
                        >
                            <Icon size={12} />
                            <Typography
                                sx={{
                                    fontFamily: 'var(--font-mono)',
                                    fontSize: 11,
                                    fontWeight: 700,
                                    lineHeight: 1,
                                    color: 'inherit',
                                }}
                            >
                                {n}
                            </Typography>
                        </Box>
                    </Tooltip>
                )
            })}
        </Box>
    )
}
