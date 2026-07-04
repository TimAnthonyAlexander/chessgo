import { Box, Typography } from '@mui/material'
import { Crown } from 'lucide-react'
import type { Profile } from '../../api/client'
import { fmtDate, fmtRelative, initials, monogramColor, type PrimaryRating } from './shared'
import RatingSparkline from './RatingSparkline'

/** The profile hero band: a layered surface anchoring identity (monogram +
 * name + badges + last-active) on the left and the headline rating call-out
 * (biggest rating, trend delta, sparkline) on the right. This is the "layer"
 * the old flat profile lacked — it mirrors the homepage's chrome hero. */
export default function IdentityHero({
    profile,
    isSelf,
    primary,
    lastActive,
}: {
    profile: Profile
    isSelf: boolean
    primary: PrimaryRating | null
    lastActive: string | null
}) {
    const color = monogramColor(profile.name)

    return (
        <Box
            sx={{
                position: 'relative',
                overflow: 'hidden',
                bgcolor: 'var(--surface)',
                border: '1px solid var(--line-soft)',
                borderRadius: '16px',
                p: { xs: 2.5, md: 3 },
                display: 'flex',
                flexDirection: { xs: 'column', md: 'row' },
                alignItems: { md: 'center' },
                justifyContent: 'space-between',
                gap: { xs: 2.5, md: 3 },
            }}
        >
            {/* Soft accent glow (the "layered" depth cue). */}
            <Box
                aria-hidden
                sx={{
                    position: 'absolute',
                    top: -80,
                    right: -60,
                    width: 260,
                    height: 260,
                    borderRadius: '50%',
                    background: `radial-gradient(circle, ${color}22, transparent 70%)`,
                    pointerEvents: 'none',
                }}
            />

            {/* Identity */}
            <Box
                sx={{
                    position: 'relative',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 2,
                    minWidth: 0,
                }}
            >
                <Box
                    sx={{
                        width: 62,
                        height: 62,
                        flexShrink: 0,
                        borderRadius: '16px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontFamily: 'var(--font-display)',
                        fontWeight: 700,
                        fontSize: 24,
                        color: '#fff',
                        background: `linear-gradient(140deg, ${color}, ${color}bb)`,
                        boxShadow: `0 6px 18px ${color}33`,
                    }}
                >
                    {initials(profile.name)}
                </Box>

                <Box sx={{ minWidth: 0 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
                        <Typography
                            sx={{
                                fontFamily: 'var(--font-display)',
                                fontWeight: 700,
                                fontSize: { xs: 26, md: 30 },
                                letterSpacing: '-0.01em',
                                lineHeight: 1.05,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                            }}
                        >
                            {profile.name}
                        </Typography>
                        {profile.role === 'admin' && (
                            <Box
                                sx={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: 0.5,
                                    color: 'var(--accent)',
                                }}
                            >
                                <Crown size={14} />
                                <Typography
                                    sx={{
                                        fontSize: 10.5,
                                        fontWeight: 700,
                                        letterSpacing: '0.12em',
                                        textTransform: 'uppercase',
                                    }}
                                >
                                    Admin
                                </Typography>
                            </Box>
                        )}
                        {isSelf && (
                            <Box
                                sx={{
                                    px: 0.9,
                                    py: '2px',
                                    borderRadius: '999px',
                                    bgcolor: 'var(--accent-soft)',
                                    color: 'var(--accent)',
                                    fontSize: 10.5,
                                    fontWeight: 700,
                                    letterSpacing: '0.08em',
                                    textTransform: 'uppercase',
                                }}
                            >
                                You
                            </Box>
                        )}
                    </Box>
                    <Typography sx={{ fontSize: 12.5, color: 'var(--muted)', mt: 0.6 }}>
                        Member since {fmtDate(profile.created_at)}
                        {lastActive && (
                            <Box component="span"> · Active {fmtRelative(lastActive)}</Box>
                        )}
                    </Typography>
                </Box>
            </Box>

            {/* Headline rating call-out */}
            {primary && (
                <Box
                    sx={{
                        position: 'relative',
                        flexShrink: 0,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 2,
                        px: 2,
                        py: 1.75,
                        borderRadius: '14px',
                        bgcolor: 'var(--surface-2)',
                        border: '1px solid var(--line-soft)',
                    }}
                >
                    <Box>
                        <Box
                            sx={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 0.75,
                                color: primary.color,
                            }}
                        >
                            <Typography
                                sx={{
                                    fontFamily: 'var(--font-mono)',
                                    fontSize: 10,
                                    fontWeight: 700,
                                    letterSpacing: '0.14em',
                                    textTransform: 'uppercase',
                                }}
                            >
                                {primary.label}
                            </Typography>
                            {primary.delta != null && primary.delta !== 0 && (
                                <Typography
                                    sx={{
                                        fontFamily: 'var(--font-mono)',
                                        fontSize: 11,
                                        fontWeight: 700,
                                        color: primary.delta > 0 ? '#5b9e5b' : '#ca4a4a',
                                    }}
                                >
                                    {primary.delta > 0 ? '+' : ''}
                                    {primary.delta}
                                </Typography>
                            )}
                        </Box>
                        <Typography
                            sx={{
                                fontFamily: 'var(--font-mono)',
                                fontSize: 34,
                                fontWeight: 700,
                                lineHeight: 1,
                                mt: 0.4,
                            }}
                        >
                            {primary.rating}
                            {primary.provisional && (
                                <Box component="span" sx={{ color: 'var(--muted)', fontSize: 22 }}>
                                    ?
                                </Box>
                            )}
                        </Typography>
                    </Box>
                    <RatingSparkline series={primary.series} color={primary.color} />
                </Box>
            )}
        </Box>
    )
}
