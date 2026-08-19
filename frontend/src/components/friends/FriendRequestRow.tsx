import { Box, Button, Typography } from '@mui/material'
import { Link } from 'react-router-dom'
import type { FriendRequestRow as FriendRequestRowData } from '../../api/client'
import { formatRelativeTime } from '../notifications/relativeTime'
import TitleBadge from '../TitleBadge'

/** One pending friend request — incoming shows Accept/Decline, outgoing shows
 * Cancel. `busy` disables the row's actions while a mutation is in flight. */
export default function FriendRequestRow({
    request,
    direction,
    busy,
    onAccept,
    onDecline,
    onCancel,
}: {
    request: FriendRequestRowData
    direction: 'incoming' | 'outgoing'
    busy: boolean
    onAccept?: () => void
    onDecline?: () => void
    onCancel?: () => void
}) {
    const name = request.name ?? 'Unknown player'
    return (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, px: 1.5, py: 1, borderRadius: 'var(--radius)' }}>
            <Box sx={{ minWidth: 0, flex: 1 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6 }}>
                    <TitleBadge title={request.title} />
                    {request.name ? (
                        <Typography
                            component={Link}
                            to={`/@/${encodeURIComponent(request.name)}`}
                            sx={{
                                fontSize: 14,
                                fontWeight: 600,
                                color: 'var(--text)',
                                textDecoration: 'none',
                                '&:hover': { color: 'var(--accent)' },
                            }}
                        >
                            {name}
                        </Typography>
                    ) : (
                        <Typography sx={{ fontSize: 14, fontWeight: 600, color: 'var(--text-dim)' }}>
                            {name}
                        </Typography>
                    )}
                </Box>
                <Typography sx={{ fontSize: 11.5, color: 'var(--muted)', mt: 0.15 }}>
                    {direction === 'incoming' ? 'Wants to be friends' : 'Request pending'} ·{' '}
                    {formatRelativeTime(request.createdAt)}
                </Typography>
            </Box>

            <Box sx={{ display: 'flex', gap: 0.75, flexShrink: 0 }}>
                {direction === 'incoming' ? (
                    <>
                        <Button
                            size="small"
                            variant="contained"
                            disabled={busy}
                            onClick={onAccept}
                            sx={{ textTransform: 'none', fontWeight: 600 }}
                        >
                            Accept
                        </Button>
                        <Button
                            size="small"
                            color="inherit"
                            disabled={busy}
                            onClick={onDecline}
                            sx={{ textTransform: 'none', color: 'var(--text-dim)' }}
                        >
                            Decline
                        </Button>
                    </>
                ) : (
                    <Button
                        size="small"
                        color="inherit"
                        disabled={busy}
                        onClick={onCancel}
                        sx={{ textTransform: 'none', color: 'var(--text-dim)' }}
                    >
                        Cancel
                    </Button>
                )}
            </Box>
        </Box>
    )
}
