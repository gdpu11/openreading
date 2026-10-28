package cn.ixiaoshi.openreading;

import org.junit.Test;
import static org.junit.Assert.*;
import java.io.*;
import java.nio.file.Files;
import java.security.MessageDigest;

public class OfflineFileStoreTest {
    private byte[] chunk(long offset, long size) {
        byte[] bytes = new byte[(int)Math.min(OfflineFileStore.CHUNK_SIZE, size - offset)];
        for (int i = 0; i < bytes.length; i++) bytes[i] = (byte)((offset + i) % 251);
        return bytes;
    }
    private String digest(byte[] bytes) throws Exception {
        return OfflineFileStore.hex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }
    private String key(long size) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        for (long offset = 0; offset < size; offset += OfflineFileStore.CHUNK_SIZE) digest.update(chunk(offset, size));
        return OfflineFileStore.hex(digest.digest());
    }
    private void remove(File dir) throws Exception {
        try (java.util.stream.Stream<java.nio.file.Path> paths = Files.walk(dir.toPath())) {
            for (java.nio.file.Path path : paths.sorted(java.util.Comparator.reverseOrder()).toArray(java.nio.file.Path[]::new)) Files.delete(path);
        }
    }
    @Test public void streamsSixtyMegabytesWithBoundedChunks() throws Exception {
        File dir = Files.createTempDirectory("offline-large").toFile();
        long size = 61976622;
        String key = key(size);
        try {
            Files.write(new File(dir, ".receiving-" + key).toPath(), new byte[]{9, 8, 7});
            int[] reads = {0};
            OfflineFileStore.commit(dir, key, size, offset -> {
                reads[0]++;
                byte[] bytes = chunk(offset, size);
                return new OfflineFileStore.Part(bytes, digest(bytes), size);
            });
            assertEquals(30, reads[0]);
            assertEquals(size, new File(dir, key).length());
            assertTrue(OfflineFileStore.verified(new File(dir, key), key));
            assertEquals(1, dir.list().length);
        } finally { remove(dir); }
    }
    @Test public void failurePreservesPublishedFileAndCleansTemporaryFile() throws Exception {
        File dir = Files.createTempDirectory("offline-retry").toFile();
        long size = OfflineFileStore.CHUNK_SIZE + 7L;
        String key = key(size);
        OfflineFileStore.ChunkReader good = offset -> {
            byte[] bytes = chunk(offset, size);
            return new OfflineFileStore.Part(bytes, digest(bytes), size);
        };
        try {
            OfflineFileStore.commit(dir, key, size, good);
            for (boolean corruption : new boolean[]{false, true}) {
                try {
                    OfflineFileStore.commit(dir, key, size, offset -> {
                        if (offset > 0) {
                            if (!corruption) throw new IOException("disk full");
                            return new OfflineFileStore.Part(new byte[7], key, size);
                        }
                        return good.read(offset);
                    });
                    fail("expected interrupted commit");
                } catch (IOException expected) {}
                assertTrue(OfflineFileStore.verified(new File(dir, key), key));
                assertEquals(1, dir.list().length);
            }
            OfflineFileStore.commit(dir, key, size, good);
            assertTrue(OfflineFileStore.verified(new File(dir, key), key));
        } finally { remove(dir); }
    }
    @Test public void validatesFinalHashEmptyFilesAndKeys() throws Exception {
        File dir = Files.createTempDirectory("offline-hash").toFile();
        try {
            String empty = key(0);
            OfflineFileStore.commit(dir, empty, 0, offset -> { throw new AssertionError(); });
            assertTrue(OfflineFileStore.verified(new File(dir, empty), empty));
            try {
                OfflineFileStore.commit(dir, empty, 1, offset -> {
                    byte[] bytes = {1};
                    return new OfflineFileStore.Part(bytes, digest(bytes), 1);
                });
                fail();
            } catch (OfflineFileStore.IntegrityException expected) {}
            assertEquals(1, dir.list().length);
            try { OfflineFileStore.validKey("../../state"); fail(); }
            catch (IllegalArgumentException expected) {}
        } finally { remove(dir); }
    }
}
