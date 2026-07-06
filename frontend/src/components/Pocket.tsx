import type { Color } from '../api/client'
import { pieceImageUrl } from '../lib/chess'
import { usePieceSet } from '../lib/boardTheme'
import type { PocketPiece, Pockets } from '../lib/variants'
import './Pocket.css'

const ORDER: PocketPiece[] = ['Q', 'R', 'B', 'N', 'P']

/**
 * The Crazyhouse pocket strip for one side: the pieces that side holds in hand,
 * grouped by type with a count badge. On your own turn the pieces are clickable to
 * arm a drop (the selected one is highlighted); the opponent's pocket is display
 * only. Empty pockets render an empty, fixed-height tray so the layout is stable.
 */
export default function Pocket({
    color,
    pocket,
    selected,
    interactive,
    onSelect,
}: {
    color: Color
    pocket: Pockets
    selected: PocketPiece | null
    interactive: boolean
    onSelect: (p: PocketPiece) => void
}) {
    const set = usePieceSet()
    const held = color === 'w' ? pocket.w : pocket.b
    const counts = countBy(held)
    const types = ORDER.filter((t) => counts[t] > 0)

    return (
        <div className="pocket">
            {types.length === 0 && <span className="pocket-empty">—</span>}
            {types.map((t) => {
                const letter = color === 'w' ? t : t.toLowerCase()
                const active = interactive && selected === t
                return (
                    <button
                        key={t}
                        type="button"
                        className={`pocket-piece${active ? ' active' : ''}`}
                        disabled={!interactive}
                        onClick={() => onSelect(t)}
                        aria-label={`Drop ${t} (${counts[t]} in hand)`}
                    >
                        <span
                            className="pocket-glyph"
                            style={{ backgroundImage: `url(${pieceImageUrl(letter, set)})` }}
                        />
                        {counts[t] > 1 && <span className="pocket-count">{counts[t]}</span>}
                    </button>
                )
            })}
        </div>
    )
}

function countBy(pieces: PocketPiece[]): Record<PocketPiece, number> {
    const c = { P: 0, N: 0, B: 0, R: 0, Q: 0 }
    for (const p of pieces) c[p]++
    return c
}
