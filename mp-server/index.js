/* eslint-disable no-console */
"use strict";

const http = require("http");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const { Server } = require("socket.io");
const { Chess } = require("chess.js");

const PORT = Number(process.env.PORT || 4000);

// ---- Clock config (5 min default) ----
const INITIAL_CLOCK_MS = Number(process.env.INITIAL_CLOCK_MS || 5 * 60 * 1000);
const CLOCK_TICK_MS = Number(process.env.CLOCK_TICK_MS || 1000);

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true },
});

const games = new Map(); // gameId -> game

function newToken() {
  return crypto.randomBytes(24).toString("hex");
}
function newGameId() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}
function nowMs() {
  return Date.now();
}

// Node 18+ has global fetch
const _fetch = globalThis.fetch;

function seatFromToken(game, token) {
  if (!token) return "spectator";
  if (token === game.tokens.white) return "white";
  if (token === game.tokens.black) return "black";
  return "spectator";
}

// ---------------- Clock helpers ----------------
function ensureClock(game) {
  if (game.clock) return;
  game.clock = {
    whiteMs: INITIAL_CLOCK_MS,
    blackMs: INITIAL_CLOCK_MS,
    running: false,
    active: "w", // 'w' | 'b'
    lastTs: null,
  };
}

function startClockIfReady(game) {
  ensureClock(game);
  if (game.clock.running) return;
  if (!game.tokens.black) return; // only once 2 players exist
  if (game.status !== "playing") return;

  game.clock.running = true;
  game.clock.active = "w"; // white starts
  game.clock.lastTs = nowMs();
}

function pauseClock(game) {
  if (!game.clock) return;
  game.clock.running = false;
  game.clock.lastTs = null;
}

function tickClock(game) {
  if (!game.clock?.running) return;
  if (game.status !== "playing") return;

  const now = nowMs();
  const last = game.clock.lastTs ?? now;
  const elapsed = now - last;
  if (elapsed <= 0) return;

  if (game.clock.active === "w") game.clock.whiteMs -= elapsed;
  else game.clock.blackMs -= elapsed;

  game.clock.lastTs = now;

  // timeout check
  if (game.clock.whiteMs <= 0 || game.clock.blackMs <= 0) {
    game.status = "ended";
    game.reason = "timeout";
    game.result =
      game.clock.whiteMs <= 0 && game.clock.blackMs <= 0
        ? "1/2-1/2"
        : game.clock.whiteMs <= 0
          ? "0-1"
          : "1-0";
    pauseClock(game);
  }
}

function stateFor(game) {
  return {
    gameId: game.id,
    status: game.status, // waiting | playing | ended
    fen: game.chess.fen(),
    pgn: game.chess.pgn({ newline_char: "\n" }),
    turn: game.chess.turn(), // 'w' | 'b'
    moves: game.moves, // [{from,to,san}]
    result: game.result || "",
    reason: game.reason || "",
    drawOffer: game.drawOffer || null, // 'white'|'black'|null
    drawOfferCount: game.drawOfferCount || { white: 0, black: 0 },

    // PEP info - hide wallet addresses, only share stake and escrow addresses
    pep: {
      stake: game.pep.stake,
      matchId: game.pep.matchId,
      whiteEscrow: game.pep.whiteEscrow,
      blackEscrow: game.pep.blackEscrow,
      status: game.pep.status,
      error: game.pep.error,
      // Boolean flags so each side knows if address is set (without revealing it)
      whiteAddressSet: !!game.pep.whiteAddress,
      blackAddressSet: !!game.pep.blackAddress,
    },

    // clock fields (top-level + nested for compatibility)
    whiteTimeMs: game.clock?.whiteMs ?? null,
    blackTimeMs: game.clock?.blackMs ?? null,
    clock: game.clock
      ? {
          whiteMs: game.clock.whiteMs,
          blackMs: game.clock.blackMs,
          running: game.clock.running,
          active: game.clock.active,
        }
      : null,

    players: {
      white: game.tokens.white ? { connected: !!game.connected.white } : null,
      black: game.tokens.black ? { connected: !!game.connected.black } : null,
    },
  };
}

function endIfGameOver(game) {
  if (game.status === "ended") return;

  if (!game.chess.isGameOver()) {
    game.status = game.tokens.black ? "playing" : "waiting";
    return;
  }

  game.status = "ended";
  pauseClock(game);

  if (game.chess.isCheckmate()) {
    const loserTurn = game.chess.turn(); // side to move is checkmated
    const winner = loserTurn === "w" ? "black" : "white";
    game.result = winner === "white" ? "1-0" : "0-1";
    game.reason = "checkmate";
    return;
  }

  if (game.chess.isStalemate()) {
    game.result = "1/2-1/2";
    game.reason = "stalemate";
    return;
  }

  if (game.chess.isThreefoldRepetition()) {
    game.result = "1/2-1/2";
    game.reason = "threefold repetition";
    return;
  }

  if (game.chess.isInsufficientMaterial()) {
    game.result = "1/2-1/2";
    game.reason = "insufficient material";
    return;
  }

  game.result = "1/2-1/2";
  game.reason = "draw";
}

function broadcastState(game) {
  io.to(game.id).emit("state", stateFor(game));
}

// ------------- HTTP -------------
app.get("/health", (_, res) => res.json({ ok: true }));

// Create a new online game (creator becomes white)
app.post("/api/games", (req, res) => {
  const id = newGameId();

  const game = {
    id,
    createdAt: nowMs(),
    status: "waiting",
    chess: new Chess(),
    tokens: {
      white: newToken(),
      black: null,
    },
    connected: {
      white: false,
      black: false,
    },
    moves: [],
    drawOffer: null,
    drawOfferCount: { white: 0, black: 0 }, // Track how many times each player offered a draw
    result: "",
    reason: "",

    pep: {
      stake: null,
      whiteAddress: null,
      blackAddress: null,
      matchId: null,
      whiteEscrow: null,
      blackEscrow: null,
      status: null,
      error: null,
    },

    clock: {
      whiteMs: INITIAL_CLOCK_MS,
      blackMs: INITIAL_CLOCK_MS,
      running: false,
      active: "w",
      lastTs: null,
    },
  };

  games.set(id, game);

  res.json({
    gameId: id,
    token: game.tokens.white,
    color: "white",
    state: stateFor(game),
  });
});

// Join an existing game (joiner becomes black)
app.post("/api/games/:id/join", (req, res) => {
  const id = (req.params.id || "").trim();
  const game = games.get(id);

  if (!game) return res.json({ error: "Game not found." });
  if (game.tokens.black) return res.json({ error: "Game already has 2 players." });

  game.tokens.black = newToken();
  game.status = "playing";
 // startClockIfReady(game);

  res.json({
    gameId: game.id,
    token: game.tokens.black,
    color: "black",
    state: stateFor(game),
  });

  broadcastState(game);
});

const API_BASE = process.env.PEPCHESS_API_URL || "http://127.0.0.1:8001";

// Create PEP match (any player, but only once)
// Uses stored addresses from set_pep_info - addresses are private to each player
app.post("/api/games/:id/pep/create", async (req, res) => {
  const id = (req.params.id || "").trim();
  const game = games.get(id);
  if (!game) return res.status(404).json({ error: "Game not found." });

  const { token } = req.body || {};
  const seat = seatFromToken(game, token);
  if (seat === "spectator") {
    return res.status(403).json({ error: "Only players can create the PEP match." });
  }

  // Prevent creating multiple PEP matches
  if (game.pep.matchId) {
    return res.status(400).json({ error: "PEP match already exists." });
  }

  // Use stored addresses and stake (set via set_pep_info socket event)
  const stake = game.pep.stake;
  const whiteAddress = game.pep.whiteAddress;
  const blackAddress = game.pep.blackAddress;

  if (!stake || stake <= 0) {
    return res.status(400).json({ error: "Stake must be set before creating PEP match." });
  }
  if (!whiteAddress) {
    return res.status(400).json({ error: "White address not set. White player must enter their address." });
  }
  if (!blackAddress) {
    return res.status(400).json({ error: "Black address not set. Black player must enter their address." });
  }

  if (!_fetch) {
    return res.status(500).json({ error: "Server fetch() not available. Use Node 18+ or add node-fetch." });
  }

  try {
    const r = await _fetch(`${API_BASE}/api/matches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        white_address: whiteAddress,
        black_address: blackAddress,
        stake: Number(stake),
      }),
    });

    const data = await r.json();
    if (!r.ok) return res.status(400).json({ error: data });
    game.pep.matchId = data.matchId;
    game.pep.whiteEscrow = data.whiteEscrow;
    game.pep.blackEscrow = data.blackEscrow;
    game.pep.status = data.status || "created";
    game.pep.error = null;

    broadcastState(game);
    return res.json({ ok: true, pep: game.pep });
  } catch (e) {
    game.pep.error = "pep create failed";
    broadcastState(game);
    return res.status(500).json({ error: "Failed to create match" });
  }
});

// Abort PEP match - broadcasts status to both players
app.post("/api/games/:id/pep/abort", async (req, res) => {
  const id = (req.params.id || "").trim();
  const game = games.get(id);
  if (!game) return res.status(404).json({ error: "Game not found." });

  const { token } = req.body || {};
  const seat = seatFromToken(game, token);
  if (seat === "spectator") {
    return res.status(403).json({ error: "Only players can abort." });
  }

  if (!game.pep.matchId) {
    return res.status(400).json({ error: "No PEP match to abort." });
  }

  if (game.pep.status === "aborted") {
    return res.status(400).json({ error: "Match already aborted." });
  }

  try {
    const r = await _fetch(`${API_BASE}/api/matches/${game.pep.matchId}/abort`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    const data = await r.json();
    if (!r.ok) return res.status(400).json({ error: data });

    // Update game state and broadcast to both players
    game.pep.status = "aborted";
    game.status = "ended";
    game.reason = "aborted";
    game.result = "";
    pauseClock(game);

    broadcastState(game);
    return res.json({ ok: true, ...data });
  } catch (e) {
    return res.status(500).json({ error: "Failed to abort match" });
  }
});

// ------------- Socket.io -------------
io.on("connection", (socket) => {
  socket.on("join_game", ({ gameId, token }) => {
  const id = (gameId || "").trim();
  const game = games.get(id);

  if (!game) {
    socket.emit("error_msg", { error: "Game not found." });
    return;
  }

  let seat = seatFromToken(game, token);

  // ✅ If someone joins from an invite link (no token) and black is free, assign them as black
  if (seat === "spectator" && !game.tokens.black) {
    game.tokens.black = newToken();
    game.status = "playing";
    token = game.tokens.black;
    seat = "black";
  }

  socket.data.gameId = game.id;
  socket.data.token = token;
  socket.data.seat = seat;

  socket.join(game.id);

  if (seat === "white" || seat === "black") {
    game.connected[seat] = true;
  }

  // send token back so client can store it
  socket.emit("joined", { seat, token, state: stateFor(game) });
  broadcastState(game);
});

  // IMPORTANT: do NOT trust gameId/token from client after join.
  function getBoundGame() {
    const id = (socket.data.gameId || "").trim();
    if (!id) return null;
    return games.get(id) || null;
  }

  // Set PEP info (stake and player's own wallet address)
  socket.on("set_pep_info", ({ stake, address }) => {
    const game = getBoundGame();
    if (!game) return socket.emit("error_msg", { error: "Game not found." });

    const seat = seatFromToken(game, socket.data.token);
    if (seat !== "white" && seat !== "black") {
      return socket.emit("error_msg", { error: "Only players can set PEP info." });
    }

    // Can't change PEP info once match is created
    if (game.pep.matchId) {
      return socket.emit("error_msg", { error: "Cannot change PEP info after match is created." });
    }

    // Update stake (any player can set/update before match creation)
    if (stake !== undefined && stake !== null) {
      game.pep.stake = Number(stake) || null;
    }

    // Update this player's address only
    if (address !== undefined) {
      if (seat === "white") {
        game.pep.whiteAddress = address || null;
      } else {
        game.pep.blackAddress = address || null;
      }
    }

    broadcastState(game);
  });

  socket.on("move", ({ from, to, promotion }) => {
    const game = getBoundGame();
    if (!game) {
      socket.emit("error_msg", { error: "Game not found." });
      return;
    }

    const token = socket.data.token;
    const seat = seatFromToken(game, token);
    if (seat !== "white" && seat !== "black") {
      socket.emit("error_msg", { error: "Invalid token." });
      return;
    }

    if (game.status === "ended") {
      socket.emit("error_msg", { error: "Game already ended." });
      return;
    }

    if (game.status !== "playing") {
      socket.emit("error_msg", { error: "Game not started." });
      return;
    }

    // Start clock on first move (prevents deposit-confirm waiting from timing out)
    if (!game.clock?.running) startClockIfReady(game);

    // charge thinking time before move
    tickClock(game);
    if (game.status === "ended") {
      broadcastState(game);
      return;
    }

    const expectedTurn = seat === "white" ? "w" : "b";
    if (game.chess.turn() !== expectedTurn) {
      socket.emit("error_msg", { error: "Not your turn." });
      return;
    }

    try {
      const mv = game.chess.move({
        from,
        to,
        promotion: promotion || undefined,
      });

      if (!mv) {
        socket.emit("error_msg", { error: "Illegal move." });
        return;
      }

      game.moves.push({ from: mv.from, to: mv.to, san: mv.san });
      game.drawOffer = null;

      // switch clock to opponent
      if (game.clock?.running) {
        game.clock.active = game.chess.turn();
        game.clock.lastTs = nowMs();
      }

      endIfGameOver(game);
      broadcastState(game);
    } catch (e) {
      socket.emit("error_msg", { error: "Move failed." });
    }
  });

  socket.on("offer_draw", () => {
    const game = getBoundGame();
    if (!game) return socket.emit("error_msg", { error: "Game not found." });

    const seat = seatFromToken(game, socket.data.token);
    if (seat !== "white" && seat !== "black") return socket.emit("error_msg", { error: "Invalid token." });
    if (game.status !== "playing") return;

    // Check draw offer cap (3 per player)
    const MAX_DRAW_OFFERS = 3;
    if (game.drawOfferCount[seat] >= MAX_DRAW_OFFERS) {
      return socket.emit("error_msg", { error: `You can only offer draw ${MAX_DRAW_OFFERS} times per game.` });
    }

    game.drawOffer = seat;
    game.drawOfferCount[seat]++;
    broadcastState(game);
  });

  socket.on("accept_draw", () => {
    const game = getBoundGame();
    if (!game) return socket.emit("error_msg", { error: "Game not found." });

    const seat = seatFromToken(game, socket.data.token);
    if (seat !== "white" && seat !== "black") return socket.emit("error_msg", { error: "Invalid token." });
    if (game.status !== "playing") return;

    if (!game.drawOffer || game.drawOffer === seat) {
      return socket.emit("error_msg", { error: "No opponent draw offer to accept." });
    }

    game.status = "ended";
    game.result = "1/2-1/2";
    game.reason = "agreed draw";
    game.drawOffer = null;
    pauseClock(game);

    broadcastState(game);
  });

  socket.on("decline_draw", () => {
    const game = getBoundGame();
    if (!game) return socket.emit("error_msg", { error: "Game not found." });

    const seat = seatFromToken(game, socket.data.token);
    if (seat !== "white" && seat !== "black") return socket.emit("error_msg", { error: "Invalid token." });
    if (game.status !== "playing") return;

    // Can only decline if there's an offer from opponent
    if (!game.drawOffer || game.drawOffer === seat) {
      return socket.emit("error_msg", { error: "No opponent draw offer to decline." });
    }

    game.drawOffer = null;
    broadcastState(game);
  });

  socket.on("resign", () => {
    const game = getBoundGame();
    if (!game) return socket.emit("error_msg", { error: "Game not found." });

    const seat = seatFromToken(game, socket.data.token);
    if (seat !== "white" && seat !== "black") return socket.emit("error_msg", { error: "Invalid token." });
    if (game.status === "ended") return;

    const winner = seat === "white" ? "black" : "white";
    game.status = "ended";
    game.result = winner === "white" ? "1-0" : "0-1";
    game.reason = "resignation";
    game.drawOffer = null;
    pauseClock(game);

    broadcastState(game);
  });

  socket.on("disconnect", () => {
    const game = getBoundGame();
    if (!game) return;

    const seat = socket.data.seat;
    if (seat === "white" || seat === "black") {
      game.connected[seat] = false;
      broadcastState(game);
    }
  });
});

// Global ticker: broadcast updated clock
setInterval(() => {
  for (const game of games.values()) {
    if (game.status !== "playing") continue;
    if (!game.clock?.running) continue;
    tickClock(game);
    broadcastState(game);
  }
}, CLOCK_TICK_MS);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`mp-server listening on :${PORT}`);
});
