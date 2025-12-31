import React, { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";

const MP_URL =
  import.meta?.env?.VITE_MP_SERVER_URL || `http://${window.location.hostname}:4000`;

const LS_GAME = "pepchess_mp_gameId";
const LS_TOKEN = "pepchess_mp_token";
const LS_SEAT = "pepchess_mp_seat";

function saveSession(gameId, token, seat) {
  localStorage.setItem(LS_GAME, gameId);
  localStorage.setItem(LS_TOKEN, token);
  localStorage.setItem(LS_SEAT, seat);
}

function loadSession() {
  return {
    gameId: localStorage.getItem(LS_GAME) || "",
    token: localStorage.getItem(LS_TOKEN) || "",
    seat: localStorage.getItem(LS_SEAT) || "spectator",
  };
}

export default function OnlineGame() {
  const [statusMsg, setStatusMsg] = useState("");
  const [connected, setConnected] = useState(false);

  const [gameId, setGameId] = useState("");
  const [token, setToken] = useState("");
  const [seat, setSeat] = useState("spectator");
  const [joinInput, setJoinInput] = useState("");

  const [state, setState] = useState(null);

  const chess = useMemo(() => new Chess(), []);
  const socketRef = useRef(null);

  // keep local chess synced to server fen
  useEffect(() => {
    if (!state?.fen) return;
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
    const id = (joinInput || "").trim();
    if (!id) return;

    setStatusMsg("Joining game...");
    const r = await fetch(`${MP_URL}/api/games/${id}/join`, { method: "POST" });
    const data = await r.json();

    if (data?.error) {
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

  function connectSocket(gid, tok) {
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

    s.on("joined", (payload) => {
      setSeat(payload.seat);
      setState(payload.state);
    });

    s.on("state", (st) => setState(st));

    s.on("error_msg", (e) => {
      setStatusMsg(`Server: ${e?.error || "error"}`);
    });
  }

  // auto-load session + also allow ?game=XXXX
  useEffect(() => {
    const url = new URL(window.location.href);
    const qGame = url.searchParams.get("game") || "";

    const sess = loadSession();
    const gid = qGame || sess.gameId;
    const tok = sess.token;

    if (gid) setJoinInput(gid);

    if (gid && tok) {
      setGameId(gid);
      setToken(tok);
      setSeat(sess.seat || "spectator");
      connectSocket(gid, tok);
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

  function onDrop(sourceSquare, targetSquare, piece) {
    if (!state || !socketRef.current) return false;
    if (!isPlayer) return false;
    if (!myTurn) return false;
    if (state.status !== "playing") return false;

    const promotion =
      piece?.toLowerCase?.().includes("p") &&
      (targetSquare.endsWith("8") || targetSquare.endsWith("1"))
        ? "q"
        : undefined;

    socketRef.current.emit("move", {
      gameId,
      token,
      from: sourceSquare,
      to: targetSquare,
      promotion,
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
    localStorage.removeItem(LS_GAME);
    localStorage.removeItem(LS_TOKEN);
    localStorage.removeItem(LS_SEAT);
    setGameId("");
    setToken("");
    setSeat("spectator");
    setState(null);
    setStatusMsg("Cleared session.");
    socketRef.current?.disconnect();
    socketRef.current = null;
  }

  const inviteLink = gameId ? `${window.location.origin}?game=${gameId}` : "";

  // build a simple moves list from server moves (if present)
  const movesText =
    state?.moves?.length
      ? state.moves.map((m, i) => `${i + 1}. ${m.san}`).join(" ")
      : state?.pgn || "";

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: 16 }}>
      <h1 style={{ textAlign: "center", margin: "6px 0 14px" }}>PEP Chess (Online)</h1>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <button className="control-btn" onClick={createGame}>Create Online Game</button>

        <input
          value={joinInput}
          onChange={(e) => setJoinInput(e.target.value)}
          placeholder="Enter gameId to join"
          style={{ width: 240, padding: 8, borderRadius: 8 }}
        />
        <button className="control-btn" onClick={joinGame}>Join</button>

        <button className="control-btn" onClick={clearSession}>Clear Session</button>

        <div style={{ marginLeft: "auto", fontFamily: "monospace" }}>
          socket: {connected ? "connected" : "disconnected"}
        </div>
      </div>

      {gameId && (
        <div style={{ marginTop: 10, fontFamily: "monospace" }}>
          gameId: <b>{gameId}</b> | seat: <b>{seat}</b> | status: <b>{state?.status || "-"}</b>
          {state?.status === "ended" && (
            <>
              {" "} | result: <b>{state?.result}</b> ({state?.reason})
            </>
          )}
          <div style={{ opacity: 0.85, marginTop: 6 }}>
            Invite: <span>{inviteLink}</span>
          </div>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "520px 1fr", gap: 16, marginTop: 16 }}>
        <div>
          <Chessboard
            position={state?.fen || chess.fen()}
            boardOrientation={orientation}
            onPieceDrop={onDrop}
          />

          <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
            <button className="control-btn" onClick={resign} disabled={!isPlayer || state?.status !== "playing"}>
              Resign
            </button>

            <button className="control-btn" onClick={offerDraw} disabled={!isPlayer || state?.status !== "playing"}>
              Offer Draw
            </button>

            <button
              className="control-btn"
              onClick={acceptDraw}
              disabled={
                !isPlayer ||
                state?.status !== "playing" ||
                !state?.drawOffer ||
                state?.drawOffer?.by === seat
              }
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

        <div style={{ padding: 12, border: "1px solid #333", borderRadius: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Moves</div>
          <div style={{ fontFamily: "monospace", whiteSpace: "pre-wrap" }}>
            {movesText}
          </div>

          <div style={{ marginTop: 12, opacity: 0.9 }}>{statusMsg}</div>

          <div style={{ marginTop: 16, fontSize: 12, opacity: 0.8 }}>
            Tip: open the invite link in another browser/incognito to join.
          </div>
        </div>
      </div>
    </div>
  );
}
