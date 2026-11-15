import type { Response } from 'express';
import { AppError } from '../../db/errors.js';

type Socket = { userId: string; hid: string; close: (bye?: boolean) => void; send: (message: string) => void };
const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
export class StreamHub {
  private sockets = new Set<Socket>();
  private pending = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;
  constructor(private readonly maxStreams = 5000) {}
  connect(res: Response, userId: string, hid: string, expiresAt: number) {
    if (this.stopped) throw new AppError('BUSY', 503, 'The server is restarting.', 3);
    if (expiresAt <= Date.now()) throw new AppError('UNAUTHENTICATED', 401, 'Please sign in to continue.');
    if (this.sockets.size >= this.maxStreams || [...this.sockets].filter((s) => s.userId === userId).length >= 3) {
      throw new AppError('RATE_LIMITED', 429, 'Too many live connections. Close another tab and try again.', 3);
    }
    let closed = false; let blocked = false; let dirty = false;
    let slow: ReturnType<typeof setTimeout> | undefined;
    const state = () => frame('state.changed', { hackathonId: hid });
    const close = (bye = false) => {
      if (closed) return;
      closed = true; clearTimeout(slow); clearInterval(heartbeat); clearTimeout(expiry);
      this.sockets.delete(socket); res.off('drain', drain); res.off('close', onClose); res.off('error', onClose);
      if (bye && !blocked && !res.destroyed) res.write(frame('bye', {}));
      if (blocked) res.destroy(); else res.end();
    };
    const send = (message: string) => {
      if (closed) return;
      if (blocked) { dirty = true; return; }
      if (!res.write(message)) {
        blocked = true;
        slow = setTimeout(() => close(), 5000); slow.unref();
      }
    };
    const drain = () => { blocked = false; clearTimeout(slow); if (dirty) { dirty = false; send(state()); } };
    const onClose = () => close();
    const socket: Socket = { userId, hid, close, send };
    this.sockets.add(socket);
    res.on('close', onClose); res.on('error', onClose); res.on('drain', drain);
    const heartbeat = setInterval(() => send(': heartbeat\n\n'), 20_000); heartbeat.unref();
    const expiry = setTimeout(() => close(), Math.max(0, expiresAt - Date.now())); expiry.unref();
    res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    send(`retry: 3000\n\n${frame('hello', { serverTime: new Date().toISOString() })}`);
    return close;
  }
  changed(hid: string) {
    if (this.stopped || this.pending.has(hid) || ![...this.sockets].some((s) => s.hid === hid)) return;
    const timer = setTimeout(() => {
      this.pending.delete(hid);
      for (const socket of this.sockets) if (socket.hid === hid) socket.send(frame('state.changed', { hackathonId: hid }));
    }, 250);
    timer.unref(); this.pending.set(hid, timer);
  }
  close() {
    this.stopped = true;
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    for (const socket of this.sockets) socket.close(true);
  }
}
