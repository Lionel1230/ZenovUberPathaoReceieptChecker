"""Flask web application for PDF metadata analysis."""

from __future__ import annotations

import json
import logging
import os
import secrets
import shutil
import threading
from functools import wraps
from pathlib import Path

from flask import Flask, jsonify, redirect, render_template, request, session, url_for
from dotenv import load_dotenv
from werkzeug.utils import secure_filename

from analyzer import analyze_pdfs
from jobs import JobStatus, job_store

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent
UPLOAD_ROOT = BASE_DIR / "uploads"
USERS_FILE = BASE_DIR / "users.txt"
ADMIN_ROLES = {"root", "admin", "IT"}

UPLOAD_ROOT.mkdir(exist_ok=True)

MAX_FILE_SIZE = 50 * 1024 * 1024  # 50 MB per file
MAX_FILES = 200

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_FILE_SIZE * MAX_FILES
app.secret_key = os.environ.get("SECRET_KEY", secrets.token_hex(32))


def _seed_users_file() -> None:
    """If users.txt is missing, seed it from the USERS env var."""
    if USERS_FILE.exists():
        return
    env_users = os.environ.get("USERS")
    if env_users:
        try:
            users = json.loads(env_users)
            lines = [f"{u}:{p}" for u, p in users.items()]
            USERS_FILE.write_text("\n".join(lines) + "\n")
            logger.info("Seeded users.txt from USERS env var")
        except (json.JSONDecodeError, TypeError):
            logger.warning("Failed to parse USERS env var, no users seeded")


_seed_users_file()


def _load_users() -> dict[str, str]:
    users: dict[str, str] = {}
    if USERS_FILE.exists():
        for line in USERS_FILE.read_text().splitlines():
            line = line.strip()
            if ":" in line and not line.startswith("#"):
                username, password = line.split(":", 1)
                users[username.strip()] = password.strip()
    return users


def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get("authenticated"):
            if request.path.startswith("/api/"):
                return jsonify({"error": "Authentication required"}), 401
            return redirect(url_for("login"))
        return f(*args, **kwargs)
    return decorated


def _result_to_dict(result) -> dict:
    return {
        "filename": result.filename,
        "verdict": result.verdict.value,
        "producer": result.producer,
        "creator": result.creator,
        "matched_keywords": result.matched_keywords,
        "error_message": result.error_message,
    }


def _run_analysis(job_id: str, pdf_items: list[tuple[Path, str]]) -> None:
    """Background thread: analyze PDFs and update job progress."""
    try:
        job_store.update(
            job_id,
            status=JobStatus.ANALYZING,
            total_files=len(pdf_items),
            analyze_progress=0,
            analyzed_count=0,
        )

        def on_progress(completed: int, total: int) -> None:
            pct = int((completed / total) * 100) if total else 100
            job_store.update(
                job_id,
                analyzed_count=completed,
                analyze_progress=pct,
            )

        results = analyze_pdfs(pdf_items, on_progress=on_progress)
        serialized = [_result_to_dict(r) for r in results]

        job_store.update(
            job_id,
            status=JobStatus.COMPLETED,
            analyze_progress=100,
            results=serialized,
        )
        logger.info("Job %s completed — %d files analyzed", job_id, len(results))

    except Exception as exc:
        logger.exception("Job %s failed during analysis", job_id)
        job_store.update(job_id, status=JobStatus.FAILED, error=str(exc))
    finally:
        job = job_store.get(job_id)
        if job and job.upload_dir and job.upload_dir.exists():
            try:
                shutil.rmtree(job.upload_dir, ignore_errors=True)
            except OSError:
                logger.warning("Could not clean up upload dir for job %s", job_id)


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        username = request.form.get("username", "")
        password = request.form.get("password", "")
        users = _load_users()
        if users.get(username) == password:
            session["authenticated"] = True
            session["username"] = username
            return redirect(url_for("index"))
        return render_template("login.html", error="Invalid username or password")
    return render_template("login.html")


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.route("/api/me")
@login_required
def get_me():
    username = session.get("username", "")
    return jsonify({"username": username, "is_admin": username in ADMIN_ROLES})


def _save_user(username: str, password: str) -> None:
    line = f"{username}:{password}\n"
    with open(USERS_FILE, "a", encoding="utf-8") as f:
        f.write(line)


@app.route("/api/users", methods=["GET"])
@login_required
def list_users():
    if session.get("username") not in ADMIN_ROLES:
        return jsonify({"error": "Forbidden"}), 403
    users = _load_users()
    return jsonify({"users": [{"username": u} for u in users]})


@app.route("/api/users", methods=["POST"])
@login_required
def create_user():
    if session.get("username") not in ADMIN_ROLES:
        return jsonify({"error": "Forbidden"}), 403

    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    password = (data.get("password") or "").strip()

    if not username or not password:
        return jsonify({"error": "Username and password are required"}), 400
    if ":" in username:
        return jsonify({"error": "Username cannot contain ':'"}), 400

    users = _load_users()
    if username in users:
        return jsonify({"error": f"User '{username}' already exists"}), 409

    _save_user(username, password)
    logger.info("User '%s' created by '%s'", username, session.get("username"))
    return jsonify({"message": f"User '{username}' created"}), 201


@app.route("/api/users/<username>", methods=["DELETE"])
@login_required
def delete_user(username: str):
    if session.get("username") not in ADMIN_ROLES:
        return jsonify({"error": "Forbidden"}), 403
    if username == "root":
        return jsonify({"error": "Cannot delete root user"}), 403

    users = _load_users()
    if username not in users:
        return jsonify({"error": "User not found"}), 404

    lines = USERS_FILE.read_text().splitlines()
    new_lines = [l for l in lines if not (l.strip() and not l.strip().startswith("#") and l.strip().split(":")[0].strip() == username)]
    USERS_FILE.write_text("\n".join(new_lines) + "\n")
    logger.info("User '%s' deleted by '%s'", username, session.get("username"))
    return jsonify({"message": f"User '{username}' deleted"})


@app.route("/api/password", methods=["POST"])
@login_required
def change_password():
    data = request.get_json(silent=True) or {}
    old_password = (data.get("old_password") or "").strip()
    new_password = (data.get("new_password") or "").strip()

    if not old_password or not new_password:
        return jsonify({"error": "Both old and new password are required"}), 400

    username = session.get("username", "")
    users = _load_users()
    if users.get(username) != old_password:
        return jsonify({"error": "Current password is incorrect"}), 403

    lines = USERS_FILE.read_text().splitlines()
    new_lines = []
    for line in lines:
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and stripped.split(":")[0].strip() == username:
            new_lines.append(f"{username}:{new_password}")
        else:
            new_lines.append(line)
    USERS_FILE.write_text("\n".join(new_lines) + "\n")
    logger.info("Password changed for user '%s'", username)
    return jsonify({"message": "Password updated"})


@app.route("/")
@login_required
def index():
    return render_template("index.html")


@app.route("/api/jobs/<job_id>", methods=["GET"])
@login_required
def get_job_status(job_id: str):
    job = job_store.get(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404
    job_store.cleanup_old_jobs()
    return jsonify(job_store.to_dict(job))


def _display_filename(raw: str | None, idx: int) -> str:
    """Extract the actual file name, stripping any folder path from uploads."""
    if not raw:
        return f"file_{idx}.pdf"
    return Path(raw.replace("\\", "/")).name


def _safe_storage_name(original: str, idx: int) -> str:
    """Sanitize only the base name for safe disk storage."""
    safe = secure_filename(original) or f"file_{idx}.pdf"
    if not safe.lower().endswith(".pdf"):
        safe += ".pdf"
    return safe


@app.route("/api/upload", methods=["POST"])
@login_required
def upload_files():
    files = request.files.getlist("files")
    if not files or all(f.filename == "" for f in files):
        return jsonify({"error": "No files provided"}), 400

    pdf_files = [f for f in files if f.filename and f.filename.lower().endswith(".pdf")]
    if not pdf_files:
        return jsonify({"error": "No PDF files found in upload"}), 400

    valid_pdfs = []
    for f in pdf_files:
        header = f.stream.read(5)
        f.stream.seek(0)
        if header.startswith(b"%PDF"):
            valid_pdfs.append(f)
    if not valid_pdfs:
        return jsonify({"error": "No valid PDF files found (bad file content)"}), 400
    pdf_files = valid_pdfs

    oversized = []
    for f in pdf_files:
        f.stream.seek(0, 2)
        size = f.stream.tell()
        f.stream.seek(0)
        if size > MAX_FILE_SIZE:
            oversized.append(f.filename)
    if oversized:
        names = ", ".join(oversized[:5])
        suffix = f" and {len(oversized) - 5} more" if len(oversized) > 5 else ""
        return jsonify({"error": f"Files too large (max {MAX_FILE_SIZE // (1024*1024)} MB): {names}{suffix}"}), 400

    if len(pdf_files) > MAX_FILES:
        return jsonify({"error": f"Too many files (max {MAX_FILES})"}), 400

    job = job_store.create()
    upload_dir = UPLOAD_ROOT / job.id
    upload_dir.mkdir(parents=True, exist_ok=True)
    job_store.update(job.id, upload_dir=upload_dir, total_files=len(pdf_files))

    saved_items: list[tuple[Path, str]] = []
    try:
        for idx, file in enumerate(pdf_files):
            display_name = _display_filename(file.filename, idx)
            safe_name = _safe_storage_name(display_name, idx)

            dest = upload_dir / safe_name
            counter = 1
            while dest.exists():
                stem = Path(safe_name).stem
                dest = upload_dir / f"{stem}_{counter}.pdf"
                counter += 1

            file.save(str(dest))
            saved_items.append((dest, display_name))

            pct = int(((idx + 1) / len(pdf_files)) * 100)
            job_store.update(job.id, upload_progress=pct)

        job_store.update(job.id, upload_progress=100)

        thread = threading.Thread(
            target=_run_analysis,
            args=(job.id, saved_items),
            daemon=True,
            name=f"analyze-{job.id[:8]}",
        )
        thread.start()

        return jsonify({"job_id": job.id, "file_count": len(saved_items)})

    except Exception as exc:
        logger.exception("Upload failed for job %s", job.id)
        job_store.update(job.id, status=JobStatus.FAILED, error=str(exc))
        if upload_dir.exists():
            shutil.rmtree(upload_dir, ignore_errors=True)
        return jsonify({"error": str(exc)}), 500


@app.errorhandler(413)
def too_large(_exc):
    return jsonify({"error": "Upload too large"}), 413


if __name__ == "__main__":
    import socket

    def local_ips() -> list[str]:
        ips: list[str] = []
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.connect(("8.8.8.8", 80))
                ips.append(s.getsockname()[0])
        except OSError:
            pass
        return ips

    port = 5000
    print("\n  PDF Analyzer is running")
    print(f"  On this PC:  http://127.0.0.1:{port}")
    for ip in local_ips():
        print(f"  On your WiFi: http://{ip}:{port}")
    print("\n  Other devices on the same WiFi can use the WiFi address above.\n")

    debug = os.environ.get("FLASK_DEBUG", "0") == "1"
    app.run(host="0.0.0.0", debug=debug, threaded=True, port=port)
