// PGN import/export. Owns serializing the app's move list to a standards-
// compliant PGN string and parsing pasted PGN back into plain SAN/UCI moves +
// headers. chess.js is the actual PGN engine (parser + movetext writer) — this
// module only shapes headers/defaults and the app-facing result types, plus the
// browser-side download/clipboard helpers. No rules logic lives here.

import { Chess } from 'chess.js'

export const PGN_START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

export interface PgnHeaders {
    Event?: string
    Site?: string
    Date?: string
    Round?: string
    White?: string
    Black?: string
    Result?: string
    // Any other Seven-Tag-Roster-adjacent tag (ECO, TimeControl, Termination, …).
    [tag: string]: string | undefined
}

export interface PgnGame {
    /** Mainline moves in SAN, in order, played from `startFen`. */
    sanMoves: string[]
    /** Start position. Omit (or pass the standard initial FEN) for a normal game. */
    startFen?: string
}

export interface ParsedPgn {
    ok: true
    sanMoves: string[]
    uciMoves: string[]
    startFen: string
    headers: Record<string, string>
    result: string
}

export interface ParsedPgnError {
    ok: false
    error: string
}

export type FromPgnResult = ParsedPgn | ParsedPgnError

function todayTag(): string {
    const d = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`
}

function siteUrl(): string {
    try {
        return window.location.origin
    } catch {
        return 'https://chessgo.timanthonyalexander.de'
    }
}

/**
 * Serialize the app's move list to a PGN string. Sensible Seven Tag Roster
 * defaults are applied first, then overridden by `headers`. chess.js adds the
 * [FEN]/[SetUp] tags itself, only when `startFen` differs from the standard
 * initial position.
 */
export function toPgn(game: PgnGame, headers: PgnHeaders = {}): string {
    const merged: PgnHeaders = {
        Event: 'chessgo',
        Site: siteUrl(),
        Date: todayTag(),
        Round: '-',
        White: '?',
        Black: '?',
        Result: '*',
        ...headers,
    }

    const startFen = game.startFen?.trim()
    let chess: Chess
    try {
        chess = startFen ? new Chess(startFen) : new Chess()
    } catch {
        chess = new Chess() // invalid start FEN — fall back to the standard position
    }

    for (const [key, value] of Object.entries(merged)) {
        if (value !== undefined) chess.header(key, value)
    }

    for (const san of game.sanMoves) {
        try {
            chess.move(san)
        } catch {
            break // stop at the first move that doesn't apply — best effort
        }
    }

    return chess.pgn()
}

/**
 * Parse a pasted PGN into plain SAN/UCI move lists + headers. Tolerates
 * comments, NAGs/glyphs, `%clk`/`%eval` annotations, CRLF, and missing
 * headers; variations are parsed but only the mainline is kept. Never throws.
 */
export function fromPgn(text: string): FromPgnResult {
    if (!text.trim()) {
        return { ok: false, error: 'Paste a PGN first' }
    }

    const chess = new Chess()
    try {
        chess.loadPgn(text, { strict: false })
    } catch (e) {
        return { ok: false, error: (e as Error).message || 'Could not parse this PGN' }
    }

    const headers = chess.getHeaders()
    const sanMoves = chess.history()
    const uciMoves = chess
        .history({ verbose: true })
        .map((m) => m.from + m.to + (m.promotion ?? ''))
    const startFen = headers.SetUp === '1' && headers.FEN ? headers.FEN : PGN_START_FEN
    const result = headers.Result ?? '*'

    return { ok: true, sanMoves, uciMoves, startFen, headers, result }
}

/** Trigger a browser download of `text` as a `.pgn` file named `filename`. */
export function downloadPgn(text: string, filename: string): void {
    const blob = new Blob([text], { type: 'application/x-chess-pgn' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
}

/**
 * Copy `text` to the clipboard, resolving `true`/`false` with whether it
 * worked. Falls back to a hidden-textarea + execCommand copy when the async
 * Clipboard API is unavailable (non-secure contexts).
 */
export async function copyText(text: string): Promise<boolean> {
    if (navigator.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(text)
            return true
        } catch {
            // fall through to the legacy fallback below
        }
    }
    try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.focus()
        ta.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(ta)
        return ok
    } catch {
        return false
    }
}

function slugify(name: string | undefined): string {
    if (!name || name === '?') return ''
    return name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
}

/** e.g. `{ White: 'Alice', Black: 'Bob', Date: '2026.07.28' }` → "chessgo_alice-vs-bob_2026-07-28.pgn" */
export function pgnFilename(headers: { White?: string; Black?: string; Date?: string }): string {
    const white = slugify(headers.White) || 'white'
    const black = slugify(headers.Black) || 'black'
    const date =
        headers.Date && /^\d{4}\.\d{2}\.\d{2}$/.test(headers.Date)
            ? headers.Date.replace(/\./g, '-')
            : todayTag().replace(/\./g, '-')
    return `chessgo_${white}-vs-${black}_${date}.pgn`
}
