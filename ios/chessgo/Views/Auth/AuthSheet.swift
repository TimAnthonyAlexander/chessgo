import SwiftUI

/// The one auth surface: a sheet that toggles between login and signup via a
/// text link (not tabs — there's only ever one thing to do at a time). Reads
/// `AuthStore` from the environment and does its own submit/error handling;
/// callers just `.sheet(isPresented:) { AuthSheet() }`.
struct AuthSheet: View {
    private enum Mode {
        case login
        case signup

        var title: String {
            switch self {
            case .login: return "Sign in"
            case .signup: return "Create account"
            }
        }

        var switchPrompt: String {
            switch self {
            case .login: return "Need an account? Sign up"
            case .signup: return "Have an account? Sign in"
            }
        }

        var submitLabel: String {
            switch self {
            case .login: return "Sign in"
            case .signup: return "Create account"
            }
        }
    }

    @Environment(AuthStore.self) private var authStore
    @Environment(\.dismiss) private var dismiss

    @State private var mode: Mode = .login
    @State private var name = ""
    @State private var email = ""
    @State private var password = ""
    @State private var isBusy = false
    @State private var errorMessage: String?
    @FocusState private var focusedField: Field?

    private enum Field {
        case name, email, password
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                    Text(mode.title)
                        .font(Theme.title())
                        .foregroundStyle(Theme.Colors.primaryText)

                    VStack(spacing: Theme.Spacing.md) {
                        if mode == .signup {
                            AuthField(placeholder: "Name", text: $name)
                                .textContentType(.name)
                                .focused($focusedField, equals: .name)
                                .submitLabel(.next)
                                .onSubmit { focusedField = .email }
                        }

                        AuthField(placeholder: "Email", text: $email)
                            .textContentType(.emailAddress)
                            .keyboardType(.emailAddress)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .focused($focusedField, equals: .email)
                            .submitLabel(.next)
                            .onSubmit { focusedField = .password }

                        AuthField(placeholder: "Password", text: $password, isSecure: true)
                            .textContentType(mode == .login ? .password : .newPassword)
                            .focused($focusedField, equals: .password)
                            .submitLabel(.go)
                            .onSubmit { submit() }
                    }

                    if let errorMessage {
                        Text(errorMessage)
                            .font(Theme.body(14))
                            .foregroundStyle(Theme.Colors.negative)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    Button {
                        submit()
                    } label: {
                        ZStack {
                            Text(mode.submitLabel).opacity(isBusy ? 0 : 1)
                            if isBusy {
                                ProgressView().tint(.white)
                            }
                        }
                    }
                    .prominentGlassButton()
                    .disabled(!canSubmit || isBusy)
                    .opacity(canSubmit ? 1 : 0.5)

                    Button {
                        errorMessage = nil
                        mode = mode == .login ? .signup : .login
                    } label: {
                        Text(mode.switchPrompt)
                            .font(Theme.body(14))
                            .foregroundStyle(Theme.Colors.accent)
                    }
                    .frame(maxWidth: .infinity, alignment: .center)
                }
                .padding(Theme.Spacing.lg)
            }
            .background(Theme.Colors.background)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    private var canSubmit: Bool {
        let hasCore = !email.trimmingCharacters(in: .whitespaces).isEmpty && !password.isEmpty
        switch mode {
        case .login: return hasCore
        case .signup: return hasCore && !name.trimmingCharacters(in: .whitespaces).isEmpty
        }
    }

    private func submit() {
        guard canSubmit, !isBusy else { return }
        errorMessage = nil
        isBusy = true
        Task {
            defer { isBusy = false }
            do {
                switch mode {
                case .login:
                    try await authStore.login(email: email, password: password)
                case .signup:
                    try await authStore.signup(name: name, email: email, password: password)
                }
                dismiss()
            } catch let error as APIError {
                errorMessage = error.errorDescription
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}

/// Plain bordered text field matching the walnut-and-brass surface — no
/// system chrome, sized for a 16pt+ minimum per the design bar.
private struct AuthField: View {
    let placeholder: String
    @Binding var text: String
    var isSecure: Bool = false

    var body: some View {
        Group {
            if isSecure {
                SecureField(placeholder, text: $text)
            } else {
                TextField(placeholder, text: $text)
            }
        }
        .font(Theme.body(17))
        .foregroundStyle(Theme.Colors.primaryText)
        .padding(.vertical, 14)
        .padding(.horizontal, Theme.Spacing.md)
        .background(Theme.Colors.surface, in: RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                .stroke(Theme.Colors.primaryText.opacity(0.08), lineWidth: 1)
        )
    }
}

#Preview("Login") {
    AuthSheet()
        .environment(AuthStore.preview())
}
