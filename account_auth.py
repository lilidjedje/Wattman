import os
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone

from flask import g, jsonify, redirect, request, session
from werkzeug.security import check_password_hash, generate_password_hash


ADMIN_EMAIL = "lilicontact07@gmail.com"
SESSION_DAYS = 30


def configure_auth(app, data_directory):
    os.makedirs(data_directory, exist_ok=True)
    database_path = os.path.join(data_directory, "accounts.sqlite3")
    secret_path = os.path.join(data_directory, "session-secret")
    if not os.path.exists(secret_path):
        try:
            with open(secret_path, "xb") as secret_file:
                secret_file.write(secrets.token_bytes(32))
        except FileExistsError:
            pass
    with open(secret_path, "rb") as secret_file:
        secret_key = secret_file.read()
    if len(secret_key) != 32:
        raise RuntimeError("La clé de session locale est invalide.")

    app.secret_key = secret_key
    app.config.update(
        PERMANENT_SESSION_LIFETIME=timedelta(days=SESSION_DAYS),
        SESSION_COOKIE_NAME="wattman_session",
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        SESSION_COOKIE_SECURE=False,
        SESSION_REFRESH_EACH_REQUEST=False,
    )
    app.extensions["account_database_path"] = database_path
    initialize_account_database(database_path)


def account_connection(app=None):
    from flask import current_app

    owner = app or current_app
    connection = sqlite3.connect(owner.extensions["account_database_path"], timeout=10)
    connection.row_factory = sqlite3.Row
    return connection


def initialize_account_database(database_path):
    connection = sqlite3.connect(database_path, timeout=10)
    try:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS accounts (
                id TEXT PRIMARY KEY,
                email TEXT NOT NULL UNIQUE COLLATE NOCASE,
                first_name TEXT NOT NULL,
                last_name TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
                active INTEGER NOT NULL DEFAULT 1,
                auth_version INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );
            DROP TABLE IF EXISTS password_resets;
            """
        )
        connection.commit()
    finally:
        connection.close()


def normalize_email(email):
    return str(email or "").strip().lower()


def email_is_valid(email):
    if len(email) > 254 or email.count("@") != 1 or any(char.isspace() for char in email):
        return False
    local, domain = email.split("@")
    return bool(local and "." in domain and not domain.startswith(".") and not domain.endswith("."))


def account_count(app=None):
    connection = account_connection(app)
    try:
        return connection.execute("SELECT COUNT(*) FROM accounts").fetchone()[0]
    finally:
        connection.close()


def account_by_email(email, app=None):
    connection = account_connection(app)
    try:
        row = connection.execute(
            "SELECT * FROM accounts WHERE email = ? COLLATE NOCASE",
            (normalize_email(email),),
        ).fetchone()
        return dict(row) if row else None
    finally:
        connection.close()


def account_by_id(account_id, app=None):
    connection = account_connection(app)
    try:
        row = connection.execute("SELECT * FROM accounts WHERE id = ?", (account_id,)).fetchone()
        return dict(row) if row else None
    finally:
        connection.close()


def public_account(account):
    return {
        "id": account["id"],
        "email": account["email"],
        "firstName": account["first_name"],
        "lastName": account["last_name"],
        "role": account["role"],
        "active": bool(account["active"]),
        "createdAt": account["created_at"],
    }


def create_account(email, first_name, last_name, password, role="user", app=None):
    account_id = secrets.token_hex(16)
    created_at = datetime.now(timezone.utc).isoformat()
    connection = account_connection(app)
    try:
        connection.execute(
            """INSERT INTO accounts
               (id, email, first_name, last_name, password_hash, role, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                account_id,
                normalize_email(email),
                first_name.strip(),
                last_name.strip(),
                generate_password_hash(password),
                role,
                created_at,
            ),
        )
        connection.commit()
    finally:
        connection.close()
    return account_by_id(account_id, app)


def authenticate_account(email, password, app=None):
    account = account_by_email(email, app)
    if not account or not account["active"] or not check_password_hash(account["password_hash"], password):
        return None
    return account


def current_account(app=None):
    account_id = session.get("account_id")
    if not account_id:
        return None
    account = account_by_id(account_id, app)
    if (
        not account
        or not account["active"]
        or session.get("auth_version") != account["auth_version"]
    ):
        session.clear()
        return None
    return account


def begin_account_session(account, remember_me=True):
    session.clear()
    session.permanent = remember_me
    session["account_id"] = account["id"]
    session["auth_version"] = account["auth_version"]


def register_auth_guard(app):
    @app.before_request
    def require_account():
        if (
            request.endpoint == "static"
            or request.path == "/auth"
            or request.path.startswith("/api/auth/")
        ):
            return None

        account = current_account(app)
        if account:
            g.account = account
            return None

        if request.path.startswith("/api/"):
            return jsonify({"error": "Connectez-vous pour continuer."}), 401
        return redirect("/auth")


def set_account_password(account_id, password, app=None):
    connection = account_connection(app)
    try:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute(
            """UPDATE accounts
               SET password_hash = ?, auth_version = auth_version + 1
               WHERE id = ?""",
            (generate_password_hash(password), account_id),
        )
        if connection.execute("SELECT changes()").fetchone()[0] != 1:
            connection.rollback()
            return None
        connection.commit()
    finally:
        connection.close()
    return account_by_id(account_id, app)


def account_list(app=None):
    connection = account_connection(app)
    try:
        return [
            dict(row)
            for row in connection.execute(
                """SELECT id, email, first_name, last_name, role, active, created_at
                   FROM accounts ORDER BY created_at"""
            )
        ]
    finally:
        connection.close()


def set_account_role(account_id, role, app=None):
    connection = account_connection(app)
    try:
        connection.execute("BEGIN IMMEDIATE")
        current = connection.execute(
            "SELECT role, active FROM accounts WHERE id = ?",
            (account_id,),
        ).fetchone()
        if not current:
            connection.rollback()
            return False
        if current["role"] == "admin" and role == "user" and current["active"]:
            active_admins = connection.execute(
                "SELECT COUNT(*) FROM accounts WHERE role = 'admin' AND active = 1"
            ).fetchone()[0]
            if active_admins <= 1:
                connection.rollback()
                return False
        connection.execute("UPDATE accounts SET role = ? WHERE id = ?", (role, account_id))
        connection.commit()
        return True
    finally:
        connection.close()
