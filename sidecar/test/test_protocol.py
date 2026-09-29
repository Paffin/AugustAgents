"""Safety/protocol regression only; the fake adapter does not qualify a model."""
import importlib.util
import json
from pathlib import Path
import threading
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("laya_server", ROOT / "laya_server.py")
server_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server_module)
spec = importlib.util.spec_from_file_location("fake_laya", ROOT / "test/fake/laya.py")
fake = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fake)


class ProtocolTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), server_module.make_handler(fake.load("fixture")))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def request(self, body, headers=None):
        connection = HTTPConnection(*self.server.server_address, timeout=3)
        try:
            connection.request("POST", "/predict", json.dumps(body), headers or {})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_choice_protocol(self):
        payload = {"state": "fs.read notes", "question": {"id": "tool", "instructions": "choose",
                   "options": [{"key": "fs.read", "description": "read"}, {"key": "none", "description": "finish"}]}}
        status, result = self.request(payload)
        self.assertEqual(status, 200)
        self.assertTrue(result["exact"])
        self.assertAlmostEqual(result["probs"]["fs.read"], 0.9)

    def test_browser_origin_is_rejected_before_inference(self):
        self.assertEqual(self.request({}, {"Origin": "https://untrusted.invalid"})[0], 403)

    def test_invalid_question_is_rejected(self):
        self.assertEqual(self.request({"state": "private", "question": {}})[0], 400)


if __name__ == "__main__":
    unittest.main()
