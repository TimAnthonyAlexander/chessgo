import { useState } from 'react'
import { Alert, Box, Button, CircularProgress, Dialog, DialogContent, TextField, Typography } from '@mui/material'
import { authStore } from '../lib/auth'
import { ApiError } from '../api/client'

type Mode = 'login' | 'signup'

/** Login / signup modal. On success it closes; the auth store + socket identity
 * are updated by the store methods. */
export default function AuthDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [mode, setMode] = useState<Mode>('login')
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
      slotProps={{ paper: { sx: { bgcolor: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 3, minWidth: 360 } } }}
    >
      <DialogContent sx={{ p: 3 }}>
        <Typography sx={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 22, mb: 0.5 }}>
          {mode === 'login' ? 'Log in' : 'Create account'}
        </Typography>
        <Typography sx={{ color: 'var(--text-dim)', fontSize: 13.5, mb: 2.5 }}>
          {mode === 'login' ? 'Play rated games and track your rating.' : 'Free, takes a few seconds.'}
        </Typography>

        <Box component="form" onSubmit={submit} sx={{ display: 'flex', flexDirection: 'column', gap: 1.75 }}>
          {mode === 'signup' && (
            <TextField
              label="Username"
              value={name}
              onChange={(e) => setName(e.target.value)}
              size="small"
              required
              autoFocus
              fullWidth
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
            startIcon={busy ? <CircularProgress size={15} color="inherit" /> : undefined}
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
            {mode === 'login' ? "No account? Sign up" : 'Have an account? Log in'}
          </Button>
        </Box>
      </DialogContent>
    </Dialog>
  )
}
