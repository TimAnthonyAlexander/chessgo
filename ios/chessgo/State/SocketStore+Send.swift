import Foundation

/// Client→server senders (`ws-protocol.md`'s "flat JSON, `type` selects
/// handler" table). Every frame is `{"type": ..., ...}` — fields the hub
/// doesn't need for a given type are simply omitted (an `Optional` property
/// with `nil` is skipped by the synthesized `Encodable`, not sent as `null`).
extension SocketStore {
    /// Every outgoing frame shape. Only `type` is required; the rest are
    /// filled in per call site and dropped from the JSON when `nil`.
    struct OutgoingFrame: Encodable {
        let type: String
        var pool: String?
        var variant: String?
        var move: String?
        var text: String?
        var color: String?
        var rated: Bool?
        var code: String?
    }

    // MARK: - Lobby / matchmaking
    //
    // These three are "replayable": if the socket isn't open yet, the intent
    // is stashed and fired the moment `hello` arrives (see `flushPendingIntent`
    // in `SocketStore+Receive.swift`) instead of silently dropping the tap —
    // this is `connect()`'s frontend-features.md "replay pending lobby intent
    // on open" behavior. Once the hub acks with `queued`/`challengeCreated`/
    // `matched`, the intent is cleared — a LATER disconnect while already
    // queued/challenged is Home's concern to re-drive, not this store's.

    func queue(pool: String, variant: String) {
        replayableSend(OutgoingFrame(type: "queue", pool: pool, variant: variant))
    }

    func cancelQueue() {
        pendingIntent = nil
        lobby = .idle
        send(OutgoingFrame(type: "cancel"))
    }

    func createChallenge(pool: String, color: String, rated: Bool, variant: String) {
        replayableSend(OutgoingFrame(type: "createChallenge", pool: pool, variant: variant, color: color, rated: rated))
    }

    func joinChallenge(code: String) {
        replayableSend(OutgoingFrame(type: "joinChallenge", code: code))
    }

    func cancelChallenge() {
        pendingIntent = nil
        challengeInfo = nil
        send(OutgoingFrame(type: "cancelChallenge"))
    }

    // MARK: - In-game

    /// Standard UCI ("e2e4"/"e7e8q"), a Crazyhouse drop ("P@e4"), or a Duck
    /// composite ("e2e4:d5") — all the same wire `move` type; the shape
    /// distinction is purely in the string `LiveGameDriver` builds.
    func move(_ uci: String) {
        send(OutgoingFrame(type: "move", move: uci))
    }

    func resign() {
        send(OutgoingFrame(type: "resign"))
    }

    func drawOffer() {
        drawOfferState = .mine
        send(OutgoingFrame(type: "drawOffer"))
    }

    func drawAccept() {
        send(OutgoingFrame(type: "drawAccept"))
    }

    func drawDecline() {
        drawOfferState = .none
        send(OutgoingFrame(type: "drawDecline"))
    }

    func takebackOffer() {
        takebackOfferState = .mine
        send(OutgoingFrame(type: "takebackOffer"))
    }

    func takebackAccept() {
        send(OutgoingFrame(type: "takebackAccept"))
    }

    func takebackDecline() {
        takebackOfferState = .none
        send(OutgoingFrame(type: "takebackDecline"))
    }

    func chat(_ text: String) {
        let trimmed = String(text.prefix(280))
        guard !trimmed.isEmpty else { return }
        send(OutgoingFrame(type: "chat", text: trimmed))
    }

    // MARK: - Wire

    private func replayableSend(_ frame: OutgoingFrame) {
        pendingIntent = { [weak self] in self?.send(frame) }
        if connection == .open {
            send(frame)
            pendingIntent = nil
        } else {
            connect()
        }
    }

    private func send<T: Encodable>(_ frame: T) {
        guard let socketTask, connection == .open, let data = try? Self.encoder.encode(frame) else { return }
        Task {
            try? await socketTask.send(.data(data))
        }
    }
}
