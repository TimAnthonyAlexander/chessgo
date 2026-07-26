import SwiftUI

/// App shell. Four tabs mirroring the web's primary areas. Feature waves fill
/// each tab's root view; this skeleton keeps the foundation compiling.
struct RootTabView: View {
    var body: some View {
        TabView {
            Tab("Play", systemImage: "play.circle.fill") {
                HomeView()
            }
            Tab("Puzzles", systemImage: "puzzlepiece.fill") {
                PuzzlesView()
            }
            Tab("Watch", systemImage: "eye.fill") {
                WatchView()
            }
            Tab("Profile", systemImage: "person.fill") {
                NavigationStack {
                    AccountView()
                        .navigationTitle("Profile")
                        .toolbar {
                            ToolbarItem(placement: .topBarTrailing) {
                                NavigationLink {
                                    SettingsView()
                                } label: {
                                    Image(systemName: "gearshape")
                                }
                            }
                        }
                }
            }
        }
    }
}

/// Temporary placeholder until a feature wave replaces it.
struct PlaceholderScreen: View {
    let title: String
    var body: some View {
        NavigationStack {
            ContentUnavailableView(title, systemImage: "square.dashed", description: Text("Coming soon"))
                .navigationTitle(title)
        }
    }
}

#Preview {
    RootTabView()
}
