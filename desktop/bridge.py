"""Pont WSGI local pour Electron.

Le processus ne crée aucun socket et n'écoute sur aucun port. Electron lui
transmet les requêtes de son protocole interne par stdin/stdout.
"""

import argparse
import base64
import importlib.util
import json
import os
import sys
import traceback
from contextlib import ExitStack


def resource_root():
    return getattr(sys, "_MEIPASS", os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", default=resource_root())
    args = parser.parse_args()
    source_root = os.path.abspath(args.source_root)
    os.chdir(source_root)
    sys.path.insert(0, os.path.join(source_root, "requirements"))
    sys.path.insert(0, os.path.join(source_root, "requirements", "openpyxl"))
    sys.path.insert(0, os.path.join(source_root, "can_server"))
    # Le module racine app.py doit rester prioritaire sur can_server/app.py.
    sys.path.insert(0, source_root)

    from werkzeug.test import Client
    from werkzeug.wrappers import Response

    app_path = os.path.join(source_root, "app.py")
    app_spec = importlib.util.spec_from_file_location("engineering_root_app", app_path)
    engineering_app = importlib.util.module_from_spec(app_spec)
    app_spec.loader.exec_module(engineering_app)

    engineering_app.app.config["CAN_SERVER_URL"] = "/analyse_logs"
    client = Client(engineering_app.app.wsgi_app, Response, use_cookies=True)

    for line in sys.stdin:
        request_id = None
        try:
            command = json.loads(line)
            request_id = command.get("id")
            headers = {
                key: value
                for key, value in (command.get("headers") or {}).items()
                if key.lower() not in {"host", "content-length", "connection"}
            }
            payload = base64.b64decode(command.get("body") or "")
            if command.get('operation') == 'shutdown':
                module = engineering_app.can_server_module
                try:
                    if module.active_measurement.get('status') == 'running':
                        status = module.esp32_request('POST', '/api/acquisition/stop', {'sensor':'ALL'})
                        module.reconcile_active_measurement(status)
                except Exception:
                    pass
                module.can_collector.stop()
                if module.active_measurement.get('acquisition_mode') == 'digital':
                    module.active_measurement['status'] = 'stopped'
                    module.synchronize_digital_samples(module.active_measurement)
                    module.save_measurement_session(dict(module.active_measurement))
                from digital_excel import finish_exports
                finish_exports()
                response = Response('{"status":"saved"}', mimetype='application/json')
            elif command.get('operation') == 'import-can-files':
                # Native desktop import: stream files from disk rather than
                # duplicating multi-gigabyte multipart bodies in JS/base64/JSON.
                from werkzeug.datastructures import FileStorage
                paths = command.get('paths') or []
                if not paths or any(not os.path.isabs(p) or not p.lower().endswith('.asc') for p in paths):
                    raise ValueError('Fichiers ASC locaux invalides.')
                module = engineering_app.can_server_module
                with ExitStack() as stack, module.app.test_request_context('/api/upload_and_ingest_measures', method='POST', environ_overrides={'SCRIPT_NAME': '/analyse_logs'}):
                    files = [FileStorage(stream=stack.enter_context(open(p, 'rb')), filename=os.path.basename(p)) for p in paths]
                    response = module.app.make_response(module.upload_and_ingest_measures(files))
            else:
                response = client.open(
                    command.get("path") or "/",
                    method=command.get("method") or "GET",
                    headers=headers,
                    data=payload,
                    follow_redirects=False,
                )
            result = {
                "id": request_id,
                "ok": True,
                "status": response.status_code,
                "headers": list(response.headers.items()),
                "body": base64.b64encode(response.get_data()).decode("ascii"),
            }
        except Exception as error:
            result = {
                "id": request_id,
                "ok": False,
                "status": 500,
                "headers": [["Content-Type", "application/json; charset=utf-8"]],
                "body": base64.b64encode(
                    json.dumps(
                        {"error": str(error), "trace": traceback.format_exc()},
                        ensure_ascii=False,
                    ).encode("utf-8")
                ).decode("ascii"),
            }
        sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
