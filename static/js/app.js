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
  const stagingSection = document.getElementById("stagingSection");
  const stagingList = document.getElementById("stagingList");

  let pollTimer = null;
  let busy = false;
  let currentUser = window.__CURRENT_USER || "";
  let isAdmin = ["root", "admin", "IT"].includes(currentUser);
  let stagedFiles = [];

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
    const uploadsBtn = document.getElementById("uploadsBtn");
    const siteSettingsBtn = document.getElementById("siteSettingsBtn");
    const regRequestsBtn = document.getElementById("regRequestsBtn");
    const title = document.getElementById("headerTitle");
    const subtitle = document.getElementById("headerSubtitle");
    const warning = document.getElementById("headerWarning");
    if (btn) btn.classList.toggle("hidden", !isAdmin);
    if (uploadsBtn) uploadsBtn.classList.toggle("hidden", !isAdmin);
    if (siteSettingsBtn) siteSettingsBtn.classList.toggle("hidden", !isAdmin);
    if (regRequestsBtn) regRequestsBtn.classList.toggle("hidden", !isAdmin);
    if (title) title.textContent = "Zenov Conveyance Management";
    if (subtitle) subtitle.classList.toggle("hidden", !isAdmin);
    if (warning) warning.classList.toggle("hidden", isAdmin);
    if (!isAdmin) loadMySubmissions();
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

    if (isAdmin) {
      resetUI();
      progressSection.classList.remove("hidden");
      busy = true;
      uploadFiles(pdfs);
    } else {
      addFilesToStaging(pdfs);
    }
  }

  function addFilesToStaging(files) {
    files.forEach((f) => {
      if (!stagedFiles.some((s) => s.name === f.name && s.size === f.size)) {
        stagedFiles.push(f);
      }
    });
    renderStaging();
  }

  function renderStaging() {
    if (stagedFiles.length === 0) {
      stagingSection.classList.add("hidden");
      return;
    }
    stagingSection.classList.remove("hidden");
    stagingList.innerHTML = stagedFiles
      .map(
        (f, i) => `
        <div class="staging-item">
          <span class="staging-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
          <span class="staging-size">${(f.size / (1024 * 1024)).toFixed(2)} MB</span>
          <button class="btn-icon btn-danger-icon" data-remove="${i}" title="Remove">✕</button>
        </div>`
      )
      .join("");
    stagingList.querySelectorAll("[data-remove]").forEach((btn) => {
      btn.addEventListener("click", () => {
        stagedFiles.splice(parseInt(btn.dataset.remove), 1);
        renderStaging();
      });
    });
  }

  async function submitStagedFiles() {
    if (stagedFiles.length === 0 || busy) return;
    busy = true;
    hideError();

    const formData = new FormData();
    stagedFiles.forEach((f) => formData.append("files", f));

    try {
      const res = await fetch("/api/submit", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) {
        showError(data.error || "Submit failed");
        busy = false;
        return;
      }
      stagedFiles = [];
      renderStaging();
      showSuccess(data.message);
      loadMySubmissions();

      busy = false;
    } catch (_) {
      showError("Network error during submit");
      busy = false;
    }
  }

  function showSuccess(msg) {
    errorAlert.textContent = msg;
    errorAlert.classList.remove("hidden");
    errorAlert.style.background = "var(--real-bg)";
    errorAlert.style.borderColor = "var(--real)";
    errorAlert.style.color = "var(--real)";
    setTimeout(() => {
      errorAlert.classList.add("hidden");
      errorAlert.style.background = "";
      errorAlert.style.borderColor = "";
      errorAlert.style.color = "";
    }, 4000);
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

  let showPasswords = false;

  async function loadUserList() {
    const list = document.getElementById("userList");
    try {
      const res = showPasswords
        ? await fetch("/api/users/with-passwords")
        : await fetch("/api/users");
      if (!res.ok) return;
      const data = await res.json();
      list.innerHTML = data.users
        .map(
          (u) => `
          <div class="user-row">
            <span class="user-name">${escapeHtml(u.username)}</span>
            ${showPasswords && u.password ? `<span class="user-password">${escapeHtml(u.password)}</span>` : ""}
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
    if (!confirm("Are you really sure? This cannot be undone.")) return;
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(username)}`, { method: "DELETE" });
      if (res.ok) loadUserList();
    } catch (_) {}
  }

  /* My Submissions */
  async function loadMySubmissions() {
    if (isAdmin) return;
    try {
      const res = await fetch("/api/my-submissions");
      if (res.status === 401) { window.location.href = "/login"; return; }
      if (!res.ok) return;
      const data = await res.json();
      const section = document.getElementById("mySubmissions");
      const list = document.getElementById("mySubmissionsList");

      if (data.files.length === 0) {
        section.classList.add("hidden");
        return;
      }

      section.classList.remove("hidden");
      list.innerHTML = data.files
        .map((f) => {
          const sizeMB = (f.size / (1024 * 1024)).toFixed(2);
          const remaining = formatRemaining(f.remaining);
          return `
          <div class="my-submission-item${f.duplicate ? " is-duplicate" : ""}">
            <div class="my-submission-info">
              <span class="my-submission-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
              <span class="my-submission-meta">${sizeMB} MB${f.can_delete ? " · " + remaining : " · Delete expired"}</span>
            </div>
            ${f.duplicate ? `<span class="my-submission-dup-badge">Duplicate</span>` : ""}
            ${f.can_delete ? `<button class="btn-icon btn-danger-icon" data-my-delete="${escapeHtml(f.name)}" title="Delete">✕</button>` : ""}
          </div>`;
        })
        .join("");

      list.querySelectorAll("[data-my-delete]").forEach((btn) => {
        btn.addEventListener("click", () => deleteMySubmission(btn.dataset.myDelete));
      });
    } catch (_) {}
  }

  function formatRemaining(seconds) {
    if (seconds <= 0) return "Delete expired";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0 && m > 0) return `${h} hour${h > 1 ? "s" : ""} ${m} minute${m > 1 ? "s" : ""} left to delete`;
    if (h > 0) return `${h} hour${h > 1 ? "s" : ""} left to delete`;
    return `${m} minute${m > 1 ? "s" : ""} left to delete`;
  }

  async function deleteMySubmission(filename) {
    if (!confirm(`Delete "${filename}"?`)) return;
    try {
      const res = await fetch(`/api/my-submissions/${encodeURIComponent(filename)}`, { method: "DELETE" });
      const data = await res.json();
      if (res.ok) {
        loadMySubmissions();
      } else {
        showError(data.error || "Delete failed");
      }
    } catch (_) {
      showError("Network error");
    }
  }

  /* Admin Dashboard */
  function openUploadsModal() {
    document.getElementById("uploadsModalOverlay").classList.remove("hidden");
    loadUploadsModal();
    loadCleanupStatus();

    const isIT = window.__CURRENT_USER === "IT";
    document.getElementById("logsDivider").classList.toggle("hidden", !isIT);
    document.getElementById("logsTitle").classList.toggle("hidden", !isIT);
    document.getElementById("logsViewer").classList.toggle("hidden", !isIT);
    if (isIT) loadLogs();
  }

  function closeUploadsModal() {
    document.getElementById("uploadsModalOverlay").classList.add("hidden");
  }

  async function loadUploadsModal() {
    const list = document.getElementById("uploadsModalList");
    try {
      const res = await fetch("/api/admin/uploads");
      if (!res.ok) return;
      const data = await res.json();
      if (data.users.length === 0) {
        list.innerHTML = '<p class="text-muted">No submissions yet</p>';
      } else {
        list.innerHTML = data.users
          .map(
            (u) => `
            <div class="admin-user-card${u.count === 0 ? " no-uploads" : ""}">
              <div class="admin-user-header">
                <span class="admin-user-name">${escapeHtml(u.username)}</span>
                <div class="admin-user-actions">
                  ${u.count > 0 ? `
                  <button class="btn btn-secondary btn-sm open-folder-btn" data-open-folder="${escapeHtml(u.username)}" title="Open this user's folder in Explorer">Open Folder</button>
                  ` : ""}
                  <span class="admin-file-count ${u.count === 0 ? "text-muted" : ""}">${u.count === 0 ? "No uploads" : u.count + " file(s)"}</span>
                </div>
              </div>
              ${u.count > 0 ? `
              <div class="admin-file-list">
                ${u.files.map((f) => {
                  const v = f.verdict || "";
                  const verdictLabel = v === "real" ? "Real PDF" : v === "fake" ? "Fake PDF" : v === "error" ? "Error" : "Unknown";
                  const verdictClass = v === "real" ? "verdict-real" : v === "fake" ? "verdict-fake" : v === "error" ? "verdict-error" : "verdict-unknown";
                  const source = f.producer || f.creator || "";
                  return `
                  <div class="admin-file-row">
                    <span class="admin-file-name">${escapeHtml(f.name)}</span>
                    <span class="admin-file-verdict ${verdictClass}">${verdictLabel}</span>
                    ${f.duplicate ? `<span class="admin-file-verdict verdict-duplicate">Duplicate</span>` : ""}
                    ${source ? `<span class="admin-file-source">${escapeHtml(source)}</span>` : ""}
                    <button class="btn-icon btn-danger-icon" data-modal-delete="${escapeHtml(u.username)}/${escapeHtml(f.name)}" title="Delete">✕</button>
                  </div>`;
                }).join("")}
              </div>` : ""}
            </div>`
          )
          .join("");
        list.querySelectorAll("[data-modal-delete]").forEach((btn) => {
          btn.addEventListener("click", () => modalDeleteFile(btn.getAttribute("data-modal-delete")));
        });
        list.querySelectorAll("[data-open-folder]").forEach((btn) => {
          btn.addEventListener("click", () => openUserFolder(btn.dataset.openFolder));
        });
      }
    } catch (_) {
      list.innerHTML = '<p class="text-muted">Failed to load uploads</p>';
    }
  }

  async function modalDeleteFile(path) {
    if (!confirm("Delete this file?")) return;
    try {
      const res = await fetch(`/api/admin/uploads/${path}`, { method: "DELETE" });
      if (res.ok) loadUploadsModal();
    } catch (_) {}
  }

  async function openUserFolder(username) {
    try {
      await fetch(`/api/admin/open-folder/${encodeURIComponent(username)}`);
    } catch (_) {}
  }

  /* Registration Requests */
  function openRegRequests() {
    document.getElementById("regRequestsOverlay").classList.remove("hidden");
    loadRegRequests();
  }

  function closeRegRequests() {
    document.getElementById("regRequestsOverlay").classList.add("hidden");
  }

  async function loadRegRequests() {
    const list = document.getElementById("regRequestsList");
    try {
      const res = await fetch("/api/admin/registration-requests");
      if (!res.ok) return;
      const data = await res.json();
      if (data.requests.length === 0) {
        list.innerHTML = '<p class="text-muted">No requests yet</p>';
      } else {
        list.innerHTML = data.requests
          .map(
            (r) => `
            <div class="reg-request-card">
              <div class="reg-request-header">
                <span class="reg-request-name">${escapeHtml(r.name)}</span>
                <button class="btn-icon btn-danger-icon" data-delete-reg="${escapeHtml(r.gmail)}" title="Remove">✕</button>
              </div>
              <div class="reg-request-details">
                <span class="reg-request-team">${escapeHtml(r.team)}</span>
                <span class="reg-request-gmail">${escapeHtml(r.gmail)}</span>
                <button class="btn-icon copy-gmail-btn" data-copy="${escapeHtml(r.gmail)}" title="Copy email">⧉</button>
              </div>
            </div>`
          )
          .join("");
        list.querySelectorAll("[data-copy]").forEach((btn) => {
          btn.addEventListener("click", () => {
            navigator.clipboard.writeText(btn.dataset.copy);
            btn.textContent = "✓";
            setTimeout(() => { btn.textContent = "⧉"; }, 1500);
          });
        });
        list.querySelectorAll("[data-delete-reg]").forEach((btn) => {
          btn.addEventListener("click", () => deleteRegRequest(btn.dataset.deleteReg));
        });
      }
    } catch (_) {
      list.innerHTML = '<p class="text-muted">Failed to load requests</p>';
    }
  }

  async function deleteRegRequest(gmail) {
    if (!confirm("Remove this request?")) return;
    try {
      const res = await fetch("/api/admin/registration-requests", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gmail }),
      });
      if (res.ok) loadRegRequests();
    } catch (_) {}
  }

  /* Site Settings */
  function openSiteSettings() {
    document.getElementById("siteSettingsOverlay").classList.remove("hidden");
    loadSiteSettingsForm();
  }

  function closeSiteSettings() {
    document.getElementById("siteSettingsOverlay").classList.add("hidden");
  }

  async function loadSiteSettingsForm() {
    try {
      const res = await fetch("/api/site-config");
      if (!res.ok) return;
      const data = await res.json();
      document.getElementById("dailyQuoteInput").value = data.daily_quote || "";
      document.getElementById("maintenanceInput").value = data.maintenance_message || "";
    } catch (_) {}
  }

  async function saveSiteSettings() {
    const alertEl = document.getElementById("siteSettingsAlert");
    alertEl.classList.add("hidden");
    try {
      const res = await fetch("/api/admin/site-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          daily_quote: document.getElementById("dailyQuoteInput").value.trim(),
          maintenance_message: document.getElementById("maintenanceInput").value.trim(),
        }),
      });
      if (res.ok) {
        alertEl.textContent = "Settings saved";
        alertEl.classList.remove("hidden", "error");
        loadSiteConfig();
      } else {
        alertEl.textContent = "Failed to save";
        alertEl.classList.remove("hidden");
        alertEl.classList.add("error");
      }
    } catch (_) {
      alertEl.textContent = "Network error";
      alertEl.classList.remove("hidden");
      alertEl.classList.add("error");
    }
  }

  async function loadSiteConfig() {
    try {
      const res = await fetch("/api/site-config");
      if (!res.ok) return;
      const data = await res.json();

      const quoteEl = document.getElementById("dailyQuote");
      if (data.daily_quote) {
        quoteEl.textContent = "\u201C" + data.daily_quote + "\u201D";
        quoteEl.classList.remove("hidden");
      } else {
        quoteEl.classList.add("hidden");
      }

      const bannerEl = document.getElementById("maintenanceBanner");
      if (data.maintenance_message) {
        document.getElementById("maintenanceText").textContent = data.maintenance_message;
        bannerEl.classList.remove("hidden");
      } else {
        bannerEl.classList.add("hidden");
      }
    } catch (_) {}
  }

  /* Cleanup */
  async function loadCleanupStatus() {
    try {
      const res = await fetch("/api/admin/cleanup-status");
      if (!res.ok) return;
      const data = await res.json();
      document.getElementById("cleanupToggle").checked = data.enabled;
    } catch (_) {}
  }

  async function toggleCleanup() {
    const enabled = document.getElementById("cleanupToggle").checked;
    try {
      await fetch("/api/admin/cleanup-toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
    } catch (_) {}
  }

  async function runCleanup() {
    if (!confirm("Delete all PDFs older than 90 days?")) return;
    try {
      const res = await fetch("/api/admin/cleanup", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        showSuccess(`Cleanup done — ${data.deleted} file(s) deleted`);
        loadUploadsModal();
      }
    } catch (_) {}
  }

  /* Logs */
  async function loadLogs() {
    try {
      const res = await fetch("/api/logs");
      if (!res.ok) return;
      const data = await res.json();
      const viewer = document.getElementById("logsViewer");
      viewer.textContent = data.logs || "No logs yet";
      viewer.scrollTop = viewer.scrollHeight;
    } catch (_) {
      document.getElementById("logsViewer").textContent = "Failed to load logs";
    }
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
  document.getElementById("togglePasswordsBtn").addEventListener("click", () => {
    showPasswords = !showPasswords;
    document.getElementById("togglePasswordsBtn").textContent = showPasswords ? "Hide Passwords" : "Show Passwords";
    loadUserList();
  });
  document.getElementById("submitFilesBtn").addEventListener("click", submitStagedFiles);
  document.getElementById("clearStagingBtn").addEventListener("click", () => {
    stagedFiles = [];
    renderStaging();
  });
  document.getElementById("uploadsBtn").addEventListener("click", openUploadsModal);
  document.getElementById("closeUploadsModal").addEventListener("click", closeUploadsModal);
  document.getElementById("uploadsModalOverlay").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeUploadsModal();
  });
  document.getElementById("refreshMySubmissionsBtn").addEventListener("click", loadMySubmissions);
  document.getElementById("cleanupToggle").addEventListener("change", toggleCleanup);
  document.getElementById("runCleanupBtn").addEventListener("click", runCleanup);

  document.getElementById("siteSettingsBtn").addEventListener("click", openSiteSettings);
  document.getElementById("closeSiteSettings").addEventListener("click", closeSiteSettings);
  document.getElementById("siteSettingsOverlay").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeSiteSettings();
  });
  document.getElementById("saveSiteSettingsBtn").addEventListener("click", saveSiteSettings);

  document.getElementById("regRequestsBtn").addEventListener("click", openRegRequests);
  document.getElementById("closeRegRequests").addEventListener("click", closeRegRequests);
  document.getElementById("regRequestsOverlay").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeRegRequests();
  });

  updateAdminUI();
  loadSiteConfig();
})();
