package hub

import (
	"context"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/timanthonyalexander/gomachine/internal/auth"
)

const (
	sendBuffer    = 24
	heartbeatTick = 30 * time.Second // beats Cloudflare's ~100s idle drop
	writeTimeout  = 10 * time.Second
	readLimit     = 32 * 1024
)

// Client is one WebSocket connection. The hub mutates all shared state on its
// own goroutine; the client only owns its read loop and a buffered send channel
// drained by a single writer goroutine (so a slow client never stalls the hub).
type Client struct {
	hub    *Hub
	conn   *websocket.Conn
	id     auth.Identity
	send   chan []byte
	ctx    context.Context
	cancel context.CancelFunc

	// Touched only by the hub goroutine:
	game     *game
	pool     string    // current queue pool, "" if not queued
	queuedAt time.Time // when the client entered its current pool (for bot backfill)
}

func (c *Client) readPump() {
	c.conn.SetReadLimit(readLimit)
	for {
		var msg inMsg
		if err := wsjson.Read(c.ctx, c.conn, &msg); err != nil {
			return
		}
		select {
		case c.hub.commands <- command{client: c, msg: msg}:
		case <-c.ctx.Done():
			return
		}
	}
}

func (c *Client) writePump() {
	ping := time.NewTicker(heartbeatTick)
	defer ping.Stop()
	for {
		select {
		case <-c.ctx.Done():
			return
		case data, ok := <-c.send:
			if !ok {
				return
			}
			ctx, cancel := context.WithTimeout(c.ctx, writeTimeout)
			err := c.conn.Write(ctx, websocket.MessageText, data)
			cancel()
			if err != nil {
				c.cancel()
				return
			}
		case <-ping.C:
			ctx, cancel := context.WithTimeout(c.ctx, writeTimeout)
			err := c.conn.Ping(ctx)
			cancel()
			if err != nil {
				c.cancel()
				return
			}
		}
	}
}

// trySend queues a pre-marshaled message; if the buffer is full the client is
// too slow, so we drop the connection rather than block the hub.
func (c *Client) trySend(data []byte) {
	select {
	case c.send <- data:
	default:
		c.cancel()
	}
}
