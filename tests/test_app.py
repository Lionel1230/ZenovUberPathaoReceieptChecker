"""Unit tests for the Flask app."""
from __future__ import annotations

import json
import io
from pathlib import Path

import pytest
import app as app_module
from app import app


# ─── helpers ───────────────────────────────────────────────────────────

@pytest.fixture
def client():
    app.config["TESTING"] = True
    app.config["SECRET_KEY"] = "test-secret"
    with app.test_client() as c:
        yield c


def login(client, username="admin", password="admin"):
    return client.post("/login", data={"username": username, "password": password}, follow_redirects=False)


def admin_session(client):
    login(client, "admin", "admin")


def user_session(client):
    login(client, "user", "user")


def wait_for_job(client, job_id, timeout=15):
    import time
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        r = client.get(f"/api/jobs/{job_id}")
        assert r.status_code == 200
        body = r.get_json()
        last = body
        if body["status"] in ("completed", "failed"):
            return body
        time.sleep(0.05)
    raise AssertionError(f"job {job_id} did not finish in {timeout}s (last: {last})")


# ─── auth ──────────────────────────────────────────────────────────────

class TestAuth:
    def test_login_valid(self, client):
        r = login(client, "admin", "admin")
        assert r.status_code == 302

    def test_login_invalid(self, client):
        r = login(client, "admin", "wrong")
        assert r.status_code == 200
        assert b"Invalid username or password" in r.data

    def test_logout(self, client):
        admin_session(client)
        r = client.get("/logout", follow_redirects=False)
        assert r.status_code == 302
        assert r.location.endswith("/login")

    def test_demo_admin_creates_user(self, client, users_file):
        users_file.write_text("root:root\n")
        r = client.get("/demo-login/admin", follow_redirects=False)
        assert r.status_code == 302
        users = dict(l.split(":", 1) for l in users_file.read_text().splitlines() if ":" in l)
        assert "admin" in users

    def test_demo_user_creates_user(self, client, users_file):
        users_file.write_text("root:root\n")
        r = client.get("/demo-login/user", follow_redirects=False)
        assert r.status_code == 302
        users = dict(l.split(":", 1) for l in users_file.read_text().splitlines() if ":" in l)
        assert "user" in users

    def test_demo_login_sets_session(self, client):
        r = client.get("/demo-login/admin", follow_redirects=True)
        assert r.status_code == 200
        with client.session_transaction() as sess:
            assert sess["username"] == "admin"
            assert sess["authenticated"] is True


# ─── authorization ─────────────────────────────────────────────────────

class TestAuthz:
    @pytest.mark.parametrize("endpoint", [
        "/api/admin/uploads",
        "/api/admin/registration-requests",
        "/api/users/with-passwords",
    ])
    def test_normal_user_blocked(self, client, endpoint):
        user_session(client)
        r = client.get(endpoint)
        assert r.status_code == 403

    def test_unauthenticated_blocked(self, client):
        r = client.get("/api/users")
        assert r.status_code in (302, 401)


# ─── user management ───────────────────────────────────────────────────

class TestUsers:
    def test_list_users(self, client):
        admin_session(client)
        r = client.get("/api/users")
        assert r.status_code == 200
        data = r.get_json()
        assert "users" in data
        assert any(u["username"] == "admin" for u in data["users"])

    def test_list_users_with_passwords(self, client):
        admin_session(client)
        r = client.get("/api/users/with-passwords")
        assert r.status_code == 200
        data = r.get_json()
        user = next(u for u in data["users"] if u["username"] == "user")
        assert user["password"] == "user"

    def test_create_user(self, client, users_file):
        admin_session(client)
        r = client.post("/api/users", json={"username": "newbie", "password": "secret"})
        assert r.status_code == 201
        assert "newbie:secret" in users_file.read_text()

    def test_create_user_duplicate(self, client):
        admin_session(client)
        r = client.post("/api/users", json={"username": "admin", "password": "x"})
        assert r.status_code in (400, 409)

    def test_delete_user(self, client, users_file):
        admin_session(client)
        users_file.write_text("root:root\ntodelete:del\n")
        r = client.delete("/api/users/todelete")
        assert r.status_code in (200, 204)
        assert "todelete" not in users_file.read_text()

    def test_delete_all_users_forbidden_non_it(self, client):
        admin_session(client)
        r = client.delete("/api/users/all")
        assert r.status_code == 403

    def test_delete_all_users_by_it(self, client, users_file):
        users_file.write_text("root:root\nIT:IT\nadmin:admin\nuser:user\ntodelete:del\n")
        login(client, "IT", "IT")
        r = client.delete("/api/users/all")
        assert r.status_code == 200
        remaining = users_file.read_text()
        assert "root" in remaining
        assert "IT" in remaining
        assert "admin" in remaining
        assert "user" not in remaining
        assert "todelete" not in remaining


# ─── duplicate detection ───────────────────────────────────────────────

class TestDuplicates:
    def test_check_duplicates_none(self, client):
        user_session(client)
        r = client.post("/api/check-duplicates", json={"hashes": ["abc123"]})
        assert r.status_code == 200
        data = r.get_json()
        assert data["duplicates"] == []

    def test_check_duplicates_found(self, client, all_hashes_file):
        user_session(client)
        known_hash = "9ee3c46b6ac454defaf2c24a423fad1d460079d7"
        all_hashes_file.write_text(json.dumps({
            known_hash: {
                "first_seen": "2026-01-01T00:00:00",
                "origin": {"username": "other", "month": "January", "filename": "receipt.pdf"},
            }
        }))
        r = client.post("/api/check-duplicates", json={"hashes": [known_hash, "nonexistent"]})
        assert r.status_code == 200
        data = r.get_json()
        assert known_hash in data["duplicates"]
        assert "nonexistent" not in data["duplicates"]

    def test_check_duplicates_admin_returns_empty(self, client):
        admin_session(client)
        r = client.post("/api/check-duplicates", json={"hashes": ["anyhash"]})
        assert r.status_code == 200
        data = r.get_json()
        assert data["duplicates"] == []

    def test_submit_stores_hash_in_global_db(self, client, all_hashes_file):
        user_session(client)
        pdf_content = b"%PDF-1.4 test-content-for-hash-" + str(__import__("time").time()).encode()
        import io
        data = {
            "files": [(io.BytesIO(pdf_content), "test_dup.pdf")],
            "month": "January",
        }
        r = client.post("/api/submit", data=data, content_type="multipart/form-data")
        assert r.status_code == 200
        job = wait_for_job(client, r.get_json()["job_id"])
        assert job["status"] == "completed"
        all_hashes = json.loads(all_hashes_file.read_text())
        assert len(all_hashes) > 0


# ─── file uploads ──────────────────────────────────────────────────────

class TestUploads:
    def test_upload_pdf(self, client):
        user_session(client)
        data = {
            "files": [(io.BytesIO(b"%PDF-1.4 test-content"), "test.pdf")],
            "month": "January",
        }
        r = client.post("/api/upload", data=data, content_type="multipart/form-data")
        assert r.status_code in (200, 202)

    def test_upload_non_pdf_rejected(self, client):
        user_session(client)
        data = {
            "files": [(io.BytesIO(b"not a pdf"), "test.txt")],
            "month": "January",
        }
        r = client.post("/api/upload", data=data, content_type="multipart/form-data")
        assert r.status_code == 400

    def test_admin_uploads_lists_files(self, client, users_file):
        user_session(client)
        sub = app_module.UPLOAD_ROOT / "submissions" / "user" / "January" / "Real"
        sub.mkdir(parents=True, exist_ok=True)
        (sub / "report.pdf").write_bytes(b"%PDF-1.4 dummy")

        admin_session(client)
        r = client.get("/api/admin/uploads")
        assert r.status_code == 200
        data = r.get_json()
        users = {u["username"]: u for u in data["users"]}
        assert "user" in users
        assert any("report.pdf" in f["name"] for f in users["user"]["files"])

    def test_admin_uploads_month_totals(self, client):
        user_session(client)
        folder = app_module.UPLOAD_ROOT / "submissions" / "user" / "July" / "Real"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "a.pdf").write_bytes(b"%PDF-1.4 dummy")
        (folder / "b.pdf").write_bytes(b"%PDF-1.4 dummy")
        results_path = app_module.UPLOAD_ROOT / "submissions" / "user" / "July" / "_results.json"
        results_path.write_text(json.dumps({
            "a.pdf": {"filename": "a.pdf", "verdict": "real", "amount": 500.0, "sha1": "x1"},
            "b.pdf": {"filename": "b.pdf", "verdict": "real", "amount": 600.0, "sha1": "x2"},
        }), encoding="utf-8")

        admin_session(client)
        r = client.get("/api/admin/uploads")
        assert r.status_code == 200
        user = next(u for u in r.get_json()["users"] if u["username"] == "user")
        assert user["month_totals"]["July"]["total"] == 1100.0
        assert user["month_totals"]["July"]["count"] == 2
        amounts = {f["name"]: f["amount"] for f in user["files"]}
        assert amounts["a.pdf"] == 500.0
        assert amounts["b.pdf"] == 600.0


# ─── registration requests ────────────────────────────────────────────

class TestRegRequests:
    def test_submit_request(self, client, reg_file):
        r = client.post("/api/admin/registration-requests", json={
            "name": "Test", "team": "TeamA", "gmail": "t@t.com"
        })
        assert r.status_code in (200, 405)

    def test_admin_list_requests(self, client):
        admin_session(client)
        r = client.get("/api/admin/registration-requests")
        assert r.status_code == 200

    def test_admin_delete_request(self, client, reg_file):
        reg_file.write_text(json.dumps([
            {"name": "X", "team": "T", "gmail": "x@x.com"}
        ]))
        admin_session(client)
        r = client.delete("/api/admin/registration-requests",
                          json={"gmail": "x@x.com"})
        assert r.status_code == 200

    def test_admin_delete_all_requests(self, client, reg_file):
        reg_file.write_text(json.dumps([
            {"name": "A", "team": "T1", "gmail": "a@a.com"},
            {"name": "B", "team": "T2", "gmail": "b@b.com"},
        ]))
        admin_session(client)
        r = client.delete("/api/admin/registration-requests/all")
        assert r.status_code == 200
        assert json.loads(reg_file.read_text()) == []


# ─── cache ─────────────────────────────────────────────────────────────

class TestCache:
    def test_clear_cache_forbidden_non_it(self, client):
        admin_session(client)
        r = client.post("/api/admin/clear-cache")
        assert r.status_code == 403

    def test_clear_cache_by_it(self, client, users_file):
        users_file.write_text("IT:IT\n")
        login(client, "IT", "IT")
        r = client.post("/api/admin/clear-cache")
        assert r.status_code == 200
        data = r.get_json()
        assert "Cache cleared" in data.get("message", "")


# ─── billing ──────────────────────────────────────────────────────────

class TestBilling:
    def test_set_total_bill(self, client):
        admin_session(client)
        r = client.put("/api/billing/total",
                       json={"month": "January", "total_bill": 500.0})
        assert r.status_code in (200, 403)

    def test_get_billing(self, client):
        admin_session(client)
        r = client.get("/api/billing")
        assert r.status_code == 200


# ─── amount extraction endpoint ────────────────────────────────────────

class TestExtractAmounts:
    def test_requires_files(self, client):
        user_session(client)
        r = client.post("/api/extract-amounts", data={}, content_type="multipart/form-data")
        assert r.status_code == 400

    def test_returns_amounts_list(self, client):
        user_session(client)
        data = {"files": [(io.BytesIO(b"%PDF-1.4 not really a receipt"), "x.pdf")]}
        r = client.post("/api/extract-amounts", data=data, content_type="multipart/form-data")
        assert r.status_code == 200
        amounts = r.get_json()["amounts"]
        assert amounts[0]["filename"] == "x.pdf"
        assert amounts[0]["amount"] is None

    def test_skips_non_pdf(self, client):
        user_session(client)
        data = {"files": [(io.BytesIO(b"plain text"), "notes.txt")]}
        r = client.post("/api/extract-amounts", data=data, content_type="multipart/form-data")
        assert r.status_code == 200
        assert r.get_json()["amounts"] == []

    def test_unauthenticated_blocked(self, client):
        r = client.post("/api/extract-amounts", data={}, content_type="multipart/form-data")
        assert r.status_code in (302, 401)


# ─── monthly totals from submitted receipts ────────────────────────────class TestMonthlyTotals:
    def _make_submission(self, username, month, filename, amount):
        folder = app_module.UPLOAD_ROOT / "submissions" / username / month / "Real"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / filename).write_bytes(b"%PDF-1.4 dummy")
        results_path = app_module.UPLOAD_ROOT / "submissions" / username / month / "_results.json"
        results = {}
        if results_path.exists():
            results = json.loads(results_path.read_text(encoding="utf-8"))
        results[filename] = {
            "filename": filename,
            "verdict": "real",
            "amount": amount,
            "sha1": "abc",
        }
        results_path.write_text(json.dumps(results), encoding="utf-8")

    def test_no_submissions(self, client):
        user_session(client)
        r = client.get("/api/my-monthly-totals")
        assert r.status_code == 200
        assert r.get_json()["totals"] == {}

    def test_sums_amounts_per_month(self, client):
        user_session(client)
        self._make_submission("user", "January", "a.pdf", 500.0)
        self._make_submission("user", "January", "b.pdf", 600.0)
        self._make_submission("user", "February", "c.pdf", 150.5)
        r = client.get("/api/my-monthly-totals")
        assert r.status_code == 200
        totals = r.get_json()["totals"]
        assert totals["January"]["total"] == 1100.0
        assert totals["January"]["count"] == 2
        assert totals["February"]["total"] == 150.5

    def test_skips_missing_amount(self, client):
        user_session(client)
        folder = app_module.UPLOAD_ROOT / "submissions" / "user" / "March" / "Real"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "x.pdf").write_bytes(b"%PDF-1.4 dummy")
        results_path = app_module.UPLOAD_ROOT / "submissions" / "user" / "March" / "_results.json"
        results_path.write_text(json.dumps({"x.pdf": {"filename": "x.pdf", "verdict": "real"}}), encoding="utf-8")
        r = client.get("/api/my-monthly-totals")
        totals = r.get_json()["totals"]
        assert "March" not in totals or totals["March"]["total"] == 0

    def test_admin_forbidden_view(self, client):
        admin_session(client)
        r = client.get("/api/my-monthly-totals")
        assert r.status_code == 200
        assert r.get_json()["totals"] == {}


# ─── site settings ────────────────────────────────────────────────────

class TestSiteSettings:
    def test_save_and_load(self, client):
        admin_session(client)
        r = client.put("/api/admin/site-config", json={
            "daily_quote": "Test quote",
            "maintenance_message": "",
        })
        assert r.status_code == 200
        r = client.get("/api/site-config")
        data = r.get_json()
        assert data["daily_quote"] == "Test quote"


# ─── verification ─────────────────────────────────────────────────────

class TestVerification:
    def test_toggle_verification(self, client):
        admin_session(client)
        sub = app_module.UPLOAD_ROOT / "submissions" / "user" / "January" / "Real"
        sub.mkdir(parents=True, exist_ok=True)
        (sub / "doc.pdf").write_bytes(b"%PDF-1.4 data")

        r = client.post("/api/admin/verify", json={
            "username": "user", "month": "January", "filename": "doc.pdf"
        })
        assert r.status_code in (200, 202)


# ─── cleanup ───────────────────────────────────────────────────────────

class TestCleanup:
    def test_cleanup_status(self, client):
        admin_session(client)
        r = client.get("/api/admin/cleanup-status")
        assert r.status_code == 200

    def test_cleanup_toggle(self, client, cleanup_file):
        admin_session(client)
        r = client.post("/api/admin/cleanup-toggle", json={"enabled": True})
        assert r.status_code == 200
        assert cleanup_file.read_text().strip() == "1"
