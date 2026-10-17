// SPDX-License-Identifier: GPL-3.0-only
// A virtual FM-1 for testing Consort on an emulator: the system publishes a MIDI device named "Felucca";
// SysEx frames go to a host build of the SLOOP firmware over TCP (10.0.2.2 is the emulator's host) and
// the firmware's replies come back to the client. This is a test tool, not part of Consort.
package app.consort.vfm1;

import android.media.midi.MidiDeviceService;
import android.media.midi.MidiReceiver;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;

public final class VirtualFm1Service extends MidiDeviceService {
    private static final String TAG = "VFM1";
    private static final String HOST = "10.0.2.2";
    private static final int PORT = 47600;

    private final Object lock = new Object();
    private final ArrayDeque<byte[]> pending = new ArrayDeque<>();
    private final ByteArrayOutputStream frame = new ByteArrayOutputStream();
    private Socket socket;
    private OutputStream out;
    private volatile boolean running = true;

    private final MidiReceiver inputReceiver = new MidiReceiver() {
        @Override
        public void onSend(byte[] data, int offset, int count, long timestamp) {
            synchronized (lock) {
                for (int i = 0; i < count; i++) {
                    byte b = data[offset + i];
                    frame.write(b & 0xFF);
                    if (b == (byte) 0xF7) {
                        byte[] f = frame.toByteArray();
                        frame.reset();
                        if (f.length >= 2 && f[0] == (byte) 0xF0) sendFrame(f);
                    }
                }
            }
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        connectLoop();
    }

    @Override
    public MidiReceiver[] onGetInputPortReceivers() {
        return new MidiReceiver[]{inputReceiver};
    }

    @Override
    public void onDestroy() {
        running = false;
        closeSocket();
        super.onDestroy();
    }

    private void connectLoop() {
        new Thread(() -> {
            while (running) {
                try {
                    Socket s = new Socket();
                    s.connect(new InetSocketAddress(HOST, PORT), 2000);
                    synchronized (lock) {
                        socket = s;
                        out = s.getOutputStream();
                        for (byte[] f : pending) writeHex(f);
                        pending.clear();
                    }
                    Log.i(TAG, "connected to " + HOST + ":" + PORT);
                    readLoop(s.getInputStream());
                } catch (IOException e) {
                    Log.w(TAG, "bridge: " + e.getMessage());
                }
                closeSocket();
                if (!running) break;
                try {
                    Thread.sleep(1000);
                } catch (InterruptedException e) {
                    break;
                }
            }
        }, "vfm1-link").start();
    }

    private void readLoop(InputStream in) throws IOException {
        ByteArrayOutputStream line = new ByteArrayOutputStream();
        int c;
        while (running && (c = in.read()) >= 0) {
            if (c == '\n') {
                String s = line.toString(StandardCharsets.US_ASCII.name()).trim();
                line.reset();
                if (s.isEmpty()) continue;
                byte[] b = parseHex(s);
                if (b.length > 0) sendToClient(b);
            } else if (c != '\r') {
                line.write(c);
            }
        }
    }

    private void sendToClient(byte[] b) {
        for (int i = 0; i < 50; i++) {
            MidiReceiver[] outs = getOutputPortReceivers();
            if (outs != null && outs.length > 0) {
                try {
                    int max = outs[0].getMaxMessageSize();
                    if (max <= 0 || b.length <= max) {
                        outs[0].send(b, 0, b.length);
                    } else {
                        for (int off = 0; off < b.length; off += max)
                            outs[0].send(b, off, Math.min(max, b.length - off));
                    }
                    return;
                } catch (IOException e) {
                    Log.w(TAG, "client send", e);
                    return;
                }
            }
            try {
                Thread.sleep(20);
            } catch (InterruptedException e) {
                return;
            }
        }
        Log.w(TAG, "no output port for a reply");
    }

    private void sendFrame(byte[] f) {
        synchronized (lock) {
            if (out != null) {
                try {
                    writeHex(f);
                    return;
                } catch (IOException e) {
                    closeSocket();
                }
            }
            pending.add(f);
            if (pending.size() > 64) pending.removeFirst();
        }
    }

    private void writeHex(byte[] f) throws IOException {
        StringBuilder sb = new StringBuilder(f.length * 3);
        for (int i = 0; i < f.length; i++) {
            if (i > 0) sb.append(' ');
            sb.append(String.format("%02X", f[i] & 0xFF));
        }
        sb.append('\n');
        out.write(sb.toString().getBytes(StandardCharsets.US_ASCII));
        out.flush();
    }

    private void closeSocket() {
        synchronized (lock) {
            try {
                if (socket != null) socket.close();
            } catch (IOException ignored) {
            }
            socket = null;
            out = null;
        }
    }

    private static byte[] parseHex(String s) {
        String[] parts = s.trim().split("\\s+");
        byte[] b = new byte[parts.length];
        for (int i = 0; i < parts.length; i++) {
            try {
                b[i] = (byte) Integer.parseInt(parts[i], 16);
            } catch (NumberFormatException e) {
                return new byte[0];
            }
        }
        return b;
    }
}
