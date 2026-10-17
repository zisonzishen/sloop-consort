// SPDX-License-Identifier: GPL-3.0-only
// Android's MIDI transport delivers a raw byte stream to MidiReceiver.onSend: a SysEx can arrive in pieces, and
// one call can hold several messages. Web MIDI (what the editor was written against) hands over one complete
// message per event, so the bytes are framed here first: SysEx is accumulated from F0 to F7 across calls, channel
// messages are collected by their data-byte count (with running status), and real-time bytes pass through.
package app.consort;

final class StreamFramer {
    interface Sink {
        void message(byte[] data, int length);
    }

    private final byte[] buf = new byte[1 << 16];
    private int len;
    private int need = -1;       // data bytes still to come for the current message
    private int status;          // last channel status byte, for running status

    synchronized void feed(byte[] data, int offset, int count, Sink sink) {
        for (int i = offset; i < offset + count; i++) {
            int b = data[i] & 0xFF;
            if (b >= 0xF8) {                                  // real-time: never interrupts anything
                sink.message(new byte[]{(byte) b}, 1);
                continue;
            }
            if (len > 0 && (buf[0] & 0xFF) == 0xF0) {         // inside a SysEx
                if (len == buf.length) len = 0;               // pathological stream: drop it
                buf[len++] = (byte) b;
                if (b == 0xF7) {
                    sink.message(buf, len);
                    len = 0;
                }
                continue;
            }
            if (b == 0xF0) {
                len = 0;
                buf[len++] = (byte) b;
                status = 0;
                continue;
            }
            if (b >= 0x80) {                                  // a status byte starts a message
                len = 0;
                buf[len++] = (byte) b;
                status = b < 0xF0 ? b : 0;
                int hi = b & 0xF0;
                if (hi == 0xC0 || hi == 0xD0) need = 1;
                else if (hi >= 0x80 && hi <= 0xE0) need = 2;
                else if (b == 0xF1 || b == 0xF3) need = 1;    // system common
                else if (b == 0xF2) need = 2;
                else need = 0;                                // F4-F6, F7 alone
                if (need == 0) {
                    sink.message(buf, len);
                    len = 0;
                }
                continue;
            }
            if (need > 0) {                                   // data byte
                if (len == buf.length) len = 0;
                buf[len++] = (byte) b;
                if (--need == 0) {
                    sink.message(buf, len);
                    len = 0;
                }
            } else if (status != 0) {                         // running status
                len = 0;
                buf[len++] = (byte) status;
                buf[len++] = (byte) b;
                need = ((status & 0xF0) == 0xC0 || (status & 0xF0) == 0xD0) ? 0 : 1;
                if (need == 0) {
                    sink.message(buf, len);
                    len = 0;
                }
            }                                                 // else: a stray data byte
        }
    }
}
