// Client-side analysis move tree. chess.js owns move generation / legality / SAN
// / FEN here (the Go engine remains the authority for EVALUATION only). The tree
// supports Lichess-style branching: playing a move from any node either follows
// an existing child or creates a new variation.

import { Chess } from 'chess.js'
import type { WhiteEval } from '../components/EvalBar'

export type Judgment = 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder'

export interface TreeMove {
  uci: string
  san: string
  from: string
  to: string
}

export interface TreeNode {
  id: number
  fen: string
  ply: number // half-moves from the root position (root = 0)
  parent: number | null
  children: number[] // children[0] is the mainline continuation
  move: TreeMove | null // the move leading INTO this node (null at root)
  evalWhite: WhiteEval | null // eval at this position, White-relative (null = unknown)
  bestUci: string | null // engine's best move FROM this position (for the arrow)
  judgment: Judgment | null // judgment of `move` (set for a loaded game's mainline)
  cpLoss: number | null
}

export interface Tree {
  nodes: Record<number, TreeNode>
  rootId: number
  nextId: number
}

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

function emptyNode(id: number, fen: string, ply: number, parent: number | null): TreeNode {
  return {
    id,
    fen,
    ply,
    parent,
    children: [],
    move: null,
    evalWhite: null,
    bestUci: null,
    judgment: null,
    cpLoss: null,
  }
}

export function createTree(startFen: string = START_FEN): Tree {
  const root = emptyNode(0, startFen, 0, null)
  return { nodes: { 0: root }, rootId: 0, nextId: 1 }
}

/** Side to move at a node ('w' | 'b'), read from its FEN. */
export function turnAt(node: TreeNode): 'w' | 'b' {
  return node.fen.split(' ')[1] === 'b' ? 'b' : 'w'
}

/** Legal moves from a node, as UCI strings, for feeding the Board. */
export function legalUci(node: TreeNode): string[] {
  try {
    const c = new Chess(node.fen)
    return c.moves({ verbose: true }).map((m) => m.from + m.to + (m.promotion ?? ''))
  } catch {
    return []
  }
}

export interface GameOver {
  over: boolean
  checkmate: boolean
  stalemate: boolean
  draw: boolean
  check: boolean
}

export function gameOverAt(node: TreeNode): GameOver {
  try {
    const c = new Chess(node.fen)
    return {
      over: c.isGameOver(),
      checkmate: c.isCheckmate(),
      stalemate: c.isStalemate(),
      draw: c.isDraw(),
      check: c.isCheck(),
    }
  } catch {
    return { over: false, checkmate: false, stalemate: false, draw: false, check: false }
  }
}

/**
 * Play a UCI move from a node. Follows an existing child with the same move, or
 * creates a new branch. Returns the (possibly new) tree and the resulting node id.
 * Returns the original node id unchanged if the move is illegal.
 */
export function playMove(tree: Tree, fromId: number, uci: string): { tree: Tree; nodeId: number; created: boolean } {
  const node = tree.nodes[fromId]
  if (!node) return { tree, nodeId: fromId, created: false }

  // Already explored this move from here? Reuse the child (no duplicate branch).
  for (const childId of node.children) {
    if (tree.nodes[childId]?.move?.uci === uci) {
      return { tree, nodeId: childId, created: false }
    }
  }

  let c: Chess
  let mv: { san: string; from: string; to: string } | null = null
  try {
    c = new Chess(node.fen)
    const from = uci.slice(0, 2)
    const to = uci.slice(2, 4)
    const promotion = uci.length > 4 ? uci[4] : undefined
    const res = c.move({ from, to, promotion })
    mv = { san: res.san, from: res.from, to: res.to }
  } catch {
    return { tree, nodeId: fromId, created: false }
  }

  const id = tree.nextId
  const child = emptyNode(id, c.fen(), node.ply + 1, fromId)
  child.move = { uci, san: mv.san, from: mv.from, to: mv.to }

  const nodes = { ...tree.nodes, [id]: child, [fromId]: { ...node, children: [...node.children, id] } }
  return { tree: { ...tree, nodes, nextId: id + 1 }, nodeId: id, created: true }
}

/** Ancestor chain root→node (inclusive), used for the move list of the current line. */
export function pathToNode(tree: Tree, nodeId: number): TreeNode[] {
  const out: TreeNode[] = []
  let cur: number | null = nodeId
  while (cur !== null) {
    const n: TreeNode | undefined = tree.nodes[cur]
    if (!n) break
    out.push(n)
    cur = n.parent
  }
  return out.reverse()
}

/** Store an eval (and optional best move) on a node immutably. */
export function annotateEval(tree: Tree, nodeId: number, evalWhite: WhiteEval | null, bestUci: string | null): Tree {
  const node = tree.nodes[nodeId]
  if (!node) return tree
  return { ...tree, nodes: { ...tree.nodes, [nodeId]: { ...node, evalWhite, bestUci } } }
}

export interface AnalysisPlyDTO {
  ply: number
  fen: string
  sideToMove: 'w' | 'b'
  evalWhite: WhiteEval | null
  bestUci: string | null
  bestSan: string | null
  move?: {
    uci: string
    san: string
    color: 'w' | 'b'
    cpLoss: number
    isBest: boolean
    judgment: Judgment
  }
}

/**
 * Build a tree from a persisted game's analysis (the backend payload), producing
 * the mainline annotated with cached evals, best moves, and move judgments. The
 * user can branch off any node afterward.
 */
export function buildFromAnalysis(startFen: string, plies: AnalysisPlyDTO[]): { tree: Tree; lastId: number } {
  let tree = createTree(startFen || START_FEN)
  let curId = tree.rootId

  // Annotate the root (start position) eval + best move.
  if (plies[0]) {
    tree = annotateEval(tree, curId, plies[0].evalWhite, plies[0].bestUci)
  }

  for (let k = 0; k < plies.length; k++) {
    const p = plies[k]
    if (!p.move) continue
    const res = playMove(tree, curId, p.move.uci)
    tree = res.tree
    curId = res.nodeId
    // The resulting position's eval/best come from the NEXT ply entry.
    const after = plies[k + 1]
    const node = tree.nodes[curId]
    if (node) {
      tree = {
        ...tree,
        nodes: {
          ...tree.nodes,
          [curId]: {
            ...node,
            evalWhite: after ? after.evalWhite : node.evalWhite,
            bestUci: after ? after.bestUci : null,
            judgment: p.move.judgment,
            cpLoss: p.move.cpLoss,
          },
        },
      }
    }
  }

  return { tree, lastId: curId }
}
