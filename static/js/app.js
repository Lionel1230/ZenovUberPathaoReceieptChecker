(() => {
  "use strict";

  const fileInput = document.getElementById("fileInput");
  const folderInput = document.getElementById("folderInput");
  const dropZone = document.getElementById("dropZone");
  const progressSection = document.getElementById("progressSection");
  const resultsSection = document.getElementById("resultsSection");
  const errorAlert = document.getElementById("errorAlert");
  const uploadBar = document.getElementById("uploadBar");
  const analyzeBar = document.getElementById("analyzeBar");
  const uploadPct = document.getElementById("uploadPct");
  const analyzePct = document.getElementById("analyzePct");
  const analyzeDetail = document.getElementById("analyzeDetail");
  const resultsGrid = document.getElementById("resultsGrid");
  const summaryBadges = document.getElementById("summaryBadges");

  let pollTimer = null;
  let busy = false;
  let currentUser = window.__CURRENT_USER || "";
  let isAdmin = ["root", "admin", "IT"].includes(currentUser);

  if (!currentUser) {
    fetch("/api/me")
      .then((r) => r.json())
      .then((data) => {
        currentUser = data.username;
        isAdmin = data.is_admin;
        updateAdminUI();
      })
      .catch(() => {});
  }

  function updateAdminUI() {
    const btn = document.getElementById("manageUsersBtn");
    const title = document.getElementById("headerTitle");
    const subtitle = document.getElementById("headerSubtitle");
    const warning = document.getElementById("headerWarning");
    if (btn) btn.classList.toggle("hidden", !isAdmin);
    if (title) title.textContent = isAdmin ? "Zenov Conveyance Management" : "Zenov Conveyance Management";
    if (subtitle) subtitle.classList.toggle("hidden", !isAdmin);
    if (warning) warning.classList.toggle("hidden", isAdmin);
  }

  function showError(msg) {
    errorAlert.textContent = msg;
    errorAlert.classList.remove("hidden");
  }

  function hideError() {
    errorAlert.classList.add("hidden");
  }

  function resetUI() {
    hideError();
    resultsSection.classList.add("hidden");
    resultsGrid.innerHTML = "";
    summaryBadges.innerHTML = "";
    setProgress(uploadBar, uploadPct, 0);
    setProgress(analyzeBar, analyzePct, 0);
    analyzeDetail.textContent = "";
  }

  function setProgress(bar, label, pct) {
    const clamped = Math.min(100, Math.max(0, pct));
    bar.style.width = `${clamped}%`;
    label.textContent = `${clamped}%`;
  }

  function filterPdfs(fileList) {
    return Array.from(fileList).filter(
      (f) => f.name.toLowerCase().endsWith(".pdf")
    );
  }

  function handleFiles(fileList) {
    if (busy) return;

    const pdfs = filterPdfs(fileList);
    if (pdfs.length === 0) {
      showError("No PDF files found. Please select PDF files only.");
      return;
    }

    resetUI();
    progressSection.classList.remove("hidden");
    busy = true;
    uploadFiles(pdfs);
  }

  function uploadFiles(files) {
    const formData = new FormData();
    files.forEach((f) => formData.append("files", f));

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");

    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        setProgress(uploadBar, uploadPct, pct);
      }
    });

    xhr.addEventListener("load", () => {
      if (xhr.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        const data = JSON.parse(xhr.responseText);
        setProgress(uploadBar, uploadPct, 100);
        pollJob(data.job_id);
      } else {
        let msg = "Upload failed";
        try {
          const err = JSON.parse(xhr.responseText);
          msg = err.error || msg;
        } catch (_) { /* ignore */ }
        showError(msg);
        busy = false;
      }
    });

    xhr.addEventListener("error", () => {
      showError("Network error during upload. Please try again.");
      busy = false;
    });

    xhr.addEventListener("timeout", () => {
      showError("Upload timed out. Try fewer or smaller files.");
      busy = false;
    });

    xhr.timeout = 600000; // 10 min
    xhr.send(formData);
  }

  function pollJob(jobId) {
    if (pollTimer) clearInterval(pollTimer);

    pollTimer = setInterval(async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}`);
        if (res.status === 401) {
          clearInterval(pollTimer);
          pollTimer = null;
          window.location.href = "/login";
          return;
        }
        if (!res.ok) throw new Error("Job not found");

        const job = await res.json();

        setProgress(analyzeBar, analyzePct, job.analyze_progress);

        if (job.total_files > 0) {
          analyzeDetail.textContent = `${job.analyzed_count} / ${job.total_files} files analyzed`;
        }

        if (job.status === "completed") {
          clearInterval(pollTimer);
          pollTimer = null;
          setProgress(analyzeBar, analyzePct, 100);
          renderResults(job.results);
          busy = false;
        } else if (job.status === "failed") {
          clearInterval(pollTimer);
          pollTimer = null;
          showError(job.error || "Analysis failed");
          busy = false;
        }
      } catch (err) {
        clearInterval(pollTimer);
        pollTimer = null;
        showError("Lost connection while checking progress.");
        busy = false;
      }
    }, 1500);
  }

  function renderResults(results) {
    if (!results || results.length === 0) {
      showError("No results returned.");
      return;
    }

    resultsSection.classList.remove("hidden");

    const counts = { real: 0, fake: 0, unknown: 0, error: 0 };
    results.forEach((r) => {
      if (counts[r.verdict] !== undefined) counts[r.verdict]++;
    });

    summaryBadges.innerHTML = Object.entries(counts)
      .filter(([, c]) => c > 0)
      .map(
        ([v, c]) =>
          `<span class="summary-badge ${v}">${c} ${verdictLabel(v)}</span>`
      )
      .join("");

    resultsGrid.innerHTML = results
      .map((r) => {
        const icon = verdictIcon(r.verdict);
        const label = verdictLabel(r.verdict);
        const meta = buildMeta(r);

        return `
          <div class="result-card">
            <div class="result-icon ${r.verdict}">${icon}</div>
            <div class="result-info">
              <div class="result-filename" title="${escapeHtml(r.filename)}">${escapeHtml(r.filename)}</div>
              <div class="result-meta">${meta}</div>
            </div>
            <span class="result-verdict ${r.verdict}">${label}</span>
          </div>`;
      })
      .join("");
  }

  function verdictIcon(v) {
    const icons = { real: "✓", fake: "✗", unknown: "?", error: "!" };
    return icons[v] || "?";
  }

  function verdictLabel(v) {
    if (isAdmin) {
      const labels = { real: "Real PDF", fake: "Fake PDF", unknown: "Unknown", error: "Error" };
      return labels[v] || v;
    }
    const labels = { real: "Good to upload", fake: "Contact IT", unknown: "Check manually", error: "Error" };
    return labels[v] || v;
  }

  function buildMeta(r) {
    if (!isAdmin) return "";
    const parts = [];
    if (r.producer) parts.push(`Producer: ${escapeHtml(r.producer)}`);
    if (r.creator) parts.push(`Creator: ${escapeHtml(r.creator)}`);
    if (r.matched_keywords.length)
      parts.push(`Matched: ${r.matched_keywords.join(", ")}`);
    if (r.error_message) parts.push(escapeHtml(r.error_message));
    return parts.join(" · ") || "No metadata keywords found";
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  /* User Management Modal */
  function generatePassword(len) {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%&*";
    let pw = "";
    const arr = new Uint32Array(len);
    crypto.getRandomValues(arr);
    for (let i = 0; i < len; i++) pw += chars[arr[i] % chars.length];
    return pw;
  }

  function openUserModal() {
    document.getElementById("userModalOverlay").classList.remove("hidden");
    loadUserList();
    document.getElementById("newUsername").value = "";
    document.getElementById("newPassword").value = "";
    document.getElementById("userModalError").classList.add("hidden");
  }

  function closeUserModal() {
    document.getElementById("userModalOverlay").classList.add("hidden");
  }

  async function loadUserList() {
    const list = document.getElementById("userList");
    try {
      const res = await fetch("/api/users");
      if (!res.ok) return;
      const data = await res.json();
      list.innerHTML = data.users
        .map(
          (u) => `
          <div class="user-row">
            <span class="user-name">${escapeHtml(u.username)}</span>
            ${u.username !== "root" && u.username !== currentUser ? `<button class="btn-icon btn-danger-icon" data-delete="${escapeHtml(u.username)}" title="Delete user">✕</button>` : ""}
          </div>`
        )
        .join("");

      list.querySelectorAll("[data-delete]").forEach((btn) => {
        btn.addEventListener("click", () => deleteUser(btn.dataset.delete));
      });
    } catch (_) {
      list.innerHTML = '<p class="text-muted">Failed to load users</p>';
    }
  }

  async function createUser() {
    const username = document.getElementById("newUsername").value.trim();
    const password = document.getElementById("newPassword").value.trim();
    const errEl = document.getElementById("userModalError");
    errEl.classList.add("hidden");

    if (!username || !password) {
      errEl.textContent = "Username and password are required";
      errEl.classList.remove("hidden");
      return;
    }

    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        errEl.textContent = data.error;
        errEl.classList.remove("hidden");
        return;
      }
      document.getElementById("newUsername").value = "";
      document.getElementById("newPassword").value = "";
      loadUserList();
    } catch (_) {
      errEl.textContent = "Failed to create user";
      errEl.classList.remove("hidden");
    }
  }

  async function deleteUser(username) {
    if (!confirm(`Delete user "${username}"?`)) return;
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(username)}`, { method: "DELETE" });
      if (res.ok) loadUserList();
    } catch (_) {}
  }

  /* Event listeners */
  fileInput.addEventListener("change", () => {
    if (fileInput.files.length) handleFiles(fileInput.files);
    fileInput.value = "";
  });

  folderInput.addEventListener("change", () => {
    if (folderInput.files.length) handleFiles(folderInput.files);
    folderInput.value = "";
  });

  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("drag-over");
  });

  dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("drag-over");
  });

  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  });

  document.getElementById("manageUsersBtn").addEventListener("click", openUserModal);
  document.getElementById("closeUserModal").addEventListener("click", closeUserModal);
  document.getElementById("userModalOverlay").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeUserModal();
  });
  document.getElementById("createUserBtn").addEventListener("click", createUser);
  document.getElementById("generatePwBtn").addEventListener("click", () => {
    document.getElementById("newPassword").value = generatePassword(16);
  });

  updateAdminUI();
})();
