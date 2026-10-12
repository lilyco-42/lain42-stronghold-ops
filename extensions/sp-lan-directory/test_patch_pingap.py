#!/usr/bin/env python3
"""Contract test for the HTTPS path rewriting and patch idempotency."""
import importlib.util
from pathlib import Path
import tomllib
import unittest

path = Path(__file__).with_name("patch-pingap.py")
spec = importlib.util.spec_from_file_location("sp_lan_route_patch", path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

SAMPLE = """
[basic]
name = "dev"
[servers.https]
addr = "0.0.0.0:443"
locations = [
    "another",
    "sp",
]
[locations.sp]
host = "sp.lain42.top"
path = "/"
upstream = "game"
[locations.another]
path = "/other"
upstream = "game"
[upstreams.game]
addrs = ["127.0.0.1:3000"]
"""

# The state of /etc/pingap.toml after the bot route was applied, plus our route.
SAMPLE_WITH_BOT = SAMPLE.replace('    "another",\n', '    "another",\n    "sp_room_bot",\n')


class PatchTests(unittest.TestCase):
    def test_route_rewrite_and_ordering(self):
        patched = mod.patch(SAMPLE)
        cfg = tomllib.loads(patched)
        loc = cfg["locations"]["sp_lan_directory"]
        assert loc["path"] == "/api/lan/v1/"
        assert loc["rewrite"] == "^/api/lan/v1/(.*)$ /v1/$1"
        assert loc["upstream"] == "sp_lan_directory_backend"
        assert cfg["upstreams"]["sp_lan_directory_backend"]["addrs"] == ["127.0.0.1:5188"]
        locations = cfg["servers"]["https"]["locations"]
        assert locations.index("sp_lan_directory") < locations.index("sp")
        self.assertEqual(mod.patch(patched), patched)

    def test_coexists_with_the_bot_route(self):
        patched = mod.patch(SAMPLE_WITH_BOT)
        locations = tomllib.loads(patched)["servers"]["https"]["locations"]
        assert locations.index("sp_room_bot") < locations.index("sp_lan_directory") < locations.index("sp")

    def test_rejects_conflicting_rewrite(self):
        cfg = mod.patch(SAMPLE).replace('rewrite = "^/api/lan/v1/(.*)$ /v1/$1"', 'rewrite = "^/wrong$ /v1"')
        with self.assertRaises(ValueError):
            mod.patch(cfg)


if __name__ == "__main__":
    unittest.main()
