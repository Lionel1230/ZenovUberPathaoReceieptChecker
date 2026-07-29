(() => {
  "use strict";

  const fileInput = document.getElementById("fileInput");
  const folderInput = document.getElementById("folderInput");
  const dropZone = document.getElementById("dropZone");
  const progressSection = document.getElementById("progressSection");
  const resultsSection = document.getElementById("resultsSection");
  const uploadBar = document.getElementById("uploadBar");
  const analyzeBar = document.getElementById("analyzeBar");
  const uploadPct = document.getElementById("uploadPct");
  const analyzePct = document.getElementById("analyzePct");
  const analyzeDetail = document.getElementById("analyzeDetail");
  const resultsGrid = document.getElementById("resultsGrid");
  const summaryBadges = document.getElementById("summaryBadges");
  const stagingSection = document.getElementById("stagingSection");
  const stagingList = document.getElementById("stagingList");
  const toastContainer = document.getElementById("toastContainer");

  let pollTimer = null;
  let busy = false;
  let currentUser = window.__CURRENT_USER || "";
  let isAdmin = ["root", "admin", "IT"].includes(currentUser);
  let stagedFiles = [];
  let focusedBeforeDialog = null;

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

  /* ─── loading state ─── */
  function setLoading(btn, loading) {
    if (!btn) return;
    btn.classList.toggle("btn-loading", loading);
    btn.disabled = loading;
  }

  /* ─── toast ─── */
  function showToast(message, type) {
    type = type || "error";
    var el = document.createElement("div");
    el.className = "toast toast-" + type;
    el.innerHTML =
      '<span class="toast-icon">' + (type === "success" ? "✓" : "✕") + '</span>' +
      '<span class="toast-msg">' + escapeHtml(message) + '</span>' +
      '<button class="toast-close" aria-label="Dismiss">&times;</button>';

    el.querySelector(".toast-close").addEventListener("click", function () {
      dismissToast(el);
    });

    toastContainer.appendChild(el);

    var auto = setTimeout(function () { dismissToast(el); }, type === "success" ? 4000 : 6000);
    el._autoTimer = auto;
  }

  function dismissToast(el) {
    if (el._autoTimer) { clearTimeout(el._autoTimer); el._autoTimer = null; }
    if (el.classList.contains("removing")) return;
    el.classList.add("removing");
    el.addEventListener("animationend", function () { el.remove(); });
  }

  /* ─── dialog helpers ─── */
  var dialogs = [];

  function openDialog(overlay) {
    focusedBeforeDialog = document.activeElement;
    overlay.classList.remove("hidden", "closing");
    overlay.classList.remove("closing");
    void overlay.offsetWidth;
    overlay.classList.remove("hidden");
    dialogs.push(overlay);
    trapFocus(overlay);
    overlay.setAttribute("aria-modal", "true");
    var closeBtn = overlay.querySelector(".dialog-close");
    if (closeBtn) closeBtn.focus();
  }

  function closeDialog(overlay) {
    if (!overlay || overlay.classList.contains("hidden")) return;
    overlay.classList.add("closing");
    overlay.addEventListener("animationend", function onEnd() {
      overlay.classList.add("hidden");
      overlay.classList.remove("closing");
      overlay.removeAttribute("aria-modal");
      overlay.removeEventListener("animationend", onEnd);
    }, { once: true });
    dialogs = dialogs.filter(function (d) { return d !== overlay; });
    if (focusedBeforeDialog) { focusedBeforeDialog.focus(); focusedBeforeDialog = null; }
  }

  function closeTopDialog() {
    if (dialogs.length) closeDialog(dialogs[dialogs.length - 1]);
  }

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && dialogs.length) {
      e.stopPropagation();
      closeTopDialog();
    }
  });

  function trapFocus(overlay) {
    var focusable = overlay.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (!focusable.length) return;
    var first = focusable[0], last = focusable[focusable.length - 1];

    function handler(e) {
      if (e.key !== "Tab") return;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    overlay.addEventListener("keydown", handler);
    overlay._focusTrap = handler;
  }

  /* ─── rest of UI ─── */
  function updateAdminUI() {
    var btn = document.getElementById("manageUsersBtn");
    var uploadsBtn = document.getElementById("uploadsBtn");
    var siteSettingsBtn = document.getElementById("siteSettingsBtn");
    var regRequestsBtn = document.getElementById("regRequestsBtn");
    var title = document.getElementById("headerTitle");
    var subtitle = document.getElementById("headerSubtitle");
    var warning = document.getElementById("headerWarning");
    if (btn) btn.classList.toggle("hidden", !isAdmin);
    if (uploadsBtn) uploadsBtn.classList.toggle("hidden", !isAdmin);
    if (siteSettingsBtn) siteSettingsBtn.classList.toggle("hidden", !isAdmin);
    if (regRequestsBtn) regRequestsBtn.classList.toggle("hidden", !isAdmin);
    if (title) title.textContent = "Zenov Conveyance Management";
    if (subtitle) subtitle.classList.toggle("hidden", !isAdmin);
    if (warning) warning.classList.toggle("hidden", isAdmin);
    if (!isAdmin) loadMySubmissions();
  }

  function resetUI() {
    resultsSection.classList.add("hidden");
    resultsGrid.innerHTML = "";
    summaryBadges.innerHTML = "";
    setProgress(uploadBar, uploadPct, 0);
    setProgress(analyzeBar, analyzePct, 0);
    analyzeDetail.textContent = "";
  }

  function setProgress(bar, label, pct) {
    var clamped = Math.min(100, Math.max(0, pct));
    bar.style.width = clamped + "%";
    label.textContent = clamped + "%";
  }

  function filterPdfs(fileList) {
    return Array.from(fileList).filter(function (f) { return f.name.toLowerCase().endsWith(".pdf"); });
  }

  function handleFiles(fileList) {
    if (busy) return;
    var pdfs = filterPdfs(fileList);
    if (pdfs.length === 0) {
      showToast("No PDF files found. Please select PDF files only.");
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
    files.forEach(function (f) {
      if (!stagedFiles.some(function (s) { return s.name === f.name && s.size === f.size; })) {
        stagedFiles.push(f);
      }
    });
    renderStaging();
  }

  function renderStaging() {
    if (stagedFiles.length === 0) { stagingSection.classList.add("hidden"); return; }
    stagingSection.classList.remove("hidden");
    stagingList.innerHTML = stagedFiles.map(function (f, i) {
      return '<div class="staging-item">' +
        '<span class="staging-name" title="' + escapeHtml(f.name) + '">' + escapeHtml(f.name) + '</span>' +
        '<span class="staging-size">' + (f.size / (1024 * 1024)).toFixed(2) + ' MB</span>' +
        '<button class="btn btn-ghost btn-icon btn-sm" data-remove="' + i + '" title="Remove" style="color:hsl(var(--destructive))">&times;</button>' +
        '</div>';
    }).join("");
    stagingList.querySelectorAll("[data-remove]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        stagedFiles.splice(parseInt(btn.dataset.remove), 1);
        renderStaging();
      });
    });
  }

  async function submitStagedFiles() {
    if (stagedFiles.length === 0 || busy) return;
    busy = true;
    var btn = document.getElementById("submitFilesBtn");
    setLoading(btn, true);

    var formData = new FormData();
    stagedFiles.forEach(function (f) { formData.append("files", f); });

    try {
      var res = await fetch("/api/submit", { method: "POST", body: formData });
      var data = await res.json();
      if (!res.ok) { showToast(data.error || "Submit failed"); busy = false; setLoading(btn, false); return; }
      stagedFiles = [];
      renderStaging();
      showToast(data.message, "success");
      loadMySubmissions();
    } catch (_) { showToast("Network error during submit"); }
    busy = false;
    setLoading(btn, false);
  }

  function uploadFiles(files) {
    var formData = new FormData();
    files.forEach(function (f) { formData.append("files", f); });

    var xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");

    xhr.upload.addEventListener("progress", function (e) {
      if (e.lengthComputable) { setProgress(uploadBar, uploadPct, Math.round((e.loaded / e.total) * 100)); }
    });

    xhr.addEventListener("load", function () {
      if (xhr.status === 401) { window.location.href = "/login"; return; }
      if (xhr.status >= 200 && xhr.status < 300) {
        setProgress(uploadBar, uploadPct, 100);
        pollJob(JSON.parse(xhr.responseText).job_id);
      } else {
        var msg = "Upload failed";
        try { var err = JSON.parse(xhr.responseText); msg = err.error || msg; } catch (_) {}
        showToast(msg);
        busy = false;
      }
    });

    xhr.addEventListener("error", function () { showToast("Network error during upload. Please try again."); busy = false; });
    xhr.addEventListener("timeout", function () { showToast("Upload timed out. Try fewer or smaller files."); busy = false; });
    xhr.timeout = 600000;
    xhr.send(formData);
  }

  function pollJob(jobId) {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(async function () {
      try {
        var res = await fetch("/api/jobs/" + jobId);
        if (res.status === 401) { clearInterval(pollTimer); pollTimer = null; window.location.href = "/login"; return; }
        if (!res.ok) throw new Error("Job not found");
        var job = await res.json();
        setProgress(analyzeBar, analyzePct, job.analyze_progress);
        if (job.total_files > 0) analyzeDetail.textContent = job.analyzed_count + " / " + job.total_files + " files analyzed";
        if (job.status === "completed") {
          clearInterval(pollTimer); pollTimer = null;
          setProgress(analyzeBar, analyzePct, 100);
          renderResults(job.results);
          busy = false;
        } else if (job.status === "failed") {
          clearInterval(pollTimer); pollTimer = null;
          showToast(job.error || "Analysis failed");
          busy = false;
        }
      } catch (_) { clearInterval(pollTimer); pollTimer = null; showToast("Lost connection while checking progress."); busy = false; }
    }, 1500);
  }

  function renderResults(results) {
    if (!results || results.length === 0) { showToast("No results returned."); return; }
    resultsSection.classList.remove("hidden");

    var counts = { real: 0, fake: 0, unknown: 0, error: 0 };
    results.forEach(function (r) { if (counts[r.verdict] !== undefined) counts[r.verdict]++; });

    summaryBadges.innerHTML = Object.entries(counts).filter(function (e) { return e[1] > 0; }).map(function (e) {
      return '<span class="badge ' + badgeClass(e[0]) + '">' + e[1] + " " + verdictLabel(e[0]) + "</span>";
    }).join("");

    resultsGrid.innerHTML = results.map(function (r) {
      return '<div class="result-card">' +
        '<div class="result-icon ' + resultIconClass(r.verdict) + '">' + verdictIcon(r.verdict) + "</div>" +
        '<div class="result-info">' +
        '<div class="result-filename" title="' + escapeHtml(r.filename) + '">' + escapeHtml(r.filename) + "</div>" +
        '<div class="result-meta">' + buildMeta(r) + "</div>" +
        "</div>" +
        '<span class="badge ' + badgeClass(r.verdict) + '">' + verdictLabel(r.verdict) + "</span>" +
        "</div>";
    }).join("");
  }

  function resultIconClass(v) {
    var map = { real: "success", fake: "destructive", unknown: "warning", error: "error" };
    return map[v] || "warning";
  }

  function badgeClass(v) {
    var map = { real: "badge-success", fake: "badge-destructive", unknown: "badge-warning", error: "badge-warning" };
    return map[v] || "badge-warning";
  }

  function verdictIcon(v) {
    var icons = { real: "✓", fake: "✗", unknown: "?", error: "!" };
    return icons[v] || "?";
  }

  function verdictLabel(v) {
    if (isAdmin) {
      var labels = { real: "Real PDF", fake: "Fake PDF", unknown: "Unknown", error: "Error" };
      return labels[v] || v;
    }
    var labels = { real: "Good to upload", fake: "Contact IT", unknown: "Check manually", error: "Error" };
    return labels[v] || v;
  }

  function buildMeta(r) {
    if (!isAdmin) return "";
    var parts = [];
    if (r.producer) parts.push("Producer: " + escapeHtml(r.producer));
    if (r.creator) parts.push("Creator: " + escapeHtml(r.creator));
    if (r.matched_keywords.length) parts.push("Matched: " + r.matched_keywords.join(", "));
    if (r.error_message) parts.push(escapeHtml(r.error_message));
    return parts.join(" · ") || "No metadata keywords found";
  }

  function escapeHtml(str) { var d = document.createElement("div"); d.textContent = str; return d.innerHTML; }

  /* ─── empty state ─── */
  function emptyStateHtml(msg, icon) {
    icon = icon || "📄";
    return '<div class="empty-state"><div class="empty-state-icon">' + icon + '</div><div class="empty-state-text">' + msg + '</div></div>';
  }

  /* ─── User Management ─── */
  function generatePassword(len) {
    var chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%&*";
    var pw = "";
    var arr = new Uint32Array(len);
    crypto.getRandomValues(arr);
    for (var i = 0; i < len; i++) pw += chars[arr[i] % chars.length];
    return pw;
  }

  function openUserModal() { openDialog(document.getElementById("userModalOverlay")); loadUserList(); document.getElementById("newUsername").value = ""; document.getElementById("newPassword").value = ""; document.getElementById("userModalError").classList.add("hidden"); }
  function closeUserModal() { closeDialog(document.getElementById("userModalOverlay")); }

  var showPasswords = false;

  async function loadUserList() {
    var list = document.getElementById("userList");
    try {
      var res = showPasswords ? await fetch("/api/users/with-passwords") : await fetch("/api/users");
      if (!res.ok) return;
      var data = await res.json();
      if (!data.users.length) { list.innerHTML = emptyStateHtml("No users yet"); return; }
      list.innerHTML = data.users.map(function (u) {
        return '<div class="user-row">' +
          '<span class="user-name">' + escapeHtml(u.username) + "</span>" +
          (showPasswords && u.password ? '<span class="user-password">' + escapeHtml(u.password) + "</span>" : "") +
          (u.username !== "root" && u.username !== currentUser ? '<button class="btn btn-ghost btn-icon btn-sm" data-delete="' + escapeHtml(u.username) + '" title="Delete user" style="color:hsl(var(--destructive))">&times;</button>' : "") +
          "</div>";
      }).join("");
      list.querySelectorAll("[data-delete]").forEach(function (btn) { btn.addEventListener("click", function () { deleteUser(btn.dataset.delete); }); });
    } catch (_) { list.innerHTML = emptyStateHtml("Failed to load users"); }
  }

  async function createUser() {
    var btn = document.getElementById("createUserBtn");
    setLoading(btn, true);
    var username = document.getElementById("newUsername").value.trim();
    var password = document.getElementById("newPassword").value.trim();
    var errEl = document.getElementById("userModalError");
    errEl.classList.add("hidden");
    if (!username || !password) { errEl.textContent = "Username and password are required"; errEl.classList.remove("hidden"); setLoading(btn, false); return; }
    try {
      var res = await fetch("/api/users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: username, password: password }) });
      var data = await res.json();
      if (!res.ok) { errEl.textContent = data.error; errEl.classList.remove("hidden"); setLoading(btn, false); return; }
      document.getElementById("newUsername").value = "";
      document.getElementById("newPassword").value = "";
      loadUserList();
      showToast("User '" + username + "' created", "success");
    } catch (_) { errEl.textContent = "Failed to create user"; errEl.classList.remove("hidden"); }
    setLoading(btn, false);
  }

  async function deleteUser(username) {
    if (!confirm('Delete user "' + username + '"?')) return;
    if (!confirm("Are you really sure? This cannot be undone.")) return;
    try { var res = await fetch("/api/users/" + encodeURIComponent(username), { method: "DELETE" }); if (res.ok) loadUserList(); } catch (_) {}
  }

  /* ─── My Submissions ─── */
  async function loadMySubmissions() {
    if (isAdmin) return;
    try {
      var res = await fetch("/api/my-submissions");
      if (res.status === 401) { window.location.href = "/login"; return; }
      if (!res.ok) return;
      var data = await res.json();
      var section = document.getElementById("mySubmissions");
      var list = document.getElementById("mySubmissionsList");
      if (data.files.length === 0) { section.classList.add("hidden"); return; }
      section.classList.remove("hidden");
      list.innerHTML = data.files.map(function (f) {
        var sizeMB = (f.size / (1024 * 1024)).toFixed(2);
        var remaining = formatRemaining(f.remaining);
        return '<div class="submission-item">' +
          '<div class="submission-info">' +
          '<span class="submission-name" title="' + escapeHtml(f.name) + '">' + escapeHtml(f.name) + "</span>" +
          '<span class="submission-meta">' + sizeMB + " MB" + (f.can_delete ? " · " + remaining : " · Delete expired") + "</span>" +
          "</div>" +
          (f.can_delete ? '<button class="btn btn-ghost btn-icon btn-sm" data-my-delete="' + escapeHtml(f.name) + '" title="Delete" style="color:hsl(var(--destructive))">&times;</button>' : "") +
          "</div>";
      }).join("");
      list.querySelectorAll("[data-my-delete]").forEach(function (btn) { btn.addEventListener("click", function () { deleteMySubmission(btn.dataset.myDelete); }); });
    } catch (_) {}
  }

  function formatRemaining(seconds) {
    if (seconds <= 0) return "Delete expired";
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    if (h > 0 && m > 0) return h + " hour" + (h > 1 ? "s" : "") + " " + m + " minute" + (m > 1 ? "s" : "") + " left to delete";
    if (h > 0) return h + " hour" + (h > 1 ? "s" : "") + " left to delete";
    return m + " minute" + (m > 1 ? "s" : "") + " left to delete";
  }

  async function deleteMySubmission(filename) {
    if (!confirm('Delete "' + filename + '"?')) return;
    var btn = document.querySelector('[data-my-delete="' + escapeHtml(filename) + '"]');
    setLoading(btn, true);
    try {
      var res = await fetch("/api/my-submissions/" + encodeURIComponent(filename), { method: "DELETE" });
      var data = await res.json();
      if (res.ok) loadMySubmissions(); else showToast(data.error || "Delete failed");
    } catch (_) { showToast("Network error"); }
    if (btn) setLoading(btn, false);
  }

  /* ─── Admin Dashboard ─── */
  function openUploadsModal() {
    openDialog(document.getElementById("uploadsModalOverlay"));
    loadUploadsModal();
    loadCleanupStatus();
    var isIT = window.__CURRENT_USER === "IT";
    document.getElementById("logsDivider").classList.toggle("hidden", !isIT);
    document.getElementById("logsTitle").classList.toggle("hidden", !isIT);
    document.getElementById("logsViewer").classList.toggle("hidden", !isIT);
    if (isIT) loadLogs();
  }

  function closeUploadsModal() { closeDialog(document.getElementById("uploadsModalOverlay")); }

  async function loadUploadsModal() {
    var list = document.getElementById("uploadsModalList");
    try {
      var res = await fetch("/api/admin/uploads");
      if (!res.ok) return;
      var data = await res.json();
      if (data.users.length === 0) { list.innerHTML = emptyStateHtml("No submissions yet", "📭"); return; }
      list.innerHTML = data.users.map(function (u) {
        return '<div class="admin-user-card' + (u.count === 0 ? " no-uploads" : "") + '">' +
          '<div class="admin-user-header">' +
          '<span class="admin-user-name">' + escapeHtml(u.username) + "</span>" +
          '<div class="admin-user-actions">' +
          (u.count > 0 ? '<button class="btn btn-outline btn-sm open-folder-btn" data-open-folder="' + escapeHtml(u.username) + '" title="Open this user\'s folder in Explorer">Open Folder</button>' : "") +
          '<span class="admin-file-count' + (u.count === 0 ? " text-muted" : "") + '">' + (u.count === 0 ? "No uploads" : u.count + " file(s)") + "</span>" +
          "</div></div>" +
          (u.count > 0 ? '<div class="admin-file-list">' + u.files.map(function (f) {
            var v = f.verdict || "";
            var vLabel = verdictLabel(v);
            var vBadge = badgeClass(v);
            var source = f.producer || f.creator || "";
            return '<div class="admin-file-row">' +
              '<span class="admin-file-name">' + escapeHtml(f.name) + "</span>" +
              '<span class="badge ' + vBadge + '" style="font-size:0.7rem">' + vLabel + "</span>" +
              (f.duplicate ? '<span class="badge badge-destructive" style="font-size:0.7rem">Duplicate</span>' : "") +
              (source ? '<span class="admin-file-source">' + escapeHtml(source) + "</span>" : "") +
              '<button class="btn btn-ghost btn-icon btn-sm" data-modal-delete="' + escapeHtml(u.username) + "/" + escapeHtml(f.name) + '" title="Delete" style="color:hsl(var(--destructive))">&times;</button>' +
              "</div>";
          }).join("") + "</div>" : "") +
          "</div>";
      }).join("");
      list.querySelectorAll("[data-modal-delete]").forEach(function (btn) { btn.addEventListener("click", function () { modalDeleteFile(btn.getAttribute("data-modal-delete")); }); });
      list.querySelectorAll("[data-open-folder]").forEach(function (btn) { btn.addEventListener("click", function () { openUserFolder(btn.dataset.openFolder); }); });
    } catch (_) { list.innerHTML = emptyStateHtml("Failed to load uploads"); }
  }

  async function modalDeleteFile(path) {
    if (!confirm("Delete this file?")) return;
    try { var res = await fetch("/api/admin/uploads/" + path, { method: "DELETE" }); if (res.ok) loadUploadsModal(); } catch (_) {}
  }

  async function openUserFolder(username) { try { await fetch("/api/admin/open-folder/" + encodeURIComponent(username)); } catch (_) {} }

  /* ─── Registration Requests ─── */
  function openRegRequests() { openDialog(document.getElementById("regRequestsOverlay")); loadRegRequests(); }
  function closeRegRequests() { closeDialog(document.getElementById("regRequestsOverlay")); }

  async function loadRegRequests() {
    var list = document.getElementById("regRequestsList");
    try {
      var res = await fetch("/api/admin/registration-requests");
      if (!res.ok) return;
      var data = await res.json();
      if (data.requests.length === 0) { list.innerHTML = emptyStateHtml("No requests yet", "📋"); return; }
      list.innerHTML = data.requests.map(function (r) {
        return '<div class="reg-request-card">' +
          '<div class="reg-request-header">' +
          '<span class="reg-request-name">' + escapeHtml(r.name) + "</span>" +
          '<button class="btn btn-ghost btn-icon btn-sm" data-delete-reg="' + escapeHtml(r.gmail) + '" title="Remove" style="color:hsl(var(--destructive))">&times;</button>' +
          "</div>" +
          '<div class="reg-request-details">' +
          '<span class="reg-request-team">' + escapeHtml(r.team) + "</span>" +
          '<span class="reg-request-gmail">' + escapeHtml(r.gmail) + "</span>" +
          '<button class="reg-request-copy" data-copy="' + escapeHtml(r.gmail) + '" title="Copy email">⧉</button>' +
          "</div></div>";
      }).join("");
      list.querySelectorAll("[data-copy]").forEach(function (btn) { btn.addEventListener("click", function () { navigator.clipboard.writeText(btn.dataset.copy); btn.textContent = "✓"; setTimeout(function () { btn.textContent = "⧉"; }, 1500); }); });
      list.querySelectorAll("[data-delete-reg]").forEach(function (btn) { btn.addEventListener("click", function () { deleteRegRequest(btn.dataset.deleteReg); }); });
    } catch (_) { list.innerHTML = emptyStateHtml("Failed to load requests"); }
  }

  async function deleteRegRequest(gmail) {
    if (!confirm("Remove this request?")) return;
    try { var res = await fetch("/api/admin/registration-requests", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ gmail: gmail }) }); if (res.ok) loadRegRequests(); } catch (_) {}
  }

  /* ─── Site Settings ─── */
  function openSiteSettings() { openDialog(document.getElementById("siteSettingsOverlay")); loadSiteSettingsForm(); }
  function closeSiteSettings() { closeDialog(document.getElementById("siteSettingsOverlay")); }

  async function loadSiteSettingsForm() {
    try { var res = await fetch("/api/site-config"); if (!res.ok) return; var data = await res.json(); document.getElementById("dailyQuoteInput").value = data.daily_quote || ""; document.getElementById("maintenanceInput").value = data.maintenance_message || ""; } catch (_) {}
  }

  async function saveSiteSettings() {
    var btn = document.getElementById("saveSiteSettingsBtn");
    setLoading(btn, true);
    var alertEl = document.getElementById("siteSettingsAlert");
    alertEl.classList.add("hidden");
    try {
      var res = await fetch("/api/admin/site-config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ daily_quote: document.getElementById("dailyQuoteInput").value.trim(), maintenance_message: document.getElementById("maintenanceInput").value.trim() }) });
      if (res.ok) { showToast("Settings saved", "success"); loadSiteConfig(); } else { showToast("Failed to save"); }
    } catch (_) { showToast("Network error"); }
    setLoading(btn, false);
  }

  async function loadSiteConfig() {
    try {
      var res = await fetch("/api/site-config");
      if (!res.ok) return;
      var data = await res.json();
      var quoteEl = document.getElementById("dailyQuote");
      if (data.daily_quote) { quoteEl.textContent = "\u201C" + data.daily_quote + "\u201D"; quoteEl.classList.remove("hidden"); } else { quoteEl.classList.add("hidden"); }
      var bannerEl = document.getElementById("maintenanceBanner");
      if (data.maintenance_message) { document.getElementById("maintenanceText").textContent = data.maintenance_message; bannerEl.classList.remove("hidden"); } else { bannerEl.classList.add("hidden"); }
    } catch (_) {}
  }

  /* ─── Cleanup ─── */
  async function loadCleanupStatus() { try { var res = await fetch("/api/admin/cleanup-status"); if (!res.ok) return; document.getElementById("cleanupToggle").checked = (await res.json()).enabled; } catch (_) {} }
  async function toggleCleanup() { try { await fetch("/api/admin/cleanup-toggle", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: document.getElementById("cleanupToggle").checked }) }); } catch (_) {} }
  async function runCleanup() {
    if (!confirm("Delete all PDFs older than 90 days?")) return;
    var btn = document.getElementById("runCleanupBtn");
    setLoading(btn, true);
    try { var res = await fetch("/api/admin/cleanup", { method: "POST" }); var data = await res.json(); if (res.ok) { showToast("Cleanup done \u2014 " + data.deleted + " file(s) deleted", "success"); loadUploadsModal(); } } catch (_) {}
    setLoading(btn, false);
  }

  /* ─── Logs ─── */
  async function loadLogs() {
    try {
      var res = await fetch("/api/logs");
      if (!res.ok) return;
      var data = await res.json();
      var viewer = document.getElementById("logsViewer");
      viewer.textContent = data.logs || "No logs yet";
      viewer.scrollTop = viewer.scrollHeight;
    } catch (_) { document.getElementById("logsViewer").textContent = "Failed to load logs"; }
  }

  /* ─── Event listeners ─── */
  fileInput.addEventListener("change", function () { if (fileInput.files.length) handleFiles(fileInput.files); fileInput.value = ""; });
  folderInput.addEventListener("change", function () { if (folderInput.files.length) handleFiles(folderInput.files); folderInput.value = ""; });
  dropZone.addEventListener("dragover", function (e) { e.preventDefault(); dropZone.classList.add("drag-over"); });
  dropZone.addEventListener("dragleave", function () { dropZone.classList.remove("drag-over"); });
  dropZone.addEventListener("drop", function (e) { e.preventDefault(); dropZone.classList.remove("drag-over"); if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); });

  document.getElementById("manageUsersBtn").addEventListener("click", openUserModal);
  document.getElementById("closeUserModal").addEventListener("click", closeUserModal);
  document.getElementById("userModalOverlay").addEventListener("click", function (e) { if (e.target === e.currentTarget) closeUserModal(); });
  document.getElementById("createUserBtn").addEventListener("click", createUser);
  document.getElementById("generatePwBtn").addEventListener("click", function () { document.getElementById("newPassword").value = generatePassword(16); });
  document.getElementById("togglePasswordsBtn").addEventListener("click", function () { showPasswords = !showPasswords; document.getElementById("togglePasswordsBtn").textContent = showPasswords ? "Hide Passwords" : "Show Passwords"; loadUserList(); });
  document.getElementById("submitFilesBtn").addEventListener("click", submitStagedFiles);
  document.getElementById("clearStagingBtn").addEventListener("click", function () { stagedFiles = []; renderStaging(); });
  document.getElementById("uploadsBtn").addEventListener("click", openUploadsModal);
  document.getElementById("closeUploadsModal").addEventListener("click", closeUploadsModal);
  document.getElementById("uploadsModalOverlay").addEventListener("click", function (e) { if (e.target === e.currentTarget) closeUploadsModal(); });
  document.getElementById("refreshMySubmissionsBtn").addEventListener("click", loadMySubmissions);
  document.getElementById("cleanupToggle").addEventListener("change", toggleCleanup);
  document.getElementById("runCleanupBtn").addEventListener("click", runCleanup);
  document.getElementById("siteSettingsBtn").addEventListener("click", openSiteSettings);
  document.getElementById("closeSiteSettings").addEventListener("click", closeSiteSettings);
  document.getElementById("siteSettingsOverlay").addEventListener("click", function (e) { if (e.target === e.currentTarget) closeSiteSettings(); });
  document.getElementById("saveSiteSettingsBtn").addEventListener("click", saveSiteSettings);
  document.getElementById("regRequestsBtn").addEventListener("click", openRegRequests);
  document.getElementById("closeRegRequests").addEventListener("click", closeRegRequests);
  document.getElementById("regRequestsOverlay").addEventListener("click", function (e) { if (e.target === e.currentTarget) closeRegRequests(); });

  updateAdminUI();
  loadSiteConfig();
})();
