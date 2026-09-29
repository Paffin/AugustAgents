"""Stand-in for the laya package in tests. LAYA_FAKE=exact|choice picks the reply shape."""
import os


class _Agent:
    def predict(self, inputs, questions):
        (qid, q), = questions.items()
        keys = list(q["criteria"])
        # Prefer the option whose key appears in the state.
        pick = next((k for k in keys if k in inputs["state"]), keys[-1])
        if os.environ.get("LAYA_FAKE") == "choice":
            return {"answers": {qid: {"choice": pick}}}
        probs = {k: (0.9 if k == pick else 0.1 / (len(keys) - 1)) for k in keys}
        return {"answers": {qid: {"choice": pick, "probs": probs}}}


def load(model_id):
    return _Agent()
