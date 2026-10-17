/* Consort: the theme slice first — read the skin from the FM-1, keep it on the phone, write it back, and
   wear it in the app. Songs and samples hang off the same protocol link. */
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const native = !!window.ConsortMidi;
  const THEMES_KEY = "consort.themes";
  const SKIN_KEY = "consort.skin";
  let link = null;
  let current = null;                 // the theme last read from the machine
  let autoTheme = null;               // the mock device's skin
  let connRaw = null;                 // the USB MIDI port name, if it is printable ASCII
  let currentAt = 0;                  // when the machine's theme was read
  const T = (key, vars) => (window.ConsortI18n ? ConsortI18n.t(key, vars) : key);
  // USB descriptors are not guaranteed to be valid UTF-8; a broken name arrives as U+FFFD or mojibake.
  // Only a short printable-ASCII name is shown, and only then does the toast name the port.
  function cleanPortName(name) {
    const s = String(name || "").trim();
    return /^[\x20-\x7E]{1,24}$/.test(s) ? s : "";
  }

  function toastMsg(msg) {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("on");
    clearTimeout(toastMsg.t);
    toastMsg.t = setTimeout(() => el.classList.remove("on"), 2400);
  }

  // ---- transport -----------------------------------------------------------------------------------
  // The device can answer the very first INFO frame before Sloop.connect() has returned, so incoming
  // bytes must go through transport.link: protocol.js sets that when the Link is made, while the
  // module-level `link` below is still null until the handshake completes. Routing through `link`
  // here would drop the INFO reply and make a perfectly good FM-1 look unresponsive.
  const nativeTransport = {
    send(bytes) { ConsortMidi.send(Array.from(bytes).join(",")); },
    receive(csv) {
      const l = this.link;
      if (l && csv) l.receive(csv.split(",").map(Number));
    }
  };

  function mockTransport() {
    const theme = autoTheme || (autoTheme = Sloop.encodeTheme({
      name: "NORD",
      c: ["#6f6f6f", "#5a5a5a", "#3c3c3c", "#232323", "#0d0d0d"],
      trk: ["#88c0f8", "#80f860", "#f0f078", "#f8a028"],
      bg: "#000000", hi: "#ffffff"
    }));
    const objs = [
      { id: 0, d: Uint8Array.from([1]) },
      { id: 1, d: Uint8Array.from([2]) },
      { id: Sloop.THEME_ID, d: theme }
    ];
    const t = {
      send(bytes) {
        const f = Sloop.unframe(bytes);
        if (!f) return;
        const reply = (args) => setTimeout(() => t.link && t.link.receive(Sloop.frame(f.cmd, args)), 25);
        if (f.cmd === Sloop.CMD.INFO) reply([1, 0]);
        else if (f.cmd === Sloop.CMD.PROJECT) reply([f.a[0], f.a[1], f.a[1] < 2 ? 1 : 0]);
        else if (f.cmd === Sloop.CMD.LIVE) reply([f.a[0]]);
        else if (f.cmd === Sloop.CMD.SET) reply([f.a[0], f.a[1], f.a[2], f.a[3]]);
        else if (f.cmd === Sloop.CMD.SMP_INFO) {
          const a = [4, 80];
          for (let i = 0; i < 4; i++) a.push(0, 0, 0);
          reply(a);
        } else if (f.cmd === Sloop.CMD.SMP_BEGIN || f.cmd === Sloop.CMD.SMP_END || f.cmd === Sloop.CMD.SMP_ERASE) reply([f.a[0], 0]);
        else if (f.cmd === Sloop.CMD.SMP_WRITE) reply([f.a[0], f.a[1], f.a[2], f.a[3], 0]);
        else if (f.cmd === Sloop.CMD.BK_LIST) {
          const a = [0, objs.length];
          for (const o of objs) a.push(o.id, ...Sloop.u35enc(o.d.length), ...Sloop.u35enc(Sloop.crc32(o.d)));
          reply(a);
        } else if (f.cmd === Sloop.CMD.BK_GET) {
          const o = objs.find((x) => x.id === f.a[0]);
          if (!o) { reply([f.a[0], 5]); return; }
          reply([o.id, 0, ...Sloop.u35enc(0), o.d.length & 0x7F, (o.d.length >> 7) & 0x7F, ...Sloop.pack7(o.d)]);
        } else if (f.cmd === Sloop.CMD.BK_PUT) reply([f.a[0], f.a[1], 0]);
      }
    };
    return t;
  }

  function setConn(on, label) {
    const el = document.querySelector(".conn");
    if (!el) return;
    el.innerHTML = "<i></i>" + (on ? (label || T("conn.on")) : T("conn.off"));
    el.classList.toggle("off", !on);
    paintPills();
  }

  function paintPills() {
    const on = !!link;
    for (const id of ["song-pill", "theme-pill"]) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.textContent = on ? T("songs.connectedPill") : T("songs.offlinePill");
      el.classList.toggle("off", !on);
    }
  }

  async function start(transport, label) {
    try {
      link = await Sloop.connect(transport);
      connRaw = label || "";
      const port = cleanPortName(connRaw);
      setConn(true, port || T("conn.on"));
      toastMsg(port ? T("conn.connectedTo", { name: port }) : T("conn.on"));
      refreshSections();
      renderSongs();
      if (window.ConsortSamples) window.ConsortSamples.refresh();
    } catch (e) {
      link = null;
      connRaw = null;
      setConn(false);
      toastMsg(T("conn.noReply"));
    }
  }

  setConn(false);                     // localized "not connected" before the first MIDI callback
  if (native) {
    window.__consortOpened = (ok, name, why) => {
      if (!ok) {
        setConn(false);
        toastMsg(why ? T("conn.fail", { why }) : T("conn.noReply"));
        return;
      }
      start(nativeTransport, name || "FM-1");
    };
    window.__consortIn = (csv) => { nativeTransport.receive(csv); };
    window.__consortLost = () => {
      nativeTransport.link = null;
      link = null;
      connRaw = null;
      setConn(false);
    };
    try { ConsortMidi.connect(); } catch (e) { /* no bridge */ }
  } else {
    setTimeout(() => start(mockTransport(), "FM-1 (mock)"), 250);
  }

  document.querySelector(".conn").addEventListener("click", () => {
    if (link) return;
    if (native) ConsortMidi.connect();
    else start(mockTransport(), "FM-1 (mock)");
  });

  // ---- storage -------------------------------------------------------------------------------------
  function loadThemes() {
    try { return JSON.parse(localStorage.getItem(THEMES_KEY) || "[]"); } catch (e) { return []; }
  }
  function saveThemes(list) {
    try { localStorage.setItem(THEMES_KEY, JSON.stringify(list)); } catch (e) { toastMsg(T("storage.fail")); }
  }
  function when(ms) {
    const d = new Date(ms);
    const p = (n) => (n < 10 ? "0" : "") + n;
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  window.ConsortApp = { get link() { return link; }, toast: toastMsg, when: when };

  // ---- skin ----------------------------------------------------------------------------------------
  function rgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return [0, 0, 0];
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function hex(c) { return "#" + c.map((x) => Math.round(x).toString(16).padStart(2, "0")).join(""); }
  function mix(a, b, t) {
    const x = rgb(a), y = rgb(b);
    return hex(x.map((v, i) => v + (y[i] - v) * t));
  }
  function lum(hexColor) {
    const [r, g, b] = rgb(hexColor).map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  function brightest(list) {
    return list.slice().sort((a, b) => lum(b) - lum(a))[0] || "#e8e8e8";
  }
  function applySkin(t) {
    const root = document.documentElement;
    const bg = t.bg || "#0b0b0b";
    const fg = brightest(t.c);
    const v = {
      "--bg": bg, "--fg": fg, "--fg2": mix(bg, fg, 0.78),
      "--s1": mix(bg, fg, 0.06), "--s2": mix(bg, fg, 0.12), "--s3": mix(bg, fg, 0.24),
      "--card": mix(bg, fg, 0.06), "--card2": mix(bg, fg, 0.12),
      "--btn": mix(bg, fg, 0.12), "--line": mix(bg, fg, 0.16),
      "--dim": mix(bg, fg, 0.50), "--nav": mix(bg, fg, 0.04),
      "--wave": mix(bg, fg, 0.05),
      "--acc": t.hi || "#ffffff",
      "--ink": lum(t.hi || "#ffffff") > 0.45 ? "#0b0b0b" : "#ffffff",
      "--t1": t.trk[0], "--t2": t.trk[1], "--t3": t.trk[2], "--t4": t.trk[3]
    };
    for (const k in v) if (v[k]) root.style.setProperty(k, v[k]);
    const name = document.getElementById("skinName");
    if (name) name.textContent = "FM-1 companion · " + (t.name || "THEME");
  }
  try {
    const saved = JSON.parse(localStorage.getItem(SKIN_KEY) || "null");
    if (saved) applySkin(saved);
  } catch (e) { /* no skin */ }

  // ---- the theme page ------------------------------------------------------------------------------
  function swatches(t) {
    const box = document.createElement("div");
    box.className = "swatches";
    for (const c of [...t.c, t.bg, ...t.trk]) {
      const i = document.createElement("i");
      i.className = "sw";
      i.style.background = c;
      box.appendChild(i);
    }
    return box;
  }

  function renderCurrent(t) {
    const name = document.getElementById("cur-name");
    const whenEl = document.getElementById("cur-when");
    const box = document.getElementById("cur-sw");
    if (name) name.textContent = t.name || T("theme.unnamed");
    if (whenEl) whenEl.textContent = T("theme.readAt", { when: when(currentAt || Date.now()) });
    if (box) {
      box.replaceChildren();
      for (const c of [...t.c, t.bg, ...t.trk]) {
        const i = document.createElement("i");
        i.className = "sw";
        i.style.background = c;
        box.appendChild(i);
      }
    }
  }

  async function readCurrent() {
    if (!link) { toastMsg(T("needConnect")); return; }
    try {
      const bytes = await Sloop.readTheme(link);
      if (!bytes || !bytes.length) { toastMsg(T("theme.readNone")); return; }
      const t = Sloop.decodeTheme(bytes);
      if (!t) { toastMsg(T("theme.readBad")); return; }
      current = t;
      currentAt = Date.now();
      renderCurrent(t);
      toastMsg(T("theme.readDone", { name: t.name || T("theme.unnamed") }));
    } catch (e) {
      toastMsg(T("theme.readFail", { err: e.message }));
    }
  }

  function saveCurrent() {
    if (!current) { toastMsg(T("theme.needRead")); return; }
    const list = loadThemes();
    list.unshift({ name: current.name || "THEME", when: Date.now(), bytes: current.bytes });
    saveThemes(list);
    renderPhoneThemes();
    toastMsg(T("theme.saved", { name: current.name || "THEME" }));
  }

  async function applyTheme(item, index) {
    const t = Sloop.decodeTheme(item.bytes);
    if (!t) { toastMsg(T("theme.bad")); return; }
    const dev = document.querySelector('[data-opt="dev"]').checked;
    const app = document.querySelector('[data-opt="app"]').checked;
    if (app) {
      applySkin(t);
      try { localStorage.setItem(SKIN_KEY, JSON.stringify(t)); } catch (e) { /* no storage */ }
    }
    if (dev) {
      if (!link) { toastMsg(app ? T("theme.skinOnlyNoConn") : T("needConnect")); return; }
      try {
        await Sloop.writeTheme(link, Uint8Array.from(item.bytes));
        toastMsg(app ? T("theme.writtenSkin") : T("theme.written"));
      } catch (e) {
        toastMsg(app ? T("theme.writeFailSkin", { err: e.message }) : T("theme.writeFail", { err: e.message }));
      }
    } else {
      toastMsg(app ? T("theme.skinChanged", { name: t.name || "" }) : T("theme.noAction"));
    }
  }

  function shareTheme(item) {
    const code = Sloop.shareCode(item.bytes);
    const done = () => toastMsg(T("theme.codeCopied"));
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(done, () => prompt(T("theme.code"), code));
    else prompt(T("theme.code"), code);
  }

  function deleteTheme(index) {
    const list = loadThemes();
    const item = list[index];
    if (!item) return;
    if (!confirm(T("theme.deleteConfirm", { name: item.name }))) return;
    list.splice(index, 1);
    saveThemes(list);
    renderPhoneThemes();
    toastMsg(T("theme.deleted", { name: item.name }));
  }

  function openMenu(item, index, anchor) {
    const back = document.createElement("div");
    back.className = "consort-back";
    const sheet = document.createElement("div");
    sheet.className = "consort-sheet";
    const b1 = document.createElement("button");
    b1.textContent = T("theme.shareCode");
    b1.addEventListener("click", () => { back.remove(); shareTheme(item); });
    const b2 = document.createElement("button");
    b2.textContent = T("menu.delete");
    b2.className = "danger";
    b2.addEventListener("click", () => { back.remove(); deleteTheme(index); });
    const b3 = document.createElement("button");
    b3.textContent = T("menu.cancel");
    b3.addEventListener("click", () => back.remove());
    sheet.append(b1, b2, b3);
    back.appendChild(sheet);
    back.addEventListener("click", (e) => { if (e.target === back) back.remove(); });
    document.body.appendChild(back);
  }

  function renderPhoneThemes() {
    const box = document.getElementById("phone-themes");
    const empty = document.getElementById("phone-empty");
    if (!box) return;
    const list = loadThemes();
    box.replaceChildren();
    if (empty) empty.style.display = list.length ? "none" : "";
    list.forEach((item, index) => {
      const t = Sloop.decodeTheme(item.bytes);
      const row = document.createElement("div");
      row.className = "themerow";
      const sw = document.createElement("div");
      sw.className = "swatches";
      if (t) for (const c of [t.c[0], t.c[2], t.c[4], t.trk[0]]) {
        const i = document.createElement("i");
        i.className = "sw";
        i.style.background = c;
        sw.appendChild(i);
      }
      const info = document.createElement("div");
      const b = document.createElement("b");
      b.textContent = item.name || "THEME";
      const s = document.createElement("span");
      s.textContent = when(item.when) + " · " + T("theme.onPhone");
      info.append(b, s);
      const acts = document.createElement("div");
      acts.className = "row";
      acts.style.marginLeft = "auto";
      acts.style.gap = "6px";
      const apply = document.createElement("button");
      apply.className = "mini";
      apply.textContent = T("theme.apply");
      apply.addEventListener("click", () => applyTheme(item, index));
      const more = document.createElement("button");
      more.className = "mini";
      more.textContent = "⋯";
      more.addEventListener("click", () => openMenu(item, index, more));
      acts.append(apply, more);
      row.append(sw, info, acts);
      box.appendChild(row);
    });
  }

  function importCode() {
    const raw = prompt(T("theme.importAsk"));
    if (!raw) return;
    const code = raw.trim().replace(/^SLOOP-THEME-1:/i, "");
    try {
      const bytes = Sloop.unb64(code);
      const t = Sloop.decodeTheme(bytes);
      if (!t) { toastMsg(T("theme.importBad")); return; }
      const list = loadThemes();
      list.unshift({ name: t.name || "THEME", when: Date.now(), bytes: Array.from(bytes) });
      saveThemes(list);
      renderPhoneThemes();
      toastMsg(T("theme.importDone", { name: t.name || "THEME" }));
    } catch (e) { toastMsg(T("theme.importFail")); }
  }

  // ---- FX: punch-in while held (LIVE op 3) ------------------------------------------------------
  let fxHeld = -1;
  function fxRelease() {
    if (fxHeld < 0) return;
    const el = document.querySelector('.fx[data-fx="' + fxHeld + '"]');
    if (el) el.classList.remove("on");
    if (link) Sloop.live(link, 3, fxHeld, 0).catch(() => {});
    fxHeld = -1;
  }
  document.querySelectorAll(".fx[data-fx]").forEach((b) => {
    b.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      if (!link) { toastMsg(T("needConnect")); return; }
      if (fxHeld >= 0) fxRelease();
      fxHeld = +b.dataset.fx;
      b.classList.add("on");
      Sloop.live(link, 3, fxHeld, 1).catch(() => {});
    });
  });
  document.addEventListener("pointerup", fxRelease);
  document.addEventListener("pointercancel", fxRelease);

  // the master effects: global parameters (SET scope 1); the engine's own ids: FILT 29, DUST 27, DUCK 28
  [["fx-filter", 29], ["fx-dust", 27], ["fx-duck", 28]].forEach(([id, gid]) => {
    const el = document.getElementById(id);
    if (!el) return;
    const out = el.parentElement.querySelector("output");
    const show = () => { if (out) out.textContent = el.value; };
    el.addEventListener("input", show);
    el.addEventListener("change", () => {
      if (!link) { toastMsg(T("needConnect")); return; }
      Sloop.setParam(link, 1, gid, +el.value).catch(() => {});
    });
    show();
  });

  // ---- songs: the section slots and a backup on the phone ------------------------------------------
  async function refreshSections() {
    const el = document.getElementById("song-status");
    if (!el) return;
    paintPills();
    if (!link) { el.textContent = T("songs.notConnected"); return; }
    try {
      const u = [];
      for (let k = 0; k < 4; k++) u.push((await Sloop.project(link, 2, k)).used);
      el.textContent = ["A", "B", "C", "D"].map((s, i) => s + " " + (u[i] ? T("songs.used") : T("songs.free"))).join(" · ");
    } catch (e) { el.textContent = T("songs.readFail"); }
  }
  function songFiles() {
    if (!window.ConsortFiles) return [];
    try { return JSON.parse(ConsortFiles.list()).filter((f) => /\.(sloopsong|sloopset)$/i.test(f.name)); }
    catch (e) { return []; }
  }
  function renderSongs() {
    const box = document.getElementById("songs-list");
    const empty = document.getElementById("songs-empty");
    if (!box) return;
    const list = songFiles();
    box.replaceChildren();
    if (empty) empty.style.display = list.length ? "none" : "";
    list.forEach((f) => {
      const row = document.createElement("div");
      row.className = "song";
      const info = document.createElement("div");
      const b = document.createElement("b");
      b.textContent = f.name;
      const sp = document.createElement("span");
      sp.textContent = (f.size ? (f.size / 1024).toFixed(1) + " KB" : "") + (f.date ? " · " + when(f.date * 1000) : "");
      info.append(b, sp);
      const more = document.createElement("button");
      more.className = "mini";
      more.textContent = "⋯";
      more.addEventListener("click", (e) => { e.stopPropagation(); songMenu(f); });
      row.append(info, more);
      row.addEventListener("click", () => { if (window.ConsortFiles) { try { ConsortFiles.share(f.name); } catch (e) { /* gone */ } } });
      box.appendChild(row);
    });
  }
  function songMenu(f) {
    const back = document.createElement("div");
    back.className = "consort-back";
    const sheet = document.createElement("div");
    sheet.className = "consort-sheet";
    const share = document.createElement("button");
    share.textContent = T("menu.share");
    share.addEventListener("click", () => { back.remove(); if (window.ConsortFiles) ConsortFiles.share(f.name); });
    const ren = document.createElement("button");
    ren.textContent = T("menu.rename");
    ren.addEventListener("click", () => {
      back.remove();
      const to = prompt(T("menu.newName"), f.name);
      if (!to) return;
      let ok = true;
      if (window.ConsortFiles) { try { ok = ConsortFiles.rename(f.name, to); } catch (e) { ok = false; } }
      if (!ok) { toastMsg(T("file.renameFail", { name: f.name })); return; }
      renderSongs();
    });
    const del = document.createElement("button");
    del.textContent = T("menu.delete");
    del.className = "danger";
    del.addEventListener("click", () => {
      back.remove();
      if (!confirm(T("deleteConfirm", { name: f.name }))) return;
      let ok = true;
      if (window.ConsortFiles) { try { ok = ConsortFiles.delete(f.name); } catch (e) { ok = false; } }
      if (!ok) { toastMsg(T("file.deleteFail", { name: f.name })); return; }
      renderSongs();
      toastMsg(T("deleted", { name: f.name }));
    });
    const cancel = document.createElement("button");
    cancel.textContent = T("menu.cancel");
    cancel.addEventListener("click", () => back.remove());
    sheet.append(share, ren, del, cancel);
    back.appendChild(sheet);
    back.addEventListener("click", (e) => { if (e.target === back) back.remove(); });
    document.body.appendChild(back);
  }
  function importSong() {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = ".sloopsong,.json,application/json";
    inp.addEventListener("change", async () => {
      const file = inp.files && inp.files[0];
      if (!file) return;
      try {
        const r = await fetch("/save?name=" + encodeURIComponent(file.name) + "&type=application/json", { method: "POST", body: file });
        if (!r.ok) throw new Error("HTTP " + r.status);
        toastMsg(T("songs.imported", { name: file.name }));
        renderSongs();
      } catch (e) { toastMsg(T("songs.importFail", { err: e.message })); }
    });
    inp.click();
  }
  function backups() {
    try { return JSON.parse(localStorage.getItem("consort.backups") || "[]"); } catch (e) { return []; }
  }
  async function backupSave() {
    if (!link) { toastMsg(T("needConnect")); return; }
    const btn = document.getElementById("bk-save");
    if (btn) { btn.disabled = true; btn.textContent = T("songs.backingUp"); }
    try {
      toastMsg(T("songs.backingUp"));
      const file = await Sloop.backupCapture(link, (done, total) => {
        if (btn && total) btn.textContent = Math.round(done / total * 100) + "%";
      });
      // A durable copy first: Download/SLOOP survives a cleared WebView, the list below is the convenience copy.
      const d = new Date(), p = (n) => (n < 10 ? "0" : "") + n;
      const stamp = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
      const fileName = "SLOOP-backup-" + stamp + ".json";
      let fileSaved = true;
      try {
        const r = await fetch("/save?name=" + encodeURIComponent(fileName) + "&type=application/json",
          { method: "POST", body: JSON.stringify(file) });
        fileSaved = r.ok;
      } catch (e) { fileSaved = !window.ConsortFiles; }   // the static preview has no saver
      const list = backups();
      const name = T("songs.backupName", { when: when(Date.now()) });
      list.unshift({ name, date: Date.now(), file });
      try {
        localStorage.setItem("consort.backups", JSON.stringify(list.slice(0, 5)));
        toastMsg(T("songs.backupDone", { n: file.objects.length })
          + (fileSaved && window.ConsortFiles ? " · Download/SLOOP" : ""));
      } catch (e) {
        toastMsg(fileSaved ? T("songs.backupFileOnly", { n: file.objects.length }) : T("storage.fail"));
      }
    } catch (e) { toastMsg(T("songs.backupFail", { err: e.message })); }
    if (btn) { btn.disabled = false; btn.textContent = T("songs.backup"); }
  }

  function backupSheet() {
    const list = backups();
    const back = document.createElement("div");
    back.className = "consort-back";
    const sheet = document.createElement("div");
    sheet.className = "consort-sheet";
    list.forEach((b) => {
      const btn = document.createElement("button");
      btn.textContent = b.name;
      btn.addEventListener("click", () => { back.remove(); restoreBackup(b); });
      sheet.appendChild(btn);
    });
    const cancel = document.createElement("button");
    cancel.textContent = T("menu.cancel");
    cancel.addEventListener("click", () => back.remove());
    const fromFile = document.createElement("button");
    fromFile.textContent = T("songs.restoreFile");
    fromFile.addEventListener("click", () => { back.remove(); restoreFromFile(); });
    sheet.appendChild(fromFile);
    sheet.appendChild(cancel);
    back.appendChild(sheet);
    back.addEventListener("click", (e) => { if (e.target === back) back.remove(); });
    document.body.appendChild(back);
  }

  function restoreFromFile() {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = ".json,application/json";
    inp.addEventListener("change", async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        if (!data || data.format !== "sloop-backup" || !Array.isArray(data.objects)) {
          toastMsg(T("songs.restoreFileBad"));
          return;
        }
        if (!confirm(T("songs.restoreConfirm", { name: f.name }))) return;
        restoreBackup({ name: f.name, file: data });
      } catch (e) { toastMsg(T("songs.restoreFileBad")); }
    });
    inp.click();
  }

  async function restoreBackup(b) {
    if (!link) { toastMsg(T("needConnect")); return; }
    if (!confirm(T("songs.restoreConfirm", { name: b.name }))) return;
    const btn = document.getElementById("bk-restore");
    if (btn) { btn.disabled = true; btn.textContent = T("songs.restoring"); }
    try {
      toastMsg(T("songs.restoring"));
      await Sloop.backupRestore(link, b.file, (done, total) => {
        if (btn && total) btn.textContent = Math.round(done / total * 100) + "%";
      });
      toastMsg(T("songs.restored", { name: b.name }));
      refreshSections();
    } catch (e) { toastMsg(T("songs.restoreFail", { err: e.message })); }
    if (btn) { btn.disabled = false; btn.textContent = T("songs.restore"); }
  }
  document.getElementById("bk-save").addEventListener("click", backupSave);
  document.getElementById("bk-restore").addEventListener("click", backupSheet);
  document.getElementById("song-import").addEventListener("click", importSong);
  const songsTab = document.querySelector('nav button[data-page="p-songs"]');
  if (songsTab) songsTab.addEventListener("click", () => { refreshSections(); renderSongs(); });

  document.getElementById("th-read").addEventListener("click", readCurrent);
  document.getElementById("th-save").addEventListener("click", saveCurrent);
  document.getElementById("th-import").addEventListener("click", importCode);
  renderPhoneThemes();
  if (current) renderCurrent(current);
  else {
    const w = document.getElementById("cur-when");
    if (w) w.textContent = T("set.notRead");
  }

  document.addEventListener("consort:lang", () => {
    setConn(!!link, cleanPortName(connRaw) || T("conn.on"));
    paintPills();
    refreshSections();
    renderSongs();
    renderPhoneThemes();
    if (current) renderCurrent(current);
    else {
      const w = document.getElementById("cur-when");
      if (w) w.textContent = T("set.notRead");
    }
    if (window.ConsortSamples && window.ConsortSamples.relabel) window.ConsortSamples.relabel();
  });
})();
