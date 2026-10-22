const escapeJson = (value) => JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

const STYLE = `
:root {
  --bg: #f4f5f8; --surface: #ffffff; --fg: #1b1e2f; --muted: #5d6276; --rule: #dfe2ea;
  --accent: #c95c08; --ok: #0b8a52; --warn: #a76200; --bad: #c71e22; --chip: #eceef4;
  --mono: ui-monospace, "SF Mono", Menlo, monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) { :root {
  --bg: #0f1118; --surface: #171a24; --fg: #e9eaf0; --muted: #a2a7b8; --rule: #2a2e3c;
  --accent: #ff9a45; --ok: #46c98a; --warn: #f0b04a; --bad: #ff6b6e; --chip: #222634; color-scheme: dark } }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 var(--sans); }
header { position: sticky; top: 0; z-index: 5; background: var(--surface); border-bottom: 1px solid var(--rule); padding: 12px 20px; display: grid; gap: 10px; }
.title-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 18px; }
h1 { font-size: 18px; margin: 0; }
.targets { display: flex; flex-wrap: wrap; gap: 6px 14px; font: 12px var(--mono); color: var(--muted); }
.targets b { color: var(--fg); }
.tabs { display: flex; gap: 4px; margin-left: auto; }
.tabs button, button.chip { font: 600 12.5px var(--sans); border: 1px solid var(--rule); background: var(--surface); color: var(--fg); padding: 5px 12px; border-radius: 999px; cursor: pointer; }
.tabs button[aria-selected="true"], button.chip[aria-pressed="true"] { background: var(--fg); color: var(--surface); border-color: var(--fg); }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.stats, .controls, .group { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; }
.group { gap: 4px; }
.group > span { font: 600 11px var(--mono); text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin-right: 4px; }
.stat { font: 600 12px var(--mono); padding: 3px 9px; border-radius: 999px; background: var(--chip); }
.ok { color: var(--ok); } .bad { color: var(--bad); } .warn { color: var(--warn); } .accent { color: var(--accent); }
main { padding: 16px 20px 80px; display: grid; gap: 28px; }
section.flow h2 { font-size: 15px; margin: 0 0 2px; }
.sub { color: var(--muted); font-size: 12px; margin-bottom: 10px; }
.grid { overflow-x: auto; border: 1px solid var(--rule); border-radius: 10px; background: var(--surface); }
.grid table { border-collapse: separate; border-spacing: 0; }
.grid th, .grid td { border-bottom: 1px solid var(--rule); border-right: 1px solid var(--rule); padding: 8px; vertical-align: top; }
.grid thead th { font: 600 12px var(--sans); text-align: left; white-space: nowrap; }
.grid thead th small, .grid tbody th small { display: block; font: 11px var(--mono); color: var(--muted); font-weight: 400; }
.grid tbody th { text-align: left; font: 500 12px var(--sans); width: 150px; min-width: 150px; position: sticky; left: 0; background: var(--surface); z-index: 1; }
.cell { width: var(--cell); min-width: var(--cell); }
.pair { display: grid; grid-template-columns: repeat(var(--cols), 1fr); gap: 4px; }
.shot { display: block; padding: 0; border: 1px solid var(--rule); border-radius: 6px; background: var(--chip); cursor: zoom-in; width: 100%; overflow: hidden; position: relative; }
.shot img { display: block; width: 100%; height: var(--thumb-h); object-fit: cover; object-position: top; }
.shot .tag { position: absolute; left: 4px; top: 4px; font: 600 9.5px var(--mono); background: rgb(0 0 0 / .65); color: #fff; padding: 1px 5px; border-radius: 3px; }
.cell.failed .shot { border: 2px solid var(--bad); }
.cell.changed .shot { border-color: var(--accent); }
.badges { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 4px; }
.badge { font: 600 10.5px var(--mono); padding: 1px 6px; border-radius: 4px; background: var(--chip); }
.empty { color: var(--muted); font-size: 12px; font-style: italic; padding: 12px 4px; }
.err { color: var(--bad); font: 11px/1.4 var(--mono); margin-top: 4px; word-break: break-word; max-height: 4.2em; overflow: hidden; }
.build { display: grid; gap: 24px; max-width: 1200px; }
.build h2 { font-size: 16px; margin: 0 0 8px; }
.why { background: var(--surface); border: 1px solid var(--rule); border-left: 4px solid var(--accent); border-radius: 10px; padding: 14px 18px; }
.why ul { margin: 0; padding-left: 18px; display: grid; gap: 6px; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 10px; }
.card { background: var(--surface); border: 1px solid var(--rule); border-radius: 10px; padding: 12px 14px; display: grid; gap: 2px; }
.card .label { font: 600 11px var(--mono); text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
.card .value { font: 600 20px var(--sans); font-variant-numeric: tabular-nums; }
.card .delta { font: 12px var(--mono); }
.grow { color: var(--bad); } .shrink { color: var(--ok); } .same { color: var(--muted); }
.scroll { overflow-x: auto; border: 1px solid var(--rule); border-radius: 10px; background: var(--surface); }
.data { width: 100%; border-collapse: collapse; font-size: 13px; }
.data th, .data td { padding: 7px 10px; border-bottom: 1px solid var(--rule); text-align: left; font-variant-numeric: tabular-nums; }
.data th { font: 600 11px var(--mono); text-transform: uppercase; letter-spacing: .05em; color: var(--muted); background: var(--chip); }
.data td.num { text-align: right; font: 12px var(--mono); white-space: nowrap; }
.data td.name { font: 12px var(--mono); word-break: break-all; }
.data td.name small { display: block; color: var(--muted); }
dialog { border: 0; padding: 0; background: transparent; max-width: 100vw; max-height: 100vh; width: 100vw; height: 100vh; }
dialog::backdrop { background: rgb(0 0 0 / .85); }
.lb { display: grid; grid-template-rows: auto 1fr; height: 100%; color: #fff; }
.lb-bar { display: flex; gap: 12px; align-items: center; padding: 10px 16px; background: rgb(0 0 0 / .5); flex-wrap: wrap; }
.lb-bar .k { font: 11px var(--mono); opacity: .7; margin-left: auto; }
.lb-bar button { background: rgb(255 255 255 / .12); color: #fff; border: 0; border-radius: 6px; padding: 5px 10px; cursor: pointer; }
.lb-body { overflow: auto; display: flex; justify-content: center; align-items: flex-start; padding: 16px; gap: 14px; }
.lb-col { display: grid; gap: 6px; justify-items: center; }
.lb-col span { font: 600 11px var(--mono); opacity: .8; text-transform: uppercase; }
.lb-col img { max-width: min(30vw, 520px); height: auto; border-radius: 8px; background: #fff; }
.lb-col.solo img { max-width: min(90vw, 760px); }
.lb-side { max-width: 320px; font: 12px/1.5 var(--mono); color: #ddd; }
.lb-side ul { padding-left: 16px; margin: 4px 0 12px; }
@media (max-width: 800px) { .lb-body { flex-direction: column; align-items: center; } .lb-col img { max-width: 92vw; } }
`;

const SCRIPT = `
const M = JSON.parse(document.getElementById("manifest").textContent);
const compare = M.compare;
const CHANGE = M.diffThreshold;
const groups = [...new Set(M.flows.map((f) => f.group))];
const state = { tab: location.hash === "#build" ? "build" : "screens", mode: compare ? "side" : "after", viewport: M.viewports[0], groups: new Set(groups), clients: new Set(M.clients.map((c) => c.id)), issuesOnly: false, changedOnly: false, size: 210 };
const byKey = new Map(M.results.map((r) => [r.client + "|" + r.viewport + "|" + r.flow, r]));
const el = (tag, attrs = {}, ...kids) => { const n = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (v === undefined || v === null || v === false) continue; if (k === "class") n.className = v; else if (k.startsWith("on")) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v); } kids.flat().forEach((k) => k != null && n.append(k)); return n; };
const kb = (b) => Math.abs(b) < 1024 ? Math.round(b) + " B" : (b / 1024).toFixed(1) + " KB";
const signed = (b) => (b > 0 ? "+" : b < 0 ? "−" : "±") + kb(Math.abs(b));
const tone = (b) => Math.abs(b) < 102 ? "same" : b > 0 ? "grow" : "shrink";
const pct = (a, b) => a ? ((b - a) / a * 100).toFixed(1) + "%" : "new";
const failed = (run) => !!(run && (run.error || run.steps.some((s) => s.error)));
const warned = (run) => !!(run && run.steps.some((s) => s.networkErrors?.length || s.consoleErrors?.length));
const hasIssue = (r) => failed(r?.after) || warned(r?.after) || failed(r?.before);
const changedCount = (r) => Object.values(r?.diffs ?? {}).filter((d) => d.ratio > CHANGE).length;

const targets = document.getElementById("targets");
M.targets.forEach((t) => targets.append(el("span", {}, el("b", {}, t.label), " " + t.ref + " @ " + t.sha + (t.dirtyFiles ? " (+" + t.dirtyFiles + " uncommitted)" : ""))));
targets.append(el("span", {}, new Date(M.generatedAt).toLocaleString() + " · " + M.durationSeconds + "s"));

function chipGroup(id, items, isOn, toggle) {
  const box = document.getElementById(id);
  items.forEach((item) => box.append(el("button", { class: "chip", "data-id": item.id, title: item.title ?? "", onclick: () => { toggle(item.id); update(); } }, item.label)));
  box._isOn = isOn;
}
const modes = compare ? [{ id: "side", label: "Before | After" }, { id: "after", label: "After" }, { id: "before", label: "Before" }, { id: "diff", label: "Diff" }] : [{ id: "after", label: "Screens" }];
chipGroup("mode", modes, (m) => m === state.mode, (m) => { state.mode = m; });
chipGroup("viewport", M.viewports.map((v) => ({ id: v, label: v })), (v) => v === state.viewport, (v) => { state.viewport = v; });
chipGroup("section", groups.map((g) => ({ id: g, label: g })), (g) => state.groups.has(g), (g) => state.groups.has(g) ? state.groups.delete(g) : state.groups.add(g));
chipGroup("clients", M.clients.map((c) => ({ id: c.id, label: c.label, title: c.id })), (id) => state.clients.has(id), (id) => state.clients.has(id) ? state.clients.delete(id) : state.clients.add(id));
document.getElementById("issues-only").onclick = () => { state.issuesOnly = !state.issuesOnly; update(); };
document.getElementById("changed-only").onclick = () => { state.changedOnly = !state.changedOnly; update(); };
document.getElementById("changed-only").hidden = !compare;
document.querySelectorAll("[data-size]").forEach((b) => { b.onclick = () => { state.size = Number(b.dataset.size); update(); }; });
document.getElementById("tab-screens").onclick = () => { state.tab = "screens"; update(); };
document.getElementById("tab-build").onclick = () => { state.tab = "build"; update(); };
document.getElementById("tab-screens").hidden = !M.results.length;

function sync() {
  document.querySelectorAll(".group[id]").forEach((box) => box._isOn && box.querySelectorAll(".chip").forEach((b) => b.setAttribute("aria-pressed", String(box._isOn(b.dataset.id)))));
  document.getElementById("issues-only").setAttribute("aria-pressed", String(state.issuesOnly));
  document.getElementById("changed-only").setAttribute("aria-pressed", String(state.changedOnly));
  document.querySelectorAll("[data-size]").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.size) === state.size)));
  document.getElementById("tab-screens").setAttribute("aria-selected", String(state.tab === "screens"));
  document.getElementById("tab-build").setAttribute("aria-selected", String(state.tab === "build"));
  document.querySelectorAll(".screen-only").forEach((n) => { n.hidden = state.tab !== "screens"; });
}

function renderStats() {
  const box = document.getElementById("stats");
  box.replaceChildren();
  if (state.tab === "build") {
    const b = M.build;
    if (b?.before) box.append(el("span", { class: "stat accent" }, "JS gzip " + signed(b.after.totals.jsGzip - b.before.totals.jsGzip)), el("span", { class: "stat accent" }, "first paint " + signed(b.after.totals.initialJsGzip - b.before.totals.initialJsGzip)), el("span", { class: "stat accent" }, "CSS gzip " + signed(b.after.totals.cssGzip - b.before.totals.cssGzip)));
    return;
  }
  let shots = 0, clean = 0, bad = 0, warn = 0, skipped = 0, changed = 0, compared = 0, beforeBad = 0;
  M.results.forEach((r) => {
    if (r.after.skipped) { skipped++; return; }
    shots += r.after.steps.filter((s) => s.shot).length;
    if (failed(r.after)) bad++; else if (warned(r.after)) warn++; else clean++;
    if (failed(r.before)) beforeBad++;
    Object.values(r.diffs ?? {}).forEach((d) => { compared++; if (d.ratio > CHANGE) changed++; });
  });
  box.append(el("span", { class: "stat" }, shots + " screens"), el("span", { class: "stat ok" }, clean + " clean runs"), el("span", { class: "stat warn" }, warn + " with console/network errors"), el("span", { class: "stat bad" }, bad + " failed"), el("span", { class: "stat" }, skipped + " skipped"));
  if (compare) box.append(el("span", { class: "stat accent" }, changed + " of " + compared + " screens changed"), el("span", { class: "stat" }, beforeBad + " runs failed on before"));
}

let grid = [];
function renderScreens(main) {
  const cols = state.mode === "side" ? 2 : 1;
  main.style.setProperty("--cols", cols);
  main.style.setProperty("--cell", (state.size * cols + (cols - 1) * 4) + "px");
  main.style.setProperty("--thumb-h", Math.round(state.size * (state.viewport === "desktop" ? 0.65 : 1.9)) + "px");
  const clients = M.clients.filter((c) => state.clients.has(c.id));
  grid = [];
  M.flows.filter((f) => state.groups.has(f.group)).forEach((flow) => {
    const results = clients.map((c) => byKey.get(c.id + "|" + state.viewport + "|" + flow.id));
    if (state.issuesOnly && !results.some(hasIssue)) return;
    if (state.changedOnly && !results.some((r) => changedCount(r) > 0 || failed(r?.before) !== failed(r?.after))) return;
    const stepIds = [...new Set([...flow.steps.map((s) => s.id), ...results.flatMap((r) => [...(r?.after?.steps ?? []), ...(r?.before?.steps ?? [])].filter((s) => s.shot).map((s) => s.id))])];
    const title = (id) => flow.steps.find((s) => s.id === id)?.title ?? id;
    const rows = stepIds.map((stepId) => {
      const row = [];
      const cells = clients.map((c, index) => {
        const r = results[index];
        const td = el("td", { class: "cell" });
        if (!r) return (td.append(el("div", { class: "empty" }, "not run")), td);
        if (r.after.skipped) return (td.append(el("div", { class: "empty" }, r.after.skipped)), td);
        const a = r.after.steps.find((s) => s.id === stepId);
        const b = r.before?.steps.find((s) => s.id === stepId);
        const d = r.diffs?.[stepId];
        if (!a && !b) return (td.append(el("div", { class: "empty" }, failed(r.after) ? "blocked by an earlier failure" : "—")), td);
        if (state.changedOnly && !(d?.ratio > CHANGE) && !(a?.error || b?.error)) return (td.append(el("div", { class: "empty" }, "unchanged")), td);
        const pos = { flow, stepId, client: c, after: a, before: b, diff: d };
        row.push(pos);
        if (a?.error) td.classList.add("failed");
        if (d?.ratio > CHANGE) td.classList.add("changed");
        const thumb = (src, tag) => el("button", { class: "shot", onclick: () => openLightbox(pos), "aria-label": c.label + " " + title(stepId) + " " + tag }, src ? el("img", { src, loading: "lazy", alt: "" }) : el("div", { class: "empty" }, "no " + tag), compare ? el("span", { class: "tag" }, tag) : null);
        const pair = el("div", { class: "pair" });
        if (state.mode === "side") pair.append(thumb(b?.shot, "before"), thumb(a?.shot, "after"));
        else if (state.mode === "before") pair.append(thumb(b?.shot, "before"));
        else if (state.mode === "diff") pair.append(thumb(d?.diffShot, "diff"));
        else pair.append(thumb(a?.shot, "after"));
        td.append(pair);
        const badges = el("div", { class: "badges" });
        if (d && !d.error) badges.append(el("span", { class: "badge " + (d.ratio > CHANGE ? "accent" : "ok") }, d.ratio > CHANGE ? "Δ " + (d.ratio * 100).toFixed(1) + "%" : "same"));
        if (d?.error) badges.append(el("span", { class: "badge warn", title: d.error }, "diff failed"));
        if (d && Math.abs(d.heightAfter - d.heightBefore) > 2) badges.append(el("span", { class: "badge", title: "page height before → after" }, Math.round(d.heightBefore) + "→" + Math.round(d.heightAfter) + "px"));
        if (compare && b?.error && !a?.error) badges.append(el("span", { class: "badge warn", title: b.error }, "before failed"));
        if (a?.error) badges.append(el("span", { class: "badge bad" }, "step failed"));
        if (a?.networkErrors?.length) badges.append(el("span", { class: "badge warn", title: a.networkErrors.join("\\n") }, a.networkErrors.length + " network"));
        if (a?.consoleErrors?.length) badges.append(el("span", { class: "badge warn", title: a.consoleErrors.join("\\n") }, a.consoleErrors.length + " console"));
        if (badges.childNodes.length) td.append(badges);
        if (a?.error) td.append(el("div", { class: "err", title: a.error }, a.error));
        return td;
      });
      grid.push(row);
      return el("tr", {}, el("th", {}, title(stepId), el("small", {}, stepId)), cells);
    });
    main.append(el("section", { class: "flow" },
      el("h2", {}, flow.title, flow.description ? el("span", { class: "sub" }, " · " + flow.description) : null),
      el("div", { class: "sub" }, flow.group + " · " + flow.id),
      el("div", { class: "grid" }, el("table", {}, el("thead", {}, el("tr", {}, el("th", {}, "Step"), clients.map((c) => el("th", {}, c.label, el("small", {}, c.id))))), el("tbody", {}, rows)))));
  });
  if (!main.childNodes.length) main.append(el("p", { class: "empty" }, "Nothing matches the current filters."));
}

function card(label, before, after, fmt) {
  const delta = after - before;
  const isKb = !fmt;
  return el("div", { class: "card" }, el("span", { class: "label" }, label), el("span", { class: "value" }, isKb ? kb(after) : String(after)),
    before === null ? null : el("span", { class: "delta " + (isKb ? tone(delta) : delta > 0 ? "grow" : delta < 0 ? "shrink" : "same") }, (isKb ? signed(delta) + " (" + pct(before, after) + ")" : (delta > 0 ? "+" : "") + delta) + " · was " + (isKb ? kb(before) : before)));
}
function table(title, head, rows) {
  return el("section", {}, el("h2", {}, title), el("div", { class: "scroll" }, el("table", { class: "data" }, el("thead", {}, el("tr", {}, head.map((h, i) => el("th", { style: i ? "text-align:right" : null }, h)))), el("tbody", {}, rows))));
}
function deltaRows(items, limit) {
  return items.slice(0, limit).map((r) => el("tr", {}, el("td", { class: "name" }, r.name, r.note ? el("small", {}, r.note) : null), el("td", { class: "num" }, r.before ? kb(r.before) : "—"), el("td", { class: "num" }, r.after ? kb(r.after) : "—"), el("td", { class: "num " + tone(r.after - r.before) }, signed(r.after - r.before))));
}
function renderBuild(main) {
  const box = el("div", { class: "build" });
  main.append(box);
  if (M.buildError) return box.append(el("div", { class: "why" }, el("h2", {}, "Build failed"), el("pre", {}, M.buildError)));
  const b = M.build;
  if (!b) return box.append(el("p", { class: "empty" }, "Build size was not measured. Add build to the config and run with --baseline <ref> or --build-size."));
  if (b.single) {
    const t = b.single.totals;
    box.append(el("div", { class: "cards" }, card("JS gzip", null, t.jsGzip), card("First-paint JS gzip", null, t.initialJsGzip), card("CSS gzip", null, t.cssGzip), card("JS files", null, t.jsFiles, String)));
    if (b.single.pages.length) box.append(table("JavaScript to open each page", ["Page", "JS to open", "Own", "Later", "CSS"], b.single.pages.map((p) => el("tr", {}, el("td", { class: "name" }, p.label, el("small", {}, p.route ?? "")), ...[p.totalJs, p.pageJs, p.laterJs, p.css].map((v) => el("td", { class: "num" }, kb(v)))))));
    return;
  }
  const t0 = b.before.totals, t1 = b.after.totals;
  box.append(
    el("div", { class: "why" }, el("h2", {}, "Why the size changed"), el("ul", {}, b.why.map((w) => el("li", {}, w)))),
    el("div", { class: "cards" }, card("JS gzip", t0.jsGzip, t1.jsGzip), card("JS brotli", t0.jsBrotli, t1.jsBrotli), card("JS raw", t0.jsRaw, t1.jsRaw), card("First-paint JS gzip", t0.initialJsGzip, t1.initialJsGzip), card("CSS gzip", t0.cssGzip, t1.cssGzip), card("JS files", t0.jsFiles, t1.jsFiles, String), card("CSS rules", t0.cssRules, t1.cssRules, String)),
  );
  if (b.pageDiff.length) box.append(table("JavaScript to open each page (gzip)", ["Page", "Before", "After", "Change", "Own JS", "Loaded later", "CSS"], b.pageDiff.map((p) => el("tr", {},
    el("td", { class: "name" }, p.label, el("small", {}, p.route ?? "")), el("td", { class: "num" }, kb(p.totalBefore)), el("td", { class: "num" }, kb(p.totalAfter)), el("td", { class: "num " + tone(p.delta) }, signed(p.delta)),
    el("td", { class: "num" }, kb(p.pageBefore) + " → " + kb(p.pageAfter)), el("td", { class: "num" }, kb(p.laterBefore) + " → " + kb(p.laterAfter)), el("td", { class: "num" }, kb(p.cssBefore) + " → " + kb(p.cssAfter))))));
  const packages = b.groupDiff.filter((g) => g.kind === "package");
  if (packages.length) box.append(table("Packages (gzip, attributed by module share)", ["Package", "Before", "After", "Change"], deltaRows(packages.map((g) => ({ name: g.key, before: g.gzipBefore, after: g.gzipAfter, note: [g.versionBefore && g.versionAfter && g.versionBefore !== g.versionAfter ? g.versionBefore + " → " + g.versionAfter : g.versionAfter ?? g.versionBefore ?? "", g.status !== "changed" ? g.status : ""].filter(Boolean).join(" · ") })), 40)));
  const sources = b.groupDiff.filter((g) => g.kind !== "package");
  if (sources.length) box.append(table("App source areas (gzip)", ["Source", "Before", "After", "Change"], deltaRows(sources.map((g) => ({ name: g.key, before: g.gzipBefore, after: g.gzipAfter, note: g.status !== "changed" ? g.status : "" })), 40)));
  box.append(table("Output files (gzip, hash stripped)", ["File", "Before", "After", "Change"], deltaRows(b.fileDiff.map((f) => ({ name: f.name, before: f.gzipBefore, after: f.gzipAfter, note: f.kind + (f.initial ? " · first paint" : "") })), 80)));
}

function update() {
  sync();
  renderStats();
  const main = document.getElementById("main");
  main.replaceChildren();
  if (state.tab === "build" || !M.results.length) renderBuild(main); else renderScreens(main);
}

const lb = document.getElementById("lightbox");
let current = null;
function openLightbox(pos) {
  current = pos;
  const { flow, client, after, before, diff, stepId } = pos;
  document.getElementById("lb-title").textContent = flow.title + " · " + (after?.title ?? before?.title ?? stepId) + " · " + client.label + " · " + state.viewport;
  const col = (label, src, solo) => el("div", { class: "lb-col" + (solo ? " solo" : "") }, el("span", {}, label), src ? el("a", { href: src, target: "_blank" }, el("img", { src, alt: label })) : el("div", { class: "empty" }, "no screenshot"));
  const notes = (label, step) => step ? [
    step.error ? el("div", { class: "bad" }, label + " step failed: " + step.error) : null,
    step.networkErrors?.length ? el("div", { class: "warn" }, label + " network errors", el("ul", {}, step.networkErrors.map((u) => el("li", {}, u)))) : null,
    step.consoleErrors?.length ? el("div", { class: "warn" }, label + " console errors", el("ul", {}, step.consoleErrors.map((u) => el("li", {}, u)))) : null,
  ] : [];
  document.getElementById("lb-body").replaceChildren(
    ...(compare ? [col("before", before?.shot), col("after", after?.shot), col("diff", diff?.diffShot)] : [col("screen", after?.shot, true)]),
    el("div", { class: "lb-side" }, el("div", {}, "URL"), el("ul", {}, el("li", {}, after?.url ?? before?.url ?? "")), diff && !diff.error ? el("div", {}, (diff.ratio * 100).toFixed(2) + "% pixels changed") : null, ...notes("after", after), ...notes("before", before)),
  );
  if (!lb.open) lb.showModal();
}
function move(dx, dy) {
  if (!current) return;
  let r = grid.findIndex((row) => row.includes(current));
  if (r < 0) return;
  if (dx) { const row = grid[r]; openLightbox(row[(row.indexOf(current) + dx + row.length) % row.length]); return; }
  for (let i = 0; i < grid.length; i++) {
    r = (r + dy + grid.length) % grid.length;
    const same = grid[r].find((p) => p.client.id === current.client.id) ?? grid[r][0];
    if (same) { openLightbox(same); return; }
  }
}
document.getElementById("lb-close").onclick = () => lb.close();
lb.addEventListener("click", (e) => { if (e.target === lb || e.target.id === "lb-body") lb.close(); });
document.addEventListener("keydown", (e) => {
  if (!lb.open) return;
  const keys = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] };
  if (keys[e.key]) { e.preventDefault(); move(...keys[e.key]); }
});
update();
`;

export function renderVisualReport(manifest) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Visual Review</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <div class="title-row">
    <h1>Visual Review</h1>
    <div class="targets" id="targets"></div>
    <div class="tabs" role="tablist">
      <button role="tab" id="tab-screens" aria-selected="true">Screens</button>
      <button role="tab" id="tab-build" aria-selected="false">Build size</button>
    </div>
  </div>
  <div class="stats" id="stats"></div>
  <div class="controls screen-only">
    <div class="group" id="mode"><span>View</span></div>
    <div class="group" id="viewport"><span>Viewport</span></div>
    <div class="group" id="section"><span>Section</span></div>
    <div class="group"><span>Size</span>
      <button class="chip" data-size="150">S</button><button class="chip" data-size="210">M</button><button class="chip" data-size="300">L</button>
    </div>
    <div class="group"><span>Show</span>
      <button class="chip" id="changed-only">Changed only</button><button class="chip" id="issues-only">Issues only</button>
    </div>
  </div>
  <div class="controls screen-only"><div class="group" id="clients"><span>Clients</span></div></div>
</header>
<main id="main"></main>
<dialog id="lightbox"><div class="lb">
  <div class="lb-bar"><b id="lb-title"></b><button id="lb-close">Close</button><span class="k">← → client · ↑ ↓ step · Esc close</span></div>
  <div class="lb-body" id="lb-body"></div>
</div></dialog>
<script id="manifest" type="application/json">${escapeJson(manifest)}</script>
<script>${SCRIPT}</script>
</body>
</html>`;
}
