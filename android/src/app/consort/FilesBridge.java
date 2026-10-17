// SPDX-License-Identifier: GPL-3.0-only
// The phone's half of the library: list what is in Download/SLOOP, share a file through the system sheet,
// rename it, delete it. The page asks for names; the MediaStore row does the work.
package app.consort;

import android.app.Activity;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

public final class FilesBridge {
    private static final String DIR = Environment.DIRECTORY_DOWNLOADS + "/SLOOP";
    private final Activity activity;
    private final Handler ui = new Handler(Looper.getMainLooper());

    public FilesBridge(Activity activity) {
        this.activity = activity;
    }

    /** [{name, size, date}] as JSON, newest first. */
    @JavascriptInterface
    public String list() {
        StringBuilder sb = new StringBuilder("[");
        boolean first = true;
        if (Build.VERSION.SDK_INT >= 29) {
            String[] cols = {MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.SIZE, MediaStore.MediaColumns.DATE_ADDED};
            try (Cursor c = activity.getContentResolver().query(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cols,
                    MediaStore.MediaColumns.RELATIVE_PATH + " LIKE ?", new String[]{DIR + "/%"},
                    MediaStore.MediaColumns.DATE_ADDED + " DESC")) {
                while (c != null && c.moveToNext()) {
                    if (!first) sb.append(',');
                    first = false;
                    sb.append("{\"name\":\"").append(esc(c.getString(0))).append("\",\"size\":").append(c.getLong(1))
                            .append(",\"date\":").append(c.getLong(2)).append('}');
                }
            } catch (Exception ignored) {
            }
        } else {
            File dir = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            File[] files = dir != null ? dir.listFiles() : null;
            List<File> out = new ArrayList<>();
            if (files != null) for (File f : files) if (f.isFile()) out.add(f);
            out.sort((a, b) -> Long.compare(b.lastModified(), a.lastModified()));
            for (File f : out) {
                if (!first) sb.append(',');
                first = false;
                sb.append("{\"name\":\"").append(esc(f.getName())).append("\",\"size\":").append(f.length())
                        .append(",\"date\":").append(f.lastModified() / 1000).append('}');
            }
        }
        return sb.append(']').toString();
    }

    @JavascriptInterface
    public void share(String name) {
        Uri uri = uriFor(name);
        if (uri == null) { toast("找不到文件：" + name); return; }
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType(mime(name));
        send.putExtra(Intent.EXTRA_STREAM, uri);
        send.putExtra(Intent.EXTRA_SUBJECT, name);
        send.setClipData(android.content.ClipData.newRawUri(name, uri));
        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        ui.post(() -> {
            try {
                activity.startActivity(Intent.createChooser(send, "分享 " + name));
            } catch (Exception e) {
                toast("没有可以分享的应用");
            }
        });
    }

    @JavascriptInterface
    public void rename(String name, String to) {
        String clean = to == null ? "" : to.trim().replaceAll("[\\\\/:*?\"<>|\\r\\n\\t]", "_");
        if (clean.isEmpty()) return;
        String oldExt = ext(name);
        if (!oldExt.isEmpty() && !clean.toLowerCase(Locale.ROOT).endsWith("." + oldExt)) clean += "." + oldExt;
        if (Build.VERSION.SDK_INT >= 29) {
            Uri uri = uriFor(name);
            if (uri == null) return;
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, clean);
            activity.getContentResolver().update(uri, v, null, null);
        } else {
            File dir = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            File from = new File(dir, name), dest = new File(dir, clean);
            if (from.isFile() && !dest.exists()) from.renameTo(dest);
        }
    }

    @JavascriptInterface
    public void delete(String name) {
        if (Build.VERSION.SDK_INT >= 29) {
            Uri uri = uriFor(name);
            if (uri != null) activity.getContentResolver().delete(uri, null, null);
        } else {
            File dir = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            File f = new File(dir, name);
            if (f.isFile()) f.delete();
        }
    }

    private Uri uriFor(String name) {
        if (Build.VERSION.SDK_INT >= 29) {
            try (Cursor c = activity.getContentResolver().query(MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                    new String[]{MediaStore.MediaColumns._ID},
                    MediaStore.MediaColumns.DISPLAY_NAME + "=? AND " + MediaStore.MediaColumns.RELATIVE_PATH + " LIKE ?",
                    new String[]{name, DIR + "/%"}, null)) {
                if (c != null && c.moveToFirst())
                    return ContentUris.withAppendedId(MediaStore.Downloads.EXTERNAL_CONTENT_URI, c.getLong(0));
            } catch (Exception ignored) {
            }
            return null;
        }
        return uriForLegacy(name);
    }

    private Uri uriForLegacy(String name) {
        File f = new File(activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), name);
        try (Cursor c = activity.getContentResolver().query(MediaStore.Files.getContentUri("external"),
                new String[]{MediaStore.Files.FileColumns._ID},
                MediaStore.Files.FileColumns.DATA + "=?", new String[]{f.getAbsolutePath()}, null)) {
            if (c != null && c.moveToFirst())
                return ContentUris.withAppendedId(MediaStore.Files.getContentUri("external"), c.getLong(0));
        } catch (Exception ignored) {
        }
        return null;
    }

    private static String ext(String name) {
        int dot = name.lastIndexOf('.');
        return dot > 0 ? name.substring(dot + 1) : "";
    }

    private static String mime(String name) {
        String n = name.toLowerCase(Locale.ROOT);
        if (n.endsWith(".wav")) return "audio/wav";
        if (n.endsWith(".json") || n.endsWith(".sloopsong") || n.endsWith(".sloopset")) return "application/json";
        if (n.endsWith(".mid")) return "audio/midi";
        return "application/octet-stream";
    }

    private static String esc(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n");
    }

    private void toast(String m) {
        ui.post(() -> Toast.makeText(activity, m, Toast.LENGTH_LONG).show());
    }
}
