from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uuid

from rpc import pep_rpc

app = FastAPI()

# Allow your React dev server to call this API
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],      # for dev; lock this down later
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class CreateMatchRequest(BaseModel):
    stake: float
    white_address: str
    black_address: str


class ReportResultRequest(BaseModel):
    # "white", "black", "draw"
    result: str


# In-memory store (fine for now; lost on restart)
matches: dict[str, dict] = {}


@app.post("/api/matches")
def create_match(req: CreateMatchRequest):
    if req.stake <= 0:
        raise HTTPException(400, "Stake must be positive.")
    if not req.white_address or not req.black_address:
        raise HTTPException(400, "Both payout addresses are required.")

    match_id = str(uuid.uuid4())

    # One escrow address per player
    try:
        white_escrow = pep_rpc("getnewaddress", ["pepchess_white"])
        black_escrow = pep_rpc("getnewaddress", ["pepchess_black"])
    except Exception as exc:
        raise HTTPException(
            500,
            f"PEP RPC error while creating escrow addresses: {exc}",
        )

    matches[match_id] = {
        "id": match_id,
        "stake": float(req.stake),
        "white_address": req.white_address,
        "black_address": req.black_address,
        "white_escrow": white_escrow,
        "black_escrow": black_escrow,
        "white_deposit": 0.0,
        "black_deposit": 0.0,
        "status": "waiting_for_deposits",
        "result": None,
        "tx_ids": [],
        # cumulative amount of "extra above stake" already refunded
        "white_extra_amount": 0.0,
        "black_extra_amount": 0.0,
        "confirmed_deposits": 0,
    }


    return {
        "matchId": match_id,
        "stake": float(req.stake),
        "status": "waiting_for_deposits",
        "whiteEscrow": white_escrow,
        "blackEscrow": black_escrow,
        "whiteDeposit": 0.0,
        "blackDeposit": 0.0,
    }


@app.get("/api/matches/{match_id}")
def get_match(match_id: str):
    """
    Poll match:
      * Updates deposits from node
      * Incrementally refunds any extra above stake back to each player
      * Updates confirmed deposit count and status
    """
    m = matches.get(match_id)
    if not m:
        raise HTTPException(404, "Match not found.")

    if m["status"] in ("waiting_for_deposits", "ready_to_play"):
        try:
            stake = float(m["stake"])
            white_dep_total = float(
                pep_rpc("getreceivedbyaddress", [m["white_escrow"], 1])
            )
            black_dep_total = float(
                pep_rpc("getreceivedbyaddress", [m["black_escrow"], 1])
            )

            m["white_deposit"] = white_dep_total
            m["black_deposit"] = black_dep_total

            # === Check for under-deposits (too little sent) ===
            under_msgs = []
            if white_dep_total > 1e-8 and white_dep_total < stake:
                deficit = round(stake - white_dep_total, 4)
                under_msgs.append(
                    f"White has deposited too little ({white_dep_total:.4f} PEP) — please send an additional {deficit:.4f} PEP to start the match."
                )
            if black_dep_total > 1e-8 and black_dep_total < stake:
                deficit = round(stake - black_dep_total, 4)
                under_msgs.append(
                    f"Black has deposited too little ({black_dep_total:.4f} PEP) — please send an additional {deficit:.4f} PEP to start the match."
                )

            # === Incremental refund of any extra above the stake ===
            # total extra that *should* have gone back so far
            extra_w_total = max(0.0, white_dep_total - stake)
            extra_b_total = max(0.0, black_dep_total - stake)

            # how much we've already refunded in earlier polls
            already_w = float(m.get("white_extra_amount", 0.0))
            already_b = float(m.get("black_extra_amount", 0.0))

            # only send the difference so we never under/over-refund
            to_refund_w = max(0.0, extra_w_total - already_w)
            to_refund_b = max(0.0, extra_b_total - already_b)

            if to_refund_w > 1e-8:
                pep_rpc("sendtoaddress", [m["white_address"], to_refund_w])
                m["white_extra_amount"] = already_w + to_refund_w

            if to_refund_b > 1e-8:
                pep_rpc("sendtoaddress", [m["black_address"], to_refund_b])
                m["black_extra_amount"] = already_b + to_refund_b

            # Effective deposit used for the stake pot
            white_eff = min(white_dep_total, stake)
            black_eff = min(black_dep_total, stake)

            confirmed = 0
            if white_eff >= stake:
                confirmed += 1
            if black_eff >= stake:
                confirmed += 1
            m["confirmed_deposits"] = confirmed

            if confirmed == 2:
                m["status"] = "ready_to_play"
            else:
                m["status"] = "waiting_for_deposits"

        except Exception:
            # Node might be offline; keep last known values
            pass

    return {
        "matchId": m["id"],
        "stake": m["stake"],
        "status": m["status"],
        "whiteAddress": m["white_address"],
        "blackAddress": m["black_address"],
        "whiteEscrow": m["white_escrow"],
        "blackEscrow": m["black_escrow"],
        "whiteDeposit": m.get("white_deposit", 0.0),
        "blackDeposit": m.get("black_deposit", 0.0),
        # front-end flags
        "whiteExtraRefunded": m.get("white_extra_amount", 0.0) > 0.0,
        "whiteExtraAmount": m.get("white_extra_amount", 0.0),
        "blackExtraRefunded": m.get("black_extra_amount", 0.0) > 0.0,
        "blackExtraAmount": m.get("black_extra_amount", 0.0),
        "confirmedDeposits": m.get("confirmed_deposits", 0),
        "txIds": m.get("tx_ids", []),
        "result": m.get("result"),
        "underDepositMessage": " ".join(under_msgs),
    }


@app.post("/api/matches/{match_id}/abort")
def abort_match(match_id: str):
    """
    Abort a match and refund up to the stake amount for each side.
    Any extra above the stake has already been auto-refunded when
    the deposit was detected.
    """
    m = matches.get(match_id)
    if not m:
        raise HTTPException(404, "Match not found.")

    if m["status"] in ("settled", "aborted"):
        raise HTTPException(400, "Match already settled or aborted.")

    stake = float(m["stake"])

    try:
        white_dep_total = float(
            pep_rpc("getreceivedbyaddress", [m["white_escrow"], 1])
        )
        black_dep_total = float(
            pep_rpc("getreceivedbyaddress", [m["black_escrow"], 1])
        )
    except Exception as exc:
        raise HTTPException(
            500, f"PEP RPC error while checking deposits: {exc}"
        )

    white_to_refund = min(white_dep_total, stake)
    black_to_refund = min(black_dep_total, stake)

    if white_to_refund <= 0 and black_to_refund <= 0:
        raise HTTPException(400, "No deposits to refund.")

    tx_ids: list[str] = []
    try:
        if white_to_refund > 0:
            tx_ids.append(
                pep_rpc("sendtoaddress", [m["white_address"], white_to_refund])
            )
        if black_to_refund > 0:
            tx_ids.append(
                pep_rpc("sendtoaddress", [m["black_address"], black_to_refund])
            )
    except Exception as exc:
        raise HTTPException(
            500, f"PEP RPC error while refunding: {exc}"
        )

    m["status"] = "aborted"
    m["result"] = "aborted"
    m["tx_ids"] = tx_ids
    m["white_deposit"] = white_dep_total
    m["black_deposit"] = black_dep_total

    return {
        "status": "aborted",
        "txIds": tx_ids,
        "whiteDeposit": white_dep_total,
        "blackDeposit": black_dep_total,
    }


@app.post("/api/matches/{match_id}/result")
def report_result(match_id: str, req: ReportResultRequest):
    """
    Finalise a match:

      - "white"/"black":
          winner gets up to 2 * stake (stake from each side).

      - "draw":
          each side gets back up to the stake they contributed.

    Any amount above the stake has already been auto-refunded at
    deposit time by get_match().
    """
    m = matches.get(match_id)
    if not m:
        raise HTTPException(404, "Match not found.")

    if m["status"] in ("settled", "aborted"):
        raise HTTPException(400, "Match already settled or aborted.")

    result = req.result
    if result not in ("white", "black", "draw"):
        raise HTTPException(
            400, "Invalid result; must be 'white', 'black' or 'draw'."
        )

    # Refresh deposits one last time
    try:
        white_dep_total = float(
            pep_rpc("getreceivedbyaddress", [m["white_escrow"], 1])
        )
        black_dep_total = float(
            pep_rpc("getreceivedbyaddress", [m["black_escrow"], 1])
        )
    except Exception as exc:
        raise HTTPException(
            500, f"PEP RPC error while checking deposits: {exc}"
        )

    m["white_deposit"] = white_dep_total
    m["black_deposit"] = black_dep_total

    stake = float(m["stake"])
    tx_ids: list[str] = []

    # effective stake contribution from each side (cap at stake)
    used_from_white = min(white_dep_total, stake)
    used_from_black = min(black_dep_total, stake)
    pot = used_from_white + used_from_black  # normally 2 * stake

    try:
        if result == "draw":
            # Draw: each side gets back up to stake they put in.
            if used_from_white > 0:
                tx_ids.append(
                    pep_rpc(
                        "sendtoaddress", [m["white_address"], used_from_white]
                    )
                )
            if used_from_black > 0:
                tx_ids.append(
                    pep_rpc(
                        "sendtoaddress", [m["black_address"], used_from_black]
                    )
                )
        else:
            # Winner case
            winner_addr = (
                m["white_address"] if result == "white" else m["black_address"]
            )
            if pot > 0:
                tx_ids.append(
                    pep_rpc("sendtoaddress", [winner_addr, pot])
                )

    except Exception as exc:
        raise HTTPException(
            500, f"PEP RPC error while sending payout/refunds: {exc}"
        )

    m["status"] = "settled"
    m["result"] = result
    m["tx_ids"] = tx_ids

    return {
        "status": "settled",
        "result": result,
        "txIds": tx_ids,
        "whiteDeposit": white_dep_total,
        "blackDeposit": black_dep_total,
    }
