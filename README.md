# Consort

A phone companion for the **M-VAVE FM-1** running **SLOOP 2.7**. It does not try to reproduce the machine's controls; it covers the things that are awkward on a phone.

Status: work in progress. The APK builds, the USB MIDI handshake works on a real FM-1, and the phone-side features (library, files, skins, languages) are tested. The sampler, FX, theme and backup writes are still being verified on hardware.

## What it does

- **Sampler** — record up to 7 s through the phone mic, trim (auto or by dragging the ends), normalize, fade, set the root note and loop mode, name it, and send it to one of the four USR slots. Takes stay on the phone as WAV in `Download/SLOOP`.
- **FX** — every effect on one dense page, grouped by kind, with the master FILTER / DUST / DUCK sliders. Hold a pad to engage it, release to let go.
- **Songs** — song/section status, a full backup and restore (songs, sections, settings, presets; every backup is also written to `Download/SLOOP` as a JSON file), and a phone-side library: import a `.sloopsong`, rename it, share it to another app, delete it.
- **Settings** — read the current theme from the FM-1, save it on the phone, write it back, and wear the same colours in the app; eight interface languages (English by default); about.

The FM-1 is reached over USB MIDI through Android's own `android.media.midi`, not Web MIDI. No firmware is modified. Phones need USB host / OTG; the FM-1's USB port must be the one that exposes MIDI.

## Build

Needs the Android SDK (build-tools and a platform), JDK 17, and a shell where `aapt2`, `javac`, `d8`, `zipalign` and `apksigner` can run.

    bash android/build.sh

The signed APK is written to `consort.apk` at the project root (and `android/consort.apk`).

## Preview without hardware

    python -m http.server 8765
    # open http://127.0.0.1:8765/index.html

Without the native bridge the page connects to a mock FM-1, so the whole UI and protocol flow can be exercised in a browser. Transfers are simulated; nothing is written to Download/SLOOP in this mode.

## Protocol

SLOOP 2.7 over USB MIDI: `F0 7D 46 4C <cmd> <7-bit args> F7`. Framing, request/response, backup objects, themes (THM2) and sample slots (SMP, IMA ADPCM) live in `protocol.js`.

```
index.html   the four pages and the banner
theme.css    SLOOP's visual language (Terminus, square controls)
i18n.js      the eight interface languages
protocol.js  framing, Link, backup objects, themes, SMP
app.js       theme/skin, FX, songs, settings
samples.js   the sampler
android/     WebView shell, local server, USB MIDI bridge, file bridge
```

## Credits and licences

- SLOOP and the FM-1 belong to their respective authors. This is an independent companion and contains no firmware.
- The code is GPL-3.0-only (see `LICENSE`), matching the SLOOP editor sources it was developed against.
- The Terminus font is SIL OFL 1.1; see `LICENSES/Terminus-OFL.txt`.
