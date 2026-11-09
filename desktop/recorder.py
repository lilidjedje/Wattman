"""Permanent Raspberry Pi recorder; the PC is only an HTTP client."""
import os
import threading
import time

os.environ['WATTMAN_AUTONOMOUS_RECORDER'] = '1'

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app as root_app
root_app.app.config['CAN_SERVER_URL'] = '/analyse_logs'
from werkzeug.serving import make_server

module = root_app.can_server_module


def monitor():
    while True:
        try:
            with module.measurement_control_lock:
                if module.active_measurement.get('status') == 'running':
                    status = module.esp32_request('GET', '/api/acquisition/status')
                    module.reconcile_active_measurement(status)
                    if module.active_measurement.get('status') == 'running':
                        state = module.can_collector.state()
                        if not state.get('running'):
                            module.active_measurement['recording_error'] = (
                                'Le flux du collecteur est interrompu. Des données peuvent manquer.')
                        module.save_measurement_session(dict(module.active_measurement))
        except Exception as error:
            # Keep the last running state: unreachable does not mean completed.
            print(f'Recorder monitor: {error}', file=sys.stderr, flush=True)
        time.sleep(2)


def main():
    module.init_db()
    # A Pi reboot is a recording interruption, never a successful completion.
    for session in module.measurement_sessions():
        if session.get('status') == 'running':
            session.update(status='incomplete', recording_error=
                           'Collecteur redémarré : continuité non garantie.')
            module.save_measurement_session(session)
    threading.Thread(target=monitor, daemon=True, name='recorder-monitor').start()
    server = make_server(os.environ.get('WATTMAN_BIND', '0.0.0.0'),
                         int(os.environ.get('WATTMAN_PORT', '8080')),
                         root_app.app, threaded=True)
    print(f'Wattman recorder port {server.server_port}', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
