#!/usr/bin/env bash
# Builds the virtual FM-1 test service (tools/vfm1) without Gradle, the same way as the app.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
SDK="${ANDROID_SDK:-${ANDROID_HOME:-/d/tools/android-sdk}}"
BT="$(ls -d "$SDK"/build-tools/*/ | sort -V | tail -1)"; BT="${BT%/}"
PLATFORM="$(ls -d "$SDK"/platforms/android-* | sort -V | tail -1)"
AJAR="$PLATFORM/android.jar"
OUT="$here/build"

w() { cygpath -w "$1"; }
OUTW="$(w "$OUT")"; HEREW="$(w "$here")"; AJARW="$(w "$AJAR")"; BTW="$(w "$BT")"

rm -rf "$OUT"
mkdir -p "$OUT/classes" "$OUT/dex"

"$BTW/aapt2" compile --dir "$HEREW\\res" -o "$OUTW\\res.zip"
"$BTW/aapt2" link -o "$OUTW\\base.apk" -I "$AJARW" \
    --manifest "$HEREW\\AndroidManifest.xml" -R "$OUTW\\res.zip" \
    --auto-add-overlay --min-sdk-version 23 --target-sdk-version 36

find "$here/src" -name '*.java' | while read -r f; do w "$f"; done > "$OUT/sources.txt"
javac --release 8 -encoding UTF-8 -classpath "$AJARW" -d "$OUTW\\classes" @"$OUTW\\sources.txt"

find "$OUT/classes" -name '*.class' | while read -r f; do w "$f"; done > "$OUT/classes.txt"
"$BTW\\d8.bat" --lib "$AJARW" --min-api 23 --output "$OUTW\\dex" @"$OUTW\\classes.txt"

cp "$OUT/base.apk" "$OUT/unsigned.apk"
( cd "$OUT/dex" && jar --update --file "$OUTW\\unsigned.apk" classes.dex )
"$BTW/zipalign" -f -p 4 "$OUTW\\unsigned.apk" "$OUTW\\aligned.apk"

KS="$(w "$HOME/.android/debug.keystore")"
if [ ! -f "$HOME/.android/debug.keystore" ]; then
    mkdir -p "$HOME/.android"
    keytool -genkeypair -keystore "$KS" -storepass android -keypass android \
        -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 \
        -dname "CN=Android Debug,O=Android,C=US" >/dev/null 2>&1
fi
"$BTW\\apksigner.bat" sign --ks "$KS" --ks-key-alias androiddebugkey \
    --ks-pass pass:android --key-pass pass:android \
    --out "$HEREW\\vfm1.apk" "$OUTW\\aligned.apk"
ls -l "$here/vfm1.apk"
