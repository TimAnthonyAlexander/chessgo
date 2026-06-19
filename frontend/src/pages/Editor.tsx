import { useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Box, ToggleButton, ToggleButtonGroup, Tooltip, Typography } from '@mui/material'
import { Bot, Check, Copy, Eraser, FlipVertical2, Microscope, RotateCcw } from 'lucide-react'
import BoardEditor, { type Brush, EditorPalette } from '../components/BoardEditor'
import { ActionBtn } from '../components/PanelUI'
import type { Color } from '../api/client'
import { parseFen } from '../lib/chess'
import {
  type Active,
  START_FEN,
  activeOf,
  castlingAvailability,
  castlingOf,
  validateSetup,
  withActive,
  withCastling,
  withClearedBoard,
} from '../lib/fenEdit'

const CASTLE_RIGHTS: { code: string; label: string }[] = [
  { code: 'K', label: 'White O-O' },
  { code: 'Q', label: 'White O-O-O' },
  { code: 'k', label: 'Black O-O' },
  { code: 'q', label: 'Black O-O-O' },
]

export default function Editor() {
  const navigate = useNavigate()
  // Seeded from the analysis board ("Edit this board") or starts from scratch.
  const navFen = (useLocation().state as { fen?: string } | null)?.fen ?? null
  const [fen, setFen] = useState<string>(navFen || START_FEN)
  const [orientation, setOrientation] = useState<Color>('w')
  const [brush, setBrush] = useState<Brush>(null)
  const [copied, setCopied] = useState(false)

  const active = activeOf(fen)
  const castling = castlingOf(fen)
  const avail = useMemo(() => castlingAvailability(parseFen(fen)), [fen])
  const valid = useMemo(() => validateSetup(fen), [fen])

  const setActive = (a: Active) => setFen(withActive(fen, a))
  const toggleCastle = (code: string) => {
    const has = castling.includes(code)
    const next = has ? castling.replace(code, '') : castling + code
    setFen(withCastling(fen, next))
  }

  const copyFen = async () => {
    try {
      await navigator.clipboard.writeText(fen)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {
      /* clipboard blocked — no-op */
    }
  }

  const analyse = () => navigate('/analysis', { state: { startFen: fen } })
  const playBot = () => navigate('/bot', { state: { fen } })

  return (
    <Box
      sx={{
        flex: 1,
        display: 'flex',
        justifyContent: 'center',
        alignItems: { xs: 'flex-start', md: 'center' },
        px: { xs: 1.5, md: 3 },
        py: { xs: 2, md: 2 },
      }}
    >
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: {
            xs: '1fr',
            md: '320px min(calc(100vh - 120px), calc(100vw - 752px), 880px) 320px',
          },
          columnGap: { md: 4 },
          rowGap: 2,
          alignItems: { xs: 'start', md: 'center' },
          justifyContent: 'center',
          width: { xs: '100%', md: 'fit-content' },
          maxWidth: '100%',
          mx: 'auto',
        }}
      >
        {/* Left — spare-piece palette + how-to (mirrors the right panel so the
            board stays centered). */}
        <Box
          sx={{
            alignSelf: 'start',
            width: '100%',
            maxWidth: { xs: 'min(94vw, 64vh)', md: 'none' },
            mx: { xs: 'auto', md: 0 },
          }}
        >
          <PaletteCard brush={brush} onPick={setBrush} />
        </Box>

        {/* Center — the editor board. */}
        <Box sx={{ minWidth: 0, width: { xs: 'min(94vw, 64vh)', md: '100%' }, mx: 'auto' }}>
          <BoardEditor fen={fen} orientation={orientation} brush={brush} onChange={setFen} />
        </Box>

        {/* Right — controls + actions. */}
        <Box
          sx={{
            justifySelf: { md: 'start' },
            alignSelf: 'start',
            width: '100%',
            maxWidth: { xs: 'min(94vw, 64vh)', md: 'none' },
            mx: { xs: 'auto', md: 0 },
            border: '1px solid var(--line-soft)',
            borderRadius: '14px',
            bgcolor: 'var(--surface)',
            overflow: 'hidden',
            boxShadow: '0 18px 50px -28px rgba(0,0,0,0.8)',
          }}
        >
          <PanelHeader />

          <Box sx={{ p: 1.75, display: 'flex', flexDirection: 'column', gap: 1.75 }}>
            {/* Side to move */}
            <Box>
              <Label>Side to move</Label>
              <ToggleButtonGroup
                exclusive
                fullWidth
                size="small"
                value={active}
                onChange={(_, v) => v && setActive(v as Active)}
                sx={toggleSx}
              >
                <ToggleButton value="w">White</ToggleButton>
                <ToggleButton value="b">Black</ToggleButton>
              </ToggleButtonGroup>
            </Box>

            {/* Castling rights — only the structurally-possible ones are enabled. */}
            <Box>
              <Label>Castling</Label>
              <Box sx={{ display: 'flex', gap: 0.75, mt: 1 }}>
                {CASTLE_RIGHTS.map(({ code, label }) => (
                  <CastleChip
                    key={code}
                    label={code}
                    title={label}
                    on={castling.includes(code)}
                    disabled={!avail[code]}
                    onClick={() => toggleCastle(code)}
                  />
                ))}
              </Box>
            </Box>

            {/* Tools */}
            <Box sx={{ display: 'flex', gap: 1 }}>
              <ToolBtn icon={<RotateCcw size={15} />} label="Start position" onClick={() => setFen(START_FEN)} />
              <ToolBtn icon={<Eraser size={15} />} label="Clear board" onClick={() => setFen(withClearedBoard(fen))} />
              <ToolBtn
                icon={<FlipVertical2 size={15} />}
                label="Flip"
                onClick={() => setOrientation((o) => (o === 'w' ? 'b' : 'w'))}
              />
            </Box>

            {/* FEN readout */}
            <Box>
              <Label>FEN</Label>
              <Box sx={{ display: 'flex', alignItems: 'stretch', gap: 1, mt: 0.75 }}>
                <Box
                  sx={{
                    flex: 1,
                    minWidth: 0,
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11.5,
                    color: 'var(--text-dim)',
                    bgcolor: 'var(--bg)',
                    border: '1px solid var(--line-soft)',
                    borderRadius: '8px',
                    px: 1.25,
                    py: 0.85,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {fen}
                </Box>
                <Tooltip title={copied ? 'Copied!' : 'Copy FEN'} arrow>
                  <Box
                    component="button"
                    onClick={copyFen}
                    aria-label="Copy FEN"
                    sx={{
                      flexShrink: 0,
                      width: 40,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                      color: copied ? 'var(--accent)' : 'var(--text-dim)',
                      bgcolor: 'var(--surface-2)',
                      border: '1px solid var(--line)',
                      borderRadius: '8px',
                      transition: 'color .15s, background-color .15s',
                      '&:hover': { color: 'var(--accent)', bgcolor: 'var(--line)' },
                    }}
                  >
                    {copied ? <Check size={16} /> : <Copy size={15} />}
                  </Box>
                </Tooltip>
              </Box>
            </Box>

            {/* Validity hint */}
            <Typography
              sx={{
                fontSize: 12.5,
                color: valid.ok ? 'var(--muted)' : '#ca4a4a',
                minHeight: 18,
              }}
            >
              {valid.ok ? 'Legal position — ready to use.' : valid.reason}
            </Typography>

            {/* Actions */}
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <ActionBtn
                tone="primary"
                icon={<Microscope size={16} />}
                label="Analyse this position"
                onClick={analyse}
                disabled={!valid.ok}
              />
              <ActionBtn
                tone="neutral"
                icon={<Bot size={16} />}
                label="Play a bot from here"
                onClick={playBot}
                disabled={!valid.ok}
              />
            </Box>
          </Box>
        </Box>
      </Box>
    </Box>
  )
}

function PanelHeader() {
  return (
    <Box
      sx={{
        px: 1.75,
        py: 1.5,
        bgcolor: 'var(--bg-2)',
        borderBottom: '1px solid var(--line-soft)',
      }}
    >
      <Typography sx={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16 }}>Board editor</Typography>
      <Typography sx={{ fontSize: 12.5, color: 'var(--text-dim)', mt: 0.25 }}>
        Set up any position, then analyse it or play it out.
      </Typography>
    </Box>
  )
}

function PaletteCard({ brush, onPick }: { brush: Brush; onPick: (b: Brush) => void }) {
  return (
    <Box
      sx={{
        border: '1px solid var(--line-soft)',
        borderRadius: '12px',
        bgcolor: 'var(--surface)',
        overflow: 'hidden',
        boxShadow: '0 18px 50px -28px rgba(0,0,0,0.8)',
      }}
    >
      <Typography
        sx={{
          fontFamily: 'var(--font-display)',
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: 1.8,
          textTransform: 'uppercase',
          color: 'var(--text-dim)',
          px: 1.75,
          py: 1.25,
          borderBottom: '1px solid var(--line-soft)',
          bgcolor: 'var(--bg-2)',
        }}
      >
        Pieces
      </Typography>
      <Box sx={{ p: 1.75 }}>
        <EditorPalette brush={brush} onPick={onPick} />
        <Box sx={{ height: '1px', bgcolor: 'var(--line-soft)', my: 1.5 }} />
        {[
          'Click a piece, then click squares to place it.',
          'Drag-paint to fill; the pointer tool drags pieces.',
          'Right-click a square to clear it.',
        ].map((t, i) => (
          <Typography key={i} sx={{ fontSize: 12, color: 'var(--muted)', mb: 0.5, lineHeight: 1.45 }}>
            • {t}
          </Typography>
        ))}
      </Box>
    </Box>
  )
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <Typography
      sx={{
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        letterSpacing: '0.16em',
        textTransform: 'uppercase',
        color: 'var(--muted)',
        mb: 0.5,
      }}
    >
      {children}
    </Typography>
  )
}

function CastleChip({
  label,
  title,
  on,
  disabled,
  onClick,
}: {
  label: string
  title: string
  on: boolean
  disabled: boolean
  onClick: () => void
}) {
  return (
    <Tooltip title={disabled ? `${title} — pieces not on home squares` : title} arrow>
      <Box component="span" sx={{ flex: 1, display: 'flex' }}>
        <Box
          component="button"
          onClick={onClick}
          disabled={disabled}
          sx={{
            flex: 1,
            height: 38,
            fontFamily: 'var(--font-mono)',
            fontSize: 15,
            fontWeight: 700,
            cursor: disabled ? 'default' : 'pointer',
            color: disabled ? 'var(--muted)' : on ? '#15171c' : 'var(--text-dim)',
            background: on && !disabled ? 'linear-gradient(180deg, #e3b56a, #d8a657)' : 'var(--surface-2)',
            border: `1px solid ${on && !disabled ? 'var(--accent)' : 'var(--line)'}`,
            borderRadius: '9px',
            opacity: disabled ? 0.45 : 1,
            transition: 'color .15s, background .15s, border-color .15s',
            '&:hover': disabled ? {} : { borderColor: 'var(--accent-line)' },
            '&:active': disabled ? {} : { transform: 'translateY(1px)' },
          }}
        >
          {label}
        </Box>
      </Box>
    </Tooltip>
  )
}

function ToolBtn({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <Box
      component="button"
      onClick={onClick}
      sx={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 0.4,
        height: 52,
        cursor: 'pointer',
        fontFamily: 'var(--font-display)',
        fontSize: 11.5,
        fontWeight: 600,
        color: 'var(--text)',
        bgcolor: 'var(--surface-2)',
        border: '1px solid var(--line)',
        borderRadius: '9px',
        transition: 'color .15s, background-color .15s, border-color .15s, transform .05s',
        '&:hover': { color: 'var(--accent)', bgcolor: 'var(--line)', borderColor: 'var(--accent-line)' },
        '&:active': { transform: 'translateY(1px)' },
      }}
    >
      {icon}
      {label}
    </Box>
  )
}

const toggleSx = {
  mt: 1,
  gap: 0.75,
  '& .MuiToggleButton-root': {
    color: 'var(--text-dim)',
    border: '1px solid var(--line)',
    borderRadius: '10px !important',
    textTransform: 'none',
    fontFamily: 'var(--font-display)',
    fontWeight: 600,
    fontSize: 13.5,
    py: 0.7,
    transition: 'color .15s, background .15s, border-color .15s',
    '&:hover': { background: 'var(--line)', color: 'var(--accent)' },
    '&.Mui-selected': {
      color: '#15171c',
      background: 'linear-gradient(180deg, #e3b56a, #d8a657)',
      borderColor: 'var(--accent)',
      '&:hover': { background: 'linear-gradient(180deg, #e7bd76, #dcab5d)' },
    },
  },
}
