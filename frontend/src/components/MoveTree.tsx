import type { ReactNode } from 'react'
import { Box } from '@mui/material'
import type { Judgment, Tree, TreeNode } from '../lib/analysisTree'
import { sanToGlyph } from '../lib/chess'

// Visuals match MoveList (the bot/live move table) so the move list looks the same
// across every page: a number gutter + White/Black columns, fixed-height rows that
// scroll. MoveTree adds what an analysis board needs on top: per-node selection,
// move judgments, and branching variations (rendered as indented inline lines).
const ROW_H = 31
const NUM_COL = 32
const STRIPE = 'rgba(255,255,255,0.05)'
const CURRENT_BG = '#3a4880'

const JUDGMENT_COLOR: Record<Judgment, string> = {
  best: 'var(--text)',
  good: 'var(--text)',
  inaccuracy: '#e0a33e',
  mistake: '#e08a3e',
  blunder: '#ca4a4a',
}

const JUDGMENT_GLYPH: Record<Judgment, string> = {
  best: '',
  good: '',
  inaccuracy: '?!',
  mistake: '?',
  blunder: '??',
}

interface Props {
  tree: Tree
  currentId: number
  onSelect: (id: number) => void
}

type Row =
  | { kind: 'moves'; no: number; white?: TreeNode; black?: TreeNode }
  | { kind: 'var'; node: TreeNode }

export default function MoveTree({ tree, currentId, onSelect }: Props) {
  const root = tree.nodes[tree.rootId]

  // --- Flatten the mainline into White/Black rows, inserting variation blocks at
  // each branch point (anything beyond children[0]). ---
  const rows: Row[] = []
  let pending: { no: number; white?: TreeNode; black?: TreeNode } | null = null
  const flush = () => {
    if (pending) {
      rows.push({ kind: 'moves', ...pending })
      pending = null
    }
  }
  const addMove = (node: TreeNode) => {
    const isWhite = node.ply % 2 === 1
    const no = Math.ceil(node.ply / 2)
    if (isWhite) {
      flush()
      pending = { no, white: node }
    } else if (pending && pending.no === no && !pending.black) {
      pending.black = node
    } else {
      flush()
      pending = { no, black: node }
    }
  }

  let cur: TreeNode | undefined = root
  while (cur && cur.children.length > 0) {
    const main: TreeNode | undefined = tree.nodes[cur.children[0]]
    if (!main) break
    addMove(main)
    if (cur.children.length > 1) {
      flush() // variations appear on their own lines, after the move they branch from
      for (let i = 1; i < cur.children.length; i++) {
        const alt = tree.nodes[cur.children[i]]
        if (alt) rows.push({ kind: 'var', node: alt })
      }
    }
    cur = main
  }
  flush()

  // --- Inline rendering for variation lines (recursive, like a mini move stream). ---
  function inlineChip(node: TreeNode, forceNumber: boolean): ReactNode {
    const isWhite = node.ply % 2 === 1
    const moveNo = Math.ceil(node.ply / 2)
    const j = node.judgment
    const num = isWhite ? `${moveNo}.` : forceNumber ? `${moveNo}…` : ''
    const active = node.id === currentId
    return (
      <Box
        component="span"
        key={node.id}
        onClick={() => onSelect(node.id)}
        sx={{
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'baseline',
          gap: 0.3,
          px: 0.4,
          py: '1px',
          mr: 0.25,
          borderRadius: '3px',
          fontFamily: 'var(--font-mono)',
          fontSize: 12.5,
          fontWeight: active ? 700 : 500,
          color: active ? '#fff' : j ? JUDGMENT_COLOR[j] : 'var(--text-dim)',
          bgcolor: active ? CURRENT_BG : 'transparent',
          '&:hover': active ? {} : { bgcolor: 'var(--line)' },
        }}
      >
        {num && (
          <Box component="span" sx={{ color: active ? 'rgba(255,255,255,0.7)' : 'var(--muted)' }}>
            {num}
          </Box>
        )}
        <span>
          {node.move ? sanToGlyph(node.move.san) : ''}
          {j && JUDGMENT_GLYPH[j]}
        </span>
      </Box>
    )
  }

  function renderVariation(start: TreeNode): ReactNode[] {
    const els: ReactNode[] = [inlineChip(start, true)]
    let node: TreeNode | undefined = start
    let justBranched = false
    while (node && node.children.length > 0) {
      const main: TreeNode | undefined = tree.nodes[node.children[0]]
      if (!main) break
      els.push(inlineChip(main, justBranched))
      justBranched = false
      if (node.children.length > 1) {
        for (let i = 1; i < node.children.length; i++) {
          const alt = tree.nodes[node.children[i]]
          if (!alt) continue
          els.push(
            <Box
              key={`v-${alt.id}`}
              sx={{ display: 'block', ml: 1.25, pl: 1, my: 0.25, borderLeft: '2px solid var(--line)' }}
            >
              {renderVariation(alt)}
            </Box>,
          )
        }
        justBranched = true
      }
      node = main
    }
    return els
  }

  return (
    <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      {rows.length === 0 ? (
        <Box sx={{ color: 'var(--muted)', fontSize: 13, fontStyle: 'italic', px: 1.5, py: 1.25 }}>
          Make a move to start exploring.
        </Box>
      ) : (
        rows.map((r, idx) =>
          r.kind === 'moves' ? (
            <Box key={idx} sx={{ display: 'grid', gridTemplateColumns: `${NUM_COL}px 1fr 1fr` }}>
              <NumCell no={r.no} />
              <Cell node={r.white} whiteCol currentId={currentId} onSelect={onSelect} />
              <Cell node={r.black} currentId={currentId} onSelect={onSelect} />
            </Box>
          ) : (
            <Box
              key={idx}
              sx={{
                pl: `${NUM_COL + 6}px`,
                pr: 1.25,
                py: 0.5,
                borderLeft: '2px solid var(--line)',
                ml: 1,
                my: 0.25,
                lineHeight: 1.7,
              }}
            >
              {renderVariation(r.node)}
            </Box>
          ),
        )
      )}
    </Box>
  )
}

function NumCell({ no }: { no?: number }) {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: ROW_H,
        color: 'var(--muted)',
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
      }}
    >
      {no ?? ''}
    </Box>
  )
}

function Cell({
  node,
  whiteCol,
  currentId,
  onSelect,
}: {
  node?: TreeNode
  whiteCol?: boolean
  currentId: number
  onSelect: (id: number) => void
}) {
  const base = whiteCol ? STRIPE : 'transparent'
  if (!node) return <Box sx={{ minHeight: ROW_H, bgcolor: base }} />
  const active = node.id === currentId
  const j = node.judgment
  return (
    <Box
      onClick={() => onSelect(node.id)}
      sx={{
        minHeight: ROW_H,
        display: 'flex',
        alignItems: 'center',
        px: 1.25,
        cursor: 'pointer',
        fontFamily: 'var(--font-mono)',
        fontSize: 13.5,
        fontWeight: active ? 700 : 500,
        color: active ? '#fff' : j ? JUDGMENT_COLOR[j] : 'var(--text)',
        bgcolor: active ? CURRENT_BG : base,
        transition: 'background 0.1s ease',
        '&:hover': { bgcolor: active ? CURRENT_BG : whiteCol ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.06)' },
      }}
    >
      {node.move ? sanToGlyph(node.move.san) : ''}
      {j ? JUDGMENT_GLYPH[j] : ''}
    </Box>
  )
}
