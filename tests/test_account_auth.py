import importlib
import os
import sqlite3
import tempfile
import unittest
from datetime import timedelta
from desktop.bridge import create_wsgi_client


_test_data = tempfile.TemporaryDirectory()
os.environ["ENGINEERING_APP_DATA"] = _test_data.name
app_module = importlib.import_module("app")
flask_app = app_module.app


class AccountAuthTests(unittest.TestCase):
    def setUp(self):
        connection = sqlite3.connect(flask_app.extensions["account_database_path"])
        connection.execute("DELETE FROM accounts")
        connection.commit()
        connection.close()
        self.client = flask_app.test_client()

    def setup_admin(self):
        response = self.client.post(
            "/api/auth/setup",
            json={
                "email": "lilicontact07@gmail.com",
                "firstName": "Lili",
                "lastName": "Admin",
                "password": "test-admin-password",
            },
        )
        self.assertEqual(response.status_code, 200, response.get_json())
        return response.get_json()["user"]

    def test_project_routes_require_login_until_initial_admin_is_created(self):
        auth_page = self.client.get("/auth")
        self.assertEqual(auth_page.status_code, 200)
        self.assertIn(b"lilicontact07@gmail.com", auth_page.data)
        response = self.client.get("/import_project")
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers["Location"], "/auth")
        self.assertEqual(self.client.get("/analyse_logs/").status_code, 302)
        self.assertEqual(self.client.get("/api/auth/me").get_json(), {"user": None})

        user = self.setup_admin()
        self.assertEqual(user["role"], "admin")
        self.assertEqual(self.client.get("/import_project").status_code, 200)
        self.assertEqual(self.client.get("/admin").status_code, 200)
        self.assertEqual(flask_app.config["PERMANENT_SESSION_LIFETIME"], timedelta(days=30))
        with self.client.session_transaction() as browser_session:
            self.assertTrue(browser_session.permanent)

        connection = sqlite3.connect(flask_app.extensions["account_database_path"])
        stored_hash = connection.execute(
            "SELECT password_hash FROM accounts WHERE email = ?",
            ("lilicontact07@gmail.com",),
        ).fetchone()[0]
        connection.close()
        self.assertNotEqual(stored_hash, "test-admin-password")
        self.assertEqual(self.client.get("/analyse_logs/").status_code, 200)

    def test_login_remember_me_controls_persistent_session_and_auth_redirect(self):
        self.setup_admin()

        remembered_client = flask_app.test_client()
        remembered_login = remembered_client.post(
            "/api/auth/login",
            json={
                "email": "lilicontact07@gmail.com",
                "password": "test-admin-password",
                "rememberMe": True,
            },
        )
        self.assertEqual(remembered_login.status_code, 200)
        with remembered_client.session_transaction() as browser_session:
            self.assertTrue(browser_session.permanent)
        auth_redirect = remembered_client.get("/auth")
        self.assertEqual(auth_redirect.status_code, 302)
        self.assertEqual(auth_redirect.headers["Location"], "/")

        temporary_client = flask_app.test_client()
        temporary_login = temporary_client.post(
            "/api/auth/login",
            json={
                "email": "lilicontact07@gmail.com",
                "password": "test-admin-password",
                "rememberMe": False,
            },
        )
        self.assertEqual(temporary_login.status_code, 200)
        with temporary_client.session_transaction() as browser_session:
            self.assertFalse(browser_session.permanent)

    def test_remembered_cookie_survives_bridge_client_restart(self):
        self.setup_admin()
        bridge_client = create_wsgi_client(flask_app.wsgi_app)
        login = bridge_client.post(
            "/api/auth/login",
            json={
                "email": "lilicontact07@gmail.com",
                "password": "test-admin-password",
                "rememberMe": True,
            },
        )
        self.assertEqual(login.status_code, 200, login.get_json())
        self.assertIn("Expires=", login.headers["Set-Cookie"])
        session_cookie = login.headers["Set-Cookie"].split(";", 1)[0]

        restarted_bridge_client = create_wsgi_client(flask_app.wsgi_app)
        current_user = restarted_bridge_client.get(
            "/api/auth/me",
            headers={"Cookie": session_cookie},
        )
        self.assertEqual(current_user.status_code, 200)
        self.assertEqual(
            current_user.get_json()["user"]["email"],
            "lilicontact07@gmail.com",
        )

    def test_admin_can_change_roles_and_reset_passwords(self):
        admin = self.setup_admin()
        register = {
            "email": "user@example.com",
            "firstName": "Test",
            "lastName": "User",
            "password": "strong-password",
        }
        response = self.client.post("/api/auth/register", json=register)
        self.assertEqual(response.status_code, 200, response.get_json())
        user = response.get_json()["user"]
        self.assertEqual(user["role"], "user")
        self.assertEqual(self.client.get("/admin").status_code, 302)
        self.assertEqual(self.client.get("/api/admin/accounts").status_code, 403)

        admin_client = flask_app.test_client()
        admin_client.post(
            "/api/auth/login",
            json={"email": "lilicontact07@gmail.com", "password": "test-admin-password"},
        )
        last_admin = admin_client.post(
            f"/api/admin/accounts/{admin['id']}/role",
            json={"role": "user"},
        )
        self.assertEqual(last_admin.status_code, 409)
        role_response = admin_client.post(
            f"/api/admin/accounts/{user['id']}/role",
            json={"role": "admin"},
        )
        self.assertEqual(role_response.status_code, 200)
        demote_response = admin_client.post(
            f"/api/admin/accounts/{user['id']}/role",
            json={"role": "user"},
        )
        self.assertEqual(demote_response.status_code, 200)
        role_response = admin_client.post(
            f"/api/admin/accounts/{user['id']}/role",
            json={"role": "admin"},
        )
        self.assertEqual(role_response.status_code, 200)

        user_client = flask_app.test_client()
        user_client.post("/api/auth/login", json=register)
        reset = admin_client.post(
            f"/api/admin/accounts/{user['id']}/reset",
            json={"password": "new-strong-password", "confirmation": "new-strong-password"},
        )
        self.assertEqual(reset.status_code, 200, reset.get_json())
        self.assertEqual(user_client.get("/api/auth/me").get_json(), {"user": None})
        self.assertEqual(
            user_client.post("/api/auth/login", json=register).status_code,
            401,
        )
        self.assertEqual(
            user_client.post(
                "/api/auth/login",
                json={"email": "user@example.com", "password": "new-strong-password"},
            ).status_code,
            200,
        )

        own_reset = admin_client.post(
            f"/api/admin/accounts/{admin['id']}/reset",
            json={"password": "replacement-admin-password", "confirmation": "replacement-admin-password"},
        )
        self.assertEqual(own_reset.status_code, 200, own_reset.get_json())
        self.assertEqual(
            admin_client.get("/api/auth/me").get_json()["user"]["email"],
            "lilicontact07@gmail.com",
        )
        self.assertEqual(
            admin_client.post(
                "/api/auth/login",
                json={"email": "lilicontact07@gmail.com", "password": "test-admin-password"},
            ).status_code,
            401,
        )
        self.assertEqual(
            admin_client.post(
                "/api/auth/login",
                json={"email": "lilicontact07@gmail.com", "password": "replacement-admin-password"},
            ).status_code,
            200,
        )
        self_demote = admin_client.post(
            f"/api/admin/accounts/{admin['id']}/role",
            json={"role": "user"},
        )
        self.assertEqual(self_demote.status_code, 200, self_demote.get_json())
        self.assertTrue(self_demote.get_json()["selfDemoted"])
        self.assertEqual(admin_client.get("/admin").status_code, 302)
        self.assertEqual(
            admin_client.get("/api/auth/me").get_json()["user"]["role"],
            "user",
        )

    def test_only_admin_can_reset_and_password_confirmation_is_required(self):
        self.setup_admin()
        register = {
            "email": "user@example.com",
            "firstName": "Test",
            "lastName": "User",
            "password": "strong-password",
        }
        user = self.client.post("/api/auth/register", json=register).get_json()["user"]
        response = self.client.post(
            f"/api/admin/accounts/{user['id']}/reset",
            json={"password": "replacement-password", "confirmation": "different-password"},
        )
        self.assertEqual(response.status_code, 403)

        admin_client = flask_app.test_client()
        admin_client.post(
            "/api/auth/login",
            json={"email": "lilicontact07@gmail.com", "password": "test-admin-password"},
        )
        mismatch = admin_client.post(
            f"/api/admin/accounts/{user['id']}/reset",
            json={"password": "replacement-password", "confirmation": "different-password"},
        )
        self.assertEqual(mismatch.status_code, 400)
        too_short = admin_client.post(
            f"/api/admin/accounts/{user['id']}/reset",
            json={"password": "short", "confirmation": "short"},
        )
        self.assertEqual(too_short.status_code, 400)
        self.assertEqual(admin_client.post("/api/auth/forgot-password", json={}).status_code, 404)
        self.assertEqual(admin_client.post("/api/auth/reset-password", json={}).status_code, 404)
        self.assertEqual(admin_client.get("/account").status_code, 404)


if __name__ == "__main__":
    unittest.main()
