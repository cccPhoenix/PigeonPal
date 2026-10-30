"""A local desktop service must be able to start without reverse DNS."""
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from local_service import LocalServer, handler_for


class LoopbackServerTests(unittest.TestCase):
    def test_binding_loopback_never_resolves_a_hostname(self):
        with patch('socket.getfqdn', side_effect=AssertionError('Unexpected reverse DNS')):
            server = LocalServer(('127.0.0.1', 0), handler_for(None))
            try:
                self.assertEqual(server.server_name, '127.0.0.1')
                self.assertEqual(server.server_port, server.server_address[1])
                self.assertGreater(server.server_port, 0)
            finally:
                server.server_close()
