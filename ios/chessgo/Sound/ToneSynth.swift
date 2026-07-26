//
//  ToneSynth.swift
//  chessgo
//
//  Pure sample-synthesis helpers. No audio files are bundled anywhere in
//  this app — every sound effect is a handful of sine/triangle oscillators
//  shaped by an exponential-decay envelope, rendered into a plain `[Float]`
//  sample array and then wrapped into an `AVAudioPCMBuffer`. Everything here
//  is a free function with no shared state, so it's safe to call from
//  anywhere and easy to unit-reason about.
//
//  Every buffer-producing call is `nil`-safe: a stripped-down simulator
//  audio stack (or any unexpected format failure) degrades to "no buffer",
//  never a crash.
//

import AVFoundation

enum ToneSynth {

    static let sampleRate: Double = 44100

    enum Waveform {
        case sine
        case triangle
    }

    /// Renders `duration` seconds of a tone at `frequency` Hz, scaled by
    /// `amplitude` (roughly 0...1) and shaped by `exp(-decay * t)` so the
    /// tone fades to silence instead of clicking at the cutoff. `decay` is
    /// in nepers/second; higher = shorter perceived tone for the same
    /// `duration` window.
    static func tone(
        frequency: Double,
        duration: Double,
        amplitude: Float = 0.5,
        decay: Double = 20,
        waveform: Waveform = .sine
    ) -> [Float] {
        let frameCount = max(1, Int(duration * sampleRate))
        var samples = [Float](repeating: 0, count: frameCount)
        for i in 0..<frameCount {
            let t = Double(i) / sampleRate
            let phase = 2.0 * Double.pi * frequency * t
            let raw: Double
            switch waveform {
            case .sine:
                raw = sin(phase)
            case .triangle:
                // arcsin(sin(x)) reshapes a sine into a triangle without any
                // discontinuities, so no extra anti-click handling is needed.
                raw = (2.0 / Double.pi) * asin(sin(phase))
            }
            let envelope = exp(-decay * t)
            samples[i] = Float(raw * envelope) * amplitude
        }
        return samples
    }

    /// Concatenates sample arrays end to end (e.g. arpeggio notes, staggered
    /// capture contacts), optionally inserting `gap` seconds of silence
    /// between each part.
    static func concat(_ parts: [[Float]], gap: Double = 0.0) -> [Float] {
        guard !parts.isEmpty else { return [] }
        let gapFrames = max(0, Int(gap * sampleRate))
        var out: [Float] = []
        out.reserveCapacity(parts.reduce(0) { $0 + $1.count } + gapFrames * parts.count)
        for (index, part) in parts.enumerated() {
            out.append(contentsOf: part)
            if index < parts.count - 1, gapFrames > 0 {
                out.append(contentsOf: [Float](repeating: 0, count: gapFrames))
            }
        }
        return out
    }

    /// Sums sample arrays that start at the same instant, padded to the
    /// longest length. Used to layer a fundamental with a brief higher
    /// partial for a slightly richer "contact" timbre.
    static func mix(_ parts: [[Float]]) -> [Float] {
        guard let maxCount = parts.map(\.count).max() else { return [] }
        var out = [Float](repeating: 0, count: maxCount)
        for part in parts {
            for i in 0..<part.count {
                out[i] += part[i]
            }
        }
        return out
    }

    /// Wraps a raw mono sample array into an `AVAudioPCMBuffer` at
    /// `sampleRate`. Returns `nil` (never crashes) if the format or buffer
    /// can't be constructed — callers treat `nil` as "this event has no
    /// sound," which is a safe degrade.
    static func buffer(from samples: [Float]) -> AVAudioPCMBuffer? {
        guard !samples.isEmpty else { return nil }
        guard let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1) else {
            return nil
        }
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)) else {
            return nil
        }
        guard let channelData = buffer.floatChannelData else { return nil }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { pointer in
            guard let base = pointer.baseAddress else { return }
            channelData[0].update(from: base, count: samples.count)
        }
        return buffer
    }
}
