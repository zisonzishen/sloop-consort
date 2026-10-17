// SPDX-License-Identifier: GPL-3.0-only
// The FM-1 as a MIDI port to the editor in the WebView, through Android's own USB MIDI (android.media.midi):
// no Web MIDI, no browser version to depend on. The editor calls navigator.requestMIDIAccess(); assets/midi-shim.js
// turns that into calls on this class, and this class turns them into MidiInputPort.send / MidiOutputPort.
package app.consort;

import android.content.Context;
import android.media.midi.MidiDevice;
import android.media.midi.MidiDeviceInfo;
import android.media.midi.MidiInputPort;
import android.media.midi.MidiManager;
import android.media.midi.MidiOutputPort;
import android.media.midi.MidiReceiver;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.IOException;
import java.util.regex.Pattern;

public final class MidiBridge {
    private static final String TAG = "ConsortMidi";
    /* the names the editor accepts (web/editor.html FM1_PORT), and every FM-1 firmware has the same USB IDs */
    private static final Pattern FM1 = Pattern.compile("fm-1|felucca|sloop|clipper|ota|composite|sinco|usb-midi",
            Pattern.CASE_INSENSITIVE);

    private final WebView web;
    private final MidiManager mm;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private volatile String portName = "";
    private volatile MidiInputPort toDevice;      /* editor -> FM-1 */
    private MidiOutputPort fromDevice;            /* FM-1 -> editor */
    private MidiDevice device;
    private boolean opening;
    private int openSeq;
    private final StreamFramer framer = new StreamFramer();
    private volatile int txCount, rxCount;

    public MidiBridge(WebView web, MidiManager mm) {
        this.web = web;
        this.mm = mm;
        if (mm != null) try {
            mm.registerDeviceCallback(new MidiManager.DeviceCallback() {
                @Override
                public void onDeviceAdded(MidiDeviceInfo info) {
                    if (matches(info) && device == null && !opening) connectOnUi();
                }

                @Override
                public void onDeviceRemoved(MidiDeviceInfo info) {
                    if (device != null && info.getId() == device.getInfo().getId()) {
                        closeQuietly();
                        js("window.__consortLost&&window.__consortLost()");
                    }
                }
            }, ui);
        } catch (RuntimeException e) {          // a build without hotplug support: connect still works
            Log.w(TAG, "no device callback", e);
        }
    }

    /** Called from the shim: open the FM-1, then call back into window.__consortOpened. */
    @JavascriptInterface
    public void connect() {
        ui.post(this::connectOnUi);
    }

    /** One MIDI message, as the comma-separated bytes the shim sends. */
    @JavascriptInterface
    public void send(String csv) {
        MidiInputPort p = toDevice;
        if (p == null || csv == null || csv.isEmpty()) return;
        String[] parts = csv.split(",");
        byte[] b = new byte[parts.length];
        for (int i = 0; i < parts.length; i++) {
            try {
                b[i] = (byte) (Integer.parseInt(parts[i].trim()) & 0xFF);
            } catch (NumberFormatException e) {
                return;
            }
        }
        try {
            p.send(b, 0, b.length);
            if (txCount++ == 0) Log.i(TAG, "tx " + hex(b));
        } catch (IOException e) {
            Log.w(TAG, "send", e);
        }
    }

    @JavascriptInterface
    public void disconnect() {
        ui.post(() -> {
            closeQuietly();
            js("window.__consortLost&&window.__consortLost()");
        });
    }

    private void connectOnUi() {
        if (toDevice != null) {
            jsOpened(true, "");
            return;
        }
        if (opening) return;
        if (mm == null) {                    // no MIDI service at all (some builds): nothing to connect to
            jsOpened(false, "no MIDI service");
            return;
        }
        MidiDeviceInfo found = null;
        for (MidiDeviceInfo info : mm.getDevices()) {
            if (matches(info)) {
                found = info;
                break;
            }
        }
        if (found == null) {
            portName = "";
            Log.w(TAG, "no FM-1 USB MIDI device among " + mm.getDevices().length);
            jsOpened(false, "no FM-1 USB MIDI device");
            return;
        }
        portName = name(found);
        opening = true;
        final int seq = ++openSeq;
        ui.postDelayed(() -> {                  // never leave the editor saying "connecting"
            if (opening && seq == openSeq) {
                opening = false;
                jsOpened(false, "open timed out");
            }
        }, 5000);
        mm.openDevice(found, d -> {
            if (seq != openSeq) return;
            opening = false;
            if (d == null) {
                Log.w(TAG, "openDevice returned null for " + portName);
                jsOpened(false, "could not open the device (USB permission?)");
                return;
            }
            device = d;
            toDevice = d.openInputPort(0);
            fromDevice = d.openOutputPort(0);
            Log.i(TAG, "opened " + portName + " in=" + d.getInfo().getInputPortCount()
                    + " out=" + d.getInfo().getOutputPortCount());
            if (fromDevice != null) {
                fromDevice.connect(new MidiReceiver() {
                    @Override
                    public void onSend(byte[] data, int offset, int count, long timestamp) {
                        push(data, offset, count);
                    }
                });
            }
            jsOpened(toDevice != null, toDevice != null ? "" : "the device has no input port");
            ui.postDelayed(() -> {              // the editor sends its first frame at once; a silent device says why
                if (toDevice != null && txCount > 0 && rxCount == 0)
                    toast("FM-1 已连接，但没有收到任何回传数据");
            }, 6000);
        }, ui);
    }

    private static boolean matches(MidiDeviceInfo info) {
        return FM1.matcher(name(info)).find();
    }

    private static String name(MidiDeviceInfo info) {
        return info.getProperties().getString(MidiDeviceInfo.PROPERTY_NAME, "");
    }

    private void jsOpened(boolean ok, String why) {
        // quote() keeps a device descriptor with quotes, backslashes or control characters from breaking the script
        js("window.__consortOpened&&window.__consortOpened(" + ok + "," + JSONObject.quote(portName)
                + "," + JSONObject.quote(why) + ")");
    }

    private void js(String code) {
        web.post(() -> web.evaluateJavascript(code, null));
    }

    private void closeQuietly() {
        openSeq++;
        opening = false;
        try {
            if (toDevice != null) toDevice.close();
        } catch (IOException ignored) {
        }
        try {
            if (fromDevice != null) fromDevice.close();
        } catch (IOException ignored) {
        }
        try {
            if (device != null) device.close();
        } catch (IOException ignored) {
        }
        toDevice = null;
        fromDevice = null;
        device = null;
        portName = "";
    }

    /* Android hands over a byte stream (SysEx in pieces, several messages per call); the editor expects one
       complete message per event, as Web MIDI gives it. */
    private void push(byte[] data, int offset, int count) {
        framer.feed(data, offset, count, this::deliver);
    }

    private void deliver(byte[] msg, int len) {
        if (rxCount++ == 0) Log.i(TAG, "rx " + hex(msg, len));
        StringBuilder sb = new StringBuilder(len * 4);
        for (int i = 0; i < len; i++) {
            if (i > 0) sb.append(',');
            sb.append(msg[i] & 0xFF);
        }
        final String csv = sb.toString();
        js("window.__consortIn&&window.__consortIn('" + csv + "')");
    }

    private static String hex(byte[] b) {
        return hex(b, b.length);
    }

    private static String hex(byte[] b, int n) {
        StringBuilder s = new StringBuilder(n * 3);
        for (int i = 0; i < n; i++) {
            if (i > 0) s.append(' ');
            s.append(String.format("%02X", b[i] & 0xFF));
        }
        return s.toString();
    }

    private void toast(String msg) {
        Context ctx = web.getContext();
        ui.post(() -> Toast.makeText(ctx, msg, Toast.LENGTH_LONG).show());
    }
}
