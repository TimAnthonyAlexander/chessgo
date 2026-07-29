import { Box, Typography } from '@mui/material'
import { Check, X } from 'lucide-react'
import { ActionBtn } from './PanelUI'
import type { PendingMove } from '../lib/useConfirmMove'

/**
 * The `confirmMove` affordance: floats over the board (the parent must be
 * `position: relative`) once a real move is held pending. The move itself is
 * shown on the board via Board's own `arrow` prop (from → to) — this bar is
 * just the Confirm/Cancel action plus an aria-live announcement, since the
 * pending move never touches `fen`/`lastMove` and so never reaches Board's own
 * live region.
 */
export default function PendingMoveBar({
    pending,
    onConfirm,
    onCancel,
}: {
    pending: PendingMove
    onConfirm: () => void
    onCancel: () => void
}) {
    return (
        <Box
            sx={{
                position: 'absolute',
                bottom: 10,
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: 6,
                display: 'flex',
                alignItems: 'center',
                gap: 0.75,
                px: 1.25,
                py: 0.75,
                borderRadius: '10px',
                bgcolor: 'rgba(0,0,0,0.74)',
                border: '1px solid var(--accent-line)',
                boxShadow: '0 10px 34px -12px rgba(0,0,0,0.75)',
            }}
        >
            <Typography
                sx={{ fontSize: 12.5, color: 'var(--text)', fontFamily: 'var(--font-mono)' }}
            >
                {pending.from}–{pending.to}
            </Typography>
            <ActionBtn tone="primary" icon={<Check size={14} />} label="Confirm" onClick={onConfirm} />
            <ActionBtn tone="neutral" icon={<X size={14} />} label="Cancel" onClick={onCancel} />
            <Box className="sr-only" aria-live="polite" aria-atomic="true">
                {`Move ${pending.from} to ${pending.to} needs confirmation. Press Enter to confirm, Escape to cancel.`}
            </Box>
        </Box>
    )
}
