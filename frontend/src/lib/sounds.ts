// Self-contained sound engine — no audio files, no licensing concerns. The move
// and capture sounds are recreations of Lichess's "standard" set (which is
// all-rights-reserved and can't be shipped), built with physically-informed
// MODAL SYNTHESIS: a struck wooden body is a small bank of decaying, INHARMONIC
// sine "modes" (free-free-bar ratios 1 : 2.756 : 5.404, per Fletcher & Rossing /
// the STK toolkit) excited by one soft, lowpassed "contact" noise burst. Highs
// decay fastest (that's what reads as "wood"), onsets are soft ~ms ramps (a hard
// step would splatter broadband = a digital "click"), and voices are detuned +
// onset-staggered with real gain headroom so the in-phase sum never clips.
//
// LowTime is two staggered synthy notes; the game-end "ding" is Lichess's
// GenericNotify bell (which standard also uses for win/loss/draw). The
// AudioContext is created lazily on the first sound (always after a gesture).

import { type BoardMap, fileOf } from './chess'
import { type MaterialId, soundThemeStore } from './soundTheme'
import { settingsStore } from './settings'

let ctx: AudioContext | null = null
let master: GainNode | null = null

// Master on/off now lives in the unified prefs blob (settings.ts) as `soundEnabled`
// — it used to be a standalone `chessgo.sound` localStorage key with its own module
// variable here; settingsStore.init() migrates that old key once (see its
// migrateSoundEnabled()). Read live rather than cached so it's correct even before
// this module has seen a gesture, and so a settingsStore.reset() takes effect with
// no extra wiring.
const isEnabled = (): boolean => settingsStore.get('soundEnabled')

// The engine's headroom ceiling — the master gain at 100% volume. Per-voice gains
// are tuned so the in-phase sum stays clear of clipping at this level; the volume
// preference scales linearly from 0 to this. (Was a hard-coded 0.8.)
const MASTER_CEILING = 0.8

/** Master gain for the current volume preference (0–100 → 0–MASTER_CEILING). */
function masterGain(): number {
    const vol = settingsStore.get('soundVolume')
    return (MASTER_CEILING * Math.min(100, Math.max(0, vol))) / 100
}

/** Push the current volume preference onto the live master node (if built). */
function applyMasterVolume(): void {
    if (master) master.gain.value = masterGain()
}

// True once a REAL user gesture has touched the audio graph. Until then we never
// create/resume an AudioContext or emit a sound — because audio emitted without a
// gesture is an "autoplay attempt", and Safari permanently demotes a domain's
// per-site Auto-Play permission when it sees those (persisting across refresh,
// tab close, even a browser restart — it's stored by Safari, not the page). A
// bot/opponent move arriving over WebSocket before you've clicked is exactly such
// an attempt, so we suppress sound entirely until the first gesture arms us.
let armed = false

// Every voice is scheduled at `currentTime + LOOKAHEAD` so its attack envelope
// is always strictly in the future relative to the audio render head. Scheduling
// exactly at currentTime lets a busy main thread drop the first render quantum
// (the soft attack), which reads as a click or a partial dropout. 15ms is below
// the threshold of "lag" for a move cue but comfortably past the quantum.
const LOOKAHEAD = 0.015

// KEEP-ALIVE — the single most important thing for INSTANT sound on Safari.
//
// Safari/CoreAudio puts the output audio *unit* to sleep after a short spell of
// silence. Between moves the board is silent, so the unit idles; the next move
// cue then has to WAKE the DAC first, and that wake-up is a few-hundred-ms stall
// you hear as "the sound arrives half a second late." It recurs on every move
// because every quiet gap re-idles the unit. (This is distinct from the context
// being 'suspended'/'interrupted' — the context can be 'running' with currentTime
// advancing while the hardware unit is asleep.)
//
// The fix every audio library uses ("warm up with silence"): keep one INAUDIBLE
// source rendering to the output forever, so the unit never sleeps and every real
// sound plays immediately. A very-low-frequency, near-zero-gain oscillator is
// enough continuous work to hold the unit open while being completely silent (a
// pure-zero signal risks being optimised away). It's global — every BoardPage
// shares the one AudioContext, so this makes sound instant on ALL of them at once,
// with no per-page wiring.
//
// Strictly FOREGROUND-ONLY and gated: started only AFTER a real gesture (`armed`),
// only while sound is `enabled`, and only while the tab is VISIBLE. Running it in a
// backgrounded tab is what caused the "indicator on but silent, and two chessgo
// tabs fight" bug: an always-rendering source forces the context to 'running' even
// after Safari has grabbed the single output session for another tab, which masks
// the interruption from resume() (a no-op on a 'running' context) and pins the
// audio indicator. Foreground-only + suspend-on-hide (below) makes tabs take turns
// cleanly instead of wedging each other.
let keepAlive: { osc: OscillatorNode; gain: GainNode } | null = null

function startKeepAlive(): void {
    if (keepAlive || !armed || !isEnabled()) return
    if (typeof document !== 'undefined' && document.hidden) return
    const a = audio()
    if (!a) return
    try {
        const osc = a.c.createOscillator()
        osc.frequency.value = 1 // sub-audible; the point is continuous render work, not a tone
        const g = a.c.createGain()
        g.gain.value = 0.00001 // inaudible, but non-zero so it isn't elided as silence
        osc.connect(g).connect(a.c.destination) // straight to output, independent of the master bus
        osc.start()
        keepAlive = { osc, gain: g }
    } catch {
        /* never let the keep-alive break sound */
    }
}

function stopKeepAlive(): void {
    if (!keepAlive) return
    try {
        keepAlive.osc.stop()
        keepAlive.osc.disconnect()
        keepAlive.gain.disconnect()
    } catch {
        /* ignore */
    }
    keepAlive = null
}

/** Thin delegate to settingsStore's `soundEnabled` — kept so every existing call
 * site (this module's own guards, plus every UI reading the master toggle) is
 * unchanged. ThemeDialog now reads the same value reactively via usePrefs(). */
export function soundEnabled(): boolean {
    return isEnabled()
}

export function setSoundEnabled(on: boolean): void {
    settingsStore.set('soundEnabled', on)
    // Only hold the audio unit awake while we actually make sound. Muting releases
    // it (power + no tab audio indicator); unmuting re-warms it so the very next
    // move cue is instant. No-op until the first gesture arms us.
    if (on) startKeepAlive()
    else stopKeepAlive()
}

// ONE AudioContext for the whole page lifetime. We deliberately NEVER close and
// recreate it: Safari leaks closed contexts (there's a per-page cap), and a fresh
// context built outside a user gesture comes up muted and can't be reliably
// un-muted. Keeping a single context and resuming it — from a gesture — is the
// only thing that survives Safari's interruptions. See the lifecycle block below.
function audio(): { c: AudioContext; out: GainNode } | null {
    if (typeof window === 'undefined') return null
    // Don't even create the context before the first gesture — see `armed`. This is
    // the single most important rule for staying in Safari's good graces.
    if (!armed) return null
    if (!ctx) {
        const Ctor =
            window.AudioContext ||
            (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
        if (!Ctor) return null
        ctx = new Ctor()
        // Real headroom instead of a brickwall limiter: per-voice gains are small and
        // the master sits below unity, so the in-phase sum stays clear of clipping.
        master = ctx.createGain()
        master.gain.value = masterGain()
        master.connect(ctx.destination)
    }
    // Resume on ANY non-running state, not just 'suspended'. Safari/iOS park the
    // context in 'interrupted' whenever OUR tab is backgrounded/occluded, or after a
    // screen lock / long idle; Chrome uses 'suspended'. resume() is a no-op when running.
    // It may reject on an interrupted context — that's fine, the gesture handler
    // below is what actually recovers it; we just never want to throw here.
    if (ctx.state !== 'running') void ctx.resume().catch(() => {})
    return { c: ctx, out: master! }
}

function noiseBuffer(c: AudioContext, seconds: number): AudioBuffer {
    const len = Math.floor(c.sampleRate * seconds)
    const buf = c.createBuffer(1, len, c.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
    return buf
}

// A decaying tone with a soft onset — used for the bell ding and the low-time
// notes. Optional downward pitch glide.
interface Body {
    freq: number
    dur: number
    gain: number
    type?: OscillatorType
    at?: number
    glide?: number
}
function body({ freq, dur, gain, type = 'sine', at = 0, glide = 0 }: Body): void {
    const a = audio()
    if (!a) return
    const { c, out } = a
    const t = c.currentTime + LOOKAHEAD + at
    const o = c.createOscillator()
    o.type = type
    o.frequency.setValueAtTime(freq, t)
    if (glide) o.frequency.exponentialRampToValueAtTime(freq * glide, t + dur)
    const g = c.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(gain, t + 0.003)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    o.connect(g).connect(out)
    o.start(t)
    o.stop(t + dur + 0.02)
}

// One struck resonance MODE: a sine with a soft (no-click) onset that rings down
// exponentially — i.e. a damped sinusoid. A small detune + sub-ms stagger keeps
// modes from summing in phase into a clip.
interface Mode {
    freq: number
    dur: number
    gain: number
    at?: number
    detune?: number
    attack?: number
    // Oscillator waveform. Defaults to 'sine' (a true damped sinusoid = the modal
    // model). A 'square' partial is how the 8-bit material gets its retro timbre —
    // a genuine square wave from Web Audio, not a modal approximation.
    type?: OscillatorType
}
function mode({
    freq,
    dur,
    gain,
    at = 0,
    detune = 0,
    attack = 0.002,
    type = 'sine',
}: Mode): void {
    const a = audio()
    if (!a) return
    const { c, out } = a
    const t = c.currentTime + LOOKAHEAD + at
    const o = c.createOscillator()
    o.type = type
    o.frequency.value = freq
    o.detune.value = detune
    const g = c.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.linearRampToValueAtTime(gain, t + attack) // soft onset, not a step
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur) // ring-down (never to exactly 0)
    o.connect(g).connect(out)
    o.start(t)
    o.stop(t + dur + 0.01)
}

// A struck-wood hit: an inharmonic modal bank excited by a single soft, lowpassed
// "contact" noise burst (the lowpass cutoff = wood hardness — lower is more
// felt-muted). modes ring down per `decays`; the noise is the attack transient.
interface WoodHit {
    fundamental: number
    ratios: number[]
    gains: number[]
    decays: number[]
    attack: number
    noise?: { dur: number; cutoff: number; gain: number }
    at?: number
    // Partial waveform (see Mode.type). Threaded through so a material can pick a
    // non-sine timbre (8-bit → 'square'); omitted → 'sine' = the wood model.
    type?: OscillatorType
}
function woodHit({
    fundamental,
    ratios,
    gains,
    decays,
    attack,
    noise,
    at = 0,
    type = 'sine',
}: WoodHit): void {
    ratios.forEach((r, i) => {
        mode({
            freq: fundamental * r,
            dur: decays[i],
            gain: gains[i],
            at: at + i * 0.0003,
            detune: (i - 1) * 3,
            attack,
            type,
        })
    })
    if (noise) {
        const a = audio()
        if (!a) return
        const { c, out } = a
        const t = c.currentTime + LOOKAHEAD + at
        const s = c.createBufferSource()
        s.buffer = noiseBuffer(c, noise.dur + 0.005)
        const lp = c.createBiquadFilter()
        lp.type = 'lowpass'
        lp.frequency.value = noise.cutoff
        const g = c.createGain()
        g.gain.setValueAtTime(0.0001, t)
        g.gain.linearRampToValueAtTime(noise.gain, t + 0.0015) // soft contact, not a step
        g.gain.exponentialRampToValueAtTime(0.0001, t + noise.dur)
        s.connect(lp).connect(g).connect(out)
        s.start(t)
        s.stop(t + noise.dur + 0.02)
    }
}

// A synthy electric-piano note: fundamental + octave + 3rd-harmonic shimmer, the
// upper partials decaying faster. Two of these (staggered) make the low-time cue.
function epNote({
    freq,
    at,
    dur,
    gain,
}: {
    freq: number
    at: number
    dur: number
    gain: number
}): void {
    body({ freq, dur, gain, at })
    body({ freq: freq * 2, dur: dur * 0.7, gain: gain * 0.32, at })
    body({ freq: freq * 3, dur: dur * 0.45, gain: gain * 0.16, at })
}

function guard(fn: () => void): void {
    if (!isEnabled()) return
    try {
        fn()
    } catch {
        /* never let audio break gameplay */
    }
}

const RATIOS = [1, 2.756, 5.404] // free-free wooden bar — the "wood" timbre

// A sound MATERIAL is a preset for the move + capture cues fed to the SAME modal
// synth. Every material reuses `woodHit`/`mode`; only the parameters differ —
// modal ratios, brightness (noise cutoff), decay length, gains, and (for 8-bit)
// the oscillator waveform. `moveHits`/`captureHits` are lists of struck hits; a
// capture is two contacts a hair apart. `moveLow` is the optional low "body"
// weight under a move. Wood reproduces the original sound BYTE-FOR-BYTE and is the
// default, so an unset preference is unchanged from before this feature existed.
interface MaterialSynth {
    moveHits: WoodHit[]
    moveLow?: Mode
    captureHits: WoodHit[]
}

const MATERIAL_PRESETS: Record<MaterialId, MaterialSynth> = {
    // WOOD — the original: inharmonic free-free bar, felt-soft ~3kHz contact,
    // highs die fast. Values copied verbatim from the pre-material sound.
    wood: {
        moveHits: [
            {
                fundamental: 440,
                ratios: RATIOS,
                gains: [0.36, 0.216, 0.12],
                decays: [0.09, 0.045, 0.018],
                attack: 0.003,
                noise: { dur: 0.006, cutoff: 3000, gain: 0.144 }, // ~3kHz lowpass = felt-soft contact
            },
        ],
        moveLow: { freq: 95, dur: 0.06, gain: 0.144, attack: 0.003 }, // subtle low weight (board body)
        captureHits: [
            {
                fundamental: 1050,
                ratios: RATIOS,
                gains: [0.384, 0.216, 0.12],
                decays: [0.03, 0.016, 0.008],
                attack: 0.0012,
                noise: { dur: 0.004, cutoff: 6500, gain: 0.216 },
            },
            {
                fundamental: 720,
                ratios: RATIOS,
                gains: [0.228, 0.132, 0.072],
                decays: [0.034, 0.018, 0.009],
                attack: 0.0018,
                at: 0.018,
                noise: { dur: 0.004, cutoff: 5000, gain: 0.132 },
            },
        ],
    },

    // GLASS — brighter, higher & more inharmonic ratios, a very bright contact and
    // LONG decays so it rings/shimmers like struck crystal.
    glass: {
        moveHits: [
            {
                fundamental: 620,
                ratios: [1, 2.76, 5.18, 8.8],
                gains: [0.26, 0.19, 0.13, 0.07],
                decays: [0.55, 0.4, 0.26, 0.14],
                attack: 0.001,
                noise: { dur: 0.004, cutoff: 9000, gain: 0.1 },
            },
        ],
        captureHits: [
            {
                fundamental: 1240,
                ratios: [1, 2.76, 5.18, 8.8],
                gains: [0.3, 0.2, 0.13, 0.07],
                decays: [0.4, 0.28, 0.18, 0.1],
                attack: 0.0008,
                noise: { dur: 0.003, cutoff: 11000, gain: 0.14 },
            },
            {
                fundamental: 930,
                ratios: [1, 2.76, 5.18],
                gains: [0.2, 0.13, 0.08],
                decays: [0.34, 0.22, 0.12],
                attack: 0.001,
                at: 0.016,
                noise: { dur: 0.003, cutoff: 9000, gain: 0.09 },
            },
        ],
    },

    // MARBLE — hard, bright, and SHORT: a very bright contact with fast-decaying
    // modes reads as a sharp stone click-clack, plus a hard low tap for weight.
    marble: {
        moveHits: [
            {
                fundamental: 520,
                ratios: [1, 3.1, 5.8],
                gains: [0.34, 0.16, 0.08],
                decays: [0.05, 0.022, 0.01],
                attack: 0.0006,
                noise: { dur: 0.004, cutoff: 8000, gain: 0.22 },
            },
        ],
        moveLow: { freq: 120, dur: 0.03, gain: 0.11, attack: 0.001 },
        captureHits: [
            {
                fundamental: 1300,
                ratios: [1, 3.1, 5.8],
                gains: [0.36, 0.16, 0.08],
                decays: [0.028, 0.014, 0.006],
                attack: 0.0005,
                noise: { dur: 0.003, cutoff: 12000, gain: 0.26 },
            },
            {
                fundamental: 900,
                ratios: [1, 3.1, 5.8],
                gains: [0.22, 0.11, 0.06],
                decays: [0.03, 0.015, 0.007],
                attack: 0.0006,
                at: 0.016,
                noise: { dur: 0.003, cutoff: 9000, gain: 0.16 },
            },
        ],
    },

    // FELT — muffled and soft: a LOW contact cutoff kills the brightness, gains are
    // gentle and decays short, and a rounded low body dominates → a soft thud.
    felt: {
        moveHits: [
            {
                fundamental: 300,
                ratios: [1, 2.4, 4.2],
                gains: [0.3, 0.12, 0.05],
                decays: [0.07, 0.03, 0.012],
                attack: 0.006,
                noise: { dur: 0.008, cutoff: 1100, gain: 0.16 },
            },
        ],
        moveLow: { freq: 80, dur: 0.08, gain: 0.2, attack: 0.005 },
        captureHits: [
            {
                fundamental: 520,
                ratios: [1, 2.4, 4.2],
                gains: [0.26, 0.1, 0.04],
                decays: [0.045, 0.02, 0.009],
                attack: 0.004,
                noise: { dur: 0.006, cutoff: 1600, gain: 0.18 },
            },
            {
                fundamental: 360,
                ratios: [1, 2.4],
                gains: [0.18, 0.07],
                decays: [0.05, 0.022],
                attack: 0.005,
                at: 0.02,
                noise: { dur: 0.006, cutoff: 1200, gain: 0.12 },
            },
        ],
    },

    // 8-BIT — genuine SQUARE oscillators (Web Audio 'square'), integer harmonics,
    // no contact-noise transient, quick decay → a retro chip "blip". The capture is
    // a descending two-blip zap. NOTE: this is the one material that leaves the
    // pure modal model — the square wave IS the retro character (no samples).
    eightbit: {
        moveHits: [
            {
                fundamental: 330,
                ratios: [1, 2],
                gains: [0.13, 0.045],
                decays: [0.1, 0.05],
                attack: 0.001,
                type: 'square',
            },
        ],
        captureHits: [
            {
                fundamental: 660,
                ratios: [1, 2],
                gains: [0.14, 0.05],
                decays: [0.05, 0.03],
                attack: 0.0008,
                type: 'square',
            },
            {
                fundamental: 440,
                ratios: [1, 2],
                gains: [0.11, 0.04],
                decays: [0.06, 0.035],
                attack: 0.001,
                at: 0.02,
                type: 'square',
            },
        ],
    },
}

function playHits(hits: WoodHit[]): void {
    hits.forEach((h) => woodHit(h))
}

/** The move/capture params for the active material (defaults to Wood). Resolved
 * at play-time so a change in the picker takes effect on the very next cue. */
function activeMaterial(): MaterialSynth {
    return MATERIAL_PRESETS[soundThemeStore.get()]
}

export const sounds = {
    // Piece → board: the active material's move cue (Wood = soft contact + wood
    // ring). Read from the store each call so switching material is instant.
    move: () =>
        guard(() => {
            const m = activeMaterial()
            playHits(m.moveHits)
            if (m.moveLow) mode(m.moveLow)
        }),

    // Piece → piece: the active material's capture cue — two contacts a hair apart
    // (a main strike then a lighter second tap).
    capture: () =>
        guard(() => {
            playHits(activeMaterial().captureHits)
        }),

    // Lichess "standard" has no distinct castle/promotion/check sound — they just
    // use the move (or capture) cue. We keep the API keys so callers don't break.
    castle: () => guard(() => sounds.move()),
    promote: () => guard(() => sounds.move()),
    check: () => {
        /* standard plays Silence for check — intentional no-op */
    },

    // Two staggered synthy notes: high first, low enters ~30% in. The low-time cue.
    lowTime: () =>
        guard(() => {
            epNote({ freq: 371, at: 0, dur: 0.46, gain: 0.59 })
            epNote({ freq: 183, at: 0.14, dur: 0.4, gain: 0.59 })
        }),

    // A bright ascending C-major arpeggio (C5–E5–G5–C6) — a "nice" reward cue for
    // solving a puzzle, distinct from the neutral end-bell used on a miss.
    success: () =>
        guard(() => {
            body({ freq: 523.25, dur: 0.4, gain: 0.5, at: 0 })
            body({ freq: 659.25, dur: 0.4, gain: 0.5, at: 0.09 })
            body({ freq: 783.99, dur: 0.5, gain: 0.55, at: 0.18 })
            body({ freq: 1046.5, dur: 0.6, gain: 0.42, at: 0.27 })
        }),

    // Soft bell "ding" (= Lichess GenericNotify, which standard also uses for
    // win/loss/draw): 561Hz + faint 759 + a touch of shimmer.
    end: () =>
        guard(() => {
            body({ freq: 561, dur: 0.45, gain: 0.71 })
            body({ freq: 759, dur: 0.4, gain: 0.095 })
            body({ freq: 1122, dur: 0.3, gain: 0.06 })
        }),
}

/** Audition a material WITHOUT changing the stored preference: plays its move
 * cue, then its capture cue a beat later, so the picker can preview a timbre on
 * click. Called from a click handler, so the AudioContext is already armed. */
export function previewMaterial(id: MaterialId): void {
    guard(() => {
        const m = MATERIAL_PRESETS[id]
        playHits(m.moveHits)
        if (m.moveLow) mode(m.moveLow)
        const CAPTURE_AT = 0.26 // demo the capture timbre shortly after the move
        m.captureHits.forEach((h) => woodHit({ ...h, at: (h.at ?? 0) + CAPTURE_AT }))
    })
}

/** Pick the right sound for a UCI move, given the board BEFORE it's applied.
 * Used for the local player's own move (played synchronously inside the click
 * gesture, both for instant feedback and to unlock the AudioContext). The SAN
 * variant `playForSan` is the counterpart for moves that arrive as SAN. */
export function playForMove(board: BoardMap, uci: string): void {
    const from = uci.slice(0, 2)
    const to = uci.slice(2, 4)
    const piece = board[from]?.toLowerCase()
    if (uci.length === 5) sounds.promote()
    else if (piece === 'k' && Math.abs(fileOf(to) - fileOf(from)) === 2) sounds.castle()
    else if (board[to] || (piece === 'p' && from[0] !== to[0])) sounds.capture()
    else sounds.move()
}

/** Pick the right sound for a SAN string (after the move is on the board). */
export function playForSan(san: string, gameOver: boolean): void {
    if (gameOver) {
        sounds.end()
        return
    }
    // Capture is checked before promotion so a capture-promotion sounds like a
    // capture. Castle/promotion fall through to the move cue (authentic standard).
    if (san.startsWith('O-O')) sounds.castle()
    else if (san.includes('x')) sounds.capture()
    else if (san.includes('=')) sounds.promote()
    else sounds.move()
    // No check sound: Lichess "standard" maps Check → Silence.
}

// Prime audio on EVERY user gesture, for the whole page lifetime — never detached.
//
// The first gesture unlocks: browsers create the AudioContext 'suspended' outside a
// gesture and won't play until resumed from one, so a sound driven purely by an
// event (an opponent/bot move over WebSocket) would never be heard. Arming + resuming
// + starting a 1-sample SILENT buffer inside the gesture is the "the user engaged
// with this site's audio" signal Safari wants (resuming alone is weaker on Safari/iOS).
//
// Every LATER gesture recovers: Safari suspends/interrupts a tab's AudioContext
// whenever THAT tab is backgrounded, minimized, or occluded (WebKit #231105/#237878),
// AND when another tab (a second chessgo instance, a video, anything) steals the one
// output session — the backgrounded context can be left 'running' but silent. It can
// also wedge after a long idle or a screen lock. We defend against the wedge by
// suspending ourselves on tab-hide (see visibilitychange below), and the ONLY
// reliable cure once wedged is resume() from a real gesture — resume() outside a
// gesture rejects on an interrupted context. So we keep the listener attached
// forever: the next click (e.g. a board move) is what un-wedges audio, and it can
// only do that if we're still listening.
// Detaching after the first unlock (as we used to) is what left audio permanently
// silent until a full Safari restart. pointerdown covers mouse + touch.
if (typeof window !== 'undefined') {
    const prime = () => {
        armed = true
        const a = audio() // builds the context on the first gesture; resumes on every one
        // Now that a gesture has armed us, keep the audio unit warm so every move cue
        // is instant (Safari sleeps the unit during silence otherwise). No-op if
        // already warm or muted.
        startKeepAlive()
        if (!a || a.c.state === 'running') return
        void a.c.resume().catch(() => {})
        try {
            const silent = a.c.createBufferSource()
            silent.buffer = a.c.createBuffer(1, 1, a.c.sampleRate)
            silent.connect(a.c.destination)
            silent.start(0)
        } catch {
            /* ignore */
        }
    }
    window.addEventListener('pointerdown', prime)
    window.addEventListener('keydown', prime)

    // Live-apply the volume preference: any settings change re-reads the volume and
    // updates the master node (no-op until the context is built). Cheap.
    settingsStore.subscribe(applyMasterVolume)

    // Keep the keep-alive oscillator in sync with `soundEnabled` even when it
    // changes without going through setSoundEnabled() — e.g. the Settings dialog's
    // "Reset to defaults", which calls settingsStore.reset() directly.
    settingsStore.subscribe(() => {
        if (isEnabled()) startKeepAlive()
        else stopKeepAlive()
    })

    // When the tab returns to the foreground (or the OS ends an interruption), try a
    // gestureless resume — it succeeds in the common auto-recover case and rejects
    // harmlessly otherwise, in which case the next gesture's prime() recovers it. We
    // deliberately do NOT tear the context down here: destroying it on every resume
    // that didn't instantly succeed was what left all later sounds permanently silent.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            // Leaving the tab: drop the keep-alive (releases the audio indicator and
            // stops two chessgo tabs contending) and PROACTIVELY suspend. A context we
            // suspend ourselves comes back with a plain resume(); the 'running-but-
            // silent' wedge Safari imposes when another tab steals the output session
            // does NOT — so we get there first with a clean, recoverable 'suspended'.
            stopKeepAlive()
            if (ctx && ctx.state === 'running') void ctx.suspend().catch(() => {})
            return
        }
        // Returning to the tab: resume the cleanly-suspended context and re-warm so
        // sound is instant again. If Safari still wedged it, the next gesture's
        // prime() (resume + re-warm) is the fallback recovery.
        if (ctx && ctx.state !== 'running') void ctx.resume().catch(() => {})
        startKeepAlive()
    })
}
