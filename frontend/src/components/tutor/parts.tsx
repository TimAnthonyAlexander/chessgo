import type { ReactNode } from 'react'
import { Box, Typography } from '@mui/material'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { directionText, fmtGames, isThin } from './format'

/**
 * Small shared pieces of the report's type scale. The contrast rule they exist
 * to enforce: exactly one thing per row is bright (--text) and everything
 * supporting it is --muted. Section headers sit at --text-dim, NOT --muted —
 * at 11px in a mono face with wide tracking, --muted was the least legible
 * text on the page while also being the only thing telling you what you were
 * looking at.
 */

export function SectionHead({
    title,
    sub,
    rule = true,
}: {
    title: string
    sub?: string
    rule?: boolean
}) {
    return (
        <Box
            sx={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: 1,
                mb: 1.5,
                pb: rule ? 0.75 : 0,
                borderBottom: rule ? '1px solid var(--line-soft)' : 'none',
            }}
        >
            <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, flexWrap: 'wrap', minWidth: 0 }}>
                <Typography
                    component="h2"
                    sx={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11,
                        fontWeight: 600,
                        letterSpacing: '0.16em',
                        textTransform: 'uppercase',
                        color: 'var(--text-dim)',
                    }}
                >
                    {title}
                </Typography>
                {sub && (
                    <Typography sx={{ fontSize: 12, color: 'var(--muted)', minWidth: 0 }}>{sub}</Typography>
                )}
            </Box>
        </Box>
    )
}

/** The direction of goodness, per metric. An arrow rather than words because it
 * repeats on every row; the reading key in the rail spells it out once. */
export function DirectionMark({ higherIsBetter }: { higherIsBetter: boolean }) {
    const Icon = higherIsBetter ? ArrowUp : ArrowDown
    return (
        <Box
            component="span"
            title={directionText(higherIsBetter)}
            aria-label={directionText(higherIsBetter)}
            sx={{ display: 'inline-flex', color: 'var(--muted)', flexShrink: 0 }}
        >
            <Icon size={12} strokeWidth={2.25} />
        </Box>
    )
}

/** A sample size, coloured by whether it carries any weight. --warn is a status
 * token doing status work here, and it never travels alone — the word "thin"
 * rides with it. */
export function SampleNote({ sample }: { sample: number }) {
    const thin = isThin(sample)
    return (
        <Box component="span" sx={{ color: thin ? 'var(--warn)' : 'var(--muted)', whiteSpace: 'nowrap' }}>
            {fmtGames(sample)}
            {thin ? ' · thin' : ''}
        </Box>
    )
}

/** Row caption: one line of mono metadata under a meter. Always --muted, so
 * the value above it stays the only bright thing in the row. */
export function Caption({ children }: { children: ReactNode }) {
    return (
        <Typography
            sx={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                lineHeight: 1.5,
                color: 'var(--muted)',
                fontVariantNumeric: 'tabular-nums',
            }}
        >
            {children}
        </Typography>
    )
}

/** The one bright thing in a row. `tone` is ink only — never a bar fill — and
 * 'weakness' is the sole caller allowed --danger. */
export function Value({
    children,
    tone = 'plain',
    dim = false,
    size = 15,
}: {
    children: ReactNode
    tone?: 'plain' | 'strength' | 'weakness'
    dim?: boolean
    size?: number
}) {
    const color =
        tone === 'weakness'
            ? 'var(--danger)'
            : tone === 'strength'
              ? 'var(--accent)'
              : dim
                ? 'var(--text-dim)'
                : 'var(--text)'
    return (
        <Typography
            sx={{
                fontFamily: 'var(--font-mono)',
                fontSize: size,
                fontWeight: 700,
                lineHeight: 1.2,
                color,
                fontVariantNumeric: 'tabular-nums',
                whiteSpace: 'nowrap',
                flexShrink: 0,
            }}
        >
            {children}
        </Typography>
    )
}
