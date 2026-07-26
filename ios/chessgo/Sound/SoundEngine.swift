//
//  SoundEngine.swift
//  chessgo
//
//  Synthesized sound effects for the board — no bundled audio files. Short
//  tones are generated once at startup (`ToneSynth`), cached as
//  `AVAudioPCMBuffer`s, and played through a single `AVAudioPlayerNode`.
//
//  Robustness is the whole point of this file: a simulator without a
//  working audio stack, a `AVAudioSession` that refuses to activate, or an
//  `AVAudioEngine` that fails to start must all degrade to silence, never a
//  crash. Nothing here force-unwraps an audio API or lets a throw escape to
//  the call site.
//
//  Own-move-vs-opponent-move timing and the global mute switch are the
//  caller's concern (see the drivers) — this class only knows how to render
//  and play a named event at a given volume.
//

import AVFoundation

/// `nonisolated` + `@unchecked Sendable`: every audio operation runs on a
/// private serial queue, NEVER the main thread. Activating `AVAudioSession` or
/// starting `AVAudioEngine` can block for SECONDS during a Bluetooth route
/// change (e.g. AirPods handing back from a paired Mac to the phone); doing
/// that on `@MainActor` — as this used to — froze the entire UI for the whole
/// hand-off. `play`/`playForSan` now just guard the cheap stuff and dispatch,
/// returning immediately, so a slow audio route can delay a move's sound but
/// can never stall the interface. `AVAudioEngine`/its nodes are documented as
/// usable from any thread and `AVAudioSession` is thread-safe, so confining all
/// of it to one serial queue is both correct and what makes the unchecked
/// `Sendable` conformance sound.
nonisolated final class SoundEngine: @unchecked Sendable {

    static let shared = SoundEngine()

    /// The sound catalog. `.check` is deliberately silent — matches the web
    /// client, which treats a check "sound" as more alarming than useful.
    /// `.castle` and `.promote` reuse the `.move` tone (see the event
    /// catalog in `docs/analysis/frontend-features.md`); they're kept as
    /// distinct cases so `playForSan` reads as self-documenting precedence
    /// logic rather than magic string matching.
    enum SoundEvent: CaseIterable {
        case move
        case capture
        case castle
        case promote
        case check
        case lowTime
        case success
        case end
    }

    /// Serial queue that OWNS every mutable member below (engine, player,
    /// buffers, the lazy-setup/activation flags). They are only ever touched
    /// inside a `queue.async` block — that single-threaded confinement is what
    /// makes the `@unchecked Sendable` safe.
    private let queue = DispatchQueue(label: "de.timanthonyalexander.chessgo.sound", qos: .userInitiated)

    // Built lazily on `queue` in `setupIfNeeded`, NOT as init-time stored
    // properties: constructing `AVAudioEngine`/`AVAudioPlayerNode` (and
    // touching `mainMixerNode`) can itself reach into CoreAudio and stall on a
    // Bluetooth route change, so even that must stay off the main thread. This
    // was the second half of the freeze — `play` dispatched, but the very first
    // `SoundEngine.shared` access still built the engine on main.
    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var buffers: [SoundEvent: AVAudioPCMBuffer] = [:]
    private var didSetup = false
    private var didAttemptSessionActivation = false
    private var isEngineRunning = false

    private init() {}

    /// One-time engine construction + wiring + buffer generation, deferred off
    /// init so nothing audio-related runs on the main thread. Called on `queue`.
    private func setupIfNeeded() {
        guard !didSetup else { return }
        didSetup = true
        let engine = AVAudioEngine()
        let player = AVAudioPlayerNode()
        engine.attach(player)
        // Connect with the SAME mono format the tone buffers use. Connecting
        // with the mixer's stereo hardware format instead makes
        // `scheduleBuffer` assert on a channel-count mismatch (mono buffer vs
        // stereo render format) the first time a sound plays. The mixer upmixes
        // mono to the output.
        if let format = AVAudioFormat(standardFormatWithSampleRate: ToneSynth.sampleRate, channels: 1) {
            engine.connect(player, to: engine.mainMixerNode, format: format)
        }
        buffers = Self.buildBuffers()
        self.engine = engine
        self.player = player
    }

    /// Warm the whole audio stack ahead of the first move — construct the
    /// engine, activate the session, and start the engine, all on `queue`.
    /// Call once at launch so the first move's sound isn't the thing that pays
    /// the (possibly seconds-long, on a Bluetooth route change) cold start.
    /// Best-effort and idempotent; returns immediately.
    func prewarm() {
        queue.async { [self] in
            setupIfNeeded()
            activateSessionIfNeeded()
            _ = startEngineIfNeeded()
        }
    }

    // MARK: - Playback

    /// Plays `event`'s tone at `volume` (0...1). `0` is silent and skips all
    /// work; `.check` is always a no-op regardless of volume. Every failure
    /// path — session activation, engine start, a missing buffer — silently
    /// drops the sound instead of throwing: sound is a nice-to-have, never
    /// something that should be able to break a move.
    func play(_ event: SoundEvent, volume: Double = 1.0) {
        guard event != .check, volume > 0 else { return }
        let clampedVolume = Float(max(0, min(1, volume)))

        // Hop off the caller's thread (the drivers call this on the main
        // thread). Everything below can block on a Bluetooth route change and
        // must never hold up the UI — it all runs on `queue` instead.
        queue.async { [self] in
            setupIfNeeded()
            guard let player, let buffer = buffers[event] else { return }

            activateSessionIfNeeded()
            guard startEngineIfNeeded() else { return }

            player.volume = clampedVolume
            player.scheduleBuffer(buffer, at: nil, options: .interrupts, completionHandler: nil)
            if !player.isPlaying {
                player.play()
            }
        }
    }

    /// Web-parity precedence for a SAN string that was just applied to the
    /// board (matches `playForSan` on the web client):
    ///
    /// 1. `isGameOver` → `.end` (win/loss/draw all share one sound)
    /// 2. SAN starts with `"O-O"` (covers both `O-O` and `O-O-O`) → `.castle`
    /// 3. SAN contains `"x"` → `.capture`
    /// 4. SAN contains `"="` → `.promote`
    /// 5. else → `.move`
    ///
    /// Order 2-3-4 matters: a capturing promotion like `"exd8=Q+"` contains
    /// both `x` and `=`, and is checked against `x` first, so it correctly
    /// sounds like a capture rather than a plain promotion.
    func playForSan(_ san: String, isGameOver: Bool, volume: Double = 1.0) {
        guard volume > 0 else { return }
        if isGameOver {
            play(.end, volume: volume)
            return
        }
        if san.hasPrefix("O-O") {
            play(.castle, volume: volume)
            return
        }
        if san.contains("x") {
            play(.capture, volume: volume)
            return
        }
        if san.contains("=") {
            play(.promote, volume: volume)
            return
        }
        play(.move, volume: volume)
    }

    // MARK: - Session / engine lifecycle

    /// `.ambient` + `.mixWithOthers` so board sounds never interrupt
    /// whatever the user is already playing (music, a podcast) and never
    /// silence it either — same posture as the web client's Web Audio
    /// context, which never claims exclusive audio. Activation is lazy
    /// (first sound played) and best-effort: `try?` everywhere, because a
    /// failed session activation must never surface to the caller.
    private func activateSessionIfNeeded() {
        guard !didAttemptSessionActivation else { return }
        didAttemptSessionActivation = true
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.ambient, options: [.mixWithOthers])
        try? session.setActive(true, options: [])
    }

    /// Starts the engine on first use and remembers success so we don't pay
    /// the `try engine.start()` cost on every single play call. Returns
    /// `false` (never throws) on failure so `play` can just skip the sound.
    private func startEngineIfNeeded() -> Bool {
        if isEngineRunning { return true }
        guard let engine else { return false }
        do {
            try engine.start()
            isEngineRunning = true
            return true
        } catch {
            isEngineRunning = false
            return false
        }
    }

    // MARK: - Buffer generation (built once at init, then reused forever)

    private static func buildBuffers() -> [SoundEvent: AVAudioPCMBuffer] {
        var result: [SoundEvent: AVAudioPCMBuffer] = [:]
        let moveBuffer = ToneSynth.buffer(from: moveSamples())
        result[.move] = moveBuffer
        result[.capture] = ToneSynth.buffer(from: captureSamples())
        // Castle and promote share the plain move tone (event catalog: both
        // collapse to "move" on the web client).
        result[.castle] = moveBuffer
        result[.promote] = moveBuffer
        result[.lowTime] = ToneSynth.buffer(from: lowTimeSamples())
        result[.success] = ToneSynth.buffer(from: successSamples())
        result[.end] = ToneSynth.buffer(from: endSamples())
        // .check intentionally has no buffer — play(_:) no-ops on it anyway.
        return result
    }

    /// Soft short "woodblock" contact: a low fundamental plus a brief higher
    /// tick, both decaying fast. ~45ms total.
    private static func moveSamples() -> [Float] {
        let fundamental = ToneSynth.tone(
            frequency: 220, duration: 0.045, amplitude: 0.5, decay: 55, waveform: .triangle
        )
        let tick = ToneSynth.tone(
            frequency: 900, duration: 0.02, amplitude: 0.18, decay: 90, waveform: .sine
        )
        return ToneSynth.mix([fundamental, tick])
    }

    /// Two quick staggered contacts, louder than a plain move — reads as a
    /// "clack-clack" rather than a single tap.
    private static func captureSamples() -> [Float] {
        let first = ToneSynth.mix([
            ToneSynth.tone(frequency: 260, duration: 0.04, amplitude: 0.65, decay: 45, waveform: .triangle),
            ToneSynth.tone(frequency: 1100, duration: 0.02, amplitude: 0.2, decay: 90, waveform: .sine),
        ])
        let second = ToneSynth.mix([
            ToneSynth.tone(frequency: 200, duration: 0.05, amplitude: 0.75, decay: 40, waveform: .triangle),
            ToneSynth.tone(frequency: 950, duration: 0.02, amplitude: 0.22, decay: 90, waveform: .sine),
        ])
        return ToneSynth.concat([first, second], gap: 0.016)
    }

    /// Short higher blip for the low-time warning — urgent without being
    /// alarming.
    private static func lowTimeSamples() -> [Float] {
        ToneSynth.tone(frequency: 1000, duration: 0.09, amplitude: 0.45, decay: 22, waveform: .sine)
    }

    /// Ascending three-note arpeggio (puzzle solved) — a plain major triad
    /// read bottom to top (C5-E5-G5).
    private static func successSamples() -> [Float] {
        let notes = [523.25, 659.25, 783.99].map { frequency in
            ToneSynth.tone(frequency: frequency, duration: 0.11, amplitude: 0.45, decay: 16, waveform: .sine)
        }
        return ToneSynth.concat(notes, gap: 0.015)
    }

    /// Soft two-tone "bell" for game end — reused across win/loss/draw, the
    /// same "one end sound" the web client uses.
    private static func endSamples() -> [Float] {
        let high = ToneSynth.mix([
            ToneSynth.tone(frequency: 587.33, duration: 0.3, amplitude: 0.4, decay: 7, waveform: .sine),
            ToneSynth.tone(frequency: 587.33 * 2, duration: 0.3, amplitude: 0.12, decay: 9, waveform: .sine),
        ])
        let low = ToneSynth.mix([
            ToneSynth.tone(frequency: 440.0, duration: 0.4, amplitude: 0.4, decay: 6, waveform: .sine),
            ToneSynth.tone(frequency: 440.0 * 2, duration: 0.4, amplitude: 0.12, decay: 8, waveform: .sine),
        ])
        return ToneSynth.concat([high, low], gap: 0.03)
    }
}
