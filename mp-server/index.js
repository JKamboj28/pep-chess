/* eslint-disable no-console */
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const { Server } = require("socket.io");
const { Chess } = require("chess.js");

const PORT = Number(process.env.PORT || 4000);

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
  // short-ish id for sharing
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
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

    pep: game.pep,

    players: {
      white: game.tokens.white
        ? { connected: !!game.connected.white }
        : null,
      black: game.tokens.black
        ? { connected: !!game.connected.black }
        : null,
    },
  };
}

function seatFromToken(game, token) {
  if (!token) return "spectator";
  if (token === game.tokens.white) return "white";
  if (token === game.tokens.black) return "black";
  return "spectator";
}

function endIfGameOver(game) {
  if (game.status === "ended") return;

  if (!game.chess.isGameOver()) {
    game.status = game.tokens.black ? "playing" : "waiting";
    return;
  }

  game.status = "ended";

  if (game.chess.isCheckmate()) {
    // side to move is checkmated
    const loserTurn = game.chess.turn(); // 'w' or 'b'
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

  // generic draw
  game.result = "1/2-1/2";
  game.reason = "draw";
}

function broadcastState(game) {
  io.to(game.id).emit("state", stateFor(game));
}

app.get("/health", (_, res) => res.json({ ok: true }));

// Create a new online game (creator becomes white)
app.post("/api/games", (req, res) => {
  const id = newGameId();

  const game = {
    id,
    createdAt: Date.now(),
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
    result: "",
    reason: "",

  pep: {
    stake: null,
    whiteAddress: null,
    blackAddress: null,
    matchId: null,
    whiteEscrow: null,
    blackEscrow: null,
    status: null, // e.g. "created" | "waiting_for_deposits" | ...
    error: null,
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

  if (!game) {
    return res.json({ error: "Game not found." });
  }
  if (game.tokens.black) {
    return res.json({ error: "Game already has 2 players." });
  }

  game.tokens.black = newToken();
  game.status = "playing";

  res.json({
    gameId: game.id,
    token: game.tokens.black,
    color: "black",
    state: stateFor(game),
  });

  broadcastState(game);
});

const API_BASE = process.env.PEPCHESS_API_URL || "http://127.0.0.1:8001";

app.post("/api/games/:id/pep/create", async (req, res) => {
  const id = (req.params.id || "").trim();
  const game = games.get(id);
  if (!game) return res.status(404).json({ error: "Game not found." });

  const { token, stake, whiteAddress, blackAddress } = req.body || {};

  const tok = token || socket.data.token
  const seat = seatFromToken(game, tok);
  if (seat !== "white") {
    return res.status(403).json({ error: "Only white can create the PEP match." });
  }

  if (!stake || !whiteAddress || !blackAddress) {
    return res.status(400).json({ error: "stake, whiteAddress, blackAddress required" });
  }

  try {
    const r = await fetch(`${API_BASE}/api/matches`, {
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

    // ✅ save matchId + escrows on server
    game.pep.stake = Number(stake);
    game.pep.whiteAddress = whiteAddress;
    game.pep.blackAddress = blackAddress;
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


io.on("connection", (socket) => {
  socket.on("join_game", ({ gameId, token }) => {
    const id = (gameId || "").trim();
    const game = games.get(id);

    if (!game) {
      socket.emit("error_msg", { error: "Game not found." });
      return;
    }

    const seat = seatFromToken(game, token);

    socket.data.gameId = game.id;
    socket.data.seat = seat;
    socket.data.token = token;

    socket.join(game.id);

    if (seat === "white" || seat === "black") {
      game.connected[seat] = true;
    }

    socket.emit("joined", { seat, state: stateFor(game) });
    broadcastState(game);
  });

  socket.on("move", ({ gameId, token, from, to, promotion }) => {
    const id = (gameId || socket.data.gameId || "").trim();
    const game = games.get(id);

    if (!game) {
      socket.emit("error_msg", { error: "Game not found." });
      return;
    }

    const tok = token || socket.data.token;
    const seat = seatFromToken(game, tok);
    if (seat !== "white" && seat !== "black") {
      socket.emit("error_msg", { error: "Invalid token." });
      return;
    }

    if (game.status === "ended") {
      socket.emit("error_msg", { error: "Game already ended." });
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

      // clear any draw offer once a move is played
      game.drawOffer = null;

      endIfGameOver(game);
      broadcastState(game);
    } catch (e) {
      socket.emit("error_msg", { error: "Move failed." });
    }
  });

  socket.on("offer_draw", ({ gameId, token }) => {
    const id = (gameId || socket.data.gameId || "").trim();
    const game = games.get(id);
    if (!game) return socket.emit("error_msg", { error: "Game not found." });

    const tok = token || socket.data.token;
    const seat = seatFromToken(game, tok);
    if (seat !== "white" && seat !== "black") {
      return socket.emit("error_msg", { error: "Invalid token." });
    }
    if (game.status !== "playing") return;

    game.drawOffer = seat;
    broadcastState(game);
  });

  socket.on("accept_draw", ({ gameId, token }) => {
    const id = (gameId || socket.data.gameId || "").trim();
    const game = games.get(id);
    if (!game) return socket.emit("error_msg", { error: "Game not found." });

    const tok = token || socket.data.token;
    const seat = seatFromToken(game, tok);
    if (seat !== "white" && seat !== "black") {
      return socket.emit("error_msg", { error: "Invalid token." });
    }
    if (game.status !== "playing") return;

    if (!game.drawOffer || game.drawOffer === seat) {
      return socket.emit("error_msg", { error: "No opponent draw offer to accept." });
    }

    game.status = "ended";
    game.result = "1/2-1/2";
    game.reason = "agreed draw";
    game.drawOffer = null;

    broadcastState(game);
  });

  socket.on("resign", ({ gameId, token }) => {
    const id = (gameId || socket.data.gameId || "").trim();
    const game = games.get(id);
    if (!game) return socket.emit("error_msg", { error: "Game not found." });

    const tok = token || socket.data.token;
    const seat = seatFromToken(game, tok);
    if (seat !== "white" && seat !== "black") {
      return socket.emit("error_msg", { error: "Invalid token." });
    }
    if (game.status === "ended") return;

    const winner = seat === "white" ? "black" : "white";
    game.status = "ended";
    game.result = winner === "white" ? "1-0" : "0-1";
    game.reason = "resignation";
    game.drawOffer = null;

    broadcastState(game);
  });

  socket.on("disconnect", () => {
    const id = socket.data.gameId;
    if (!id) return;

    const game = games.get(id);
    if (!game) return;

    const seat = socket.data.seat;
    if (seat === "white" || seat === "black") {
      game.connected[seat] = false;
      broadcastState(game);
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`mp-server listening on :${PORT}`);
});
