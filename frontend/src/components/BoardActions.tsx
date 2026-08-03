import { type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Box } from '@mui/material'
import { Bot, Cpu, Microscope, SquarePen, Telescope } from 'lucide-react'
import { ActionBtn } from './PanelUI'
import { useAuth } from '../lib/auth'

// One shared set of cross-navigation actions so every board can jump to every
// other board context: analyse the game / the position, edit the board, play a
// bot from here, or (admins) pit two engines from here. Wiring the destinations
// in one place keeps the state contracts identical everywhere:
//   - /analysis        ← { moves, startFen }  (replay a game)  or  { startFen }  (a position)
//   - /analysis/:id    ← a persisted game rebuilt server-side
//   - /editor          ← { fen }
//   - /bot             ← { fen }
//   - /engine-vs       ← { fen }  (admin only)
//
// Live / bot / spectated games only mount this at their FINAL state — never
// mid-game — so the engine can't be used as a mid-game analysis crutch.

/** How "Analyse game" should open the full game: either an in-memory move list
 * replayed from a start FEN, or a persisted game id the server rebuilds. */
export type AnalyzeGameRef = { moves: string[]; startFen: string } | { id: string }

export type BoardAction = 'analyze-game' | 'analyze-position' | 'edit' | 'play-bot' | 'engine-vs'

export default function BoardActions({
    fen,
    analyzeGame,
    omit,
    disabled,
    playDisabled,
}: {
    /** The position currently on the board — the seed for edit / play / analyse-position. */
    fen: string
    /** Present → render "Analyse game". Omit for a bare position (editor, puzzle, single pos). */
    analyzeGame?: AnalyzeGameRef | null
    /** Actions to hide — typically the current page's own action (no self-links). */
    omit?: BoardAction[]
    /** Disable every action (e.g. an engine match is mid-run, or the FEN is invalid). */
    disabled?: boolean
    /** Disable only the "play on from here" actions (play-bot + engine-vs) — used when
     *  the position is terminal (checkmate/stalemate), where playing on is pointless. */
    playDisabled?: boolean
}) {
    const navigate = useNavigate()
    const { user } = useAuth()
    const skip = (a: BoardAction) => omit?.includes(a) ?? false

    const openAnalyzeGame = () => {
        if (!analyzeGame) return
        if ('id' in analyzeGame) navigate(`/analysis/${analyzeGame.id}`)
        else navigate('/analysis', { state: { moves: analyzeGame.moves, startFen: analyzeGame.startFen } })
    }

    const items: ReactNode[] = []

    if (analyzeGame && !skip('analyze-game')) {
        items.push(
            <ActionBtn
                key="analyze-game"
                tone="primary"
                icon={<Telescope size={16} />}
                label="Analyse game"
                onClick={openAnalyzeGame}
                disabled={disabled}
            />,
        )
    }
    if (!skip('analyze-position')) {
        items.push(
            <ActionBtn
                key="analyze-position"
                // Headline (gold) unless "Analyse game" already took that slot.
                tone={analyzeGame && !skip('analyze-game') ? 'neutral' : 'primary'}
                icon={<Microscope size={16} />}
                label="Analyse this position"
                onClick={() => navigate('/analysis', { state: { startFen: fen } })}
                disabled={disabled}
            />,
        )
    }
    if (!skip('edit')) {
        items.push(
            <ActionBtn
                key="edit"
                tone="neutral"
                icon={<SquarePen size={16} />}
                label="Edit this board"
                onClick={() => navigate('/editor', { state: { fen } })}
                disabled={disabled}
            />,
        )
    }
    if (!skip('play-bot')) {
        items.push(
            <ActionBtn
                key="play-bot"
                tone="neutral"
                icon={<Bot size={16} />}
                label="Play a bot from here"
                onClick={() => navigate('/bot', { state: { fen } })}
                disabled={disabled || playDisabled}
            />,
        )
    }
    if (user?.role === 'admin' && !skip('engine-vs')) {
        items.push(
            <ActionBtn
                key="engine-vs"
                tone="neutral"
                icon={<Cpu size={16} />}
                label="Engine vs Engine from here"
                onClick={() => navigate('/engine-vs', { state: { fen } })}
                disabled={disabled || playDisabled}
            />,
        )
    }

    if (items.length === 0) return null
    return <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>{items}</Box>
}
