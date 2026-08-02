"""Load test — the site must survive ~200 concurrent visitors without errors."""
from __future__ import annotations

import http.cookiejar
import io
import logging
import threading
import time
import urllib.parse
import urllib.request

import pytest

import app as app_module

logger = logging.getLogger("werkzeug")
logger.setLevel(logging.CRITICAL)  # silence the dev server request log


@pytest.fixture
def live_server():
    """Run the real app on an ephemeral local port with a threaded WSGI server."""
    from werkzeug.serving import make_server

    server = make_server("127.0.0.1", 0, app_module.app, threaded=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}"
    yield base
    server.shutdown()
    thread.join(timeout=5)


def make_opener():
    jar = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def http_get(base, path, opener, timeout=30):
    return opener.open(base + path, timeout=timeout)


def http_post_form(base, path, opener, data, timeout=30):
    body = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(base + path, data=body, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    return opener.open(req, timeout=timeout)


def http_post_multipart(base, path, opener, filename, content, timeout=60):
    boundary = "----testboundary123"
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="files"; filename="{filename}"\r\n'
        "Content-Type: application/pdf\r\n\r\n"
    ).encode() + content + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(base + path, data=body, method="POST")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    return opener.open(req, timeout=timeout)


class TestLoad:
    def test_200_concurrent_visitors(self, live_server):
        base = live_server
        n = 200
        errors: list[str] = []
        results: list[tuple[str, int]] = []
        barrier = threading.Barrier(n)

        def visitor(i):
            try:
                opener = make_opener()
                barrier.wait()
                # anonymous page hit
                r = http_get(base, "/login", opener)
                results.append(("anon_get_login", r.status))

                # log in as a normal user
                role = "user" if i % 2 == 0 else "admin"
                r = http_post_form(base, "/login", opener, {"username": role, "password": role})
                results.append(("post_login", r.status))

                # authenticated API call
                r = http_get(base, "/api/me", opener)
                results.append(("api_me", r.status))
            except Exception as exc:  # pragma: no cover
                errors.append(f"visitor {i}: {exc!r}")

        threads = [threading.Thread(target=visitor, args=(i,)) for i in range(n)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=120)

        assert not errors, errors[:5]
        assert len(results) == n * 3
        fivexx = [s for _, s in results if s >= 500]
        assert not fivexx, f"server returned 5xx: {fivexx[:5]}"
        assert all(s == 200 for _, s in results)

        # server must still be alive afterwards
        assert http_get(base, "/login", make_opener()).status == 200

    def test_concurrent_uploads_survive(self, live_server):
        base = live_server
        n = 25
        errors: list[str] = []
        job_ids: list[str] = []
        barrier = threading.Barrier(n)

        def uploader(i):
            try:
                opener = make_opener()
                http_post_form(base, "/login", opener, {"username": "user", "password": "user"})
                barrier.wait()
                r = http_post_multipart(base, "/api/upload", opener, f"r{i}.pdf", b"%PDF-1.4 fake")
                body = r.read()
                import json

                job_ids.append(json.loads(body)["job_id"])
            except Exception as exc:  # pragma: no cover
                errors.append(f"uploader {i}: {exc!r}")

        threads = [threading.Thread(target=uploader, args=(i,)) for i in range(n)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=120)

        assert not errors, errors[:5]
        assert len(job_ids) == n

        # poll every job until it finishes (or timeout)
        opener = make_opener()
        http_post_form(base, "/login", opener, {"username": "user", "password": "user"})
        deadline = time.time() + 30
        unfinished = list(job_ids)
        while unfinished and time.time() < deadline:
            still = []
            for jid in unfinished:
                try:
                    r = http_get(base, f"/api/jobs/{jid}", opener)
                    status = r.status
                    if status != 200:
                        errors.append(f"job {jid} status {status}")
                        continue
                    import json

                    state = json.loads(r.read().decode())["status"]
                    if state not in ("completed", "failed"):
                        still.append(jid)
                except Exception as exc:  # pragma: no cover
                    errors.append(f"job poll {jid}: {exc!r}")
            unfinished = still
            if unfinished:
                time.sleep(0.1)

        assert not errors, errors[:5]
        assert not unfinished, f"jobs did not finish: {unfinished}"
