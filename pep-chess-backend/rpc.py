import json
import requests

# === PEP RPC SETTINGS (hard-coded) ===
# These must match your pepecoin.conf
RPC_URL = "http://127.0.0.1:22555"  # default local PEP node port

RPC_USER = "jkam28"            # <-- choose a username
RPC_PASSWORD = "F4p3P_9r1uE4k1wq3G7zA9mJ2xN5sL8" 


def pep_rpc(method, params=None):
    """
    Call the local Pepecoin JSON-RPC node.
    """
    payload = {
        "jsonrpc": "1.0",
        "id": "pep-chess",
        "method": method,
        "params": params or [],
    }
    resp = requests.post(
        RPC_URL,
        auth=(RPC_USER, RPC_PASSWORD),
        data=json.dumps(payload),
    )
    resp.raise_for_status()
    data = resp.json()
    if data.get("error"):
        raise RuntimeError(data["error"])
    return data["result"]
