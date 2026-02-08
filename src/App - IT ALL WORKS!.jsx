import { useEffect, useRef, useState } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
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
/*
const API_BASE_URL =
  import.meta.env.VITE_PEP_API_URL || "http://localhost:8001";
*/
/*
const API_BASE_URL =
  import.meta.env.VITE_PEP_API_URL || "http://127.0.0.1:8001";
*/
/*
const API_BASE_URL =
  import.meta.env.VITE_PEP_API_URL || "http://5.223.75.104:8001";
*/

const API_BASE_URL =
  import.meta.env.VITE_PEP_API_URL || `http://${window.location.hostname}:8001`;


/*
const API_BASE_URL = "http://5.223.75.104:8001";
*/
// piece values for material diff
const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9 };
// order icons appear in material row (lichess-ish)
const CAPTURE_ORDER = ["q", "r", "b", "n", "p"];

const START_TIME_MS = 5 * 60 * 1000; // 5+0 blitz

function formatTime(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function isProbablyPepAddress(addr) {
  if (!addr) return false;
  const a = addr.trim();

  // Typical PEP addresses: start with P, ~34 chars
  if (!a.startsWith("P")) return false;
  if (a.length < 30 || a.length > 40) return false;

  // Base58 charset (no 0,O,I,l)
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
      if (typeof obj.detail === "string") {
        text = obj.detail;
      }
    } catch (_) {}
  }

  const lower = text.toLowerCase();

  // ---------- INVALID ADDRESS CASE ----------
  const mentionsInvalidAddress =
    lower.includes("invalid") && lower.includes("address");

  if (mentionsInvalidAddress) {
    let whiteBad = lower.includes("white");
    let blackBad = lower.includes("black");

    const whiteLooksValid = isProbablyPepAddress(whiteAddr);
    const blackLooksValid = isProbablyPepAddress(blackAddr);

    if (!whiteBad && whiteAddr.trim() && !whiteLooksValid) whiteBad = true;
    if (!blackBad && blackAddr.trim() && !blackLooksValid) blackBad = true;

    if (whiteBad && blackBad) {
      return "White and Black PEP addresses are invalid – check both and try again.";
    }
    if (whiteBad) {
      return "White PEP address is invalid – check and try again.";
    }
    if (blackBad) {
      return "Black PEP address is invalid – check and try again.";
    }

    // can't tell which one → say and/or
    return "White and/or Black PEP address is invalid – check both and try again.";
  }

  // ---------- NODE / RPC / CONNECTION ERRORS ----------
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

// Helper to keep PEP messages short (one clean sentence)
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

function App() {
  const titleRef = useRef(null);
  const bottomBarRef = useRef(null);
  const gameRef = useRef(new Chess());

  const [position, setPosition] = useState(gameRef.current.fen());
  const [selectedSquare, setSelectedSquare] = useState(null);
  const [legalSquares, setLegalSquares] = useState([]);
  const [lastMove, setLastMove] = useState(null); // [from, to]
  const [status, setStatus] = useState("White to move.");
  const [moves, setMoves] = useState([]); // [{ no, white, black }]
  const [checkSquare, setCheckSquare] = useState(null);
  const [pendingPromotion, setPendingPromotion] = useState(null); // { from, to, color }
  const hasStarted = moves.length > 0;

  // clocks
  const [whiteTime, setWhiteTime] = useState(START_TIME_MS);
  const [blackTime, setBlackTime] = useState(START_TIME_MS);
  const [activeColor, setActiveColor] = useState(null); // 'w' or 'b'
  const [timerStarted, setTimerStarted] = useState(false);
  const [flaggedSide, setFlaggedSide] = useState(null); // 'w' | 'b' | null

  // manual results (resign / draw)
  const [manualResult, setManualResult] = useState(null); // { type: 'resign'|'draw', winner: 'w'|'b'|null }

  // which confirm UI is active: 'draw' | 'resign' | null
  const [pendingAction, setPendingAction] = useState(null);

  // captured pieces: how many pieces each side has captured
  const emptyCaps = { p: 0, n: 0, b: 0, r: 0, q: 0 };
  const [capturedByWhite, setCapturedByWhite] = useState({ ...emptyCaps });
  const [capturedByBlack, setCapturedByBlack] = useState({ ...emptyCaps });

  // --- PEP match / escrow state ---
  const [pepMatchId, setPepMatchId] = useState(null);
  const [pepEscrowAddress, setPepEscrowAddress] = useState("");
  const [pepMatchStatus, setPepMatchStatus] = useState("idle"); // "idle" | "creating" | "waiting_for_deposits" | "ready_to_play" | "settled" | "error"

  const isPepMatchLocked =
  pepMatchStatus === "creating" ||
  pepMatchStatus === "waiting_for_deposits" ||
  pepMatchStatus === "ready_to_play";


  const [pepStake, setPepStake] = useState("1000");
  const [pepWhiteAddress, setPepWhiteAddress] = useState("");
  const [pepBlackAddress, setPepBlackAddress] = useState("");
  const [pepError, setPepError] = useState("");
  const [pepInfoMessage, setPepInfoMessage] = useState("");
  const [pepResultSent, setPepResultSent] = useState(false);
  const [pepConfirmedDeposits, setPepConfirmedDeposits] = useState(0);
  const pepModeActive =
    pepMatchId && pepMatchStatus !== "settled" && pepMatchStatus !== "error";
  const pepBoardLocked =
    pepModeActive && pepMatchStatus !== "ready_to_play";
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

  const canCreatePepMatch =
    !pepMatchId || pepMatchStatus === "settled" || pepMatchStatus === "error";

  const canAbortPepMatch =
    pepMatchId &&
    (pepMatchStatus === "waiting_for_deposits" ||
      pepMatchStatus === "ready_to_play");

  const stakeNumber = parseFloat(pepStake) || 0;
  const whiteDepositOk = stakeNumber > 0 && pepWhiteDeposit >= stakeNumber;
  const blackDepositOk = stakeNumber > 0 && pepBlackDeposit >= stakeNumber;
  const confirmedDeposits =
    (whiteDepositOk ? 1 : 0) + (blackDepositOk ? 1 : 0);

  // fixed board width
  //const boardWidth = 680;

const [boardWidth, setBoardWidth] = useState(680);

const SIDE_PANEL_W = 625; // must match CSS
const GAP = 24;
const PAD_X = 48;         // app-root left+right padding (24+24)
const PAD_Y = 46;         // app-root top+bottom padding-ish + small buffer
const MAX_BOARD = 720;    // bigger than before

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


  const game = gameRef.current;

  const isGameStopped =
    flaggedSide !== null || manualResult !== null || game.isGameOver();

  // Reset rules:
  // - allowed before any move has been played
  // - allowed after the game has ended
  // - NOT allowed mid-game
  const canReset = !hasStarted || isGameStopped;

  async function reportPepResult(result) {
    // result: "white" | "black" | "draw"
    if (!pepMatchId || pepResultSent) return;

    try {
      setPepInfoMessage("Reporting PEP match result…");

      const res = await fetch(
        `${API_BASE_URL}/api/matches/${pepMatchId}/result`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            result,
            pgn: game.pgn(),
            finalFen: game.fen(),
          }),
        }
      );

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
        setPepInfoMessage(
          shortMessage(
            `Match settled; first payout txid: ${data.txIds[0]}`,
            "Match settled; payouts sent."
          )
        );
      } else {
        setPepInfoMessage("Match settled; payouts sent.");
      }

      setPepError("");
      setPepResultSent(true);
    } catch (err) {
      setPepError(
        shortMessage(err, "Failed to report PEP match result.")
      );
      // allow retry if something went wrong
      setPepResultSent(false);
    }
  }

  // ---------- helpers ----------

  const syncMoves = () => {
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

  const updateStatus = () => {
    // manual results override everything
    if (manualResult) {
      // report to PEP backend (if match is active)
      if (pepMatchId && !pepResultSent) {
        if (manualResult.type === "draw") {
          reportPepResult("draw");
        } else if (manualResult.type === "resign") {
          const winnerColor = manualResult.winner; // "w" | "b"
          const resultString =
            winnerColor === "w"
              ? "white"
              : winnerColor === "b"
              ? "black"
              : null;
          if (resultString) {
            reportPepResult(resultString);
          }
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

    // time flag
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
        if (pepMatchId && !pepResultSent) {
          reportPepResult("draw");
        }

        if (game.isStalemate()) setStatus("Draw by stalemate.");
        else if (game.isThreefoldRepetition())
          setStatus("Draw by threefold repetition.");
        else if (game.isInsufficientMaterial())
          setStatus("Draw by insufficient material.");
        else setStatus("Draw.");
      } else {
        setStatus("Game over.");
      }
    } else {
      const turnName = game.turn() === "w" ? "White" : "Black";
      if (game.inCheck()) setStatus(`${turnName} to move — in check.`);
      else setStatus(`${turnName} to move.`);
    }

    if (game.inCheck()) {
      setCheckSquare(findKingSquare(game, game.turn()));
    } else {
      setCheckSquare(null);
    }
  };

  // ---------- reset helpers ----------

  const resetBoardOnly = () => {
    // --- chess state only ---
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

  const resetGame = () => {
    // Prevent resetting once a game is in progress.
    // Reset is only allowed before the first move, or after the game ends.
    if (!canReset) return;

    // reset the board + clocks
    resetBoardOnly();

    // --- PEP match / form state ---
    setPepMatchId(null);
    setPepMatchStatus("idle");
    setPepResultSent(false);
    setPepPendingResetConfirm(false);

    // leave stake as-is (so user doesn’t have to re-enter it)
    // setPepStake("1000");

    // fully clear payout addresses on a manual Reset
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


const createPepMatch = async () => {
  if (pepMatchStatus === "creating") return;

  // --- 2-click confirmation if there are moves on the board ---
  if (!pepPendingResetConfirm && moves.length > 0) {
    setPepPendingResetConfirm(true);
    setPepError("");
    setPepInfoMessage(
      "PEP match will reset the board – click 'Create PEP match' again to confirm."
    );
    return; // don't create the match yet
  }

  // ---------- FRONT-END ADDRESS FORMAT CHECK ----------
  const whiteValid = isProbablyPepAddress(pepWhiteAddress);
  const blackValid = isProbablyPepAddress(pepBlackAddress);

  if (!whiteValid || !blackValid) {
    setPepMatchStatus("error");
    setPepInfoMessage("");

    if (!whiteValid && !blackValid) {
      setPepError(
        "White and Black PEP addresses look invalid – please check both."
      );
    } else if (!whiteValid) {
      setPepError(
        "White PEP address looks invalid – please check and try again."
      );
    } else {
      setPepError(
        "Black PEP address looks invalid – please check and try again."
      );
    }
    return; // stop here, don't reset board / hit API
  }

  // ---------- actually reset and create match ----------
  setPepPendingResetConfirm(false);
  resetBoardOnly(); // reset only the board, keep stake + payout addresses

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

  try {
    const stakeNum = parseFloat(pepStake);
    if (!Number.isFinite(stakeNum) || stakeNum <= 0) {
      throw new Error("Stake must be a positive number.");
    }
    if (!pepWhiteAddress.trim() || !pepBlackAddress.trim()) {
      throw new Error("Both PEP addresses are required.");
    }

    const res = await fetch(`${API_BASE_URL}/api/matches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stake: stakeNum,
        white_address: pepWhiteAddress.trim(),
        black_address: pepBlackAddress.trim(),
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || "Failed to create match.");
    }

    const data = await res.json();

    const matchId = data.matchId ?? data.id;
    const whiteEscrow = data.whiteEscrow ?? data.white_escrow ?? "";
    const blackEscrow = data.blackEscrow ?? data.black_escrow ?? "";
    const whiteDep = data.whiteDeposit ?? data.white_deposit ?? 0;
    const blackDep = data.blackDeposit ?? data.black_deposit ?? 0;

    setPepMatchId(matchId);
    setPepWhiteEscrow(whiteEscrow);
    setPepBlackEscrow(blackEscrow);
    setPepWhiteDeposit(whiteDep);
    setPepBlackDeposit(blackDep);

    // Optional single escrow field; not used for deposits
    setPepEscrowAddress("");

    setPepMatchStatus(data.status || "waiting_for_deposits");
    setPepConfirmedDeposits(0);
    setPepWhiteExtraRefunded(false);
    setPepWhiteExtraAmount(0);
    setPepBlackExtraRefunded(false);
    setPepBlackExtraAmount(0);

    setPepInfoMessage(
      "Match created – send stakes to each escrow address and wait for both deposits."
    );
  } catch (err) {
    setPepMatchStatus("error");
    const msg =
      err && err.message ? err.message : typeof err === "string" ? err : "";
    setPepError(formatPepError(msg, pepWhiteAddress, pepBlackAddress));
  }
};


  const abortPepMatch = async () => {
    if (!pepMatchId) return;

    setPepError("");
    setPepInfoMessage("");

    try {
      const res = await fetch(
        `${API_BASE_URL}/api/matches/${pepMatchId}/abort`,
        {
          method: "POST",
        }
      );

      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || "Failed to abort match.");
      }

      const data = await res.json();

      setPepMatchStatus("aborted");
      setPepResultSent(true); // prevent any later auto-result from firing
      if (data.txIds && data.txIds.length > 0) {
        setPepInfoMessage(
          shortMessage(
            `Match aborted – refund txid: ${data.txIds[0]}`,
            "Match aborted – refunds sent."
          )
        );
      } else {
        setPepInfoMessage("Match aborted – refunds sent.");
      }
    } catch (err) {
    setPepMatchStatus("error");
    const msg =
      err && err.message ? err.message : typeof err === "string" ? err : "";
    setPepError(formatPepError(msg, pepWhiteAddress, pepBlackAddress));
    }
  };

  useEffect(() => {
    updateStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manualResult, flaggedSide]);

  // --------- clocks: tick every second while active ---------
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

  // --------- PEP match polling (escrow deposits, settled status) ---------
  useEffect(() => {
    if (!pepMatchId) return;

    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/api/matches/${pepMatchId}`);
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        if (data.underDepositMessage) {
          setPepInfoMessage(data.underDepositMessage);
        }
        if (data.status) {
          setPepMatchStatus(data.status);

          const whiteEscrow = data.whiteEscrow ?? data.white_escrow ?? "";
          const blackEscrow = data.blackEscrow ?? data.black_escrow ?? "";
          const whiteDep = data.whiteDeposit ?? data.white_deposit ?? 0;
          const blackDep = data.blackDeposit ?? data.black_deposit ?? 0;

          const whiteExtraRefunded =
            data.whiteExtraRefunded ??
            data.white_extra_refunded ??
            false;
          const whiteExtraAmount =
            data.whiteExtraAmount ?? data.white_extra_amount ?? 0;
          const blackExtraRefunded =
            data.blackExtraRefunded ??
            data.black_extra_refunded ??
            false;
          const blackExtraAmount =
            data.blackExtraAmount ?? data.black_extra_amount ?? 0;

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
            setPepInfoMessage(
              "Both deposits confirmed – you can start the game."
            );
          } else if (data.status === "settled") {
            setPepInfoMessage("Match settled on-chain.");
          }
        }
      } catch (_err) {
        // ignore temporary network errors
      }
    };

    poll();
    const intervalId = setInterval(poll, 5000);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [pepMatchId, pepStake]);

  const applyMove = (from, to, promotion) => {
    if (isGameStopped) return false;

    const moveObj = { from, to };
    if (promotion) moveObj.promotion = promotion;

    const move = game.move(moveObj);
    if (!move) return false; // illegal

    if (move.captured || move.promotion) {
      const updated = (prev) => {
        const copy = { ...prev };

        // --- 1. Handle capture ---
        if (move.captured) {
          const capturedType = move.captured; // e.g. 'p','n','b','r','q'
          copy[capturedType] = (copy[capturedType] || 0) + 1;
        }

        // --- 2. Handle promotion correctly ---
        if (move.promotion) {
          const promotedVal = PIECE_VALUES[move.promotion] || 0;
          const pawnVal = PIECE_VALUES["p"];
          const diff = promotedVal - pawnVal;

          if (diff > 0) {
            const promotedType = move.promotion;
            copy[promotedType] = (copy[promotedType] || 0) + 1;

            if (copy["p"] && copy["p"] > 0) {
              copy["p"] -= 1;
            }
          }
        }

        return copy;
      };

      if (move.color === "w") {
        setCapturedByWhite((prev) => updated(prev));
      } else {
        setCapturedByBlack((prev) => updated(prev));
      }
    }

    setPosition(game.fen());
    setSelectedSquare(null);
    setLegalSquares([]);
    setLastMove([from, to]);
    setPendingPromotion(null);
    syncMoves();

    // set / switch clocks
    if (!timerStarted) {
      setTimerStarted(true);
      setActiveColor(move.color === "w" ? "b" : "w");
    } else {
      setActiveColor(move.color === "w" ? "b" : "w");
    }

    // if game ended by checkmate/stalemate etc, stop the clocks
    if (game.isGameOver()) {
      setActiveColor(null);
      setTimerStarted(false);
    }

    updateStatus();
    return true;
  };

  // ---------- clicks / drags ----------

  const handleSquareClick = (square) => {
    if (pepBoardLocked) {
      setStatus(
        "PEP match active – both deposits must be confirmed before you can move."
      );
      return;
    }

    if (isGameStopped || flaggedSide || manualResult) return;
    if (pendingPromotion) return;

    if (selectedSquare === square) {
      setSelectedSquare(null);
      setLegalSquares([]);
      return;
    }

    if (selectedSquare) {
      const movesFromSelected = game.moves({
        square: selectedSquare,
        verbose: true,
      });
      const targetMove = movesFromSelected.find((m) => m.to === square);

      if (targetMove) {
        const isPromotion =
          targetMove.piece === "p" &&
          (targetMove.to[1] === "8" || targetMove.to[1] === "1");

        if (isPromotion) {
          setPendingPromotion({
            from: selectedSquare,
            to: square,
            color: game.turn(),
          });
          return;
        }

        applyMove(selectedSquare, square);
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

  const handlePieceDrop = (sourceSquare, targetSquare) => {
    if (pepBoardLocked) {
      setStatus(
        "PEP match active – both deposits must be confirmed before you can move."
      );
      return false;
    }

    if (isGameStopped || flaggedSide || manualResult) return false;
    if (pendingPromotion) return false;

    const movesFromSource = game.moves({
      square: sourceSquare,
      verbose: true,
    });
    const move = movesFromSource.find((m) => m.to === targetSquare);
    if (!move) return false;

    const isPromotion =
      move.piece === "p" && (move.to[1] === "8" || move.to[1] === "1");

    if (isPromotion) {
      setPendingPromotion({
        from: sourceSquare,
        to: targetSquare,
        color: game.turn(),
      });
      return false;
    }

    return applyMove(sourceSquare, targetSquare);
  };

  // ---------- promotion overlay ----------

  const onPromotionChoice = (role) => {
    if (!pendingPromotion) return;
    const { from, to } = pendingPromotion;
    applyMove(from, to, role);
  };

  const renderPromotionOverlay = () => {
    if (!pendingPromotion) return null;

    const { to, color } = pendingPromotion;

    const squareSize = boardWidth / 8;
    const discSize = squareSize * 0.9;

    const rank = parseInt(to[1], 10);
    const rankIndex = 8 - rank;

    const squareCenterY = rankIndex * squareSize + squareSize / 2;
    const left = boardWidth + squareSize * 0.15 - discSize / 2;

    return (
      <div
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 5,
          pointerEvents: "auto",
        }}
        onClick={() => setPendingPromotion(null)}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundColor: "rgba(0,0,0,0.55)",
          }}
        />

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
                onPromotionChoice(role);
              }}
            >
              <img
                src={imgSrc}
                alt={pieceKey}
                draggable={false}
                style={{
                  width: discSize * 0.7,
                  height: discSize * 0.7,
                  filter:
                    color === "w"
                      ? "drop-shadow(0 0 3px rgba(0,0,0,0.7))"
                      : "none",
                }}
              />
            </div>
          );
        })}
      </div>
    );
  };

  const promotionOverlay = renderPromotionOverlay();

  // ---------- material / captured pieces rows ----------

  const renderCapturedRow = (sideColor) => {
    const myMap = sideColor === "w" ? capturedByWhite : capturedByBlack;
    const oppMap = sideColor === "w" ? capturedByBlack : capturedByWhite;

    const icons = [];
    CAPTURE_ORDER.forEach((t) => {
      const count = myMap[t] || 0;
      for (let i = 0; i < count; i++) {
        const key = "w" + t.toUpperCase(); // always white-style icon
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
          <img
            key={`${key}-${idx}`}
            src={pieceImagePaths[key]}
            alt={key}
            className="captured-piece"
          />
        ))}
        {score > 0 && <span className="captured-score">+{score}</span>}
      </div>
    );
  };

  // ---------- resign / draw handlers ----------

  const handleResignClick = () => {
  if (isGameStopped) return;

  // No moves yet → treat as simple abort/reset, not a resignation
  if (!hasStarted) {
    resetGame();
    setStatus("Game aborted.");
    return;
  }

  // Game has started → go through normal resign confirmation flow
  setPendingAction("resign");
  };

  const handleDrawClick = () => {
    if (isGameStopped) return;
    setPendingAction("draw");
  };

  const confirmPendingAction = () => {
    if (isGameStopped || !pendingAction) return;

    if (pendingAction === "draw") {
      setManualResult({ type: "draw", winner: null });
      setActiveColor(null);
      setTimerStarted(false);
      setStatus("Game drawn by agreement.");
    } else if (pendingAction === "resign") {
      const turn = game.turn(); // side that resigns
      const winnerColor = turn === "w" ? "b" : "w";
      setManualResult({ type: "resign", winner: winnerColor });
      setActiveColor(null);
      setTimerStarted(false);
      const winnerName = winnerColor === "w" ? "White" : "Black";
      setStatus(`Resignation. ${winnerName} wins.`);
    }

    setPendingAction(null);
  };

  const cancelPendingAction = () => {
    setPendingAction(null);
  };

  // ---------- square styles ----------

  const customSquareStyles = {};

  if (lastMove) {
    const [from, to] = lastMove;
    [from, to].forEach((sq) => {
      customSquareStyles[sq] = {
        ...customSquareStyles[sq],
        boxShadow: "inset 0 0 0 9999px rgba(246, 246, 104, 0.35)",
      };
    });
  }

  if (selectedSquare) {
    customSquareStyles[selectedSquare] = {
      ...customSquareStyles[selectedSquare],
      boxShadow: "inset 0 0 0 3px rgba(120, 144, 255, 0.95)",
    };
  }

  legalSquares.forEach((sq) => {
    const piece = game.get(sq);
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

  if (checkSquare) {
    customSquareStyles[checkSquare] = {
      ...customSquareStyles[checkSquare],
      boxShadow:
        "inset 0 0 0 3px rgba(255, 80, 80, 0.95), inset 0 0 12px rgba(255, 80, 80, 0.9)",
    };
  }

  const gameEnded = isGameStopped;

  return (
    <div className="app-root">
      <h1 ref={titleRef} className="title">PEP Chess (Core Game)</h1>

      <div className="main-layout">
        <div className="board-wrapper">
          <div
            className="board-inner"
            style={{ width: boardWidth, position: "relative" }}
          >
            <Chessboard
              position={position}
              onPieceDrop={handlePieceDrop}
              onSquareClick={handleSquareClick}
              customSquareStyles={customSquareStyles}
              customDarkSquareStyle={{ backgroundColor: DARK_SQUARE }}
              customLightSquareStyle={{ backgroundColor: LIGHT_SQUARE }}
              customBoardStyle={{
                borderRadius: "4px",
                boxShadow: "0 12px 35px rgba(0,0,0,0.7)",
              }}
              arePiecesDraggable={
                !pendingPromotion && !gameEnded && !pepBoardLocked
              }
              boardWidth={boardWidth}
              animationDuration={200}
              customPieces={customPieces}
            />
            {promotionOverlay}
          </div>

          <div ref={bottomBarRef} className="bottom-bar">
            <span className="status-text">{status}</span>
            <button
              className="reset-btn"
              onClick={resetGame}
              disabled={!canReset}
              title={canReset ? "" : "Reset is disabled while a game is in progress"}
            >
              Reset Game
            </button>
          </div>
        </div>

        <div className="side-panel">
          {/* Black clock + captured row */}
          <div className="clock-block">
            <div
              className={
                "clock" +
                (activeColor === "b" && !gameEnded ? " clock-active" : "")
              }
            >
              <span className="clock-label">BLACK</span>
              <span className="clock-time">{formatTime(blackTime)}</span>
            </div>
            {renderCapturedRow("b")}
          </div>

          {/* Moves table */}
          <div className="moves-panel">
            <div className="moves-header">
              <span>#</span>
              <span>White</span>
              <span>Black</span>
            </div>
            <div className="moves-body">
              {moves.length === 0 && (
                <div className="moves-empty">No moves yet.</div>
              )}
              {moves.map((row) => (
                <div key={row.no} className="moves-row">
                  <span>{row.no}.</span>
                  <span>{row.white}</span>
                  <span>{row.black}</span>
                </div>
              ))}
            </div>
          </div>

          {/* White clock + captured row */}
          <div className="clock-block">
            <div
              className={
                "clock" +
                (activeColor === "w" && !gameEnded ? " clock-active" : "")
              }
            >
              <span className="clock-label">WHITE</span>
              <span className="clock-time">{formatTime(whiteTime)}</span>
            </div>
            {renderCapturedRow("w")}
          </div>

          {/* Draw / resign controls with confirm UI */}
          <div className="controls-row">
            {pendingAction ? (
              <>
                <button
                  className="control-btn control-btn-confirm"
                  onClick={confirmPendingAction}
                  disabled={gameEnded}
                >
                  ✓ {pendingAction === "draw" ? "Confirm draw" : "Confirm resign"}
                </button>
                <button
                  className="control-btn control-btn-cancel"
                  onClick={cancelPendingAction}
                  disabled={gameEnded}
                >
                  ✕ Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  className="control-btn"
                  onClick={handleDrawClick}
                  disabled={gameEnded}
                >
                  Draw
                </button>
                <button
                  className="control-btn control-btn-resign"
                  onClick={handleResignClick}
                  disabled={gameEnded}
                >
                  {hasStarted ? "Resign" : "Abort"}
                </button>
              </>
            )}
          </div>

          {/* PEP match controls */}
          <div className="pep-panel">
            <h2 className="pep-title">PEP Match (optional)</h2>
            <p className="pep-subtitle">
              Both players stake the same PEP amount, and the winner
              automatically receives the pot from escrow.
            </p>

            <div className="pep-field-row">
              <label className="pep-label">Stake (PEP) - Only send PEP from a wallet you control</label>
              <input
                className="pep-input"
                type="number"
                min="0"
                step="1"
                value={pepStake}
                onChange={(e) => {
                const value = e.target.value;
                if (value === "" || (/^\d*(\.\d{0,2})?$/.test(value))) {
                setPepStake(value)};
                /*disabled={isPepMatchLocked}*/
              }}
              disabled={isPepMatchLocked}
              />
            </div>

            <div className="pep-field-row">
              <label className="pep-label">White PEP payout address</label>
              <input
                className="pep-input"
                type="text"
                value={pepWhiteAddress}
                onChange={(e) => setPepWhiteAddress(e.target.value)}
                disabled={isPepMatchLocked}
              />
            </div>

            <div className="pep-field-row">
              <label className="pep-label">Black PEP payout address</label>
              <input
                className="pep-input"
                type="text"
                value={pepBlackAddress}
                onChange={(e) => setPepBlackAddress(e.target.value)}
                disabled={isPepMatchLocked}
              />
            </div>

            <button
              className="pep-button"
              onClick={createPepMatch}
              disabled={!canCreatePepMatch || pepMatchStatus === "creating"}
            >
              {pepPendingResetConfirm
                ? "Confirm PEP match (reset board)"
                : pepMatchId
                ? "Create new match"
                : "Create PEP match"}
            </button>

            <button
              className="pep-button pep-button-abort"
              onClick={abortPepMatch}
              disabled={!canAbortPepMatch}
            >
              Abort match & refund
            </button>

            {/* <div className="pep-escrow-block">
              <div className="pep-escrow-title">Escrow</div>

              <div className="pep-escrow-line">
                <span className="pep-escrow-side">White:</span>
                <span className="pep-escrow-address">
                  {pepWhiteEscrow || "—"}
                </span>
              </div>

              <div className="pep-escrow-line">
                <span className="pep-escrow-side">Black:</span>
                <span className="pep-escrow-address">
                  {pepBlackEscrow || "—"}
                </span>
              </div>
            </div> */}

              {/* Escrow addresses (with copy buttons) */}
              <div className="pep-address-row">
                <div className="pep-status-label">White escrow</div>
                <div className="pep-escrow-address-row">
                  <div className="pep-escrow-address">
                    {pepWhiteEscrow || "—"}
                  </div>
                  <button
                    type="button"
                    className="pep-copy-btn"
                    onClick={() => {
                      if (!pepWhiteEscrow) return;
                      navigator.clipboard.writeText(pepWhiteEscrow);
                      setCopiedWhiteEscrow(true);
                      setTimeout(() => setCopiedWhiteEscrow(false), 1500);
                    }}
                    disabled={!pepWhiteEscrow}
                  >
                    Copy
                  </button>
                  {copiedWhiteEscrow && (
                    <span className="pep-copy-msg">Copied!</span>
                  )}
                </div>
              </div>

              <div className="pep-address-row">
                <div className="pep-status-label">Black escrow</div>
                <div className="pep-escrow-address-row">
                  <div className="pep-escrow-address">
                    {pepBlackEscrow || "—"}
                  </div>
                  <button
                    type="button"
                    className="pep-copy-btn"
                    onClick={() => {
                      if (!pepBlackEscrow) return;
                      navigator.clipboard.writeText(pepBlackEscrow);
                      setCopiedBlackEscrow(true);
                      setTimeout(() => setCopiedBlackEscrow(false), 1500);
                    }}
                    disabled={!pepBlackEscrow}
                  >
                    Copy
                  </button>
                  {copiedBlackEscrow && (
                    <span className="pep-copy-msg">Copied!</span>
                  )}
                </div>
              </div>

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
                {pepMatchStatus === "waiting_for_deposits" &&
                  "Waiting for both deposits…"}
                {pepMatchStatus === "ready_to_play" && "Ready to play"}
                {pepMatchStatus === "settled" && "Settled on-chain"}
                {pepMatchStatus === "error" &&
                  "Error – check message below"}
                {pepMatchStatus !== "idle" &&
                  ![
                    "creating",
                    "waiting_for_deposits",
                    "ready_to_play",
                    "settled",
                    "error",
                  ].includes(pepMatchStatus) &&
                  pepMatchStatus}
              </span>
            </div>

            <div className="pep-status-line">
              Deposits: {pepConfirmedDeposits} / 2 confirmed
            </div>

            <div className="pep-deposit-status">
              <span
                className={
                  "pep-deposit-inline" + (whiteDepositOk ? " pep-deposit-ok" : "")
                }
              >
                <span className="pep-dot" />
                White {pepWhiteDeposit.toFixed(4)} PEP
              </span>

              <span
                className={
                  "pep-deposit-inline" + (blackDepositOk ? " pep-deposit-ok" : "")
                }
              >
                <span className="pep-dot" />
                Black {pepBlackDeposit.toFixed(4)} PEP
              </span>
            </div>

            {/* Over-deposit info, short lines */}
            {pepMatchStatus !== "settled" &&
              pepMatchStatus !== "aborted" && (
                <>
                  {pepWhiteDeposit > stakeNumber &&
                    !pepWhiteExtraRefunded && (
                      <div className="pep-warning-line">
                        White overpaid (stake {stakeNumber.toFixed(
                          4
                        )} PEP); extra will be refunded.
                      </div>
                    )}
                  {pepBlackDeposit > stakeNumber &&
                    !pepBlackExtraRefunded && (
                      <div className="pep-warning-line">
                        Black overpaid (stake {stakeNumber.toFixed(
                          4
                        )} PEP); extra will be refunded.
                      </div>
                    )}
                </>
              )}

            {/* Confirmation after refund */}
            {pepWhiteExtraRefunded && pepWhiteExtraAmount > 0 && (
              <div className="pep-info">
                Extra {pepWhiteExtraAmount.toFixed(4)} PEP refunded to
                White.
              </div>
            )}
            {pepBlackExtraRefunded && pepBlackExtraAmount > 0 && (
              <div className="pep-info">
                Extra {pepBlackExtraAmount.toFixed(4)} PEP refunded to
                Black.
              </div>
            )}

            {pepInfoMessage && (
              <div className="pep-info">
                {shortMessage(pepInfoMessage)}
              </div>
            )}
            {pepError && (
              <div className="pep-error">
                {shortMessage(pepError, "PEP match error.")}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
