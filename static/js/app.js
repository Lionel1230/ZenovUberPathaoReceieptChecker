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

  let userData = {};
  // No debug log in production

  async function initUI() {
    await loadSiteConfig();
  }

  function applyUI() {
    updateAdminUI();
    loadProfile();
    loadMySubmissions();
    loadBillList();
    if (isAdmin) {
      loadUploadsAdminList();
      loadCleanupStatus();
      loadRequestsBadge();
    }
  }

  if (!currentUser) {
    fetch("/api/me")
      .then((r) => r.json())
      .then((data) => {
        currentUser = data.username;
        isAdmin = data.is_admin;
        applyUI();
        initUI();
      })
      .catch(() => {});
  } else {
    applyUI();
    initUI();
  }

  /* ─── global spinner ─── */
  function showGlobalSpinner(text) {
    var el = document.getElementById("globalSpinner");
    document.getElementById("globalSpinnerText").textContent = text || "Loading...";
    el.classList.remove("hidden");
  }
  function hideGlobalSpinner() {
    document.getElementById("globalSpinner").classList.add("hidden");
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

  /* ─── duplicate popup ─── */
  function showDuplicatePopup(filenames) {
    var overlay = document.getElementById("duplicateOverlay");
    if (!overlay) return;
    var list = document.getElementById("duplicateFileList");
    if (list) {
      list.innerHTML = filenames.map(function (n) {
        return '<li>' + escapeHtml(n) + '</li>';
      }).join("");
    }
    var count = document.getElementById("duplicateCount");
    if (count) count.textContent = filenames.length;
    overlay.classList.remove("hidden");
    var closeBtn = document.getElementById("duplicateCloseBtn");
    if (closeBtn) {
      closeBtn.onclick = function () { overlay.classList.add("hidden"); };
    }
    overlay.onclick = function (e) {
      if (e.target === overlay) overlay.classList.add("hidden");
    };
  }

  /* ─── UI toggle: User vs Admin ─── */
  function updateAdminUI() {
    var isAdm = isAdmin;
    var sub = document.getElementById("headerSubtitle");
    var warn = document.getElementById("headerWarning");
    if (sub) sub.classList.toggle("hidden", !isAdm);
    if (warn) warn.classList.toggle("hidden", isAdm);

    var profile = document.getElementById("profileSection");
    var userTabs = document.getElementById("userTabs");
    var adminTabs = document.getElementById("adminTabs");
    var adminBtns = ["manageUsersBtn", "uploadsBtn", "regRequestsBtn", "siteSettingsBtn"];

    if (isAdm) {
      adminBtns.forEach(function (id) { var el = document.getElementById(id); if (el) el.classList.remove("hidden"); });
      if (profile) profile.classList.add("hidden");
      if (userTabs) userTabs.classList.add("hidden");
      document.getElementById("tab-billing").classList.add("hidden");
      document.getElementById("tab-submitted").classList.add("hidden");
      document.getElementById("tab-check").classList.remove("hidden");
      document.getElementById("stagingSection").classList.add("hidden");
      if (adminTabs) adminTabs.classList.remove("hidden");
      var logsTab = document.querySelector('.admin-tab[data-atab="logs"]');
      if (logsTab) logsTab.classList.toggle("hidden", currentUser !== "IT");
      switchAdminTab("uploads");
    } else {
      adminBtns.forEach(function (id) { var el = document.getElementById(id); if (el) el.classList.add("hidden"); });
      if (profile) profile.classList.remove("hidden");
      if (userTabs) userTabs.classList.remove("hidden");
      if (adminTabs) adminTabs.classList.add("hidden");
      document.querySelectorAll(".admin-panel").forEach(function (p) { p.classList.remove("active"); p.classList.add("hidden"); });
      document.getElementById("tab-check").classList.remove("hidden");
      document.getElementById("tab-billing").classList.add("hidden");
      document.getElementById("tab-submitted").classList.add("hidden");
    }
  }

  function switchAdminTab(tabId) {
    document.querySelectorAll(".admin-tab").forEach(function (t) { t.classList.toggle("active", t.dataset.atab === tabId); });
    document.querySelectorAll(".admin-panel").forEach(function (p) {
      var show = p.id === "apanel-" + tabId;
      p.classList.toggle("active", show);
      p.classList.toggle("hidden", !show);
    });
    if (tabId === "uploads") { loadUploadsAdminList(); loadCleanupStatus(); }
    else if (tabId === "users") { loadUserList(); }
    else if (tabId === "requests") { loadRegRequests(); }
    else if (tabId === "logs") { loadLogs(); }
    else if (tabId === "settings") { loadSiteSettingsForm(); }
  }

  /* ─── tab switching ─── */
  function switchUserTab(tabId) {
    document.querySelectorAll(".tabs-trigger").forEach(function (t) { t.classList.toggle("active", t.dataset.tab === tabId); });
    document.querySelectorAll(".tab-panel").forEach(function (t) { t.classList.toggle("hidden", t.id !== "tab-" + tabId); });
  }

  /* ─── dialog functions ─── */
  function openDialog(overlay) {
    overlay.classList.remove("hidden", "closing");
    void overlay.offsetWidth;
    overlay.classList.remove("hidden");
    var closeBtn = overlay.querySelector(".dialog-close");
    if (closeBtn) closeBtn.focus();
  }

  function closeDialog(overlay) {
    if (!overlay || overlay.classList.contains("hidden")) return;
    overlay.classList.add("closing");
    overlay.addEventListener("animationend", function onEnd() {
      overlay.classList.add("hidden");
      overlay.classList.remove("closing");
      overlay.removeEventListener("animationend", onEnd);
    }, { once: true });
  }

  /* ─── profile ─── */
  async function loadProfile() {
    try {
      var res = await fetch("/api/me");
      var data = await res.json();
      userData = data;
      document.getElementById("profileName").textContent = data.name || data.username;
      document.getElementById("profileRole").textContent = data.role ? "Role: " + data.role : "Role: User";
      document.getElementById("profileTeam").textContent = data.team ? "Team: " + data.team : "";
      if (data.profile_pic) {
        document.getElementById("profilePicImg").src = "/api/profile-pic/" + encodeURIComponent(data.username) + "?" + Date.now();
      } else {
        document.getElementById("profilePicImg").src = "/api/profile-pic/default?" + Date.now();
      }
    } catch (_) {}
  }

  document.getElementById("profilePicUpload").addEventListener("click", function () {
    document.getElementById("profilePicInput").click();
  });

  document.getElementById("profilePicInput").addEventListener("change", function () {
    if (!this.files.length) return;
    var fd = new FormData();
    fd.append("profile_pic", this.files[0]);
    fetch("/api/profile-pic", { method: "PUT", body: fd })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d.ok) { showToast("Profile pic updated", "success"); loadProfile(); } else { showToast(d.error || "Failed"); } })
      .catch(function () { showToast("Network error"); });
    this.value = "";
  });


  /* ─── rest of UI ─── */
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

  async function computeFileSha1(file) {
    var buffer = await file.arrayBuffer();
    var hashBuffer = await crypto.subtle.digest("SHA-1", buffer);
    var hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  }

  async function checkStagedDuplicates() {
    if (stagedFiles.length === 0) return;
    var hashes = await Promise.all(stagedFiles.map(function (f) { return computeFileSha1(f); }));
    try {
      var res = await fetch("/api/check-duplicates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hashes: hashes }),
      });
      if (!res.ok) return;
      var data = await res.json();
      if (data.duplicates && data.duplicates.length > 0) {
        var dupSet = new Set(data.duplicates);
        var removeIndices = [];
        hashes.forEach(function (h, i) {
          if (dupSet.has(h)) removeIndices.push(i);
        });
        if (removeIndices.length > 0) {
          var dupNames = removeIndices.map(function (i) { return stagedFiles[i].name; });
          showDuplicatePopup(dupNames);
          removeIndices.sort(function (a, b) { return b - a; }).forEach(function (i) {
            var item = stagingList.querySelectorAll(".staging-item")[i];
            if (item) { item.classList.add("staging-removing"); }
          });
          await new Promise(function (r) { setTimeout(r, 400); });
          removeIndices.sort(function (a, b) { return b - a; }).forEach(function (i) {
            stagedFiles.splice(i, 1);
          });
          renderStaging();
        }
      }
    } catch (_) {}
  }

  function addFilesToStaging(files) {
    files.forEach(function (f) {
      if (!stagedFiles.some(function (s) { return s.name === f.name && s.size === f.size; })) {
        stagedFiles.push(f);
      }
    });
    renderStaging();
    checkStagedDuplicates();
  }

  function renderStaging() {
    if (stagedFiles.length === 0) { stagingSection.classList.add("hidden"); return; }
    stagingSection.classList.remove("hidden");
    stagingList.innerHTML = stagedFiles.map(function (f, i) {
      return '<div class="staging-item">' +
        '<span class="staging-name" title="' + escapeHtml(f.name) + '">' + escapeHtml(f.name) + '</span>' +
        '<span class="staging-size">' + (f.size / (1024 * 1024)).toFixed(2) + ' MB</span>' +
        '<button class="btn-remove" data-remove="' + i + '" title="Remove">&times;</button>' +
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
    var monthSelect = document.getElementById("monthSelect");
    var month = monthSelect.value;
    if (!month) { showToast("Please select a month before submitting."); monthSelect.focus(); return; }

    var monthBillInput = document.getElementById("monthBillInput");
    var billVal = parseFloat(monthBillInput.value);
    if (!isNaN(billVal) && billVal > 0) {
      try {
        await fetch("/api/billing/total", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ month: month, total_bill: billVal }) });
      } catch (_) {}
    }

    busy = true;
    var btn = document.getElementById("submitFilesBtn");
    setLoading(btn, true);

    var formData = new FormData();
    formData.append("month", month);
    stagedFiles.forEach(function (f) { formData.append("files", f); });

    try {
      var res = await fetch("/api/submit", { method: "POST", body: formData });
      var data = await res.json();
      if (!res.ok) { showToast(data.error || "Submit failed"); busy = false; setLoading(btn, false); return; }
      stagedFiles = [];
      monthSelect.value = "";
      monthBillInput.value = "";
      renderStaging();
      showToast(data.message, "success");
      loadMySubmissions();
      loadBillList();
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
          showToast("Analysis complete \u2014 " + job.analyzed_count + " file(s) analyzed", "success");
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
    var icons = { real: "?", fake: "?", unknown: "?", error: "!" };
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
    if (r.matched_keywords.length) parts.push("Matched: " + escapeHtml(r.matched_keywords.join(", ")));
    if (r.error_message) parts.push(escapeHtml(r.error_message));
    return parts.join(" . ") || "No metadata keywords found";
  }

  function escapeHtml(str) { var d = document.createElement("div"); d.textContent = str; return d.innerHTML; }

  /* --- empty state --- */
  function emptyStateHtml(msg, icon) {
    icon = icon || "";
    return '<div class="empty-state"><div class="empty-state-icon">' + escapeHtml(icon) + '</div><div class="empty-state-text">' + escapeHtml(msg) + '</div></div>';
  }

  /* --- skeleton --- */
  function skeletonHtml(count, type) {
    if (type === "row") {
      var html = "";
      for (var i = 0; i < count; i++) {
        var w = 55 + Math.floor(Math.random() * 35);
        html += '<div class="skeleton" style="height:1rem;width:' + w + '%;margin-bottom:0.625rem"></div>';
      }
      return '<div style="padding:0.75rem 0">' + html + '</div>';
    }
    if (type === "card") {
      var html = "";
      for (var i = 0; i < count; i++) {
        html += '<div style="padding:0.75rem 0;border-bottom:1px solid hsl(var(--border))">' +
          '<div class="skeleton" style="height:1rem;width:45%;margin-bottom:0.5rem"></div>' +
          '<div class="skeleton" style="height:0.75rem;width:70%"></div>' +
          '</div>';
      }
      return html;
    }
    if (type === "user-card") {
      var html = "";
      for (var i = 0; i < count; i++) {
        html += '<div style="padding:0.75rem 0;border-bottom:1px solid hsl(var(--border));display:flex;align-items:center;gap:0.75rem">' +
          '<div class="skeleton" style="height:1rem;width:35%;flex:1"></div>' +
          '<div class="skeleton" style="height:1.5rem;width:1.5rem;border-radius:var(--radius);flex-shrink:0"></div>' +
          '</div>';
      }
      return html;
    }
    if (type === "file-list") {
      var html = "";
      for (var i = 0; i < count; i++) {
        html += '<div style="padding:0.5rem 0;display:flex;align-items:center;gap:0.5rem">' +
          '<div class="skeleton" style="height:0.65rem;width:3.5rem;border-radius:9999px;flex-shrink:0"></div>' +
          '<div class="skeleton" style="height:0.875rem;width:40%;flex:1"></div>' +
          '<div class="skeleton" style="height:0.7rem;width:3rem;border-radius:9999px;flex-shrink:0"></div>' +
          '<div class="skeleton" style="height:1.5rem;width:1.5rem;border-radius:var(--radius);flex-shrink:0"></div>' +
          '</div>';
      }
      return html;
    }
    if (type === "text") {
      var html = "";
      for (var i = 0; i < count; i++) {
        var w = 70 + Math.floor(Math.random() * 30);
        html += '<div class="skeleton" style="height:0.875rem;width:' + w + '%;margin-bottom:0.75rem"></div>';
      }
      return html;
    }
    if (type === "reg-card") {
      var html = "";
      for (var i = 0; i < count; i++) {
        html += '<div style="padding:0.75rem 0;border-bottom:1px solid hsl(var(--border))">' +
          '<div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:0.5rem">' +
          '<div class="skeleton" style="height:1rem;width:40%;flex:1"></div>' +
          '<div class="skeleton" style="height:1.5rem;width:1.5rem;border-radius:var(--radius);flex-shrink:0"></div>' +
          '</div>' +
          '<div class="skeleton" style="height:0.75rem;width:55%;margin-bottom:0.375rem"></div>' +
          '<div class="skeleton" style="height:0.75rem;width:65%"></div>' +
          '</div>';
      }
      return html;
    }
    return '<div class="skeleton" style="height:' + (typeof count === "number" ? count : 1) + 'rem;width:100%"></div>';
  }

  /* --- User Management --- */
  function generatePassword(len) {
    var chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%&*";
    var pw = "";
    var arr = new Uint32Array(len);
    crypto.getRandomValues(arr);
    for (var i = 0; i < len; i++) pw += chars[arr[i] % chars.length];
    return pw;
  }




  async function loadUserList() {
    var list = document.getElementById("userList");
    list.innerHTML = skeletonHtml(6, "user-card");
    try {
      var res = await fetch("/api/users/with-passwords");
      if (!res.ok) return;
      var data = await res.json();
      if (!data.users.length) { list.innerHTML = emptyStateHtml("No users yet"); return; }
      list.innerHTML = data.users.map(function (u) {
        var picUrl = "/api/profile-pic/" + encodeURIComponent(u.username);
        var pwId = "pw-" + encodeURIComponent(u.username);
        return '<div class="user-row">' +
          '<div class="user-cell" style="display:flex;align-items:center;gap:0.5rem;flex:1">' +
          '<img class="profile-pic profile-pic-sm" src="' + picUrl + '" alt="" onerror="this.style.display=\'none\'" />' +
          '<span class="user-name">' + escapeHtml(u.username) + "</span>" +
          "</div>" +
          (u.password ? '<span style="display:flex;align-items:center;gap:0.25rem"><input class="user-password-input" id="' + pwId + '" type="password" value="' + escapeHtml(u.password) + '" readonly /><button class="pw-toggle" data-pw="' + pwId + '" title="Toggle password visibility"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button></span>' : "") +
          (u.username !== "root" && u.username !== currentUser ? '<button class="btn-remove" data-delete="' + escapeHtml(u.username) + '" title="Delete">&times;</button>' : "") +
          "</div>";
      }).join("");
      list.querySelectorAll("[data-delete]").forEach(function (btn) { btn.addEventListener("click", function () { deleteUser(btn.dataset.delete); }); });
      list.querySelectorAll(".pw-toggle").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var input = document.getElementById(btn.dataset.pw);
          input.type = input.type === "password" ? "text" : "password";
        });
      });
      filterUsersModal();
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
    try { var res = await fetch("/api/users/" + encodeURIComponent(username), { method: "DELETE" }); var data = await res.json(); if (res.ok) { showToast(data.message || "User deleted", "success"); loadUserList(); } else { showToast(data.error || "Delete failed"); } } catch (_) { showToast("Network error"); }
  }

  function beep() {
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 800;
      osc.type = "sine";
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.3);
    } catch (_) {}
  }

  async function deleteAllUsers() {
    var prompts = ["Type CONFIRM to delete ALL users: ", "Are you ABSOLUTELY sure? Type CONFIRM: ", "FINAL WARNING \u2014 this cannot be undone. Type CONFIRM: "];
    for (var i = 0; i < 3; i++) {
      beep();
      var response = prompt(prompts[i]);
      if (response !== "CONFIRM") { showToast("Deletion cancelled"); return; }
    }
    beep();
    try {
      var res = await fetch("/api/users/all", { method: "DELETE" });
      var data = await res.json();
      if (res.ok) { showToast(data.message || "All users deleted", "success"); loadUserList(); }
      else { showToast(data.error || "Delete failed"); }
    } catch (_) { showToast("Network error"); }
  }

  /* --- My Submissions --- */
  async function loadMySubmissions() {
    if (isAdmin) return;
    var section = document.getElementById("mySubmissionsList");
    section.innerHTML = skeletonHtml(4, "row");
    try {
      var res = await fetch("/api/my-submissions");
      if (res.status === 401) { window.location.href = "/login"; return; }
      if (!res.ok) return;
      var data = await res.json();
      if (data.files.length === 0) { section.innerHTML = emptyStateHtml("No submissions yet"); return; }

      var grouped = {};
      var monthOrder = ["January","February","March","April","May","June","July","August","September","October","November","December"];
      data.files.forEach(function (f) {
        if (!grouped[f.month]) grouped[f.month] = [];
        grouped[f.month].push(f);
      });

      var html = "";
      monthOrder.forEach(function (m) {
        var files = grouped[m];
        if (!files) return;
        html += '<div class="month-group">' +
          '<div class="month-group-header"><span class="badge badge-outline month-badge">' + m + '</span></div>';
        html += files.map(function (f) {
          var sizeMB = (f.size / (1024 * 1024)).toFixed(2);
          var remaining = formatRemaining(f.remaining);
          return '<div class="submission-item">' +
            '<div class="submission-info">' +
            '<span class="submission-name" title="' + escapeHtml(f.name) + '">' + escapeHtml(f.name) + "</span>" +
            '<span class="submission-meta">' + sizeMB + " MB" + (f.can_delete ? " . " + remaining : " . Delete expired") + "</span>" +
            "</div>" +
            (f.can_delete ? '<button class="btn-remove" data-my-delete=\'' + escapeHtml(JSON.stringify({month:f.month,name:f.name})) + "' title=\"Delete\">&times;</button>" : "") +
            "</div>";
        }).join("");
        html += "</div>";
      });
      section.innerHTML = html;
      section.querySelectorAll("[data-my-delete]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var info = JSON.parse(btn.dataset.myDelete);
          deleteMySubmission(info.month, info.name, btn);
        });
      });
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

  async function deleteMySubmission(month, filename, btn) {
    if (!confirm('Delete "' + filename + '" from ' + month + '?')) return;
    if (!btn) btn = document.querySelector('[data-my-delete*="' + escapeHtml(filename) + '"]');
    setLoading(btn, true);
    try {
      var res = await fetch("/api/my-submissions/" + encodeURIComponent(month) + "/" + encodeURIComponent(filename), { method: "DELETE" });
      var data = await res.json();
      if (res.ok) { showToast(data.message || "File deleted", "success"); loadMySubmissions(); } else showToast(data.error || "Delete failed");
    } catch (_) { showToast("Network error"); }
    if (btn) setLoading(btn, false);
  }

  /* --- Billing --- */
  function loadExistingMonthBill(month) {
    document.getElementById("monthBillInput").value = "";
  }

  async function loadBillList() {
    if (isAdmin) return;
    var list = document.getElementById("billList");
    try {
      var res = await fetch("/api/billing");
      if (!res.ok) return;
      var data = await res.json();
      var totalBills = data.total_bills || {};
      var monthOrder = ["December","November","October","September","August","July","June","May","April","March","February","January"];
      var hasAny = monthOrder.some(function (m) { return totalBills[m] > 0; });
      if (!hasAny) {
        list.innerHTML = emptyStateHtml("No billing entries yet. Set a total bill for a month to get started.");
        return;
      }
      var html = "";
      var grandTotal = 0;
      monthOrder.forEach(function (m) {
        var bill = totalBills[m] || 0;
        if (bill <= 0) return;
        grandTotal += bill;
        html += '<div class="month-group">' +
          '<div class="month-group-header"><span class="badge badge-outline month-badge">' + m + '</span>' +
          ' <span class="badge badge-default month-badge" style="margin-left:0.375rem">Total: \u09F3' + bill.toFixed(2) + '</span></div></div>';
      });
      if (grandTotal > 0) {
        html += '<div class="bill-row bill-total"><span>Grand Total</span><span>\u09F3' + grandTotal.toFixed(2) + '</span></div>';
      }
      list.innerHTML = html;
    } catch (_) { list.innerHTML = emptyStateHtml("Failed to load billing"); }
  }

  
  /* --- set month bill toast --- */
  document.getElementById("setMonthBillBtn").addEventListener("click", async function () {
    var month = document.getElementById("monthSelect").value;
    var val = parseFloat(document.getElementById("monthBillInput").value);
    if (!month) { showToast("Select a month first"); return; }
    if (isNaN(val) || val <= 0) { showToast("Enter a valid total bill amount"); return; }
    try {
      var res = await fetch("/api/billing/total", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ month: month, total_bill: val }) });
      var data = await res.json();
      if (res.ok) { showToast("Total bill set to \u09F3" + val.toFixed(2) + " for " + month, "success"); loadBillList(); }
      else { showToast(data.error || "Failed to set bill"); }
    } catch (_) { showToast("Network error"); }
  });

  document.getElementById("monthSelect").addEventListener("change", function () {
    loadExistingMonthBill(this.value);
  });

  /* --- Admin Dashboard --- */
  async function loadUploadsModal() {
    var list = document.getElementById("uploadsModalList");
    list.innerHTML = skeletonHtml(8, "file-list");
    try {
      var res = await fetch("/api/admin/uploads");
      if (!res.ok) return;
      var data = await res.json();
      if (data.users.length === 0) { list.innerHTML = emptyStateHtml("No submissions yet", ""); return; }
      list.innerHTML = data.users.map(function (u) {
        return '<div class="admin-user-card' + (u.count === 0 ? " no-uploads" : "") + '">' +
          '<div class="admin-user-header">' +
          '<span class="admin-user-name">' +
          '<img class="profile-pic profile-pic-sm" src="/api/profile-pic/' + encodeURIComponent(u.username) + '" alt="" onerror="this.style.display=\'none\'" style="vertical-align:middle;margin-right:0.375rem" />' +
          escapeHtml(u.username) + '</span>' +
          '<div class="admin-user-actions">' +
          (u.count > 0 ? '<button class="btn btn-outline btn-sm open-folder-btn" data-open-folder="' + escapeHtml(u.username) + '" title="Open folder">Open Folder</button>' : "") +
          '<span class="admin-file-count' + (u.count === 0 ? " text-muted" : "") + '">' + (u.count === 0 ? "No uploads" : u.count + " file(s)") + "</span>" +
          "</div></div>" +
          (u.count > 0 ? '<div class="admin-file-list">' + u.files.map(function (f) {
            var v = f.verdict || "";
            var vLabel = verdictLabel(v);
            var vBadge = badgeClass(v);
            var source = f.producer || f.creator || "";
            var verifClass = f.verified === true ? "verified" : (f.verified === false ? "malicious" : "unverified");
            var verifLabel = f.verified === true ? "Verified" : (f.verified === false ? "Malicious" : "Unverified");
            return '<div class="admin-file-row">' +
              (f.month ? '<span class="badge badge-outline" style="font-size:0.65rem;margin-right:0.5rem">' + escapeHtml(f.month) + '</span>' : "") +
              '<span class="admin-file-name">' + escapeHtml(f.name) + "</span>" +
              '<span class="badge ' + vBadge + '" style="font-size:0.7rem">' + vLabel + "</span>" +
              (f.duplicate ? '<span class="badge badge-destructive" style="font-size:0.7rem">Duplicate</span>' : "") +
              '<button class="verify-btn ' + verifClass + '" data-verify=\'' + escapeHtml(JSON.stringify({user:u.username,month:f.month,name:f.name})) + "' title=\"Toggle verification\">" + verifLabel + "</button>" +
              (source ? '<span class="admin-file-source">' + escapeHtml(source) + "</span>" : "") +
              '<button class="btn-remove" data-modal-delete=\'' + escapeHtml(u.username + "/" + f.month + "/" + f.name) + "' title=\"Delete\">&times;</button>" +
              "</div>";
          }).join("") + "</div>" : "") +
          "</div>";
      }).join("");
      list.querySelectorAll("[data-modal-delete]").forEach(function (btn) { btn.addEventListener("click", function () { modalDeleteFile(btn.getAttribute("data-modal-delete")); }); });
      list.querySelectorAll("[data-open-folder]").forEach(function (btn) { btn.addEventListener("click", function () { openUserFolder(btn.dataset.openFolder); }); });
      list.querySelectorAll("[data-verify]").forEach(function (btn) { btn.addEventListener("click", function () { toggleVerification(btn.dataset.verify); }); });
      filterUploadsModal();
    } catch (_) { list.innerHTML = emptyStateHtml("Failed to load uploads"); }
  }

  function filterUploadsModal() {
    var q = (document.getElementById("uploadsSearch").value || "").toLowerCase().trim();
    var list = document.getElementById("uploadsModalList");
    list.querySelectorAll(".admin-user-card").forEach(function (card) {
      var name = card.querySelector(".admin-user-name").textContent.toLowerCase();
      card.style.display = (!q || name.indexOf(q) !== -1) ? "" : "none";
    });
  }

  function filterUsersModal() {
    var q = (document.getElementById("usersSearch").value || "").toLowerCase().trim();
    var list = document.getElementById("userList");
    list.querySelectorAll(".user-row").forEach(function (row) {
      var name = row.querySelector(".user-name").textContent.toLowerCase();
      row.style.display = (!q || name.indexOf(q) !== -1) ? "" : "none";
    });
  }

  function filterRequestsModal() {
    var q = (document.getElementById("requestsSearch").value || "").toLowerCase().trim();
    var list = document.getElementById("regRequestsList");
    list.querySelectorAll(".reg-request-card").forEach(function (card) {
      var text = card.textContent.toLowerCase();
      card.style.display = (!q || text.indexOf(q) !== -1) ? "" : "none";
    });
  }

  function filterAdminUploads() {
    var q = (document.getElementById("adminUploadsSearch").value || "").toLowerCase().trim();
    var list = document.getElementById("uploadsAdminList");
    list.querySelectorAll(".admin-user-card").forEach(function (card) {
      var name = card.querySelector(".admin-user-name").textContent.toLowerCase();
      card.style.display = (!q || name.indexOf(q) !== -1) ? "" : "none";
    });
  }

  async function loadUploadsAdminList() {
    var list = document.getElementById("uploadsAdminList");
    if (!list) return;
    if (!document.getElementById("adminUploadsSearch").dataset.bound) { document.getElementById("adminUploadsSearch").dataset.bound = "1"; document.getElementById("adminUploadsSearch").addEventListener("keyup", filterAdminUploads); }
    var cleanupBtn = document.getElementById("runCleanupBtn");
    if (cleanupBtn) { cleanupBtn.classList.remove("btn-outline"); cleanupBtn.classList.add("btn-destructive"); }
    list.innerHTML = skeletonHtml(8, "file-list");
    try {
      var res = await fetch("/api/admin/uploads");
      if (!res.ok) return;
      var data = await res.json();
      if (data.users.length === 0) { list.innerHTML = emptyStateHtml("No submissions yet", ""); return; }
      data.users.sort(function (a, b) { return (a.count === 0 ? 0 : 1) - (b.count === 0 ? 0 : 1); });
      list.innerHTML = data.users.map(function (u) {
        return '<div class="admin-user-card' + (u.count === 0 ? " no-uploads" : "") + '">' +
          '<div class="admin-user-header">' +
          '<span class="admin-user-name">' +
          '<img class="profile-pic profile-pic-sm" src="/api/profile-pic/' + encodeURIComponent(u.username) + '" alt="" onerror="this.style.display=\'none\'" style="vertical-align:middle;margin-right:0.375rem" />' +
          escapeHtml(u.username) + '</span>' +
          '<div class="admin-user-actions">' +
          (u.count > 0 ? '<button class="btn btn-outline btn-sm open-folder-btn" data-open-folder="' + escapeHtml(u.username) + '" title="Open folder">Open Folder</button>' : "") +
          '<span class="admin-file-count' + (u.count === 0 ? " text-muted" : "") + '">' + (u.count === 0 ? "No uploads" : u.count + " file(s)") + "</span>" +
          "</div></div>" +
          (u.count > 0 ? '<div class="admin-file-list">' + u.files.map(function (f) {
            var v = f.verdict || "";
            var vLabel = verdictLabel(v);
            var vBadge = badgeClass(v);
            var source = f.producer || f.creator || "";
            var verifClass = f.verified === true ? "verified" : (f.verified === false ? "malicious" : "unverified");
            var verifLabel = f.verified === true ? "Verified" : (f.verified === false ? "Malicious" : "Unverified");
            return '<div class="admin-file-row">' +
              (f.month ? '<span class="badge badge-outline" style="font-size:0.65rem;margin-right:0.5rem">' + escapeHtml(f.month) + '</span>' : "") +
              '<span class="admin-file-name">' + escapeHtml(f.name) + "</span>" +
              '<span class="badge ' + vBadge + '" style="font-size:0.7rem">' + vLabel + "</span>" +
              (f.duplicate ? '<span class="badge badge-destructive" style="font-size:0.7rem">Duplicate</span>' : "") +
              '<button class="verify-btn ' + verifClass + '" data-verify=\'' + escapeHtml(JSON.stringify({user:u.username,month:f.month,name:f.name})) + "' title=\"Toggle verification\">" + verifLabel + "</button>" +
              (source ? '<span class="admin-file-source">' + escapeHtml(source) + "</span>" : "") +
              '<button class="btn-remove" data-modal-delete=\'' + escapeHtml(u.username + "/" + f.month + "/" + f.name) + "' title=\"Delete\">&times;</button>" +
              "</div>";
          }).join("") + "</div>" : "") +
          "</div>";
      }).join("");
      list.querySelectorAll("[data-modal-delete]").forEach(function (btn) { btn.addEventListener("click", function () { modalDeleteFile(btn.getAttribute("data-modal-delete")); }); });
      list.querySelectorAll("[data-open-folder]").forEach(function (btn) { btn.addEventListener("click", function () { openUserFolder(btn.dataset.openFolder); }); });
      list.querySelectorAll("[data-verify]").forEach(function (btn) { btn.addEventListener("click", function () { toggleVerification(btn.dataset.verify); }); });
      filterAdminUploads();
    } catch (_) { list.innerHTML = emptyStateHtml("Failed to load uploads"); }
  }

  async function modalDeleteFile(path) {
    if (!confirm("Delete this file?")) return;
    try { var res = await fetch("/api/admin/uploads/" + path, { method: "DELETE" }); var data = await res.json(); if (res.ok) { showToast(data.message || "File deleted", "success"); if (document.getElementById("uploadsModalList")) loadUploadsModal(); } else { showToast(data.error || "Delete failed"); } } catch (_) { showToast("Network error"); }
  }

  async function openUserFolder(username) { try { await fetch("/api/admin/open-folder/" + encodeURIComponent(username)); } catch (_) {} }

  async function toggleVerification(jsonStr) {
    var info;
    try { info = JSON.parse(jsonStr); } catch (_) { return; }
    try {
      var res = await fetch("/api/admin/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: info.user, month: info.month, filename: info.name }) });
      var data = await res.json();
      if (res.ok) { showToast(data.message || "Verification toggled", "success"); if (document.getElementById("uploadsModalList")) loadUploadsModal(); } else showToast(data.error || "Failed");
    } catch (_) { showToast("Network error"); }
  }

  /* --- Registration Requests --- */
  async function loadRequestsBadge() {
    var btn = document.getElementById("regRequestsBtn");
    if (!btn) return;
    try {
      var res = await fetch("/api/admin/registration-requests");
      if (!res.ok) return;
      var data = await res.json();
      var count = data.requests ? data.requests.length : 0;
      var existing = btn.querySelector(".badge");
      if (existing) existing.remove();
      if (count > 0) {
        var badge = document.createElement("span");
        badge.className = "badge badge-destructive";
        badge.textContent = count;
        badge.style.marginLeft = "0.35rem";
        btn.appendChild(badge);
      }
    } catch (_) {}
  }

  async function loadRegRequests() {
    loadRequestsBadge();
    var list = document.getElementById("regRequestsList");
    list.innerHTML = skeletonHtml(4, "reg-card");
    try {
      var res = await fetch("/api/admin/registration-requests");
      if (!res.ok) return;
      var data = await res.json();
      if (data.requests.length === 0) { list.innerHTML = emptyStateHtml("No requests yet", ""); return; }
      list.innerHTML = data.requests.map(function (r) {
        return '<div class="reg-request-card">' +
          '<span class="reg-request-name">' + escapeHtml(r.name) + '</span>' +
          '<span class="reg-request-divider">|</span>' +
          '<span class="reg-request-team">' + escapeHtml(r.team) + '</span>' +
          '<span class="reg-request-divider">|</span>' +
          '<span class="reg-request-gmail">' + escapeHtml(r.gmail) + '</span>' +
          '<button class="reg-request-copy" data-copy="' + escapeHtml(r.gmail) + '" title="Copy email">Copy</button>' +
          '<button class="reg-request-remove" data-delete-reg="' + escapeHtml(r.gmail) + '" title="Remove">&times;</button>' +
          "</div>";
      }).join("");
      list.querySelectorAll("[data-copy]").forEach(function (btn) { btn.addEventListener("click", function () { navigator.clipboard.writeText(btn.dataset.copy); btn.textContent = "Copied!"; setTimeout(function () { btn.textContent = "Copy"; }, 1500); }); });
      list.querySelectorAll("[data-delete-reg]").forEach(function (btn) { btn.addEventListener("click", function () { deleteRegRequest(btn.dataset.deleteReg); }); });
      filterRequestsModal();
    } catch (_) { list.innerHTML = emptyStateHtml("Failed to load requests"); }
  }



  async function deleteRegRequest(gmail) {
    if (!confirm("Remove this request?")) return;
    try { var res = await fetch("/api/admin/registration-requests", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ gmail: gmail }) }); var data = await res.json(); if (res.ok) { showToast(data.message || "Request removed", "success"); loadRegRequests(); } else { showToast(data.error || "Failed to remove"); } } catch (_) { showToast("Network error"); }
  }

  async function deleteAllRegRequests() {
    if (!confirm("Delete ALL registration requests? This cannot be undone.")) return;
    try {
      var res = await fetch("/api/admin/registration-requests/all", { method: "DELETE" });
      var data = await res.json();
      if (res.ok) { showToast(data.message || "All requests deleted", "success"); loadRegRequests(); }
      else { showToast(data.error || "Failed to delete all"); }
    } catch (_) { showToast("Network error"); }
  }

  async function clearCache() {
    if (!confirm("Clear all cached upload data? This removes temporary files left from previous analyses.")) return;
    try {
      var res = await fetch("/api/admin/clear-cache", { method: "POST" });
      var data = await res.json();
      if (res.ok) { showToast(data.message || "Cache cleared", "success"); }
      else { showToast(data.error || "Failed to clear cache"); }
    } catch (_) { showToast("Network error"); }
  }

  async function clearAllHashes() {
    if (!confirm("Clear ALL stored file hashes? This will disable duplicate detection until new files are submitted.")) return;
    try {
      var res = await fetch("/api/admin/clear-hashes", { method: "POST" });
      var data = await res.json();
      if (res.ok) { showToast(data.message || "All hashes cleared", "success"); }
      else { showToast(data.error || "Failed to clear hashes"); }
    } catch (_) { showToast("Network error"); }
  }

  /* --- Site Settings --- */
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
      if (res.ok) { showToast("Settings saved", "success"); loadSiteConfig(); } else { showToast("Failed to save"); alertEl.textContent = "Failed to save"; alertEl.classList.remove("hidden"); }
    } catch (_) { showToast("Network error"); }
    setLoading(btn, false);
  }

  async function loadSiteConfig() {
    try {
      var res = await fetch("/api/site-config");
      if (!res.ok) return;
      var data = await res.json();
      var quoteEl = document.getElementById("dailyQuote");
      if (data.daily_quote) { quoteEl.textContent = "" + data.daily_quote + ""; quoteEl.classList.remove("hidden"); } else { quoteEl.classList.add("hidden"); }
      var bannerEl = document.getElementById("maintenanceBanner");
      if (data.maintenance_message) { document.getElementById("maintenanceText").textContent = data.maintenance_message; bannerEl.classList.remove("hidden"); } else { bannerEl.classList.add("hidden"); }
    } catch (_) {}
  }

  /* --- Cleanup --- */
  async function loadLogs() {
    try {
      var res = await fetch("/api/logs");
      if (!res.ok) return;
      var data = await res.json();
      var viewer = document.getElementById("logsViewer");
      if (!viewer) return;
      viewer.textContent = data.logs || "No logs yet";
      viewer.scrollTop = viewer.scrollHeight;
    } catch (_) { var v = document.getElementById("logsViewer"); if (v) v.textContent = "Failed to load logs"; }
  }


  async function loadCleanupStatus() { try { var res = await fetch("/api/admin/cleanup-status"); if (!res.ok) return; document.getElementById("cleanupToggle").checked = (await res.json()).enabled; } catch (_) {} }
  async function toggleCleanup() { try { var en = document.getElementById("cleanupToggle").checked; var res = await fetch("/api/admin/cleanup-toggle", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: en }) }); if (res.ok) showToast("Auto-cleanup " + (en ? "enabled" : "disabled"), "success"); } catch (_) {} }
  async function runCleanup() {
    if (!confirm("Delete all user submissions?")) return;
    if (!confirm("Are you sure? This action cannot be undone.")) return;
    var btn = document.getElementById("runCleanupBtn");
    setLoading(btn, true);
    try { var res = await fetch("/api/admin/cleanup", { method: "POST" }); if (res.ok) { showToast("All submissions deleted", "success"); loadUploadsAdminList(); if (document.getElementById("uploadsModalList")) loadUploadsModal(); } else { var d = await res.json(); showToast(d.error || "Cleanup failed"); } } catch (_) { showToast("Cleanup failed"); }
    setLoading(btn, false);
  }

  /* --- Logs --- */
  async function loadAdminLogs() {
    var viewer = document.getElementById("logsViewer");
    if (!viewer) return;
    viewer.innerHTML = skeletonHtml(12, "text");
    try {
      var res = await fetch("/api/logs");
      if (!res.ok) return;
      var data = await res.json();
      viewer.textContent = data.logs || "No logs yet";
      viewer.scrollTop = viewer.scrollHeight;
    } catch (_) { viewer.textContent = "Failed to load logs"; }
  }

  /* --- Event listeners --- */
  fileInput.addEventListener("change", function () { if (fileInput.files.length) handleFiles(fileInput.files); fileInput.value = ""; });
  folderInput.addEventListener("change", function () { if (folderInput.files.length) handleFiles(folderInput.files); folderInput.value = ""; });
  dropZone.addEventListener("dragover", function (e) { e.preventDefault(); dropZone.classList.add("drag-over"); });
  dropZone.addEventListener("dragleave", function () { dropZone.classList.remove("drag-over"); });
  dropZone.addEventListener("drop", function (e) { e.preventDefault(); dropZone.classList.remove("drag-over"); if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); });

  function onId(id, event, fn) { var el = document.getElementById(id); if (el) el.addEventListener(event, fn); }
  onId("submitFilesBtn", "click", submitStagedFiles);
  onId("clearStagingBtn", "click", function () { stagedFiles = []; document.getElementById("monthSelect").value = ""; document.getElementById("monthBillInput").value = ""; renderStaging(); });
  onId("refreshMySubmissionsBtn", "click", loadMySubmissions);
  onId("cleanupToggle", "change", toggleCleanup);
  onId("runCleanupBtn", "click", runCleanup);
  onId("deleteAllRegBtn", "click", deleteAllRegRequests);
  onId("deleteAllUsersBtn", "click", deleteAllUsers);
  onId("clearCacheBtn", "click", clearCache);
  onId("clearHashesBtn", "click", clearAllHashes);
  onId("manageUsersBtn", "click", function () { openDialog(document.getElementById("userModalOverlay")); loadUserList(); document.getElementById("deleteAllUsersBtn").classList.toggle("hidden", currentUser !== "IT"); });
  onId("closeUserModal", "click", function () { closeDialog(document.getElementById("userModalOverlay")); });
  onId("userModalOverlay", "click", function (e) { if (e.target === this) closeDialog(document.getElementById("userModalOverlay")); });
  onId("createUserBtn", "click", createUser);
  onId("generatePwBtn", "click", function () { document.getElementById("newPassword").value = generatePassword(16); });
  onId("togglePasswordsBtn", "click", function () {
    var btn = document.getElementById("togglePasswordsBtn");
    var show = btn.textContent === "Show Passwords";
    btn.textContent = show ? "Hide Passwords" : "Show Passwords";
    document.querySelectorAll("#userList .user-password-input").forEach(function (inp) { inp.type = show ? "text" : "password"; });
  });
  onId("uploadsBtn", "click", function () { openDialog(document.getElementById("uploadsModalOverlay")); loadUploadsModal(); loadCleanupStatus(); var isIT = currentUser === "IT"; document.getElementById("logsDivider").classList.toggle("hidden", !isIT); document.getElementById("logsTitle").classList.toggle("hidden", !isIT); document.getElementById("logsViewer").classList.toggle("hidden", !isIT); document.getElementById("clearCacheBtn").classList.toggle("hidden", !isIT); document.getElementById("clearHashesBtn").classList.toggle("hidden", !isIT); if (isIT) loadLogs(); });
  onId("closeUploadsModal", "click", function () { closeDialog(document.getElementById("uploadsModalOverlay")); });
  onId("uploadsModalOverlay", "click", function (e) { if (e.target === this) closeDialog(document.getElementById("uploadsModalOverlay")); });
  onId("regRequestsBtn", "click", function () { openDialog(document.getElementById("regRequestsOverlay")); loadRegRequests(); });
  onId("closeRegRequests", "click", function () { closeDialog(document.getElementById("regRequestsOverlay")); });
  onId("regRequestsOverlay", "click", function (e) { if (e.target === this) closeDialog(document.getElementById("regRequestsOverlay")); });
  onId("siteSettingsBtn", "click", function () { openDialog(document.getElementById("siteSettingsOverlay")); loadSiteSettingsForm(); });
  onId("closeSiteSettings", "click", function () { closeDialog(document.getElementById("siteSettingsOverlay")); });
  onId("siteSettingsOverlay", "click", function (e) { if (e.target === this) closeDialog(document.getElementById("siteSettingsOverlay")); });
  onId("saveSiteSettingsBtn", "click", saveSiteSettings);

  /* --- tab listeners --- */
  document.querySelectorAll(".tabs-trigger").forEach(function (btn) {
    btn.addEventListener("click", function () { switchUserTab(btn.dataset.tab); });
  });

  document.querySelectorAll(".admin-tab").forEach(function (btn) {
    btn.addEventListener("click", function () { switchAdminTab(btn.dataset.atab); });
  });

  onId("uploadsSearch", "keyup", filterUploadsModal);
  onId("usersSearch", "keyup", filterUsersModal);
  onId("requestsSearch", "keyup", filterRequestsModal);

})();
