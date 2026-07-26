import Foundation

/// Receive loop + per-frame-type dispatch. `URLSessionWebSocketTask.receive()`
/// is the async (not completion-handler) API, so there's no nonisolated
/// callback to hop off of: `listen` starts a `Task` from a `@MainActor`
/// method, which inherits MainActor isolation, and every `await` inside the
/// loop resumes back on MainActor before the next line runs — mutating
/// `SocketStore`'s published state after `try await task.receive()` is
/// already main-actor-safe with no explicit `MainActor.run` needed.
extension SocketStore {
    func listen(_ task: URLSessionWebSocketTask) {
        receiveLoopTask = Task { [weak self] in
            await self?.receiveLoop(task)
        }
    }

    private func receiveLoop(_ task: URLSessionWebSocketTask) async {
        while !Task.isCancelled {
            do {
                let message = try await task.receive()
                if let data = Self.payload(of: message) {
                    dispatch(data)
                }
            } catch {
                handleDisconnect()
                return
            }
        }
    }

    private static func payload(of message: URLSessionWebSocketTask.Message) -> Data? {
        switch message {
        case .data(let data): return data
        case .string(let text): return Data(text.utf8)
        @unknown default: return nil
        }
    }

    private func handleDisconnect() {
        guard connection != .closed else { return }
        connection = .closed
        socketTask = nil
        resumeWaitTask?.cancel()
        scheduleReconnect()
    }

    private func dispatch(_ data: Data) {
        guard let envelope = try? decoder.decode(WsEnvelope.self, from: data) else { return }
        switch envelope.type {
        case "hello": handleHello()
        case "queued": handleQueued(data)
        case "idle": handleIdle()
        case "matched": handleMatched(data)
        case "challengeCreated": handleChallengeCreated(data)
        case "challengeExpired": handleChallengeExpired()
        case "resume": handleResume(data)
        case "state": handleState(data)
        case "end": handleEnd(data)
        case "opponentGone": handleOpponentPresence(data, online: false)
        case "opponentBack": handleOpponentPresence(data, online: true)
        case "drawOffered": handleDrawOffered(data)
        case "drawDeclined": drawOfferState = .none
        case "takebackOffered": handleTakebackOffered(data)
        case "takebackDeclined": takebackOfferState = .none
        case "chat": handleChat(data)
        case "watching", "watchEnd": break // spectator-only frames, not used by the live-game screen
        case "error": handleError(data)
        default: Log.warn("SocketStore: unhandled frame type '\(envelope.type)'")
        }
    }

    // MARK: - Handlers

    private func handleHello() {
        connection = .open
        reconnectAttempt = 0
        flushPendingIntent()
        armResumeTimeout()
    }

    private func handleQueued(_ data: Data) {
        guard let frame = try? decoder.decode(WsQueued.self, from: data) else { return }
        lobby = .queued(pool: frame.pool, variant: frame.variant)
    }

    private func handleIdle() {
        resumeWaitTask?.cancel()
        lobby = .idle
        // A definitive "you have no live game" — don't wait out the 1.5s
        // resume timeout, we already know.
        forceLocalGameEndedIfNeeded()
    }

    private func handleMatched(_ data: Data) {
        guard let matched = try? decoder.decode(WsMatched.self, from: data) else { return }
        resumeWaitTask?.cancel()
        pendingIntent = nil
        challengeInfo = nil
        lobby = .idle
        postGame = nil
        messages = []
        drawOfferState = .none
        takebackOfferState = .none
        game = .from(matched: matched)
        clockAt = Date()
    }

    private func handleChallengeCreated(_ data: Data) {
        guard let frame = try? decoder.decode(WsChallengeCreated.self, from: data) else { return }
        pendingIntent = nil
        challengeInfo = ChallengeInfo(code: frame.code, pool: frame.pool, color: frame.color, rated: frame.rated, variant: frame.variant)
    }

    private func handleChallengeExpired() {
        challengeInfo = nil
        lastError = "That challenge expired."
    }

    private func handleResume(_ data: Data) {
        guard let resume = try? decoder.decode(WsResume.self, from: data) else { return }
        resumeWaitTask?.cancel()
        lobby = .idle
        game = .from(resume: resume)
        clockAt = Date()
    }

    private func handleState(_ data: Data) {
        guard let state = try? decoder.decode(WsState.self, from: data), let current = game, current.id == state.gameId else { return }
        var moves = current.moves
        if state.ply < moves.count {
            moves = Array(moves.prefix(state.ply)) // takeback: server re-broadcasts a LOWER ply
        } else if state.ply > moves.count, let lastMove = state.lastMove, let san = state.san {
            moves.append(WsMoveRef(uci: lastMove, san: san))
        }
        game = current.withState(state, moves: moves)
        clockAt = Date()
        // A move (yours or theirs) implicitly supersedes any offer made
        // against the prior position — ws-protocol.md doesn't say this
        // explicitly, but leaving a stale "accept/decline" banner up after
        // the position has already changed would be misleading.
        drawOfferState = .none
        takebackOfferState = .none
    }

    private func handleEnd(_ data: Data) {
        guard let end = try? decoder.decode(WsEnd.self, from: data), let current = game, current.id == end.gameId else { return }
        game = current.withEnd(end)
        clockAt = Date()
        drawOfferState = .none
        takebackOfferState = .none
        fetchPostGameResult(id: end.gameId)
    }

    private func handleOpponentPresence(_ data: Data, online: Bool) {
        guard let frame = try? decoder.decode(WsGameRef.self, from: data), let current = game, current.id == frame.gameId else { return }
        game = current.withOpponentOnline(online)
    }

    private func handleDrawOffered(_ data: Data) {
        guard let frame = try? decoder.decode(WsOfferedBy.self, from: data), let current = game, current.id == frame.gameId else { return }
        if let by = frame.by, by == current.color {
            drawOfferState = .mine
        } else if drawOfferState != .mine {
            drawOfferState = .theirs
        }
    }

    /// `by` is documented as sometimes-absent for `takebackOffered`. Since
    /// `takebackOffer()` (the sender) already sets `.mine` optimistically the
    /// instant the local player taps it, a missing/opponent `by` only needs
    /// to escalate to `.theirs` when we don't already know it was us.
    private func handleTakebackOffered(_ data: Data) {
        guard let frame = try? decoder.decode(WsOfferedBy.self, from: data), let current = game, current.id == frame.gameId else { return }
        if let by = frame.by, by == current.color {
            takebackOfferState = .mine
        } else if takebackOfferState != .mine {
            takebackOfferState = .theirs
        }
    }

    private func handleChat(_ data: Data) {
        guard let frame = try? decoder.decode(WsChat.self, from: data), let current = game, current.id == frame.gameId else { return }
        messages.append(ChatLine(by: frame.by, name: frame.name, text: frame.text))
    }

    private func handleError(_ data: Data) {
        guard let frame = try? decoder.decode(WsErrorFrame.self, from: data) else { return }
        lastError = frame.message
    }

    func flushPendingIntent() {
        guard let intent = pendingIntent else { return }
        pendingIntent = nil
        intent()
    }
}
