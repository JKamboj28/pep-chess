import React, { useEffect, useMemo, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";

type Seat = "white" | "black" | "spectator";

type PublicState = {
  gameId: string;
  status: "waiting" | "playing" | "ended";
  result: string | null;
  reason: string | null;
  fen: string;
  pgn: string;
  turn: "w" | "b";
  moves: Array<{ from: string; to: string; promotion: string | null; san: string; by: Seat; ts: string }>;
  players: { white: { connected: boolean } | null; black: { connected: boolean } | null };
  drawOffer: { by: Seat; ts: string } | null;

  // ✅ CLOCK FIELDS (sent by your server)
  whiteTimeMs: number | null;
  blackTimeMs: number | null;
  clock: null | {
    whiteMs: number;
    blackMs: number;
    running: boolean;
    active: "w" | "b";
    lastTs?: number;
  };
};

const MP_URL = (import.meta as any).env?.VITE_MP_SERVER_URL || "http://localhost:4000";

function saveSession(gameId: string, token: string, seat: Seat) {
  localStorage.setItem("pepchess_gameId", gameId);
  localStorage.setItem("pepchess_token", token);
  localStorage.setItem("pepchess_seat", seat);
}

function loadSession() {
  const gameId = localStorage.getItem("pepchess_gameId") || "";
  const token = localStorage.getItem("pepchess_token") || "";
  const seat = (localStorage.getItem("pepchess_seat") as Seat) || "spectator";
  return { gameId, token, seat };
}

function formatMs(ms: number | null | undefined) {
  if (ms == null) return "--:--";
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function OnlineGame() {
  const [statusMsg, setStatusMsg] = useState<string>("");
  const [connected, setConnected] = useState(false);

  const [gameId, setGameId] = useState("");
  const [token, setToken] = useState("");
  const [seat, setSeat] = useState<Seat>("spectator");
  const [joinInput, setJoinInput] = useState("");

  const [state, setState] = useState<PublicState | null>(null);

  const chess = useMemo(() => new Chess(), []);
  const socketRef = useRef<Socket | null>(null);

  // keep local chess synced to server fen
  useEffect(() => {
    if (!state) return;
    try {
      chess.load(state.fen);
    } catch {
      // ignore
    }
  }, [state?.fen, chess]);

  async function createGame() {
    setStatusMsg("Creating game...");
    const r = await fetch(`${MP_URL}/api/games`, { method: "POST" });
    const data = await r.json();

    setGameId(data.gameId);
    setToken(data.token);
    setSeat(data.color);
    setState(data.state);
    saveSession(data.gameId, data.token, data.color);

    setStatusMsg("Game created.");
  }

  async function joinGame() {
    const id = joinInput.trim();
    if (!id) return;

    setStatusMsg("Joining game...");
    const r = await fetch(`${MP_URL}/api/games/${id}/join`, { method: "POST" });
    const data = await r.json();

    if (data.error) {
      setStatusMsg(`Join failed: ${data.error}`);
      return;
    }

    setGameId(data.gameId);
    setToken(data.token);
    setSeat(data.color);
    setState(data.state);
    saveSession(data.gameId, data.token, data.color);

    setStatusMsg(`Joined as ${data.color}.`);
  }

  function connectSocket(gid: string, tok: string) {
    if (!gid || !tok) return;

    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }

    const s = io(MP_URL, { transports: ["websocket", "polling"] });
    socketRef.current = s;

    s.on("connect", () => {
      setConnected(true);
      s.emit("join_game", { gameId: gid, token: tok });
    });

    s.on("disconnect", () => setConnected(false));

    s.on("joined", (payload: { seat: Seat; token?: string; state: PublicState }) => {
      setSeat(payload.seat);
      if (payload.token) setToken(payload.token);
      setState(payload.state);
    });

    s.on("state", (st: PublicState) => setState(st));

    s.on("error_msg", (e: any) => {
      setStatusMsg(`Server: ${e?.error || "error"}`);
    });
  }

  // auto-load session
  useEffect(() => {
    const sess = loadSession();
    if (sess.gameId && sess.token) {
      setGameId(sess.gameId);
      setToken(sess.token);
      setSeat(sess.seat);
      connectSocket(sess.gameId, sess.token);
      setStatusMsg("Reconnected from saved session.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // connect whenever gameId/token changes
  useEffect(() => {
    if (gameId && token) connectSocket(gameId, token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId, token]);

  const orientation = seat === "black" ? "black" : "white";
  const isPlayer = seat === "white" || seat === "black";
  const myTurn = state
    ? (state.turn === "w" && seat === "white") || (state.turn === "b" && seat === "black")
    : false;

  function onDrop(sourceSquare: string, targetSquare: string, piece: string) {
    if (!state || !socketRef.current) return false;
    if (!isPlayer) return false;
    if (!myTurn) return false;
    if (state.status !== "playing") return false;

    // promotion quick default (you can add UI later)
    const promotion =
      piece?.toLowerCase?.().includes("p") && (targetSquare.endsWith("8") || targetSquare.endsWith("1"))
        ? "q"
        : undefined;

    socketRef.current.emit("move", {
      from: sourceSquare,
      to: targetSquare,
      promotion
    });

    return true;
  }

  function resign() {
    socketRef.current?.emit("resign", { gameId, token });
  }

  function offerDraw() {
    socketRef.current?.emit("offer_draw", { gameId, token });
  }

  function acceptDraw() {
    socketRef.current?.emit("accept_draw", { gameId, token });
  }

  function clearSession() {
    localStorage.removeItem("pepchess_gameId");
    localStorage.removeItem("pepchess_token");
    localStorage.removeItem("pepchess_seat");

    setGameId("");
    setToken("");
    setSeat("spectator");
    setState(null);

    setStatusMsg("Cleared session.");
    socketRef.current?.disconnect();
    socketRef.current = null;
  }

  const inviteLink = gameId ? `${window.location.origin}?game=${gameId}` : "";

  const active = state?.clock?.active; // "w" | "b" | undefined
  const whiteMs = state?.whiteTimeMs ?? state?.clock?.whiteMs ?? null;
  const blackMs = state?.blackTimeMs ?? state?.clock?.blackMs ?? null;

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: 16 }}>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <button onClick={createGame}>Create Online Game</button>

        <input
          value={joinInput}
          onChange={(e) => setJoinInput(e.target.value)}
          placeholder="Enter gameId to join"
          style={{ width: 220 }}
        />
        <button onClick={joinGame}>Join</button>

        <button onClick={clearSession}>Clear Session</button>

        <div style={{ marginLeft: "auto", fontFamily: "monospace" }}>
          socket: {connected ? "connected" : "disconnected"}
        </div>
      </div>

      {gameId && (
        <div style={{ marginTop: 10, fontFamily: "monospace" }}>
          gameId: <b>{gameId}</b> | seat: <b>{seat}</b> | status: <b>{state?.status || "-"}</b>
          {state?.status === "ended" && (
            <>
              {" "}
              | result: <b>{state.result}</b> ({state.reason})
            </>
          )}
          <div style={{ opacity: 0.85, marginTop: 6 }}>
            Invite: <span>{inviteLink}</span>
          </div>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "520px 1fr", gap: 16, marginTop: 16 }}>
        <div>
          {/* CLOCKS */}
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 10 }}>
            <div
              style={{
                padding: 10,
                border: "1px solid #333",
                borderRadius: 8,
                minWidth: 140,
                fontFamily: "monospace",
                opacity: state?.status === "playing" ? 1 : 0.8,
                outline: active === "b" ? "2px solid #555" : "none"
              }}
            >
              <div style={{ fontWeight: 800, marginBottom: 6 }}>BLACK</div>
              <div style={{ fontSize: 22 }}>{formatMs(blackMs)}</div>
              <div style={{ fontSize: 12, opacity: 0.85 }}>
                {state?.players?.black?.connected ? "connected" : "not connected"}
              </div>
            </div>

            <div
              style={{
                padding: 10,
                border: "1px solid #333",
                borderRadius: 8,
                minWidth: 140,
                fontFamily: "monospace",
                opacity: state?.status === "playing" ? 1 : 0.8,
                outline: active === "w" ? "2px solid #555" : "none"
              }}
            >
              <div style={{ fontWeight: 800, marginBottom: 6 }}>WHITE</div>
              <div style={{ fontSize: 22 }}>{formatMs(whiteMs)}</div>
              <div style={{ fontSize: 12, opacity: 0.85 }}>
                {state?.players?.white?.connected ? "connected" : "not connected"}
              </div>
            </div>
          </div>

          <Chessboard position={state?.fen || chess.fen()} boardOrientation={orientation} onPieceDrop={onDrop} />

          <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
            <button onClick={resign} disabled={!isPlayer || state?.status !== "playing"}>
              Resign
            </button>
            <button onClick={offerDraw} disabled={!isPlayer || state?.status !== "playing"}>
              Offer Draw
            </button>
            <button
              onClick={acceptDraw}
              disabled={!isPlayer || state?.status !== "playing" || !state?.drawOffer || state?.drawOffer?.by === seat}
            >
              Accept Draw
            </button>
          </div>

          {state?.drawOffer && (
            <div style={{ marginTop: 8 }}>
              Draw offered by: <b>{state.drawOffer.by}</b>
            </div>
          )}
        </div>

        <div style={{ padding: 12, border: "1px solid #333", borderRadius: 8 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Moves</div>
          <div style={{ fontFamily: "monospace", whiteSpace: "pre-wrap" }}>{state?.pgn || ""}</div>

          <div style={{ marginTop: 12, opacity: 0.9 }}>{statusMsg}</div>

          <div style={{ marginTop: 16, fontSize: 12, opacity: 0.8 }}>
            Tip: open this same URL in another browser/incognito, join with the gameId.
          </div>
        </div>
      </div>
    </div>
  );
}
