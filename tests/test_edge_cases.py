"""Edge-case and vulnerability tests for the Flask app."""
from __future__ import annotations

import io
import json
import os
import threading
import time
from pathlib import Path

import pytest
import app as app_module
from app import app
from jobs import JOB_TTL_SECONDS, JobStore, JobStatus
from analyzer import extract_bill_amount_from_text


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


def submit_and_wait(client, files, month="January"):
    data = {"files": files, "month": month}
    r = client.post("/api/submit", data=data, content_type="multipart/form-data")
    assert r.status_code == 200
    return wait_for_job(client, r.get_json()["job_id"])


FAKE_PDF = b"%PDF-1.4 fake receipt content for tests"


# ─── /api/me ───────────────────────────────────────────────────────────

class TestMe:
    def test_requires_auth(self, client):
        r = client.get("/api/me")
        assert r.status_code in (302, 401)

    def test_normal_user(self, client):
        user_session(client)
        r = client.get("/api/me")
        assert r.status_code == 200
        data = r.get_json()
        assert data["username"] == "user"
        assert data["is_admin"] is False

    def test_admin(self, client):
        admin_session(client)
        data = client.get("/api/me").get_json()
        assert data["is_admin"] is True


# ─── filename sanitisation (path traversal) ────────────────────────────

class TestFilenameSanitisation:
    def test_display_filename_strips_path(self):
        assert app_module._display_filename(r"..\..\Windows\evil.pdf", 0) == "evil.pdf"
        assert app_module._display_filename("uploads/x/y/evil.pdf", 0) == "evil.pdf"
        assert app_module._display_filename("", 0) == "file_0.pdf"
        assert app_module._display_filename(None, 2) == "file_2.pdf"

    def test_safe_storage_name_blocks_traversal(self):
        assert app_module._safe_storage_name(r"..\..\evil.pdf", 0) == "evil.pdf"
        assert app_module._safe_storage_name("report v2.pdf", 0) == "report_v2.pdf"
        assert app_module._safe_storage_name("../../etc/passwd", 0) == "etc_passwd.pdf"
        assert app_module._safe_storage_name("", 0) == "file_0.pdf"

    def test_submit_with_traversal_filename_stays_inside(self, client):
        user_session(client)
        job = submit_and_wait(client, [(io.BytesIO(FAKE_PDF), r"..\..\evil.pdf")])
        assert job["status"] == "completed"
        root = app_module.UPLOAD_ROOT
        assert not (root / "evil.pdf").exists()
        user_dir = root / "submissions" / "user" / "January"
        found = [p.name for p in user_dir.rglob("*.pdf")]
        assert "evil.pdf" in found

    def test_delete_submission_cannot_escape(self, client):
        user_session(client)
        r = client.delete("/api/my-submissions/January/..%2F..%2Fevil.pdf")
        assert r.status_code in (400, 403, 404)
        assert not (app_module.UPLOAD_ROOT / ".." / "evil.pdf").resolve().exists()


# ─── profile pictures ──────────────────────────────────────────────────

class TestProfilePic:
    def test_get_invalid_username_returns_default(self, client):
        user_session(client)
        r = client.get("/api/profile-pic/..")
        assert r.status_code == 200
        assert r.mimetype == "image/svg+xml"

    def test_upload_valid(self, client):
        user_session(client)
        r = client.put(
            "/api/profile-pic",
            data={"profile_pic": (io.BytesIO(b"\x89PNG\r\n\x1a\nfake"), "me.png")},
            content_type="multipart/form-data",
        )
        assert r.status_code == 200
        assert (app_module.PROFILE_PIC_DIR / "user.png").exists()
        r2 = client.get("/api/profile-pic/user")
        assert r2.status_code == 200
        assert r2.mimetype == "image/png"

    def test_upload_rejects_bad_extension(self, client):
        user_session(client)
        r = client.put(
            "/api/profile-pic",
            data={"profile_pic": (io.BytesIO(b"<script>x</script>"), "me.svg")},
            content_type="multipart/form-data",
        )
        assert r.status_code == 400
        assert not (app_module.PROFILE_PIC_DIR / "user.svg").exists()

    def test_upload_requires_file(self, client):
        user_session(client)
        r = client.put("/api/profile-pic", data={}, content_type="multipart/form-data")
        assert r.status_code == 400


# ─── password change ───────────────────────────────────────────────────

class TestPassword:
    def test_change_password_success(self, client, users_file):
        user_session(client)
        r = client.post("/api/password", json={"old_password": "user", "new_password": "newpass"})
        assert r.status_code == 200
        assert "user:newpass" in users_file.read_text()

    def test_change_password_wrong_old(self, client):
        user_session(client)
        r = client.post("/api/password", json={"old_password": "nope", "new_password": "x"})
        assert r.status_code == 403

    def test_change_password_requires_fields(self, client):
        user_session(client)
        r = client.post("/api/password", json={})
        assert r.status_code == 400

    def test_new_password_logs_in_old_does_not(self, client):
        user_session(client)
        client.post("/api/password", json={"old_password": "user", "new_password": "fresh"})
        client.get("/logout")
        assert login(client, "user", "user").status_code == 200  # old fails
        assert login(client, "user", "fresh").status_code == 302  # new works


# ─── registration requests (submit path) ───────────────────────────────

class TestRegisterRequestSubmit:
    def test_valid(self, client, reg_file):
        r = client.post("/api/register-request", json={"name": "A", "team": "B", "gmail": "a@b.com"})
        assert r.status_code == 200
        assert len(json.loads(reg_file.read_text())) == 1

    def test_duplicate_rejected(self, client, reg_file):
        payload = {"name": "A", "team": "B", "gmail": "a@b.com"}
        assert client.post("/api/register-request", json=payload).status_code == 200
        r = client.post("/api/register-request", json=payload)
        assert r.status_code == 409

    def test_force_bypasses_duplicate(self, client):
        payload = {"name": "A", "team": "B", "gmail": "a@b.com"}
        assert client.post("/api/register-request", json=payload).status_code == 200
        payload["force"] = True
        assert client.post("/api/register-request", json=payload).status_code == 200

    def test_invalid_email(self, client):
        r = client.post("/api/register-request", json={"name": "A", "team": "B", "gmail": "not-an-email"})
        assert r.status_code == 400

    def test_missing_fields(self, client):
        assert client.post("/api/register-request", json={"name": "A"}).status_code == 400

    def test_register_page(self, client):
        r = client.get("/register-request")
        assert r.status_code == 200


# ─── job store / analysis pipeline ─────────────────────────────────────

class TestJobs:
    def test_job_not_found(self, client):
        user_session(client)
        r = client.get("/api/jobs/nonexistent")
        assert r.status_code == 404

    def test_job_requires_auth(self, client):
        r = client.get("/api/jobs/whatever")
        assert r.status_code in (302, 401)

    def test_upload_creates_pollable_job(self, client):
        user_session(client)
        data = {"files": [(io.BytesIO(FAKE_PDF), "a.pdf")]}
        r = client.post("/api/upload", data=data, content_type="multipart/form-data")
        assert r.status_code in (200, 202)
        job_id = r.get_json()["job_id"]

        status = None
        for _ in range(100):
            jr = client.get(f"/api/jobs/{job_id}")
            assert jr.status_code == 200
            body = jr.get_json()
            status = body["status"]
            if status in ("completed", "failed"):
                break
            time.sleep(0.05)
        assert status in ("completed", "failed")
        assert "results" in jr.get_json()


class TestJobStoreUnit:
    def test_concurrent_create_update_get(self):
        store = JobStore()
        n = 8
        barrier = threading.Barrier(n)
        errors = []

        def worker(i):
            try:
                barrier.wait()
                job = store.create()
                store.update(job.id, upload_progress=i, status=JobStatus.ANALYZING)
                got = store.get(job.id)
                assert got is not None
                assert got.upload_progress == i
                assert got.status == JobStatus.ANALYZING
                store.update(job.id, status=JobStatus.COMPLETED)
            except Exception as exc:  # pragma: no cover
                errors.append(exc)

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)
        assert not errors
        assert len(store.to_dict(next(iter(store._jobs.values())))) > 0

    def test_get_returns_copy(self):
        store = JobStore()
        job = store.create()
        job.results.append({"x": 1})
        got = store.get(job.id)
        got.results.append({"y": 2})
        assert store.get(job.id).results == [{"x": 1}]

    def test_cleanup_old_jobs_only_expired(self):
        store = JobStore()
        old = store.create()
        old.status = JobStatus.COMPLETED
        old.created_at = time.time() - JOB_TTL_SECONDS - 10
        fresh = store.create()
        fresh.status = JobStatus.COMPLETED
        active = store.create()
        active.status = JobStatus.ANALYZING
        assert store.cleanup_old_jobs() == 1
        assert store.get(old.id) is None
        assert store.get(fresh.id) is not None
        assert store.get(active.id) is not None

    def test_cleanup_removes_job(self):
        store = JobStore()
        job = store.create()
        assert store.get(job.id) is not None
        store.cleanup(job.id)
        assert store.get(job.id) is None


# ─── upload validation ─────────────────────────────────────────────────

class TestUploadValidation:
    def test_too_many_files(self, client):
        user_session(client)
        data = {"files": [(io.BytesIO(FAKE_PDF), f"f{i}.pdf") for i in range(201)]}
        r = client.post("/api/upload", data=data, content_type="multipart/form-data")
        assert r.status_code == 400

    def test_oversized_file(self, client):
        user_session(client)
        big = b"%PDF" + b"0" * (app_module.MAX_FILE_SIZE + 1024)
        data = {"files": [(io.BytesIO(big), "big.pdf")]}
        r = client.post("/api/upload", data=data, content_type="multipart/form-data")
        assert r.status_code == 400

    def test_duplicate_filenames_do_not_collide(self, client):
        user_session(client)
        data = {"files": [(io.BytesIO(FAKE_PDF), "same.pdf"), (io.BytesIO(FAKE_PDF), "same.pdf")]}
        r = client.post("/api/upload", data=data, content_type="multipart/form-data")
        assert r.status_code in (200, 202)
        job_id = r.get_json()["job_id"]
        upload_dir = app_module.UPLOAD_ROOT / job_id
        names = sorted(p.name for p in upload_dir.glob("*.pdf"))
        assert names == ["same.pdf", "same_1.pdf"]


# ─── submit validation ─────────────────────────────────────────────────

class TestSubmitValidation:
    def test_invalid_month(self, client):
        user_session(client)
        data = {"files": [(io.BytesIO(FAKE_PDF), "a.pdf")], "month": "NotAMonth"}
        r = client.post("/api/submit", data=data, content_type="multipart/form-data")
        assert r.status_code == 400

    def test_no_files(self, client):
        user_session(client)
        r = client.post("/api/submit", data={"month": "January"}, content_type="multipart/form-data")
        assert r.status_code == 400

    def test_non_pdf_rejected(self, client):
        user_session(client)
        data = {"files": [(io.BytesIO(b"plain text"), "notes.txt")], "month": "January"}
        r = client.post("/api/submit", data=data, content_type="multipart/form-data")
        assert r.status_code == 400

    def test_bad_content_rejected(self, client):
        user_session(client)
        data = {"files": [(io.BytesIO(b"no pdf header"), "fake.pdf")], "month": "January"}
        r = client.post("/api/submit", data=data, content_type="multipart/form-data")
        assert r.status_code == 400

    def test_admin_cannot_submit(self, client):
        admin_session(client)
        data = {"files": [(io.BytesIO(FAKE_PDF), "a.pdf")], "month": "January"}
        r = client.post("/api/submit", data=data, content_type="multipart/form-data")
        assert r.status_code == 403

    def test_identical_files_marked_duplicate(self, client):
        user_session(client)
        job = submit_and_wait(
            client,
            [(io.BytesIO(FAKE_PDF), "a.pdf"), (io.BytesIO(FAKE_PDF), "b.pdf")],
        )
        assert job["status"] == "completed"
        summary = job["results"][0]
        assert len(summary["duplicate_files"]) == 2
        manual = app_module.UPLOAD_ROOT / "submissions" / "user" / "January" / "Manual Checks Required"
        assert len(list(manual.glob("*.pdf"))) == 2

    def test_submit_writes_results_with_amount(self, client):
        user_session(client)
        job = submit_and_wait(client, [(io.BytesIO(FAKE_PDF), "r.pdf")], month="February")
        assert job["status"] == "completed"
        results_path = app_module.UPLOAD_ROOT / "submissions" / "user" / "February" / "_results.json"
        results = json.loads(results_path.read_text(encoding="utf-8"))
        assert "r.pdf" in results


# ─── my submissions / deletion ─────────────────────────────────────────

class TestMySubmissions:
    def _add_file(self, username, month, folder_name, fname, age_hours=0):
        folder = app_module.UPLOAD_ROOT / "submissions" / username / month / folder_name
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / fname
        path.write_bytes(FAKE_PDF)
        if age_hours:
            old = time.time() - age_hours * 3600
            os.utime(path, (old, old))
        return path

    def test_lists_files_with_delete_flag(self, client):
        user_session(client)
        self._add_file("user", "January", "Real", "fresh.pdf")
        self._add_file("user", "January", "Real", "old.pdf", age_hours=5)
        r = client.get("/api/my-submissions")
        assert r.status_code == 200
        by_name = {f["name"]: f for f in r.get_json()["files"]}
        assert by_name["fresh.pdf"]["can_delete"] is True
        assert by_name["old.pdf"]["can_delete"] is False

    def test_admin_forbidden(self, client):
        admin_session(client)
        r = client.get("/api/my-submissions")
        assert r.status_code == 403

    def test_delete_within_limit(self, client):
        user_session(client)
        p = self._add_file("user", "January", "Real", "gone.pdf")
        r = client.delete("/api/my-submissions/January/gone.pdf")
        assert r.status_code == 200
        assert not p.exists()

    def test_delete_after_limit(self, client):
        user_session(client)
        self._add_file("user", "January", "Real", "locked.pdf", age_hours=5)
        r = client.delete("/api/my-submissions/January/locked.pdf")
        assert r.status_code == 403

    def test_delete_invalid_month(self, client):
        user_session(client)
        r = client.delete("/api/my-submissions/BadMonth/a.pdf")
        assert r.status_code == 400

    def test_delete_missing_file(self, client):
        user_session(client)
        r = client.delete("/api/my-submissions/January/nope.pdf")
        assert r.status_code == 404


# ─── admin upload management ───────────────────────────────────────────

class TestAdminUploadManagement:
    def _add_file(self, username, month, fname):
        folder = app_module.UPLOAD_ROOT / "submissions" / username / month / "Real"
        folder.mkdir(parents=True, exist_ok=True)
        p = folder / fname
        p.write_bytes(FAKE_PDF)
        return p

    def test_normal_user_cannot_delete(self, client):
        user_session(client)
        r = client.delete("/api/admin/uploads/user/January/a.pdf")
        assert r.status_code == 403

    def test_admin_delete(self, client):
        admin_session(client)
        p = self._add_file("user", "January", "kill.pdf")
        r = client.delete("/api/admin/uploads/user/January/kill.pdf")
        assert r.status_code == 200
        assert not p.exists()

    def test_admin_delete_missing(self, client):
        admin_session(client)
        r = client.delete("/api/admin/uploads/user/January/ghost.pdf")
        assert r.status_code == 404

    def test_admin_delete_invalid_month(self, client):
        admin_session(client)
        r = client.delete("/api/admin/uploads/user/BadMonth/a.pdf")
        assert r.status_code == 400

    def test_normal_user_cannot_open_folder(self, client):
        user_session(client)
        r = client.get("/api/admin/open-folder/user")
        assert r.status_code == 403

    def test_normal_user_cannot_list_uploads(self, client):
        user_session(client)
        assert client.get("/api/admin/uploads").status_code == 403


# ─── IT-only endpoints ─────────────────────────────────────────────────

class TestItOnly:
    def test_admin_blocked_from_logs(self, client):
        admin_session(client)
        assert client.get("/api/logs").status_code == 403

    def test_it_can_read_logs(self, client, users_file):
        users_file.write_text("IT:IT\n")
        login(client, "IT", "IT")
        r = client.get("/api/logs")
        assert r.status_code == 200
        assert "logs" in r.get_json()

    def test_admin_blocked_from_clear_hashes(self, client):
        admin_session(client)
        assert client.post("/api/admin/clear-hashes").status_code == 403

    def test_it_can_clear_hashes(self, client, all_hashes_file, users_file):
        users_file.write_text("IT:IT\n")
        login(client, "IT", "IT")
        assert client.post("/api/admin/clear-hashes").status_code == 200
        assert json.loads(all_hashes_file.read_text()) == {}

    def test_cleanup_forbidden_for_user(self, client):
        user_session(client)
        assert client.post("/api/admin/cleanup").status_code == 403

    def test_cleanup_by_admin(self, client):
        admin_session(client)
        r = client.post("/api/admin/cleanup")
        assert r.status_code == 200

    def test_site_config_write_forbidden_for_user(self, client):
        user_session(client)
        r = client.put("/api/admin/site-config", json={"daily_quote": "x"})
        assert r.status_code == 403

    def test_cleanup_status_forbidden_for_user(self, client):
        user_session(client)
        assert client.get("/api/admin/cleanup-status").status_code == 403

    def test_site_config_public_read(self, client):
        r = client.get("/api/site-config")
        assert r.status_code == 200
        assert "daily_quote" in r.get_json()


# ─── billing validation ────────────────────────────────────────────────

class TestBillingValidation:
    def test_invalid_month(self, client):
        user_session(client)
        r = client.put("/api/billing/total", json={"month": "NotAMonth", "total_bill": 10})
        assert r.status_code == 400

    def test_negative_amount(self, client):
        user_session(client)
        r = client.put("/api/billing/total", json={"month": "January", "total_bill": -5})
        assert r.status_code == 400

    def test_non_numeric_amount(self, client):
        user_session(client)
        r = client.put("/api/billing/total", json={"month": "January", "total_bill": "abc"})
        assert r.status_code == 400

    def test_user_can_set(self, client):
        user_session(client)
        r = client.put("/api/billing/total", json={"month": "January", "total_bill": 123.45})
        assert r.status_code == 200
        data = client.get("/api/billing").get_json()
        assert data["total_bills"]["January"] == 123.45

    def test_admin_blocked(self, client):
        admin_session(client)
        r = client.put("/api/billing/total", json={"month": "January", "total_bill": 10})
        assert r.status_code == 403


# ─── misc authorisation ────────────────────────────────────────────────

class TestMiscAuthz:
    def test_admin_verify_forbidden_for_user(self, client):
        user_session(client)
        r = client.post("/api/admin/verify", json={"username": "x", "month": "January", "filename": "a.pdf"})
        assert r.status_code == 403

    def test_jobs_unauthenticated(self, client):
        assert client.get("/api/jobs/abc").status_code in (302, 401)

    def test_index_requires_login(self, client):
        r = client.get("/")
        assert r.status_code == 302
        assert "/login" in r.location


# ─── hardening fixes ───────────────────────────────────────────────────

class TestHardening:
    @pytest.mark.parametrize("bad", ["../x", "a/b", "a\\b", "..", "a:b", ""])
    def test_create_user_rejects_unsafe_username(self, client, bad):
        admin_session(client)
        r = client.post("/api/users", json={"username": bad, "password": "p"})
        assert r.status_code == 400, bad

    def test_create_user_accepts_safe_username(self, client, users_file):
        admin_session(client)
        r = client.post("/api/users", json={"username": "good-name_1.2", "password": "p"})
        assert r.status_code == 201
        assert "good-name_1.2:p" in users_file.read_text()

    def test_login_rejects_traversal_username(self, client):
        r = client.post("/login", data={"username": "../x", "password": "whatever"}, follow_redirects=False)
        assert r.status_code == 200
        assert b"Invalid username or password" in r.data

    def test_admin_delete_rejects_bad_username(self, client):
        admin_session(client)
        r = client.delete("/api/admin/uploads/../x/January/a.pdf")
        assert r.status_code in (400, 404)

    def test_open_folder_rejects_bad_username(self, client):
        admin_session(client)
        r = client.get("/api/admin/open-folder/../x")
        assert r.status_code in (400, 404)

    def test_secret_key_persisted(self):
        key_file = app_module.BASE_DIR / ".secret_key"
        assert key_file.exists()
        persisted = key_file.read_text(encoding="utf-8").strip()
        assert len(persisted) >= 32
        assert app_module._get_secret_key() == persisted

    def test_submit_returns_job_id(self, client):
        user_session(client)
        r = client.post(
            "/api/submit",
            data={"files": [(io.BytesIO(FAKE_PDF), "q.pdf")], "month": "January"},
            content_type="multipart/form-data",
        )
        assert r.status_code == 200
        assert "job_id" in r.get_json()

    def test_concurrent_submits_no_lost_updates(self, client):
        from concurrent.futures import ThreadPoolExecutor

        user_session(client)
        n = 6

        def do(i):
            c = app.test_client()
            login(c, "user", "user")
            content = b"%PDF-1.4 " + f"unique-{i}".encode()
            data = {"files": [(io.BytesIO(content), f"f{i}.pdf")], "month": "March"}
            r = c.post("/api/submit", data=data, content_type="multipart/form-data")
            return r.get_json()["job_id"]

        with ThreadPoolExecutor(max_workers=n) as pool:
            job_ids = list(pool.map(do, range(n)))

        for jid in job_ids:
            body = wait_for_job(client, jid)
            assert body["status"] == "completed", body

        results_path = app_module.UPLOAD_ROOT / "submissions" / "user" / "March" / "_results.json"
        results = json.loads(results_path.read_text(encoding="utf-8"))
        names = set(results.keys())
        assert all(f"f{i}.pdf" in names for i in range(n))
        assert len(names) == n
