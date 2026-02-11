import { assertEquals, assertNotEquals } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import { Binary } from "npm:mongodb";
import MediaHostingConcept, { User } from "./MediaHostingConcept.ts";

const userA = "user:Alice" as User;
const userB = "user:Bob" as User;

/**
 * Helper to create a Blob for testing.
 */
function createBlob(content: string, type: string): Blob {
  return new Blob([content], { type });
}

/**
 * Helper to encode a string as base64 (simulating what Requesting sends).
 */
function toBase64(content: string): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(content);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ========== BLOB-BASED UPLOAD TESTS ==========

Deno.test({
  name: "Blob: User uploads media, verifies storage, and deletes it",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const mediaHosting = new MediaHostingConcept(db);

    try {
      const content = "Hello, world!";
      const mimeType = "text/plain";
      const blob = createBlob(content, mimeType);

      // 1. Upload
      const uploadRes = await mediaHosting.upload({
        uploader: userA,
        fileData: blob,
        mimeType,
      });

      assertEquals("url" in uploadRes, true, "Upload should succeed");
      const url = (uploadRes as { url: string }).url;
      const mediaId = url.split("/").pop()!;

      // 2. Verify internal storage
      const doc = await mediaHosting.mediaFiles.findOne({ _id: mediaId as ID });
      assertNotEquals(doc, null, "Document should exist in DB");
      assertEquals(doc?.uploader, userA);
      assertEquals(doc?.mimeType, mimeType);
      assertEquals(doc?.size, blob.size);

      // Verify binary data content
      const storedBinary = doc?.data as Binary;
      const storedText = new TextDecoder().decode(storedBinary.buffer);
      assertEquals(storedText, content, "Stored binary data should match uploaded content");

      // 3. Verify retrieval via query
      const userMedia = await mediaHosting._getMediaByUser({ user: userA });
      assertEquals(userMedia.length, 1);
      assertEquals(userMedia[0].mediaFile.id, mediaId);
      assertEquals(userMedia[0].mediaFile.url, url);
      // @ts-ignore: checking for property existence that shouldn't be there
      assertEquals(userMedia[0].mediaFile.data, undefined);

      // 4. Delete
      const deleteRes = await mediaHosting.delete({ mediaId, user: userA });
      assertEquals("error" in deleteRes, false, "Delete should succeed");

      // 5. Verify deletion
      const finalDoc = await mediaHosting.mediaFiles.findOne({ _id: mediaId as ID });
      assertEquals(finalDoc, null, "Document should be gone from DB");

    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "Blob: upload - Validation",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const mediaHosting = new MediaHostingConcept(db);

    try {
      // Case 1: Empty file
      const emptyBlob = createBlob("", "text/plain");
      const res1 = await mediaHosting.upload({
        uploader: userA,
        fileData: emptyBlob,
        mimeType: "text/plain",
      });
      assertEquals("error" in res1, true);
      assertEquals((res1 as { error: string }).error, "File data cannot be empty");

      // Case 2: Unsupported MIME type
      const validBlob = createBlob("data", "application/x-executable");
      const res2 = await mediaHosting.upload({
        uploader: userA,
        fileData: validBlob,
        mimeType: "application/x-executable",
      });
      assertEquals("error" in res2, true);
      assertEquals((res2 as { error: string }).error.includes("Unsupported MIME type"), true);

      // Case 3: Supported MIME type (e.g. image/png)
      const pngBlob = createBlob("fake-image-data", "image/png");
      const res3 = await mediaHosting.upload({
        uploader: userA,
        fileData: pngBlob,
        mimeType: "image/png",
      });
      assertEquals("url" in res3, true);

    } finally {
      await client.close();
    }
  },
});

// ========== BASE64-BASED UPLOAD TESTS ==========

Deno.test({
  name: "Base64: User uploads media via base64, verifies storage, and retrieves data",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const mediaHosting = new MediaHostingConcept(db);

    try {
      const content = "Hello from base64!";
      const base64Data = toBase64(content);
      const mimeType = "text/plain";

      // 1. Upload via base64 string
      const uploadRes = await mediaHosting.upload({
        uploader: userA,
        fileData: base64Data,
        mimeType,
      });

      assertEquals("url" in uploadRes, true, "Base64 upload should succeed");
      const url = (uploadRes as { url: string }).url;
      const mediaId = url.split("/").pop()!;

      // 2. Verify internal storage
      const doc = await mediaHosting.mediaFiles.findOne({ _id: mediaId as ID });
      assertNotEquals(doc, null, "Document should exist in DB");
      assertEquals(doc?.mimeType, mimeType);
      assertEquals(doc?.size, new TextEncoder().encode(content).length);

      // Verify binary roundtrip
      const storedBinary = doc?.data as Binary;
      const storedText = new TextDecoder().decode(storedBinary.buffer);
      assertEquals(storedText, content, "Decoded base64 data should match original");

      // 3. Verify _getMediaData returns raw binary
      const mediaDataRes = await mediaHosting._getMediaData({ mediaId });
      assertNotEquals(mediaDataRes[0].media, null);
      const servedText = new TextDecoder().decode(mediaDataRes[0].media!.data);
      assertEquals(servedText, content, "_getMediaData should return the original bytes");
      assertEquals(mediaDataRes[0].media!.mimeType, mimeType);

      // 4. Verify _getMediaByUser still works
      const userMedia = await mediaHosting._getMediaByUser({ user: userA });
      assertEquals(userMedia.length, 1);
      assertEquals(userMedia[0].mediaFile.url, url);

      // 5. Delete and verify
      const deleteRes = await mediaHosting.delete({ mediaId, user: userA });
      assertEquals("error" in deleteRes, false);

      const gone = await mediaHosting._getMediaData({ mediaId });
      assertEquals(gone[0].media, null, "Should be null after delete");

    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "Base64: upload - Validation",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const mediaHosting = new MediaHostingConcept(db);

    try {
      // Case 1: Empty base64 string
      const res1 = await mediaHosting.upload({
        uploader: userA,
        fileData: "",
        mimeType: "text/plain",
      });
      assertEquals("error" in res1, true);
      assertEquals((res1 as { error: string }).error, "File data cannot be empty");

      // Case 2: Invalid base64 string
      const res2 = await mediaHosting.upload({
        uploader: userA,
        fileData: "!!!not-valid-base64!!!",
        mimeType: "text/plain",
      });
      assertEquals("error" in res2, true);

      // Case 3: Valid base64 but unsupported MIME type
      const res3 = await mediaHosting.upload({
        uploader: userA,
        fileData: toBase64("data"),
        mimeType: "application/x-executable",
      });
      assertEquals("error" in res3, true);

      // Case 4: Valid base64 + valid MIME
      const res4 = await mediaHosting.upload({
        uploader: userA,
        fileData: toBase64("fake-png-data"),
        mimeType: "image/png",
      });
      assertEquals("url" in res4, true);

    } finally {
      await client.close();
    }
  },
});

// ========== DELETE & QUERY TESTS (shared) ==========

Deno.test({
  name: "Action: delete - Authorization and Existence",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const mediaHosting = new MediaHostingConcept(db);

    try {
      // Setup: Upload a file
      const blob = createBlob("test", "text/plain");
      const uploadRes = await mediaHosting.upload({
        uploader: userA,
        fileData: blob,
        mimeType: "text/plain",
      });
      const url = (uploadRes as { url: string }).url;
      const mediaId = url.split("/").pop()!;

      // Case 1: Wrong user tries to delete
      const res1 = await mediaHosting.delete({ mediaId, user: userB });
      assertEquals("error" in res1, true);
      assertEquals((res1 as { error: string }).error, "User is not the uploader of this file");

      // Case 2: File does not exist
      const res2 = await mediaHosting.delete({ mediaId: "non-existent-id", user: userA });
      assertEquals("error" in res2, true);
      assertEquals((res2 as { error: string }).error, "Media file not found");

      // Case 3: Correct user deletes
      const res3 = await mediaHosting.delete({ mediaId, user: userA });
      assertEquals("error" in res3, false);

    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "Query: _getMediaByUser - Sorting and Filtering",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const mediaHosting = new MediaHostingConcept(db);

    try {
      // Upload 3 files: 2 by Alice, 1 by Bob
      await mediaHosting.upload({
        uploader: userA,
        fileData: createBlob("A1", "text/plain"),
        mimeType: "text/plain",
      });
      await new Promise(r => setTimeout(r, 10));

      await mediaHosting.upload({
        uploader: userB,
        fileData: createBlob("B1", "text/plain"),
        mimeType: "text/plain",
      });
      await new Promise(r => setTimeout(r, 10));

      await mediaHosting.upload({
        uploader: userA,
        fileData: createBlob("A2", "text/plain"),
        mimeType: "text/plain",
      });

      // Query Alice's files
      const aliceFiles = await mediaHosting._getMediaByUser({ user: userA });
      assertEquals(aliceFiles.length, 2);

      const t0 = aliceFiles[0].mediaFile.createdAt.getTime();
      const t1 = aliceFiles[1].mediaFile.createdAt.getTime();
      assertEquals(t0 >= t1, true, "Files should be sorted by createdAt descending");

      // Query Bob's files
      const bobFiles = await mediaHosting._getMediaByUser({ user: userB });
      assertEquals(bobFiles.length, 1);

    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "Lifecycle: deleteByUploader removes all media by user",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const mediaHosting = new MediaHostingConcept(db);

    try {
      await mediaHosting.upload({
        uploader: userA,
        fileData: createBlob("A1", "text/plain"),
        mimeType: "text/plain",
      });
      await mediaHosting.upload({
        uploader: userA,
        fileData: createBlob("A2", "text/plain"),
        mimeType: "text/plain",
      });
      await mediaHosting.upload({
        uploader: userB,
        fileData: createBlob("B1", "text/plain"),
        mimeType: "text/plain",
      });

      const aliceBefore = await mediaHosting._getMediaByUser({ user: userA });
      assertEquals(aliceBefore.length, 2);

      const res = await mediaHosting.deleteByUploader({ uploader: userA });
      assertEquals("ok" in res, true);

      const aliceAfter = await mediaHosting._getMediaByUser({ user: userA });
      assertEquals(aliceAfter.length, 0);

      const bobAfter = await mediaHosting._getMediaByUser({ user: userB });
      assertEquals(bobAfter.length, 1);
    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "Query: _getMediaData - non-existent returns null",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const mediaHosting = new MediaHostingConcept(db);

    try {
      const res = await mediaHosting._getMediaData({ mediaId: "does-not-exist" });
      assertEquals(res[0].media, null);
    } finally {
      await client.close();
    }
  },
});
