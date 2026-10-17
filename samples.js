/* Consort — the sampler: record (7 s), trim, auto-trim / normalize / fade, root note and loop,
   then encode (IMA ADPCM, 22050 mono) and send to USR1–4 through SMP. The classic order: listen, cut,
   set the root and the loop, name it, send it. */
(function () {
  "use strict";
  const App = window.ConsortApp || {};
  const SMPC = Sloop.SMP;
  const MAX_SEC = 7;
  const T = (key, vars) => (window.ConsortI18n ? ConsortI18n.t(key, vars) : key);
  const IMA_STEP = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88,
    97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658,
    724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660,
    4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818,
    18500, 20350, 22385, 24623, 27086, 29794, 32767];
  const IMA_IDX = [-1, -1, -1, -1, 2, 4, 6, 8];
  const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  let slot = 0, take = null, trim = { a: 0, b: 1 }, root = 60, loopMode = 0;
  let recorder = null, recTimer = null, recCtx = null, recAnalyser = null, recStopAt = 0;
  let lastInfo = null, lastErr = null;

  const toast = (m) => (App.toast ? App.toast(m) : null);
  const link = () => App.link || null;
  const when = (ms) => (App.when ? App.when(ms) : String(ms));
  const noteName = (n) => NOTES[n % 12] + (Math.floor(n / 12) - 1);

  function imaEncode(x) {
    let pred = 0, idx = 0;
    const nib = new Uint8Array(x.length + (x.length & 1));
    for (let n = 0; n < x.length; n++) {
      const step = IMA_STEP[idx];
      let diff = x[n] - pred, code = 0;
      if (diff < 0) { code = 8; diff = -diff; }
      let vd = step >> 3;
      if (diff >= step) { code |= 4; diff -= step; vd += step; }
      if (diff >= step >> 1) { code |= 2; diff -= step >> 1; vd += step >> 1; }
      if (diff >= step >> 2) { code |= 1; vd += step >> 2; }
      pred = Math.max(-32768, Math.min(32767, code & 8 ? pred - vd : pred + vd));
      idx = Math.max(0, Math.min(88, idx + IMA_IDX[code & 7]));
      nib[n] = code;
    }
    const out = new Uint8Array(nib.length >> 1);
    for (let k = 0; k < nib.length; k += 2) out[k >> 1] = nib[k] | (nib[k + 1] << 4);
    return out;
  }

  function buildSlot(name, zones) {
    const parts = [], zs = [];
    let len = 0;
    for (const z of zones) {
      const data = imaEncode(z.s);
      zs.push({ off: len, n: z.s.length, root: z.root, looped: z.loop ? 2 : 0 });
      parts.push(data);
      len += data.length;
    }
    if (len > SMPC.MAX_DATA) throw new Error(T("smp.tooLong"));
    const data = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { data.set(p, o); o += p.length; }
    const hdr = new Uint8Array(SMPC.HDR_LEN), v = new DataView(hdr.buffer);
    v.setUint32(0, 0x504D5346, true);
    v.setUint16(4, 1, true);
    hdr[6] = zs.length;
    const nm = String(name).toUpperCase().replace(/[^A-Z0-9 _-]/g, "").slice(0, 8) || "SAMPLE";
    for (let i = 0; i < nm.length; i++) hdr[8 + i] = nm.charCodeAt(i);
    v.setUint32(16, len, true);
    v.setUint32(20, Sloop.crc32(data), true);
    const rate = Math.round(SMPC.RATE / 44100 * 65536);
    zs.forEach((z, j) => {
      const b = 32 + j * 28;
      [z.off, z.n, 0, z.n - 1, rate].forEach((x, k) => v.setUint32(b + k * 4, x >>> 0, true));
      v.setInt16(b + 20, z.root * 16, true);
      v.setInt16(b + 22, 0, true);
      hdr[b + 24] = 0;
      hdr[b + 25] = 0;
      hdr[b + 26] = 127;
      hdr[b + 27] = z.looped;
    });
    return { hdr, data };
  }

  function monoPcm(buf) {
    const n = buf.length, out = new Float32Array(n);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) out[i] += d[i] / buf.numberOfChannels;
    }
    return out;
  }
  function resample(x, from, to) {
    if (from === to) return x;
    const n = Math.max(1, Math.round(x.length * to / from)), out = new Float32Array(n), r = from / to;
    for (let i = 0; i < n; i++) {
      const p = i * r, i0 = Math.floor(p), f = p - i0;
      const a = x[Math.min(x.length - 1, i0)], b = x[Math.min(x.length - 1, i0 + 1)];
      out[i] = a + (b - a) * f;
    }
    return out;
  }
  function toInt16(x) {
    const o = new Int16Array(x.length);
    for (let i = 0; i < x.length; i++) {
      const v = Math.max(-1, Math.min(1, x[i]));
      o[i] = v < 0 ? v * 32768 : v * 32767;
    }
    return o;
  }
  function wavBytes(pcm, rate) {
    const ab = new ArrayBuffer(44 + pcm.length * 2), v = new DataView(ab);
    const str = (o, t) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, t.charCodeAt(i)); };
    str(0, "RIFF"); v.setUint32(4, 36 + pcm.length * 2, true); str(8, "WAVE");
    str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, "data"); v.setUint32(40, pcm.length * 2, true);
    new Uint8Array(ab, 44).set(new Uint8Array(pcm.buffer));
    return new Uint8Array(ab);
  }
  function clock(sec) {
    const m = Math.floor(sec / 60), s = sec - m * 60;
    return String(m).padStart(2, "0") + ":" + (s < 10 ? "0" : "") + s.toFixed(1);
  }
  function drawWave(pcm) {
    const svg = document.getElementById("smp-wavesvg");
    const n = 96, step = pcm.length / n, out = [];
    for (let i = 0; i < n; i++) {
      let peak = 0;
      for (let j = Math.floor(i * step); j < Math.floor((i + 1) * step); j++) peak = Math.max(peak, Math.abs(pcm[j] || 0));
      const h = Math.max(2, Math.round(peak * 120));
      out.push('<rect x="' + (i * 4 + 2) + '" y="' + (66 - h / 2) + '" width="3" height="' + h + '"/>');
    }
    svg.innerHTML = '<g style="fill:var(--t1);opacity:.85">' + out.join("") + "</g>";
  }
  function drawHint() {
    const el = document.getElementById("smp-wavehint");
    if (el && !take) el.textContent = T("smp.recHint");
  }
  function setTrim(a, b) {
    a = Math.max(0, Math.min(0.98, a));
    b = Math.max(a + 0.02, Math.min(1, b));
    trim = { a, b };
    const sel = document.getElementById("smp-sel");
    sel.hidden = !take;
    sel.style.left = (a * 100) + "%";
    sel.style.right = ((1 - b) * 100) + "%";
    const lp = document.getElementById("smp-loopreg");
    lp.hidden = !take || !loopMode;
    lp.style.left = (a * 100) + "%";
    lp.style.right = ((1 - b) * 100) + "%";
    if (take) {
      const s = a * take.pcm.length / take.rate, e = b * take.pcm.length / take.rate;
      document.getElementById("smp-wavehint").textContent =
        T("smp.trimHint", { a: clock(s), b: clock(e) });
      document.getElementById("smp-time").textContent = clock(e - s);
      document.getElementById("smp-cap").textContent = "/ " + MAX_SEC.toFixed(1) + " s";
    } else {
      drawHint();
    }
  }
  function rootLabel() {
    const el = document.getElementById("smp-root");
    if (el) el.textContent = noteName(root);
  }
  function loopLabel() {
    const el = document.getElementById("smp-loopmode");
    if (el) el.textContent = loopMode ? "LOOP" : "ONE SHOT";
  }
  function paintSlots() {
    const box = document.getElementById("smp-slots");
    if (!box) return;
    box.replaceChildren();
    for (let k = 0; k < 4; k++) {
      const sl = lastInfo && lastInfo.slots[k];
      const c = document.createElement("button");
      c.className = "chip" + (k === slot ? " on" : "");
      const b = document.createElement("b");
      b.textContent = "USR" + (k + 1);
      const sp = document.createElement("span");
      sp.textContent = sl && sl.zones ? (sl.name || "—") + " · " + sl.kib + " KiB"
        : (lastInfo ? T("smp.empty", { kib: lastInfo.slotKiB })
          : (lastErr ? T("smp.readFail") : T("smp.offline")));
      c.append(b, sp);
      c.addEventListener("click", () => { slot = k; refresh(); });
      box.appendChild(c);
    }
    const inf = document.getElementById("smp-slotinfo");
    if (inf) inf.textContent = lastInfo ? T("smp.slotInfo", { n: slot + 1, kib: lastInfo.slotKiB })
      : (lastErr ? T("smp.slotInfoFail", { err: lastErr }) : T("smp.offline"));
    const send = document.getElementById("smp-upload");
    if (send) send.textContent = T("smp.send", { n: slot + 1 });
  }
  function refresh() {
    if (!link()) { lastInfo = null; lastErr = null; paintSlots(); return Promise.resolve(); }
    return Sloop.smpInfo(link())
      .then((info) => { lastInfo = info; lastErr = null; paintSlots(); })
      .catch((e) => { lastInfo = null; lastErr = e.message || String(e); paintSlots(); });
  }
  let preview = null;
  function stopPreview() {
    if (!preview) return;
    const s = preview;
    preview = null;
    const btn = document.getElementById("smp-play");
    if (btn) btn.classList.remove("on");
    try { s.stop(); } catch (e) { /* already ended */ }
  }
  function play() {
    if (!take) { toast(T("smp.needTake")); return; }
    if (preview) { stopPreview(); return; }
    const i0 = Math.floor(trim.a * take.pcm.length), i1 = Math.max(i0 + 1, Math.floor(trim.b * take.pcm.length));
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const buf = ac.createBuffer(1, i1 - i0, take.rate);
    buf.copyToChannel(take.pcm.subarray(i0, i1), 0);
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.loop = !!loopMode;                    // in LOOP the audition loops until pressed again
    src.connect(ac.destination);
    const btn = document.getElementById("smp-play");
    if (btn) btn.classList.add("on");
    src.onended = () => {
      ac.close().catch(() => {});
      if (preview === src) preview = null;
      if (btn) btn.classList.remove("on");
    };
    src.start();
    preview = src;
  }
  function autoTrim() {
    if (!take) return;
    stopPreview();
    const x = take.pcm, peak = x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    const th = Math.max(0.01, peak * 0.04);
    let i0 = 0, i1 = x.length - 1;
    while (i0 < i1 && Math.abs(x[i0]) < th) i0++;
    while (i1 > i0 && Math.abs(x[i1]) < th) i1--;
    setTrim(i0 / x.length, (i1 + 1) / x.length);
    toast(T("smp.trimmed"));
  }
  function normalize() {
    if (!take) return;
    stopPreview();
    const peak = take.pcm.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    if (peak < 1e-4) { toast(T("smp.silent")); return; }
    const g = 0.98 / peak;
    for (let i = 0; i < take.pcm.length; i++) take.pcm[i] *= g;
    drawWave(take.pcm);
    toast(T("smp.normalized"));
  }
  function fade() {
    if (!take) return;
    stopPreview();
    const n = Math.min(Math.round(take.rate * 0.015), take.pcm.length >> 2);
    for (let i = 0; i < n; i++) {
      const g = i / n;
      take.pcm[i] *= g;
      take.pcm[take.pcm.length - 1 - i] *= g;
    }
    drawWave(take.pcm);
    toast(T("smp.faded"));
  }
  async function upload() {
    if (!take) { toast(T("smp.needTake")); return; }
    if (!link()) { toast(T("needConnect")); return; }
    const i0 = Math.floor(trim.a * take.pcm.length), i1 = Math.max(i0 + 1, Math.floor(trim.b * take.pcm.length));
    const pcm = resample(take.pcm.subarray(i0, i1), take.rate, SMPC.RATE);
    const name = (document.getElementById("smp-name").value || take.name.replace(/\.wav$/i, "")).toUpperCase();
    document.getElementById("smp-name").value = name;
    let built;
    try { built = buildSlot(name, [{ s: toInt16(pcm), root, loop: loopMode }]); }
    catch (e) { toast(e.message); return; }
    const btn = document.getElementById("smp-upload");
    btn.disabled = true;
    try {
      await Sloop.smpUpload(link(), slot, built.hdr, built.data, (d, t) => { btn.textContent = Math.round(d / t * 100) + "%"; });
      toast(T("smp.written", { n: slot + 1 }));
      let saved = true;
      try {
        const r = await fetch("/save?name=" + encodeURIComponent(take.name) + "&type=audio/wav",
          { method: "POST", body: wavBytes(toInt16(pcm), SMPC.RATE) });
        saved = r.ok;
      } catch (e) { saved = !window.ConsortFiles; }   // the static preview has no saver
      if (!saved && window.ConsortFiles) toast(T("smp.writtenNoFile", { n: slot + 1 }));
      remember(take.name);
      refresh();
    } catch (e) { toast(T("smp.uploadFail", { err: e.message })); }
    btn.textContent = T("smp.send", { n: slot + 1 });
    btn.disabled = false;
  }
  function takes() {
    try { return JSON.parse(localStorage.getItem("consort.takes") || "[]"); } catch (e) { return []; }
  }
  function remember(name) {
    const list = takes().filter((t) => t.name !== name);
    list.unshift({ name, when: Date.now() });
    try { localStorage.setItem("consort.takes", JSON.stringify(list.slice(0, 20))); } catch (e) { /* full */ }
    renderTakes();
  }
  function renderTakes() {
    const box = document.getElementById("smp-takes");
    const empty = document.getElementById("smp-takes-empty");
    if (!box) return;
    const list = takes();
    box.replaceChildren();
    if (empty) empty.style.display = list.length ? "none" : "";
    list.forEach((t, i) => {
      const row = document.createElement("div");
      row.className = "take";
      const info = document.createElement("div");
      const b = document.createElement("b");
      b.textContent = t.name;
      const sp = document.createElement("span");
      sp.textContent = when(t.when) + " · " + T("smp.phone");
      info.append(b, sp);
      const more = document.createElement("button");
      more.className = "mini";
      more.textContent = "⋯";
      more.addEventListener("click", () => menu(t, i));
      row.append(info, more);
      box.appendChild(row);
    });
  }
  function menu(t, i) {
    const back = document.createElement("div");
    back.className = "consort-back";
    const sheet = document.createElement("div");
    sheet.className = "consort-sheet";
    const ren = document.createElement("button");
    ren.textContent = T("menu.rename");
    ren.addEventListener("click", () => {
      back.remove();
      const to = prompt(T("menu.newName"), t.name);
      if (!to) return;
      const m = /(\.[^.]+)$/.exec(t.name);
      const ext = m ? m[1] : "";
      let next = to.trim();
      if (ext && !next.toLowerCase().endsWith(ext.toLowerCase())) next += ext;
      if (!next) return;
      let ok = true;
      if (window.ConsortFiles) { try { ok = ConsortFiles.rename(t.name, next); } catch (e) { ok = false; } }
      if (!ok) { toast(T("file.renameFail", { name: t.name })); return; }
      const list = takes();
      if (list[i]) {
        list[i].name = next;
        localStorage.setItem("consort.takes", JSON.stringify(list));
        renderTakes();
      }
    });
    const share = document.createElement("button");
    share.textContent = T("menu.share");
    share.addEventListener("click", () => {
      back.remove();
      if (window.ConsortFiles) { try { ConsortFiles.share(t.name); return; } catch (e) { /* no bridge */ } }
      toast(T("smp.shareNone"));
    });
    const del = document.createElement("button");
    del.textContent = T("menu.delete");
    del.className = "danger";
    del.addEventListener("click", () => {
      back.remove();
      if (!confirm(T("deleteConfirm", { name: t.name }))) return;
      let ok = true;
      if (window.ConsortFiles) { try { ok = ConsortFiles.delete(t.name); } catch (e) { ok = false; } }
      if (!ok) { toast(T("file.deleteFail", { name: t.name })); return; }
      const list = takes();
      list.splice(i, 1);
      localStorage.setItem("consort.takes", JSON.stringify(list));
      renderTakes();
      toast(T("deleted", { name: t.name }));
    });
    const cancel = document.createElement("button");
    cancel.textContent = T("menu.cancel");
    cancel.addEventListener("click", () => back.remove());
    sheet.append(ren, share, del, cancel);
    back.appendChild(sheet);
    back.addEventListener("click", (e) => { if (e.target === back) back.remove(); });
    document.body.appendChild(back);
  }
  async function toggleRec() {
    const btn = document.getElementById("smp-rec");
    if (recorder && recorder.state === "recording") { recorder.stop(); return; }
    if (!navigator.mediaDevices || !window.MediaRecorder) { toast(T("smp.noRec")); return; }
    stopPreview();                            // never record the audition coming out of the speaker
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      const chunks = [];
      recCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (recCtx.resume) recCtx.resume().catch(() => {});
      const src = recCtx.createMediaStreamSource(stream);
      recAnalyser = recCtx.createAnalyser();
      recAnalyser.fftSize = 512;
      src.connect(recAnalyser);
      recorder = new MediaRecorder(stream, MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? { mimeType: "audio/webm;codecs=opus" } : undefined);
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.onstop = async () => {
        clearInterval(recTimer);
        stream.getTracks().forEach((x) => x.stop());
        if (recCtx) { try { recCtx.close(); } catch (e) { /* gone */ } recCtx = null; recAnalyser = null; }
        btn.textContent = "REC";
        btn.classList.remove("stop");
        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        const meter = document.getElementById("smp-meter");
        if (meter) meter.style.width = "0%";
        try {
          const ac = new (window.AudioContext || window.webkitAudioContext)();
          const buf = await ac.decodeAudioData(await blob.arrayBuffer());
          ac.close().catch(() => {});
          const pcm = monoPcm(buf);
          const d = new Date(), p = (x) => (x < 10 ? "0" : "") + x;
          take = { pcm, rate: buf.sampleRate, name: "REC-" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + ".wav" };
          document.getElementById("smp-name").value = "REC-" + p(d.getHours()) + p(d.getMinutes());
          drawWave(pcm);
          setTrim(0, 1);
          autoTrim();
        } catch (e) { toast(T("smp.decodeFail", { err: e.message })); }
      };
      recorder.start();
      const t0 = Date.now();
      recStopAt = t0 + MAX_SEC * 1000;
      btn.textContent = "STOP";
      btn.classList.add("stop");
      const meter = document.getElementById("smp-meter");
      const time = document.getElementById("smp-time");
      recTimer = setInterval(() => {
        const el = (Date.now() - t0) / 1000;
        time.textContent = clock(el);
        if (recAnalyser) {
          const a = new Float32Array(recAnalyser.fftSize);
          recAnalyser.getFloatTimeDomainData(a);
          let peak = 0;
          for (let i = 0; i < a.length; i++) peak = Math.max(peak, Math.abs(a[i]));
          meter.style.width = Math.min(100, Math.round(peak * 140)) + "%";
        }
        if (Date.now() >= recStopAt && recorder && recorder.state === "recording") recorder.stop();
      }, 100);
    } catch (e) { toast(T("smp.recFail", { err: e.message || e })); }
  }

  function relabel() {
    paintSlots();
    renderTakes();
    if (take) setTrim(trim.a, trim.b); else drawHint();
  }

  document.getElementById("smp-rec").addEventListener("click", toggleRec);
  document.getElementById("smp-play").addEventListener("click", play);
  document.getElementById("smp-trim").addEventListener("click", autoTrim);
  document.getElementById("smp-norm").addEventListener("click", normalize);
  document.getElementById("smp-fade").addEventListener("click", fade);
  document.getElementById("smp-upload").addEventListener("click", upload);
  document.getElementById("root-dec").addEventListener("click", () => { root = Math.max(24, root - 1); rootLabel(); });
  document.getElementById("root-inc").addEventListener("click", () => { root = Math.min(96, root + 1); rootLabel(); });
  document.getElementById("smp-loopmode").addEventListener("click", () => { stopPreview(); loopMode = loopMode ? 0 : 1; loopLabel(); setTrim(trim.a, trim.b); });
  document.getElementById("smp-name").addEventListener("input", (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9 _-]/g, "").slice(0, 8);
  });
  document.getElementById("smp-erase").addEventListener("click", async () => {
    if (!link()) { toast(T("needConnect")); return; }
    if (!confirm(T("smp.eraseConfirm", { n: slot + 1 }))) return;
    try { await Sloop.smpErase(link(), slot); toast(T("smp.erased", { n: slot + 1 })); refresh(); }
    catch (e) { toast(T("smp.eraseFail", { err: e.message })); }
  });
  const sel = document.getElementById("smp-sel");
  let edge = 0;
  sel.addEventListener("pointerdown", (e) => {
    const r = document.getElementById("smp-wave").getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    edge = Math.abs(x - trim.a) < Math.abs(x - trim.b) ? -1 : 1;
    try { sel.setPointerCapture(e.pointerId); } catch (err) { /* no capture */ }
    e.preventDefault();
  });
  sel.addEventListener("pointermove", (e) => {
    if (!sel.hasPointerCapture || !sel.hasPointerCapture(e.pointerId)) return;
    const r = document.getElementById("smp-wave").getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    if (edge < 0) setTrim(Math.min(x, trim.b - 0.02), trim.b);
    else setTrim(trim.a, Math.max(x, trim.a + 0.02));
  });
  sel.addEventListener("pointerup", (e) => { try { sel.releasePointerCapture(e.pointerId); } catch (err) { /* */ } });
  const tab = document.querySelector('nav button[data-page="p-samples"]');
  if (tab) tab.addEventListener("click", refresh);

  window.ConsortSamples = {
    refresh,
    relabel,
    _take: (pcm, rate, name) => {
      stopPreview();
      take = { pcm, rate, name: name || "TEST.wav" };
      drawWave(pcm); setTrim(0, 1); autoTrim();
    }
  };
  rootLabel();
  loopLabel();
  drawHint();
  refresh();
  renderTakes();
})();
