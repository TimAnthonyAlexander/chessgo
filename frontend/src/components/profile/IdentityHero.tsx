import { useState } from 'react'
import { Box, IconButton, Typography } from '@mui/material'
import { Pencil } from 'lucide-react'
import type { Profile, ProfileUpdateResult } from '../../api/client'
import TitleBadge from '../TitleBadge'
import EditProfileDialog from './EditProfileDialog'
import { COUNTRY_NAMES, fmtDate, fmtRelative, initials, monogramColor } from './shared'

/** The profile hero band: a quiet identity header (monogram + title + name +
 * badges + last-active + bio/country). Ratings live in `RatingsPanel` below —
 * the hero used to echo the player's headline rating too, which just
 * duplicated that panel. */
export default function IdentityHero({
    profile,
    isSelf,
    lastActive,
    onProfileUpdated,
}: {
    profile: Profile
    isSelf: boolean
    lastActive: string | null
    /** Called with the server's response after a successful self-edit, so the
     *  caller can merge the new bio/country into the displayed profile without
     *  a full refetch. Only ever invoked when `isSelf`. */
    onProfileUpdated?: (result: ProfileUpdateResult) => void
}) {
    const color = monogramColor(profile.name)
    const [editOpen, setEditOpen] = useState(false)
    const countryName = profile.country ? (COUNTRY_NAMES[profile.country] ?? profile.country) : null

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

                <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
                        <TitleBadge title={profile.title} />
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
                        {isSelf && (
                            <IconButton
                                aria-label="Edit profile"
                                size="small"
                                onClick={() => setEditOpen(true)}
                                sx={{ color: 'var(--muted)', ml: 'auto' }}
                            >
                                <Pencil size={15} />
                            </IconButton>
                        )}
                    </Box>
                    <Typography sx={{ fontSize: 12.5, color: 'var(--muted)', mt: 0.6 }}>
                        Member since {fmtDate(profile.created_at)}
                        {lastActive && (
                            <Box component="span"> · Active {fmtRelative(lastActive)}</Box>
                        )}
                        {countryName && <Box component="span"> · {countryName}</Box>}
                    </Typography>
                    {profile.bio && (
                        <Typography
                            sx={{
                                fontSize: 13,
                                color: 'var(--text)',
                                mt: 1,
                                maxWidth: 480,
                                overflowWrap: 'anywhere',
                            }}
                        >
                            {profile.bio}
                        </Typography>
                    )}
                </Box>
            </Box>

            {isSelf && (
                <EditProfileDialog
                    open={editOpen}
                    onClose={() => setEditOpen(false)}
                    initialBio={profile.bio}
                    initialCountry={profile.country}
                    onSaved={(result) => onProfileUpdated?.(result)}
                />
            )}
        </Box>
    )
}
