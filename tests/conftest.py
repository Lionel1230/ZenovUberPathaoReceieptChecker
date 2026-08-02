"""pytest configuration — sets TEST_DATA_DIR before any app imports."""
import json
import os
import shutil
import tempfile

import pytest

# Must run before any test module is imported.
_tmp = tempfile.mkdtemp()
os.environ["TEST_DATA_DIR"] = _tmp

# Seed required files
with open(os.path.join(_tmp, "users.txt"), "w") as f:
    f.write("admin:admin\nuser:user\n")
os.makedirs(os.path.join(_tmp, "uploads", "submissions"), exist_ok=True)
os.makedirs(os.path.join(_tmp, "logs"), exist_ok=True)

import app as app_module  # noqa: E402


@pytest.fixture
def users_file():
    return app_module.USERS_FILE


@pytest.fixture
def reg_file():
    return app_module.REG_REQUESTS_FILE


@pytest.fixture
def cleanup_file():
    return app_module.CLEANUP_TOGGLE_FILE


@pytest.fixture
def all_hashes_file():
    return app_module.ALL_HASHES_FILE


@pytest.fixture(autouse=True)
def reset_state(users_file, reg_file, all_hashes_file):
    """Reset shared state files before each test to avoid cross-test pollution."""
    users_file.write_text("admin:admin\nuser:user\n")
    reg_file.write_text("[]")
    all_hashes_file.write_text("{}")
    submissions_dir = app_module.UPLOAD_ROOT / "submissions"
    if submissions_dir.exists():
        shutil.rmtree(submissions_dir, ignore_errors=True)
    submissions_dir.mkdir(parents=True, exist_ok=True)
    yield
    _tmp_upload = app_module.UPLOAD_ROOT / "submissions"
    if _tmp_upload.exists():
        shutil.rmtree(_tmp_upload, ignore_errors=True)
