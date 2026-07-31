import { useEffect, useState } from 'react'
import {
    Alert,
    Box,
    Button,
    CircularProgress,
    Dialog,
    DialogContent,
    Switch,
    ToggleButton,
    ToggleButtonGroup,
    Typography,
} from '@mui/material'
import { Check, Swords } from 'lucide-react'
import { ApiError, createChallenge, type ChallengeVariant } from '../../api/client'
import VariantPicker from '../VariantPicker'

// Own, self-contained "challenge this friend" dialog — deliberately separate
// from ChallengeDialog.tsx (the hub's ephemeral code-link invite). This one
// sends a directed, persistent challenge (POST /challenges) to a specific
// friend by name; it sits in their notifications until they accept/decline.

const POOL_PRESETS = ['1+0', '3+0', '3+2', '5+0', '10+0', '15+10']

type ColorPref = 'w' | 'b' | 'random'

export default function FriendChallengeDialog({
    open,
    onClose,
    friendName,
}: {
    open: boolean
    onClose: () => void
    friendName: string
}) {
    const [pool, setPool] = useState('5+0')
    const [color, setColor] = useState<ColorPref>('random')
    const [rated, setRated] = useState(true)
    const [variant, setVariant] = useState<ChallengeVariant>('standard')
    const [sending, setSending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [sent, setSent] = useState(false)

    // Reset transient state whenever the dialog (re)opens for a (possibly
    // different) friend.
    useEffect(() => {
        if (open) {
            setPool('5+0')
            setColor('random')
            setRated(true)
            setVariant('standard')
            setSending(false)
            setError(null)
            setSent(false)
        }
    }, [open, friendName])

    const send = async () => {
        setSending(true)
        setError(null)
        try {
            await createChallenge({ name: friendName, pool, color, rated, variant })
            setSent(true)
        } catch (e) {
            setError(e instanceof ApiError ? e.message : 'Could not send the challenge.')
        } finally {
            setSending(false)
        }
    }

    return (
        <Dialog
            open={open}
            onClose={onClose}
            slotProps={{
                paper: {
                    sx: {
                        bgcolor: 'var(--surface)',
                        border: '1px solid var(--line)',
                        borderRadius: '16px',
                        minWidth: 340,
                        maxWidth: 400,
                    },
                },
            }}
        >
            <DialogContent sx={{ p: 3 }}>
                {sent ? (
                    <Box sx={{ textAlign: 'center', py: 1 }}>
                        <Box sx={{ display: 'flex', justifyContent: 'center', color: 'var(--accent)', mb: 1.5 }}>
                            <Check size={28} />
                        </Box>
                        <Typography sx={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 18, mb: 0.5 }}>
                            Challenge sent
                        </Typography>
                        <Typography sx={{ color: 'var(--text-dim)', fontSize: 13, mb: 2.5 }}>
                            {friendName} will see it in their notifications.
                        </Typography>
                        <Button
                            fullWidth
                            variant="outlined"
                            onClick={onClose}
                            sx={{ textTransform: 'none', fontWeight: 600 }}
                        >
                            Close
                        </Button>
                    </Box>
                ) : (
                    <>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                            <Box sx={{ display: 'flex', color: 'var(--accent)' }}>
                                <Swords size={16} />
                            </Box>
                            <Typography sx={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 18 }}>
                                Challenge {friendName}
                            </Typography>
                        </Box>
                        <Typography sx={{ color: 'var(--text-dim)', fontSize: 13, mb: 2.5 }}>
                            Sends a game request straight to their inbox.
                        </Typography>

                        <FieldLabel>Time control</FieldLabel>
                        <ToggleButtonGroup
                            exclusive
                            value={pool}
                            onChange={(_, v) => v && setPool(v as string)}
                            sx={presetSx}
                        >
                            {POOL_PRESETS.map((p) => (
                                <ToggleButton key={p} value={p}>
                                    {p}
                                </ToggleButton>
                            ))}
                        </ToggleButtonGroup>

                        <FieldLabel sx={{ mt: 2 }}>Play as</FieldLabel>
                        <ToggleButtonGroup
                            exclusive
                            fullWidth
                            value={color}
                            onChange={(_, v) => v && setColor(v as ColorPref)}
                            sx={presetSx}
                        >
                            <ToggleButton value="w">White</ToggleButton>
                            <ToggleButton value="random">Random</ToggleButton>
                            <ToggleButton value="b">Black</ToggleButton>
                        </ToggleButtonGroup>

                        <FieldLabel sx={{ mt: 2 }}>Variant</FieldLabel>
                        <VariantPicker
                            value={variant}
                            onChange={(v) => setVariant(v as ChallengeVariant)}
                            only={['standard', 'chess960', 'duck', 'crazyhouse', 'antichess']}
                            layout="menu"
                        />

                        <Box
                            sx={{
                                mt: 2,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: 1,
                            }}
                        >
                            <Typography sx={{ fontSize: 13.5, fontWeight: 600 }}>Rated</Typography>
                            <Switch
                                checked={rated}
                                onChange={(e) => setRated(e.target.checked)}
                                size="small"
                            />
                        </Box>

                        {error && (
                            <Alert severity="error" variant="outlined" sx={{ mt: 2, fontSize: 13 }}>
                                {error}
                            </Alert>
                        )}

                        <Button
                            variant="contained"
                            fullWidth
                            disabled={sending}
                            onClick={() => void send()}
                            startIcon={sending ? <CircularProgress size={14} color="inherit" /> : undefined}
                            sx={{ mt: 2.5, textTransform: 'none', fontWeight: 600 }}
                        >
                            {sending ? 'Sending…' : 'Send challenge'}
                        </Button>
                    </>
                )}
            </DialogContent>
        </Dialog>
    )
}

function FieldLabel({ children, sx }: { children: string; sx?: object }) {
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
            {children}
        </Typography>
    )
}

const presetSx = {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: 0.75,
    '& .MuiToggleButtonGroup-grouped': {
        border: '1px solid var(--line) !important',
        borderRadius: '10px !important',
        margin: 0,
        color: 'var(--text-dim)',
        fontSize: 13,
        fontWeight: 600,
        textTransform: 'none',
        py: 0.9,
        '&:hover': { borderColor: 'var(--accent-line) !important', color: 'var(--text)' },
        '&.Mui-selected': {
            color: 'var(--on-accent)',
            background: 'var(--accent-grad)',
            borderColor: 'var(--accent) !important',
            '&:hover': { background: 'var(--accent-grad)' },
        },
    },
}
