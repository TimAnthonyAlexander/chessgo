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

let ctx: AudioContext | null = null
let master: GainNode | null = null
let enabled = readEnabled()

function readEnabled(): boolean {
  try {
    return localStorage.getItem('chessgo.sound') !== 'off'
  } catch {
    return true
  }
}

export function soundEnabled(): boolean {
  return enabled
}

export function setSoundEnabled(on: boolean): void {
  enabled = on
  try {
    localStorage.setItem('chessgo.sound', on ? 'on' : 'off')
  } catch {
    /* ignore */
  }
}

function audio(): { c: AudioContext; out: GainNode } | null {
  if (typeof window === 'undefined') return null
  if (!ctx) {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    ctx = new Ctor()
    // Real headroom instead of a brickwall limiter: per-voice gains are small and
    // the master sits below unity, so the in-phase sum stays clear of clipping.
    master = ctx.createGain()
    master.gain.value = 0.8
    master.connect(ctx.destination)
  }
  if (ctx.state === 'suspended') void ctx.resume()
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
  const t = c.currentTime + at
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
}
function mode({ freq, dur, gain, at = 0, detune = 0, attack = 0.002 }: Mode): void {
  const a = audio()
  if (!a) return
  const { c, out } = a
  const t = c.currentTime + at
  const o = c.createOscillator()
  o.type = 'sine'
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
}
function woodHit({ fundamental, ratios, gains, decays, attack, noise, at = 0 }: WoodHit): void {
  ratios.forEach((r, i) => {
    mode({ freq: fundamental * r, dur: decays[i], gain: gains[i], at: at + i * 0.0003, detune: (i - 1) * 3, attack })
  })
  if (noise) {
    const a = audio()
    if (!a) return
    const { c, out } = a
    const t = c.currentTime + at
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
function epNote({ freq, at, dur, gain }: { freq: number; at: number; dur: number; gain: number }): void {
  body({ freq, dur, gain, at })
  body({ freq: freq * 2, dur: dur * 0.7, gain: gain * 0.32, at })
  body({ freq: freq * 3, dur: dur * 0.45, gain: gain * 0.16, at })
}

function guard(fn: () => void): void {
  if (!enabled) return
  try {
    fn()
  } catch {
    /* never let audio break gameplay */
  }
}

const RATIOS = [1, 2.756, 5.404] // free-free wooden bar — the "wood" timbre

export const sounds = {
  // Piece → board: soft felt-muted contact + inharmonic wood ring, highs die fast.
  move: () =>
    guard(() => {
      woodHit({
        fundamental: 440,
        ratios: RATIOS,
        gains: [0.36, 0.216, 0.12],
        decays: [0.09, 0.045, 0.018],
        attack: 0.003,
        noise: { dur: 0.006, cutoff: 3000, gain: 0.144 }, // ~3kHz lowpass = felt-soft contact
      })
      mode({ freq: 95, dur: 0.06, gain: 0.144, attack: 0.003 }) // subtle low weight (board body)
    }),

  // Piece → piece: TWO wooden contacts a hair apart (they don't touch at once) —
  // a louder/higher main strike, then a lower/lighter second tap.
  capture: () =>
    guard(() => {
      woodHit({
        fundamental: 1050,
        ratios: RATIOS,
        gains: [0.384, 0.216, 0.12],
        decays: [0.03, 0.016, 0.008],
        attack: 0.0012,
        noise: { dur: 0.004, cutoff: 6500, gain: 0.216 },
      })
      woodHit({
        fundamental: 720,
        ratios: RATIOS,
        gains: [0.228, 0.132, 0.072],
        decays: [0.034, 0.018, 0.009],
        attack: 0.0018,
        at: 0.018,
        noise: { dur: 0.004, cutoff: 5000, gain: 0.132 },
      })
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

// Unlock audio on the first user gesture ANYWHERE in the app. Browsers create an
// AudioContext in a "suspended" state when it's first touched outside a gesture
// and won't play until resumed from one — so a sound driven purely by an event
// (an opponent/bot move arriving over WebSocket) would never be heard. Creating +
// resuming the context inside this listener primes it for all later sounds. The
// listener removes itself once the context is actually running.
if (typeof window !== 'undefined') {
  const unlock = () => {
    const a = audio() // creates + resumes within the gesture
    if (a && a.c.state === 'running') {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
  }
  window.addEventListener('pointerdown', unlock)
  window.addEventListener('keydown', unlock)
}
