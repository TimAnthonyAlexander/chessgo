package server

import (
	"container/list"
	"sync"

	"github.com/timanthonyalexander/gomachine/internal/engine"
)

// candKey identifies a cached MultiPV result by the position (our native Zobrist)
// and the search budget that produced it. Same key ⇒ identical analysis, so a
// position the analysis board revisits — the start position above all — is served
// from memory instead of re-running a full MultiPV search. (The opening NAME is
// not cached here: it's a cheap table lookup and depends on the line's history.)
//
// The key deliberately ignores game history: a position's opening-explorer eval is
// position-determined, and folding history in would miss the common "same position
// again / page refresh" hits this exists to serve. The rare repetition-draw nuance
// isn't worth losing those hits for an analysis aid.
type candKey struct {
	pos      uint64
	depth    int
	movetime int // milliseconds
}

// candCache is a bounded, concurrency-safe LRU over MultiPV results.
type candCache struct {
	mu  sync.Mutex
	cap int
	ll  *list.List // front = most-recently-used; holds *candNode
	m   map[candKey]*list.Element
}

type candNode struct {
	key candKey
	val []engine.Candidate
}

func newCandCache(capacity int) *candCache {
	if capacity < 1 {
		capacity = 1
	}
	return &candCache{cap: capacity, ll: list.New(), m: make(map[candKey]*list.Element, capacity)}
}

// get returns the cached candidates for a key (and marks it most-recently-used).
func (c *candCache) get(k candKey) ([]engine.Candidate, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.m[k]; ok {
		c.ll.MoveToFront(el)
		return el.Value.(*candNode).val, true
	}
	return nil, false
}

// put stores candidates for a key, evicting the least-recently-used entry past cap.
func (c *candCache) put(k candKey, v []engine.Candidate) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.m[k]; ok {
		el.Value.(*candNode).val = v
		c.ll.MoveToFront(el)
		return
	}
	c.m[k] = c.ll.PushFront(&candNode{key: k, val: v})
	if c.ll.Len() > c.cap {
		if old := c.ll.Back(); old != nil {
			c.ll.Remove(old)
			delete(c.m, old.Value.(*candNode).key)
		}
	}
}
