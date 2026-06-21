//go:build !race

package hub

// raceDetectorOn is false in normal (non -race) builds; see race_on_test.go.
const raceDetectorOn = false
