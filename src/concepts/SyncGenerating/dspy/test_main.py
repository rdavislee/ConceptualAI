import json
import os
import subprocess
import sys
import unittest


class SyncGeneratingMainTests(unittest.TestCase):
    def test_main_handles_stub_generate(self):
        env = os.environ.copy()
        env["SYNCGEN_STUB"] = "1"
        payload = {"action": "generate", "payload": {"plan": {}, "conceptSpecs": "specs", "implementations": {}}}
        result = subprocess.run(
            [sys.executable, "main.py"],
            input=json.dumps(payload),
            text=True,
            capture_output=True,
            env=env,
        )
        self.assertEqual(result.returncode, 0)
        data = json.loads(result.stdout.strip())
        self.assertIn("apiDefinition", data)


if __name__ == "__main__":
    unittest.main()
