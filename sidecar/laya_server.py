"""Laya decision sidecar for August.

Runs Laya Multilingual locally and answers `choice` questions over HTTP on
127.0.0.1. Standard library only, apart from the `laya` package itself:

    pip install laya
    python sidecar/laya_server.py --port 7788

Protocol (the only one the agent speaks):

    POST /predict
    {"state": "...", "question": {"id": "tool-choice", "instructions": "...",
                                  "options": [{"key": "fs.read", "description": "..."}]}}
    -> {"probs": {"fs.read": 0.8, "none": 0.2}, "exact": true}

`exact` is false when the installed laya version only reports the winning
option; the agent then treats the confidence as unknown and lets the LLM decide.
"""

import argparse
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL_ID = "convaiinnovations/laya-multilingual"
MAX_BODY = 256 * 1024
PROB_KEYS = ("probs", "probabilities", "scores", "distribution")


def to_laya(question):
    """Our question -> laya's typed question. The state is passed as input field `state`."""
    return {
        question["id"]: {
            "type": "choice",
            "instructions": f"{question['instructions']} Read `state`.",
            "criteria": {o["key"]: o["description"] for o in question["options"]},
        }
    }


def from_laya(result, question):
    keys = [o["key"] for o in question["options"]]
    answer = result["answers"][question["id"]]
    for name in PROB_KEYS:
        dist = answer.get(name) if isinstance(answer, dict) else None
        if isinstance(dist, dict) and all(k in dist for k in keys):
            return {"probs": {k: float(dist[k]) for k in keys}, "exact": True}
    choice = answer["choice"] if isinstance(answer, dict) else answer
    return {"probs": {k: (1.0 if k == choice else 0.0) for k in keys}, "exact": False}


def validate(payload):
    if not isinstance(payload, dict):
        raise ValueError("body must be an object")
    state, q = payload.get("state"), payload.get("question")
    if not isinstance(state, str) or not isinstance(q, dict):
        raise ValueError("state and question are required")
    opts = q.get("options")
    if not isinstance(q.get("id"), str) or not isinstance(q.get("instructions"), str) or not isinstance(opts, list):
        raise ValueError("question needs id, instructions and options")
    if not 2 <= len(opts) <= 16:
        raise ValueError("2 to 16 options")
    for o in opts:
        if not isinstance(o, dict) or not isinstance(o.get("key"), str) or not isinstance(o.get("description"), str):
            raise ValueError("each option needs key and description")
    return state, q


def make_handler(agent):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):  # never log request bodies: they hold private text
            pass

        def reply(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == "/health":
                return self.reply(200, {"ok": True, "model": MODEL_ID})
            self.reply(404, {"error": "not found"})

        def do_POST(self):
            if self.path != "/predict":
                return self.reply(404, {"error": "not found"})
            # Browsers send Origin; a page on another site must not reach the model.
            if self.headers.get("origin"):
                return self.reply(403, {"error": "origin not allowed"})
            length = int(self.headers.get("content-length") or 0)
            if length <= 0 or length > MAX_BODY:
                return self.reply(413, {"error": "bad body size"})
            try:
                state, q = validate(json.loads(self.rfile.read(length)))
            except (ValueError, json.JSONDecodeError) as e:
                return self.reply(400, {"error": str(e)})
            try:
                result = agent.predict({"state": state}, to_laya(q))
                return self.reply(200, from_laya(result, q))
            except Exception as e:  # noqa: BLE001 - report the kind, not the content
                return self.reply(500, {"error": type(e).__name__})

    return Handler


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=7788)
    parser.add_argument("--model", default=MODEL_ID)
    args = parser.parse_args(argv)
    try:
        import laya  # noqa: PLC0415
    except ImportError:
        print("The laya package is not installed: pip install laya", file=sys.stderr)
        return 1
    agent = laya.load(args.model)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(agent))
    print(f"Laya sidecar on http://127.0.0.1:{args.port}", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
