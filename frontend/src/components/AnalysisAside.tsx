import { useMemo, useState } from 'react'
import { Box, Tooltip, Typography } from '@mui/material'
import { Bot, Check, Copy, Dices, FileInput, RotateCcw } from 'lucide-react'
import { Chess } from 'chess.js'
import { START_FEN } from '../lib/analysisTree'

// Standard piece values + starting counts, used to derive captured material from a
// bare FEN (an approximation when pawns have promoted, like most board UIs).
const VALUE: Record<string, number> = { P: 1, N: 3, B: 3, R: 5, Q: 9 }
const START_COUNT: Record<string, number> = { P: 8, N: 2, B: 2, R: 2, Q: 1 }
const ORDER = ['Q', 'R', 'B', 'N', 'P'] as const

interface Material {
  capturedByWhite: string[] // black pieces removed from the board
  capturedByBlack: string[] // white pieces removed from the board
  diff: number // White material minus Black material
}

function computeMaterial(fen: string): Material {
  const board = fen.split(' ')[0]
  const w: Record<string, number> = {}
  const b: Record<string, number> = {}
  for (const ch of board) {
    if (!/[pnbrq]/i.test(ch)) continue
    const t = ch.toUpperCase()
    if (ch === t) w[t] = (w[t] ?? 0) + 1
    else b[t] = (b[t] ?? 0) + 1
  }
  const capturedByWhite: string[] = []
  const capturedByBlack: string[] = []
  let whiteVal = 0
  let blackVal = 0
  for (const t of ORDER) {
    whiteVal += (w[t] ?? 0) * VALUE[t]
    blackVal += (b[t] ?? 0) * VALUE[t]
    for (let i = 0; i < START_COUNT[t] - (b[t] ?? 0); i++) capturedByWhite.push(t)
    for (let i = 0; i < START_COUNT[t] - (w[t] ?? 0); i++) capturedByBlack.push(t)
  }
  return { capturedByWhite, capturedByBlack, diff: whiteVal - blackVal }
}

// A random Chess960 (Fischer Random) start position. Castling is left disabled
// ("-") so the position always loads cleanly in chess.js and movegen stays exact.
function random960(): string {
  const rank: (string | null)[] = Array(8).fill(null)
  const pickFrom = (cells: number[]) => cells[Math.floor(Math.random() * cells.length)]
  // Bishops on opposite-colored squares.
  rank[pickFrom([1, 3, 5, 7])] = 'B'
  rank[pickFrom([0, 2, 4, 6])] = 'B'
  const empties = () => rank.map((p, i) => (p === null ? i : -1)).filter((i) => i >= 0)
  rank[pickFrom(empties())] = 'Q'
  rank[pickFrom(empties())] = 'N'
  rank[pickFrom(empties())] = 'N'
  // Remaining three squares get rook, king, rook (king always between the rooks).
  const [r1, k, r2] = empties()
  rank[r1] = 'R'
  rank[k] = 'K'
  rank[r2] = 'R'
  const white = rank.join('')
  const black = white.toLowerCase()
  return `${black}/pppppppp/8/8/8/8/PPPPPPPP/${white} w - - 0 1`
}

// Returns the FEN if chess.js accepts it, else null.
function validFen(fen: string): string | null {
  try {
    new Chess(fen.trim())
    return fen.trim()
  } catch {
    return null
  }
}

export default function AnalysisAside({
  fen,
  onLoadFen,
  onPlayBot,
  playBotDisabled = false,
  showSetup = true,
}: {
  fen: string
  onLoadFen: (fen: string) => void
  onPlayBot: () => void
  playBotDisabled?: boolean
  showSetup?: boolean
}) {
  const mat = useMemo(() => computeMaterial(fen), [fen])

  return (
    <Box
      sx={{
        display: { xs: 'none', md: 'flex' },
        flexDirection: 'column',
        gap: 2,
        alignSelf: 'start',
        width: '100%',
      }}
    >
      <MaterialCard mat={mat} />
      {showSetup && <PositionCard fen={fen} onLoadFen={onLoadFen} />}
      <PlayBotButton onClick={onPlayBot} disabled={playBotDisabled} />
    </Box>
  )
}

// Take the position currently on the board into a fresh game against the engine
// (the BotGame setup then asks which side to play). Available in both free
// analysis and game review.
function PlayBotButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <Box
      component="button"
      onClick={onClick}
      disabled={disabled}
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 0.9,
        width: '100%',
        height: 46,
        cursor: disabled ? 'default' : 'pointer',
        fontFamily: 'var(--font-display)',
        fontSize: 14,
        fontWeight: 700,
        letterSpacing: 0.2,
        color: disabled ? 'var(--muted)' : '#15171c',
        background: disabled ? 'var(--surface-2)' : 'linear-gradient(180deg, #e3b56a, #d8a657)',
        border: `1px solid ${disabled ? 'var(--line-soft)' : 'var(--accent)'}`,
        borderRadius: '12px',
        boxShadow: disabled ? 'none' : '0 0 16px -6px rgba(216,166,87,0.6)',
        opacity: disabled ? 0.6 : 1,
        transition: 'background .15s, transform .05s, box-shadow .2s',
        '&:hover': disabled
          ? {}
          : { background: 'linear-gradient(180deg, #e7bd76, #dcab5d)', boxShadow: '0 0 20px -5px rgba(216,166,87,0.75)' },
        '&:active': disabled ? {} : { transform: 'translateY(1px)' },
      }}
    >
      <Bot size={17} />
      Play bot from here
    </Box>
  )
}

function Card({ label, children }: { label: string; children: React.ReactNode }) {
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
        {label}
      </Typography>
      <Box sx={{ p: 1.75 }}>{children}</Box>
    </Box>
  )
}

function MaterialCard({ mat }: { mat: Material }) {
  return (
    <Card label="Material">
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        <SideRow label="White" pieces={mat.capturedByWhite} color="b" adv={mat.diff > 0 ? mat.diff : 0} />
        <Box sx={{ height: '1px', bgcolor: 'var(--line-soft)' }} />
        <SideRow label="Black" pieces={mat.capturedByBlack} color="w" adv={mat.diff < 0 ? -mat.diff : 0} />
      </Box>
    </Card>
  )
}

function SideRow({ label, pieces, color, adv }: { label: string; pieces: string[]; color: 'w' | 'b'; adv: number }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minHeight: 26 }}>
      <Typography
        sx={{ width: 44, flexShrink: 0, fontSize: 12.5, fontWeight: 600, letterSpacing: 0.3, color: 'var(--text-dim)' }}
      >
        {label}
      </Typography>
      <Box sx={{ flex: 1, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '1px', minWidth: 0 }}>
        {pieces.length === 0 ? (
          <Typography sx={{ fontSize: 13, color: 'var(--muted)' }}>—</Typography>
        ) : (
          pieces.map((t, i) => (
            <Box
              key={i}
              component="img"
              src={`/piece/cburnett/${color}${t}.svg`}
              alt={t}
              sx={{ width: 20, height: 20, ml: i > 0 && pieces[i - 1] === t ? '-7px' : 0 }}
            />
          ))
        )}
      </Box>
      {adv > 0 && (
        <Typography sx={{ fontFamily: 'var(--font-mono)', fontSize: 13.5, fontWeight: 700, color: 'var(--accent)' }}>
          +{adv}
        </Typography>
      )}
    </Box>
  )
}

function PositionCard({ fen, onLoadFen }: { fen: string; onLoadFen: (fen: string) => void }) {
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteVal, setPasteVal] = useState('')
  const [pasteErr, setPasteErr] = useState(false)
  const [copied, setCopied] = useState(false)

  const submitPaste = () => {
    const ok = validFen(pasteVal)
    if (!ok) {
      setPasteErr(true)
      return
    }
    onLoadFen(ok)
    setPasteOpen(false)
    setPasteVal('')
    setPasteErr(false)
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

  return (
    <Card label="Position">
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <AsideBtn icon={<RotateCcw size={15} />} label="New game" onClick={() => onLoadFen(START_FEN)} />
          <AsideBtn icon={<Dices size={15} />} label="Chess960" onClick={() => onLoadFen(random960())} />
        </Box>
        <AsideBtn
          icon={<FileInput size={15} />}
          label="Paste FEN…"
          active={pasteOpen}
          onClick={() => {
            setPasteOpen((v) => !v)
            setPasteErr(false)
          }}
        />

        {pasteOpen && (
          <Box
            component="input"
            autoFocus
            value={pasteVal}
            placeholder="Paste a FEN, then Enter"
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
              setPasteVal(e.target.value)
              setPasteErr(false)
            }}
            onKeyDown={(e: React.KeyboardEvent) => {
              if (e.key === 'Enter') submitPaste()
              else if (e.key === 'Escape') setPasteOpen(false)
            }}
            sx={{
              width: '100%',
              boxSizing: 'border-box',
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              color: 'var(--text)',
              bgcolor: 'var(--bg)',
              border: `1px solid ${pasteErr ? '#ca4a4a' : 'var(--line)'}`,
              borderRadius: '8px',
              px: 1.25,
              py: 1,
              outline: 'none',
              '&:focus': { borderColor: pasteErr ? '#ca4a4a' : 'var(--accent-line)' },
              '&::placeholder': { color: 'var(--muted)' },
            }}
          />
        )}

        <Box sx={{ height: '1px', bgcolor: 'var(--line-soft)', my: 0.5 }} />

        <Typography sx={{ fontSize: 10.5, letterSpacing: 1.2, textTransform: 'uppercase', color: 'var(--muted)' }}>
          Current FEN
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'stretch', gap: 1 }}>
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
    </Card>
  )
}

function AsideBtn({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  active?: boolean
  onClick: () => void
}) {
  return (
    <Box
      component="button"
      onClick={onClick}
      sx={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 0.75,
        height: 40,
        cursor: 'pointer',
        fontFamily: 'var(--font-display)',
        fontSize: 13.5,
        fontWeight: 600,
        letterSpacing: 0.2,
        color: active ? 'var(--accent)' : 'var(--text)',
        bgcolor: active ? 'var(--accent-soft)' : 'var(--surface-2)',
        border: `1px solid ${active ? 'var(--accent-line)' : 'var(--line)'}`,
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
