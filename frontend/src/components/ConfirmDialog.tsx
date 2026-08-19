import { Box, Button, Dialog, DialogContent, Typography } from '@mui/material'

/**
 * A small confirm/cancel modal for guarding hard-to-undo actions (resign, abort,
 * …). Controlled: render it with `open`, and wire `onConfirm`/`onClose`. Kept
 * intentionally minimal so every call site reads the same. Pair it with the
 * `confirmResign` (and similar) preference — when the preference is off, callers
 * should skip the dialog and act directly.
 */
export default function ConfirmDialog({
    open,
    title,
    message,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    danger = false,
    onConfirm,
    onClose,
}: {
    open: boolean
    title: string
    message?: string
    confirmLabel?: string
    cancelLabel?: string
    /** Style the confirm button as a destructive action. */
    danger?: boolean
    onConfirm: () => void
    onClose: () => void
}) {
    return (
        <Dialog
            open={open}
            onClose={onClose}
            slotProps={{
                paper: {
                    sx: {
                        bgcolor: 'var(--surface)',
                        border: '1px solid var(--line)',
                        borderRadius: 'var(--radius)',
                        width: '90vw',
                        maxWidth: 380,
                    },
                },
            }}
        >
            <DialogContent sx={{ p: 3 }}>
                <Typography
                    sx={{
                        fontFamily: 'var(--font-display)',
                        fontWeight: 600,
                        fontSize: 18,
                        mb: message ? 1 : 2.5,
                    }}
                >
                    {title}
                </Typography>
                {message && (
                    <Typography sx={{ fontSize: 14, color: 'var(--text-dim)', mb: 2.5 }}>
                        {message}
                    </Typography>
                )}
                <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
                    <Button
                        onClick={onClose}
                        sx={{ textTransform: 'none', color: 'var(--text-dim)' }}
                    >
                        {cancelLabel}
                    </Button>
                    <Button
                        variant="contained"
                        color={danger ? 'error' : 'primary'}
                        onClick={() => {
                            onConfirm()
                            onClose()
                        }}
                        sx={{ textTransform: 'none', px: 2.5 }}
                    >
                        {confirmLabel}
                    </Button>
                </Box>
            </DialogContent>
        </Dialog>
    )
}
