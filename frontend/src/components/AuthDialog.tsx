import { useEffect, useState } from 'react'
import {
    Alert,
    Box,
    Button,
    CircularProgress,
    Dialog,
    DialogContent,
    TextField,
    Typography,
} from '@mui/material'
import { authStore } from '../lib/auth'
import { ApiError } from '../api/client'

export type AuthMode = 'login' | 'signup'

/** Login / signup modal. On success it closes; the auth store + socket identity
 * are updated by the store methods. `initialMode` picks which tab opens (a
 * "Create account" CTA opens straight to signup). */
export default function AuthDialog({
    open,
    onClose,
    initialMode = 'login',
}: {
    open: boolean
    onClose: () => void
    initialMode?: AuthMode
}) {
    const [mode, setMode] = useState<AuthMode>(initialMode)

    // Re-sync the tab each time the dialog is (re)opened, so the caller's
    // requested mode wins over whatever it was left on last time.
    useEffect(() => {
        if (open) setMode(initialMode)
    }, [open, initialMode])
    const [name, setName] = useState('')
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const reset = () => {
        setName('')
        setEmail('')
        setPassword('')
        setError(null)
        setBusy(false)
    }

    const close = () => {
        reset()
        onClose()
    }

    async function submit(e: React.FormEvent) {
        e.preventDefault()
        setError(null)
        setBusy(true)
        try {
            if (mode === 'signup') await authStore.signup(name.trim(), email.trim(), password)
            else await authStore.login(email.trim(), password)
            close()
        } catch (err) {
            setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.')
            setBusy(false)
        }
    }

    return (
        <Dialog
            open={open}
            onClose={close}
            aria-labelledby="auth-dialog-title"
            slotProps={{
                paper: {
                    sx: {
                        bgcolor: 'var(--surface)',
                        border: '1px solid var(--line)',
                        borderRadius: 'var(--radius)',
                        minWidth: 360,
                    },
                },
            }}
        >
            <DialogContent sx={{ p: 3 }}>
                <Typography
                    id="auth-dialog-title"
                    component="h2"
                    sx={{
                        fontFamily: 'var(--font-display)',
                        fontWeight: 600,
                        fontSize: 22,
                        mb: 0.5,
                    }}
                >
                    {mode === 'login' ? 'Log in' : 'Create account'}
                </Typography>
                <Typography sx={{ color: 'var(--text-dim)', fontSize: 13.5, mb: 2.5 }}>
                    {mode === 'login'
                        ? 'Play rated games and track your rating.'
                        : 'Free, takes a few seconds.'}
                </Typography>

                <Box
                    component="form"
                    onSubmit={submit}
                    sx={{ display: 'flex', flexDirection: 'column', gap: 1.75 }}
                >
                    {mode === 'signup' && (
                        <TextField
                            label="Username"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            size="small"
                            required
                            autoFocus
                            fullWidth
                            // ≥16px input font on phones so iOS Safari doesn't auto-zoom on focus.
                            sx={{ '& .MuiInputBase-input': { fontSize: { xs: 16 } } }}
                        />
                    )}
                    <TextField
                        label="Email"
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        size="small"
                        required
                        autoFocus={mode === 'login'}
                        fullWidth
                        sx={{ '& .MuiInputBase-input': { fontSize: { xs: 16 } } }}
                    />
                    <TextField
                        label="Password"
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        size="small"
                        required
                        fullWidth
                        helperText={mode === 'signup' ? 'At least 8 characters.' : undefined}
                        sx={{ '& .MuiInputBase-input': { fontSize: { xs: 16 } } }}
                    />

                    {error && (
                        <Alert severity="error" variant="outlined" sx={{ fontSize: 13 }}>
                            {error}
                        </Alert>
                    )}

                    <Button
                        type="submit"
                        variant="contained"
                        disabled={busy}
                        startIcon={
                            busy ? <CircularProgress size={15} color="inherit" /> : undefined
                        }
                        sx={{ mt: 0.5 }}
                    >
                        {mode === 'login' ? 'Log in' : 'Create account'}
                    </Button>
                </Box>

                <Box sx={{ mt: 2, textAlign: 'center' }}>
                    <Button
                        color="inherit"
                        size="small"
                        onClick={() => {
                            setMode(mode === 'login' ? 'signup' : 'login')
                            setError(null)
                        }}
                        sx={{ color: 'var(--text-dim)', textTransform: 'none', fontSize: 13 }}
                    >
                        {mode === 'login' ? 'No account? Sign up' : 'Have an account? Log in'}
                    </Button>
                </Box>
            </DialogContent>
        </Dialog>
    )
}
