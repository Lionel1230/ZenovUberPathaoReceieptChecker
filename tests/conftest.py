"""pytest configuration — sets TEST_DATA_DIR before any app imports."""
import os
import tempfile

# Must run before any test module is imported.
_tmp = tempfile.mkdtemp()
os.environ["TEST_DATA_DIR"] = _tmp

# Seed required files
with open(os.path.join(_tmp, "users.txt"), "w") as f:
    f.write("admin:admin\nuser:user\n")
os.makedirs(os.path.join(_tmp, "uploads", "submissions"), exist_ok=True)
os.makedirs(os.path.join(_tmp, "logs"), exist_ok=True)
