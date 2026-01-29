import json
import os
import unittest

from sync_generator import SyncGenerator


class SyncGeneratorTests(unittest.TestCase):
    def setUp(self):
        os.environ["SYNCGEN_STUB"] = "1"

    def tearDown(self):
        os.environ.pop("SYNCGEN_STUB", None)

    def test_stub_generate_returns_shape(self):
        generator = SyncGenerator()
        result = generator.generate({"plan": {}, "conceptSpecs": "specs", "implementations": {}})
        self.assertIn("syncs", result)
        self.assertIn("apiDefinition", result)
        self.assertIn("endpointBundles", result)
        self.assertEqual(result["apiDefinition"]["format"], "openapi")
        self.assertEqual(result["apiDefinition"]["encoding"], "yaml")

    def test_missing_payload_fields(self):
        os.environ.pop("SYNCGEN_STUB", None)
        generator = SyncGenerator()
        result = generator.generate({"plan": {}})
        self.assertIn("error", result)


if __name__ == "__main__":
    unittest.main()
