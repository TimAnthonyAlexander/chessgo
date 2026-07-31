import { Box, Button, IconButton, Typography } from '@mui/material'
import { Link } from 'react-router-dom'
import { Swords, UserMinus } from 'lucide-react'
import type { FriendRow } from '../../api/client'
import TitleBadge from '../TitleBadge'

/** One row of the accepted-friends list: identity + rating, an explicit
 * "Online"/"Offline" text label (never a coloured dot — online state is data,
 * not decoration), a Challenge action while they're online, and Unfriend
 * (keyed by `friend.linkId`, the FriendLink row id — confirmation lives at the
 * page level via ConfirmDialog). */
export default function FriendListItem({
    friend,
    onChallenge,
    onUnfriend,
}: {
    friend: FriendRow
    onChallenge: () => void
    onUnfriend: () => void
}) {
    return (
        <Box
            sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1.5,
                px: 1.5,
                py: 1.25,
                borderRadius: '10px',
                border: '1px solid var(--line-soft)',
            }}
        >
            <Box sx={{ minWidth: 0, flex: 1 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6 }}>
                    <TitleBadge title={friend.title} />
                    <Typography
                        component={Link}
                        to={`/@/${encodeURIComponent(friend.name)}`}
                        sx={{
                            fontSize: 14.5,
                            fontWeight: 600,
                            color: 'var(--text)',
                            textDecoration: 'none',
                            '&:hover': { color: 'var(--accent)' },
                        }}
                    >
                        {friend.name}
                    </Typography>
                </Box>
                <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75, mt: 0.25 }}>
                    <Typography
                        sx={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: 13,
                            color: 'var(--text-dim)',
                        }}
                    >
                        {friend.rating}
                    </Typography>
                    <Typography sx={{ fontSize: 11.5, color: 'var(--muted)', textTransform: 'capitalize' }}>
                        {friend.ratingCategory}
                    </Typography>
                    <Typography
                        sx={{
                            fontSize: 11.5,
                            fontWeight: 700,
                            letterSpacing: '0.04em',
                            textTransform: 'uppercase',
                            color: friend.online ? 'var(--accent)' : 'var(--muted)',
                        }}
                    >
                        {friend.online ? 'Online' : 'Offline'}
                    </Typography>
                </Box>
            </Box>

            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexShrink: 0 }}>
                {friend.online && (
                    <Button
                        size="small"
                        variant="outlined"
                        onClick={onChallenge}
                        startIcon={<Swords size={13} />}
                        sx={{ textTransform: 'none', fontWeight: 600, borderColor: 'var(--line)' }}
                    >
                        Challenge
                    </Button>
                )}
                <IconButton
                    size="small"
                    onClick={onUnfriend}
                    aria-label={`Unfriend ${friend.name}`}
                    sx={{ color: 'var(--muted)', '&:hover': { color: '#ca4a4a' } }}
                >
                    <UserMinus size={15} />
                </IconButton>
            </Box>
        </Box>
    )
}
