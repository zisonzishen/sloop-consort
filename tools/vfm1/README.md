# Virtual FM-1 (test rig)

A way to run the **real APK** against the **real SLOOP firmware** without an FM-1:

```
Consort APK  ←Android MIDI→  vfm1.apk (virtual MIDI device "Felucca")
                                     ↕ TCP 10.0.2.2:47600
                             bridge.mjs  ←stdio→  editor_host (SLOOP firmware, host build)
```

- `vfm1.apk` is a tiny `MidiDeviceService`: Android publishes it as a MIDI device named `Felucca`,
  so Consort's normal USB-MIDI bridge opens it like the machine. It forwards complete SysEx frames,
  as hex lines, to the bridge.
- `bridge.mjs` runs the SLOOP firmware's editor as a host binary, seeds a valid theme, and forwards
  frames between the firmware and the Android device.
- The firmware is the actual `editor.c` (INFO, GET/SET, SMP, BK, PROJECT, LIVE) with the browser
  emulator's storage/flash environment; it is not a reimplementation.

## 1. Build the firmware host

In a clone of the SLOOP sources (GPL-3.0), on Linux or WSL with gcc:

```sh
cd sloop-src
gcc -O2 -w -Ibuild/gen -Ifirmware/src -Itools/wasm_shim -o build/editor_host tests/editor_host.c -lm
```

`tests/editor_host.c` is the small host bridge (it includes the emulator's firmware environment and
`editor.c`, and answers one frame per stdin line). The generated headers in `build/gen` come from the
emulator build (`sh web/emu/build.sh` generates them; no WASM toolchain is needed for this host build).

## 2. Build and run

```sh
bash tools/vfm1/build.sh                 # tools/vfm1/vfm1.apk
node tools/vfm1/bridge.mjs               # listens on 127.0.0.1:47600
adb install -r tools/vfm1/vfm1.apk
adb install -r consort.apk
adb shell am start -n app.consort/.MainActivity
```

Use an emulator with the MIDI service (`android.software.midi`). A Google APIs system image has it;
some vendor/custom images do not. `adb shell dumpsys midi` shows the `Felucca` device once Consort
asks for MIDI devices.

`10.0.2.2` is the emulator's alias for the host loopback. For a real phone on the same LAN, change
`HOST` in `VirtualFm1Service.java` to the PC's address and rebuild.

## What has been exercised this way

- INFO handshake and the 4 × 80 KiB USR slots
- the app's own IMA ADPCM encoder → USR1, stored object and data CRC verified
- erase a slot; the WAV stays in `Download/SLOOP`
- FX press/release (LIVE op 3) and a master SET (FILTER)
- theme read, save, write-back (BK_PUT) and app skin
- full backup (15 objects) to the app and to `Download/SLOOP`, and restore
- a 320 dp screen layout (the app must not overflow)
