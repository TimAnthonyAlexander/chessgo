import { useEffect, useState } from 'react'
import {
    Alert,
    Box,
    Button,
    CircularProgress,
    Dialog,
    DialogContent,
    Divider,
    TextField,
    Typography,
} from '@mui/material'
import { Check, Copy, Crown } from 'lucide-react'
import { gameSocket } from '../lib/socket'
import { useGameSocket } from '../lib/useGameSocket'
import { useAuth } from '../lib/auth'

// Time-control presets, shared with the lobby. Kept here so the dialog is
// self-contained (the values are simple strings the hub parses directly).
const PRESETS = ['1+0', '2+1', '3+0', '3+2', '5+0', '5+3', '10+0', '10+5', '15+10', '30+0', '30+20']

type ColorPref = 'w' | 'b' | 'random'

/** "Challenge a friend" modal: create a private invite (time control, color,
 * rated) and share its code/link, or join a friend's game by code. Pairing and
 * the invite lifetime live entirely on the hub; this is just its UI. */
export default function ChallengeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
    const s = useGameSocket()
    const { user } = useAuth()
    const challenge = s.challenge

    // Create-form state.
    const [custom, setCustom] = useState(false)
    const [preset, setPreset] = useState('5+0')
    const [base, setBase] = useState('5')
    const [inc, setInc] = useState('3')
    const [color, setColor] = useState<ColorPref>('random')
    const [rated, setRated] = useState(true)

    // Join-by-code state.
    const [joinCode, setJoinCode] = useState('')
    const [joining, setJoining] = useState(false)

    const [copied, setCopied] = useState<'code' | 'link' | null>(null)

    // Reset transient state whenever the dialog (re)opens.
    useEffect(() => {
        if (open) {
            setJoinCode('')
            setJoining(false)
            setCopied(null)
            gameSocket.clearError()
        }
    }, [open])

    // A failed join (bad/expired code) clears the spinner so the user can retry.
    useEffect(() => {
        if (s.error) setJoining(false)
    }, [s.error])

    const loggedIn = !!user
    const effectiveRated = loggedIn && rated

    const pool = custom ? `${parseInt(base || '0', 10)}+${parseInt(inc || '0', 10)}` : preset
    const poolValid = (() => {
        const [b, i] = pool.split('+').map((n) => parseInt(n, 10))
        return (
            Number.isFinite(b) &&
            Number.isFinite(i) &&
            b >= 0 &&
            i >= 0 &&
            b <= 180 &&
            i <= 180 &&
            !(b === 0 && i === 0)
        )
    })()

    const shareLink = challenge ? `${window.location.origin}/challenge/${challenge.code}` : ''

    const close = () => {
        // Closing while an invite is live withdraws it — an invite exists only as
        // long as its creator keeps this screen open (Lichess-style).
        if (challenge) gameSocket.cancelChallenge()
        onClose()
    }

    const create = () => {
        if (!poolValid) return
        void gameSocket.createChallenge(pool, color, effectiveRated)
    }

    const join = () => {
        const code = joinCode.trim()
        if (!code) return
        setJoining(true)
        void gameSocket.joinChallenge(code)
    }

    const copy = async (kind: 'code' | 'link', text: string) => {
        try {
            await navigator.clipboard.writeText(text)
            setCopied(kind)
            window.setTimeout(() => setCopied(null), 1500)
        } catch {
            /* clipboard unavailable (insecure context) — the text is still visible to select */
        }
    }

    return (
        <Dialog
            open={open}
            onClose={close}
            slotProps={{
                paper: {
                    sx: {
                        bgcolor: 'var(--surface)',
                        border: '1px solid var(--line)',
                        borderRadius: 3,
                        minWidth: 380,
                        maxWidth: 420,
                    },
                },
            }}
        >
            <DialogContent sx={{ p: 3 }}>
                {challenge ? (
                    <InviteView
                        code={challenge.code}
                        link={shareLink}
                        pool={challenge.pool}
                        color={challenge.color}
                        rated={challenge.rated}
                        copied={copied}
                        onCopyCode={() => copy('code', challenge.code)}
                        onCopyLink={() => copy('link', shareLink)}
                        onCancel={close}
                    />
                ) : (
                    <>
                        <Typography
                            sx={{
                                fontFamily: 'var(--font-display)',
                                fontWeight: 600,
                                fontSize: 22,
                                mb: 0.5,
                            }}
                        >
                            Challenge a friend
                        </Typography>
                        <Typography sx={{ color: 'var(--text-dim)', fontSize: 13.5, mb: 2.5 }}>
                            Create a private game and send your friend the link.
                        </Typography>

                        {/* Time control */}
                        <Label text="Time control" />
                        {!custom ? (
                            <Box
                                sx={{
                                    display: 'grid',
                                    gridTemplateColumns: 'repeat(4, 1fr)',
                                    gap: 0.75,
                                }}
                            >
                                {PRESETS.map((p) => (
                                    <Chip
                                        key={p}
                                        label={p}
                                        active={preset === p}
                                        onClick={() => setPreset(p)}
                                    />
                                ))}
                                <Chip
                                    label="Custom"
                                    active={false}
                                    onClick={() => setCustom(true)}
                                    dashed
                                />
                            </Box>
                        ) : (
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                <TextField
                                    label="Minutes"
                                    value={base}
                                    onChange={(e) => setBase(e.target.value.replace(/[^0-9]/g, ''))}
                                    size="small"
                                    sx={{ flex: 1 }}
                                />
                                <Typography sx={{ color: 'var(--text-dim)' }}>+</Typography>
                                <TextField
                                    label="Increment (s)"
                                    value={inc}
                                    onChange={(e) => setInc(e.target.value.replace(/[^0-9]/g, ''))}
                                    size="small"
                                    sx={{ flex: 1 }}
                                />
                                <Button
                                    size="small"
                                    color="inherit"
                                    onClick={() => setCustom(false)}
                                    sx={{ color: 'var(--text-dim)', textTransform: 'none' }}
                                >
                                    Presets
                                </Button>
                            </Box>
                        )}

                        {/* Color */}
                        <Label text="Play as" sx={{ mt: 2 }} />
                        <Box
                            sx={{
                                display: 'grid',
                                gridTemplateColumns: 'repeat(3, 1fr)',
                                gap: 0.75,
                            }}
                        >
                            <Chip
                                label="White"
                                active={color === 'w'}
                                onClick={() => setColor('w')}
                            />
                            <Chip
                                label="Random"
                                active={color === 'random'}
                                onClick={() => setColor('random')}
                            />
                            <Chip
                                label="Black"
                                active={color === 'b'}
                                onClick={() => setColor('b')}
                            />
                        </Box>

                        {/* Rated */}
                        <Box
                            sx={{
                                mt: 2,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: 1,
                            }}
                        >
                            <Box>
                                <Typography sx={{ fontSize: 14, fontWeight: 600 }}>
                                    Rated
                                </Typography>
                                <Typography sx={{ fontSize: 12, color: 'var(--text-dim)' }}>
                                    {loggedIn
                                        ? 'Affects both players’ ratings'
                                        : 'Log in to play rated'}
                                </Typography>
                            </Box>
                            <Box sx={{ display: 'flex', gap: 0.75 }}>
                                <Chip
                                    label="Casual"
                                    active={!effectiveRated}
                                    onClick={() => setRated(false)}
                                    small
                                />
                                <Chip
                                    label="Rated"
                                    active={effectiveRated}
                                    onClick={() => loggedIn && setRated(true)}
                                    small
                                    disabled={!loggedIn}
                                />
                            </Box>
                        </Box>

                        <Button
                            variant="contained"
                            fullWidth
                            disabled={!poolValid || s.conn === 'connecting'}
                            onClick={create}
                            sx={{ mt: 2.5 }}
                        >
                            Create invite
                        </Button>

                        <Divider
                            sx={{
                                my: 2.5,
                                borderColor: 'var(--line)',
                                '&::before, &::after': { borderColor: 'var(--line)' },
                            }}
                        >
                            <Typography
                                sx={{
                                    fontSize: 11.5,
                                    color: 'var(--muted)',
                                    letterSpacing: '0.1em',
                                }}
                            >
                                OR JOIN
                            </Typography>
                        </Divider>

                        <Box sx={{ display: 'flex', gap: 1 }}>
                            <TextField
                                label="Invite code"
                                value={joinCode}
                                onChange={(e) =>
                                    setJoinCode(
                                        e.target.value
                                            .toUpperCase()
                                            .replace(/[^A-Z0-9]/g, '')
                                            .slice(0, 6),
                                    )
                                }
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') join()
                                }}
                                size="small"
                                fullWidth
                                slotProps={{
                                    htmlInput: {
                                        style: {
                                            letterSpacing: '0.15em',
                                            fontFamily: 'var(--font-mono)',
                                        },
                                    },
                                }}
                            />
                            <Button
                                variant="outlined"
                                onClick={join}
                                disabled={joinCode.trim().length === 0 || joining}
                                startIcon={
                                    joining ? (
                                        <CircularProgress size={14} color="inherit" />
                                    ) : undefined
                                }
                            >
                                Join
                            </Button>
                        </Box>

                        {s.error && (
                            <Alert
                                severity="error"
                                variant="outlined"
                                sx={{ mt: 1.75, fontSize: 13 }}
                            >
                                {s.error}
                            </Alert>
                        )}
                    </>
                )}
            </DialogContent>
        </Dialog>
    )
}

// --- invite / waiting sub-view ---

function InviteView({
    code,
    link,
    pool,
    color,
    rated,
    copied,
    onCopyCode,
    onCopyLink,
    onCancel,
}: {
    code: string
    link: string
    pool: string
    color: ColorPref
    rated: boolean
    copied: 'code' | 'link' | null
    onCopyCode: () => void
    onCopyLink: () => void
    onCancel: () => void
}) {
    const colorLabel =
        color === 'w' ? 'You play White' : color === 'b' ? 'You play Black' : 'Random colors'
    return (
        <Box sx={{ textAlign: 'center' }}>
            <Typography
                sx={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 20, mb: 0.5 }}
            >
                Waiting for your friend…
            </Typography>
            <Typography sx={{ color: 'var(--text-dim)', fontSize: 13, mb: 2.5 }}>
                Share the code or link. The game starts the moment they join.
            </Typography>

            {/* Big code */}
            <Box
                sx={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 1,
                    py: 1.5,
                    mb: 1.25,
                    borderRadius: '12px',
                    bgcolor: 'var(--surface-2)',
                    border: '1px solid var(--line)',
                }}
            >
                <Typography
                    sx={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 30,
                        fontWeight: 700,
                        letterSpacing: '0.22em',
                        pl: '0.22em',
                    }}
                >
                    {code}
                </Typography>
                <CopyButton active={copied === 'code'} onClick={onCopyCode} />
            </Box>

            {/* Link */}
            <Box
                sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    px: 1.5,
                    py: 1,
                    mb: 2,
                    borderRadius: '10px',
                    bgcolor: 'var(--surface-2)',
                    border: '1px solid var(--line)',
                }}
            >
                <Typography
                    sx={{
                        flex: 1,
                        minWidth: 0,
                        fontSize: 12.5,
                        color: 'var(--text-dim)',
                        textAlign: 'left',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                    }}
                >
                    {link}
                </Typography>
                <CopyButton active={copied === 'link'} onClick={onCopyLink} label />
            </Box>

            <Box
                sx={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 1.5,
                    mb: 2.5,
                    color: 'var(--text-dim)',
                    fontSize: 12.5,
                }}
            >
                <Crown size={14} />
                <span>{pool}</span>
                <span>·</span>
                <span>{colorLabel}</span>
                <span>·</span>
                <span>{rated ? 'Rated' : 'Casual'}</span>
            </Box>

            <CircularProgress size={22} sx={{ color: 'var(--accent)', mb: 2 }} />

            <Button
                fullWidth
                color="inherit"
                onClick={onCancel}
                sx={{ color: 'var(--text-dim)', textTransform: 'none' }}
            >
                Cancel invite
            </Button>
        </Box>
    )
}

// --- small shared bits ---

function Label({ text, sx }: { text: string; sx?: object }) {
    return (
        <Typography
            sx={{
                fontSize: 12,
                fontWeight: 600,
                color: 'var(--muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                mb: 1,
                ...sx,
            }}
        >
            {text}
        </Typography>
    )
}

function Chip({
    label,
    active,
    onClick,
    dashed,
    small,
    disabled,
}: {
    label: string
    active: boolean
    onClick: () => void
    dashed?: boolean
    small?: boolean
    disabled?: boolean
}) {
    return (
        <Box
            onClick={disabled ? undefined : onClick}
            sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                py: small ? 0.6 : 1,
                px: small ? 1.5 : 0,
                fontSize: small ? 13 : 13.5,
                fontWeight: 600,
                fontFamily: 'var(--font-display)',
                borderRadius: '9px',
                cursor: disabled ? 'not-allowed' : 'pointer',
                opacity: disabled ? 0.4 : 1,
                color: active ? '#15171c' : 'var(--text-dim)',
                background: active
                    ? 'linear-gradient(180deg, #e3b56a, #d8a657)'
                    : 'var(--surface-2)',
                border: active
                    ? '1px solid var(--accent)'
                    : dashed
                      ? '1px dashed var(--line)'
                      : '1px solid var(--line)',
                transition: 'border-color .12s, background .12s, color .12s',
                '&:hover': disabled
                    ? {}
                    : {
                          borderColor: 'var(--accent-line)',
                          color: active ? '#15171c' : 'var(--text)',
                      },
            }}
        >
            {label}
        </Box>
    )
}

function CopyButton({
    active,
    onClick,
    label,
}: {
    active: boolean
    onClick: () => void
    label?: boolean
}) {
    return (
        <Button
            onClick={onClick}
            size="small"
            variant="outlined"
            startIcon={active ? <Check size={14} /> : <Copy size={14} />}
            sx={{
                flexShrink: 0,
                minWidth: label ? undefined : 40,
                px: label ? 1.25 : 1,
                textTransform: 'none',
                borderColor: 'var(--line)',
                color: active ? 'var(--accent)' : 'var(--text-dim)',
            }}
        >
            {label ? (active ? 'Copied' : 'Copy') : ''}
        </Button>
    )
}
