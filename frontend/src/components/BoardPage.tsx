import type { BoardPageProps } from './boardPage/types'
import type { BoardLayout } from '../lib/settings'
import { useSetting } from '../lib/settings'
import LichessLayout from './boardPage/LichessLayout'
import ChessComLayout from './boardPage/ChessComLayout'

// One layout to rule every board page — now in two shapes. This file is only the
// switch: it reads the user's `boardLayout` preference and renders the matching
// layout, both of which implement the same `BoardPageProps` contract. Pages import
// this and nothing else, so a page never knows which layout it's in unless it
// deliberately asks (via `useBoardLayout`, below).
//
//   components/boardPage/LichessLayout.tsx   centered board, two flanking columns
//   components/boardPage/ChessComLayout.tsx  left-anchored board + strips, one rail
//
// The preference is a single-key subscription, so switching layouts re-renders
// every board page live with no reload.
export default function BoardPage(props: BoardPageProps) {
    const layout = useSetting('boardLayout')
    return layout === 'chesscom' ? <ChessComLayout {...props} /> : <LichessLayout {...props} />
}

/** The active board layout. For the handful of pages whose CONTENT genuinely
 *  differs between the two designs — chiefly the game pages, which put their player
 *  rows inside the right panel for Lichess and hand them to `top`/`bottom` as
 *  board-width strips for chess.com. Layout-agnostic pages never need this. */
export function useBoardLayout(): BoardLayout {
    return useSetting('boardLayout')
}

export type { BoardPageProps }
