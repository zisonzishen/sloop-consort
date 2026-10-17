// SPDX-License-Identifier: GPL-3.0-only
// Host half of the virtual FM-1 test rig. It runs the SLOOP firmware's editor as a host build, seeds a
// theme, and bridges SysEx frames between that firmware and the Android virtual MIDI service over TCP.
//   1. build the host firmware:  (WSL) gcc -O2 -w -Ibuild/gen -Ifirmware/src -Itools/wasm_shim \
//        -o build/editor_host tests/editor_host.c -lm        (in the sloop-src tree)
//   2. node tools/vfm1/bridge.mjs
//   3. install tools/vfm1/vfm1.apk, start its service, then open Consort.
import fs from "node:fs";
import vm from "node:vm";
import net from "node:net";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOST_BIN = "/mnt/d/zisonzishen/development/sloop/sloop-src/build/editor_host";
const PORT = 47600;
const protoPath = fileURLToPath(new URL("../../protocol.js", import.meta.url));
const src = fs.readFileSync(protoPath, "utf8");
const ctx = { console, setTimeout, clearTimeout, btoa, atob, TextDecoder, TextEncoder };
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(src, ctx);
const Sloop = ctx.Sloop;

const host = spawn("wsl.exe", ["-e", HOST_BIN], { stdio: ["pipe", "pipe", "pipe"] });
host.stderr.on("data", () => {});
let readyResolve;
const ready = new Promise((r) => { readyResolve = r; });
let readyFlag = false;
let mode = "seed";
let client = null;

const seedTransport = {
  send(bytes) {
    host.stdin.write(Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join(" ") + "\n");
  }
};

const hex = (bytes) => Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join(" ");

readline.createInterface({ input: host.stdout }).on("line", (line) => {
  const s = line.trim();
  if (!readyFlag) {
    if (s === "READY") { readyFlag = true; readyResolve(); }
    return;
  }
  if (!s) return;
  if (mode === "seed") {
    if (seedTransport.link) seedTransport.link.receive(Uint8Array.from(s.split(/\s+/).map((h) => parseInt(h, 16))));
    return;
  }
  if (client && !client.destroyed) {
    console.log("<-", s.slice(0, 80));
    client.write(s + "\n");
  } else {
    console.log("<- (no client)", s.slice(0, 40));
  }
});

function seed() {
  return Sloop.connect(seedTransport).then(async (link) => {
    const theme = Sloop.encodeTheme({
      name: "VFM1",
      c: ["#222222", "#444444", "#666666", "#888888", "#aaaaaa"],
      trk: ["#ff0000", "#00ff00", "#0000ff", "#ffff00"],
      bg: "#000000",
      hi: "#ffffff"
    });
    await Sloop.writeTheme(link, theme);
    console.log("seeded theme VFM1");
  });
}

function startServer() {
  net.createServer((socket) => {
    client = socket;
    console.log("client connected");
    let buf = "";
    socket.setEncoding("ascii");
    socket.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const bytes = line.split(/\s+/).map((h) => parseInt(h, 16));
        if (bytes[0] !== 0xF0 || bytes[bytes.length - 1] !== 0xF7) continue;
        console.log("->", "cmd", bytes[4], "len", bytes.length);
        host.stdin.write(line + "\n");
      }
    });
    socket.on("close", () => { console.log("client gone"); client = null; });
    socket.on("error", (e) => { console.log("client error:", e.message); client = null; });
  }).listen(PORT, "127.0.0.1", () => console.log("bridge on 127.0.0.1:" + PORT));
}

(async () => {
  await ready;
  await seed();
  mode = "bridge";
  console.log("firmware ready");
  startServer();
})().catch((e) => {
  console.error("bridge error:", e);
  try { host.kill(); } catch (e2) { /* gone */ }
  process.exit(1);
});
