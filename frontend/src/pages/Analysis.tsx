import { useCallback, useEffect, useMemo, useState } from 'react'
import { Box, Button, Typography } from '@mui/material'
import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, FlipVertical2, Play, Square, Target, Zap } from 'lucide-react'
import { useParams } from 'react-router-dom'
import Board from '../components/Board'
import EvalBar, { type WhiteEval } from '../components/EvalBar'
import MoveTree from '../components/MoveTree'
import { analyze, getGameAnalysis, type GameAnalysis } from '../api/client'
import type { Color } from '../api/client'
import {
  type Tree,
  type TreeNode,
  annotateEval,
  buildFromAnalysis,
  createTree,
  gameOverAt,
  legalUci,
  playMove,
  START_FEN,
  turnAt,
} from '../lib/analysisTree'
import { sounds } from '../lib/sounds'

// How long (ms) each auto-played move lingers before the next one.
const AUTO_DELAY = 700

type AutoMode = 'off' | 'play' | 'best'

// Play the appropriate sound for the move that leads INTO a node.
function playMoveSound(node?: TreeNode) {
  const m = node?.move
  if (!m) return
  if (m.san.includes('x')) sounds.capture()
  else if (m.san.startsWith('O-O')) sounds.castle()
  else if (m.uci.length === 5) sounds.promote()
  else sounds.move()
}

export default function Analysis() {
  const { id } = useParams<{ id?: string }>()

  const [tree, setTree] = useState<Tree>(() => createTree(START_FEN))
  const [currentId, setCurrentId] = useState(0)
  const [orientation, setOrientation] = useState<Color>('w')
  const [showArrow, setShowArrow] = useState(true)
  const [game, setGame] = useState<GameAnalysis | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState<boolean>(!!id)
  const [autoMode, setAutoMode] = useState<AutoMode>('off')

  // --- Load a finished game's analysis (review mode) ---
  useEffect(() => {
    setAutoMode('off')
    if (!id) {
      // Free mode: fresh board from the start position.
      setTree(createTree(START_FEN))
      setCurrentId(0)
      setGame(null)
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    setLoadError(null)

    // The hub persists a finished game fire-and-forget, so just after a game ends
    // the record may not exist yet — retry a few times before giving up.
    const attempt = async (tries: number): Promise<void> => {
      try {
        const a = await getGameAnalysis(id)
        if (cancelled) return
        const built = buildFromAnalysis(a.startFen, a.plies)
        setTree(built.tree)
        setCurrentId(built.tree.rootId)
        setGame(a)
        setLoading(false)
      } catch (e) {
        const status = (e as { status?: number }).status
        if (status === 404 && tries > 0 && !cancelled) {
          setTimeout(() => void attempt(tries - 1), 1200)
          return
        }
        if (cancelled) return
        setLoadError((e as Error).message || 'Could not load this game')
        setLoading(false)
      }
    }
    void attempt(5)
    return () => {
      cancelled = true
    }
  }, [id])

  const current = tree.nodes[currentId] ?? tree.nodes[tree.rootId]
  const sideToMove = turnAt(current)
  const over = useMemo(() => gameOverAt(current), [current.fen])
  const legalMoves = useMemo(() => (over.over ? [] : legalUci(current)), [current.fen, over.over])

  // --- Live engine eval for positions we don't already have one for ---
  useEffect(() => {
    if (current.evalWhite !== null) return

    // Terminal positions: derive the eval locally, no engine call.
    if (over.over) {
      let ev: WhiteEval
      if (over.checkmate) ev = { type: 'mate', white: sideToMove === 'w' ? -1 : 1 }
      else ev = { type: 'cp', white: 0 }
      setTree((t) => annotateEval(t, current.id, ev, null))
      return
    }

    let cancelled = false
    analyze(current.fen)
      .then((r) => {
        if (cancelled) return
        if (!r.eval) {
          setTree((t) => annotateEval(t, current.id, { type: 'cp', white: 0 }, r.bestmove))
          return
        }
        const white = sideToMove === 'w' ? r.eval.value : -r.eval.value
        setTree((t) => annotateEval(t, current.id, { type: r.eval!.type, white }, r.bestmove))
      })
      .catch(() => {
        /* leave eval unknown on engine error */
      })
    return () => {
      cancelled = true
    }
  }, [current.id, current.fen, current.evalWhite, over.over, over.checkmate, sideToMove])

  // --- Navigation (manual navigation always cancels any auto playback) ---
  const goPrev = useCallback(() => {
    setAutoMode('off')
    setCurrentId((cur) => tree.nodes[cur]?.parent ?? cur)
  }, [tree])
  const goNext = useCallback(() => {
    setAutoMode('off')
    setCurrentId((cur) => tree.nodes[cur]?.children[0] ?? cur)
  }, [tree])
  const goStart = useCallback(() => {
    setAutoMode('off')
    setCurrentId(tree.rootId)
  }, [tree.rootId])
  const goEnd = useCallback(() => {
    setAutoMode('off')
    setCurrentId((cur) => {
      let n = tree.nodes[cur]
      while (n && n.children.length > 0) n = tree.nodes[n.children[0]]
      return n ? n.id : cur
    })
  }, [tree])
  const selectNode = useCallback((nodeId: number) => {
    setAutoMode('off')
    setCurrentId(nodeId)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') goPrev()
      else if (e.key === 'ArrowRight') goNext()
      else if (e.key === 'ArrowUp') goStart()
      else if (e.key === 'ArrowDown') goEnd()
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goPrev, goNext, goStart, goEnd])

  // --- Making a move (branch-aware) ---
  const onMove = useCallback(
    (uci: string) => {
      const node = tree.nodes[currentId]
      if (!node) return
      const res = playMove(tree, currentId, uci)
      if (res.nodeId === currentId) return // illegal / no-op
      setAutoMode('off') // a manual move ends auto playback
      playMoveSound(res.tree.nodes[res.nodeId])
      setTree(res.tree)
      setCurrentId(res.nodeId)
    },
    [tree, currentId],
  )

  // --- Auto Play: step through the mainline (children[0]) on a timer ---
  useEffect(() => {
    if (autoMode !== 'play') return
    const nextId = tree.nodes[currentId]?.children[0]
    if (nextId === undefined) {
      setAutoMode('off') // reached the end of the line
      return
    }
    const t = setTimeout(() => {
      playMoveSound(tree.nodes[nextId])
      setCurrentId(nextId)
    }, AUTO_DELAY)
    return () => clearTimeout(t)
  }, [autoMode, currentId, tree])

  // --- Auto Best Move: keep playing the engine's best move from here, branching
  // off the existing line when the best move differs from what was played. We
  // lean on the eval effect to populate `bestUci`; when it's not yet known we
  // simply wait (this effect re-runs once it arrives). ---
  useEffect(() => {
    if (autoMode !== 'best') return
    if (over.over) {
      setAutoMode('off') // game over — nothing left to play
      return
    }
    const best = current.bestUci
    if (!best) return // waiting for the engine's best move; re-runs when known
    const t = setTimeout(() => {
      const res = playMove(tree, currentId, best)
      if (res.nodeId === currentId) {
        setAutoMode('off') // defensive: engine returned an unplayable move
        return
      }
      playMoveSound(res.tree.nodes[res.nodeId])
      setTree(res.tree)
      setCurrentId(res.nodeId)
    }, AUTO_DELAY)
    return () => clearTimeout(t)
  }, [autoMode, currentId, current.bestUci, over.over, tree])

  const toggleAuto = useCallback((mode: Exclude<AutoMode, 'off'>) => {
    setAutoMode((m) => (m === mode ? 'off' : mode))
  }, [])

  // Always surface the best-move arrow while Auto Best Move is driving, so the
  // user sees the engine's choice before it's played.
  const arrow =
    (showArrow || autoMode === 'best') && current.bestUci
      ? { from: current.bestUci.slice(0, 2), to: current.bestUci.slice(2, 4) }
      : null

  const lastMove = current.move ? { from: current.move.from, to: current.move.to } : null

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
          // A left spacer column mirrors the 360px sidebar so the BOARD (not the
          // board+sidebar block) is centered in the viewport — same trick as LiveGame.
          gridTemplateColumns: {
            xs: '1fr',
            md: '360px min(calc(100vh - 140px), calc(100vw - 840px), 820px) 360px',
          },
          columnGap: { md: 4 },
          rowGap: 2,
          alignItems: 'center',
          justifyContent: 'center',
          width: { xs: '100%', md: 'fit-content' },
          maxWidth: '100%',
          mx: 'auto',
        }}
      >
        {/* Left spacer (keeps the board centered) */}
        <Box sx={{ display: { xs: 'none', md: 'block' } }} />

        {/* Eval bar + board */}
        <Box sx={{ minWidth: 0, display: 'flex', gap: 1, alignItems: 'stretch' }}>
          <EvalBar ev={current.evalWhite} orientation={orientation} />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Board
              fen={current.fen}
              orientation={orientation}
              sideToMove={sideToMove}
              legalMoves={legalMoves}
              lastMove={lastMove}
              inCheck={over.check}
              interactive
              onMove={onMove}
              arrow={arrow}
            />
          </Box>
        </Box>

        {/* Sidebar */}
        <Box
          sx={{
            width: { xs: '100%', md: '100%' },
            justifySelf: { md: 'start' },
            display: 'flex',
            flexDirection: 'column',
            border: '1px solid var(--line-soft)',
            borderRadius: '6px',
            bgcolor: 'var(--surface)',
            overflow: 'hidden',
            maxHeight: { md: 'min(calc(100vh - 140px), 820px)' },
          }}
        >
          <Header id={id} game={game} loading={loading} loadError={loadError} current={current} />

          <MoveTree tree={tree} currentId={currentId} onSelect={selectNode} />

          {/* Auto playback */}
          <Box sx={{ display: 'flex', gap: 1, px: 1, pt: 1 }}>
            <AutoBtn
              active={autoMode === 'play'}
              onClick={() => toggleAuto('play')}
              icon={autoMode === 'play' ? <Square size={14} /> : <Play size={14} />}
              label={autoMode === 'play' ? 'Stop' : 'Auto Play'}
            />
            <AutoBtn
              active={autoMode === 'best'}
              onClick={() => toggleAuto('best')}
              icon={autoMode === 'best' ? <Square size={14} /> : <Zap size={14} />}
              label={autoMode === 'best' ? 'Stop' : 'Auto Best Move'}
            />
          </Box>

          {/* Controls */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, p: 1, borderTop: '1px solid var(--line-soft)' }}>
            <NavBtn onClick={goStart} label="Start"><ChevronFirst size={18} /></NavBtn>
            <NavBtn onClick={goPrev} label="Previous"><ChevronLeft size={18} /></NavBtn>
            <NavBtn onClick={goNext} label="Next"><ChevronRight size={18} /></NavBtn>
            <NavBtn onClick={goEnd} label="End"><ChevronLast size={18} /></NavBtn>
            <Box sx={{ flex: 1 }} />
            <NavBtn onClick={() => setShowArrow((v) => !v)} label="Best move" active={showArrow}>
              <Target size={17} />
            </NavBtn>
            <NavBtn onClick={() => setOrientation((o) => (o === 'w' ? 'b' : 'w'))} label="Flip board">
              <FlipVertical2 size={17} />
            </NavBtn>
          </Box>
        </Box>
      </Box>
    </Box>
  )
}

function NavBtn({
  onClick,
  label,
  active,
  children,
}: {
  onClick: () => void
  label: string
  active?: boolean
  children: React.ReactNode
}) {
  return (
    <Button
      onClick={onClick}
      aria-label={label}
      sx={{
        minWidth: 0,
        px: 1,
        py: 0.5,
        color: active ? 'var(--accent)' : 'var(--text-dim)',
        '&:hover': { color: 'var(--accent)', bgcolor: 'var(--line)' },
      }}
    >
      {children}
    </Button>
  )
}

function AutoBtn({
  active,
  onClick,
  icon,
  label,
}: {
  active?: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
}) {
  return (
    <Button
      onClick={onClick}
      aria-label={label}
      startIcon={icon}
      sx={{
        flex: 1,
        textTransform: 'none',
        fontSize: 13,
        fontWeight: 600,
        py: 0.5,
        gap: 0.25,
        color: active ? 'var(--bg)' : 'var(--text-dim)',
        bgcolor: active ? 'var(--accent)' : 'var(--line)',
        border: '1px solid var(--line-soft)',
        '&:hover': {
          bgcolor: active ? 'var(--accent)' : 'var(--line-soft)',
          color: active ? 'var(--bg)' : 'var(--accent)',
        },
      }}
    >
      {label}
    </Button>
  )
}

function Header({
  id,
  game,
  loading,
  loadError,
  current,
}: {
  id?: string
  game: GameAnalysis | null
  loading: boolean
  loadError: string | null
  current: { evalWhite: WhiteEval | null; bestUci: string | null }
}) {
  const evalText = formatEval(current.evalWhite)
  if (!id) {
    return (
      <Box sx={{ p: 1.5, borderBottom: '1px solid var(--line-soft)' }}>
        <Typography sx={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 16 }}>
          Analysis board
        </Typography>
        <Typography sx={{ fontSize: 12.5, color: 'var(--muted)' }}>
          Move freely · {evalText}
        </Typography>
      </Box>
    )
  }
  if (loading) {
    return (
      <Box sx={{ p: 1.5, borderBottom: '1px solid var(--line-soft)' }}>
        <Typography sx={{ fontSize: 13.5, color: 'var(--text-dim)' }}>Analyzing game…</Typography>
      </Box>
    )
  }
  if (loadError || !game) {
    return (
      <Box sx={{ p: 1.5, borderBottom: '1px solid var(--line-soft)' }}>
        <Typography sx={{ fontSize: 13.5, color: '#ca4a4a' }}>{loadError ?? 'Game not found'}</Typography>
      </Box>
    )
  }

  return (
    <Box sx={{ p: 1.5, borderBottom: '1px solid var(--line-soft)' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
        <Typography sx={{ fontWeight: 600, fontSize: 14.5 }}>
          {game.whiteName} <Box component="span" sx={{ color: 'var(--muted)' }}>vs</Box> {game.blackName}
        </Typography>
        <Typography sx={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--accent)' }}>
          {game.result}
        </Typography>
      </Box>
      <Box sx={{ display: 'flex', gap: 2, mt: 0.75 }}>
        <SideSummary label="White" side={game.summary.w} />
        <SideSummary label="Black" side={game.summary.b} />
      </Box>
    </Box>
  )
}

function SideSummary({ label, side }: { label: string; side: GameAnalysis['summary']['w'] }) {
  return (
    <Box sx={{ flex: 1, fontSize: 12 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
        <span style={{ color: 'var(--muted)' }}>{label}</span>
        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-dim)' }}>{side.accuracy}%</span>
      </Box>
      <Box sx={{ display: 'flex', gap: 1, color: 'var(--muted)', mt: 0.25 }}>
        <span style={{ color: '#ca4a4a' }}>{side.blunder} ??</span>
        <span style={{ color: '#e08a3e' }}>{side.mistake} ?</span>
        <span style={{ color: '#e0a33e' }}>{side.inaccuracy} ?!</span>
      </Box>
    </Box>
  )
}

function formatEval(ev: WhiteEval | null): string {
  if (!ev) return '…'
  if (ev.type === 'mate') return ev.white === 0 ? 'mate' : `mate in ${Math.abs(ev.white)}`
  const v = ev.white / 100
  return (v >= 0 ? '+' : '') + v.toFixed(2)
}
