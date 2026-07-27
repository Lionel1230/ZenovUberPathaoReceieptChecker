"""Flask web application for PDF metadata analysis."""

from __future__ import annotations

import logging
import os
import shutil
import threading
from pathlib import Path

from flask import Flask, jsonify, render_template, request
from werkzeug.utils import secure_filename

from analyzer import analyze_pdfs
from jobs import JobStatus, job_store

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent
UPLOAD_ROOT = BASE_DIR / "uploads"
UPLOAD_ROOT.mkdir(exist_ok=True)

MAX_FILE_SIZE = 50 * 1024 * 1024  # 50 MB per file
MAX_FILES = 200

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_FILE_SIZE * MAX_FILES


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


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/jobs/<job_id>", methods=["GET"])
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
