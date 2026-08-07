import {
    type CSSProperties,
    type KeyboardEvent as ReactKeyboardEvent,
    type PointerEvent as ReactPointerEvent,
    type TransitionEvent as ReactTransitionEvent,
    memo,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from 'react'
import { createPortal } from 'react-dom'
import { Sparkles } from 'lucide-react'
import './Board.css'
import type { Color } from '../api/client'
import {
    type BoardMap,
    type Square,
    checkedKings,
    fileOf,
    isWhitePiece,
    kingAttacked,
    parseFen,
    pieceImageUrl,
    premoveTargets,
    promotionsFor,
    rankOf,
    rookCastleMoves,
    squareAt,
    targetsFrom,
} from '../lib/chess'
import { usePieceSet } from '../lib/boardTheme'
import { usePrefs, type ArrowColor } from '../lib/settings'
import { DUCK_FLIGHT, diffBoardsForAnimation, sameBoard, type Flight } from '../lib/pieceAnimation'
import { DuckGlyph } from './DuckGlyph'

function PieceGlyph({ piece, set, hidden }: { piece: string; set: string; hidden?: boolean }) {
    return (
        <span
            // Hidden via `.is-hidden` (visibility), NOT inline opacity: a piece
            // landing on an empty square mounts fresh and so runs `.piece`'s
            // pieceIn keyframes, and animations outrank inline styles in the
            // cascade — an inline opacity:0 would be ignored for exactly as long
            // as the flight lasts, showing a ghost at the destination.
            className={hidden ? 'piece is-hidden' : 'piece'}
            style={{ backgroundImage: `url(${pieceImageUrl(piece, set)})` }}
        />
    )
}

interface ActiveFlight extends Flight {
    key: string
}

// One in-flight piece (or duck) slide. Positioned at its DESTINATION square via
// grid math (no getBoundingClientRect — the board is a perfect 8x8 grid, so a
// square's on-screen position is just its file/rank as a percentage), then
// rendered pre-offset back to its origin with `transition: none` and flipped to
// its resting transform one frame later — a FLIP animation computed instead of
// measured. `onDone` fires from the transform's own `transitionend`, so cleanup
// tracks the real animation length (whatever --piece-anim currently is) rather
// than guessing a matching setTimeout.
function FlightPiece({
    flight,
    set,
    center,
    onDone,
}: {
    flight: ActiveFlight
    set: string
    center: (sq: Square) => { x: number; y: number }
    onDone: () => void
}) {
    const [settled, setSettled] = useState(false)
    // Latest `onDone` behind a ref so the mount effect below can have empty deps —
    // the parent passes a fresh closure every render, which would otherwise restart
    // the fallback timer on each one.
    const doneRef = useRef(onDone)
    doneRef.current = onDone
    useEffect(() => {
        const raf = requestAnimationFrame(() => setSettled(true))
        // Safety net: `transitionend` is the real cleanup signal, but it can be
        // missed (an interrupted transform, a backgrounded tab). A stranded flight
        // keeps its destination square hidden forever, so sweep it well after the
        // longest speed tier (280ms) has elapsed. Cleanup is idempotent.
        const timer = window.setTimeout(() => doneRef.current(), 1500)
        return () => {
            cancelAnimationFrame(raf)
            window.clearTimeout(timer)
        }
    }, [])

    const from = center(flight.from)
    const to = center(flight.to)
    // Deltas expressed as a percentage of ONE SQUARE (the element's own box),
    // since CSS translate() percentages resolve against the element itself —
    // translate(100%, 0) is exactly one square right, regardless of board size.
    const dx = ((from.x - to.x) / 10) * 100
    const dy = ((from.y - to.y) / 10) * 100
    const style: CSSProperties = {
        left: `${((to.x - 5) / 80) * 100}%`,
        top: `${((to.y - 5) / 80) * 100}%`,
        width: '12.5%',
        height: '12.5%',
        transform: settled ? 'translate(0, 0)' : `translate(${dx}%, ${dy}%)`,
        transition: settled ? 'transform var(--piece-anim, 0.16s) ease' : 'none',
    }
    const onTransitionEnd = (e: ReactTransitionEvent) => {
        if (e.propertyName === 'transform') onDone()
    }

    if (flight.piece === DUCK_FLIGHT) {
        return (
            <span className="duck-flight" style={style} onTransitionEnd={onTransitionEnd} aria-hidden>
                <DuckGlyph />
            </span>
        )
    }
    return (
        <span
            className="piece-flight"
            style={{ ...style, backgroundImage: `url(${pieceImageUrl(flight.piece, set)})` }}
            onTransitionEnd={onTransitionEnd}
        />
    )
}

interface BoardProps {
    fen: string
    orientation: Color
    sideToMove: Color
    legalMoves: string[]
    lastMove: { from: Square; to: Square } | null
    /** Opt OUT of the king-in-check glow. The board detects check from the
     * position itself, so this is only for variants where check isn't a concept
     * (Antichess: the king is an ordinary capturable piece). */
    showCheck?: boolean
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
    /** Optional best-move hint: a thin accent ring on the from + to squares. Used by
     * the admin best-move readout. Only ever DISPLAYED while the admin is actively
     * peeking (see `hintReveal`) — so a spectator never sees a standing mark.
     * `uci` (when present) is the full move, so 'G' can play it. */
    hint?: { from: Square; to: Square; uci?: string } | null
    /** Enables the admin hint shortcuts for `hint`: the keyboard 'H' hold-to-peek on
     * desktop (plus a floating press-and-hold pad on touch devices) and 'G' to play
     * the hinted move outright. When false, `hint` is never shown or played. */
    hintReveal?: boolean
    /** External two-stage hint control (the puzzle trainer's hint button), independent
     * of the admin hold-to-peek interaction above. 'piece' rings only `hint.from` (which
     * piece to move); 'move' rings both `hint.from` and `hint.to` (the full move). Unlike
     * `hintReveal`, this stays visible for as long as the page keeps it set — there's no
     * hold/release. Omit/null to leave it out of the render entirely. */
    hintStage?: 'piece' | 'move' | null
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

// Antichess uniquely allows promoting to a KING ('k') — the server only ever
// includes 'k' in a position's legal moves there, so listing it here is safe for
// every other variant: `promo.options` (below) is filtered from the real legal
// moves, so the button simply never appears when 'k' isn't actually legal.
const PROMO_ORDER = ['q', 'r', 'b', 'n', 'k']
// Full piece names for the promotion picker's accessible labels ("Promote to Queen").
const PROMO_NAMES: Record<string, string> = {
    q: 'Queen',
    r: 'Rook',
    b: 'Bishop',
    n: 'Knight',
    k: 'King',
}
// Full piece names for square accessible names ("e4, white pawn") and the move
// live-region announcement ("pawn e2 to e4").
const PIECE_NAMES: Record<string, string> = {
    p: 'pawn',
    n: 'knight',
    b: 'bishop',
    r: 'rook',
    q: 'queen',
    k: 'king',
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

// Lichess-style right-click annotations. A shape with from === to tints the whole
// square (behind the piece); otherwise it's an arrow. The modifier held while
// drawing picks the brush colour.
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
        // No modifier → the user's default color, honored as-is (green means green).
        return base
    }
    // The remaining three colors, in canonical order, fill the modifier slots.
    return ARROW_COLORS.filter((c) => c !== base)[slot - 1]
}

// The pointer's live position is deliberately NOT in here: it changes on every
// pointermove, and putting it in state re-rendered all 64 squares ~120x/second
// just to move one absolutely-positioned ghost. It lives in a ref that DragGhost
// reads inside its own rAF loop instead, so this state only changes when `over`
// crosses into a different square — a few times per drag, not a few hundred.
interface DragState {
    from: Square
    piece: string
    over: Square | null
    size: number
    reselect: boolean
}

// Tuning for the drag-ghost tilt (chess.com-style "picked up piece" feel).
// Numbers are chosen by eye, not measured — a normal drag should read as a
// gentle lean, a fast flick should just kiss the clamp.
const DRAG_TILT_MAX_DEG = 18 // clamp: even a wild flick never looks silly
const DRAG_TILT_GAIN = 12 // deg per (px/ms) of smoothed pointer velocity
const DRAG_VELOCITY_SMOOTHING_MS = 60 // low-pass time constant on raw pointer velocity
const DRAG_SPRING_STIFFNESS = 260 // how hard the angle is pulled toward its target
const DRAG_SPRING_DAMPING = 20 // < critical (2*sqrt(stiffness)) → slight overshoot, then settles

function clampAngle(deg: number): number {
    return Math.max(-DRAG_TILT_MAX_DEG, Math.min(DRAG_TILT_MAX_DEG, deg))
}

// The dragged piece behaves like it's pinned at the cursor and swinging under
// its own weight: horizontal pointer speed sets a target lean, and a damped
// spring chases that target instead of snapping to it — so the rotation
// accelerates in, overshoots a touch, and settles, both on pickup and on
// stopping. Everything below writes `transform` straight to the DOM via a
// ref, never through React state, so a 120Hz pointer doesn't force a
// board-wide re-render once per frame.
function DragGhost({
    posRef,
    size,
    backgroundImage,
}: {
    posRef: { current: { x: number; y: number } }
    size: number
    backgroundImage: string
}) {
    const elRef = useRef<HTMLSpanElement>(null)

    // Place it before the browser's first paint of this mount, or the ghost
    // flashes at the top-left corner for the one frame before rAF takes over.
    // Deliberately NOT a `transform` in the style prop below: React would then
    // own the property and could stomp a frame of the loop's output on any
    // re-render (`over` changing mid-drag), which reads as a jitter.
    useLayoutEffect(() => {
        const el = elRef.current
        if (el)
            el.style.transform = `translate3d(${posRef.current.x}px, ${posRef.current.y}px, 0) translate(-50%, -50%)`
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useEffect(() => {
        // Rotation only — position still tracks the pointer either way, so this
        // can't early-return out of the loop. A CSS media query can't reach the
        // tilt since it's driven inline, hence the JS check.
        const tilt = !window.matchMedia('(prefers-reduced-motion: reduce)').matches

        let raf = 0
        let angle = 0
        let angularVelocity = 0
        let smoothedVx = 0
        let lastX = posRef.current.x
        let lastTime: number | null = null

        // Position and rotation ride on ONE transform (never left/top): a
        // transform-only change is composited, so dragging never dirties layout
        // for the 64 squares sitting under the ghost.
        const paint = () => {
            const el = elRef.current
            if (!el) return
            const { x, y } = posRef.current
            el.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%) rotate(${angle.toFixed(2)}deg)`
        }

        const tick = (now: number) => {
            raf = requestAnimationFrame(tick)
            if (lastTime === null) {
                // First frame just establishes a baseline — nothing to integrate yet.
                lastTime = now
                lastX = posRef.current.x
                paint()
                return
            }
            // Clamp dt so resuming from a backgrounded/stalled tab can't
            // whip the spring with one giant timestep.
            const dtMs = Math.min(now - lastTime, 50)
            lastTime = now
            if (dtMs <= 0) return

            const curX = posRef.current.x
            const rawVx = (curX - lastX) / dtMs // px/ms
            lastX = curX

            if (!tilt) {
                paint() // still follows the pointer, just never leans
                return
            }

            // Low-pass the raw velocity: consecutive rAF samples are noisy
            // (sub-pixel deltas), and unfiltered that noise reads as a jitter
            // in the tilt instead of a clean lean.
            const smoothing = 1 - Math.exp(-dtMs / DRAG_VELOCITY_SMOOTHING_MS)
            smoothedVx += (rawVx - smoothedVx) * smoothing

            // Moving left (negative vx) should trail the bottom of the piece
            // to the right, like a pendulum lagging behind the hand that's
            // carrying it — same sign as vx does exactly that under CSS's
            // rotate() convention, so no extra negation here.
            const target = clampAngle(smoothedVx * DRAG_TILT_GAIN)

            // Damped spring toward `target`: zeta ≈ 0.62 (underdamped), so the
            // angle accelerates toward the target, overshoots slightly, and
            // settles back — never an instant snap.
            const dtSec = dtMs / 1000
            const accel = DRAG_SPRING_STIFFNESS * (target - angle) - DRAG_SPRING_DAMPING * angularVelocity
            angularVelocity += accel * dtSec
            angle += angularVelocity * dtSec

            paint()
        }

        raf = requestAnimationFrame(tick)
        return () => cancelAnimationFrame(raf)
        // Mounts/unmounts with the drag itself (the parent only renders this
        // component while `drag` is non-null) — that's also what gives every
        // new drag a fresh angle/velocity of 0, for free.
    }, [])

    return (
        <span
            ref={elRef}
            className="drag-ghost"
            style={{
                width: size,
                height: size,
                backgroundImage,
            }}
        />
    )
}

// One square's contents. Wrapped in React.memo so a pointer-driven state change
// elsewhere on the board (e.g. `setDrag({ ...drag, over })` firing every time the
// pointer crosses into a new square) only re-renders the handful of squares whose
// OWN props actually changed, instead of rebuilding all 64 `createElement` calls,
// class-array joins, and aria-label strings every time. Every prop below is a
// primitive (string/boolean/number) or a stable reference (a callback/setter that
// doesn't change identity across renders) — an object/array prop recreated fresh
// per render would defeat the memoization outright.
const BoardSquare = memo(function BoardSquare({
    sq,
    classes,
    role,
    ariaLabel,
    tabIndex,
    onFocusSquare,
    setRef,
    markColor,
    markerOn,
    hasPiece,
    hintMarkVisible,
    piece,
    pieceSet,
    pieceHidden,
    showDuck,
    duckHidden,
    showRank,
    showFile,
    rankLabel,
    fileLabel,
}: {
    sq: Square
    classes: string
    role: 'gridcell' | 'cell'
    ariaLabel: string
    tabIndex: number | undefined
    onFocusSquare: ((sq: Square) => void) | undefined
    setRef: (el: HTMLDivElement | null) => void
    markColor: string | undefined
    markerOn: boolean
    hasPiece: boolean
    hintMarkVisible: boolean
    piece: string | undefined
    pieceSet: string
    pieceHidden: boolean
    showDuck: boolean
    duckHidden: boolean
    showRank: boolean
    showFile: boolean
    rankLabel: string
    fileLabel: string
}) {
    return (
        <div
            ref={setRef}
            className={classes}
            role={role}
            aria-label={ariaLabel}
            tabIndex={tabIndex}
            onFocus={onFocusSquare ? () => onFocusSquare(sq) : undefined}
        >
            {markColor && (
                <span className="mark" style={{ '--mark': markColor } as CSSProperties} aria-hidden />
            )}
            {/* Legal-move marker: a dot on an empty square, a ring around an
                occupied (capture) one. ALWAYS mounted and toggled with `.on`,
                never conditionally rendered — that's what lets it scale from 0
                on the way IN and back to 0 on the way OUT. An unmount can't be
                animated, and faking one with a timer would mean holding 64
                squares' worth of exit state in React. */}
            <span className={`${hasPiece ? 'ring' : 'dot'}${markerOn ? ' on' : ''}`} />
            {hintMarkVisible && <span className="hint-mark" />}
            {piece && <PieceGlyph piece={piece} set={pieceSet} hidden={pieceHidden} />}
            {showDuck && (
                <span className={duckHidden ? 'duck is-hidden' : 'duck'} aria-hidden>
                    <DuckGlyph />
                </span>
            )}
            {showRank && <span className="coord rank">{rankLabel}</span>}
            {showFile && <span className="coord file">{fileLabel}</span>}
        </div>
    )
})

function Board({
    fen,
    orientation,
    sideToMove,
    legalMoves,
    lastMove,
    showCheck = true,
    interactive,
    onMove,
    overrideBoard,
    arrow,
    arrow2,
    circle,
    hint,
    hintReveal = false,
    hintStage = null,
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
    // Opt-in keyboard play. Off by default: it makes every square focusable and
    // hands the arrow keys to a board cursor instead of the move list, which is
    // the wrong trade for nearly everyone. The board's ARIA labels and the live
    // region do NOT depend on this — the position stays readable either way.
    const keyboardBoard = prefs.keyboardBoard
    // Move method: 'both' allows drag + click-to-move; 'click' disables drag;
    // 'drag' disables the select-then-tap commit (must drag the piece).
    const allowDrag = prefs.moveMethod !== 'click'
    const allowClick = prefs.moveMethod !== 'drag'
    const [selected, setSelected] = useState<Square | null>(null)
    const [promo, setPromo] = useState<{ from: Square; to: Square; options: string[] } | null>(null)
    const [drag, setDrag] = useState<DragState | null>(null)
    // Live pointer position during a drag — see DragState's comment for why this
    // is a ref and not part of that state.
    const dragPosRef = useRef({ x: 0, y: 0 })
    // Board rect, cached for the duration of a drag. onPointerDown measures it
    // once (it already needs the width for the ghost's size); squareFromPoint
    // reuses that instead of calling getBoundingClientRect() on every native
    // pointermove — a high-polling mouse fires those at 500-1000Hz, and the
    // layout read is real cost repeated for no reason since the board can't
    // resize mid-drag except via the window/scroll, which the effect below
    // guards against. Null outside a drag, so every other squareFromPoint
    // caller (click-to-move, right-click annotations) still gets a fresh rect.
    const dragRectRef = useRef<DOMRect | null>(null)
    // Right-click drawn annotations + the one currently being dragged out.
    const [shapes, setShapes] = useState<Shape[]>([])
    const [drawing, setDrawing] = useState<Shape | null>(null)
    // Admin best-move hint hold-to-reveal: `hint` (from the page) is only DISPLAYED
    // while `peek` is true, so nothing stands on the board for a spectator to notice.
    const [peek, setPeek] = useState(false)
    // The two hint mechanisms are independent: admin hold-to-peek (`peek`) always
    // rings both squares; the puzzle trainer's `hintStage` rings just the FROM
    // square at 'piece' and both at 'move'. Either one being active shows the mark.
    const hintVisible = peek || hintStage != null
    const hintShowTo = peek || hintStage === 'move'

    // --- Keyboard / screen-reader support -----------------------------------
    // `cursor` is the roving-tabindex focus square: independent of `selected` (the
    // piece armed to move). Arrow keys walk `cursor` around the grid; Enter/Space
    // on the cursor square feeds the SAME select/commit machinery pointer input
    // uses (see moveCursor/activateCursor below and commit() further down) — one
    // move-submission path, no forked legality. Default corner is the visual
    // top-left of the CURRENT orientation so it's deterministic without favoring
    // either side.
    const [cursor, setCursor] = useState<Square>(() =>
        squareAt(orientation === 'w' ? 0 : 7, orientation === 'w' ? 7 : 0),
    )
    // Only true while DOM focus actually sits on a square of THIS board — drives
    // the focus ring so it never shows on page load or for a plain mouse click
    // elsewhere. Toggled by the per-square onFocus below and the container's
    // onBlur (checking the move stayed inside the board).
    const [gridFocused, setGridFocused] = useState(false)
    const squareRefs = useRef<Map<Square, HTMLDivElement>>(new Map())
    // One stable ref-callback per square, built once. Passing a fresh inline
    // `ref={(el) => ...}` closure per square on every Board render (the old
    // code) makes React detach+reattach all 64 callback refs on every render,
    // even ones that don't touch this square — a stable per-square setter from
    // this map means a square's ref callback identity never changes.
    const squareRefSetters = useMemo(() => {
        const map = new Map<Square, (el: HTMLDivElement | null) => void>()
        for (let file = 0; file < 8; file++) {
            for (let rank = 0; rank < 8; rank++) {
                const sq = squareAt(file, rank)
                map.set(sq, (el) => {
                    if (el) squareRefs.current.set(sq, el)
                    else squareRefs.current.delete(sq)
                })
            }
        }
        return map
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
    // Stable handler for a square's onFocus (keyboard roving-tabindex) — passed
    // to the memoized BoardSquare so its identity never changes across renders.
    const handleSquareFocus = useCallback((sq: Square) => {
        setCursor(sq)
        setGridFocused(true)
    }, [])
    // Polite live-region text: set on piece selection and on every move that
    // lands (see the effects below) — never on a bare cursor move, which would
    // flood a screen reader on every arrow press.
    const [announcement, setAnnouncement] = useState('')
    const promoRef = useRef<HTMLDivElement>(null)
    // Skip the very first promo-effect run (mount) so opening the page never
    // yanks focus into the board uninvited.
    const promoMountedRef = useRef(false)

    // Annotations are per-position: clear them whenever the position changes.
    useEffect(() => {
        setShapes([])
        setDrawing(null)
    }, [fen])

    // Dismiss the promotion picker on Escape (keyboard accessibility), and — the
    // SAME handler, not a second one — also cancel a keyboard-armed selection so
    // Escape does double duty without a second window listener that could race
    // the picker's own dismissal.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return
            if (promo) setPromo(null)
            if (selected) setSelected(null)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [promo, selected])

    // Move the picker's own keyboard focus in when it opens (its buttons are real
    // <button>s, so Tab/Enter/Space already work — this just saves a Tab press),
    // and hand focus back to the cursor square when it closes so keyboard play
    // continues without hunting for it.
    useEffect(() => {
        if (!promoMountedRef.current) {
            promoMountedRef.current = true
            return
        }
        if (promo) {
            const raf = requestAnimationFrame(() => promoRef.current?.querySelector('button')?.focus())
            return () => cancelAnimationFrame(raf)
        }
        // Only hand focus back to the board when keyboard play is on — otherwise
        // the squares aren't focusable at all and this would move focus nowhere.
        if (keyboardBoard) squareRefs.current.get(cursor)?.focus()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [promo])

    // Desktop peek: press-and-hold 'H' to reveal the best-move hint, release to hide.
    // Matched on `e.code` (PHYSICAL key — identical on QWERTZ and QWERTY); 'KeyH' is a
    // home-row consonant that holds cleanly (macOS press-and-hold only pops the accent
    // picker for vowels). Guarded against typing / key-repeat / modifiers, and
    // force-released on blur or tab-hide so it can never get stuck on.
    useEffect(() => {
        if (!hintReveal) return
        const isPeekKey = (e: KeyboardEvent) =>
            e.code === 'KeyH' && !e.ctrlKey && !e.metaKey && !e.altKey
        const typing = (t: EventTarget | null) => {
            const el = t as HTMLElement | null
            const tag = el?.tagName
            return (
                tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!el?.isContentEditable
            )
        }
        const down = (e: KeyboardEvent) => {
            if (e.repeat || typing(e.target) || !isPeekKey(e)) return
            setPeek(true)
        }
        const up = (e: KeyboardEvent) => {
            if (e.code === 'KeyH') setPeek(false)
        }
        const release = () => setPeek(false)
        window.addEventListener('keydown', down)
        window.addEventListener('keyup', up)
        window.addEventListener('blur', release)
        document.addEventListener('visibilitychange', release)
        return () => {
            window.removeEventListener('keydown', down)
            window.removeEventListener('keyup', up)
            window.removeEventListener('blur', release)
            document.removeEventListener('visibilitychange', release)
            setPeek(false)
        }
    }, [hintReveal])

    // Desktop shortcut: tap 'G' to PLAY the hinted best move (admin). Same submission
    // path as clicking the piece — the hint's UCI already carries any promotion suffix.
    // Kept in a ref so the listener never re-subscribes on a new hint/callback identity.
    const hintUci = hint?.uci
    const playHint = useRef<(() => void) | null>(null)
    playHint.current = interactive && hintUci ? () => onMove(hintUci) : null
    useEffect(() => {
        if (!hintReveal) return
        const down = (e: KeyboardEvent) => {
            if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.code !== 'KeyG') return
            const el = e.target as HTMLElement | null
            const tag = el?.tagName
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable)
                return
            playHint.current?.()
        }
        window.addEventListener('keydown', down)
        return () => window.removeEventListener('keydown', down)
    }, [hintReveal])

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

    // rookCastle pref: rook-square → king-castling-UCI, derived entirely from
    // `legalMoves` (see rookCastleMoves) — so ONLY while it's genuinely our
    // move (`interactive`); during a premove the real legal-move list belongs
    // to the side still to move, not us, and premoveTargets below is already
    // a pseudo-legal geometric guess rather than an engine-backed one, so
    // extending the "never infer castling legality" rule to that guess would
    // just be a second, less-grounded guess. Net effect: premove rook-click
    // castling isn't offered — unchanged from before this pref existed; the
    // king itself remains premovable to its castle square exactly as today.
    // Empty (no-op) whenever the pref is off, so every consumer below is a
    // byte-for-byte no-op too when `rookCastle` is off.
    const rookCastles = useMemo(
        () =>
            interactive && prefs.rookCastle
                ? rookCastleMoves(board, legalMoves, movingColor)
                : new Map<Square, string>(),
        [interactive, prefs.rookCastle, board, legalMoves, movingColor],
    )
    const destsFor = (from: Square): Set<Square> => {
        if (!interactive) return premoveTargets(board, from)
        const dests = targetsFrom(legalMoves, from)
        // A castling-eligible rook additionally targets its OWN KING's square
        // (never a real rook move — you can't move onto your own king — so
        // this can never strand a genuine rook move behind the pref).
        const castleUci = rookCastles.get(from)
        if (castleUci) dests.add(castleUci.slice(0, 2))
        return dests
    }

    // Recomputed only when the selection / legal targets actually change — not on
    // every render (e.g. the continuous setDrag during a drag).
    const targets = useMemo(
        () => (selected ? destsFor(selected) : new Set<Square>()),
        [selected, interactive, legalMoves, board, rookCastles],
    )
    // Check glow, derived from the position on screen rather than from a caller-
    // supplied flag: every board surface (bot games, puzzles, analysis, review,
    // engine-vs-engine) gets it for free and none of them can drift out of sync
    // with the board they're rendering. `checkedKings` tests BOTH kings, so it
    // stays right while scrubbing history or showing an optimistic board, where
    // the side-to-move prop belongs to the live position, not the shown one.
    // Off under blindfold, where a glow on the king's square would give away the
    // one piece the mode most obviously hides.
    const checkKings = useMemo(
        () =>
            showCheck && prefs.highlightCheck && !prefs.blindfold
                ? new Set(checkedKings(board, duck))
                : new Set<Square>(),
        [showCheck, prefs.highlightCheck, prefs.blindfold, board, duck],
    )
    // The dragged piece's legal destinations, built ONCE per drag instead of
    // per square: the drag-over highlight and the grow-on-hover marker both
    // need this set, so calling destsFor() inline in the square loop meant 128
    // Set constructions on every single re-render.
    const dragDests = useMemo(
        () => (drag ? destsFor(drag.from) : null),
        [drag?.from, interactive, legalMoves, board, rookCastles],
    )

    // Live-region announcement: piece selection (armed to move — from ANY input,
    // pointer or keyboard) and every move that actually lands, from ANY source —
    // pointer, drag, keyboard, a remote opponent's move over the socket, or
    // scrubbing move history — since `fen`/`lastMove` are the props
    // every one of those paths already updates. Never fires on a bare cursor
    // move (see moveCursor below), which would flood a screen reader.
    useEffect(() => {
        if (!selected) return
        const piece = board[selected]
        const name = piece ? (PIECE_NAMES[piece.toLowerCase()] ?? 'piece') : 'piece'
        setAnnouncement(`Selected ${name} on ${selected}`)
    }, [selected])

    const prevFenRef = useRef<string | null>(null)
    useEffect(() => {
        const prevFen = prevFenRef.current
        prevFenRef.current = fen
        if (!lastMove || prevFen === null || prevFen === fen) return
        const piece = board[lastMove.to] // occupant AFTER the move has landed
        const name = piece ? (PIECE_NAMES[piece.toLowerCase()] ?? 'piece') : 'piece'
        const noMoves = legalMoves.length === 0
        // Position AND side to move both read off `fen`, so the two can't
        // disagree — unlike the `sideToMove` prop, which belongs to the live
        // game even while an earlier ply is on screen.
        const checked = showCheck && kingAttacked(parseFen(fen), fen.split(' ')[1] !== 'b', duck)
        const suffix = checked ? (noMoves ? ', checkmate' : ', check') : ''
        setAnnouncement(`${name} ${lastMove.from} to ${lastMove.to}${suffix}`)
    }, [fen, lastMove, board, showCheck, duck, legalMoves.length])

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
    // Square annotations (right-click without dragging) are a full-square tint
    // painted UNDER the piece, so they live on the square itself rather than in
    // the arrow overlay — that SVG sits above the pieces.
    // Deliberately ignores `drawing`: an arrow starts life as from === to, so
    // previewing it would flash the square tint under the pointer on every
    // right-press. A square only tints once the press is RELEASED on it.
    const marks = useMemo(() => {
        const m = new Map<Square, string>()
        for (const s of shapes) {
            if (s.from === s.to) m.set(s.from, BRUSHES[s.brush])
        }
        return m
    }, [shapes])

    // Piece-slide animation: diff the previous board snapshot against this one
    // and play the resulting flights. Position-diff-based (see pieceAnimation.ts),
    // so it fires identically for a local move, an opponent's move arriving over
    // the socket, spectating, and stepping through move-list history either way
    // in Analysis/Puzzles — there is no separate "remote move" code path.
    const [flights, setFlights] = useState<ActiveFlight[]>([])
    const prevBoardRef = useRef<BoardMap | null>(null)
    const prevDuckRef = useRef<Square | null>(null)
    const flightIdRef = useRef(0)
    // Set by a local drag-drop commit for the exact (from, to) it just placed —
    // that piece already visually traveled under the cursor, so the next diff
    // should settle it instantly rather than replaying a redundant slide. A
    // click-to-move commit leaves this null, since the piece hasn't moved yet.
    const suppressPairRef = useRef<{ from: Square; to: Square } | null>(null)

    // useLayoutEffect, NOT useEffect: this must run before the browser paints the
    // new position. A passive effect is flushed in a later task, so a board change
    // coming from a DISCRETE event (our own click/keypress commit) gets painted
    // once with the piece already sitting on its destination and no flight yet —
    // then the slide starts, and the piece reads as doubled. Updates from async
    // sources (the socket — i.e. the opponent's move) had their passive effect
    // flushed before that first paint, which is why only our OWN moves flickered.
    useLayoutEffect(() => {
        const prevBoard = prevBoardRef.current
        const prevDuck = prevDuckRef.current
        const duckNow = duck ?? null
        prevBoardRef.current = board
        prevDuckRef.current = duckNow

        // First mount, or animations off: snap straight to the new position.
        if (!prevBoard || prefs.animationSpeed === 'none') {
            setFlights([])
            return
        }

        // Same position, new object: a re-render, not a move. Our OWN moves land
        // here — the optimistic overlay shows the move (starting the flight), then
        // the authoritative FEN echoes back and `board` is re-parsed into an equal
        // but distinct BoardMap. Clearing the flight list on that no-op diff is what
        // made your own moves snap while everyone else's slid, so leave any running
        // flight alone and let it finish.
        if (sameBoard(prevBoard, board) && prevDuck === duckNow) return

        let next = diffBoardsForAnimation(prevBoard, board)

        const suppressed = suppressPairRef.current
        if (suppressed) {
            const before = next.length
            next = next.filter((f) => !(f.from === suppressed.from && f.to === suppressed.to))
            // Only consume the suppression once it actually matched a flight —
            // if an unrelated diff (e.g. the opponent's move) lands first, keep
            // it queued for the transition it was really meant for.
            if (next.length !== before) suppressPairRef.current = null
        }

        // The duck isn't part of BoardMap (it's a standalone square prop), so it
        // gets its own flight, appended alongside whatever piece(s) moved.
        if (prevDuck && duckNow && prevDuck !== duckNow) {
            next = [...next, { from: prevDuck, to: duckNow, piece: DUCK_FLIGHT }]
        }

        setFlights(next.map((f) => ({ ...f, key: `f${flightIdRef.current++}` })))
        // Deliberately not exhaustive: `prefs.animationSpeed` is read as a
        // point-in-time gate above, not a reactive trigger — changing the
        // setting mid-flight shouldn't retroactively cancel an animation that
        // already started under the previous setting.
    }, [board, duck])

    const animatingTo = useMemo(() => {
        const set = new Set<Square>()
        for (const f of flights) if (f.piece !== DUCK_FLIGHT) set.add(f.to)
        return set
    }, [flights])
    const duckFlightTo = flights.find((f) => f.piece === DUCK_FLIGHT)?.to ?? null

    function endFlight(key: string) {
        setFlights((prev) => prev.filter((f) => f.key !== key))
    }

    const ranks = orientation === 'w' ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7]
    const files = orientation === 'w' ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0]

    // Cheap insurance against the cached drag rect above going stale: a resize
    // or scroll mid-drag (rare, but not impossible) re-measures it. Keyed on
    // whether a drag is active (a boolean, not `drag` itself) so this doesn't
    // tear down and re-attach the listeners on every `over` change.
    const dragActive = !!drag
    useEffect(() => {
        if (!dragActive) return
        const invalidate = () => {
            if (boardRef.current) dragRectRef.current = boardRef.current.getBoundingClientRect()
        }
        window.addEventListener('resize', invalidate)
        window.addEventListener('scroll', invalidate, true)
        return () => {
            window.removeEventListener('resize', invalidate)
            window.removeEventListener('scroll', invalidate, true)
        }
    }, [dragActive])

    function squareFromPoint(cx: number, cy: number): Square | null {
        // During a drag, reuse the rect cached at pointer-down instead of
        // measuring layout again on every pointermove.
        const r = dragRectRef.current ?? boardRef.current?.getBoundingClientRect()
        if (!r) return null
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

    function commit(from: Square, to: Square, viaDrag = false) {
        // A dragged piece already visually traveled under the cursor — don't
        // replay a slide once the confirmed board state reflects this move.
        // A click-to-move commit hasn't moved yet, so it's left to animate.
        if (viaDrag) suppressPairRef.current = { from, to }
        // rookCastle: `from` is a castling-eligible rook and `to` is its own
        // king's square (see rookCastleMoves) — send the KING's real UCI
        // move, never a synthetic rook-to-king string; the engine only ever
        // accepts the king-two-square castling encoding.
        const castleUci = rookCastles.get(from)
        if (castleUci && castleUci.slice(0, 2) === to) {
            setSelected(null)
            onMove(castleUci)
            return
        }
        if (interactive) {
            const options = promotionsFor(legalMoves, from, to)
            if (options.length > 0) {
                // Auto-queen preference skips the picker and promotes to a queen
                // directly (matching the premove behavior below).
                if (prefs.autoQueen) {
                    setSelected(null)
                    onMove(`${from}${to}q`)
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

    // Walk the roving-tabindex cursor one square in a VISUAL direction (dCol/dRow
    // are screen-space: +1 col = right, +1 row = down), translated to file/rank
    // deltas per `orientation` so ArrowRight always means visually right even on
    // a flipped board. Clamps at the edge rather than wrapping.
    function moveCursor(dCol: number, dRow: number) {
        const fileDelta = orientation === 'w' ? dCol : -dCol
        const rankDelta = orientation === 'w' ? -dRow : dRow
        const nf = Math.min(7, Math.max(0, fileOf(cursor) + fileDelta))
        const nr = Math.min(7, Math.max(0, rankOf(cursor) + rankDelta))
        const next = squareAt(nf, nr)
        if (next === cursor) return
        setCursor(next)
        // Roving tabindex needs an explicit focus move; deferred one frame so the
        // tabIndex swap (old cell -1, new cell 0) has committed to the DOM first.
        requestAnimationFrame(() => squareRefs.current.get(next)?.focus())
    }

    // Enter/Space on the cursor square — the keyboard counterpart to a pointer tap.
    // Mirrors onPointerDown's branching EXACTLY (duck-placement → drop-arm →
    // normal select/commit) and calls the very same ownPieceAt/targets/commit
    // functions, so there is one move-submission path, not a forked one.
    function activateCursor() {
        if (promo) return
        const sq = cursor
        if (duckPlacing) {
            if (duckTargets?.has(sq)) onPlaceDuck?.(sq)
            return
        }
        if (dropTargets != null) {
            if (dropTargets.has(sq)) {
                onDrop?.(sq)
                return
            }
            onDropCancel?.()
            // fall through — the same activation may instead pick up a board piece
        }
        if (!inputEnabled) return
        if (selected && rookCastles.get(selected)?.slice(0, 2) === sq) {
            // rookCastle: the king's own square doubles as a legit target for a
            // selected castling rook (see destsFor) but the king square ALSO
            // satisfies ownPieceAt below (it's a real own piece) — checked
            // first so activating it commits the castle instead of just
            // reselecting to the king.
            commit(selected, sq)
        } else if (ownPieceAt(sq)) {
            setSelected(sq)
        } else if (selected && targets.has(sq)) {
            commit(selected, sq)
        } else {
            setSelected(null)
            if (premoveActive) onCancelPremove?.()
        }
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
            if (sq) setCursor(sq) // keep the roving-tabindex cursor in sync with pointer input
            if (sq && duckTargets?.has(sq)) onPlaceDuck?.(sq)
            return
        }

        // Crazyhouse: a pocket piece is armed. Clicking a legal drop square drops it;
        // any other click clears the selection and falls through to normal input (so
        // the same click can instead pick up a board piece).
        if (dropTargets != null) {
            const sq = squareFromPoint(e.clientX, e.clientY)
            if (sq) setCursor(sq)
            if (sq && dropTargets.has(sq)) {
                onDrop?.(sq)
                return
            }
            onDropCancel?.()
        }

        if (!inputEnabled) return
        const sq = squareFromPoint(e.clientX, e.clientY)
        if (!sq) return
        setCursor(sq) // keep the roving-tabindex cursor in sync with pointer input

        if (allowClick && selected && rookCastles.get(selected)?.slice(0, 2) === sq) {
            // rookCastle: same precedence fix as activateCursor — the king's
            // square is both a legal target for the selected castling rook
            // AND a real own piece, so it must be checked before the
            // ownPieceAt/reselect branch below, or a second click meant to
            // finish the castle would just reselect to the king instead.
            commit(selected, sq)
        } else if (ownPieceAt(sq)) {
            e.preventDefault()
            // Drag is suppressed in click-to-move-only mode; the piece still
            // selects so the second click can commit.
            if (allowDrag) {
                const rect = boardRef.current?.getBoundingClientRect() ?? null
                dragRectRef.current = rect
                const size = (rect?.width ?? 0) / 8
                try {
                    boardRef.current?.setPointerCapture(e.pointerId)
                } catch {
                    /* ignore */
                }
                dragPosRef.current = { x: e.clientX, y: e.clientY }
                setDrag({
                    from: sq,
                    piece: board[sq],
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
        // The ghost reads this ref in its own rAF loop — no state, no re-render.
        dragPosRef.current = { x: e.clientX, y: e.clientY }
        // Only the square the pointer is OVER is React's business, and only when
        // it actually changes: that's the difference between re-rendering the
        // board a handful of times per drag and doing it on every pointer sample.
        const over = squareFromPoint(e.clientX, e.clientY)
        if (over !== drag.over) setDrag({ ...drag, over })
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
        dragRectRef.current = null
        if (dropSq === d.from) {
            // Released on the origin square — a plain tap, not a drag.
            if (d.reselect) setSelected(null) // tapped an already-selected piece → toggle off
            // else: keep it selected (dots shown)
        } else if (dropSq && destsFor(d.from).has(dropSq)) {
            commit(d.from, dropSq, true)
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

    // Board-level keyboard nav (event delegation on the container, mirroring the
    // single onPointerDown/Move/Up above rather than one handler per square).
    // Arrows move the cursor; Enter/Space activate it. Both call
    // preventDefault + stopPropagation so the SAME keypress can't also reach the
    // window-level move-nav shortcut registry (lib/shortcuts.ts binds
    // ArrowLeft/Right/Up/Down/Home/End globally for move-history scrubbing on
    // several pages) — stopping native propagation here means that listener
    // simply never sees the event while a square on this board holds focus; when
    // focus is elsewhere the event never reaches this handler at all, so
    // move-nav keeps working exactly as today. Escape is deliberately NOT handled
    // here: Board already owns a single window Escape listener (promo dismiss +
    // selection cancel, above) — adding a second one that stops propagation would
    // race it, so this handler just lets Escape bubble to that listener.
    // While the promotion picker is open, its real <button>s already handle
    // Enter/Space/Tab themselves — don't intercept.
    function onBoardKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
        // Opt-in only. With the pref off the squares aren't focusable, so this
        // handler is unreachable in practice — but bail explicitly anyway, so
        // arrow keys are guaranteed to keep bubbling to the window-level
        // move-nav registry rather than being swallowed here.
        if (!keyboardBoard) return
        if (promo) return
        switch (e.key) {
            case 'ArrowLeft':
                e.preventDefault()
                e.stopPropagation()
                moveCursor(-1, 0)
                return
            case 'ArrowRight':
                e.preventDefault()
                e.stopPropagation()
                moveCursor(1, 0)
                return
            case 'ArrowUp':
                e.preventDefault()
                e.stopPropagation()
                moveCursor(0, -1)
                return
            case 'ArrowDown':
                e.preventDefault()
                e.stopPropagation()
                moveCursor(0, 1)
                return
            case 'Enter':
            case ' ':
            case 'Spacebar':
                e.preventDefault()
                e.stopPropagation()
                activateCursor()
        }
    }

    const coordsOutside = prefs.showCoordinates === 'outside'
    // Describes the position at a glance for a screen-reader user landing on the
    // board: whose turn it is (the actual game state, independent of whether
    // THIS client can move right now) and which side is nearest the viewer.
    const boardAriaLabel = `Chess board, ${sideToMove === 'w' ? 'White' : 'Black'} to move, ${
        orientation === 'w' ? 'White' : 'Black'
    } at the bottom`

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
                // Grid semantics chosen over 64 individual <button>s: the container
                // already owns pointer hit-testing (one delegated handler, not one
                // per square — see onPointerDown), 64 focusable buttons would make
                // screen-reader browse mode unusable on an 8x8 (every cell stealing
                // linear Tab/arrow focus meant for the page), and role="grid" +
                // roving tabindex (one square tabIndex=0, the rest -1) is the
                // standard accessible pattern for a 2D cell matrix (ARIA APG "Grid").
                // "grid" is the INTERACTIVE matrix role and promises arrow-key
                // navigation, so it's only honest while keyboard play is on.
                // With the pref off the board is still fully readable, just
                // static — which is exactly what "table" means.
                role={keyboardBoard ? 'grid' : 'table'}
                aria-label={boardAriaLabel}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={() => {
                    setDrag(null)
                    setDrawing(null)
                    dragRectRef.current = null
                }}
                onContextMenu={(e) => e.preventDefault()}
                onKeyDown={onBoardKeyDown}
                onBlur={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setGridFocused(false)
                }}
            >
                {ranks.map((rank) => (
                    // display:contents so this wrapper (needed for the role="row"
                    // semantic) doesn't itself become a grid item — its children
                    // still lay out as direct children of the CSS Grid above.
                    <div role="row" key={`rank-${rank}`} style={{ display: 'contents' }}>
                        {files.map((file) => {
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
                            // Dot/ring grow-on-drag-over. `isOver` is the same condition
                            // PLUS the highlightDragOver pref gate — the marker growing
                            // isn't the opt-in "square ring" preference, it's feedback on
                            // a marker that's already shown.
                            const dragTarget = !!drag && drag.over === sq && !!dragDests?.has(sq)
                            const isOver = dragTarget && prefs.highlightDragOver
                            const isCursor = cursor === sq
                            const classes = [
                                'sq',
                                light ? 'light' : 'dark',
                                inputEnabled ? 'interactive' : '',
                                // Occupancy as a plain class instead of a `:has(.piece)`
                                // selector in Board.css — `:has()` is relational and
                                // forces wider style invalidation on every piece
                                // mount/unmount; this is computed here anyway.
                                piece ? 'has-piece' : '',
                                selected === sq ? 'sel' : '',
                                isLast ? 'last' : '',
                                isPremove ? 'premove' : '',
                                isOver ? 'over' : '',
                                dragTarget ? 'dragTarget' : '',
                                checkKings.has(sq) ? 'check' : '',
                                keyboardBoard && isCursor && gridFocused ? 'focus-ring' : '',
                            ]
                                .filter(Boolean)
                                .join(' ')

                            // Accessible name: square + occupant, plus whichever
                            // states apply — read by VoiceOver/NVDA as the cell is
                            // focused (Tab in, or an arrow-key cursor move).
                            const occupantName = piece
                                ? `${isWhitePiece(piece) ? 'white' : 'black'} ${
                                      PIECE_NAMES[piece.toLowerCase()] ?? piece
                                  }`
                                : 'empty'
                            const stateBits = [
                                selected === sq && 'selected',
                                prefs.showLegalMoves && isTarget && 'legal move',
                                isDuckTarget && 'duck placement target',
                                isDropTarget && 'drop target',
                                isLast && 'last move',
                                checkKings.has(sq) && 'king in check',
                            ].filter(Boolean) as string[]
                            const squareAriaLabel = `${sq}, ${occupantName}${
                                stateBits.length ? `, ${stateBits.join(', ')}` : ''
                            }`

                            // Whether this square's legal-move marker is currently shown
                            // (see the always-mounted <span> below). Duck/drop targets are
                            // empty-square-only modes, hence the extra !piece.
                            const markerOn =
                                (prefs.showLegalMoves && isTarget) ||
                                ((isDuckTarget || isDropTarget) && !piece)

                            // In-square coordinates only in 'inside' mode ('outside' draws
                            // them in the gutter layer below; 'off' hides them entirely).
                            const coordsInside = prefs.showCoordinates === 'inside'
                            const showFile =
                                coordsInside && (orientation === 'w' ? rank === 0 : rank === 7)
                            const showRank =
                                coordsInside && (orientation === 'w' ? file === 0 : file === 7)

                            return (
                                <BoardSquare
                                    key={sq}
                                    sq={sq}
                                    classes={classes}
                                    role={keyboardBoard ? 'gridcell' : 'cell'}
                                    ariaLabel={squareAriaLabel}
                                    // Roving tabindex: only the cursor square is Tab-reachable;
                                    // arrow keys move both `cursor` and real DOM focus (see
                                    // moveCursor), so Tab always lands where the user left off.
                                    //
                                    // With keyboard play off we omit tabIndex ENTIRELY rather
                                    // than setting -1: a plain <div> with no tabIndex isn't
                                    // focusable at all, so clicking a square can't leave a focus
                                    // ring and Tab walks straight past the board, exactly as
                                    // before any of this existed.
                                    tabIndex={keyboardBoard ? (isCursor ? 0 : -1) : undefined}
                                    onFocusSquare={keyboardBoard ? handleSquareFocus : undefined}
                                    setRef={squareRefSetters.get(sq)!}
                                    markColor={marks.get(sq)}
                                    markerOn={markerOn}
                                    hasPiece={!!piece}
                                    hintMarkVisible={
                                        !!hintVisible &&
                                        !!hint &&
                                        (hint.from === sq || (hintShowTo && hint.to === sq))
                                    }
                                    piece={piece}
                                    pieceSet={pieceSet}
                                    pieceHidden={isDragOrigin || prefs.blindfold || animatingTo.has(sq)}
                                    showDuck={duck === sq}
                                    duckHidden={duckFlightTo === sq}
                                    showRank={showRank}
                                    showFile={showFile}
                                    rankLabel={String(rank + 1)}
                                    fileLabel={'abcdefgh'[file]}
                                />
                            )
                        })}
                    </div>
                ))}

                {flights.map((f) => (
                    <FlightPiece
                        key={f.key}
                        flight={f}
                        set={pieceSet}
                        center={center}
                        onDone={() => endFlight(f.key)}
                    />
                ))}

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
                            // from === to is a square tint, drawn on the square itself
                            // (see `marks`), not here.
                            if (s.from === s.to) return null
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
                        <div ref={promoRef} className="promo" onPointerDown={(e) => e.stopPropagation()}>
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

            {/* Polite live region for move/selection announcements (screen readers
                only — visually hidden). Never touched on a bare cursor move. */}
            <div className="sr-only" aria-live="polite" aria-atomic="true">
                {announcement}
            </div>

            {coordsOutside && (
                <div className="files-gutter" aria-hidden>
                    {files.map((f) => (
                        <span key={f}>{'abcdefgh'[f]}</span>
                    ))}
                </div>
            )}

            {drag && (
                <DragGhost
                    posRef={dragPosRef}
                    size={drag.size}
                    // Blindfold hides the ghost image too, so a drag can't reveal the piece.
                    backgroundImage={prefs.blindfold ? 'none' : `url(${pieceImageUrl(drag.piece)})`}
                />
            )}

            {/* Touch peek pad (admin): the mobile counterpart to the desktop 'H' hold.
                A floating press-and-hold button — held reveals the hint, released hides
                it. PORTALED to <body> so no CSS container / transform / overflow ancestor
                can break its `position: fixed` or clip it (the board's own wrapper is a
                CSS container). Shown ONLY on touch devices via CSS (desktop uses 'H'). */}
            {hintReveal &&
                createPortal(
                    <button
                        type="button"
                        className={`peek-pad${peek ? ' active' : ''}`}
                        aria-label="Hold to reveal the engine best move"
                        onPointerDown={(e) => {
                            e.preventDefault()
                            try {
                                e.currentTarget.setPointerCapture(e.pointerId)
                            } catch {
                                /* ignore */
                            }
                            setPeek(true)
                        }}
                        onPointerUp={() => setPeek(false)}
                        onPointerCancel={() => setPeek(false)}
                        onContextMenu={(e) => e.preventDefault()}
                    >
                        <Sparkles size={20} />
                    </button>,
                    document.body,
                )}
        </div>
    )
}

// Memoized so a caller re-rendering for unrelated reasons (e.g. a parent's own
// state tick) doesn't force this whole 64-square tree to re-render when none of
// Board's own props changed. Only pays off if the caller passes stable
// references for object/array/function props (fen/legalMoves/lastMove/etc.) —
// see the page component wiring those up.
export default memo(Board)
