"""Flask web application for PDF metadata analysis."""

from __future__ import annotations

import hashlib
import json
import logging
import logging.handlers
import os
import secrets
import shutil
import threading
import time
from datetime import datetime, timedelta
from functools import wraps
from pathlib import Path

import flask
from flask import Flask, jsonify, redirect, render_template, request, session, url_for
from dotenv import load_dotenv
from werkzeug.utils import secure_filename

from analyzer import analyze_pdfs
from jobs import JobStatus, job_store

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent
LOGS_DIR = BASE_DIR / "logs"
LOGS_DIR.mkdir(exist_ok=True)

file_handler = logging.handlers.RotatingFileHandler(
    LOGS_DIR / "app.log", maxBytes=5 * 1024 * 1024, backupCount=10, encoding="utf-8"
)
file_handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s"))
file_handler.setLevel(logging.DEBUG)

console_handler = logging.StreamHandler()
console_handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s"))
console_handler.setLevel(logging.INFO)

logging.basicConfig(level=logging.DEBUG, handlers=[file_handler, console_handler])
logger = logging.getLogger(__name__)

UPLOAD_ROOT = BASE_DIR / "uploads"
USERS_FILE = BASE_DIR / "users.txt"
CLEANUP_TOGGLE_FILE = BASE_DIR / "cleanup_enabled.txt"
SITE_CONFIG_FILE = BASE_DIR / "site_config.json"
REG_REQUESTS_FILE = BASE_DIR / "registration_requests.json"
ADMIN_ROLES = {"root", "admin", "IT"}

UPLOAD_ROOT.mkdir(exist_ok=True)

MAX_FILE_SIZE = 10 * 1024 * 1024  # 10 MB per file
MAX_FILES = 200
DELETE_TIME_LIMIT = 7200  # 2 hours in seconds
CLEANUP_DAYS = 90

app = Flask(__name__)
app.jinja_env.auto_reload = True
app.config["MAX_CONTENT_LENGTH"] = MAX_FILE_SIZE * MAX_FILES
app.secret_key = os.environ.get("SECRET_KEY", secrets.token_hex(32))


@app.before_request
def log_request():
    ip = request.headers.get("X-Forwarded-For", request.remote_addr)
    username = session.get("username", "anonymous")
    logger.info("REQUEST %s %s | user=%s ip=%s", request.method, request.path, username, ip)


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


def _file_sha1(path: Path) -> str:
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


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


USER_META_FILE = BASE_DIR / "user_meta.json"

def _load_user_meta() -> dict:
    if USER_META_FILE.exists():
        try:
            return json.loads(USER_META_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}

def _save_user_meta(meta: dict) -> None:
    USER_META_FILE.write_text(json.dumps(meta, indent=2), encoding="utf-8")


@app.route("/api/me")
@login_required
def get_me():
    username = session.get("username", "")
    meta = _load_user_meta()
    info = meta.get(username, {})
    return jsonify({
        "username": username,
        "is_admin": username in ADMIN_ROLES,
        "name": info.get("name", username),
        "team": info.get("team", ""),
        "role": info.get("role", ""),
        "profile_pic": info.get("profile_pic", False),
    })


PROFILE_PIC_DIR = BASE_DIR / "profile_pics"
PROFILE_PIC_DIR.mkdir(exist_ok=True)

_default_avatar = PROFILE_PIC_DIR / "_default.svg"
if not _default_avatar.exists():
    _default_avatar.write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80">'
        '<circle cx="40" cy="40" r="40" fill="hsl(220 14% 80%)"/>'
        '<text x="40" y="46" text-anchor="middle" fill="hsl(220 14% 40%)" font-size="28" font-family="sans-serif" font-weight="600">?</text>'
        '</svg>',
        encoding="utf-8",
    )


@app.route("/api/profile-pic/<username>", methods=["GET"])
def get_profile_pic(username: str):
    if username == "default":
        return flask.send_file(str(_default_avatar), mimetype="image/svg+xml")
    for ext in (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"):
        pic = PROFILE_PIC_DIR / f"{username}{ext}"
        if pic.exists():
            mime = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp", "svg": "image/svg+xml"}
            return flask.send_file(str(pic), mimetype=mime.get(ext[1:], "image/png"))
    return flask.send_file(str(_default_avatar), mimetype="image/svg+xml")


@app.route("/api/profile-pic", methods=["PUT"])
@login_required
def upload_profile_pic():
    username = session.get("username", "")
    if "profile_pic" not in request.files:
        return jsonify({"error": "No file provided"}), 400
    file = request.files["profile_pic"]
    if not file.filename:
        return jsonify({"error": "No file selected"}), 400
    ext = Path(file.filename).suffix.lower()
    if ext not in (".png", ".jpg", ".jpeg", ".gif", ".webp"):
        return jsonify({"error": "Invalid image format"}), 400
    dest = PROFILE_PIC_DIR / f"{username}{ext}"
    for old_ext in (".png", ".jpg", ".jpeg", ".gif", ".webp"):
        old = PROFILE_PIC_DIR / f"{username}{old_ext}"
        if old.exists() and old.name != dest.name:
            old.unlink()
    file.save(str(dest))
    meta = _load_user_meta()
    if username not in meta:
        meta[username] = {}
    meta[username]["profile_pic"] = True
    _save_user_meta(meta)
    logger.info("Profile pic updated for '%s'", username)
    return jsonify({"ok": True})


@app.route("/api/billing", methods=["GET"])
@login_required
def get_billing():
    username = session.get("username", "")
    if username in ADMIN_ROLES:
        return jsonify({"entries": [], "total_bills": {}})
    user_dir = UPLOAD_ROOT / "submissions" / username
    entries = []
    meta = _load_user_meta()
    user_meta = meta.get(username, {})
    total_bills = user_meta.get("total_bills", {})
    if user_dir.exists():
        for month_dir in sorted(user_dir.iterdir()):
            if not month_dir.is_dir() or month_dir.name not in VALID_MONTHS:
                continue
            month_name = month_dir.name
            for verdict_folder in ("Real", "Fake"):
                folder = month_dir / verdict_folder
                if not folder.exists():
                    continue
                for f in sorted(folder.iterdir()):
                    if f.is_file() and f.suffix.lower() == ".pdf":
                        entries.append({
                            "month": month_name,
                            "filename": f.name,
                            "folder": verdict_folder,
                        })
    month_file_counts: dict[str, int] = {}
    for e in entries:
        month_file_counts[e["month"]] = month_file_counts.get(e["month"], 0) + 1
    for e in entries:
        m = e["month"]
        bill = total_bills.get(m, 0)
        count = month_file_counts.get(m, 1)
        e["amount"] = round(bill / count, 2) if bill > 0 and count > 0 else 0
    return jsonify({"entries": entries, "total_bills": total_bills})


@app.route("/api/billing/total", methods=["PUT"])
@login_required
def set_total_bill():
    username = session.get("username", "")
    if username in ADMIN_ROLES:
        return jsonify({"error": "Admins cannot set billing"}), 403
    data = request.get_json(silent=True) or {}
    month = (data.get("month") or "").strip()
    if month not in VALID_MONTHS:
        return jsonify({"error": "Invalid month"}), 400
    total = data.get("total_bill", 0)
    try:
        total = float(total)
    except (ValueError, TypeError):
        return jsonify({"error": "Invalid amount"}), 400
    if total < 0:
        return jsonify({"error": "Amount cannot be negative"}), 400
    meta = _load_user_meta()
    if username not in meta:
        meta[username] = {}
    if "total_bills" not in meta[username]:
        meta[username]["total_bills"] = {}
    meta[username]["total_bills"][month] = total
    _save_user_meta(meta)
    logger.info("Total bill set to %.2f for '%s' month %s", total, username, month)
    return jsonify({"ok": True, "total_bill": total, "month": month})


@app.route("/api/admin/verify", methods=["POST"])
@login_required
def toggle_verification():
    if session.get("username") not in ADMIN_ROLES:
        return jsonify({"error": "Forbidden"}), 403
    data = request.get_json(silent=True) or {}
    username = data.get("username", "")
    month = data.get("month", "")
    filename = data.get("filename", "")
    if not username or not month or not filename:
        return jsonify({"error": "Missing fields"}), 400
    safe = secure_filename(filename)
    meta = _load_user_meta()
    if username not in meta:
        meta[username] = {}
    verif_key = f"verified_{month}_{safe}"
    current = meta[username].get("verification", {})
    v = current.get(verif_key, None)
    if v is None:
        current[verif_key] = True
    elif v is True:
        current[verif_key] = False
    else:
        current[verif_key] = None
    meta[username]["verification"] = current
    _save_user_meta(meta)
    new_val = current[verif_key]
    label = "verified" if new_val is True else ("malicious" if new_val is False else "unverified")
    logger.info("Verification toggled for '%s/%s/%s' -> %s by '%s'", username, month, safe, label, session.get("username"))
    return jsonify({"message": f"Marked as {label}", "verified": new_val})


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


@app.route("/api/users/with-passwords", methods=["GET"])
@login_required
def list_users_with_passwords():
    if session.get("username") not in ADMIN_ROLES:
        return jsonify({"error": "Forbidden"}), 403
    users = _load_users()
    return jsonify({"users": [{"username": u, "password": p} for u, p in users.items()]})


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


def _load_reg_requests() -> list[dict]:
    if REG_REQUESTS_FILE.exists():
        try:
            return json.loads(REG_REQUESTS_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return []


def _save_reg_requests(reqs: list[dict]) -> None:
    REG_REQUESTS_FILE.write_text(json.dumps(reqs, indent=2), encoding="utf-8")


@app.route("/register-request")
def register_request_page():
    return render_template("register_request.html")


@app.route("/api/register-request", methods=["POST"])
def submit_register_request():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    team = (data.get("team") or "").strip()
    gmail = (data.get("gmail") or "").strip().lower()
    force = data.get("force", False)

    if not name or not team or not gmail:
        return jsonify({"error": "All fields are required"}), 400

    if "@" not in gmail or "." not in gmail.split("@")[-1]:
        return jsonify({"error": "Please enter a valid email address"}), 400

    requests_list = _load_reg_requests()

    if not force:
        for r in requests_list:
            if r["gmail"] == gmail:
                return jsonify({"error": "You have already asked for invitation", "duplicate": True}), 409

    entry = {
        "name": name,
        "team": team,
        "gmail": gmail,
        "status": "pending",
    }
    requests_list.append(entry)
    _save_reg_requests(requests_list)
    logger.info("Registration request from '%s' (%s)", name, gmail)
    return jsonify({"message": "Your invitation request has been submitted"})


@app.route("/api/admin/registration-requests", methods=["GET"])
@login_required
def list_reg_requests():
    if session.get("username") not in ADMIN_ROLES:
        return jsonify({"error": "Forbidden"}), 403
    return jsonify({"requests": _load_reg_requests()})


@app.route("/api/admin/registration-requests", methods=["DELETE"])
@login_required
def delete_reg_request():
    if session.get("username") not in ADMIN_ROLES:
        return jsonify({"error": "Forbidden"}), 403
    data = request.get_json(silent=True) or {}
    gmail = (data.get("gmail") or "").strip().lower()
    if not gmail:
        return jsonify({"error": "Gmail is required"}), 400
    reqs = _load_reg_requests()
    new_reqs = [r for r in reqs if r["gmail"] != gmail]
    _save_reg_requests(new_reqs)
    logger.info("Registration request deleted for '%s' by '%s'", gmail, session.get("username"))
    return jsonify({"message": "Request removed"})


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


VALID_MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
]


@app.route("/api/submit", methods=["POST"])
@login_required
def submit_files():
    username = session.get("username", "")
    if username in ADMIN_ROLES:
        return jsonify({"error": "Admins cannot submit files this way"}), 403

    month = request.form.get("month", "").strip()
    if month not in VALID_MONTHS:
        return jsonify({"error": "Please select a valid month"}), 400

    files = request.files.getlist("files")
    if not files or all(f.filename == "" for f in files):
        return jsonify({"error": "No files provided"}), 400

    pdf_files = [f for f in files if f.filename and f.filename.lower().endswith(".pdf")]
    if not pdf_files:
        return jsonify({"error": "No PDF files found"}), 400

    valid_pdfs = []
    for f in pdf_files:
        header = f.stream.read(5)
        f.stream.seek(0)
        if header.startswith(b"%PDF"):
            valid_pdfs.append(f)
    if not valid_pdfs:
        return jsonify({"error": "No valid PDF files found"}), 400

    oversized = []
    for f in valid_pdfs:
        f.stream.seek(0, 2)
        size = f.stream.tell()
        f.stream.seek(0)
        if size > MAX_FILE_SIZE:
            oversized.append(f.filename)
    if oversized:
        names = ", ".join(oversized[:5])
        return jsonify({"error": f"Files too large (max {MAX_FILE_SIZE // (1024*1024)} MB): {names}"}), 400

    user_dir = UPLOAD_ROOT / "submissions" / username / month
    real_dir = user_dir / "Real"
    fake_dir = user_dir / "Fake"
    real_dir.mkdir(parents=True, exist_ok=True)
    fake_dir.mkdir(parents=True, exist_ok=True)

    saved = []
    for idx, file in enumerate(valid_pdfs):
        display_name = _display_filename(file.filename, idx)
        safe_name = _safe_storage_name(display_name, idx)
        dest = user_dir / safe_name
        counter = 1
        while dest.exists():
            stem = Path(safe_name).stem
            dest = user_dir / f"{stem}_{counter}.pdf"
            counter += 1
        file.save(str(dest))
        saved.append((safe_name, dest))

    results_path = user_dir / "_results.json"
    existing_results = {}
    if results_path.exists():
        try:
            existing_results = json.loads(results_path.read_text(encoding="utf-8"))
        except Exception:
            existing_results = {}

    new_sha1s = {}
    for safe_name, dest in saved:
        sha1 = _file_sha1(dest)
        new_sha1s[safe_name] = sha1
        try:
            r = analyze_pdfs([(dest, safe_name)])
            if r:
                d = _result_to_dict(r[0])
                d["sha1"] = sha1
                existing_results[safe_name] = d
            else:
                existing_results[safe_name] = {"filename": safe_name, "verdict": "error", "producer": "", "creator": "", "matched_keywords": [], "error_message": "", "sha1": sha1}
        except Exception:
            existing_results[safe_name] = {"filename": safe_name, "verdict": "error", "producer": "", "creator": "", "matched_keywords": [], "error_message": "Analysis failed", "sha1": sha1}

        verdict = existing_results[safe_name].get("verdict", "unknown")
        target_dir = real_dir if verdict == "real" else fake_dir
        final_dest = target_dir / dest.name
        counter = 1
        while final_dest.exists():
            stem = dest.stem
            final_dest = target_dir / f"{stem}_{counter}.pdf"
            counter += 1
        dest.rename(final_dest)

    results_path.write_text(json.dumps(existing_results, indent=2), encoding="utf-8")

    sha1_counts = {}
    for info in existing_results.values():
        s = info.get("sha1", "")
        if s:
            sha1_counts[s] = sha1_counts.get(s, 0) + 1
    duplicate_files = [name for name, sha1 in new_sha1s.items() if sha1_counts.get(sha1, 0) > 1]

    logger.info("User '%s' submitted %d files", username, len(saved))
    return jsonify({"message": f"{len(saved)} file(s) submitted successfully", "files": [s for s, _ in saved], "duplicate_files": duplicate_files})


@app.route("/api/check-duplicates", methods=["POST"])
@login_required
def check_duplicates():
    username = session.get("username", "")
    if username in ADMIN_ROLES:
        return jsonify({"duplicates": []})

    data = request.get_json(silent=True) or {}
    hashes = data.get("hashes", [])

    user_dir = UPLOAD_ROOT / "submissions" / username
    results_path = user_dir / "_results.json"
    if not results_path.exists():
        return jsonify({"duplicates": []})

    try:
        results = json.loads(results_path.read_text(encoding="utf-8"))
    except Exception:
        return jsonify({"duplicates": []})

    existing_sha1s = {info.get("sha1", "") for info in results.values() if info.get("sha1")}
    duplicates = [h for h in hashes if h in existing_sha1s]
    logger.info("check_duplicates user=%s incoming=%d existing=%d dupes=%d", username, len(hashes), len(existing_sha1s), len(duplicates))
    return jsonify({"duplicates": duplicates})


@app.route("/api/my-submissions", methods=["GET"])
@login_required
def my_submissions():
    username = session.get("username", "")
    if username in ADMIN_ROLES:
        return jsonify({"error": "Admins cannot view submissions this way"}), 403

    user_dir = UPLOAD_ROOT / "submissions" / username
    if not user_dir.exists():
        return jsonify({"files": []})

    now = time.time()
    files = []
    for month_name in sorted(user_dir.iterdir()):
        if not month_name.is_dir() or month_name.name not in VALID_MONTHS:
            continue
        for verdict_folder in ("Real", "Fake"):
            folder = month_name / verdict_folder
            if not folder.exists():
                continue
            for f in sorted(folder.iterdir()):
                if f.is_file() and f.suffix.lower() == ".pdf":
                    mtime = f.stat().st_mtime
                    age = now - mtime
                    files.append({
                        "name": f.name,
                        "size": f.stat().st_size,
                        "uploaded": mtime,
                        "can_delete": age < DELETE_TIME_LIMIT,
                        "remaining": max(0, int(DELETE_TIME_LIMIT - age)),
                        "month": month_name.name,
                    })

    month_order = {m: i for i, m in enumerate(VALID_MONTHS)}
    files.sort(key=lambda x: (month_order.get(x["month"], 99), x["name"]))
    return jsonify({"files": files})


@app.route("/api/my-submissions/<month>/<filename>", methods=["DELETE"])
@login_required
def delete_my_submission(month: str, filename: str):
    username = session.get("username", "")
    if username in ADMIN_ROLES:
        return jsonify({"error": "Admins cannot delete this way"}), 403
    if month not in VALID_MONTHS:
        return jsonify({"error": "Invalid month"}), 400

    safe = secure_filename(filename)
    user_dir = UPLOAD_ROOT / "submissions" / username / month
    file_path = None
    for folder in ("Real", "Fake"):
        candidate = user_dir / folder / safe
        if candidate.exists():
            file_path = candidate
            break
    if file_path is None:
        return jsonify({"error": "File not found"}), 404

    age = time.time() - file_path.stat().st_mtime
    if age >= DELETE_TIME_LIMIT:
        return jsonify({"error": "Cannot delete after 2 hours"}), 403

    file_path.unlink()
    logger.info("User '%s' deleted '%s' from %s", username, safe, month)
    return jsonify({"message": f"Deleted {safe}"})


@app.route("/api/admin/uploads", methods=["GET"])
@login_required
def admin_uploads():
    if session.get("username") not in ADMIN_ROLES:
        return jsonify({"error": "Forbidden"}), 403

    submissions_dir = UPLOAD_ROOT / "submissions"
    users = _load_users()
    normal_users = {u for u in users if u not in ADMIN_ROLES}

    month_order = {m: i for i, m in enumerate(VALID_MONTHS)}

    uploaded = {}
    if submissions_dir.exists():
        for user_dir in submissions_dir.iterdir():
            if user_dir.is_dir() and user_dir.name in normal_users:
                files = []
                for month_dir in sorted(user_dir.iterdir(), key=lambda d: month_order.get(d.name, 99)):
                    if not month_dir.is_dir() or month_dir.name not in VALID_MONTHS:
                        continue
                    for verdict_folder in ("Real", "Fake"):
                        folder = month_dir / verdict_folder
                        if folder.exists():
                            for f in sorted(folder.iterdir()):
                                if f.is_file() and f.suffix.lower() == ".pdf":
                                    files.append((verdict_folder, month_dir.name, f.name))
                uploaded[user_dir.name] = files

    result = []

    sha1_to_files: dict[str, list[str]] = {}
    all_user_results: dict[str, dict] = {}
    for username in sorted(normal_users):
        user_dir = submissions_dir / username
        if not user_dir.exists():
            continue
        for month_dir in user_dir.iterdir():
            if not month_dir.is_dir() or month_dir.name not in VALID_MONTHS:
                continue
            results_path = month_dir / "_results.json"
            if not results_path.exists():
                continue
            try:
                results = json.loads(results_path.read_text(encoding="utf-8"))
            except Exception:
                continue
            for fname, info in results.items():
                sha1 = info.get("sha1", "")
                if sha1:
                    key = f"{username}/{month_dir.name}/{fname}"
                    sha1_to_files.setdefault(sha1, []).append(key)

    for username in sorted(normal_users):
        files = uploaded.get(username, [])
        file_data = []
        for folder, month_name, fname in files:
            month_dir = submissions_dir / username / month_name
            results_path = month_dir / "_results.json"
            results = {}
            if results_path.exists():
                try:
                    results = json.loads(results_path.read_text(encoding="utf-8"))
                except Exception:
                    pass
            info = results.get(fname, {})
            sha1 = info.get("sha1", "")
            is_duplicate = len(sha1_to_files.get(sha1, [])) > 1 if sha1 else False
            user_meta_all = _load_user_meta()
            umeta = user_meta_all.get(username, {})
            verif_map = umeta.get("verification", {})
            verif_key = f"verified_{month_name}_{fname}"
            verified_val = verif_map.get(verif_key)
            file_data.append({
                "name": fname,
                "verdict": info.get("verdict", ""),
                "producer": info.get("producer", ""),
                "creator": info.get("creator", ""),
                "folder": folder,
                "duplicate": is_duplicate,
                "month": month_name,
                "verified": verified_val,
            })
        result.append({"username": username, "files": file_data, "count": len(files)})

    return jsonify({"users": result})


@app.route("/api/admin/uploads/<username>/<month>/<filename>", methods=["DELETE"])
@login_required
def admin_delete_upload(username: str, month: str, filename: str):
    if session.get("username") not in ADMIN_ROLES:
        return jsonify({"error": "Forbidden"}), 403
    if month not in VALID_MONTHS:
        return jsonify({"error": "Invalid month"}), 400

    safe = secure_filename(filename)
    user_dir = UPLOAD_ROOT / "submissions" / username / month
    file_path = None
    for folder in ("Real", "Fake"):
        candidate = user_dir / folder / safe
        if candidate.exists():
            file_path = candidate
            break
    if file_path is None:
        return jsonify({"error": "File not found"}), 404

    file_path.unlink()
    logger.info("Admin deleted '%s/%s/%s'", username, month, safe)
    return jsonify({"message": f"Deleted {safe}"})


@app.route("/api/admin/open-folder/<username>", methods=["GET"])
@login_required
def open_folder(username: str):
    if session.get("username") not in ADMIN_ROLES:
        return jsonify({"error": "Forbidden"}), 403

    user_dir = UPLOAD_ROOT / "submissions" / username
    if not user_dir.exists():
        return jsonify({"error": "Folder not found"}), 404

    import subprocess
    subprocess.Popen(["explorer", str(user_dir)])
    logger.info("Admin '%s' opened folder for '%s'", session.get("username"), username)
    return jsonify({"ok": True, "path": str(user_dir)})


def _load_site_config() -> dict:
    if SITE_CONFIG_FILE.exists():
        try:
            return json.loads(SITE_CONFIG_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"daily_quote": "", "maintenance_message": ""}


def _save_site_config(cfg: dict) -> None:
    SITE_CONFIG_FILE.write_text(json.dumps(cfg, indent=2), encoding="utf-8")


@app.route("/api/site-config", methods=["GET"])
def get_site_config():
    cfg = _load_site_config()
    return jsonify({"daily_quote": cfg["daily_quote"], "maintenance_message": cfg["maintenance_message"]})


@app.route("/api/admin/site-config", methods=["PUT"])
@login_required
def update_site_config():
    if session.get("username") not in ADMIN_ROLES:
        return jsonify({"error": "Forbidden"}), 403
    data = request.get_json(silent=True) or {}
    cfg = _load_site_config()
    if "daily_quote" in data:
        cfg["daily_quote"] = data["daily_quote"]
    if "maintenance_message" in data:
        cfg["maintenance_message"] = data["maintenance_message"]
    _save_site_config(cfg)
    logger.info("Site config updated by '%s'", session.get("username"))
    return jsonify({"ok": True, "daily_quote": cfg["daily_quote"], "maintenance_message": cfg["maintenance_message"]})


@app.route("/api/admin/cleanup-status", methods=["GET"])
@login_required
def cleanup_status():
    if session.get("username") not in ADMIN_ROLES:
        return jsonify({"error": "Forbidden"}), 403
    enabled = CLEANUP_TOGGLE_FILE.exists() and CLEANUP_TOGGLE_FILE.read_text().strip() == "1"
    return jsonify({"enabled": enabled, "days": CLEANUP_DAYS})


@app.route("/api/admin/cleanup-toggle", methods=["POST"])
@login_required
def cleanup_toggle():
    if session.get("username") not in ADMIN_ROLES:
        return jsonify({"error": "Forbidden"}), 403
    data = request.get_json(silent=True) or {}
    enabled = data.get("enabled", False)
    if enabled:
        CLEANUP_TOGGLE_FILE.write_text("1")
        logger.info("Auto-cleanup ENABLED by '%s'", session.get("username"))
    else:
        CLEANUP_TOGGLE_FILE.write_text("0")
        logger.info("Auto-cleanup DISABLED by '%s'", session.get("username"))
    return jsonify({"enabled": enabled})


@app.route("/api/admin/cleanup", methods=["POST"])
@login_required
def run_cleanup():
    if session.get("username") not in ADMIN_ROLES:
        return jsonify({"error": "Forbidden"}), 403

    submissions_dir = UPLOAD_ROOT / "submissions"
    errors = []
    if submissions_dir.exists():
        for item in submissions_dir.rglob("*"):
            if item.is_file():
                try:
                    item.chmod(0o777)
                    item.unlink()
                except Exception as e:
                    errors.append(str(item.name))
        for item in list(submissions_dir.rglob("*"))[::-1]:
            if item.is_dir():
                try:
                    item.rmdir()
                except Exception:
                    pass
        if not errors:
            try:
                submissions_dir.rmdir()
            except Exception:
                pass
        logger.info("Cleanup by '%s' — %d errors", session.get("username"), len(errors))

    if errors:
        return jsonify({"error": f"Could not delete {len(errors)} file(s): {', '.join(errors[:5])}"}), 500
    return jsonify({"deleted": 0})


@app.route("/api/logs", methods=["GET"])
@login_required
def get_logs():
    if session.get("username") != "IT":
        return jsonify({"error": "Forbidden"}), 403

    log_file = LOGS_DIR / "app.log"
    if not log_file.exists():
        return jsonify({"logs": ""})

    lines = log_file.read_text(encoding="utf-8", errors="ignore").splitlines()
    tail = lines[-500:]
    return jsonify({"logs": "\n".join(tail)})


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
    print("\n  Zenov Conveyance Management is running")
    print(f"  On this PC:  http://127.0.0.1:{port}")
    for ip in local_ips():
        print(f"  On your WiFi: http://{ip}:{port}")
    print("\n  Other devices on the same WiFi can use the WiFi address above.\n")

    debug = os.environ.get("FLASK_DEBUG", "0") == "1"
    app.run(host="0.0.0.0", debug=debug, threaded=True, port=port)
