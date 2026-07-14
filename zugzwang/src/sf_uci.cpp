#include "sf_uci.h"
#include "serve_json.h" // ApiError

#include <cerrno>
#include <csignal>
#include <cstdlib>
#include <cstring>
#include <sstream>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>
#include <vector>

namespace SFUCI {
namespace {

std::string g_pathOverride;

bool is_executable_file(const std::string& p) {
    struct stat st{};
    if (::stat(p.c_str(), &st) != 0) return false;
    if (!S_ISREG(st.st_mode)) return false;
    return ::access(p.c_str(), X_OK) == 0;
}

// Minimal $PATH scan for "stockfish" (mirrors Go's exec.LookPath).
std::string lookup_in_path_env() {
    const char* pathEnv = std::getenv("PATH");
    if (!pathEnv) return "";
    std::stringstream ss(pathEnv);
    std::string dir;
    while (std::getline(ss, dir, ':')) {
        if (dir.empty()) continue;
        std::string candidate = dir + "/stockfish";
        if (is_executable_file(candidate)) return candidate;
    }
    return "";
}

std::vector<std::string> split_fields(const std::string& s) {
    std::vector<std::string> out;
    std::istringstream iss(s);
    std::string tok;
    while (iss >> tok) out.push_back(tok);
    return out;
}

// A line-buffered stdio pipe to a freshly-spawned Stockfish process. One per
// query() call — NOT reusable/thread-safe, mirroring gomachine's UCIEngine
// (bench/uci.go) being started fresh per request.
class Process {
public:
    explicit Process(std::string path) : path_(std::move(path)) {}

    ~Process() { close(); }

    void start() {
        int inPipe[2];  // parent -> child stdin
        int outPipe[2]; // child stdout -> parent
        if (pipe(inPipe) != 0) throw ApiError{502, "stockfish start: pipe() failed"};
        if (pipe(outPipe) != 0) {
            ::close(inPipe[0]);
            ::close(inPipe[1]);
            throw ApiError{502, "stockfish start: pipe() failed"};
        }

        pid_ = fork();
        if (pid_ < 0) {
            ::close(inPipe[0]);
            ::close(inPipe[1]);
            ::close(outPipe[0]);
            ::close(outPipe[1]);
            throw ApiError{502, "stockfish start: fork() failed"};
        }

        if (pid_ == 0) {
            // Child: wire pipes to stdin/stdout, exec Stockfish. Fully-qualify
            // ::close — Process::close(int argc=0) would otherwise shadow it.
            dup2(inPipe[0], STDIN_FILENO);
            dup2(outPipe[1], STDOUT_FILENO);
            ::close(inPipe[0]);
            ::close(inPipe[1]);
            ::close(outPipe[0]);
            ::close(outPipe[1]);
            char* argv[] = {const_cast<char*>(path_.c_str()), nullptr};
            execvp(path_.c_str(), argv); // PATH-resolves a bare name, like os/exec
            _exit(127);                  // exec failed
        }

        // Parent
        ::close(inPipe[0]);
        ::close(outPipe[1]);
        writeFd_ = inPipe[1];
        readFd_ = outPipe[0];
        started_ = true;
    }

    void writeLine(const std::string& line) {
        std::string s = line;
        s.push_back('\n');
        size_t off = 0;
        while (off < s.size()) {
            ssize_t n = ::write(writeFd_, s.data() + off, s.size() - off);
            if (n < 0) {
                if (errno == EINTR) continue;
                throw ApiError{502, std::string("stockfish: write failed: ") + strerror(errno)};
            }
            off += static_cast<size_t>(n);
        }
    }

    // Returns false at EOF (with no trailing partial line left to flush).
    bool readLine(std::string& out) {
        for (;;) {
            size_t nl = buf_.find('\n');
            if (nl != std::string::npos) {
                out = buf_.substr(0, nl);
                buf_.erase(0, nl + 1);
                if (!out.empty() && out.back() == '\r') out.pop_back();
                return true;
            }
            char chunk[4096];
            ssize_t n = ::read(readFd_, chunk, sizeof(chunk));
            if (n < 0) {
                if (errno == EINTR) continue;
                return false;
            }
            if (n == 0) {
                if (!buf_.empty()) {
                    out = buf_;
                    buf_.clear();
                    return true;
                }
                return false;
            }
            buf_.append(chunk, static_cast<size_t>(n));
        }
    }

    void close() {
        if (!started_) return;
        started_ = false;
        if (writeFd_ >= 0) {
            std::string q = "quit\n";
            ::write(writeFd_, q.data(), q.size()); // best-effort
            ::close(writeFd_);
            writeFd_ = -1;
        }
        if (readFd_ >= 0) {
            ::close(readFd_);
            readFd_ = -1;
        }
        if (pid_ > 0) {
            int status = 0;
            bool reaped = false;
            for (int i = 0; i < 50 && !reaped; ++i) { // ~500ms grace for a clean `quit`
                pid_t r = waitpid(pid_, &status, WNOHANG);
                if (r == pid_) reaped = true;
                else usleep(10000);
            }
            if (!reaped) {
                kill(pid_, SIGKILL);
                waitpid(pid_, &status, 0);
            }
            pid_ = -1;
        }
    }

private:
    std::string path_;
    pid_t pid_ = -1;
    int writeFd_ = -1;
    int readFd_ = -1;
    bool started_ = false;
    std::string buf_;
};

} // namespace

void set_path_override(const std::string& path) { g_pathOverride = path; }

std::string resolve_path() {
    if (!g_pathOverride.empty()) return g_pathOverride;
    if (const char* p = std::getenv("SF_PATH"); p && *p) return p;
    if (const char* p = std::getenv("STOCKFISH_PATH"); p && *p) return p;
    if (std::string found = lookup_in_path_env(); !found.empty()) return found;
    static const char* kFallbacks[] = {
        "/usr/games/stockfish", // Debian/Ubuntu (apt) — off systemd's minimal PATH
        "/usr/local/bin/stockfish",
        "/opt/homebrew/bin/stockfish", // macOS, Apple Silicon
        "/usr/bin/stockfish",
        "/bin/stockfish",
    };
    for (const char* p : kFallbacks) {
        if (is_executable_file(p)) return p;
    }
    return "";
}

BestMoveResult query(const std::string& path, const std::string& fen, int elo,
                      int movetimeMs, int depth) {
    // A Stockfish process that exits mid-write (crash, kill) would otherwise
    // SIGPIPE-kill this whole server on the next write(); ignore it globally
    // (idempotent, cheap) so a write failure surfaces as EPIPE instead.
    signal(SIGPIPE, SIG_IGN);

    Process proc(path);
    proc.start();

    auto waitForToken = [&](const char* token, const char* what) {
        std::string line;
        while (proc.readLine(line)) {
            auto f = split_fields(line);
            if (!f.empty() && f[0] == token) return;
        }
        throw ApiError{502, std::string("stockfish start: no ") + what};
    };

    proc.writeLine("uci");
    waitForToken("uciok", "uciok");

    if (elo > 0) {
        proc.writeLine("setoption name UCI_LimitStrength value true");
        proc.writeLine("setoption name UCI_Elo value " + std::to_string(elo));
    }

    proc.writeLine("isready");
    waitForToken("readyok", "readyok");

    std::string goLine;
    if (depth > 0) {
        goLine = "go depth " + std::to_string(depth);
    } else {
        int mt = movetimeMs > 0 ? movetimeMs : 100; // default 100ms — matches stockfish.go
        goLine = "go movetime " + std::to_string(mt);
    }
    proc.writeLine("position fen " + fen);
    proc.writeLine(goLine);

    BestMoveResult result;
    std::string line;
    while (proc.readLine(line)) {
        auto f = split_fields(line);
        if (f.empty()) continue;
        if (f[0] == "info") {
            for (size_t i = 0; i + 2 < f.size(); ++i) {
                if (f[i] != "score") continue;
                if (f[i + 1] == "cp") {
                    try {
                        result.value = std::stoi(f[i + 2]);
                        result.isMate = false;
                        result.hasScore = true;
                    } catch (...) {
                    }
                } else if (f[i + 1] == "mate") {
                    try {
                        // Raw UCI mate-in-N (sign = mating/getting-mated). gomachine's
                        // wire value for a mate eval IS this same raw N — its collapse
                        // to ±(20000−dist) and back is a lossless roundtrip (verified:
                        // dist == N for both signs), so there is nothing to recover here.
                        result.value = std::stoi(f[i + 2]);
                        result.isMate = true;
                        result.hasScore = true;
                    } catch (...) {
                    }
                }
            }
        } else if (f[0] == "bestmove") {
            if (f.size() >= 2 && f[1] != "(none)") result.bestmove = f[1];
            return result;
        }
    }
    throw ApiError{502, "stockfish move: unexpected EOF"};
}

} // namespace SFUCI
