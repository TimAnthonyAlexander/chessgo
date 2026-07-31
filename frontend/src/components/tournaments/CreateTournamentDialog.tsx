import { useState } from 'react'
import {
    Box,
    Button,
    Dialog,
    DialogContent,
    DialogTitle,
    MenuItem,
    Switch,
    TextField,
    Typography,
} from '@mui/material'
import {
    ApiError,
    createTournament,
    type TournamentSummary,
    type TournamentVariant,
} from '../../api/client'

const VARIANTS: { value: TournamentVariant; label: string }[] = [
    { value: 'standard', label: 'Standard' },
    { value: 'chess960', label: 'Chess960' },
    { value: 'duck', label: 'Duck Chess' },
    { value: 'crazyhouse', label: 'Crazyhouse' },
    { value: 'antichess', label: 'Antichess' },
]

const POOL_PRESETS = ['1+0', '3+0', '3+2', '5+0', '10+0', '15+10']

/** Admin-only creation form for an arena tournament (POST /tournaments). The
 * `<input type="datetime-local">` value is the admin's own wall-clock time
 * with no timezone attached — `new Date(...)` interprets that in the
 * browser's own zone, and `.toISOString()` turns it into the unambiguous UTC
 * instant the server's `strtotime` wants. */
export default function CreateTournamentDialog({
    open,
    onClose,
    onCreated,
}: {
    open: boolean
    onClose: () => void
    onCreated: (t: TournamentSummary) => void
}) {
    const [name, setName] = useState('')
    const [variant, setVariant] = useState<TournamentVariant>('standard')
    const [pool, setPool] = useState('3+0')
    const [startsAt, setStartsAt] = useState('')
    const [duration, setDuration] = useState(30)
    const [rated, setRated] = useState(true)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const reset = () => {
        setName('')
        setVariant('standard')
        setPool('3+0')
        setStartsAt('')
        setDuration(30)
        setRated(true)
        setError(null)
    }

    const close = () => {
        if (busy) return
        reset()
        onClose()
    }

    const submit = async () => {
        const trimmed = name.trim()
        if (!trimmed || !startsAt) return
        setBusy(true)
        setError(null)
        try {
            const t = await createTournament({
                name: trimmed,
                variant,
                pool,
                starts_at: new Date(startsAt).toISOString(),
                duration_minutes: duration,
                rated,
            })
            reset()
            onCreated(t)
        } catch (e) {
            setError(e instanceof ApiError ? e.message : 'Could not create the tournament.')
        } finally {
            setBusy(false)
        }
    }

    return (
        <Dialog open={open} onClose={close} fullWidth maxWidth="xs">
            <DialogTitle sx={{ fontFamily: 'var(--font-display)', fontWeight: 700 }}>
                New tournament
            </DialogTitle>
            <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
                <TextField
                    label="Name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    size="small"
                    fullWidth
                    autoFocus
                />
                <TextField
                    select
                    label="Variant"
                    value={variant}
                    onChange={(e) => setVariant(e.target.value as TournamentVariant)}
                    size="small"
                    fullWidth
                >
                    {VARIANTS.map((v) => (
                        <MenuItem key={v.value} value={v.value}>
                            {v.label}
                        </MenuItem>
                    ))}
                </TextField>
                <Box>
                    <TextField
                        label="Time control (min+inc)"
                        value={pool}
                        onChange={(e) => setPool(e.target.value)}
                        size="small"
                        fullWidth
                        placeholder="3+0"
                    />
                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mt: 0.75 }}>
                        {POOL_PRESETS.map((p) => (
                            <Box
                                key={p}
                                component="button"
                                onClick={() => setPool(p)}
                                sx={{
                                    px: 1,
                                    py: 0.4,
                                    fontSize: 12,
                                    fontFamily: 'var(--font-mono)',
                                    borderRadius: '7px',
                                    border: '1px solid',
                                    borderColor: pool === p ? 'var(--accent-line)' : 'var(--line)',
                                    bgcolor: pool === p ? 'var(--accent-soft)' : 'transparent',
                                    color: pool === p ? 'var(--accent)' : 'var(--text-dim)',
                                    cursor: 'pointer',
                                }}
                            >
                                {p}
                            </Box>
                        ))}
                    </Box>
                </Box>
                <TextField
                    label="Starts at"
                    type="datetime-local"
                    value={startsAt}
                    onChange={(e) => setStartsAt(e.target.value)}
                    size="small"
                    fullWidth
                    InputLabelProps={{ shrink: true }}
                />
                <TextField
                    label="Duration (minutes)"
                    type="number"
                    value={duration}
                    onChange={(e) =>
                        setDuration(Math.max(1, Math.min(1440, Number(e.target.value) || 0)))
                    }
                    size="small"
                    fullWidth
                />
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Typography sx={{ fontSize: 14 }}>Rated</Typography>
                    <Switch checked={rated} onChange={(e) => setRated(e.target.checked)} />
                </Box>
                {error && <Typography sx={{ fontSize: 13, color: '#e6a3a3' }}>{error}</Typography>}
                <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end', mt: 1 }}>
                    <Button
                        onClick={close}
                        disabled={busy}
                        sx={{ textTransform: 'none', color: 'var(--text-dim)' }}
                    >
                        Cancel
                    </Button>
                    <Button
                        onClick={submit}
                        disabled={busy || !name.trim() || !startsAt}
                        variant="contained"
                        sx={{ textTransform: 'none', fontWeight: 600 }}
                    >
                        Create
                    </Button>
                </Box>
            </DialogContent>
        </Dialog>
    )
}
