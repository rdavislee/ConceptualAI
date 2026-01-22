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

Deno.test("Principle: User uploads media, verifies storage, and deletes it", async () => {
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
    // Extract ID from URL /media/{id}
    const mediaId = url.split("/").pop()!;

    // 2. Verify internal storage (including binary data)
    // We access the collection directly to verify the binary data was saved,
    // since the public query omits it.
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
    // Ensure binary data is NOT returned in the lightweight view
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
});

Deno.test("Action: upload - Validation", async () => {
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
});

Deno.test("Action: delete - Authorization and Existence", async () => {
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
});

Deno.test("Query: _getMediaByUser - Sorting and Filtering", async () => {
  const [db, client] = await testDb();
  const mediaHosting = new MediaHostingConcept(db);

  try {
    // Upload 3 files: 2 by Alice, 1 by Bob
    // We add small delays to ensure createdAt timestamps differ for sorting check
    
    // Alice File 1
    await mediaHosting.upload({
      uploader: userA,
      fileData: createBlob("A1", "text/plain"),
      mimeType: "text/plain",
    });
    await new Promise(r => setTimeout(r, 10));

    // Bob File 1
    await mediaHosting.upload({
      uploader: userB,
      fileData: createBlob("B1", "text/plain"),
      mimeType: "text/plain",
    });
    await new Promise(r => setTimeout(r, 10));

    // Alice File 2
    await mediaHosting.upload({
      uploader: userA,
      fileData: createBlob("A2", "text/plain"),
      mimeType: "text/plain",
    });

    // Query Alice's files
    const aliceFiles = await mediaHosting._getMediaByUser({ user: userA });
    assertEquals(aliceFiles.length, 2);
    
    // Verify sorting: Newest (A2) should be first
    // Since we can't easily check content via query, we check size or just order if we assume IDs/URLs differ.
    // However, we know the order of insertion.
    // Let's verify the timestamps are descending.
    const t0 = aliceFiles[0].mediaFile.createdAt.getTime();
    const t1 = aliceFiles[1].mediaFile.createdAt.getTime();
    assertEquals(t0 >= t1, true, "Files should be sorted by createdAt descending");

    // Query Bob's files
    const bobFiles = await mediaHosting._getMediaByUser({ user: userB });
    assertEquals(bobFiles.length, 1);

  } finally {
    await client.close();
  }
});