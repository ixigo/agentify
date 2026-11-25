/* Agentify site: shared behaviour for every page.
   <body data-root="" | "../" data-page="home|how|proof|guides|reference"> */
(function () {
  "use strict";
  var body = document.body;
  var ROOT = body.getAttribute("data-root") || "";
  var PAGE = body.getAttribute("data-page") || "";

  var CMDS = [
    ["Memory", "agentify ctx load", "Recent activity, notes and hot files from earlier sessions.", true],
    ["Memory", "agentify ctx note \"<text>\"", "Record a gotcha or open thread for later sessions.", false],
    ["Memory", "agentify ctx decision \"<text>\"", "Record a decision with its reason.", false],
    ["Memory", "agentify ctx decisions \"<topic>\"", "Look up past decisions before revisiting a question.", false],
    ["Memory", "agentify ctx match \"<task>\"", "Show which notes would be injected for a task.", true],
    ["Memory", "agentify ctx handoff", "Write a handoff summary for the next session.", true],
    ["Memory", "agentify ctx pause / resume / clear", "Turn tracking off and on, or archive and reset the store.", false],
    ["Checks", "agentify risk --since <ref>", "Blast radius of a change and suggested tests.", true],
    ["Checks", "agentify test --since <ref> --run", "Run only the tests a change affects.", true],
    ["Routing", "agentify delegate quick \"<task>\"", "Small edits and quick questions to a fast model.", false],
    ["Routing", "agentify delegate implement \"<task>\"", "Standard feature work to a balanced model.", false],
    ["Routing", "agentify delegate heavy \"<task>\"", "Architecture and hard debugging to the strongest model.", false],
    ["Routing", "agentify delegate review --diff <ref>", "Independent review from the other vendor.", false],
    ["Routing", "agentify delegate research \"<question>\"", "Fast lookups and summaries.", false],
    ["Routing", "agentify delegate auto \"<task>\"", "Let Agentify classify the task and pick the route.", false],
    ["Routing", "agentify route explain \"<task>\"", "Show which route a task would take, without running it.", false],
    ["Routing", "agentify models", "Routing table, tiers and which CLIs are ready.", false],
    ["Index", "agentify scan", "Rebuild the repo index.", false],
    ["Index", "agentify query search <text>", "Search files and symbols.", false],
    ["Index", "agentify query def <symbol>", "Where a symbol is defined.", false],
    ["Index", "agentify query refs <symbol>", "Where a symbol is used.", false],
    ["Index", "agentify query callers <symbol>", "Who calls a function.", false],
    ["Index", "agentify query impacts <file>", "What depends on a file.", false],
    ["Setup", "agentify install", "Guidance, hooks and local store for this repo. Add --mcp to register MCP.", false],
    ["Setup", "agentify uninstall", "Remove only what Agentify added.", false],
    ["Setup", "agentify status", "What is wired for this repo.", false],
    ["Setup", "agentify doctor", "Check toolchain and provider readiness.", false],
    ["Setup", "agentify version --check", "Installed version vs the latest release.", false],
    ["Setup", "agentify clean --strays", "Remove stray stores outside a repo root.", false],
    ["Setup", "agentify serve", "MCP server for any MCP-capable agent.", false],
    ["Guides", "agentify migrate <folder> --dry-run", "Preview moving saved sessions between tools.", false],
    ["Guides", "agentify analyze", "HTML report of your agent history, made locally.", false],
    ["Guides", "agentify stats", "Usage and adoption numbers for this machine.", false],
    ["Guides", "agentify workflow install", "Board-to-draft-PR skills for GitHub, GitLab or Azure.", false],
    ["Guides", "agentify skill list", "List and install bundled agent skills.", false]
  ];

  var PAGES = [
    { kind: "Page", label: "Home", url: "index.html" },
    { kind: "Page", label: "How it works", url: "pages/usage.html" },
    { kind: "Page", label: "Proof", url: "pages/proof.html" },
    { kind: "Page", label: "Reference: every command", url: "pages/reference.html" },
    { kind: "Guide", label: "Switch tools (migrate sessions)", url: "pages/migrate.html" },
    { kind: "Guide", label: "Board to PR · GitHub", url: "pages/workflow-gh.html" },
    { kind: "Guide", label: "Board to MR · GitLab", url: "pages/workflow-glab.html" },
    { kind: "Guide", label: "Board to PR · Azure DevOps", url: "pages/workflow-azure.html" },
    { kind: "Guide", label: "Tune it (config)", url: "pages/config.html" },
    { kind: "Guide", label: "See your usage (analyze)", url: "pages/analyze.html" },
    { kind: "Guide", label: "Skills catalog", url: "skill-catalog.html" },
    { kind: "Guide", label: "The skill command", url: "pages/skill.html" },
    { kind: "Section", label: "Install in three steps", url: "index.html#install" },
    { kind: "Section", label: "Watch the 40-second explainer", url: "index.html#top" },
    { kind: "Section", label: "What happens on its own", url: "index.html#home-auto" },
    { kind: "Section", label: "Side by side comparison", url: "index.html#home-compare" },
    { kind: "Section", label: "Who it's for", url: "index.html#home-fit" }
  ];

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function href(u) { return ROOT + u; }

  // current page in nav
  document.querySelectorAll(".links a[data-page]").forEach(function (a) {
    if (a.getAttribute("data-page") === PAGE) a.setAttribute("aria-current", "page");
  });

  // mobile menu
  var nav = document.getElementById("nav"), menuBtn = document.getElementById("menuBtn");
  if (nav && menuBtn) {
    menuBtn.addEventListener("click", function () {
      var open = !nav.classList.contains("open");
      nav.classList.toggle("open", open);
      menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }

  // copy buttons
  document.addEventListener("click", function (e) {
    var btn = e.target.closest(".copy"); if (!btn) return;
    var el = document.getElementById(btn.getAttribute("data-copy"));
    var text = el ? el.textContent : "";
    function sel() {
      try { var r = document.createRange(); r.selectNodeContents(el); var s = getSelection(); s.removeAllRanges(); s.addRange(r); } catch (x) {}
      btn.textContent = "Selected";
    }
    try { navigator.clipboard.writeText(text).then(function () { btn.textContent = "Copied"; }, sel); } catch (x) { sel(); }
    setTimeout(function () { btn.textContent = "Copy"; }, 1600);
  });

  // tile glow follows the pointer
  document.querySelectorAll(".tile").forEach(function (t) {
    t.addEventListener("pointermove", function (e) {
      var r = t.getBoundingClientRect();
      t.style.setProperty("--mx", ((e.clientX - r.left) / r.width * 100) + "%");
      t.style.setProperty("--my", ((e.clientY - r.top) / r.height * 100) + "%");
    });
  });

  // YouTube: swap the thumbnail for the player on click
  document.querySelectorAll("a.yt[data-yt]").forEach(function (a) {
    a.addEventListener("click", function (e) {
      if (e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      var id = a.getAttribute("data-yt");
      var f = document.createElement("iframe");
      f.src = "https://www.youtube-nocookie.com/embed/" + encodeURIComponent(id) + "?autoplay=1&rel=0&modestbranding=1";
      f.title = a.getAttribute("aria-label") || "Agentify explainer video";
      f.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture";
      f.allowFullscreen = true;
      a.appendChild(f);
      a.classList.add("playing");
    });
  });

  // reference list (only on pages with #refList)
  var refList = document.getElementById("refList"), refq = document.getElementById("refq");
  var refGroup = "";
  function renderRef() {
    if (!refList) return;
    var q = (refq && refq.value || "").trim().toLowerCase();
    var groups = {}, order = [];
    CMDS.forEach(function (c) {
      if (refGroup && c[0] !== refGroup) return;
      if (q && (c[1] + " " + c[2] + " " + c[0]).toLowerCase().indexOf(q) < 0) return;
      if (!groups[c[0]]) { groups[c[0]] = []; order.push(c[0]); }
      groups[c[0]].push(c);
    });
    if (!order.length) { refList.innerHTML = '<p class="empty">No command matches “' + esc(q) + '”. Try a shorter word.</p>'; return; }
    refList.innerHTML = order.map(function (g) {
      return '<div class="refgroup"><h3>' + g + '</h3>' + groups[g].map(function (c) {
        return '<div class="cmdrow"><code>' + esc(c[1]) + '</code><p>' + esc(c[2]) + (c[3] ? '<span class="auto">automatic</span>' : '') + '</p></div>';
      }).join("") + '</div>';
    }).join("");
  }
  if (refList) {
    try { var q0 = new URLSearchParams(location.search).get("q"); if (q0 && refq) refq.value = q0; } catch (x) {}
    if (refq) refq.addEventListener("input", renderRef);
    document.querySelectorAll(".fchip[data-group]").forEach(function (b) {
      b.addEventListener("click", function () {
        var g = b.getAttribute("data-group");
        refGroup = refGroup === g ? "" : g;
        document.querySelectorAll(".fchip[data-group]").forEach(function (o) { o.setAttribute("aria-pressed", o.getAttribute("data-group") === refGroup ? "true" : "false"); });
        renderRef();
      });
    });
    renderRef();
  }

  // command palette
  var back = document.getElementById("palBack"), pin = document.getElementById("palIn"), plist = document.getElementById("palList");
  var hint = document.getElementById("kbdHint");
  var isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  if (hint) hint.textContent = isMac ? "⌘K" : "Ctrl K";
  var ALL = PAGES.concat(CMDS.map(function (c) {
    var word = c[1].replace(/^agentify\s+/, "").split(" ")[0];
    return { kind: "Command", label: c[1], cmd: true, url: "pages/reference.html?q=" + encodeURIComponent(word) };
  }));
  var items = [], sel = 0;
  function renderPal() {
    var q = pin.value.trim().toLowerCase();
    items = ALL.filter(function (i) { return !q || i.label.toLowerCase().indexOf(q) >= 0 || i.kind.toLowerCase().indexOf(q) >= 0; }).slice(0, 40);
    if (sel >= items.length) sel = 0;
    plist.innerHTML = items.length ? items.map(function (i, n) {
      return '<li role="option" data-i="' + n + '" aria-selected="' + (n === sel) + '"><span class="kind">' + i.kind + '</span><span class="t">' + (i.cmd ? '<code>' + esc(i.label) + '</code>' : esc(i.label)) + '</span></li>';
    }).join("") : '<li aria-disabled="true"><span class="t" style="color:var(--muted)">Nothing matches. Try “risk”, “proof” or “migrate”.</span></li>';
    var cur = plist.querySelector('[aria-selected="true"]'); if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: "nearest" });
  }
  function openPal() { if (!back) return; back.hidden = false; pin.value = ""; sel = 0; renderPal(); setTimeout(function () { pin.focus(); }, 10); }
  function closePal() { if (back) back.hidden = true; }
  function pick(i) { var it = items[i]; if (!it) return; closePal(); location.href = href(it.url); }
  if (back) {
    var openBtn = document.getElementById("openPal");
    if (openBtn) openBtn.addEventListener("click", openPal);
    back.addEventListener("click", function (e) { if (e.target === back) closePal(); });
    plist.addEventListener("click", function (e) { var li = e.target.closest("li[data-i]"); if (li) pick(+li.getAttribute("data-i")); });
    pin.addEventListener("input", function () { sel = 0; renderPal(); });
    pin.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); renderPal(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(0, sel - 1); renderPal(); }
      else if (e.key === "Enter") { e.preventDefault(); pick(sel); }
    });
  }
  document.addEventListener("keydown", function (e) {
    var tag = (document.activeElement && document.activeElement.tagName) || "";
    if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) { e.preventDefault(); if (back && back.hidden) openPal(); else closePal(); }
    else if (e.key === "Escape" && back && !back.hidden) closePal();
    else if (e.key === "/" && (!back || back.hidden) && tag !== "INPUT" && tag !== "TEXTAREA") {
      var target = document.querySelector("input[data-slash]");
      if (target) { e.preventDefault(); target.focus(); }
    }
  });
})();
