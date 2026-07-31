import { useState } from 'react'
import {
    Box,
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    MenuItem,
    TextField,
    Typography,
} from '@mui/material'
import { ApiError, updateMyProfile, type ProfileUpdateResult } from '../../api/client'
import { COUNTRY_NAMES, OUTCOME_STYLE } from './shared'

const BIO_MAX = 300

// Sorted once at module load — the country select's option order never changes.
const COUNTRY_OPTIONS = Object.entries(COUNTRY_NAMES).sort((a, b) => a[1].localeCompare(b[1]))

/** Self-editable profile fields: bio (with a character counter) + country.
 * `title` is never offered here — it's staff-assigned. Calls POST /me/profile
 * and hands the result back to the caller to merge into the displayed profile. */
export default function EditProfileDialog({
    open,
    onClose,
    initialBio,
    initialCountry,
    onSaved,
}: {
    open: boolean
    onClose: () => void
    initialBio: string | null
    initialCountry: string | null
    onSaved: (result: ProfileUpdateResult) => void
}) {
    const [bio, setBio] = useState(initialBio ?? '')
    const [country, setCountry] = useState(initialCountry ?? '')
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const handleSave = () => {
        setSaving(true)
        setError(null)
        updateMyProfile({ bio: bio.trim() || null, country: country || null })
            .then((result) => {
                onSaved(result)
                onClose()
            })
            .catch((e) => {
                setError(e instanceof ApiError ? e.message : 'Could not save your profile')
            })
            .finally(() => setSaving(false))
    }

    return (
        <Dialog open={open} onClose={saving ? undefined : onClose} maxWidth="xs" fullWidth>
            <DialogTitle sx={{ fontSize: 17, fontWeight: 700 }}>Edit profile</DialogTitle>
            <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '4px !important' }}>
                <Box>
                    <TextField
                        label="Bio"
                        multiline
                        minRows={3}
                        maxRows={6}
                        fullWidth
                        value={bio}
                        onChange={(e) => setBio(e.target.value.slice(0, BIO_MAX))}
                        placeholder="Say something about yourself"
                    />
                    <Typography
                        sx={{
                            fontSize: 11,
                            color: bio.length >= BIO_MAX ? OUTCOME_STYLE.loss.color : 'var(--muted)',
                            textAlign: 'right',
                            mt: 0.5,
                        }}
                    >
                        {bio.length}/{BIO_MAX}
                    </Typography>
                </Box>

                <TextField
                    select
                    label="Country"
                    fullWidth
                    value={country}
                    onChange={(e) => setCountry(e.target.value)}
                    slotProps={{ select: { displayEmpty: true } }}
                >
                    <MenuItem value="">
                        <em>None</em>
                    </MenuItem>
                    {COUNTRY_OPTIONS.map(([code, name]) => (
                        <MenuItem key={code} value={code}>
                            {name}
                        </MenuItem>
                    ))}
                </TextField>

                {error && (
                    <Typography sx={{ fontSize: 12.5, color: OUTCOME_STYLE.loss.color }}>
                        {error}
                    </Typography>
                )}
            </DialogContent>
            <DialogActions sx={{ px: 3, pb: 2 }}>
                <Button onClick={onClose} disabled={saving}>
                    Cancel
                </Button>
                <Button onClick={handleSave} disabled={saving} variant="contained">
                    Save
                </Button>
            </DialogActions>
        </Dialog>
    )
}
