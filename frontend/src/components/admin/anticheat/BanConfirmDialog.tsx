import {
    Box,
    Button,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    Typography,
} from '@mui/material'
import { Ban } from 'lucide-react'

/** A confirmation gate for the irreversible-feeling ban action. Banning sets the
 * account's verdict to `banned` AND deactivates the login, so it's kept behind an
 * explicit confirm with the account name spelled out. */
export default function BanConfirmDialog({
    open,
    userName,
    busy,
    onConfirm,
    onCancel,
}: {
    open: boolean
    userName: string
    busy: boolean
    onConfirm: () => void
    onCancel: () => void
}) {
    return (
        <Dialog
            open={open}
            onClose={busy ? undefined : onCancel}
            slotProps={{
                paper: {
                    sx: {
                        bgcolor: 'var(--surface)',
                        border: '1px solid var(--line)',
                        borderRadius: 'var(--radius)',
                        maxWidth: 420,
                    },
                },
            }}
        >
            <DialogContent sx={{ pt: 3 }}>
                <Box
                    sx={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 1,
                        color: '#ca4a4a',
                        mb: 1.25,
                    }}
                >
                    <Ban size={20} />
                    <Typography
                        sx={{
                            fontFamily: 'var(--font-display)',
                            fontSize: 19,
                            fontWeight: 700,
                            color: 'var(--text)',
                        }}
                    >
                        Ban this account?
                    </Typography>
                </Box>
                <Typography sx={{ fontSize: 13.5, color: 'var(--text-dim)', lineHeight: 1.6 }}>
                    This sets{' '}
                    <Box component="span" sx={{ color: 'var(--text)', fontWeight: 700 }}>
                        {userName}
                    </Box>{' '}
                    to the <b>banned</b> verdict and deactivates the account — they will be signed
                    out and unable to log back in. You can reinstate them later from this page.
                </Typography>
            </DialogContent>
            <DialogActions sx={{ px: 3, pb: 2.5, gap: 1 }}>
                <Button
                    onClick={onCancel}
                    disabled={busy}
                    sx={{
                        textTransform: 'none',
                        color: 'var(--text-dim)',
                        fontWeight: 600,
                        '&:hover': { bgcolor: 'rgba(255,255,255,0.04)' },
                    }}
                >
                    Cancel
                </Button>
                <Button
                    onClick={onConfirm}
                    disabled={busy}
                    startIcon={
                        busy ? <CircularProgress size={15} sx={{ color: '#fff' }} /> : <Ban size={16} />
                    }
                    sx={{
                        textTransform: 'none',
                        fontWeight: 700,
                        bgcolor: '#ca4a4a',
                        color: '#fff',
                        px: 2,
                        '&:hover': { bgcolor: '#b83f3f' },
                        '&.Mui-disabled': { bgcolor: 'rgba(202,74,74,0.5)', color: '#fff' },
                    }}
                >
                    Ban account
                </Button>
            </DialogActions>
        </Dialog>
    )
}
