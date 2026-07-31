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
import { Check, Copy, Crown, Send } from 'lucide-react'
import { createChallenge as createDirectedChallenge, type ChallengeVariant } from '../api/client'
import { gameSocket } from '../lib/socket'
import { useGameSocket } from '../lib/useGameSocket'
import { useAuth } from '../lib/auth'
import { type Variant, VARIANT_LABEL } from '../lib/variants'
import VariantPicker from './VariantPicker'

// Time-control presets, shared with the lobby. Kept here so the dialog is
// self-contained (the values are simple strings the hub parses directly).
const PRESETS = ['1+0', '2+1', '3+0', '3+2', '5+0', '5+3', '10+0', '10+5', '15+10', '30+0', '30+20']

type ColorPref = 'w' | 'b' | 'random'

// Every variant this dialog offers. Chess960 drops out when a custom start FEN
// is set — the hub rejects that combination (its own randomized start always
// wins over a custom FEN).
const ALL_VARIANTS: Variant[] = ['standard', 'chess960', 'duck', 'crazyhouse', 'antichess']
const NO_960_VARIANTS: Variant[] = ['standard', 'duck', 'crazyhouse', 'antichess']

/** "Challenge a friend" modal. Two independent axes:
 *  - **Who**: leave the opponent field blank for the existing anonymous
 *    code/link (anyone who has it can join); fill in a username to send that
 *    player a persistent, directed challenge instead (they get a notification
 *    and can accept later, even offline) — POST /challenges rather than a WS
 *    invite.
 *  - **From where**: an optional `startFen` challenges from that position
 *    instead of the normal start. The hub always forces a custom-FEN game
 *    casual and never combines it with chess960, so both are locked here too.
 */
export default function ChallengeDialog({
    open,
    onClose,
    startFen,
}: {
    open: boolean
    onClose: () => void
    startFen?: string
}) {
    const s = useGameSocket()
    const { user } = useAuth()
    const challenge = s.challenge
    const fenLocked = !!startFen

    // Create-form state.
    const [custom, setCustom] = useState(false)
    const [preset, setPreset] = useState('5+0')
    const [base, setBase] = useState('5')
    const [inc, setInc] = useState('3')
    const [color, setColor] = useState<ColorPref>('random')
    const [rated, setRated] = useState(true)
    const [variant, setVariant] = useState<Variant>('standard')
    const [opponent, setOpponent] = useState('')

    // Directed-challenge (POST /challenges) send state — separate from the WS
    // invite flow above, since it's a one-shot request, not a live socket wait.
    const [sending, setSending] = useState(false)
    const [sentTo, setSentTo] = useState<string | null>(null)
    const [sendError, setSendError] = useState<string | null>(null)

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
            setOpponent('')
            setSending(false)
            setSentTo(null)
            setSendError(null)
            gameSocket.clearError()
        }
    }, [open])

    // A failed join (bad/expired code) clears the spinner so the user can retry.
    useEffect(() => {
        if (s.error) setJoining(false)
    }, [s.error])

    // A custom start position is always casual, and chess960 can't combine with
    // one — keep the form honest if a caller changes `startFen` under us.
    useEffect(() => {
        if (fenLocked) {
            setRated(false)
            setVariant((v) => (v === 'chess960' ? 'standard' : v))
        }
    }, [fenLocked])

    const loggedIn = !!user
    const effectiveRated = loggedIn && rated && !fenLocked
    const directed = opponent.trim().length > 0

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
        if (!poolValid || sending) return
        if (directed) {
            void sendDirected()
        } else {
            void gameSocket.createChallenge(pool, color, effectiveRated, variant, startFen)
        }
    }

    const sendDirected = async () => {
        const name = opponent.trim()
        if (!name) return
        setSending(true)
        setSendError(null)
        try {
            await createDirectedChallenge({
                name,
                pool,
                color,
                rated: effectiveRated,
                variant: variant as ChallengeVariant,
                fen: startFen,
            })
            setSentTo(name)
        } catch (e) {
            setSendError(e instanceof Error ? e.message : 'Could not send the challenge.')
        } finally {
            setSending(false)
        }
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
                        borderRadius: '16px',
                        minWidth: 360,
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
                        variant={challenge.variant}
                        copied={copied}
                        onCopyCode={() => copy('code', challenge.code)}
                        onCopyLink={() => copy('link', shareLink)}
                        onCancel={close}
                    />
                ) : sentTo ? (
                    <DirectSentView name={sentTo} onClose={close} />
                ) : (
                    <>
                        <Typography
                            sx={{
                                fontFamily: 'var(--font-display)',
                                fontWeight: 600,
                                fontSize: 20,
                                mb: 0.5,
                            }}
                        >
                            Challenge a {directed ? 'player' : 'friend'}
                        </Typography>
                        <Typography sx={{ color: 'var(--text-dim)', fontSize: 13, mb: 2 }}>
                            {directed
                                ? "Send an invitation — they'll get a notification and can accept anytime, even offline."
                                : 'Create a private game and send your friend the link.'}
                            {fenLocked && ' Starts from the position you set up.'}
                        </Typography>

                        {/* Opponent */}
                        <Label text="Opponent (optional)" />
                        <TextField
                            value={opponent}
                            onChange={(e) => setOpponent(e.target.value)}
                            placeholder="Username — leave blank for a shareable link"
                            size="small"
                            fullWidth
                            sx={{ mb: 2 }}
                        />

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

                        {/* Variant */}
                        <Label text="Variant" sx={{ mt: 2 }} />
                        <VariantPicker
                            value={variant}
                            onChange={setVariant}
                            only={fenLocked ? NO_960_VARIANTS : ALL_VARIANTS}
                        />

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
                                    {fenLocked
                                        ? 'Custom positions always start casual'
                                        : loggedIn
                                          ? "Affects both players' ratings"
                                          : 'Log in to play rated'}
                                </Typography>
                            </Box>
                            <Box sx={{ display: 'flex', gap: 0.75 }}>
                                <Chip
                                    label="Casual"
                                    active={!effectiveRated}
                                    onClick={() => setRated(false)}
                                    small
                                    disabled={fenLocked}
                                />
                                <Chip
                                    label="Rated"
                                    active={effectiveRated}
                                    onClick={() => loggedIn && !fenLocked && setRated(true)}
                                    small
                                    disabled={!loggedIn || fenLocked}
                                />
                            </Box>
                        </Box>

                        <Button
                            variant="contained"
                            fullWidth
                            disabled={!poolValid || s.conn === 'connecting' || sending}
                            onClick={create}
                            startIcon={
                                sending ? (
                                    <CircularProgress size={14} color="inherit" />
                                ) : directed ? (
                                    <Send size={15} />
                                ) : undefined
                            }
                            sx={{ mt: 2.5, textTransform: 'none', fontWeight: 600 }}
                        >
                            {directed ? 'Send challenge' : 'Create invite'}
                        </Button>

                        {sendError && (
                            <Alert
                                severity="error"
                                variant="outlined"
                                sx={{ mt: 1.5, fontSize: 13 }}
                            >
                                {sendError}
                            </Alert>
                        )}

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
                                    fontFamily: 'var(--font-mono)',
                                    letterSpacing: '0.14em',
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
                                sx={{ textTransform: 'none', fontWeight: 600 }}
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
    variant,
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
    variant: Variant
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
                        letterSpacing: '0.14em',
                        pl: '0.14em',
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
                    borderRadius: '12px',
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
                {variant !== 'standard' && (
                    <>
                        <span>·</span>
                        <span>{VARIANT_LABEL[variant]}</span>
                    </>
                )}
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

// --- directed-challenge confirmation sub-view ---

/** Shown after a directed challenge (POST /challenges) is sent — unlike the WS
 * invite above, there's nothing to wait on here: the opponent's inbox has it
 * and they can accept whenever they're next online. */
function DirectSentView({ name, onClose }: { name: string; onClose: () => void }) {
    return (
        <Box sx={{ textAlign: 'center' }}>
            <Box
                sx={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 48,
                    height: 48,
                    borderRadius: '50%',
                    bgcolor: 'var(--surface-2)',
                    border: '1px solid var(--accent-line)',
                    color: 'var(--accent)',
                    mx: 'auto',
                    mb: 1.5,
                }}
            >
                <Check size={22} />
            </Box>
            <Typography
                sx={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 20, mb: 0.5 }}
            >
                Challenge sent
            </Typography>
            <Typography sx={{ color: 'var(--text-dim)', fontSize: 13, mb: 2.5 }}>
                {name} will get a notification and can accept it anytime, even while offline.
            </Typography>
            <Button
                variant="contained"
                fullWidth
                onClick={onClose}
                sx={{ textTransform: 'none', fontWeight: 600 }}
            >
                Done
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
                fontFamily: 'var(--font-mono)',
                letterSpacing: '0.14em',
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
                borderRadius: '12px',
                cursor: disabled ? 'not-allowed' : 'pointer',
                opacity: disabled ? 0.4 : 1,
                color: active ? 'var(--on-accent)' : 'var(--text-dim)',
                background: active
                    ? 'var(--accent-grad)'
                    : 'var(--surface-2)',
                border: active
                    ? '1px solid var(--accent)'
                    : dashed
                      ? '1px dashed var(--line)'
                      : '1px solid var(--line)',
                transition: 'border-color 0.12s ease, background 0.12s ease, color 0.12s ease',
                '&:hover': disabled
                    ? {}
                    : {
                          borderColor: 'var(--accent-line)',
                          color: active ? 'var(--on-accent)' : 'var(--text)',
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
