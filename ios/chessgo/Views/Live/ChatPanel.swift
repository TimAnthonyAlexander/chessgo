import SwiftUI

/// In-game chat: a read-only scroll of `messages` plus a single-line
/// composer, capped at 280 chars (`ws-protocol.md`'s `chat` limit) and
/// disabled once the game has ended.
struct ChatPanel: View {
    let messages: [ChatLine]
    let disabled: Bool
    let onSend: (String) -> Void

    @State private var draft = ""
    private let maxLength = 280

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 4) {
                        if messages.isEmpty {
                            Text("No messages yet.")
                                .font(Theme.caption())
                                .foregroundStyle(Theme.Colors.secondaryText)
                        }
                        ForEach(messages) { line in
                            lineView(line).id(line.id)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .onChange(of: messages.count) { _, _ in
                    guard let last = messages.last?.id else { return }
                    withAnimation(.easeOut(duration: 0.15)) {
                        proxy.scrollTo(last, anchor: .bottom)
                    }
                }
            }
            .frame(height: 120)

            composer
        }
    }

    private func lineView(_ line: ChatLine) -> some View {
        (Text(line.name.isEmpty ? "them" : line.name).fontWeight(.semibold)
            + Text(": \(line.text)"))
            .font(Theme.body(13))
            .foregroundStyle(Theme.Colors.primaryText)
    }

    private var composer: some View {
        HStack(spacing: Theme.Spacing.sm) {
            TextField("Message", text: $draft)
                .textFieldStyle(.plain)
                .disabled(disabled)
                .onChange(of: draft) { _, newValue in
                    if newValue.count > maxLength {
                        draft = String(newValue.prefix(maxLength))
                    }
                }
                .onSubmit(send)

            Button(action: send) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 22))
            }
            .disabled(disabled || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(.horizontal, Theme.Spacing.sm)
        .padding(.vertical, Theme.Spacing.xs)
        .glassed(in: Capsule())
    }

    private func send() {
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        onSend(trimmed)
        draft = ""
    }
}

#Preview("ChatPanel — with messages") {
    ChatPanel(
        messages: [
            ChatLine(by: "w", name: "Nimzo42", text: "gl hf"),
            ChatLine(by: "b", name: "You", text: "you too, good luck"),
        ],
        disabled: false,
        onSend: { _ in }
    )
    .padding()
    .background(Theme.Colors.background)
}

#Preview("ChatPanel — empty, disabled") {
    ChatPanel(messages: [], disabled: true, onSend: { _ in })
        .padding()
        .background(Theme.Colors.background)
}
