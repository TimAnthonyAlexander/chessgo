import { useState } from 'react'
import {
    Box,
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    Slider,
    Typography,
} from '@mui/material'
import { categoryFor, CATEGORY_META } from '../lib/timeControl'

const DEFAULT_BASE = 10
const DEFAULT_INC = 5

export interface CustomTimeDialogProps {
    open: boolean
    onClose: () => void
    onStart: (pool: string) => void // pool is "base+inc", e.g. "7+5" (minutes+seconds)
}

export default function CustomTimeDialog(props: CustomTimeDialogProps): JSX.Element {
    const { open, onClose, onStart } = props
    const [base, setBase] = useState(DEFAULT_BASE)
    const [inc, setInc] = useState(DEFAULT_INC)

    // Reset to defaults each time the dialog re-opens so stale values never leak in.
    const reset = (): void => {
        setBase(DEFAULT_BASE)
        setInc(DEFAULT_INC)
    }

    const handleClose = (): void => {
        onClose()
    }

    const handlePlay = (): void => {
        onStart(`${base}+${inc}`)
        onClose()
    }

    const pool = `${base}+${inc}`
    const cat = categoryFor(pool)
    const meta = CATEGORY_META[cat]
    const Icon = meta.Icon

    return (
        <Dialog
            open={open}
            onClose={handleClose}
            slotProps={{
                transition: { onEnter: reset },
                paper: {
                    sx: {
                        bgcolor: 'var(--surface)',
                        border: '1px solid var(--line)',
                        borderRadius: '16px',
                        minWidth: 360,
                        color: 'var(--text)',
                    },
                },
            }}
        >
            <DialogTitle sx={{ fontFamily: 'var(--font-display)', color: 'var(--text)', pb: 1 }}>
                Custom time control
            </DialogTitle>

            <DialogContent>
                <Box sx={{ px: 0.5, pt: 1 }}>
                    <Typography sx={{ color: 'var(--text-dim)', fontSize: 13, mb: 0.5 }}>
                        Base minutes: <span style={{ color: 'var(--text)' }}>{base}</span>
                    </Typography>
                    <Slider
                        value={base}
                        min={1}
                        max={60}
                        step={1}
                        onChange={(_, v) => setBase(Array.isArray(v) ? v[0] : v)}
                        sx={{ color: 'var(--accent)' }}
                    />
                </Box>

                <Box sx={{ px: 0.5, pt: 1.5 }}>
                    <Typography sx={{ color: 'var(--text-dim)', fontSize: 13, mb: 0.5 }}>
                        Increment seconds: <span style={{ color: 'var(--text)' }}>{inc}</span>
                    </Typography>
                    <Slider
                        value={inc}
                        min={0}
                        max={30}
                        step={1}
                        onChange={(_, v) => setInc(Array.isArray(v) ? v[0] : v)}
                        sx={{ color: 'var(--accent)' }}
                    />
                </Box>

                <Box
                    sx={{
                        mt: 2,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 1.25,
                        p: 1.25,
                        borderRadius: '12px',
                        bgcolor: 'var(--surface-2)',
                        border: '1px solid var(--line-soft)',
                    }}
                >
                    <Icon size={18} color={meta.color} />
                    <Typography
                        sx={{ fontFamily: 'var(--font-mono)', fontSize: 16, color: 'var(--text)' }}
                    >
                        {pool}
                    </Typography>
                    <Typography
                        sx={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: 13,
                            color: meta.color,
                            ml: 'auto',
                        }}
                    >
                        {cat}
                    </Typography>
                </Box>
            </DialogContent>

            <DialogActions sx={{ px: 3, pb: 2.5 }}>
                <Button onClick={handleClose} sx={{ color: 'var(--muted)', textTransform: 'none' }}>
                    Cancel
                </Button>
                <Button
                    onClick={handlePlay}
                    variant="contained"
                    sx={{ textTransform: 'none', fontWeight: 600 }}
                >
                    Play
                </Button>
            </DialogActions>
        </Dialog>
    )
}
