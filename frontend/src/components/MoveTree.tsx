import type { ReactNode } from 'react'
import { Box } from '@mui/material'
import type { Judgment, Tree, TreeNode } from '../lib/analysisTree'
import { sanToGlyph } from '../lib/chess'

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

/**
 * Lichess-style move list with branching: the mainline flows inline; alternative
 * moves at any branch point render as parenthesised, indented variations.
 */
export default function MoveTree({ tree, currentId, onSelect }: Props) {
  const root = tree.nodes[tree.rootId]

  function chip(node: TreeNode, forceNumber: boolean): ReactNode {
    const isWhiteMove = node.ply % 2 === 1
    const moveNo = Math.ceil(node.ply / 2)
    const j = node.judgment
    const num = isWhiteMove ? `${moveNo}.` : forceNumber ? `${moveNo}…` : ''
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
          gap: 0.4,
          px: 0.5,
          py: '1px',
          mr: 0.25,
          borderRadius: '3px',
          fontFamily: 'var(--font-mono)',
          fontSize: 13.5,
          fontWeight: active ? 700 : 500,
          color: j ? JUDGMENT_COLOR[j] : 'var(--text)',
          bgcolor: active ? 'var(--accent)' : 'transparent',
          ...(active ? { color: '#15171c' } : {}),
          '&:hover': active ? {} : { bgcolor: 'var(--line)' },
        }}
      >
        {num && <Box component="span" sx={{ color: active ? '#15171c' : 'var(--muted)', fontWeight: 600 }}>{num}</Box>}
        <span>
          {node.move ? sanToGlyph(node.move.san) : ''}
          {j && JUDGMENT_GLYPH[j]}
        </span>
      </Box>
    )
  }

  // Render the mainline starting at `node`, inlining variations at branch points.
  function renderLine(node: TreeNode): ReactNode[] {
    const els: ReactNode[] = []
    let cur: TreeNode | undefined = node
    let justBranched = false
    while (cur && cur.children.length > 0) {
      const main: TreeNode | undefined = tree.nodes[cur.children[0]]
      if (!main) break
      els.push(chip(main, justBranched))
      justBranched = false

      // Alternative moves at this position → nested variations.
      if (cur.children.length > 1) {
        for (let i = 1; i < cur.children.length; i++) {
          const alt = tree.nodes[cur.children[i]]
          if (!alt) continue
          els.push(
            <Box
              key={`var-${alt.id}`}
              sx={{
                display: 'block',
                ml: 1.5,
                pl: 1,
                my: 0.25,
                borderLeft: '2px solid var(--line)',
                color: 'var(--text-dim)',
              }}
            >
              {chip(alt, true)}
              {renderLine(alt)}
            </Box>,
          )
        }
        justBranched = true // after a variation block, re-show the number for the next mainline move
      }
      cur = main
    }
    return els
  }

  const body = renderLine(root)

  return (
    <Box
      sx={{
        flex: 1,
        overflowY: 'auto',
        px: 1.25,
        py: 1,
        lineHeight: 1.9,
        minHeight: 0,
      }}
    >
      {body.length === 0 ? (
        <Box sx={{ color: 'var(--muted)', fontSize: 13, fontStyle: 'italic', px: 0.5 }}>
          Make a move to start exploring.
        </Box>
      ) : (
        body
      )}
    </Box>
  )
}
