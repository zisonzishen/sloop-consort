// SPDX-License-Identifier: GPL-3.0-only
// A tiny loopback HTTP server for assets/: the editor expects an origin to run under (ES modules, fetch of the
// preview wasm, localStorage), and a file:// page is not one. 127.0.0.1 counts as a secure context, so the
// editor's AudioWorklet preview works exactly as it does on the site.
//
// It also takes the editor's exports: every download in the page is a blob: link, which a WebView cannot save by
// itself, so assets/midi-shim.js POSTs the bytes to /save and they land in Download/SLOOP.
package app.consort;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.res.AssetManager;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.util.Log;
import android.widget.Toast;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.net.URLConnection;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

final class LocalServer implements Runnable {
    private static final String TAG = "Sloop";
    private static final int PORT = 47311;      /* the origin of the editor, and so of its storage */

    private final Context ctx;
    private final AssetManager assets;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ServerSocket server;
    private final byte[] index;          // index.html with midi-shim.js inserted into <head>

    LocalServer(Context ctx) throws IOException {
        this.ctx = ctx;
        this.assets = ctx.getAssets();
        index = read("index.html").getBytes(StandardCharsets.UTF_8);
        // A stable port gives the page a stable origin. With a random one the origin changed at every launch and
        // the editor's localStorage and IndexedDB (its library, settings) were effectively wiped each time.
        ServerSocket s = null;
        try {
            s = new ServerSocket(PORT, 16, InetAddress.getByName("127.0.0.1"));
            Log.i(TAG, "serving on 127.0.0.1:" + PORT);
        } catch (IOException e) {
            Log.w(TAG, "port " + PORT + " busy, falling back to a random one", e);
            s = new ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"));
        }
        server = s;
        Thread t = new Thread(this, "sloop-local");
        t.setDaemon(true);
        t.start();
    }

    int port() {
        return server.getLocalPort();
    }

    void close() {
        try {
            server.close();
        } catch (IOException ignored) {
        }
    }

    @Override
    public void run() {
        while (!server.isClosed()) {
            try {
                Socket s = server.accept();
                Thread t = new Thread(() -> handle(s), "sloop-local-req");
                t.setDaemon(true);
                t.start();
            } catch (IOException e) {
                return;
            }
        }
    }

    private void handle(Socket sock) {
        try (Socket s = sock) {
            s.setSoTimeout(120000);
            InputStream in = s.getInputStream();
            String head = readHead(in);
            if (head == null) return;
            String[] lines = head.split("\r\n");
            String[] req = lines[0].split(" ");
            if (req.length < 2) return;
            long length = 0;
            for (int i = 1; i < lines.length; i++) {
                int c = lines[i].indexOf(':');
                if (c > 0 && lines[i].substring(0, c).trim().equalsIgnoreCase("Content-Length")) {
                    try {
                        length = Long.parseLong(lines[i].substring(c + 1).trim());
                    } catch (NumberFormatException ignored) {
                    }
                }
            }
            String target = req[1];
            String query = "";
            int q = target.indexOf('?');
            if (q >= 0) {
                query = target.substring(q + 1);
                target = target.substring(0, q);
            }
            String path = URLDecoder.decode(target, "UTF-8");
            if ("POST".equals(req[0]) && path.equals("/save")) {
                save(s, in, length, query);
                return;
            }
            if (!"GET".equals(req[0])) {
                send(s, 405, "text/plain; charset=utf-8", new byte[0]);
                return;
            }
            if (path.isEmpty() || path.equals("/")) path = "/index.html";
            if (path.contains("..")) {
                send(s, 404, "text/plain; charset=utf-8", new byte[0]);
                return;
            }
            if (path.equals("/index.html")) {
                send(s, 200, "text/html; charset=utf-8", index);
                return;
            }
            try (InputStream a = assets.open(path.substring(1))) {
                send(s, 200, mime(path), copy(a));
            } catch (IOException e) {
                send(s, 404, "text/plain; charset=utf-8", new byte[0]);
            }
        } catch (IOException ignored) {
        }
    }

    // --- saving the editor's exports -------------------------------------------------------------------

    private void save(Socket s, InputStream in, long length, String query) {
        Map<String, String> q = parseQuery(query);
        String name = safeName(q.get("name"));
        String type = q.get("type");
        if (type == null || type.isEmpty()) {
            String guess = URLConnection.guessContentTypeFromName(name);
            type = guess != null ? guess : "application/octet-stream";
        }
        // MediaStore appends the extension of the MIME type it is given: a .sloopsong sent as application/json
        // would become .sloopsong.json. When the two do not agree, keep the name and store it as a plain file.
        String ext = ext(name);
        String known = ext.isEmpty() ? null
                : android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        if (known == null || !known.equalsIgnoreCase(type)) type = "application/octet-stream";
        File tmp = null;
        try {
            tmp = File.createTempFile("sloop-export", ".part", ctx.getCacheDir());
            try (OutputStream o = new FileOutputStream(tmp)) {
                copyN(in, o, length);
            }
            String where = store(tmp, name, type);
            send(s, 200, "text/plain; charset=utf-8", where.getBytes(StandardCharsets.UTF_8));
            String msg = "保存到 " + where;
            if (name.startsWith("SLOOP-live-") && name.endsWith(".wav"))
                msg += "（在 Samples → Chop a recording 里载入）";
            toast(msg);
        } catch (Exception e) {
            Log.e(TAG, "save " + name, e);
            try {
                send(s, 500, "text/plain; charset=utf-8", String.valueOf(e).getBytes(StandardCharsets.UTF_8));
            } catch (IOException ignored) {
            }
            toast("保存失败：" + e.getMessage());       // never fail quietly
        } finally {
            if (tmp != null) //noinspection ResultOfMethodCallIgnored
                tmp.delete();
        }
    }

    /** Writes the file where a person can find it and returns that path. */
    private String store(File tmp, String name, String type) throws IOException {
        if (Build.VERSION.SDK_INT >= 29) {
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            v.put(MediaStore.MediaColumns.MIME_TYPE, type);
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/SLOOP");
            v.put(MediaStore.MediaColumns.IS_PENDING, 1);
            ContentResolver cr = ctx.getContentResolver();
            Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
            if (uri == null) throw new IOException("MediaStore refused the file");
            try (OutputStream o = cr.openOutputStream(uri)) {
                if (o == null) throw new IOException("no output stream");
                try (InputStream i = new FileInputStream(tmp)) {
                    copy(i, o);
                }
            } catch (IOException e) {
                cr.delete(uri, null, null);
                throw e;
            }
            ContentValues done = new ContentValues();
            done.put(MediaStore.MediaColumns.IS_PENDING, 0);
            cr.update(uri, done, null, null);
            return Environment.DIRECTORY_DOWNLOADS + "/SLOOP/" + name;
        }
        File dir = ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (dir == null) dir = ctx.getFilesDir();
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        File out = unique(dir, name);
        try (InputStream i = new FileInputStream(tmp); OutputStream o = new FileOutputStream(out)) {
            copy(i, o);
        }
        MediaScannerConnection.scanFile(ctx, new String[]{out.getAbsolutePath()}, null, null);
        return out.getAbsolutePath();
    }

    private static File unique(File dir, String name) {
        File f = new File(dir, name);
        if (!f.exists()) return f;
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 1; ; i++) {
            f = new File(dir, base + " (" + i + ")" + ext);
            if (!f.exists()) return f;
        }
    }

    private static String ext(String name) {
        int dot = name.lastIndexOf('.');
        return dot > 0 ? name.substring(dot + 1).toLowerCase(Locale.ROOT) : "";
    }

    private static String safeName(String name) {
        if (name == null) name = "";
        name = name.replaceAll("[\\\\/:*?\"<>|\\r\\n\\t]", "_").trim();
        if (name.isEmpty() || name.equals(".") || name.equals("..")) name = "sloop-export";
        return name;
    }

    private static Map<String, String> parseQuery(String query) {
        Map<String, String> m = new HashMap<>();
        for (String pair : query.split("&")) {
            int e = pair.indexOf('=');
            if (e <= 0) continue;
            try {
                m.put(URLDecoder.decode(pair.substring(0, e), "UTF-8"),
                        URLDecoder.decode(pair.substring(e + 1), "UTF-8"));
            } catch (IOException ignored) {
            }
        }
        return m;
    }

    private void toast(String text) {
        main.post(() -> Toast.makeText(ctx, text, Toast.LENGTH_LONG).show());
    }

    // --- http -------------------------------------------------------------------------------------------

    /** The request line and headers, up to the empty line. */
    private static String readHead(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream(1024);
        while (b.size() < 65536) {
            int c = in.read();
            if (c < 0) return null;
            b.write(c);
            if (c == '\n' && b.size() >= 4) {
                byte[] h = b.toByteArray();
                int m = h.length;
                if (h[m - 4] == '\r' && h[m - 3] == '\n' && h[m - 2] == '\r' && h[m - 1] == '\n')
                    return new String(h, StandardCharsets.ISO_8859_1);
            }
        }
        return new String(b.toByteArray(), StandardCharsets.ISO_8859_1);
    }

    private static void copyN(InputStream in, OutputStream out, long n) throws IOException {
        byte[] buf = new byte[1 << 16];
        long left = n;
        while (left > 0) {
            int r = in.read(buf, 0, (int) Math.min(buf.length, left));
            if (r < 0) throw new IOException("request body ended early (" + left + " bytes missing)");
            out.write(buf, 0, r);
            left -= r;
        }
    }

    private String read(String name) throws IOException {
        try (InputStream in = assets.open(name)) {
            return new String(copy(in), StandardCharsets.UTF_8);
        }
    }

    private static byte[] copy(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        copy(in, out);
        return out.toByteArray();
    }

    private static void copy(InputStream in, OutputStream out) throws IOException {
        byte[] buf = new byte[1 << 16];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
    }

    private static void send(Socket s, int code, String type, byte[] body) throws IOException {
        String reason = code == 200 ? "OK" : code == 404 ? "Not Found" : code == 500 ? "Internal Error"
                : "Method Not Allowed";
        OutputStream o = s.getOutputStream();
        o.write(("HTTP/1.1 " + code + " " + reason + "\r\n"
                + "Content-Type: " + type + "\r\n"
                + "Content-Length: " + body.length + "\r\n"
                + "Cache-Control: no-store\r\n"
                + "Connection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
        o.write(body);
        o.flush();
    }

    private static String mime(String p) {
        p = p.toLowerCase(Locale.ROOT);
        if (p.endsWith(".html") || p.endsWith(".htm")) return "text/html; charset=utf-8";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript; charset=utf-8";
        if (p.endsWith(".wasm")) return "application/wasm";
        if (p.endsWith(".ttf")) return "font/ttf";
        if (p.endsWith(".css")) return "text/css; charset=utf-8";
        if (p.endsWith(".json") || p.endsWith(".webmanifest")) return "application/json";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".txt")) return "text/plain; charset=utf-8";
        return "application/octet-stream";
    }
}
