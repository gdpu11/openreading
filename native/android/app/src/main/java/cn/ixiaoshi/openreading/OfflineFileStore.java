package cn.ixiaoshi.openreading;

import java.io.*;
import java.nio.file.*;
import java.security.MessageDigest;

/** Content-addressed files: verify bounded chunks before atomically publishing. */
final class OfflineFileStore {
    static final int CHUNK_SIZE = 2 * 1024 * 1024;
    static final long MAX_SIZE = 210L * 1024 * 1024;
    interface ChunkReader { Part read(long offset) throws Exception; }
    static final class Part {
        final byte[] bytes;
        final String hash;
        final long total;
        Part(byte[] bytes, String hash, long total) {
            this.bytes = bytes; this.hash = hash; this.total = total;
        }
    }
    static final class IntegrityException extends IOException {
        IntegrityException() { super("文件校验失败，请重新同步"); }
    }
    static void validKey(String key) {
        if (key == null || !key.matches("[a-f0-9]{64}")) throw new IllegalArgumentException("无效的文件校验值");
    }
    static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(64);
        for (byte b : bytes) out.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
        return out.toString();
    }
    static boolean verified(File file, String key) throws Exception {
        validKey(key);
        if (!file.isFile() || file.length() > MAX_SIZE) return false;
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
        }
        return hex(digest.digest()).equals(key);
    }
    static synchronized void commit(File directory, String key, long total, ChunkReader reader) throws Exception {
        validKey(key);
        if (total < 0 || total > MAX_SIZE) throw new IllegalArgumentException("无效的文件大小");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("无法创建离线文件目录");
        // Reuse the same staging path after a process kill. Never accumulate
        // another whole-file temporary copy each time the download is resumed.
        File temporary = new File(directory, ".receiving-" + key);
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (FileOutputStream output = new FileOutputStream(temporary)) {
                for (long offset = 0; offset < total; offset += CHUNK_SIZE) {
                    Part part = reader.read(offset);
                    if (part.total != total || part.bytes.length != Math.min(CHUNK_SIZE, total - offset)
                            || !hex(MessageDigest.getInstance("SHA-256").digest(part.bytes)).equals(part.hash))
                        throw new IntegrityException();
                    output.write(part.bytes);
                    digest.update(part.bytes);
                }
                output.flush();
                output.getFD().sync();
            }
            if (!hex(digest.digest()).equals(key)) throw new IntegrityException();
            Files.move(temporary.toPath(), new File(directory, key).toPath(),
                    StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } finally {
            temporary.delete();
        }
    }
}
