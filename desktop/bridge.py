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
