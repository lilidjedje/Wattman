"""The Pi service must finish a test without an open PC page or polling."""
import json
import base64
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError


class RecorderServiceTest(unittest.TestCase):
    def test_finishes_without_a_client_and_marks_previous_reboot_interrupted(self):
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as folder:
            data = Path(folder) / 'can_data'
            data.mkdir()
            sessions = data / 'measurement_sessions.json'
            sessions.write_text(json.dumps([{'id': 'old', 'status': 'running'}]))
            env = {**os.environ, 'ENGINEERING_APP_DATA': folder, 'ESP32_SIMULATOR': '1',
                   'WATTMAN_BIND': '127.0.0.1', 'WATTMAN_PORT': '0', 'PYTHONUNBUFFERED': '1'}
            with tempfile.TemporaryFile() as errors:
                process = subprocess.Popen([sys.executable, 'desktop/recorder.py'], cwd=root,
                                           env=env, stdout=subprocess.PIPE, stderr=errors)
                try:
                    lines = queue.Queue()
                    threading.Thread(target=lambda: lines.put(process.stdout.readline()), daemon=True).start()
                    line = lines.get(timeout=30).decode()
                    self.assertIn('Wattman recorder port', line)
                    base = f"http://127.0.0.1:{int(line.split()[-1])}/analyse_logs"
                    self.assertEqual(json.loads(sessions.read_text())[0]['status'], 'incomplete')
                    form = urlencode({'acquisition_mode': 'digital', 'freq': 1,
                                      'dureeValeur': 3, 'dureeUnite': 's'}).encode()
                    # Start through the same bridge as Electron, then close it.
                    commands = [dict(id=1, path='/analyse_logs/api/control_esp_acquisition',
                                     method='POST', body=base64.b64encode(form).decode(),
                                     headers={'Content-Type': 'application/x-www-form-urlencoded'}),
                                dict(id=2, operation='shutdown')]
                    bridge = subprocess.run([sys.executable, 'desktop/bridge.py', '--source-root', str(root)],
                        cwd=root, env={**env, 'WATTMAN_RECORDER_URL': base.removesuffix('/analyse_logs')},
                        input=''.join(json.dumps(c) + '\n' for c in commands), text=True,
                        capture_output=True, timeout=20, check=True)
                    replies = [json.loads(line) for line in bridge.stdout.splitlines()]
                    self.assertEqual([r['status'] for r in replies], [200, 200])
                    session_id = json.loads(base64.b64decode(replies[0]['body']))['session']['id']
                    with self.assertRaises(HTTPError) as busy:
                        urlopen(Request(base + '/api/control_esp_acquisition', data=form), timeout=10)
                    self.assertEqual(busy.exception.code, 409)
                    busy.exception.close()
                    # No status requests: only the permanent service watches completion.
                    deadline = time.monotonic() + 15
                    result = {}
                    while time.monotonic() < deadline:
                        result = next(s for s in json.loads(sessions.read_text()) if s['id'] == session_id)
                        if result['status'] != 'running':
                            break
                        time.sleep(.1)
                    self.assertEqual(result['status'], 'completed')
                    self.assertTrue(result['autonomous_recorder'])
                finally:
                    process.terminate()
                    process.wait(timeout=10)
                    process.stdout.close()


if __name__ == '__main__':
    unittest.main()
