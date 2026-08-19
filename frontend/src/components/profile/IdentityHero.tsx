import { useState } from 'react'
import { Box, IconButton, Typography } from '@mui/material'
import { Pencil } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { Profile, ProfileUpdateResult } from '../../api/client'
import TitleBadge from '../TitleBadge'
import EditProfileDialog from './EditProfileDialog'
import { COUNTRY_NAMES, fmtDate, fmtRelative, initials } from './shared'

/** The profile header: identity only (monogram + title + name + last-active +
 * bio/country). No card chrome — a single hairline under the row separates it
 * from the stats below, and the name carries the hierarchy through size and
 * weight alone. Ratings live in `RatingsPanel` below; this used to echo the
 * player's headline rating too, which just duplicated that panel. */
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
    const [editOpen, setEditOpen] = useState(false)
    const countryName = profile.country ? (COUNTRY_NAMES[profile.country] ?? profile.country) : null

    return (
        <Box
            sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 2,
                pb: { xs: 2, md: 2.5 },
                borderBottom: '1px solid var(--line-soft)',
            }}
        >
            <Box
                sx={{
                    width: 58,
                    height: 58,
                    flexShrink: 0,
                    borderRadius: 'var(--radius)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontFamily: 'var(--font-display)',
                    fontWeight: 700,
                    fontSize: 22,
                    color: 'var(--text)',
                    bgcolor: 'var(--surface-2)',
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
                            fontSize: { xs: 28, md: 34 },
                            letterSpacing: '-0.01em',
                            lineHeight: 1.05,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                        }}
                    >
                        {profile.name}
                    </Typography>
                    {isSelf && (
                        <Typography
                            component="span"
                            sx={{
                                fontSize: 10.5,
                                fontWeight: 700,
                                letterSpacing: '0.08em',
                                textTransform: 'uppercase',
                                color: 'var(--accent)',
                            }}
                        >
                            You
                        </Typography>
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
                {profile.live_game && (
                    <Typography
                        component={Link}
                        to={`/watch/${profile.live_game.gameId}`}
                        sx={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 0.5,
                            mt: 0.6,
                            fontSize: 12.5,
                            fontWeight: 600,
                            color: 'var(--accent)',
                            textDecoration: 'none',
                            width: 'fit-content',
                            '&:hover': { textDecoration: 'underline' },
                        }}
                    >
                        Playing now — vs
                        <TitleBadge title={profile.live_game.opponent.title} />
                        {profile.live_game.opponent.name}
                    </Typography>
                )}
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
