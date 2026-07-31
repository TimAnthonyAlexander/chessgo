import { useEffect, useState } from 'react'
import { Box, Button, CircularProgress, TextField, Typography } from '@mui/material'
import { UserPlus, Users } from 'lucide-react'
import { useOutletContext } from 'react-router-dom'
import {
    acceptFriendRequest,
    addFriend,
    ApiError,
    declineFriendRequest,
    type FriendRequestRow as FriendRequestRowData,
    type FriendRow,
    getFriendRequests,
    getFriends,
    removeFriend,
} from '../api/client'
import ConfirmDialog from '../components/ConfirmDialog'
import FriendChallengeDialog from '../components/friends/FriendChallengeDialog'
import FriendListItem from '../components/friends/FriendListItem'
import FriendRequestRow from '../components/friends/FriendRequestRow'
import { Panel, PanelHead } from '../components/home/Panel'
import type { LayoutOutletContext } from '../components/Layout'
import { useAuth } from '../lib/auth'

type Load<T> = { kind: 'loading' } | { kind: 'ready'; data: T } | { kind: 'error'; message: string }

export default function Friends() {
    const { user, status } = useAuth()
    const { openAuth } = useOutletContext<LayoutOutletContext>()

    const [friends, setFriends] = useState<Load<FriendRow[]>>({ kind: 'loading' })
    const [requests, setRequests] = useState<
        Load<{ incoming: FriendRequestRowData[]; outgoing: FriendRequestRowData[] }>
    >({ kind: 'loading' })

    const [addName, setAddName] = useState('')
    const [adding, setAdding] = useState(false)
    const [addError, setAddError] = useState<string | null>(null)
    const [addSuccess, setAddSuccess] = useState<string | null>(null)

    const [busyId, setBusyId] = useState<string | null>(null)
    const [challengeTarget, setChallengeTarget] = useState<{ name: string } | null>(null)
    const [unfriendTarget, setUnfriendTarget] = useState<{ linkId: string; name: string } | null>(null)

    const loadFriends = () => {
        getFriends()
            .then((r) => setFriends({ kind: 'ready', data: r.friends }))
            .catch(() => setFriends({ kind: 'error', message: "Couldn't load your friends." }))
    }
    const loadRequests = () => {
        getFriendRequests()
            .then((r) => setRequests({ kind: 'ready', data: r }))
            .catch(() => setRequests({ kind: 'error', message: "Couldn't load friend requests." }))
    }

    useEffect(() => {
        if (status !== 'ready' || !user) return
        loadFriends()
        loadRequests()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [status, user])

    const submitAdd = async () => {
        const name = addName.trim()
        if (!name) return
        setAdding(true)
        setAddError(null)
        setAddSuccess(null)
        try {
            const r = await addFriend(name)
            setAddName('')
            setAddSuccess(
                r.status === 'accepted'
                    ? `You and ${name} are now friends.`
                    : `Friend request sent to ${name}.`,
            )
            loadFriends()
            loadRequests()
        } catch (e) {
            setAddError(e instanceof ApiError ? e.message : 'Could not send the request.')
        } finally {
            setAdding(false)
        }
    }

    const accept = async (id: string) => {
        setBusyId(id)
        try {
            await acceptFriendRequest(id)
            loadFriends()
            loadRequests()
        } catch {
            /* left pending — the row stays put and can be retried */
        } finally {
            setBusyId(null)
        }
    }

    const decline = async (id: string) => {
        setBusyId(id)
        try {
            await declineFriendRequest(id)
            loadRequests()
        } catch {
            /* no-op — retry available */
        } finally {
            setBusyId(null)
        }
    }

    const cancel = async (id: string) => {
        setBusyId(id)
        try {
            await removeFriend(id)
            loadRequests()
        } catch {
            /* no-op — retry available */
        } finally {
            setBusyId(null)
        }
    }

    const unfriend = async (linkId: string) => {
        setBusyId(linkId)
        try {
            await removeFriend(linkId)
            loadFriends()
        } catch {
            /* no-op — retry available */
        } finally {
            setBusyId(null)
        }
    }

    if (status !== 'ready') {
        return (
            <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', py: 10 }}>
                <CircularProgress size={22} sx={{ color: 'var(--muted)' }} />
            </Box>
        )
    }

    if (!user) {
        return (
            <Box sx={{ maxWidth: 480, mx: 'auto', px: 2, py: 10, textAlign: 'center' }}>
                <Typography sx={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 26, mb: 1 }}>
                    Friends
                </Typography>
                <Typography sx={{ color: 'var(--text-dim)', fontSize: 14, mb: 3 }}>
                    Log in to add friends, see who's online, and send them a game.
                </Typography>
                <Button variant="contained" onClick={() => openAuth('login')} sx={{ textTransform: 'none', fontWeight: 600 }}>
                    Log in
                </Button>
            </Box>
        )
    }

    const incoming = requests.kind === 'ready' ? requests.data.incoming : []
    const outgoing = requests.kind === 'ready' ? requests.data.outgoing : []
    const friendList = friends.kind === 'ready' ? friends.data : []

    return (
        <Box sx={{ maxWidth: 760, mx: 'auto', px: { xs: 2, md: 3 }, py: { xs: 3, md: 5 }, width: '100%' }}>
            <Box sx={{ mb: { xs: 3, md: 4 } }}>
                <Typography
                    sx={{
                        fontFamily: 'var(--font-display)',
                        fontWeight: 700,
                        fontSize: { xs: 28, md: 36 },
                        lineHeight: 1.05,
                        letterSpacing: '-0.02em',
                    }}
                >
                    Friends
                </Typography>
                <Typography sx={{ mt: 1, fontSize: 14, color: 'var(--text-dim)' }}>
                    Add people by username, then challenge them straight from here.
                </Typography>
            </Box>

            <Panel sx={{ mb: 2.5 }}>
                <PanelHead title="Add a friend" />
                <Box sx={{ display: 'flex', gap: 1 }}>
                    <TextField
                        placeholder="Username"
                        value={addName}
                        onChange={(e) => {
                            setAddName(e.target.value)
                            setAddError(null)
                            setAddSuccess(null)
                        }}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') void submitAdd()
                        }}
                        size="small"
                        fullWidth
                    />
                    <Button
                        variant="contained"
                        disabled={adding || !addName.trim()}
                        onClick={() => void submitAdd()}
                        startIcon={adding ? <CircularProgress size={14} color="inherit" /> : <UserPlus size={15} />}
                        sx={{ textTransform: 'none', fontWeight: 600, flexShrink: 0 }}
                    >
                        Add
                    </Button>
                </Box>
                {addError && (
                    <Typography sx={{ fontSize: 12.5, color: '#ca4a4a', mt: 1 }}>{addError}</Typography>
                )}
                {addSuccess && (
                    <Typography sx={{ fontSize: 12.5, color: 'var(--accent)', mt: 1 }}>{addSuccess}</Typography>
                )}
            </Panel>

            {(incoming.length > 0 || outgoing.length > 0) && (
                <Panel sx={{ mb: 2.5 }}>
                    <PanelHead title="Requests" />
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                        {incoming.map((r) => (
                            <FriendRequestRow
                                key={r.id}
                                request={r}
                                direction="incoming"
                                busy={busyId === r.id}
                                onAccept={() => void accept(r.id)}
                                onDecline={() => void decline(r.id)}
                            />
                        ))}
                        {outgoing.map((r) => (
                            <FriendRequestRow
                                key={r.id}
                                request={r}
                                direction="outgoing"
                                busy={busyId === r.id}
                                onCancel={() => void cancel(r.id)}
                            />
                        ))}
                    </Box>
                </Panel>
            )}

            <Panel>
                <PanelHead title="Your friends" sub={friendList.length > 0 ? `${friendList.length} total` : undefined} />
                {friends.kind === 'loading' && (
                    <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
                        <CircularProgress size={20} sx={{ color: 'var(--muted)' }} />
                    </Box>
                )}
                {friends.kind === 'error' && (
                    <Typography sx={{ fontSize: 13, color: '#ca4a4a', py: 2 }}>{friends.message}</Typography>
                )}
                {friends.kind === 'ready' && friendList.length === 0 && (
                    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', py: 4, gap: 1 }}>
                        <Box sx={{ color: 'var(--muted)' }}>
                            <Users size={22} />
                        </Box>
                        <Typography sx={{ fontSize: 13.5, color: 'var(--text-dim)', textAlign: 'center', maxWidth: 320 }}>
                            No friends yet. Add someone by their username above — once they accept,
                            you'll see when they're online and can challenge them directly.
                        </Typography>
                    </Box>
                )}
                {friends.kind === 'ready' && friendList.length > 0 && (
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
                        {friendList.map((f) => (
                            <FriendListItem
                                key={f.linkId}
                                friend={f}
                                onChallenge={() => setChallengeTarget({ name: f.name })}
                                onUnfriend={() => setUnfriendTarget({ linkId: f.linkId, name: f.name })}
                            />
                        ))}
                    </Box>
                )}
            </Panel>

            <FriendChallengeDialog
                open={challengeTarget !== null}
                friendName={challengeTarget?.name ?? ''}
                onClose={() => setChallengeTarget(null)}
            />

            <ConfirmDialog
                open={unfriendTarget !== null}
                title={`Unfriend ${unfriendTarget?.name ?? ''}?`}
                message="You'll need to send a new request to add them back."
                confirmLabel="Unfriend"
                danger
                onConfirm={() => {
                    if (unfriendTarget) void unfriend(unfriendTarget.linkId)
                }}
                onClose={() => setUnfriendTarget(null)}
            />
        </Box>
    )
}
