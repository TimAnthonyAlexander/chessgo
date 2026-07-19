import {
    type PointerEvent as ReactPointerEvent,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react'
import './Board.css'
import type { Color } from '../api/client'
import {
    type BoardMap,
    type Square,
    fileOf,
    isWhitePiece,
    kingSquare,
    parseFen,
    pieceImageUrl,
    premoveTargets,
    promotionsFor,
    rankOf,
    squareAt,
    targetsFrom,
} from '../lib/chess'
import { usePieceSet } from '../lib/boardTheme'
import { usePrefs, type ArrowColor } from '../lib/settings'
import { DuckGlyph } from './DuckGlyph'

function PieceGlyph({ piece, set, hidden }: { piece: string; set: string; hidden?: boolean }) {
    return (
        <span
            className="piece"
            style={{
                backgroundImage: `url(${pieceImageUrl(piece, set)})`,
                ...(hidden ? { opacity: 0 } : {}),
            }}
        />
    )
}

interface BoardProps {
    fen: string
    orientation: Color
    sideToMove: Color
    legalMoves: string[]
    lastMove: { from: Square; to: Square } | null
    inCheck: boolean
    interactive: boolean
    onMove: (uci: string) => void
    /** Optional display-only board override for optimistic move feedback. */
    overrideBoard?: BoardMap
    /** Optional move arrow (e.g. the engine's best move, or a hovered candidate)
     * drawn over the board. `color` defaults to the accent (gold) best-move hue.
     * `outline` rings the arrow in a second color — used to signal that another
     * engine agrees on this move (so we draw ONE ringed arrow, not two stacked). */
    arrow?: { from: Square; to: Square; color?: string; outline?: string } | null
    /** Optional secondary arrow (e.g. Stockfish's best move alongside the engine's),
     * drawn translucent and UNDER the primary arrow. */
    arrow2?: { from: Square; to: Square; color?: string } | null
    /** Optional highlight ring on a single square — used for Duck Chess to mark the
     * engine's best DUCK placement (the second half of a composite best move, which
     * an arrow can't express). `color` defaults to the accent (gold) best-move hue. */
    circle?: { square: Square; color?: string } | null
    /** Optional ultra-subtle best-move hint: tiny "pixel" dots on the from + to
     * squares (no arrow). Used by the admin best-move toggle to whisper the engine's
     * choice onto the board — intentionally near-invisible. */
    hint?: { from: Square; to: Square } | null
    /** The local player's own color — enables premove input while it isn't their
     * turn (i.e. while `interactive` is false). Omit/null to disable premoves. */
    premoveColor?: Color | null
    /** The queued premove chain to highlight (each from + to). */
    premoves?: { from: Square; to: Square }[] | null
    /** Discard the queued premove (user clicked an empty / invalid square). */
    onCancelPremove?: () => void
    /** Duck Chess: render a duck glyph on this square (normal play, placement, and history). */
    duck?: Square | null
    /** Duck Chess: non-null puts the board in DUCK-PLACEMENT mode — normal piece input is
     * disabled and these empty squares are the valid duck drops. */
    duckTargets?: Set<Square> | null
    /** Duck Chess: called with the chosen empty square while in duck-placement mode. */
    onPlaceDuck?: (sq: Square) => void
    /** Crazyhouse: empty squares the armed pocket piece may be dropped on (else null). */
    dropTargets?: Set<Square> | null
    /** Crazyhouse: called with the chosen empty square to drop the armed pocket piece. */
    onDrop?: (sq: Square) => void
    /** Crazyhouse: called when a click should clear the armed pocket selection (the
     * user clicked away from a drop target, e.g. to pick a board piece instead). */
    onDropCancel?: () => void
}

const PROMO_ORDER = ['q', 'r', 'b', 'n']
// Full piece names for the promotion picker's accessible labels ("Promote to Queen").
const PROMO_NAMES: Record<string, string> = {
    q: 'Queen',
    r: 'Rook',
    b: 'Bishop',
    n: 'Knight',
}

// Build an arrow as a SINGLE filled polygon (shaft + head) from a→b in the 80×80
// board space. Used for the "both engines agree" arrow, where we want ONE arrow
// with a clean, uniform border in a second color — a fill + stroke on one shape
// borders evenly everywhere (including the head), which stacked line+marker
// shapes can't (their heads scale with stroke width and misalign).
function arrowPolygon(a: { x: number; y: number }, b: { x: number; y: number }): string {
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy) || 1
    const ux = dx / len
    const uy = dy / len
    const nx = -uy // unit normal
    const ny = ux
    const shaft = 1.7 // shaft half-width is shaft/2
    const headLen = 5
    const headW = 6 // head half-width is headW/2
    const bx = b.x - ux * headLen // head base (where shaft meets head)
    const by = b.y - uy * headLen
    const sh = shaft / 2
    const hh = headW / 2
    const p = (px: number, py: number) => `${px.toFixed(2)},${py.toFixed(2)}`
    return [
        p(a.x + nx * sh, a.y + ny * sh),
        p(bx + nx * sh, by + ny * sh),
        p(bx + nx * hh, by + ny * hh),
        p(b.x, b.y), // tip
        p(bx - nx * hh, by - ny * hh),
        p(bx - nx * sh, by - ny * sh),
        p(a.x - nx * sh, a.y - ny * sh),
    ].join(' ')
}

// Lichess-style right-click annotations. A shape with from === to is a square
// highlight (ring); otherwise it's an arrow. The modifier held while drawing
// picks the brush colour.
type Brush = 'green' | 'red' | 'blue' | 'yellow' | 'accent'
const BRUSHES: Record<Brush, string> = {
    // Brighter, higher-chroma variants of the Lichess brushes so they read on both
    // light and dark (incl. photographic) board themes.
    green: '#37a93c',
    red: '#d64541',
    blue: '#3b7fe4',
    yellow: '#e8b02a',
    // The no-modifier default arrow derives from the site accent so it feels native.
    accent: 'var(--accent)',
}
interface Shape {
    from: Square
    to: Square
    brush: Brush
}
// Canonical color order. The default color takes the no-modifier slot; the other
// three fill shift / ctrl / shift+ctrl in this order, so ALL four colors stay
// reachable no matter which one is chosen as the default (never a duplicate,
// never an unreachable color).
const ARROW_COLORS: ArrowColor[] = ['green', 'red', 'blue', 'yellow']
function brushFor(
    e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
    base: ArrowColor,
): Brush {
    const ctrl = e.ctrlKey || e.metaKey
    // Slot 0 = no modifier (the default); 1 = shift, 2 = ctrl, 3 = shift+ctrl.
    const slot = e.shiftKey ? (ctrl ? 3 : 1) : ctrl ? 2 : 0
    if (slot === 0) {
        // No modifier → the user's default. The built-in default ('green') maps to
        // the site accent so the plain arrow feels native and stays legible on dark
        // board themes; an explicitly-chosen color is honored as-is.
        return base === 'green' ? 'accent' : base
    }
    // The remaining three colors, in canonical order, fill the modifier slots.
    return ARROW_COLORS.filter((c) => c !== base)[slot - 1]
}

interface DragState {
    from: Square
    piece: string
    x: number
    y: number
    over: Square | null
    size: number
    reselect: boolean
}

export default function Board({
    fen,
    orientation,
    sideToMove,
    legalMoves,
    lastMove,
    inCheck,
    interactive,
    onMove,
    overrideBoard,
    arrow,
    arrow2,
    circle,
    hint,
    premoveColor,
    premoves,
    onCancelPremove,
    duck,
    duckTargets,
    onPlaceDuck,
    dropTargets,
    onDrop,
    onDropCancel,
}: BoardProps) {
    const boardRef = useRef<HTMLDivElement>(null)
    const pieceSet = usePieceSet() // re-render (with new piece SVGs) when the set changes
    const prefs = usePrefs() // user display/input preferences (legal-move dots, coords, …)
    // Move method: 'both' allows drag + click-to-move; 'click' disables drag;
    // 'drag' disables the select-then-tap commit (must drag the piece).
    const allowDrag = prefs.moveMethod !== 'click'
    const allowClick = prefs.moveMethod !== 'drag'
    const [selected, setSelected] = useState<Square | null>(null)
    const [promo, setPromo] = useState<{ from: Square; to: Square; options: string[] } | null>(null)
    const [drag, setDrag] = useState<DragState | null>(null)
    // Right-click drawn annotations + the one currently being dragged out.
    const [shapes, setShapes] = useState<Shape[]>([])
    const [drawing, setDrawing] = useState<Shape | null>(null)

    // Annotations are per-position: clear them whenever the position changes.
    useEffect(() => {
        setShapes([])
        setDrawing(null)
    }, [fen])

    // Dismiss the promotion picker on Escape (keyboard accessibility).
    useEffect(() => {
        if (!promo) return
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setPromo(null)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [promo])

    const board: BoardMap = useMemo(() => overrideBoard ?? parseFen(fen), [overrideBoard, fen])

    // Premove mode: while it isn't our turn but we're a player, we let the user
    // queue a move. Inputs come from the same handlers; the only differences are
    // which pieces are "ours" (our color, not the side to move) and which targets
    // are valid (piece geometry, since the real legal-move list isn't ours yet).
    const premoveActive = !interactive && premoveColor != null
    // Duck-placement mode disables ALL normal piece input; the only left-click action
    // is dropping the duck on an empty target square (handled separately below).
    const duckPlacing = duckTargets != null
    const inputEnabled = !duckPlacing && (interactive || premoveActive)
    const movingColor: Color = interactive ? sideToMove : (premoveColor ?? sideToMove)
    const destsFor = (from: Square): Set<Square> =>
        interactive ? targetsFrom(legalMoves, from) : premoveTargets(board, from)

    // Recomputed only when the selection / legal targets actually change — not on
    // every render (e.g. the continuous setDrag during a drag).
    const targets = useMemo(
        () => (selected ? destsFor(selected) : new Set<Square>()),
        [selected, interactive, legalMoves, board],
    )
    const checkKing = useMemo(
        () => (inCheck && prefs.highlightCheck ? kingSquare(board, sideToMove === 'w') : null),
        [inCheck, prefs.highlightCheck, board, sideToMove],
    )

    // Square center in an 80×80 coordinate space (10 units / square), oriented.
    const center = useCallback(
        (sq: Square) => {
            const col = orientation === 'w' ? fileOf(sq) : 7 - fileOf(sq)
            const row = orientation === 'w' ? 7 - rankOf(sq) : rankOf(sq)
            return { x: col * 10 + 5, y: row * 10 + 5 }
        },
        [orientation],
    )
    const arrowGeom = useMemo(
        () => (arrow ? { a: center(arrow.from), b: center(arrow.to) } : null),
        [arrow, center],
    )
    const arrowColor = arrow?.color ?? 'var(--accent)'
    const arrowOutline = arrow?.outline ?? null
    const arrow2Geom = useMemo(
        () => (arrow2 ? { a: center(arrow2.from), b: center(arrow2.to) } : null),
        [arrow2, center],
    )
    const arrow2Color = arrow2?.color ?? 'var(--accent)'
    const circleGeom = useMemo(
        () => (circle ? center(circle.square) : null),
        [circle, center],
    )
    const circleColor = circle?.color ?? 'var(--accent)'

    const ranks = orientation === 'w' ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7]
    const files = orientation === 'w' ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0]

    function squareFromPoint(cx: number, cy: number): Square | null {
        const el = boardRef.current
        if (!el) return null
        const r = el.getBoundingClientRect()
        if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) return null
        const col = Math.min(7, Math.max(0, Math.floor((cx - r.left) / (r.width / 8))))
        const row = Math.min(7, Math.max(0, Math.floor((cy - r.top) / (r.height / 8))))
        const file = orientation === 'w' ? col : 7 - col
        const rank = orientation === 'w' ? 7 - row : row
        return squareAt(file, rank)
    }

    function ownPieceAt(sq: Square): boolean {
        const p = board[sq]
        return !!p && (isWhitePiece(p) ? 'w' : 'b') === movingColor
    }

    function commit(from: Square, to: Square) {
        if (interactive) {
            const options = promotionsFor(legalMoves, from, to)
            if (options.length > 0) {
                // Auto-queen preference skips the picker and promotes to a queen
                // directly (matching the premove behavior below).
                if (prefs.autoQueen) {
                    setSelected(null)
                    onMove(from + to + 'q')
                    return
                }
                setPromo({ from, to, options })
                return
            }
            setSelected(null)
            onMove(from + to)
            return
        }
        // Premove: auto-queen a promoting pawn (Chess.com-style — no picker mid-premove).
        const piece = board[from]?.toLowerCase()
        const promoting = piece === 'p' && (to[1] === '8' || to[1] === '1')
        setSelected(null)
        onMove(from + to + (promoting ? 'q' : ''))
    }

    // Add a shape, or toggle it off if the identical one already exists. A
    // different-coloured shape on the same squares recolours it (Lichess-style).
    function toggleShape(s: Shape) {
        setShapes((prev) => {
            const same = prev.find((x) => x.from === s.from && x.to === s.to)
            const without = prev.filter((x) => !(x.from === s.from && x.to === s.to))
            if (same && same.brush === s.brush) return without
            return [...without, s]
        })
    }

    function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
        if (promo) return

        // Right button → draw an annotation (works regardless of `interactive`).
        if (e.button === 2) {
            const sq = squareFromPoint(e.clientX, e.clientY)
            if (!sq) return
            e.preventDefault()
            try {
                boardRef.current?.setPointerCapture(e.pointerId)
            } catch {
                /* ignore */
            }
            setDrawing({ from: sq, to: sq, brush: brushFor(e, prefs.arrowColor) })
            return
        }

        // Any left-click clears existing annotations (Lichess behaviour).
        if (shapes.length) setShapes([])

        // Duck-placement mode: the only left action is dropping the duck on a valid
        // empty target square; normal piece selection/drag/premove is disabled.
        if (duckPlacing) {
            const sq = squareFromPoint(e.clientX, e.clientY)
            if (sq && duckTargets?.has(sq)) onPlaceDuck?.(sq)
            return
        }

        // Crazyhouse: a pocket piece is armed. Clicking a legal drop square drops it;
        // any other click clears the selection and falls through to normal input (so
        // the same click can instead pick up a board piece).
        if (dropTargets != null) {
            const sq = squareFromPoint(e.clientX, e.clientY)
            if (sq && dropTargets.has(sq)) {
                onDrop?.(sq)
                return
            }
            onDropCancel?.()
        }

        if (!inputEnabled) return
        const sq = squareFromPoint(e.clientX, e.clientY)
        if (!sq) return

        if (ownPieceAt(sq)) {
            e.preventDefault()
            // Drag is suppressed in click-to-move-only mode; the piece still
            // selects so the second click can commit.
            if (allowDrag) {
                const size = (boardRef.current?.getBoundingClientRect().width ?? 0) / 8
                try {
                    boardRef.current?.setPointerCapture(e.pointerId)
                } catch {
                    /* ignore */
                }
                setDrag({
                    from: sq,
                    piece: board[sq],
                    x: e.clientX,
                    y: e.clientY,
                    over: sq,
                    size,
                    reselect: selected === sq,
                })
            }
            setSelected(sq)
        } else if (allowClick && selected && targets.has(sq)) {
            commit(selected, sq)
        } else {
            setSelected(null)
            if (premoveActive) onCancelPremove?.() // tapped empty/elsewhere → drop the premove
        }
    }

    function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
        if (drawing) {
            const sq = squareFromPoint(e.clientX, e.clientY)
            if (sq && sq !== drawing.to) setDrawing({ ...drawing, to: sq })
            return
        }
        if (!drag) return
        setDrag({
            ...drag,
            x: e.clientX,
            y: e.clientY,
            over: squareFromPoint(e.clientX, e.clientY),
        })
    }

    function onPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
        if (drawing) {
            const s = drawing
            setDrawing(null)
            try {
                boardRef.current?.releasePointerCapture(e.pointerId)
            } catch {
                /* ignore */
            }
            toggleShape(s)
            return
        }
        if (!drag) return
        const d = drag
        setDrag(null)
        try {
            boardRef.current?.releasePointerCapture(e.pointerId)
        } catch {
            /* ignore */
        }

        const dropSq = squareFromPoint(e.clientX, e.clientY)
        if (dropSq === d.from) {
            // Released on the origin square — a plain tap, not a drag.
            if (d.reselect) setSelected(null) // tapped an already-selected piece → toggle off
            // else: keep it selected (dots shown)
        } else if (dropSq && destsFor(d.from).has(dropSq)) {
            commit(d.from, dropSq)
        } else {
            setSelected(null) // dropped off-board or on an invalid square → deselect
            if (premoveActive) onCancelPremove?.()
        }
    }

    function choosePromotion(letter: string) {
        if (!promo) return
        const { from, to } = promo
        setPromo(null)
        setSelected(null)
        onMove(from + to + letter)
    }

    const coordsOutside = prefs.showCoordinates === 'outside'

    return (
        <div className={`board-wrap${coordsOutside ? ' coords-outside' : ''}`}>
            {coordsOutside && (
                <div className="ranks-gutter" aria-hidden>
                    {ranks.map((r) => (
                        <span key={r}>{r + 1}</span>
                    ))}
                </div>
            )}
            <div
                ref={boardRef}
                className={`board${drag ? ' dragging' : ''}`}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={() => {
                    setDrag(null)
                    setDrawing(null)
                }}
                onContextMenu={(e) => e.preventDefault()}
            >
                {ranks.map((rank) =>
                    files.map((file) => {
                        const sq = squareAt(file, rank)
                        const piece = board[sq]
                        const light = (file + rank) % 2 === 1
                        const isTarget = targets.has(sq)
                        const isDuckTarget = duckTargets?.has(sq) ?? false
                        const isDropTarget = dropTargets?.has(sq) ?? false
                        const isLast =
                            prefs.highlightLastMove &&
                            lastMove &&
                            (lastMove.from === sq || lastMove.to === sq)
                        const isPremove = !!premoves?.some((p) => p.from === sq || p.to === sq)
                        const isDragOrigin = !!drag && drag.from === sq
                        const isOver =
                            prefs.highlightDragOver &&
                            !!drag &&
                            drag.over === sq &&
                            destsFor(drag.from).has(sq)
                        const classes = [
                            'sq',
                            light ? 'light' : 'dark',
                            inputEnabled ? 'interactive' : '',
                            selected === sq ? 'sel' : '',
                            isLast ? 'last' : '',
                            isPremove ? 'premove' : '',
                            isOver ? 'over' : '',
                            checkKing === sq ? 'check' : '',
                        ]
                            .filter(Boolean)
                            .join(' ')

                        // In-square coordinates only in 'inside' mode ('outside' draws
                        // them in the gutter layer below; 'off' hides them entirely).
                        const coordsInside = prefs.showCoordinates === 'inside'
                        const showFile =
                            coordsInside && (orientation === 'w' ? rank === 0 : rank === 7)
                        const showRank =
                            coordsInside && (orientation === 'w' ? file === 0 : file === 7)

                        return (
                            <div key={sq} className={classes}>
                                {prefs.showLegalMoves && isTarget && !piece && <span className="dot" />}
                                {prefs.showLegalMoves && isTarget && piece && <span className="ring" />}
                                {isDuckTarget && !piece && <span className="dot" />}
                                {isDropTarget && !piece && <span className="dot" />}
                                {hint && (hint.from === sq || hint.to === sq) && (
                                    <span className="hint-dot" />
                                )}
                                {piece && (
                                    <PieceGlyph
                                        piece={piece}
                                        set={pieceSet}
                                        hidden={isDragOrigin || prefs.blindfold}
                                    />
                                )}
                                {duck === sq && (
                                    <span className="duck" aria-hidden>
                                        <DuckGlyph />
                                    </span>
                                )}
                                {showRank && <span className="coord rank">{rank + 1}</span>}
                                {showFile && <span className="coord file">{'abcdefgh'[file]}</span>}
                            </div>
                        )
                    }),
                )}

                {(arrowGeom || arrow2Geom || circleGeom) && (
                    <svg
                        className="board-arrow"
                        viewBox="0 0 80 80"
                        preserveAspectRatio="none"
                        style={{
                            position: 'absolute',
                            inset: 0,
                            width: '100%',
                            height: '100%',
                            pointerEvents: 'none',
                            zIndex: 5,
                        }}
                    >
                        <defs>
                            {arrow2Geom && (
                                <marker
                                    id="bm-head2"
                                    markerWidth="4"
                                    markerHeight="4"
                                    refX="2.6"
                                    refY="2"
                                    orient="auto"
                                >
                                    <path d="M0,0 L4,2 L0,4 z" fill={arrow2Color} />
                                </marker>
                            )}
                            {arrowGeom && !arrowOutline && (
                                <marker
                                    id="bm-head"
                                    markerWidth="4"
                                    markerHeight="4"
                                    refX="2.6"
                                    refY="2"
                                    orient="auto"
                                >
                                    <path d="M0,0 L4,2 L0,4 z" fill={arrowColor} />
                                </marker>
                            )}
                        </defs>
                        {/* Secondary (e.g. Stockfish) arrow — translucent, drawn first
                            so the primary sits on top when they don't overlap. */}
                        {arrow2Geom && (
                            <line
                                x1={arrow2Geom.a.x}
                                y1={arrow2Geom.a.y}
                                x2={arrow2Geom.b.x}
                                y2={arrow2Geom.b.y}
                                stroke={arrow2Color}
                                strokeWidth={1.7}
                                strokeLinecap="round"
                                markerEnd="url(#bm-head2)"
                                opacity={0.32}
                            />
                        )}
                        {/* Agreement case: ONE arrow drawn as a filled polygon, gold
                            fill + a clean uniform border in the outline color. */}
                        {arrowGeom && arrowOutline ? (
                            <polygon
                                points={arrowPolygon(arrowGeom.a, arrowGeom.b)}
                                fill={arrowColor}
                                stroke={arrowOutline}
                                strokeWidth={0.7}
                                strokeLinejoin="round"
                                opacity={0.85}
                            />
                        ) : (
                            arrowGeom && (
                                <line
                                    x1={arrowGeom.a.x}
                                    y1={arrowGeom.a.y}
                                    x2={arrowGeom.b.x}
                                    y2={arrowGeom.b.y}
                                    stroke={arrowColor}
                                    strokeWidth={1.7}
                                    strokeLinecap="round"
                                    markerEnd="url(#bm-head)"
                                    opacity={0.7}
                                />
                            )
                        )}
                        {/* Best DUCK-placement ring (Duck Chess): a filled, ringed
                            circle on the square where the engine wants the duck. */}
                        {circleGeom && (
                            <circle
                                cx={circleGeom.x}
                                cy={circleGeom.y}
                                r={4}
                                fill={circleColor}
                                fillOpacity={0.22}
                                stroke={circleColor}
                                strokeWidth={0.9}
                                opacity={0.85}
                            />
                        )}
                    </svg>
                )}

                {(shapes.length > 0 || drawing) && (
                    <svg
                        className="board-shapes"
                        viewBox="0 0 80 80"
                        preserveAspectRatio="none"
                        style={{
                            position: 'absolute',
                            inset: 0,
                            width: '100%',
                            height: '100%',
                            pointerEvents: 'none',
                            zIndex: 6,
                        }}
                    >
                        <defs>
                            {(Object.keys(BRUSHES) as Brush[]).map((b) => (
                                <marker
                                    key={b}
                                    id={`arr-${b}`}
                                    markerWidth="3.2"
                                    markerHeight="3.2"
                                    refX="1.7"
                                    refY="1.6"
                                    orient="auto"
                                >
                                    <path d="M0,0 L3.2,1.6 L0,3.2 z" fill={BRUSHES[b]} />
                                </marker>
                            ))}
                        </defs>
                        {(drawing ? [...shapes, drawing] : shapes).map((s, i) => {
                            const color = BRUSHES[s.brush]
                            if (s.from === s.to) {
                                const c = center(s.from)
                                return (
                                    <circle
                                        key={i}
                                        cx={c.x}
                                        cy={c.y}
                                        r={4.3}
                                        fill="none"
                                        stroke={color}
                                        strokeWidth={0.9}
                                        opacity={0.85}
                                    />
                                )
                            }
                            const a = center(s.from)
                            const b = center(s.to)
                            // Knight (L) moves are drawn as cornered arrows, chess.com
                            // style: the long 2-square leg first, then a 90° bend into
                            // the short 1-square leg that carries the head to the target.
                            const dsx = Math.round((b.x - a.x) / 10)
                            const dsy = Math.round((b.y - a.y) / 10)
                            const isKnight =
                                (Math.abs(dsx) === 1 && Math.abs(dsy) === 2) ||
                                (Math.abs(dsx) === 2 && Math.abs(dsy) === 1)
                            if (isKnight) {
                                const sx = Math.sign(dsx)
                                const sy = Math.sign(dsy)
                                const longHoriz = Math.abs(dsx) === 2
                                // Where the two legs meet (turn along the long axis first).
                                const corner = longHoriz
                                    ? { x: b.x, y: a.y }
                                    : { x: a.x, y: b.y }
                                // leg1 = long axis (out of the source); leg2 = short axis (into target).
                                const l1x = longHoriz ? sx : 0
                                const l1y = longHoriz ? 0 : sy
                                const l2x = longHoriz ? 0 : sx
                                const l2y = longHoriz ? sy : 0
                                // Emerge from the source center; stop short so the head tip
                                // lands on the target center (mirrors the straight arrow).
                                const x1 = a.x + l1x * 3
                                const y1 = a.y + l1y * 3
                                const x2 = b.x - l2x * 3
                                const y2 = b.y - l2y * 3
                                const pt = (px: number, py: number) =>
                                    `${px.toFixed(2)},${py.toFixed(2)}`
                                return (
                                    <polyline
                                        key={i}
                                        points={`${pt(x1, y1)} ${pt(corner.x, corner.y)} ${pt(x2, y2)}`}
                                        fill="none"
                                        stroke={color}
                                        strokeWidth={1.7}
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        markerEnd={`url(#arr-${s.brush})`}
                                        opacity={0.85}
                                    />
                                )
                            }
                            const dx = b.x - a.x
                            const dy = b.y - a.y
                            const len = Math.hypot(dx, dy) || 1
                            const ux = dx / len
                            const uy = dy / len
                            // Start just outside the source-square center; stop short so the
                            // arrowhead tip lands at the target-square center.
                            const x1 = a.x + ux * 3
                            const y1 = a.y + uy * 3
                            const x2 = b.x - ux * 3
                            const y2 = b.y - uy * 3
                            return (
                                <line
                                    key={i}
                                    x1={x1}
                                    y1={y1}
                                    x2={x2}
                                    y2={y2}
                                    stroke={color}
                                    strokeWidth={1.7}
                                    strokeLinecap="round"
                                    markerEnd={`url(#arr-${s.brush})`}
                                    opacity={0.85}
                                />
                            )
                        })}
                    </svg>
                )}

                {promo && (
                    <div className="promo-backdrop" onPointerDown={() => setPromo(null)}>
                        <div className="promo" onPointerDown={(e) => e.stopPropagation()}>
                            {PROMO_ORDER.filter((p) => promo.options.includes(p)).map((p) => (
                                <button
                                    key={p}
                                    onClick={() => choosePromotion(p)}
                                    aria-label={`Promote to ${PROMO_NAMES[p] ?? p}`}
                                >
                                    <PieceGlyph
                                        piece={sideToMove === 'w' ? p.toUpperCase() : p}
                                        set={pieceSet}
                                    />
                                </button>
                            ))}
                        </div>
                    </div>
                )}
            </div>

            {coordsOutside && (
                <div className="files-gutter" aria-hidden>
                    {files.map((f) => (
                        <span key={f}>{'abcdefgh'[f]}</span>
                    ))}
                </div>
            )}

            {drag && (
                <span
                    className="drag-ghost"
                    style={{
                        left: drag.x,
                        top: drag.y,
                        width: drag.size,
                        height: drag.size,
                        // Blindfold hides the ghost image too, so a drag can't reveal the piece.
                        backgroundImage: prefs.blindfold
                            ? 'none'
                            : `url(${pieceImageUrl(drag.piece)})`,
                    }}
                />
            )}
        </div>
    )
}
