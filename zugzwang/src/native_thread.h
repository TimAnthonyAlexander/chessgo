#pragma once

// zug::NativeThread — a std::thread work-alike that guarantees a LARGE stack.
//
// Direct port of Stockfish's thread_win32_osx.h (~sf18-arm/src/thread_win32_osx.h),
// including its reasoning: on macOS every thread except the main one is created with a
// ~512KB stack, and "this is too low for deep searches, which require somewhat more than
// 1MB stack". SF's fix is to call pthread_create with the stack size set to the LINUX
// 8MB DEFAULT, so every platform behaves like the one the engine is actually tuned and
// shipped on. This is the same fix, for the same reason.
//
// zug's own numbers, measured on this binary (arm64, -O3):
//   * Search::start()'s frame is ~140KB — it owns `Stack stack[MAX_PLY + 13]`.
//   * each negamax frame is ~4.1KB — dominated by its `MoveList` (256 ExtMove).
// A 544KB macOS thread stack therefore runs out at roughly 86 plies of recursion, and
// MAX_PLY is 246: worst case demand is ~1.15MB. On Linux the default is already 8MB, so
// there NativeThread is a plain std::thread and nothing changes at all.
//
// This ceiling was invisible until the Syzygy root-DTZ ranking landed. Before it, the
// in-search WDL probe returned at ply 1 for every ≤5-man node, so a tablebase endgame
// never recursed at all; with the probe correctly disabled inside a DTZ-ranked root (SF
// tbprobe.cpp:1764-1766) the search runs for real, the ID loop reaches depth 245 in a
// trivial ending, and a KBNvK conversion recursed 86 plies straight into the guard page
// (SIGBUS, macOS: "Thread stack size exceeded due to excessive recursion").
//
// API is the subset of std::thread this engine uses: default construct, construct from a
// callable, move, joinable(), join(). Move-only, like std::thread.

#include <thread>

#if defined(__APPLE__) || defined(USE_PTHREADS)

    #include <functional>
    #include <pthread.h>
    #include <type_traits>
    #include <utility>

namespace zug {

class NativeThread {
   public:
    // Linux's default thread stack size — the size the engine is tuned against.
    static constexpr size_t TH_STACK_SIZE = 8 * 1024 * 1024;

    NativeThread() = default;

    // enable_if keeps this greedy template from hijacking the move constructor when it is
    // handed a non-const NativeThread lvalue.
    template<class Function, class... Args,
             class = std::enable_if_t<
               !std::is_same_v<std::decay_t<Function>, NativeThread>>>
    explicit NativeThread(Function&& fun, Args&&... args) {
        auto* func = new std::function<void()>(
          std::bind(std::forward<Function>(fun), std::forward<Args>(args)...));

        pthread_attr_t attr;
        pthread_attr_init(&attr);
        pthread_attr_setstacksize(&attr, TH_STACK_SIZE);

        auto start_routine = [](void* ptr) -> void* {
            auto* f = reinterpret_cast<std::function<void()>*>(ptr);
            (*f)();
            delete f;
            return nullptr;
        };

        if (pthread_create(&thread_, &attr, start_routine, func) == 0)
            started_ = true;
        else
            delete func;  // spawn refused: stay non-joinable rather than leak the closure
        pthread_attr_destroy(&attr);
    }

    NativeThread(const NativeThread&)            = delete;
    NativeThread& operator=(const NativeThread&) = delete;

    NativeThread(NativeThread&& o) noexcept : thread_(o.thread_), started_(o.started_) {
        o.started_ = false;
    }
    NativeThread& operator=(NativeThread&& o) noexcept {
        if (this != &o) {
            thread_    = o.thread_;
            started_   = o.started_;
            o.started_ = false;
        }
        return *this;
    }

    bool joinable() const { return started_; }
    void join() {
        if (started_) {
            pthread_join(thread_, nullptr);
            started_ = false;
        }
    }

   private:
    pthread_t thread_{};
    bool      started_ = false;
};

}  // namespace zug

#else  // every other platform: the STL default stack is already 8MB

namespace zug {
using NativeThread = std::thread;
}  // namespace zug

#endif
