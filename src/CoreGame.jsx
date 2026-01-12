import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import { io } from "socket.io-client";
import "./App.css";

// --- Board colours (lichess classical style) ---
const LIGHT_SQUARE = "#f0d9b5";
const DARK_SQUARE = "#b58863";

// Promotion order: Q, N, R, B (lichess)
const PROMOTION_ORDER = ["q", "n", "r", "b"];

// --- cburnett / lichess-style pieces ---
const pieceImagePaths = {
  wP: "/pieces/cburnett/wP.svg",
  wN: "/pieces/cburnett/wN.svg",
  wB: "/pieces/cburnett/wB.svg",
  wR: "/pieces/cburnett/wR.svg",
  wQ: "/pieces/cburnett/wQ.svg",
  wK: "/pieces/cburnett/wK.svg",
  bP: "/pieces/cburnett/bP.svg",
  bN: "/pieces/cburnett/bN.svg",
  bB: "/pieces/cburnett/bB.svg",
  bR: "/pieces/cburnett/bR.svg",
  bQ: "/pieces/cburnett/bQ.svg",
  bK: "/pieces/cburnett/bK.svg",
};

const customPieces = {};
Object.entries(pieceImagePaths).forEach(([key, src]) => {
  customPieces[key] = ({ squareWidth }) => (
    <img
      src={src}
      alt={key}
      draggable={false}
      style={{
        width: squareWidth,
        height: squareWidth,
        display: "block",
      }}
    />
  );
});

/**
 * Backend (PEP escrow API)
 * - You already had this, keeping same logic.
 */
const API_BASE_URL =
  import.meta.env.VITE_PEP_API_URL || `http://${window.location.hostname}:8001`;

/**
 * Multiplayer server (socket.io + REST)
 * - Default to same VM host on port 4000.
 */
const MP_URL =
  import.meta.env.VITE_MP_SERVER_URL || `http://${window.location.hostname}:4000`;

// piece values for material diff
const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9 };
// order icons appear in material row (lichess-ish)
const CAPTURE_ORDER = ["q", "r", "b", "n", "p"];

const START_TIME_MS = 5 * 60 * 1000; // 5+0 blitz

const START_COUNTS = { p: 8, n: 2, b: 2, r: 2, q: 1 };

function pieceCountsFromFen(fen) {
  const placement = (fen || "").split(" ")[0] || "";
  const counts = {
    w: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 },
    b: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 },
  };

  for (const ch of placement) {
    if (ch === "/" || ch === " ") continue;
    if (ch >= "1" && ch <= "8") continue; // empty squares

    const isUpper = ch === ch.toUpperCase();
    const color = isUpper ? "w" : "b";
    const type = ch.toLowerCase();

    if (counts[color][type] !== undefined) counts[color][type] += 1;
  }

  return counts;
}

function capturedFromFen(fen) {
  const counts = pieceCountsFromFen(fen);

  const capByWhite = { p: 0, n: 0, b: 0, r: 0, q: 0 }; // white captured black pieces
  const capByBlack = { p: 0, n: 0, b: 0, r: 0, q: 0 }; // black captured white pieces

  for (const t of Object.keys(START_COUNTS)) {
    capByWhite[t] = Math.max(0, START_COUNTS[t] - (counts.b[t] || 0));
    capByBlack[t] = Math.max(0, START_COUNTS[t] - (counts.w[t] || 0));
  }

  return { capByWhite, capByBlack };
}


function formatTime(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function isProbablyPepAddress(addr) {
  if (!addr) return false;
  const a = addr.trim();
  if (!a.startsWith("P")) return false;
  if (a.length < 30 || a.length > 40) return false;
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(a)) return false;
  return true;
}

function formatPepError(raw, whiteAddr = "", blackAddr = "") {
  let text =
    typeof raw === "string"
      ? raw
      : raw?.message
      ? raw.message
      : String(raw || "");

  text = text.replace(/\s+/g, " ").trim();
  if (!text) {
    return "Something went wrong with the PEP match. Please try again.";
  }

  if (text.startsWith('{"detail"')) {
    try {
      const obj = JSON.parse(text);
      if (typeof obj.detail === "string") text = obj.detail;
    } catch (_) {}
  }

  const lower = text.toLowerCase();

  const mentionsInvalidAddress =
    lower.includes("invalid") && lower.includes("address");

  if (mentionsInvalidAddress) {
    let whiteBad = lower.includes("white");
    let blackBad = lower.includes("black");

    const whiteLooksValid = isProbablyPepAddress(whiteAddr);
    const blackLooksValid = isProbablyPepAddress(blackAddr);

    if (!whiteBad && whiteAddr.trim() && !whiteLooksValid) whiteBad = true;
    if (!blackBad && blackAddr.trim() && !blackLooksValid) blackBad = true;

    if (whiteBad && blackBad) return "White and Black PEP addresses are invalid – check both and try again.";
    if (whiteBad) return "White PEP address is invalid – check and try again.";
    if (blackBad) return "Black PEP address is invalid – check and try again.";
    return "White and/or Black PEP address is invalid – check both and try again.";
  }

  if (
    lower.includes("rpc error") ||
    lower.includes("httpconnectionpool") ||
    lower.includes("max retries exceeded") ||
    lower.includes("failed to establish a new connection")
  ) {
    return "PEP node is unreachable – try again in a few minutes.";
  }

  return "Something went wrong with the PEP match. Please check the addresses and try again.";
}

async function copyText(text) {
  if (!text) return false;

  // Works on HTTPS + localhost
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) {}

  // Fallback for HTTP
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.top = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch (_) {}

  return false;
}


function shortMessage(raw, fallback = "") {
  let text =
    typeof raw === "string"
      ? raw
      : raw instanceof Error
      ? raw.message
      : String(raw || fallback || "");

  text = text.replace(/\s+/g, " ").trim();
  if (!text) return fallback;

  const MAX = 120;
  if (text.length > MAX) return text.slice(0, MAX - 1) + "…";
  return text;
}

// ---------------------------
// Multiplayer session storage
// ---------------------------
const MP_KEYS = {
  gameId: "pepchess_mp_gameId",
  token: "pepchess_mp_token",
  seat: "pepchess_mp_seat",
};

function saveMpSession(gameId, token, seat) {
  localStorage.setItem(MP_KEYS.gameId, gameId);
  localStorage.setItem(MP_KEYS.token, token);
  localStorage.setItem(MP_KEYS.seat, seat);
}

function loadMpSession() {
  return {
    gameId: localStorage.getItem(MP_KEYS.gameId) || "",
    token: localStorage.getItem(MP_KEYS.token) || "",
    seat: localStorage.getItem(MP_KEYS.seat) || "spectator",
  };
}

function clearMpSessionStorage() {
  localStorage.removeItem(MP_KEYS.gameId);
  localStorage.removeItem(MP_KEYS.token);
  localStorage.removeItem(MP_KEYS.seat);
}

function pgnToRows(pgn) {
  try {
    const tmp = new Chess();
    // chess.js versions differ: try both
    if (typeof tmp.loadPgn === "function") tmp.loadPgn(pgn || "");
    else if (typeof tmp.load_pgn === "function") tmp.load_pgn(pgn || "");
    const hist = tmp.history({ verbose: true });
    const rows = [];
    for (let i = 0; i < hist.length; i += 2) {
      rows.push({
        no: Math.floor(i / 2) + 1,
        white: hist[i]?.san || "",
        black: hist[i + 1]?.san || "",
      });
    }
    return rows;
  } catch {
    return [];
  }
}

function seatToColor(seat) {
  if (seat === "white") return "w";
  if (seat === "black") return "b";
  return null;
}

function mpStatusText(mpState) {
  if (!mpState) return "Not connected.";
  if (mpState.status === "waiting") return "Waiting for opponent…";
  if (mpState.status === "playing") return "Playing.";
  if (mpState.status === "ended") {
    const r = mpState.result || "";
    const reason = mpState.reason ? ` (${mpState.reason})` : "";
    return `Game ended: ${r}${reason}`;
  }
  return "Online.";
}

function App() {
  const titleRef = useRef(null);
  const bottomBarRef = useRef(null);

  // ---------------------------
  // Mode: local vs online
  // ---------------------------
  const [mode, setMode] = useState("online"); // "local" | "online"
  const isOnline = mode === "online";

  // ---------------------------
  // Local (existing) game state
  // ---------------------------
  const gameRef = useRef(new Chess());
  const [position, setPosition] = useState(gameRef.current.fen());
  const [selectedSquare, setSelectedSquare] = useState(null);
  const [legalSquares, setLegalSquares] = useState([]);
  const [lastMove, setLastMove] = useState(null); // [from, to]
  const [status, setStatus] = useState("White to move.");
  const [moves, setMoves] = useState([]); // [{ no, white, black }]
  const [viewPly, setViewPly] = useState(null); // null = current position, number = viewing history
  const [checkSquare, setCheckSquare] = useState(null);
  const [pendingPromotion, setPendingPromotion] = useState(null); // { from, to, color }
  const hasStarted = moves.length > 0;

  // clocks (local)
  const [whiteTime, setWhiteTime] = useState(START_TIME_MS);
  const [blackTime, setBlackTime] = useState(START_TIME_MS);
  const [activeColor, setActiveColor] = useState(null); // 'w' or 'b'
  const [timerStarted, setTimerStarted] = useState(false);
  const [flaggedSide, setFlaggedSide] = useState(null); // 'w' | 'b' | null

  // manual results (local)
  const [manualResult, setManualResult] = useState(null); // { type: 'resign'|'draw', winner: 'w'|'b'|null }
  const [pendingAction, setPendingAction] = useState(null); // 'draw' | 'resign' | null

  // captured pieces (local)
  const emptyCaps = { p: 0, n: 0, b: 0, r: 0, q: 0 };
  const [capturedByWhite, setCapturedByWhite] = useState({ ...emptyCaps });
  const [capturedByBlack, setCapturedByBlack] = useState({ ...emptyCaps });

// ---------------------------
// Online captured pieces (derived from PGN)
// ---------------------------
// const onlineCaptured = useMemo(() => {
//   const byWhite = { ...emptyCaps }; // white captured (black pieces)
//   const byBlack = { ...emptyCaps }; // black captured (white pieces)

//   if (!isOnline) return { byWhite, byBlack };

//   const pgn = mpState?.pgn || "";
//   if (!pgn.trim()) return { byWhite, byBlack };

//   try {
//     const tmp = new Chess();
//     if (typeof tmp.loadPgn === "function") tmp.loadPgn(pgn);
//     else if (typeof tmp.loadPgn === "function") tmp.loadPgn(pgn);

//     const hist = tmp.history({ verbose: true });
//     for (const m of hist) {
//       if (!m?.captured) continue;
//       const t = m.captured; // 'p','n','b','r','q'
//       if (byWhite[t] === undefined) continue;

//       if (m.color === "w") byWhite[t] += 1;
//       else if (m.color === "b") byBlack[t] += 1;
//     }
//   } catch {}

//   return { byWhite, byBlack };
// }, [isOnline, mpState?.pgn]);

  // ---------------------------
  // Multiplayer state (merged)
  // ---------------------------
  const socketRef = useRef(null);
  const mpChessRef = useRef(new Chess());

  const [mpConnected, setMpConnected] = useState(false);
  const [mpStatusMsg, setMpStatusMsg] = useState("");

  const [mpGameId, setMpGameId] = useState("");
  const [mpToken, setMpToken] = useState("");
  const [mpSeat, setMpSeat] = useState("spectator"); // "white" | "black" | "spectator"
  const [mpJoinInput, setMpJoinInput] = useState("");
  const [mpState, setMpState] = useState(null);

  const [mpSelectedSquare, setMpSelectedSquare] = useState(null);
  const [mpLegalSquares, setMpLegalSquares] = useState([]);
  const [mpLastMove, setMpLastMove] = useState(null);
  const [mpPendingPromotion, setMpPendingPromotion] = useState(null); // { from,to,color }
  const [mpCheckSquare, setMpCheckSquare] = useState(null);
  const [mpMoveRows, setMpMoveRows] = useState([]);
  const [leftOnlineGame, setLeftOnlineGame] = useState(false); // Track if we just left an online game

  const mpIsPlayer = mpSeat === "white" || mpSeat === "black";
  const mpMyTurn =
    mpState && mpIsPlayer
      ? (mpState.turn === "w" && mpSeat === "white") ||
        (mpState.turn === "b" && mpSeat === "black")
      : false;

// ----- Online clock values coming from mp-server state -----
const onlineWhiteMs = mpState?.clock?.whiteMs ?? mpState?.whiteTimeMs ?? START_TIME_MS;

const onlineBlackMs = mpState?.clock?.blackMs ?? mpState?.blackTimeMs ?? START_TIME_MS;

const onlineClockActive = mpState?.clock?.active ?? mpState?.turn ?? "w";
const onlineClockRunning = !!mpState?.clock?.running && mpState?.status === "playing";

const whiteClockActive = isOnline
  ? onlineClockRunning && onlineClockActive === "w"
  : activeColor === "w";

const blackClockActive = isOnline
  ? onlineClockRunning && onlineClockActive === "b"
  : activeColor === "b";


  // ---------------------------
  // PEP match / escrow state (kept)
  // ---------------------------
  const [pepMatchId, setPepMatchId] = useState(null);
  const [pepEscrowAddress, setPepEscrowAddress] = useState("");
  const [pepMatchStatus, setPepMatchStatus] = useState("idle"); // idle|creating|waiting_for_deposits|ready_to_play|settled|error|aborted

  const isPepMatchLocked =
    pepMatchStatus === "creating" ||
    pepMatchStatus === "waiting_for_deposits" ||
    pepMatchStatus === "ready_to_play";

  const [pepStake, setPepStake] = useState("");
  const [pepWhiteAddress, setPepWhiteAddress] = useState("");
  const [pepBlackAddress, setPepBlackAddress] = useState("");
  const [pepError, setPepError] = useState("");
  const [pepInfoMessage, setPepInfoMessage] = useState("");
  const [pepResultSent, setPepResultSent] = useState(false);
  const [pepConfirmedDeposits, setPepConfirmedDeposits] = useState(0);

  const pepModeActive =
    pepMatchId && pepMatchStatus !== "settled" && pepMatchStatus !== "error";

  // lock board until ready_to_play when a PEP match is active
  const pepBoardLocked = pepModeActive && pepMatchStatus !== "ready_to_play";

  const [pepPendingResetConfirm, setPepPendingResetConfirm] = useState(false);
  const [pepWhiteEscrow, setPepWhiteEscrow] = useState("");
  const [pepBlackEscrow, setPepBlackEscrow] = useState("");
  const [pepWhiteDeposit, setPepWhiteDeposit] = useState(0);
  const [pepBlackDeposit, setPepBlackDeposit] = useState(0);

  const [pepWhiteExtraRefunded, setPepWhiteExtraRefunded] = useState(false);
  const [pepWhiteExtraAmount, setPepWhiteExtraAmount] = useState(0);
  const [pepBlackExtraRefunded, setPepBlackExtraRefunded] = useState(false);
  const [pepBlackExtraAmount, setPepBlackExtraAmount] = useState(0);
  const [copiedWhiteEscrow, setCopiedWhiteEscrow] = useState(false);
  const [copiedBlackEscrow, setCopiedBlackEscrow] = useState(false);

  async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: ctrl.signal });
    } finally {
      clearTimeout(id);
    }
  }

//   const canCreatePepMatch =
//     (!isOnline || mpSeat === "white") &&
//     (!pepMatchId || pepMatchStatus === "settled" || pepMatchStatus === "error") &&
//     pepStake.trim() !== "" &&
//     pepWhiteAddress.trim() !== "" &&
//     pepBlackAddress.trim() !== "";

//   const hasAnyGameMove = isOnline
//     ? ((mpState?.moves?.length ?? 0) > 0)
//     : (moves.length > 0);

// const canAbortPepMatch = pepMatchId && !hasAnyGameMove && (pepMatchStatus === "waiting_for_deposits" || pepMatchStatus === "ready_to_play");

// ---------------------------
// Online captured pieces (derived from server FEN)
// ---------------------------
const onlineCaptured = useMemo(() => {
  if (!isOnline) return { byWhite: { ...emptyCaps }, byBlack: { ...emptyCaps } };

  const fen = mpState?.fen;
  if (!fen) return { byWhite: { ...emptyCaps }, byBlack: { ...emptyCaps } };

  const { capByWhite, capByBlack } = capturedFromFen(fen);
  return { byWhite: capByWhite, byBlack: capByBlack };
}, [isOnline, mpState?.fen]);

const seat = (mpSeat ?? "").toLowerCase().trim();

// Allow any player (white or black) to create PEP match - not just white
const canCreatePepMatch =
  !pepMatchId &&
  !isPepMatchLocked &&
  pepStake &&
  pepWhiteAddress &&
  pepBlackAddress &&
  (!isOnline || seat === "white" || seat === "black");

// Check if any actual moves have been made (not just game status)
// For online: check ply count or moves array length (pgn can have headers before moves)
const hasAnyGameMove = isOnline
  ? ((mpState?.ply ?? 0) > 0 || (mpState?.moves?.length ?? 0) > 0)
  : (moves.length > 0);

// Check if the CURRENT player has made any move (for Abort vs Resign button)
// White moves on ply 1,3,5... so white has moved if ply >= 1
// Black moves on ply 2,4,6... so black has moved if ply >= 2
const currentPlayerHasMoved = isOnline
  ? (mpSeat === "white" ? (mpState?.moves?.length ?? 0) >= 1 : (mpState?.moves?.length ?? 0) >= 2)
  : (moves.length > 0);

const canAbortPepMatch = !!pepMatchId && !hasAnyGameMove && (pepMatchStatus === "waiting_for_deposits" || pepMatchStatus === "ready_to_play");

// Each player only sees their own escrow address (not the opponent's)
const showWhiteEscrow = !isOnline ? true : seat === "white";
const showBlackEscrow = !isOnline ? true : seat === "black";


  const stakeNumber = parseFloat(pepStake) || 0;
  const whiteDepositOk = stakeNumber > 0 && pepWhiteDeposit >= stakeNumber;
  const blackDepositOk = stakeNumber > 0 && pepBlackDeposit >= stakeNumber;
  const confirmedDeposits = (whiteDepositOk ? 1 : 0) + (blackDepositOk ? 1 : 0);
  // const showWhiteEscrow = !isOnline ? true : mpSeat === "white";
  // const showBlackEscrow = !isOnline ? true : mpSeat === "black";

  // fixed board width
  const [boardWidth, setBoardWidth] = useState(680);

  const SIDE_PANEL_W = 625;
  const GAP = 24;
  const PAD_X = 48;
  const PAD_Y = 46;
  const MAX_BOARD = 720;

  useEffect(() => {
    const calc = () => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      const titleH = titleRef.current?.offsetHeight ?? 60;
      const bottomH = bottomBarRef.current?.offsetHeight ?? 62;

      const maxByWidth = vw - SIDE_PANEL_W - GAP - PAD_X;
      const maxByHeight = vh - titleH - bottomH - PAD_Y;

      const next = Math.max(360, Math.min(MAX_BOARD, maxByWidth, maxByHeight));
      setBoardWidth(Math.floor(next));
    };

    calc();
    window.addEventListener("resize", calc);
    return () => window.removeEventListener("resize", calc);
  }, []);

  // ---------------------------
  // Local helpers
  // ---------------------------
  const game = gameRef.current;

  const isGameStoppedLocal =
    flaggedSide !== null || manualResult !== null || game.isGameOver();

  // Reset rules (local only)
  const canResetLocal = !hasStarted || isGameStoppedLocal;

  // ---------- local reset helpers ----------
  const resetBoardOnlyLocal = () => {
    gameRef.current = new Chess();
    setPosition(gameRef.current.fen());
    setSelectedSquare(null);
    setLegalSquares([]);
    setLastMove(null);
    setPendingPromotion(null);
    setCheckSquare(null);
    setMoves([]);
    setStatus("White to move.");

    setWhiteTime(START_TIME_MS);
    setBlackTime(START_TIME_MS);
    setActiveColor(null);
    setTimerStarted(false);
    setFlaggedSide(null);
    setManualResult(null);
    setPendingAction(null);
    setCapturedByWhite({ ...emptyCaps });
    setCapturedByBlack({ ...emptyCaps });
  };

  const resetGameLocal = () => {
    if (!canResetLocal) return;

    resetBoardOnlyLocal();

    // reset PEP match state too
    setPepMatchId(null);
    setPepMatchStatus("idle");
    setPepResultSent(false);
    setPepPendingResetConfirm(false);

    setPepWhiteAddress("");
    setPepBlackAddress("");

    setPepWhiteEscrow("");
    setPepBlackEscrow("");
    setPepEscrowAddress("");

    setPepWhiteDeposit(0);
    setPepBlackDeposit(0);
    setPepConfirmedDeposits(0);
    setPepWhiteExtraRefunded(false);
    setPepWhiteExtraAmount(0);
    setPepBlackExtraRefunded(false);
    setPepBlackExtraAmount(0);

    setPepError("");
    setPepInfoMessage("");
  };

  // ---------------------------
  // PEP result reporting
  // ---------------------------
  async function reportPepResult(result, pgnOverride = "", fenOverride = "") {
    if (!pepMatchId || pepResultSent) return;

    try {
      setPepInfoMessage("Reporting PEP match result…");

      const pgn =
        pgnOverride ||
        (isOnline ? (mpState?.pgn || "") : game.pgn());
      const finalFen =
        fenOverride ||
        (isOnline ? (mpState?.fen || "") : game.fen());

      const res = await fetch(`${API_BASE_URL}/api/matches/${pepMatchId}/result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ result, pgn, finalFen }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || "Failed to report result.");
      }

      const data = await res.json();
      setPepMatchId(data.id);
      setPepEscrowAddress(data.escrow_address || "");
      setPepMatchStatus(data.status || "waiting_for_deposits");
      setPepConfirmedDeposits(data.confirmedDeposits ?? 0);

      if (data.txIds && data.txIds.length > 0) {
        setPepInfoMessage(shortMessage(`Match settled; first payout txid: ${data.txIds[0]}`, "Match settled; payouts sent."));
      } else {
        setPepInfoMessage("Match settled; payouts sent.");
      }

      setPepError("");
      setPepResultSent(true);
    } catch (err) {
      setPepError(shortMessage(err, "Failed to report PEP match result."));
      setPepResultSent(false);
    }
  }

  // ---------------------------
  // Local chess helpers (unchanged behaviour)
  // ---------------------------
  const syncMovesLocal = () => {
    const hist = game.history({ verbose: true });
    const rows = [];
    for (let i = 0; i < hist.length; i += 2) {
      rows.push({
        no: Math.floor(i / 2) + 1,
        white: hist[i]?.san || "",
        black: hist[i + 1]?.san || "",
      });
    }
    setMoves(rows);
  };

  const findKingSquare = (gameInstance, color) => {
    const boardArr = gameInstance.board();
    const files = "abcdefgh";
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const piece = boardArr[r][f];
        if (piece && piece.type === "k" && piece.color === color) {
          return `${files[f]}${8 - r}`;
        }
      }
    }
    return null;
  };

  const updateStatusLocal = () => {
    if (manualResult) {
      if (pepMatchId && !pepResultSent) {
        if (manualResult.type === "draw") {
          reportPepResult("draw");
        } else if (manualResult.type === "resign") {
          const winnerColor = manualResult.winner;
          const resultString =
            winnerColor === "w" ? "white" : winnerColor === "b" ? "black" : null;
          if (resultString) reportPepResult(resultString);
        }
      }

      if (manualResult.type === "draw") {
        setStatus("Game drawn by agreement.");
      } else if (manualResult.type === "resign") {
        const winner = manualResult.winner === "w" ? "White" : "Black";
        setStatus(`Resignation. ${winner} wins.`);
      }
      return;
    }

    if (flaggedSide) {
      const winner = flaggedSide === "w" ? "Black" : "White";
      if (pepMatchId && !pepResultSent) {
        reportPepResult(winner === "White" ? "white" : "black");
      }
      setStatus(`${winner} wins on time.`);
      return;
    }

    if (game.isGameOver()) {
      if (game.isCheckmate()) {
        const winner = game.turn() === "w" ? "Black" : "White";
        if (pepMatchId && !pepResultSent) {
          reportPepResult(winner === "White" ? "white" : "black");
        }
        setStatus(`Checkmate. ${winner} wins.`);
      } else if (game.isDraw()) {
        if (pepMatchId && !pepResultSent) reportPepResult("draw");
        if (game.isStalemate()) setStatus("Draw by stalemate.");
        else if (game.isThreefoldRepetition()) setStatus("Draw by threefold repetition.");
        else if (game.isInsufficientMaterial()) setStatus("Draw by insufficient material.");
        else setStatus("Draw.");
      } else {
        setStatus("Game over.");
      }
    } else {
      const turnName = game.turn() === "w" ? "White" : "Black";
      if (game.inCheck()) setStatus(`${turnName} to move — in check.`);
      else setStatus(`${turnName} to move.`);
    }

    if (game.inCheck()) setCheckSquare(findKingSquare(game, game.turn()));
    else setCheckSquare(null);
  };

  // ---------------------------
  // Local clocks
  // ---------------------------
  useEffect(() => {
    if (!timerStarted || flaggedSide || manualResult) return;

    const interval = setInterval(() => {
      setWhiteTime((prev) => {
        if (activeColor !== "w" || flaggedSide || manualResult) return prev;
        if (prev <= 1000) {
          clearInterval(interval);
          setFlaggedSide("w");
          setActiveColor(null);
          setStatus("Black wins on time.");
          return 0;
        }
        return prev - 1000;
      });

      setBlackTime((prev) => {
        if (activeColor !== "b" || flaggedSide || manualResult) return prev;
        if (prev <= 1000) {
          clearInterval(interval);
          setFlaggedSide("b");
          setActiveColor(null);
          setStatus("White wins on time.");
          return 0;
        }
        return prev - 1000;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [timerStarted, activeColor, flaggedSide, manualResult]);

  // ---------------------------
  // PEP match polling (kept)
  // ---------------------------
  useEffect(() => {
    if (!pepMatchId) return;

    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/api/matches/${pepMatchId}`);
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;

        if (data.underDepositMessage) setPepInfoMessage(data.underDepositMessage);

        if (data.status) {
          setPepMatchStatus(data.status);

          const whiteEscrow = data.whiteEscrow ?? data.white_escrow ?? "";
          const blackEscrow = data.blackEscrow ?? data.black_escrow ?? "";
          const whiteDep = data.whiteDeposit ?? data.white_deposit ?? 0;
          const blackDep = data.blackDeposit ?? data.black_deposit ?? 0;

          const whiteExtraRefunded = data.whiteExtraRefunded ?? data.white_extra_refunded ?? false;
          const whiteExtraAmount = data.whiteExtraAmount ?? data.white_extra_amount ?? 0;
          const blackExtraRefunded = data.blackExtraRefunded ?? data.black_extra_refunded ?? false;
          const blackExtraAmount = data.blackExtraAmount ?? data.black_extra_amount ?? 0;

          setPepWhiteEscrow(whiteEscrow);
          setPepBlackEscrow(blackEscrow);
          setPepWhiteDeposit(whiteDep);
          setPepBlackDeposit(blackDep);

          setPepWhiteExtraRefunded(!!whiteExtraRefunded);
          setPepWhiteExtraAmount(whiteExtraAmount || 0);
          setPepBlackExtraRefunded(!!blackExtraRefunded);
          setPepBlackExtraAmount(blackExtraAmount || 0);

          const stakeNum = parseFloat(pepStake) || 0;
          const whiteOk = stakeNum > 0 && whiteDep >= stakeNum;
          const blackOk = stakeNum > 0 && blackDep >= stakeNum;
          setPepConfirmedDeposits((whiteOk ? 1 : 0) + (blackOk ? 1 : 0));

          if (data.status === "ready_to_play") {
            setPepInfoMessage("Both deposits confirmed – you can start the game.");
          } else if (data.status === "settled") {
            setPepInfoMessage("Match settled on-chain.");
          }
        }
      } catch {
        // ignore
      }
    };

    poll();
    const intervalId = setInterval(poll, 5000);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [pepMatchId, pepStake]);

  // ---------------------------
  // Local move application
  // ---------------------------
  const applyMoveLocal = (from, to, promotion) => {
    if (isGameStoppedLocal) return false;

    const moveObj = { from, to };
    if (promotion) moveObj.promotion = promotion;

    const move = game.move(moveObj);
    if (!move) return false;

    if (move.captured || move.promotion) {
      const updated = (prev) => {
        const copy = { ...prev };

        if (move.captured) {
          const capturedType = move.captured;
          copy[capturedType] = (copy[capturedType] || 0) + 1;
        }

        if (move.promotion) {
          const promotedVal = PIECE_VALUES[move.promotion] || 0;
          const pawnVal = PIECE_VALUES["p"];
          const diff = promotedVal - pawnVal;

          if (diff > 0) {
            const promotedType = move.promotion;
            copy[promotedType] = (copy[promotedType] || 0) + 1;

            if (copy["p"] && copy["p"] > 0) copy["p"] -= 1;
          }
        }

        return copy;
      };

      if (move.color === "w") setCapturedByWhite((prev) => updated(prev));
      else setCapturedByBlack((prev) => updated(prev));
    }

    setPosition(game.fen());
    setSelectedSquare(null);
    setLegalSquares([]);
    setLastMove([from, to]);
    setPendingPromotion(null);
    syncMovesLocal();

    if (!timerStarted) {
      setTimerStarted(true);
      setActiveColor(move.color === "w" ? "b" : "w");
    } else {
      setActiveColor(move.color === "w" ? "b" : "w");
    }

    if (game.isGameOver()) {
      setActiveColor(null);
      setTimerStarted(false);
    }

    updateStatusLocal();
    return true;
  };

  // ---------------------------
  // Local input handlers
  // ---------------------------
  const handleSquareClickLocal = (square) => {
    if (pepBoardLocked) {
      setStatus("PEP match active – both deposits must be confirmed before you can move.");
      return;
    }

    if (isGameStoppedLocal || flaggedSide || manualResult) return;
    if (pendingPromotion) return;

    if (selectedSquare === square) {
      setSelectedSquare(null);
      setLegalSquares([]);
      return;
    }

    if (selectedSquare) {
      const movesFromSelected = game.moves({ square: selectedSquare, verbose: true });
      const targetMove = movesFromSelected.find((m) => m.to === square);

      if (targetMove) {
        const isPromotion =
          targetMove.piece === "p" && (targetMove.to[1] === "8" || targetMove.to[1] === "1");

        if (isPromotion) {
          setPendingPromotion({ from: selectedSquare, to: square, color: game.turn() });
          return;
        }

        applyMoveLocal(selectedSquare, square);
        return;
      }
    }

    const piece = game.get(square);
    if (piece && piece.color === game.turn()) {
      setSelectedSquare(square);
      const movesFromSquare = game.moves({ square, verbose: true });
      setLegalSquares(movesFromSquare.map((m) => m.to));
    } else {
      setSelectedSquare(null);
      setLegalSquares([]);
    }
  };

  const handlePieceDropLocal = (sourceSquare, targetSquare) => {
    if (pepBoardLocked) {
      setStatus("PEP match active – both deposits must be confirmed before you can move.");
      return false;
    }

    if (isGameStoppedLocal || flaggedSide || manualResult) return false;
    if (pendingPromotion) return false;

    const movesFromSource = game.moves({ square: sourceSquare, verbose: true });
    const move = movesFromSource.find((m) => m.to === targetSquare);
    if (!move) return false;

    const isPromotion = move.piece === "p" && (move.to[1] === "8" || move.to[1] === "1");

    if (isPromotion) {
      setPendingPromotion({ from: sourceSquare, to: targetSquare, color: game.turn() });
      return false;
    }

    return applyMoveLocal(sourceSquare, targetSquare);
  };

  const onPromotionChoiceLocal = (role) => {
    if (!pendingPromotion) return;
    const { from, to } = pendingPromotion;
    applyMoveLocal(from, to, role);
  };

  // ---------------------------
  // Multiplayer: socket + REST
  // ---------------------------
  function disconnectSocket() {
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }
    setMpConnected(false);
  }

  function connectSocket(gid, tok) {
    if (!gid || !tok) return;

    disconnectSocket();

    const s = io(MP_URL, { transports: ["websocket", "polling"] });
    socketRef.current = s;

    s.on("connect", () => {
      setMpConnected(true);
      s.emit("join_game", { gameId: gid, token: tok });
    });

    s.on("disconnect", () => setMpConnected(false));

    s.on("joined", (payload) => {
      setMpSeat(payload.seat);
      setMpState(payload.state);
      saveMpSession(gid, tok, payload.seat);
    });

    s.on("state", (st) => setMpState(st));

    s.on("error_msg", (e) => setMpStatusMsg(`Server: ${e?.error || "error"}`));
  }

  async function createMpGame() {
    setMode("online");
    setMpStatusMsg("Creating online game...");
    const r = await fetch(`${MP_URL}/api/games`, { method: "POST" });
    const data = await r.json();

    setMpGameId(data.gameId);
    setMpToken(data.token);
    setMpSeat(data.color);
    setMpState(data.state);
    saveMpSession(data.gameId, data.token, data.color);
    setMpStatusMsg("Online game created.");
  }

  async function joinMpGameById(id) {
    const gid = (id || "").trim();
    if (!gid) return;

    setMode("online");
    setMpStatusMsg("Joining online game...");

    const r = await fetch(`${MP_URL}/api/games/${gid}/join`, { method: "POST" });
    const data = await r.json();

    if (data.error) {
      setMpStatusMsg(`Join failed: ${data.error}`);
      return;
    }

    setMpGameId(data.gameId);
    setMpToken(data.token);
    setMpSeat(data.color);
    setMpState(data.state);
    saveMpSession(data.gameId, data.token, data.color);
    setMpStatusMsg(`Joined as ${data.color}.`);
  }

  function leaveOnlineGame() {
    clearMpSessionStorage();
    disconnectSocket();

    setMpGameId("");
    setMpToken("");
    setMpSeat("spectator");
    setMpState(null);
    setMpJoinInput("");
    setMpStatusMsg("Left online game.");

    setMpSelectedSquare(null);
    setMpLegalSquares([]);
    setMpLastMove(null);
    setMpPendingPromotion(null);
    setMpCheckSquare(null);
    setMpMoveRows([]);

    // Clear PEP state when leaving game
    setPepMatchId(null);
    setPepMatchStatus("idle");
    setPepWhiteEscrow("");
    setPepBlackEscrow("");
    setPepWhiteAddress("");
    setPepBlackAddress("");
    setPepStake("1000");
    setPepError("");
    setPepInfoMessage("");
    setPepWhiteDeposit(0);
    setPepBlackDeposit(0);
    setPepConfirmedDeposits(0);
    setPepResultSent(false);

    setLeftOnlineGame(true); // Show Reset Game button
    setMode("online");
  }

  // keep socket connected on mpGameId/mpToken
  useEffect(() => {
    if (!isOnline) return;
    if (mpGameId && mpToken) connectSocket(mpGameId, mpToken);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline, mpGameId, mpToken]);

  // sync mpChessRef with server fen + pgn, and compute UI helpers
  useEffect(() => {
    if (!isOnline) return;
    if (!mpState) return;

    try {
      mpChessRef.current.load(mpState.fen);
    } catch {}

    // captured pieces (online) — compute from current FEN
    try {
      const { capByWhite, capByBlack } = capturedFromFen(mpState.fen);
      setCapturedByWhite(capByWhite);
      setCapturedByBlack(capByBlack);
    } catch {
      // ignore
    }

    // last move highlight
    if (Array.isArray(mpState.moves) && mpState.moves.length > 0) {
      const last = mpState.moves[mpState.moves.length - 1];
      if (last?.from && last?.to) setMpLastMove([last.from, last.to]);
    } else {
      setMpLastMove(null);
    }

    // check highlight
    try {
      const c = mpChessRef.current;
      if (c.inCheck && c.inCheck()) {
        const turn = c.turn();
        setMpCheckSquare(findKingSquare(c, turn));
      } else {
        setMpCheckSquare(null);
      }
    } catch {
      setMpCheckSquare(null);
    }

    // moves rows from pgn
    setMpMoveRows(pgnToRows(mpState.pgn || ""));

    // if game ended and PEP active, report result
    // IMPORTANT: Only WHITE reports the result to avoid double payment (race condition)
    if (pepMatchId && !pepResultSent && mpState.status === "ended" && mpSeat === "white") {
      const r = mpState.result;
      if (r === "1-0") reportPepResult("white", mpState.pgn || "", mpState.fen || "");
      else if (r === "0-1") reportPepResult("black", mpState.pgn || "", mpState.fen || "");
      else if (r === "1/2-1/2") reportPepResult("draw", mpState.pgn || "", mpState.fen || "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline, mpState?.fen, mpState?.pgn, mpState?.status, mpState?.result]);

  // Sync PEP data from socket state (mp-server broadcasts pep data to both players)
  useEffect(() => {
    if (!isOnline) return;
    if (!mpState?.pep) return;

    const pep = mpState.pep;

    // Only sync if there's actual PEP data from the server
    if (pep.matchId) {
      setPepMatchId(pep.matchId);
      setPepMatchStatus(pep.status || "waiting_for_deposits");
    }
    if (pep.whiteEscrow) setPepWhiteEscrow(pep.whiteEscrow);
    if (pep.blackEscrow) setPepBlackEscrow(pep.blackEscrow);
    if (pep.stake) setPepStake(String(pep.stake));
    if (pep.whiteAddress) setPepWhiteAddress(pep.whiteAddress);
    if (pep.blackAddress) setPepBlackAddress(pep.blackAddress);
    if (pep.error) setPepError(pep.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline, mpState?.pep?.matchId, mpState?.pep?.whiteEscrow, mpState?.pep?.blackEscrow, mpState?.pep?.status]);

  // auto-load session + query params (?game=...&pep=...)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const gid = params.get("game");
    const pep = params.get("pep");

  const stake = params.get("stake");
  const wp = params.get("wp");
  const bp = params.get("bp");

  if (stake) setPepStake(stake);
  if (wp) setPepWhiteAddress(wp);
  if (bp) setPepBlackAddress(bp);

    if (pep) {
      setPepMatchId(pep);
      // status will be updated by polling
      if (pepMatchStatus === "idle") setPepMatchStatus("waiting_for_deposits");
    }

    const sess = loadMpSession();
    if (sess.gameId && sess.token) {
      setMode("online");
      setMpGameId(sess.gameId);
      setMpToken(sess.token);
      setMpSeat(sess.seat);
      setMpStatusMsg("Reconnected to online game.");
      return;
    }

    if (gid) {
      setMode("online");
      setMpJoinInput(gid);
      joinMpGameById(gid);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // online move helpers
  function mpClearSelection() {
    setMpSelectedSquare(null);
    setMpLegalSquares([]);
  }

  function mpSelectSquare(square) {
    const c = mpChessRef.current;
    const piece = c.get(square);
    const myColor = seatToColor(mpSeat);

    if (!piece) return false;
    if (!myColor) return false;
    if (piece.color !== myColor) return false;
    if (!mpMyTurn) return false;

    setMpSelectedSquare(square);
    const m = c.moves({ square, verbose: true });
    setMpLegalSquares(m.map((x) => x.to));
    return true;
  }

  function mpEmitMove(from, to, promotion) {
    if (!socketRef.current) return;
    if (!mpState) return;
    if (!mpIsPlayer) return;
    if (!mpMyTurn) return;
    if (mpState.status !== "playing") return;
    socketRef.current.emit("move", {
      gameId: mpGameId,
      token: mpToken,
      from,
      to,
      promotion,
    });
  }

  const handleSquareClickOnline = (square) => {
    if (pepBoardLocked) {
      setMpStatusMsg("PEP match active – wait for both deposits to confirm.");
      return;
    }
    if (!mpState) return;
    if (!mpIsPlayer || !mpMyTurn) return;
    if (mpState.status !== "playing") return;
    if (mpPendingPromotion) return;

    if (mpSelectedSquare === square) {
      mpClearSelection();
      return;
    }

    const c = mpChessRef.current;

    if (mpSelectedSquare) {
      const movesFromSelected = c.moves({ square: mpSelectedSquare, verbose: true });
      const targetMove = movesFromSelected.find((m) => m.to === square);

      if (targetMove) {
        const isPromotion =
          targetMove.piece === "p" && (targetMove.to[1] === "8" || targetMove.to[1] === "1");

        if (isPromotion) {
          setMpPendingPromotion({ from: mpSelectedSquare, to: square, color: c.turn() });
          return;
        }

        mpEmitMove(mpSelectedSquare, square, undefined);
        mpClearSelection();
        return;
      }
    }

    const selected = mpSelectSquare(square);
    if (!selected) mpClearSelection();
  };

  const handlePieceDropOnline = (sourceSquare, targetSquare) => {
    if (pepBoardLocked) {
      setMpStatusMsg("PEP match active – wait for both deposits to confirm.");
      return false;
    }
    if (!mpState) return false;
    if (!mpIsPlayer || !mpMyTurn) return false;
    if (mpState.status !== "playing") return false;
    if (mpPendingPromotion) return false;

    const c = mpChessRef.current;
    const movesFromSource = c.moves({ square: sourceSquare, verbose: true });
    const move = movesFromSource.find((m) => m.to === targetSquare);
    if (!move) return false;

    const isPromotion = move.piece === "p" && (move.to[1] === "8" || move.to[1] === "1");
    if (isPromotion) {
      setMpPendingPromotion({ from: sourceSquare, to: targetSquare, color: c.turn() });
      return false;
    }

    mpEmitMove(sourceSquare, targetSquare, undefined);
    mpClearSelection();
    return true;
  };

  const onPromotionChoiceOnline = (role) => {
    if (!mpPendingPromotion) return;
    const { from, to } = mpPendingPromotion;
    mpEmitMove(from, to, role);
    setMpPendingPromotion(null);
    mpClearSelection();
  };

  function mpResign() {
    if (!socketRef.current) return;
    socketRef.current.emit("resign", { gameId: mpGameId, token: mpToken });
  }

  function mpOfferDraw() {
    if (!socketRef.current) return;
    socketRef.current.emit("offer_draw", { gameId: mpGameId, token: mpToken });
  }

  function mpAcceptDraw() {
    if (!socketRef.current) return;
    socketRef.current.emit("accept_draw", { gameId: mpGameId, token: mpToken });
  }

  // ---------------------------
  // PEP match create/abort (merged)
  // ---------------------------
  const anyMovesForConfirm = isOnline
    ? ((mpState?.moves?.length || 0) > 0)
    : (moves.length > 0);

  const createPepMatch = async () => {
    if (pepMatchStatus === "creating") return;

    try {
      // 2-click confirmation if a game already has moves (local OR online)
      if (!pepPendingResetConfirm && anyMovesForConfirm) {
        setPepPendingResetConfirm(true);
        setPepError("");
        setPepInfoMessage(
          "PEP match will be linked to this game – click 'Create PEP match' again to confirm."
        );
        return;
      }

      const whiteAddr = (pepWhiteAddress || "").trim();
      const blackAddr = (pepBlackAddress || "").trim();

      const whiteValid = isProbablyPepAddress(whiteAddr);
      const blackValid = isProbablyPepAddress(blackAddr);

      if (!whiteValid || !blackValid) {
        setPepMatchStatus("error");
        setPepInfoMessage("");

        if (!whiteValid && !blackValid) {
          setPepError("White and Black PEP addresses look invalid – please check both.");
        } else if (!whiteValid) {
          setPepError("White PEP address looks invalid – please check and try again.");
        } else {
          setPepError("Black PEP address looks invalid – please check and try again.");
        }
        return;
      }

      // IMPORTANT:
      // - If local: reset board to start when creating a PEP match (existing behaviour)
      // - If online: do NOT reset locally (server owns the board)
      if (!isOnline) resetBoardOnlyLocal();

      setPepPendingResetConfirm(false);
      setPepError("");
      setPepInfoMessage("");
      setPepResultSent(false);
      setPepConfirmedDeposits(0);
      setPepWhiteDeposit(0);
      setPepBlackDeposit(0);
      setPepWhiteExtraRefunded(false);
      setPepWhiteExtraAmount(0);
      setPepBlackExtraRefunded(false);
      setPepBlackExtraAmount(0);

      setPepMatchStatus("creating");

      const stakeNum = parseFloat(pepStake);
      if (!Number.isFinite(stakeNum) || stakeNum <= 0) {
        throw new Error("Stake must be a positive number.");
      }

      const ctrl = new AbortController();
      const timeoutId = setTimeout(() => ctrl.abort(), 20000);

      let res;
      try {
        if (isOnline && mpGameId && mpToken) {
          // ONLINE: Use mp-server endpoint so both players get synced via socket
          res = await fetch(`${MP_URL}/api/games/${mpGameId}/pep/create`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: ctrl.signal,
            body: JSON.stringify({
              token: mpToken,
              stake: stakeNum,
              whiteAddress: whiteAddr,
              blackAddress: blackAddr,
            }),
          });
        } else {
          // LOCAL: Use Python API directly
          res = await fetch(`${API_BASE_URL}/api/matches`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: ctrl.signal,
            body: JSON.stringify({
              stake: stakeNum,
              white_address: whiteAddr,
              black_address: blackAddr,
            }),
          });
        }
      } finally {
        clearTimeout(timeoutId);
      }

      const raw = await res.text();
      let data = {};
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch {
        throw new Error(raw || "Failed to create match (non-JSON response).");
      }

      if (!res.ok) {
        throw new Error(data?.error || raw || "Failed to create match.");
      }

      if (isOnline) {
        // Online: PEP state will be synced via socket broadcast from mp-server
        // Just show success message - useEffect will handle state updates
        setPepMatchStatus("waiting_for_deposits");
        setPepInfoMessage("Match created – send stakes to each escrow address and wait for both deposits.");
      } else {
        // Local: Update state directly
        const newMatchId = data.matchId ?? data.id;
        if (!newMatchId) throw new Error("API did not return matchId.");

        const whiteEscrow = data.whiteEscrow ?? data.white_escrow ?? "";
        const blackEscrow = data.blackEscrow ?? data.black_escrow ?? "";
        const whiteDep = data.whiteDeposit ?? data.white_deposit ?? 0;
        const blackDep = data.blackDeposit ?? data.black_deposit ?? 0;

        setPepMatchId(newMatchId);
        setPepWhiteEscrow(whiteEscrow);
        setPepBlackEscrow(blackEscrow);
        setPepWhiteDeposit(whiteDep);
        setPepBlackDeposit(blackDep);

        setPepEscrowAddress("");
        setPepMatchStatus(data.status || "waiting_for_deposits");
        setPepConfirmedDeposits(0);

        setPepInfoMessage("Match created – send stakes to each escrow address and wait for both deposits.");
      }
    } catch (err) {
      setPepMatchStatus("error");

      const msg =
        err?.name === "AbortError"
          ? "Timed out creating match (API did not respond)."
          : err?.message
          ? err.message
          : String(err);

      setPepError(formatPepError(msg, pepWhiteAddress, pepBlackAddress));
    }
  };


  const abortPepMatch = async () => {
    if (!pepMatchId) return;

    setPepError("");
    setPepInfoMessage("");

    try {
      const res = await fetch(`${API_BASE_URL}/api/matches/${pepMatchId}/abort`, {
        method: "POST",
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || "Failed to abort match.");
      }

      const data = await res.json();
      setPepMatchStatus("aborted");
      setPepResultSent(true);

      if (data.txIds && data.txIds.length > 0) {
        setPepInfoMessage(shortMessage(`Match aborted – refund txid: ${data.txIds[0]}`, "Match aborted – refunds sent."));
      } else {
        setPepInfoMessage("Match aborted – refunds sent.");
      }
    } catch (err) {
      setPepMatchStatus("error");
      const msg = err && err.message ? err.message : typeof err === "string" ? err : "";
      setPepError(formatPepError(msg, pepWhiteAddress, pepBlackAddress));
    }
  };

  // keep local status updated
  useEffect(() => {
    if (isOnline) return;
    updateStatusLocal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manualResult, flaggedSide]);

  // ---------------------------
  // Promotion overlays (local + online)
  // ---------------------------
  const renderPromotionOverlay = (pending, onPick, onClose) => {
    if (!pending) return null;

    const { to, color } = pending;
    const squareSize = boardWidth / 8;
    const discSize = squareSize * 0.9;

    const rank = parseInt(to[1], 10);
    const rankIndex = 8 - rank;

    const squareCenterY = rankIndex * squareSize + squareSize / 2;
    const left = boardWidth + squareSize * 0.15 - discSize / 2;

    return (
      <div
        style={{ position: "absolute", inset: 0, zIndex: 5, pointerEvents: "auto" }}
        onClick={onClose}
      >
        <div style={{ position: "absolute", inset: 0, backgroundColor: "rgba(0,0,0,0.55)" }} />

        {PROMOTION_ORDER.map((role, i) => {
          const offset = color === "w" ? i : -i;
          const centerY = squareCenterY + offset * discSize;
          const top = centerY - discSize / 2;

          const pieceKey = (color === "w" ? "w" : "b") + role.toUpperCase();
          const imgSrc = pieceImagePaths[pieceKey];

          return (
            <div
              key={role}
              style={{
                position: "absolute",
                top,
                left,
                width: discSize,
                height: discSize,
                borderRadius: "50%",
                background:
                  "radial-gradient(circle at 30% 25%, #ffffff 0, #f5f5f5 35%, #b0b0b0 100%)",
                boxShadow:
                  "0 0 12px rgba(0,0,0,0.75), 0 0 0 1px rgba(255,255,255,0.65)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                zIndex: 6,
              }}
              onClick={(e) => {
                e.stopPropagation();
                onPick(role);
              }}
            >
              <img
                src={imgSrc}
                alt={pieceKey}
                draggable={false}
                style={{
                  width: discSize * 0.7,
                  height: discSize * 0.7,
                  filter: color === "w" ? "drop-shadow(0 0 3px rgba(0,0,0,0.7))" : "none",
                }}
              />
            </div>
          );
        })}
      </div>
    );
  };

  const promotionOverlayLocal = renderPromotionOverlay(
    pendingPromotion,
    onPromotionChoiceLocal,
    () => setPendingPromotion(null)
  );

  const promotionOverlayOnline = renderPromotionOverlay(
    mpPendingPromotion,
    onPromotionChoiceOnline,
    () => setMpPendingPromotion(null)
  );
  /*
  // ---------------------------
  // Captured row (local only)
  // ---------------------------
  const renderCapturedRow = (sideColor) => {
    const myMap = sideColor === "w" ? capturedByWhite : capturedByBlack;
    const oppMap = sideColor === "w" ? capturedByBlack : capturedByWhite;

    const icons = [];
    CAPTURE_ORDER.forEach((t) => {
      const count = myMap[t] || 0;
      for (let i = 0; i < count; i++) {
        const key = "w" + t.toUpperCase();
        icons.push(key);
      }
    });

    let score = 0;
    Object.keys(PIECE_VALUES).forEach((t) => {
      score += PIECE_VALUES[t] * ((myMap[t] || 0) - (oppMap[t] || 0));
    });

    if (icons.length === 0 && score <= 0) {
      return <div className="captured-row captured-row--empty" />;
    }

    return (
      <div className="captured-row">
        {icons.map((key, idx) => (
          <img key={`${key}-${idx}`} src={pieceImagePaths[key]} alt={key} className="captured-piece" />
        ))}
        {score > 0 && <span className="captured-score">+{score}</span>}
      </div>
    );
  };*/

function renderCapturedRow(sideColor) {
  const mine = isOnline
    ? (sideColor === "w" ? onlineCaptured.byWhite : onlineCaptured.byBlack)
    : (sideColor === "w" ? capturedByWhite : capturedByBlack);

  const opp = isOnline
    ? (sideColor === "w" ? onlineCaptured.byBlack : onlineCaptured.byWhite)
    : (sideColor === "w" ? capturedByBlack : capturedByWhite);

  // Captured pieces shown next to a side's clock are the OPPONENT's pieces.
  // So: white clock shows black pieces captured by white -> iconColor 'b'
  //     black clock shows white pieces captured by black -> iconColor 'w'
  const iconColor = sideColor === "w" ? "b" : "w";

  const myScore =
    mine.q * 9 + mine.r * 5 + mine.b * 3 + mine.n * 3 + mine.p * 1;
  const oppScore =
    opp.q * 9 + opp.r * 5 + opp.b * 3 + opp.n * 3 + opp.p * 1;
  const scoreDiff = myScore - oppScore;

  const hasAny =
    mine.q + mine.r + mine.b + mine.n + mine.p > 0 ||
    opp.q + opp.r + opp.b + opp.n + opp.p > 0;

  return (
    <div className={"captured-row captured-row-" + sideColor}>
      {CAPTURE_ORDER.flatMap((t) =>
        Array.from({ length: mine[t] || 0 }).map((_, idx) => (
          <img
            key={`${sideColor}-${t}-${idx}`}
            className="captured-piece"
            src={pieceImagePaths[`${iconColor}${t.toUpperCase()}`]}
            alt={t}
          />
        ))
      )}

      {!hasAny && <span className="captured-placeholder"> </span>}

      {scoreDiff > 0 && <span className="material-diff">+{scoreDiff}</span>}
    </div>
  );
}


  // ---------------------------
  // Local controls (draw/resign)
  // ---------------------------
  const handleResignClickLocal = () => {
    if (isGameStoppedLocal) return;

    if (!hasStarted) {
      resetGameLocal();
      setStatus("Game aborted.");
      return;
    }
    setPendingAction("resign");
  };

  const handleDrawClickLocal = () => {
    if (isGameStoppedLocal) return;
    setPendingAction("draw");
  };

  const confirmPendingActionLocal = () => {
    if (isGameStoppedLocal || !pendingAction) return;

    if (pendingAction === "draw") {
      setManualResult({ type: "draw", winner: null });
      setActiveColor(null);
      setTimerStarted(false);
      setStatus("Game drawn by agreement.");
    } else if (pendingAction === "resign") {
      const turn = game.turn();
      const winnerColor = turn === "w" ? "b" : "w";
      setManualResult({ type: "resign", winner: winnerColor });
      setActiveColor(null);
      setTimerStarted(false);
      const winnerName = winnerColor === "w" ? "White" : "Black";
      setStatus(`Resignation. ${winnerName} wins.`);
    }

    setPendingAction(null);
  };

  const cancelPendingActionLocal = () => setPendingAction(null);

  // ---------------------------
  // Square styles (local/online)
  // ---------------------------
  const customSquareStyles = {};

  const chosenLastMove = isOnline ? mpLastMove : lastMove;
  const chosenSelected = isOnline ? mpSelectedSquare : selectedSquare;
  const chosenLegal = isOnline ? mpLegalSquares : legalSquares;
  const chosenCheck = isOnline ? mpCheckSquare : checkSquare;

  if (chosenLastMove) {
    const [from, to] = chosenLastMove;
    [from, to].forEach((sq) => {
      customSquareStyles[sq] = {
        ...customSquareStyles[sq],
        boxShadow: "inset 0 0 0 9999px rgba(246, 246, 104, 0.35)",
      };
    });
  }

  if (chosenSelected) {
    customSquareStyles[chosenSelected] = {
      ...customSquareStyles[chosenSelected],
      boxShadow: "inset 0 0 0 3px rgba(120, 144, 255, 0.95)",
    };
  }

  (chosenLegal || []).forEach((sq) => {
    const c = isOnline ? mpChessRef.current : game;
    const piece = c.get(sq);
    if (piece) {
      customSquareStyles[sq] = {
        ...customSquareStyles[sq],
        boxShadow: "inset 0 0 0 3px rgba(0, 180, 0, 0.95)",
      };
    } else {
      customSquareStyles[sq] = {
        ...customSquareStyles[sq],
        background:
          "radial-gradient(circle, rgba(0, 180, 0, 0.95) 0, rgba(0, 180, 0, 0.95) 12%, transparent 13%)",
      };
    }
  });

  if (chosenCheck) {
    customSquareStyles[chosenCheck] = {
      ...customSquareStyles[chosenCheck],
      boxShadow:
        "inset 0 0 0 3px rgba(255, 80, 80, 0.95), inset 0 0 12px rgba(255, 80, 80, 0.9)",
    };
  }

  // ---------------------------
  // Derived UI model for board/moves/status
  // ---------------------------

  // Calculate total ply count from moves
  const totalPly = useMemo(() => {
    if (isOnline) {
      return mpState?.moves?.length ?? 0;
    } else {
      // Local game: count from moves array (each row has up to 2 moves)
      return gameRef.current.history().length;
    }
  }, [isOnline, mpState?.moves?.length, position]);

  // Compute position at a specific ply for history navigation
  const getPositionAtPly = useMemo(() => {
    return (ply) => {
      if (ply === null || ply === totalPly) {
        // Current position
        return isOnline ? (mpState?.fen || mpChessRef.current.fen()) : position;
      }
      // Replay moves to get position at ply
      const tempChess = new Chess();
      const history = isOnline
        ? (mpState?.moves || []).map(m => m.san)
        : gameRef.current.history();

      for (let i = 0; i < ply && i < history.length; i++) {
        tempChess.move(history[i]);
      }
      return tempChess.fen();
    };
  }, [isOnline, mpState?.fen, mpState?.moves, position, totalPly]);

  // Navigation functions (wrapped in useCallback for keyboard handler)
  const navFirst = useCallback(() => setViewPly(0), []);
  const navPrev = useCallback(() => setViewPly(p => Math.max(0, (p ?? totalPly) - 1)), [totalPly]);
  const navNext = useCallback(() => setViewPly(p => {
    const next = (p ?? totalPly) + 1;
    return next >= totalPly ? null : next;
  }), [totalPly]);
  const navLast = useCallback(() => setViewPly(null), []);

  // Reset viewPly when new moves are made
  useEffect(() => {
    setViewPly(null);
  }, [totalPly]);

  // Keyboard navigation for move history (arrow keys)
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (totalPly === 0) return;

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        navPrev();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        navNext();
      } else if (e.key === 'ArrowUp' || e.key === 'Home') {
        e.preventDefault();
        navFirst();
      } else if (e.key === 'ArrowDown' || e.key === 'End') {
        e.preventDefault();
        navLast();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [totalPly, navPrev, navNext, navFirst, navLast]);

  const currentBoardPosition = isOnline ? (mpState?.fen || mpChessRef.current.fen()) : position;
  const boardPosition = viewPly === null ? currentBoardPosition : getPositionAtPly(viewPly);
  const isViewingHistory = viewPly !== null && viewPly < totalPly;

  const gameEnded = isOnline ? (mpState?.status === "ended") : isGameStoppedLocal;

  const areDraggable =
    !pepBoardLocked &&
    !gameEnded &&
    !isViewingHistory &&
    !(isOnline ? mpPendingPromotion : pendingPromotion) &&
    (isOnline ? (mpIsPlayer && mpMyTurn && mpState?.status === "playing") : true);

  const boardOrientation = isOnline
    ? (mpSeat === "black" ? "black" : "white")
    : "white";

  const movesRowsToRender = isOnline ? mpMoveRows : moves;

  const statusText = isOnline
    ? mpStatusText(mpState) + (pepBoardLocked ? " (PEP: waiting for deposits)" : "")
    : status;

  // Invite link:
  // - Always include ?game=<mpGameId>
  // - Include stake + white address so Black can see them when joining
  // - Black will create the PEP match after entering their address

// near the top of CoreGame component with other hooks
const [inviteCopied, setInviteCopied] = useState(false);

// Build invite URL with stake and white address (Black will create the match)
const inviteUrl =
  isOnline && mpGameId
    ? `${window.location.origin}/?game=${mpGameId}` +
      (pepStake ? `&stake=${encodeURIComponent(pepStake)}` : "") +
      (pepWhiteAddress ? `&wp=${encodeURIComponent(pepWhiteAddress)}` : "")
    : "";

const copyInvite = async () => {
  if (!inviteUrl) return;

  const done = () => {
    setInviteCopied(true);
    setTimeout(() => setInviteCopied(false), 1500);
  };

  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(inviteUrl);
      done();
      return;
    }
  } catch {}

  try {
    const ta = document.createElement("textarea");
    ta.value = inviteUrl;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    if (ok) {
      done();
      return;
    }
  } catch {}

  window.prompt("Copy invite link:", inviteUrl);
};

  return (
    <div className="app-root">
      <h1 ref={titleRef} className="title">PEP Chess (Core Game)</h1>

      {/* Multiplayer bar (same UI page) */}
      <div
        style={{
          maxWidth: 1200,
          margin: "0 auto",
          display: "flex",
          gap: 10,
          flexWrap: "wrap",
          alignItems: "center",
          padding: "0 0 14px 0",
        }}
      >
        {/* <button
          className="control-btn"
          onClick={() => setMode("local")}
          disabled={!isOnline}
          title="Local mode"
        >
          Local
        </button> */}

        <button
          className="control-btn"
          onClick={() => setMode("online")}
          disabled={isOnline}
          title="Online mode"
        >
          Online
        </button>

        <button
          className="control-btn"
          onClick={createMpGame}
          disabled={!isOnline}
          title="Create a new online game"
        >
          Create Online Game
        </button>

        <input
          value={mpJoinInput}
          onChange={(e) => setMpJoinInput(e.target.value)}
          placeholder="Enter gameId to join"
          style={{
            height: 36,
            padding: "0 10px",
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.15)",
            background: "rgba(0,0,0,0.25)",
            color: "white",
            outline: "none",
            width: 220,
          }}
          disabled={!isOnline}
        />

        <button
          className="control-btn"
          onClick={() => joinMpGameById(mpJoinInput)}
          disabled={!isOnline}
          title="Join by gameId"
        >
          Join
        </button>

        <button
          className="control-btn control-btn-resign"
          onClick={leaveOnlineGame}
          disabled={!isOnline}
          title="Leave online game"
        >
          Leave Online
        </button>

        <div style={{ marginLeft: "auto", fontFamily: "monospace", opacity: 0.9 }}>
          {isOnline ? (
            <>
              socket: <b>{mpConnected ? "connected" : "disconnected"}</b>{" "}
              {mpGameId ? (
                <>
                  | game: <b>{mpGameId}</b> | seat: <b>{mpSeat}</b>
                </>
              ) : null}
            </>
          ) : (
            <span>Local mode</span>
          )}
        </div>

        {isOnline && inviteUrl && (
          <div
            style={{
              width: "100%",
              fontFamily: "monospace",
              opacity: 0.9,
              display: "flex",
              gap: 10,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <span>Invite:</span>

            <a href={inviteUrl} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>
              {inviteUrl}
            </a>

            <button
              className="control-btn"
              onClick={copyInvite}
              style={{ padding: "6px 12px", fontSize: 12 }}
              type="button"
            >
              {inviteCopied ? "Copied" : "Copy"}
            </button>
          </div>
        )}

        {isOnline && mpStatusMsg && (
          <div style={{ width: "100%", fontFamily: "monospace", opacity: 0.85 }}>
            {mpStatusMsg}
          </div>
        )}
      </div>

      <div className="main-layout">
        <div className="board-wrapper">
          <div className="board-inner" style={{ width: boardWidth, position: "relative" }}>
            <Chessboard
              position={boardPosition}
              onPieceDrop={isOnline ? handlePieceDropOnline : handlePieceDropLocal}
              onSquareClick={isOnline ? handleSquareClickOnline : handleSquareClickLocal}
              customSquareStyles={customSquareStyles}
              customDarkSquareStyle={{ backgroundColor: DARK_SQUARE }}
              customLightSquareStyle={{ backgroundColor: LIGHT_SQUARE }}
              customBoardStyle={{
                borderRadius: "4px",
                boxShadow: "0 12px 35px rgba(0,0,0,0.7)",
              }}
              arePiecesDraggable={areDraggable}
              boardWidth={boardWidth}
              animationDuration={200}
              customPieces={customPieces}
              boardOrientation={boardOrientation}
            />

            {isOnline ? promotionOverlayOnline : promotionOverlayLocal}
          </div>

          <div ref={bottomBarRef} className="bottom-bar">
            <span className="status-text">
              {isViewingHistory && <span className="history-badge">Move {viewPly}/{totalPly}</span>}
              {statusText}
            </span>

            {mpGameId ? (
              <button className="reset-btn" onClick={leaveOnlineGame}>
                Leave Game
              </button>
            ) : leftOnlineGame ? (
              <button
                className="reset-btn"
                onClick={() => {
                  resetBoardOnlyLocal();
                  setLeftOnlineGame(false);
                  setPepStake("");
                  setMpStatusMsg("");
                }}
              >
                Reset Game
              </button>
            ) : (
              <button
                className="reset-btn"
                onClick={resetGameLocal}
                disabled={!canResetLocal}
                title={canResetLocal ? "" : "Reset is disabled while a game is in progress"}
              >
                Reset Game
              </button>
            )}
          </div>
        </div>

        <div className="side-panel">
          {/* Top clock - opponent's clock (Black for White player, White for Black player) */}
          <div className="clock-block">
            {(isOnline && seat === "black") ? (
              // Black player sees White clock at top
              <div className={"clock" + (whiteClockActive ? " clock-active" : "")}>
                <span className="clock-label">
                  WHITE
                  {mpState?.players?.white && (
                    <span className={mpState.players.white.connected ? "player-online" : "player-offline"}>
                      {mpState.players.white.connected ? " (online)" : " (offline)"}
                    </span>
                  )}
                </span>
                <span className="clock-time">{formatTime(onlineWhiteMs)}</span>
              </div>
            ) : (
              // White player (or local) sees Black clock at top
              <div className={"clock" + (blackClockActive ? " clock-active" : "")}>
                <span className="clock-label">
                  BLACK
                  {isOnline && mpState?.players?.black && (
                    <span className={mpState.players.black.connected ? "player-online" : "player-offline"}>
                      {mpState.players.black.connected ? " (online)" : " (offline)"}
                    </span>
                  )}
                  {isOnline && !mpState?.players?.black && (
                    <span className="player-waiting"> (waiting)</span>
                  )}
                </span>
                <span className="clock-time">{formatTime(isOnline ? onlineBlackMs : blackTime)}</span>
              </div>
            )}
            {renderCapturedRow((isOnline && seat === "black") ? "w" : "b")}
          </div>

          {/* Moves table */}
          <div className="moves-panel">
            {/* Move navigation buttons */}
            <div className="move-nav-buttons">
              <button className="move-nav-btn" onClick={navFirst} disabled={totalPly === 0 || viewPly === 0} title="First move">
                &#x23EE;
              </button>
              <button className="move-nav-btn" onClick={navPrev} disabled={totalPly === 0 || viewPly === 0} title="Previous move">
                &#x23F4;
              </button>
              <button className="move-nav-btn" onClick={navNext} disabled={totalPly === 0 || viewPly === null} title="Next move">
                &#x23F5;
              </button>
              <button className="move-nav-btn" onClick={navLast} disabled={totalPly === 0 || viewPly === null} title="Last move">
                &#x23ED;
              </button>
            </div>
            <div className="moves-header">
              <span>#</span>
              <span>White</span>
              <span>Black</span>
            </div>
            <div className="moves-body">
              {movesRowsToRender.length === 0 && <div className="moves-empty">No moves yet.</div>}
              {movesRowsToRender.map((row) => {
                const whitePly = row.no * 2 - 1;
                const blackPly = row.no * 2;
                const currentPly = viewPly ?? totalPly;
                return (
                  <div key={row.no} className="moves-row">
                    <span>{row.no}.</span>
                    <span
                      className={`move-cell ${row.white ? 'move-clickable' : ''} ${currentPly === whitePly ? 'move-active' : ''}`}
                      onClick={() => row.white && setViewPly(whitePly === totalPly ? null : whitePly)}
                    >
                      {row.white}
                    </span>
                    <span
                      className={`move-cell ${row.black ? 'move-clickable' : ''} ${currentPly === blackPly ? 'move-active' : ''}`}
                      onClick={() => row.black && setViewPly(blackPly === totalPly ? null : blackPly)}
                    >
                      {row.black}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Bottom clock - player's own clock */}
          <div className="clock-block">
            {(isOnline && seat === "black") ? (
              // Black player sees their clock at bottom
              <div className={"clock" + (blackClockActive ? " clock-active" : "")}>
                <span className="clock-label">
                  BLACK
                  {mpState?.players?.black && (
                    <span className={mpState.players.black.connected ? "player-online" : "player-offline"}>
                      {mpState.players.black.connected ? " (online)" : " (offline)"}
                    </span>
                  )}
                </span>
                <span className="clock-time">{formatTime(onlineBlackMs)}</span>
              </div>
            ) : (
              // White player (or local) sees White clock at bottom
              <div className={"clock" + (whiteClockActive ? " clock-active" : "")}>
                <span className="clock-label">
                  WHITE
                  {isOnline && mpState?.players?.white && (
                    <span className={mpState.players.white.connected ? "player-online" : "player-offline"}>
                      {mpState.players.white.connected ? " (online)" : " (offline)"}
                    </span>
                  )}
                </span>
                <span className="clock-time">{formatTime(isOnline ? onlineWhiteMs : whiteTime)}</span>
              </div>
            )}
            {renderCapturedRow((isOnline && seat === "black") ? "b" : "w")}
          </div>

          {/* Draw / resign controls */}
          <div className="controls-row">
            {!isOnline ? (
              pendingAction ? (
                <>
                  <button className="control-btn control-btn-confirm" onClick={confirmPendingActionLocal} disabled={gameEnded}>
                    ✓ {pendingAction === "draw" ? "Confirm draw" : "Confirm resign"}
                  </button>
                  <button className="control-btn control-btn-cancel" onClick={cancelPendingActionLocal} disabled={gameEnded}>
                    ✕ Cancel
                  </button>
                </>
              ) : (
                <>
                  <button className="control-btn" onClick={handleDrawClickLocal} disabled={gameEnded}>
                    Draw
                  </button>
                  <button className="control-btn control-btn-resign" onClick={handleResignClickLocal} disabled={gameEnded}>
                    {hasStarted ? "Resign" : "Abort"}
                  </button>
                </>
              )
            ) : (
              <>
                <button
                  className="control-btn"
                  onClick={() => {
                    if (mpState?.drawOffer && mpState.drawOffer.by !== mpSeat) mpAcceptDraw();
                    else mpOfferDraw();
                  }}
                  disabled={!mpIsPlayer || !mpState || mpState.status !== "playing"}
                  title={mpState?.drawOffer ? "Accept draw" : "Offer draw"}
                >
                  {mpState?.drawOffer ? "Accept Draw" : "Offer Draw"}
                </button>
                {/* Show Abort before player's first move, Resign after */}
                <button
                  className="control-btn control-btn-resign"
                  onClick={currentPlayerHasMoved ? mpResign : (pepMatchId ? abortPepMatch : mpResign)}
                  disabled={!mpIsPlayer || !mpState || mpState.status !== "playing"}
                >
                  {currentPlayerHasMoved ? "Resign" : "Abort"}
                </button>
              </>
            )}
          </div>

          {/* PEP match controls */}
          <div className="pep-panel">
            <h2 className="pep-title">PEP Match (optional)</h2>
            <p className="pep-subtitle">
              Both players stake the same PEP amount, and the winner automatically receives the pot from escrow.
              Leave stake blank or 0 for a free game.
            </p>

            <div className="pep-field-row">
              <label className="pep-label">Stake (PEP) - Leave blank for free game</label>
              <input
                className="pep-input"
                type="number"
                min="0"
                step="1"
                value={pepStake}
                onChange={(e) => {
                  const value = e.target.value;
                  if (value === "" || /^\d*(\.\d{0,2})?$/.test(value)) setPepStake(value);
                }}
                disabled={isPepMatchLocked || hasAnyGameMove || (isOnline && mpSeat !== "white")}
                placeholder="0"
              />
            </div>

            {/* Only show address fields and Create button if stake > 0 and game hasn't started */}
            {parseFloat(pepStake) > 0 && !hasAnyGameMove && (
              <>
                <div className="pep-field-row">
                  <label className="pep-label">White PEP payout address</label>
                  <input
                    className="pep-input"
                    type="text"
                    value={pepWhiteAddress}
                    onChange={(e) => setPepWhiteAddress(e.target.value)}
                    disabled={isPepMatchLocked || (isOnline && mpSeat !== "white")}
                    placeholder={isOnline && mpSeat !== "white" ? "Only White can enter this" : ""}
                  />
                </div>

                <div className="pep-field-row">
                  <label className="pep-label">Black PEP payout address</label>
                  <input
                    className="pep-input"
                    type="text"
                    value={pepBlackAddress}
                    onChange={(e) => setPepBlackAddress(e.target.value)}
                    disabled={isPepMatchLocked || (isOnline && mpSeat !== "black")}
                    placeholder={isOnline && mpSeat !== "black" ? "Only Black can enter this" : ""}
                  />
                </div>

                <button
                  className="pep-button"
                  onClick={createPepMatch}
                  disabled={!canCreatePepMatch || pepMatchStatus === "creating"}
                >
                  {pepPendingResetConfirm ? "Confirm PEP match" : pepMatchId ? "Create new match" : "Create PEP match"}
                </button>
              </>
            )}

            {/* <button
              className="pep-button pep-button-abort"
              onClick={abortPepMatch}
              disabled={!canAbortPepMatch}
            >
              Abort match & refund
            </button> */}

            {canAbortPepMatch && (
              <button className="btn abort-btn" onClick={abortPepMatch}>
                Abort match & refund
              </button>
            )}

            {/* Escrow addresses and status - only show when stake > 0 */}
            {parseFloat(pepStake) > 0 && (
              <>
                {/* Escrow addresses (with copy buttons) */}
                {showWhiteEscrow && (
              <div className="pep-address-row">
                <div className="pep-status-label">White escrow</div>
                <div className="pep-escrow-address-row">
                  <div className="pep-escrow-address">{pepWhiteEscrow || "—"}</div>
                  <button
                    type="button"
                    className="pep-copy-btn"
                    // onClick={() => {
                    //   if (!pepWhiteEscrow) return;
                    //   navigator.clipboard.writeText(pepWhiteEscrow);
                    //   setCopiedWhiteEscrow(true);
                    //   setTimeout(() => setCopiedWhiteEscrow(false), 1500);
                    // }}
                    onClick={async () => {
                      const ok = await copyText(pepWhiteEscrow);
                      if (!ok) return;
                      setCopiedWhiteEscrow(true);
                      setTimeout(() => setCopiedWhiteEscrow(false), 1500);
                    }}
                    disabled={!pepWhiteEscrow}
                  >
                    Copy
                  </button>
                  {copiedWhiteEscrow && <span className="pep-copy-msg">Copied!</span>}
                </div>
              </div>
            )}

            {showBlackEscrow && (
              <div className="pep-address-row">
                <div className="pep-status-label">Black escrow</div>
                <div className="pep-escrow-address-row">
                  <div className="pep-escrow-address">{pepBlackEscrow || "—"}</div>
                  <button
                    type="button"
                    className="pep-copy-btn"
                    // onClick={() => {
                    //   if (!pepBlackEscrow) return;
                    //   navigator.clipboard.writeText(pepBlackEscrow);
                    //   setCopiedBlackEscrow(true);
                    //   setTimeout(() => setCopiedBlackEscrow(false), 1500);
                    // }}
                    onClick={async () => {
                      const ok = await copyText(pepBlackEscrow);
                      if (!ok) return;
                      setCopiedBlackEscrow(true);
                      setTimeout(() => setCopiedBlackEscrow(false), 1500);
                    }}
                    disabled={!pepBlackEscrow}
                  >
                    Copy
                  </button>
                  {copiedBlackEscrow && <span className="pep-copy-msg">Copied!</span>}
                </div>
              </div>
            )}


            {pepEscrowAddress && (
              <div className="pep-escrow">
                <div className="pep-escrow-label">Escrow address</div>
                <code className="pep-escrow-value">{pepEscrowAddress}</code>
              </div>
            )}

            <div className="pep-status-row">
              <span className="pep-status-label">Status:</span>
              <span className="pep-status-value">
                {pepMatchStatus === "idle" && "No match"}
                {pepMatchStatus === "creating" && "Creating match…"}
                {pepMatchStatus === "waiting_for_deposits" && "Waiting for both deposits…"}
                {pepMatchStatus === "ready_to_play" && "Ready to play"}
                {pepMatchStatus === "settled" && "Settled on-chain"}
                {pepMatchStatus === "error" && "Error – check message below"}
                {pepMatchStatus === "aborted" && "Aborted"}
              </span>
            </div>

            <div className="pep-status-line">Deposits: {confirmedDeposits} / 2 confirmed</div>

            <div className="pep-deposit-status">
              <span className={"pep-deposit-inline" + (whiteDepositOk ? " pep-deposit-ok" : "")}>
                <span className="pep-dot" />
                White {pepWhiteDeposit.toFixed(4)} PEP
              </span>

              <span className={"pep-deposit-inline" + (blackDepositOk ? " pep-deposit-ok" : "")}>
                <span className="pep-dot" />
                Black {pepBlackDeposit.toFixed(4)} PEP
              </span>
            </div>

            {pepMatchStatus !== "settled" && pepMatchStatus !== "aborted" && (
              <>
                {pepWhiteDeposit > stakeNumber && !pepWhiteExtraRefunded && (
                  <div className="pep-warning-line">
                    White overpaid (stake {stakeNumber.toFixed(4)} PEP); extra will be refunded.
                  </div>
                )}
                {pepBlackDeposit > stakeNumber && !pepBlackExtraRefunded && (
                  <div className="pep-warning-line">
                    Black overpaid (stake {stakeNumber.toFixed(4)} PEP); extra will be refunded.
                  </div>
                )}
              </>
            )}

            {pepWhiteExtraRefunded && pepWhiteExtraAmount > 0 && (
              <div className="pep-info">Extra {pepWhiteExtraAmount.toFixed(4)} PEP refunded to White.</div>
            )}
            {pepBlackExtraRefunded && pepBlackExtraAmount > 0 && (
              <div className="pep-info">Extra {pepBlackExtraAmount.toFixed(4)} PEP refunded to Black.</div>
            )}

            {pepInfoMessage && <div className="pep-info">{shortMessage(pepInfoMessage)}</div>}
            {pepError && <div className="pep-error">{shortMessage(pepError, "PEP match error.")}</div>}
              </>
            )}

          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
