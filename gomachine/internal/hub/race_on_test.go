//go:build race

package hub

// raceDetectorOn reports whether the binary was built with -race. Used to skip
// real-time, timing-sensitive tests (e.g. filler self-play) whose wall-clock
// deadlines are unreliable under the race detector's ~10× slowdown plus the
// suite's accumulated (un-shutdown) hub goroutines. Coverage stays in normal runs.
const raceDetectorOn = true
