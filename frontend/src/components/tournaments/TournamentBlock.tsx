import { Box, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'
import { Crown, Rabbit, Skull, Timer, Users, Zap } from 'lucide-react'
import type { TournamentSummary } from '../../api/client'
import { DuckGlyph } from '../DuckGlyph'
import type { LaneGroup } from './groups'
import { GROUP_COLOR, parsePool } from './groups'
import { formatMinutes, hhmm, poolSpeed, restrictionText, SPEED_LABEL } from './timing'

/** One timeline block: a 32px icon slot, the title, and a meta line
 * (`{clock}+{inc} {Rated|Casual}` + a person icon with the player count).
 * Absolutely positioned by its caller (`left`/`width` in px) inside its
 * lane's `position: relative` track. */
export default function TournamentBlock({
    t,
    group,
    left,
    width,
    onClick,
}: {
    t: TournamentSummary
    group: LaneGroup
    left: number
    width: number
    onClick: () => void
}) {
    const color = GROUP_COLOR[group]
    const past = t.status === 'finished'
    const { limit, increment } = parsePool(t.pool)
    const restriction = restrictionText(t)
    const startsAt = new Date(`${t.starts_at.replace(' ', 'T')  }Z`).getTime()

    const tooltip = [
        t.name,
        `${hhmm(startsAt)}–${hhmm(t.ends_at_ms)} (${formatMinutes(t.duration_minutes)})`,
        `${limit}+${increment} ${SPEED_LABEL[poolSpeed(t.pool)]}`,
        t.rated ? 'Rated' : 'Casual',
        restriction,
        `${t.player_count} player${t.player_count === 1 ? '' : 's'}`,
    ]
        .filter(Boolean)
        .join(' · ')

    return (
        <Box
            onClick={onClick}
            role="button"
            tabIndex={0}
            title={tooltip}
            aria-label={tooltip}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onClick()
                }
            }}
            sx={{
                position: 'absolute',
                left,
                width,
                top: 0,
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                px: 1,
                overflow: 'hidden',
                cursor: 'pointer',
                borderRadius: 'var(--radius)',
                border: `1px solid ${alpha(color, past ? 0.3 : 0.55)}`,
                borderLeft: `3px solid ${alpha(color, past ? 0.35 : 1)}`,
                bgcolor: alpha(color, past ? 0.06 : 0.14),
                opacity: past ? 0.6 : 1,
                transition: 'filter 0.1s ease, background-color 0.1s ease',
                '&:hover': { filter: 'brightness(1.12)' },
                '&:focus-visible': { outline: `2px solid ${color}`, outlineOffset: '-2px' },
            }}
        >
            <Box
                sx={{
                    flexShrink: 0,
                    width: 36,
                    height: 36,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color,
                    fontSize: 22,
                    filter: past ? 'grayscale(1)' : 'none',
                }}
            >
                <BlockIcon t={t} />
            </Box>

            <Box sx={{ minWidth: 0, overflow: 'hidden' }}>
                <Typography
                    noWrap
                    sx={{
                        fontFamily: 'var(--font-display)',
                        fontWeight: 700,
                        fontSize: 15,
                        lineHeight: 1.25,
                        color: 'var(--text)',
                    }}
                >
                    {t.name}
                </Typography>
                <Box
                    sx={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 0.6,
                        fontFamily: 'var(--font-mono)',
                        fontSize: 12,
                        color: 'var(--text-dim)',
                        whiteSpace: 'nowrap',
                        fontVariantNumeric: 'tabular-nums',
                    }}
                >
                    <span>
                        {limit}+{increment}
                    </span>
                    <span>{t.rated ? 'Rated' : 'Casual'}</span>
                    <Users size={11} style={{ flexShrink: 0 }} />
                    <span>{t.player_count}</span>
                </Box>
            </Box>
        </Box>
    )
}

/** The block's leading glyph: the variant's own icon for a non-standard
 * variant (matching the icons already used for the admin games table and
 * Duck Chess elsewhere in the app), otherwise the speed icon used on the
 * live-game mode card (Rabbit/Zap/Timer/Crown for bullet/blitz/rapid/
 * classical). */
function BlockIcon({ t }: { t: TournamentSummary }) {
    if (t.variant === 'duck') return <DuckGlyph />
    if (t.variant === 'crazyhouse') {
        return (
            <Box component="span" sx={{ fontSize: '1.3em', lineHeight: 1 }}>
                &#8644;
            </Box>
        )
    }
    if (t.variant === 'antichess') return <Skull size={20} />
    if (t.variant === 'chess960') {
        return (
            <Box
                component="span"
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10.5,
                    fontWeight: 700,
                    lineHeight: 1.3,
                    border: '1px solid currentColor',
                    borderRadius: 'var(--radius)',
                    px: 0.4,
                }}
            >
                960
            </Box>
        )
    }

    const speed = poolSpeed(t.pool)
    if (speed === 'bullet') return <Rabbit size={20} />
    if (speed === 'blitz') return <Zap size={20} />
    if (speed === 'rapid') return <Timer size={20} />
    return <Crown size={20} />
}
