import { Box, Typography } from '@mui/material'
import { Crown } from 'lucide-react'
import type { Profile } from '../../api/client'
import { fmtDate, fmtRelative, initials, monogramColor } from './shared'

/** The profile hero band: a quiet identity header (monogram + name + badges +
 * last-active). Ratings live in `RatingsPanel` below — the hero used to echo
 * the player's headline rating too, which just duplicated that panel. */
export default function IdentityHero({
    profile,
    isSelf,
    lastActive,
}: {
    profile: Profile
    isSelf: boolean
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
                p: { xs: 2.5, md: 2.75 },
                display: 'flex',
                alignItems: 'center',
                gap: 2,
            }}
        >
            {/* Soft accent glow (the "layered" depth cue), anchored behind the
                monogram now that the hero is identity-only. */}
            <Box
                aria-hidden
                sx={{
                    position: 'absolute',
                    top: -70,
                    left: -70,
                    width: 220,
                    height: 220,
                    borderRadius: '50%',
                    background: `radial-gradient(circle, ${color}22, transparent 70%)`,
                    pointerEvents: 'none',
                }}
            />

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
        </Box>
    )
}
