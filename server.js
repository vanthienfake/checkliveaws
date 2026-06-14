const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { AWSChecker } = require('./checker');

const app = express();
const server = http.createServer(app);

// ═══════════════════════════════════════════════════════
// Socket.IO with increased timeouts for 24/7 stability
// ═══════════════════════════════════════════════════════
const io = new Server(server, {
  cors: { origin: '*' },
  // Increase ping timeout to 120s (default 20s) — prevents false disconnects on slow networks
  pingTimeout: 120000,
  // Ping every 30s (default 25s) — keeps connection alive
  pingInterval: 30000,
  // Allow up to 10MB payloads (for large email lists)
  maxHttpBufferSize: 10e6,
  // Connection state recovery: allows client to reconnect and get missed events
  connectionStateRecovery: {
    maxDisconnectionDuration: 5 * 60 * 1000, // 5 minutes
    skipMiddlewares: true,
  },
  // Transport fallback
  transports: ['websocket', 'polling'],
  // Allow upgrades from polling to websocket
  allowUpgrades: true,
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ═══════════════════════════════════════════════════════
// Session-based checker management
// Checkers are stored by sessionId (not socket.id) so they
// survive temporary disconnects. A grace period allows
// the client to reconnect without losing progress.
// ═══════════════════════════════════════════════════════
const sessions = new Map(); // sessionId -> { checker, results, logs, progress, socketId, disconnectTimer, status }

// Grace period before stopping checker after disconnect (5 minutes)
const DISCONNECT_GRACE_MS = 5 * 60 * 1000;

// Periodic cleanup of stale sessions (sessions that completed + no client for > 30 min)
const STALE_SESSION_CLEANUP_MS = 30 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (session.status === 'completed' && session.disconnectedAt && (now - session.disconnectedAt > STALE_SESSION_CLEANUP_MS)) {
      console.log(`[cleanup] Removing stale session: ${sessionId}`);
      sessions.delete(sessionId);
    }
  }
}, 10 * 60 * 1000); // Run every 10 minutes

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    sessions: sessions.size,
    activeSessions: Array.from(sessions.values()).filter(s => s.status === 'running').length,
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString()
  });
});

io.on('connection', (socket) => {
  console.log(`[+] Client connected: ${socket.id}`);

  // ═══ Client registers with a sessionId ═══
  socket.on('register-session', (sessionId) => {
    if (!sessionId) return;

    console.log(`[session] Client ${socket.id} registered session: ${sessionId}`);

    const session = sessions.get(sessionId);
    if (session) {
      // Reconnecting to existing session
      console.log(`[session] Resuming session ${sessionId} (status: ${session.status})`);

      // Cancel disconnect grace timer
      if (session.disconnectTimer) {
        clearTimeout(session.disconnectTimer);
        session.disconnectTimer = null;
        console.log(`[session] Cancelled disconnect timer for ${sessionId}`);
      }

      // Update socket reference
      session.socketId = socket.id;
      session.disconnectedAt = null;

      // Send buffered data to reconnected client
      socket.emit('session-restored', {
        sessionId,
        status: session.status,
        results: session.results,
        progress: session.progress,
        recentLogs: session.logs.slice(-100), // Last 100 logs
      });

      // Re-bind checker callbacks to the new socket
      if (session.checker && session.status === 'running') {
        rebindCheckerCallbacks(session, socket, sessionId);
      }
    } else {
      // New session
      socket.emit('session-new', { sessionId });
    }

    // Store sessionId on socket for disconnect handling
    socket.sessionId = sessionId;
  });

  // ═══ Start check ═══
  socket.on('start-check', async (data) => {
    const { emails, proxies, captchaKey, threads, delay, tmproxyKeys, tmproxyLocation, tmproxyIsp, proxyRotateInterval, sessionId } = data;

    if (!emails || emails.length === 0) {
      socket.emit('error', { message: 'Vui lòng nhập ít nhất 1 email' });
      return;
    }

    if (!sessionId) {
      socket.emit('error', { message: 'Session ID required' });
      return;
    }

    // Cancel any previous running checker for this session
    const existingSession = sessions.get(sessionId);
    if (existingSession && existingSession.checker) {
      existingSession.checker.stop();
      if (existingSession.disconnectTimer) {
        clearTimeout(existingSession.disconnectTimer);
      }
    }

    // Parse TMProxy keys
    let parsedTMKeys = [];
    if (Array.isArray(tmproxyKeys)) {
      parsedTMKeys = tmproxyKeys.filter(k => k && k.trim());
    } else if (typeof tmproxyKeys === 'string') {
      parsedTMKeys = tmproxyKeys.split('\n').map(k => k.trim()).filter(k => k);
    }

    // Create session data
    const session = {
      checker: null,
      results: [],
      logs: [],
      progress: { checked: 0, total: emails.length, live: 0, dead: 0, error: 0 },
      socketId: socket.id,
      disconnectTimer: null,
      disconnectedAt: null,
      status: 'running',
      startedAt: Date.now(),
    };

    const checker = new AWSChecker({
      emails,
      proxies: proxies || [],
      captchaKey: captchaKey || '',
      tmproxyKeys: parsedTMKeys,
      tmproxyLocation: tmproxyLocation || 1,
      tmproxyIsp: tmproxyIsp || 0,
      proxyRotateInterval: proxyRotateInterval || 240,
      threads: threads || 1,
      delay: delay || 2000,
      onResult: (result) => {
        session.results.push(result);
        emitToSession(sessionId, 'result', result);
      },
      onProgress: (progress) => {
        session.progress = progress;
        emitToSession(sessionId, 'progress', progress);
      },
      onLog: (log) => {
        session.logs.push(log);
        // Keep only last 500 logs in memory
        if (session.logs.length > 500) {
          session.logs = session.logs.slice(-500);
        }
        emitToSession(sessionId, 'log', log);
      },
      onComplete: (summary) => {
        session.status = 'completed';
        emitToSession(sessionId, 'complete', summary);
      }
    });

    session.checker = checker;
    sessions.set(sessionId, session);

    try {
      await checker.start();
    } catch (err) {
      session.status = 'error';
      emitToSession(sessionId, 'error', { message: err.message });
    }
  });

  // ═══ Stop check ═══
  socket.on('stop-check', (data) => {
    const sessionId = data?.sessionId || socket.sessionId;
    if (!sessionId) return;

    const session = sessions.get(sessionId);
    if (session && session.checker) {
      session.checker.stop();
      session.status = 'stopped';
      socket.emit('log', { type: 'warn', message: 'Đã dừng kiểm tra.' });
    }
  });

  // ═══ Client disconnect — start grace period instead of immediately stopping ═══
  socket.on('disconnect', (reason) => {
    const sessionId = socket.sessionId;
    console.log(`[-] Client disconnected: ${socket.id} (reason: ${reason})`);

    if (!sessionId) return;

    const session = sessions.get(sessionId);
    if (!session) return;

    // Only set grace timer if checker is still running
    if (session.status === 'running' && session.checker && session.checker.running) {
      console.log(`[session] Starting ${DISCONNECT_GRACE_MS / 1000}s grace period for session ${sessionId}`);
      session.disconnectedAt = Date.now();

      session.disconnectTimer = setTimeout(() => {
        console.log(`[session] Grace period expired for ${sessionId} — stopping checker`);
        if (session.checker && session.checker.running) {
          session.checker.stop();
          session.status = 'disconnected';
        }
      }, DISCONNECT_GRACE_MS);
    }
  });

  // ═══ Heartbeat — client sends periodically to confirm it's alive ═══
  socket.on('heartbeat', (data) => {
    socket.emit('heartbeat-ack', { timestamp: Date.now(), sessionId: data?.sessionId });
  });
});

// Helper: emit to the current socket of a session (if connected)
function emitToSession(sessionId, event, data) {
  const session = sessions.get(sessionId);
  if (!session) return;

  const socketId = session.socketId;
  const targetSocket = io.sockets.sockets.get(socketId);
  if (targetSocket && targetSocket.connected) {
    targetSocket.emit(event, data);
  }
  // If not connected, data is still stored in session for later replay
}

// Helper: rebind checker callbacks to a new socket after reconnect
function rebindCheckerCallbacks(session, socket, sessionId) {
  if (!session.checker) return;

  session.checker.onResult = (result) => {
    session.results.push(result);
    emitToSession(sessionId, 'result', result);
  };
  session.checker.onProgress = (progress) => {
    session.progress = progress;
    emitToSession(sessionId, 'progress', progress);
  };
  session.checker.onLog = (log) => {
    session.logs.push(log);
    if (session.logs.length > 500) {
      session.logs = session.logs.slice(-500);
    }
    emitToSession(sessionId, 'log', log);
  };
  session.checker.onComplete = (summary) => {
    session.status = 'completed';
    emitToSession(sessionId, 'complete', summary);
  };
}

// ═══════════════════════════════════════════════════════
// Global error handlers — prevent server crash
// ═══════════════════════════════════════════════════════
process.on('uncaughtException', (err) => {
  console.error('[CRITICAL] Uncaught Exception:', err.message);
  console.error(err.stack);
  // Don't exit — keep server running
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[CRITICAL] Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit — keep server running
});

// ═══ Start server ═══
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║   AWS Account Checker - Running          ║`);
  console.log(`║   http://localhost:${PORT}                  ║`);
  console.log(`║   Mode: 24/7 Persistent Sessions         ║`);
  console.log(`║   Grace Period: ${DISCONNECT_GRACE_MS / 1000}s                    ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);
});
