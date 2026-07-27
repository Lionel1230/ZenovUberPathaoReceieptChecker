"""Thread-safe job store for upload + analysis progress tracking."""

from __future__ import annotations

import logging
import threading
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

JOB_TTL_SECONDS = 3600  # auto-cleanup jobs older than 1 hour


class JobStatus(str, Enum):
    UPLOADING = "uploading"
    ANALYZING = "analyzing"
    COMPLETED = "completed"
    FAILED = "failed"


@dataclass
class Job:
    id: str
    status: JobStatus = JobStatus.UPLOADING
    upload_progress: int = 0
    analyze_progress: int = 0
    total_files: int = 0
    analyzed_count: int = 0
    results: list[dict[str, Any]] = field(default_factory=list)
    error: str = ""
    upload_dir: Path | None = None
    created_at: float = field(default_factory=time.time)


class JobStore:
    """In-memory job registry guarded by a lock."""

    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()

    def create(self, upload_dir: Path | None = None) -> Job:
        job_id = uuid.uuid4().hex
        job = Job(id=job_id, upload_dir=upload_dir)
        with self._lock:
            self._jobs[job_id] = job
        return job

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            return Job(
                id=job.id,
                status=job.status,
                upload_progress=job.upload_progress,
                analyze_progress=job.analyze_progress,
                total_files=job.total_files,
                analyzed_count=job.analyzed_count,
                results=list(job.results),
                error=job.error,
                upload_dir=job.upload_dir,
                created_at=job.created_at,
            )

    def update(self, job_id: str, **kwargs: Any) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job:
                for key, value in kwargs.items():
                    setattr(job, key, value)

    def to_dict(self, job: Job) -> dict[str, Any]:
        with self._lock:
            return {
                "id": job.id,
                "status": job.status.value,
                "upload_progress": job.upload_progress,
                "analyze_progress": job.analyze_progress,
                "total_files": job.total_files,
                "analyzed_count": job.analyzed_count,
                "results": list(job.results),
                "error": job.error,
            }

    def cleanup(self, job_id: str) -> None:
        with self._lock:
            self._jobs.pop(job_id, None)

    def cleanup_old_jobs(self) -> int:
        """Remove jobs older than JOB_TTL_SECONDS. Returns count removed."""
        now = time.time()
        removed = 0
        with self._lock:
            expired = [
                jid
                for jid, job in self._jobs.items()
                if job.status in (JobStatus.COMPLETED, JobStatus.FAILED)
                and (now - job.created_at) > JOB_TTL_SECONDS
            ]
            for jid in expired:
                self._jobs.pop(jid)
                removed += 1
        if removed:
            logger.info("Cleaned up %d expired jobs", removed)
        return removed


job_store = JobStore()
