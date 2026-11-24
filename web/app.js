/* Nugget engine -- client side.  Plain JavaScript, no build step.
 *
 * Routes (all in the URL fragment, so the site works on any static host):
 *   #/                    home: introduction + groups
 *   #/n/<id>              one nugget
 *   #/n/<id>@<group>      one nugget, with previous/next inside <group>
 *   #/g/<group>           a group (list)
 *   #/v/<id>+<id>+...     several nuggets composed into one view
 *   #/c/<name>            a saved collection (composed view)
 *   #/all                 all nuggets, with filters
 *   #/me                  my statuses, notes, collections; export / import
 *   #/import/<data>       import state exported from another browser
 *   #/search/<text>       search
 */
(function () {
  "use strict";

  const DEFAULT_STATUSES = [
    { key: "got", label: "I understand this" },
    { key: "back", label: "I want to go back to this" },
    { key: "more", label: "I need to know more about this" },
  ];
  const REL = [
    ["requires", "Assumes you know"],
    ["uses", "Uses"],
    ["see-also", "Read more"],
    ["next", "Natural next topics"],
  ];

  let DATA, BY_ID, GROUP, STATUSES, STATE_KEY;
  const BACK = {}; // id -> {neededBy:[], usedBy:[], mentionedBy:[]}
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ------------------------------------------------------------------ state
  let state = { status: {}, notes: {}, collections: {}, tray: [] };
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STATE_KEY) || "null");
      if (s) state = Object.assign(state, s);
    } catch (e) { /* storage unavailable: work in memory */ }
  }
  function save() {
    try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }

  // --------------------------------------------------------------- markdown
  const KATEX_OPTS = {
    throwOnError: false,
    macros: { "\\N": "\\mathbb{N}", "\\Z": "\\mathbb{Z}", "\\Q": "\\mathbb{Q}", "\\R": "\\mathbb{R}", "\\B": "\\mathbb{B}" },
  };
  function tex(s, display) {
    try { return katex.renderToString(s, Object.assign({ displayMode: display }, KATEX_OPTS)); }
    catch (e) { return "<code>" + esc(s) + "</code>"; }
  }
  marked.use({
    gfm: true,
    breaks: true,
    extensions: [
      {
        name: "blockMath", level: "block",
        start(src) { const i = src.search(/^\$\$/m); return i < 0 ? undefined : i; },
        tokenizer(src) {
          const m = /^\$\$([\s\S]+?)\$\$[ \t]*(?:\n|$)/.exec(src);
          if (m) return { type: "blockMath", raw: m[0], text: m[1].trim() };
        },
        renderer(t) { return '<div class="math">' + tex(t.text, true) + "</div>"; },
      },
      {
        name: "inlineMath", level: "inline",
        start(src) { const i = src.search(/\$|\[\[/); return i < 0 ? undefined : i; },
        tokenizer(src) {
          let m = /^\$\$([\s\S]+?)\$\$/.exec(src);
          if (m) return { type: "inlineMath", raw: m[0], text: m[1].trim(), display: true };
          m = /^\$((?:\\.|[^\\$\n])+?)\$/.exec(src);
          if (m) return { type: "inlineMath", raw: m[0], text: m[1], display: false };
        },
        renderer(t) { return tex(t.text, t.display); },
      },
      {
        name: "nuggetRef", level: "inline",
        start(src) { const i = src.indexOf("[["); return i < 0 ? undefined : i; },
        tokenizer(src) {
          const m = /^\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/.exec(src);
          if (m) return { type: "nuggetRef", raw: m[0], id: m[1].trim(), text: m[2] };
        },
        renderer(t) {
          const n = BY_ID[t.id];
          const label = t.text || (n ? n.title : t.id);
          return '<a class="ref" href="#/n/' + encodeURIComponent(t.id) + '">' + esc(label) + "</a>";
        },
      },
    ],
  });

  // wrap "## Answer", "## Solution", "## Hint" sections in collapsible boxes
  function foldAnswers(root) {
    const heads = [...root.querySelectorAll(":scope > h2")];
    for (const h of heads) {
      const m = /^(answer|solution|hint|proof sketch|answers)\b/i.exec(h.textContent.trim());
      if (!m) continue;
      const d = document.createElement("details");
      d.className = "answer";
      const s = document.createElement("summary");
      s.textContent = "Show " + h.textContent.trim().toLowerCase();
      d.appendChild(s);
      let el = h.nextSibling;
      while (el && !(el.nodeType === 1 && /^H[12]$/.test(el.tagName))) {
        const nx = el.nextSibling; d.appendChild(el); el = nx;
      }
      h.replaceWith(d);
    }
  }
  function md(text) {
    const div = document.createElement("div");
    div.className = "body";
    div.innerHTML = marked.parse(text);
    foldAnswers(div);
    return div;
  }

  // ------------------------------------------------------------------ views
  const main = () => $("#main");
  function setMain(html) { main().innerHTML = html; window.scrollTo(0, 0); }
  function nlink(id, ctx) {
    const n = BY_ID[id]; if (!n) return esc(id);
    return '<a href="#/n/' + encodeURIComponent(id) + (ctx ? "@" + encodeURIComponent(ctx) : "") + '">' + esc(n.title) + "</a>";
  }
  function dot(id) { const s = state.status[id]; return '<span class="dot ' + (s || "") + '" title="' + esc(statusLabel(s)) + '"></span>'; }
  function statusLabel(k) { const s = STATUSES.find((x) => x.key === k); return s ? s.label : "no status"; }
  function kindBadge(k) { return '<span class="kind ' + esc(k) + '">' + esc(k) + "</span>"; }
  function groupChip(g) { const G = GROUP[g]; return '<a class="chip" href="#/g/' + encodeURIComponent(g) + '">' + esc(G ? G.title : g) + "</a>"; }

  function listHTML(ids, ctx) {
    if (!ids.length) return '<p class="empty">Nothing here.</p>';
    return '<ul class="list">' + ids.map((id) => {
      const n = BY_ID[id];
      return "<li>" + dot(id) + '<a class="t" href="#/n/' + encodeURIComponent(id) + (ctx ? "@" + encodeURIComponent(ctx) : "") + '">' +
        esc(n.title) + "</a>" + kindBadge(n.kind) + ' <button class="add" data-add="' + esc(id) + '" title="Add to composed view">+</button></li>';
    }).join("") + "</ul>";
  }

  function progressBar(ids) {
    if (!ids.length) return "";
    const c = (k) => ids.filter((i) => state.status[i] === k).length;
    return '<div class="progress">' + STATUSES.map((s) =>
      '<span style="width:' + (100 * c(s.key) / ids.length) + "%;background:var(--" + s.key + ')"></span>').join("") + "</div>";
  }

  function viewHome() {
    const sections = {};
    for (const g of DATA.groups) {
      const p = g.id.includes("/") ? g.id.split("/")[0] : "other";
      (sections[p] = sections[p] || []).push(g);
    }
    let h = "<h1>" + esc(DATA.site.title) + "</h1>";
    if (DATA.site.subtitle) h += '<p class="crumbs">' + esc(DATA.site.subtitle) + "</p>";
    main().innerHTML = h;
    main().appendChild(md(DATA.site.body || ""));
    let s = "";
    for (const [p, gs] of Object.entries(sections)) {
      s += "<h2>" + esc(p[0].toUpperCase() + p.slice(1)) + '</h2><div class="groups">' + gs.map((g) =>
        '<a class="group-card" href="#/g/' + encodeURIComponent(g.id) + '">' + esc(g.title) +
        "<small>" + g.members.length + " nuggets</small>" + progressBar(g.members) + "</a>").join("") + "</div>";
    }
    main().insertAdjacentHTML("beforeend", s);
    window.scrollTo(0, 0);
  }

  function viewGroup(gid) {
    const g = GROUP[gid];
    if (!g) return notFound();
    setMain('<p class="crumbs"><a href="#/">Home</a></p><h1>' + esc(g.title) + "</h1>");
    if (g.body) main().appendChild(md(g.body));
    main().insertAdjacentHTML("beforeend",
      '<div class="toolbar"><a href="#/v/' + g.members.map(encodeURIComponent).join("+") + '"><button>Read all as one page</button></a>' +
      (g.members.length ? '<a href="#/n/' + encodeURIComponent(g.members[0]) + "@" + encodeURIComponent(gid) + '"><button>Start reading one by one</button></a>' : "") +
      '<button data-addall="' + esc(g.members.join(" ")) + '">Add all to composed view</button></div>' +
      progressBar(g.members) + listHTML(g.members, gid));
  }

  function row(label, ids) {
    if (!ids.length) return "";
    return "<div><b>" + label + "</b><span>" + ids.map((i) => '<span class="rl">' + dot(i) + nlink(i) + "</span>").join("") + "</span></div>";
  }
  function relationsHTML(n) {
    let r = "";
    for (const [k, label] of REL) {
      const ids = n[k] || [];
      if (ids.length) r += row(label, ids);
    }
    const b = BACK[n.id];
    const shown = new Set(REL.flatMap(([k]) => n[k] || []));
    const fresh = (ids) => ids.filter((i) => !shown.has(i) && (shown.add(i), true));
    r += row("Used by", fresh(b.usedBy)) + row("Prerequisite for", fresh(b.neededBy)) + row("Mentioned in", fresh(b.mentionedBy));
    return r ? '<div class="rel">' + r + "</div>" : "";
  }

  function statusBar(id) {
    return '<div class="status-bar" data-id="' + esc(id) + '">' + STATUSES.map((s) =>
      '<button class="' + s.key + (state.status[id] === s.key ? " on" : "") + '" data-status="' + s.key + '">' + esc(s.label) + "</button>").join("") +
      '<button data-add="' + esc(id) + '" title="Add to composed view">+ compose</button></div>' +
      '<details class="note-box"' + (state.notes[id] ? " open" : "") + "><summary>My notes" + (state.notes[id] ? "" : " (empty)") +
      '</summary><textarea data-note="' + esc(id) + '" placeholder="Your own notes on this nugget (stored in this browser)">' +
      esc(state.notes[id] || "") + "</textarea></details>";
  }

  function nuggetSection(n, level, ctx) {
    const sec = document.createElement("section");
    sec.id = "nugget-" + n.id;
    const edit = DATA.site["edit-url"] ? ' <a class="chip" href="' + esc(DATA.site["edit-url"] + n.file) + '">edit</a>' : "";
    sec.innerHTML = "<h" + level + ">" + (level > 1 ? '<a href="#/n/' + encodeURIComponent(n.id) + '" style="color:inherit;text-decoration:none">' + esc(n.title) + "</a>" : esc(n.title)) +
      "</h" + level + '><div class="meta">' + kindBadge(n.kind) + " " + n.groups.map(groupChip).join(" ") + edit + "</div>";
    sec.appendChild(md(n.body));
    sec.insertAdjacentHTML("beforeend", statusBar(n.id) + relationsHTML(n));
    return sec;
  }

  function viewNugget(id, ctx) {
    const n = BY_ID[id];
    if (!n) return notFound();
    setMain("");
    let crumbs = '<p class="crumbs"><a href="#/">Home</a>';
    if (ctx && GROUP[ctx]) crumbs += '› <a href="#/g/' + encodeURIComponent(ctx) + '">' + esc(GROUP[ctx].title) + "</a>";
    main().insertAdjacentHTML("beforeend", crumbs + "</p>");
    main().appendChild(nuggetSection(n, 1, ctx));
    if (ctx && GROUP[ctx]) {
      const m = GROUP[ctx].members, i = m.indexOf(id);
      const prev = i > 0 ? m[i - 1] : null, next = i >= 0 && i < m.length - 1 ? m[i + 1] : null;
      main().insertAdjacentHTML("beforeend", '<div class="pager ui"><span>' + (prev ? "← " + nlink(prev, ctx) : "") +
        "</span><span>" + (i + 1) + " / " + m.length + "</span><span>" + (next ? nlink(next, ctx) + " →" : "") + "</span></div>");
    }
    document.title = n.title + " · " + DATA.site.title;
  }

  function viewComposite(ids, title, collectionName) {
    ids = ids.filter((i) => BY_ID[i]);
    if (!ids.length) return notFound();
    setMain('<p class="crumbs"><a href="#/">Home</a></p><h1>' + esc(title || "Composed view") + "</h1>");
    const inView = new Set(ids);
    const missing = [...new Set(ids.flatMap((i) => BY_ID[i].requires))].filter((i) => !inView.has(i));
    let top = '<div class="toolbar"><button data-copy="' + esc(location.href) + '">Copy link to this view</button>' +
      '<button data-addall="' + esc(ids.join(" ")) + '">Put in composer</button>' +
      (collectionName ? '<button data-delcoll="' + esc(collectionName) + '">Delete collection</button>' : "") + "</div>";
    top += '<ol class="toc">' + ids.map((i) => "<li>" + dot(i) + '<a href="#/' + (collectionName ? "c/" + encodeURIComponent(collectionName) : "v/" + ids.map(encodeURIComponent).join("+")) +
      '" data-jump="nugget-' + esc(i) + '">' + esc(BY_ID[i].title) + "</a></li>").join("") + "</ol>";
    if (missing.length) top += '<p class="warn">This view assumes you know: ' + missing.map((i) => dot(i) + nlink(i)).join(" · ") + "</p>";
    main().insertAdjacentHTML("beforeend", top);
    const wrap = document.createElement("div");
    wrap.className = "composite";
    for (const i of ids) wrap.appendChild(nuggetSection(BY_ID[i], 2));
    main().appendChild(wrap);
  }

  function viewAll(query) {
    setMain('<p class="crumbs"><a href="#/">Home</a></p><h1>' + (query ? "Search: " + esc(query) : "All nuggets") + "</h1>" +
      '<div class="toolbar">Kind <select id="f-kind"><option value="">any</option>' +
      [...new Set(DATA.nuggets.map((n) => n.kind))].sort().map((k) => "<option>" + esc(k) + "</option>").join("") +
      '</select> Status <select id="f-status"><option value="">any</option><option value="none">no status</option>' +
      STATUSES.map((s) => '<option value="' + s.key + '">' + esc(s.label) + "</option>").join("") +
      '</select> Group <select id="f-group"><option value="">any</option>' +
      DATA.groups.map((g) => '<option value="' + esc(g.id) + '">' + esc(g.title) + "</option>").join("") +
      '</select></div><div id="results"></div>');
    const run = () => {
      const k = $("#f-kind").value, st = $("#f-status").value, g = $("#f-group").value;
      const words = (query || "").toLowerCase().split(/\s+/).filter(Boolean);
      const ids = DATA.nuggets.filter((n) =>
        (!k || n.kind === k) && (!g || n.groups.includes(g)) &&
        (!st || (st === "none" ? !state.status[n.id] : state.status[n.id] === st)) &&
        words.every((w) => (n.title + " " + n.body + " " + n.id).toLowerCase().includes(w))
      ).map((n) => n.id);
      $("#results").innerHTML = '<p class="crumbs">' + ids.length + " nuggets · <a href=\"#/v/" + ids.map(encodeURIComponent).join("+") + '">read as one page</a></p>' + listHTML(ids);
    };
    ["#f-kind", "#f-status", "#f-group"].forEach((s) => $(s).addEventListener("change", run));
    run();
  }

  function viewMe() {
    let h = '<p class="crumbs"><a href="#/">Home</a></p><h1>My notes</h1>' +
      '<p class="ui">Everything here is stored in this browser only. Use <b>Export</b> to move it to another browser or device.</p>';
    for (const s of STATUSES) {
      const ids = DATA.nuggets.filter((n) => state.status[n.id] === s.key).map((n) => n.id);
      h += '<h2><span class="dot ' + s.key + '"></span>' + esc(s.label) + " (" + ids.length + ")</h2>" +
        (ids.length ? '<p class="ui"><a href="#/v/' + ids.map(encodeURIComponent).join("+") + '">read these as one page</a></p>' : "") + listHTML(ids);
    }
    const noted = Object.keys(state.notes).filter((i) => state.notes[i] && BY_ID[i]);
    h += "<h2>Nuggets with my notes (" + noted.length + ")</h2>" + listHTML(noted);
    const cs = Object.keys(state.collections);
    h += "<h2>My collections (" + cs.length + ")</h2>" + (cs.length ? '<ul class="list">' + cs.map((c) =>
      '<li><a class="t" href="#/c/' + encodeURIComponent(c) + '">' + esc(c) + "</a><small>" + state.collections[c].length + " nuggets</small></li>").join("") + "</ul>"
      : '<p class="empty">Use “+ compose” on nuggets, then “Save as collection…”.</p>');
    h += '<h2>Export / import</h2><div class="toolbar"><button id="do-export">Create export link</button></div>' +
      '<textarea id="export-out" class="export" rows="3" readonly hidden></textarea>' +
      '<p class="ui">Open the export link in another browser to import your statuses, notes and collections there.</p>';
    setMain(h);
    $("#do-export").addEventListener("click", async () => {
      const link = location.href.split("#")[0] + "#/import/" + (await encode(exportable()));
      const t = $("#export-out"); t.hidden = false; t.value = link; t.select();
      try { await navigator.clipboard.writeText(link); flash("Link copied to clipboard"); } catch (e) { /* ignore */ }
    });
  }
  function exportable() { return { v: 1, site: DATA.site.id, status: state.status, notes: state.notes, collections: state.collections }; }

  async function viewImport(data) {
    let incoming;
    try { incoming = await decode(data); } catch (e) { return setMain('<h1>Import</h1><p class="warn">This import link is damaged.</p>'); }
    const ns = Object.keys(incoming.status || {}).length, nn = Object.keys(incoming.notes || {}).length, nc = Object.keys(incoming.collections || {}).length;
    setMain("<h1>Import notes</h1><p class=\"ui\">This link contains " + ns + " statuses, " + nn + " notes and " + nc + " collections" +
      (incoming.site && incoming.site !== DATA.site.id ? " (from a different site: " + esc(incoming.site) + ")" : "") + ".</p>" +
      '<div class="toolbar"><button id="imp-merge">Merge with what I have here</button><button id="imp-replace">Replace what I have here</button>' +
      '<a href="#/">Cancel</a></div>');
    const apply = (replace) => {
      if (replace) state = { status: {}, notes: {}, collections: {}, tray: state.tray };
      Object.assign(state.status, incoming.status || {});
      for (const [k, v] of Object.entries(incoming.notes || {}))
        state.notes[k] = replace || !state.notes[k] || state.notes[k] === v ? v : state.notes[k] + "\n\n— imported —\n" + v;
      Object.assign(state.collections, incoming.collections || {});
      save(); location.hash = "#/me";
    };
    $("#imp-merge").addEventListener("click", () => apply(false));
    $("#imp-replace").addEventListener("click", () => apply(true));
  }

  // compact URL-safe encoding (deflate when the browser supports it)
  const b64u = (bytes) => { let s = ""; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
  const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  async function encode(obj) {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    if (window.CompressionStream) {
      const out = await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer();
      return "z" + b64u(new Uint8Array(out));
    }
    return "j" + b64u(bytes);
  }
  async function decode(s) {
    let bytes = unb64u(s.slice(1));
    if (s[0] === "z") bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  function notFound() { setMain('<h1>Not found</h1><p><a href="#/">Back to the start</a></p>'); }

  // ------------------------------------------------------------------- tray
  function renderTray() {
    const t = $("#tray");
    state.tray = state.tray.filter((i) => BY_ID[i]);
    t.hidden = state.tray.length === 0;
    $("#tray-count").textContent = state.tray.length + " nugget" + (state.tray.length === 1 ? "" : "s");
    $("#tray-list").innerHTML = state.tray.map((i, k) => "<li>" + esc(BY_ID[i].title) +
      ' <button data-up="' + k + '" title="Move up">↑</button><button data-rm="' + k + '" title="Remove">✕</button></li>').join("");
    document.body.style.paddingBottom = t.hidden ? "" : t.offsetHeight + "px";
  }
  function addToTray(ids) {
    for (const i of ids) if (!state.tray.includes(i)) state.tray.push(i);
    save(); renderTray();
  }
  let flashTimer;
  function flash(msg) {
    let f = $("#flash");
    if (!f) { f = document.createElement("div"); f.id = "flash"; f.className = "warn ui";
      f.style.cssText = "position:fixed;top:4rem;right:16px;z-index:9"; document.body.appendChild(f); }
    f.textContent = msg; f.hidden = false;
    clearTimeout(flashTimer); flashTimer = setTimeout(() => (f.hidden = true), 1800);
  }

  // ----------------------------------------------------------------- events
  document.addEventListener("click", (e) => {
    const b = e.target.closest("button, a[data-jump]");
    if (!b) return;
    if (b.dataset.jump) {
      e.preventDefault();
      const el = document.getElementById(b.dataset.jump);
      if (el) el.scrollIntoView({ behavior: "smooth" });
      return;
    }
    if (b.dataset.status) {
      const id = b.closest(".status-bar").dataset.id;
      state.status[id] = state.status[id] === b.dataset.status ? undefined : b.dataset.status;
      if (!state.status[id]) delete state.status[id];
      save();
      b.parentElement.querySelectorAll("button[data-status]").forEach((x) => x.classList.toggle("on", x.dataset.status === state.status[id]));
    } else if (b.dataset.add) { addToTray([b.dataset.add]); flash("Added to composed view"); }
    else if (b.dataset.addall) { addToTray(b.dataset.addall.split(" ").filter(Boolean)); }
    else if (b.dataset.rm) { state.tray.splice(+b.dataset.rm, 1); save(); renderTray(); }
    else if (b.dataset.up) { const k = +b.dataset.up; if (k > 0) { [state.tray[k - 1], state.tray[k]] = [state.tray[k], state.tray[k - 1]]; save(); renderTray(); } }
    else if (b.dataset.copy) { navigator.clipboard && navigator.clipboard.writeText(b.dataset.copy).then(() => flash("Link copied"), () => {}); }
    else if (b.dataset.delcoll) { delete state.collections[b.dataset.delcoll]; save(); location.hash = "#/me"; }
    else if (b.id === "tray-open") location.hash = "#/v/" + state.tray.map(encodeURIComponent).join("+");
    else if (b.id === "tray-clear") { state.tray = []; save(); renderTray(); }
    else if (b.id === "tray-save") {
      const head = $(".tray-head");
      if ($("#coll-name")) return;
      head.insertAdjacentHTML("beforeend", '<input id="coll-name" placeholder="Collection name"><button id="coll-ok">Save</button>');
      $("#coll-name").focus();
    } else if (b.id === "coll-ok") {
      const name = $("#coll-name").value.trim();
      if (!name) return;
      state.collections[name] = state.tray.slice(); state.tray = []; save(); renderTray();
      location.hash = "#/c/" + encodeURIComponent(name);
    }
  });
  document.addEventListener("input", (e) => {
    const id = e.target.dataset && e.target.dataset.note;
    if (id === undefined) return;
    if (e.target.value.trim()) state.notes[id] = e.target.value; else delete state.notes[id];
    save();
  });

  // ----------------------------------------------------------------- router
  function route() {
    const h = decodeURIComponent(location.hash.replace(/^#\/?/, ""));
    const [head, ...rest] = h.split("/");
    const arg = rest.join("/");
    document.title = DATA.site.title;
    if (!head) viewHome();
    else if (head === "n") { const [id, ctx] = arg.split("@"); viewNugget(id, ctx); }
    else if (head === "g") viewGroup(arg);
    else if (head === "v") viewComposite(arg.split("+"));
    else if (head === "c") viewComposite(state.collections[arg] || [], arg, arg);
    else if (head === "all") viewAll("");
    else if (head === "search") viewAll(arg);
    else if (head === "me") viewMe();
    else if (head === "import") viewImport(location.hash.split("/import/")[1]);
    else notFound();
    renderTray();
  }

  async function init() {
    DATA = await (await fetch("nuggets.json", { cache: "no-cache" })).json();
    BY_ID = Object.fromEntries(DATA.nuggets.map((n) => [n.id, n]));
    GROUP = Object.fromEntries(DATA.groups.map((g) => [g.id, g]));
    STATUSES = DATA.site.statuses && DATA.site.statuses.length ? DATA.site.statuses : DEFAULT_STATUSES;
    STATE_KEY = "nuggets:" + DATA.site.id;
    for (const n of DATA.nuggets) BACK[n.id] = { usedBy: [], neededBy: [], mentionedBy: [] };
    for (const n of DATA.nuggets) {
      for (const t of n.uses) BACK[t] && BACK[t].usedBy.push(n.id);
      for (const t of n.requires) BACK[t] && BACK[t].neededBy.push(n.id);
      for (const t of n.mentions) if (BACK[t] && !n.uses.includes(t) && !n.requires.includes(t)) BACK[t].mentionedBy.push(n.id);
    }
    load();
    $("#site-title").textContent = DATA.site.title;
    let st;
    $("#search").addEventListener("input", (e) => {
      clearTimeout(st);
      st = setTimeout(() => { location.hash = e.target.value.trim() ? "#/search/" + encodeURIComponent(e.target.value.trim()) : "#/all"; }, 250);
    });
    window.addEventListener("hashchange", route);
    route();
  }
  init().catch((e) => setMain('<h1>Could not load nuggets</h1><p class="warn">' + esc(e) +
    "</p><p>If you opened index.html directly from disk, serve the folder instead, e.g. <code>python3 -m http.server</code>.</p>"));
})();
