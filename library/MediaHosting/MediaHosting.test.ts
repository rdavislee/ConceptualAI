import { assertEquals, assertExists } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import { ID } from "@utils/types.ts";
import MediaHostingConcept, { User } from "./MediaHostingConcept.ts";

const userA = "user:Alice" as User;
const userB = "user:Bob" as User;

function createBlob(content: string, type: string): Blob {
  return new Blob([content], { type });
}

function toBase64(content: string): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(content);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

Deno.test({
  name: "upload stores metadata + GridFS bytes and returns full upload payload",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const mediaHosting = new MediaHostingConcept(db);

    try {
      const content = "Hello, file hosting!";
      const mimeType = "text/plain";
      const blob = createBlob(content, mimeType);
      const uploadRes = await mediaHosting.upload({
        uploader: userA,
        fileData: blob,
        mimeType,
        fileName: "note.txt",
        accessPolicy: "protected",
      });

      assertEquals("url" in uploadRes, true);
      const url = (uploadRes as { url: string }).url;
      const mediaId = url.split("/").pop()!;
      assertEquals((uploadRes as { fileName: string }).fileName, "note.txt");
      assertEquals((uploadRes as { size: number }).size, blob.size);
      assertEquals((uploadRes as { mimeType: string }).mimeType, mimeType);

      const doc = await mediaHosting.mediaFiles.findOne({ _id: mediaId as ID });
      assertExists(doc);
      assertEquals(doc.uploader, userA);
      assertEquals(doc.mimeType, mimeType);
      assertEquals(doc.fileName, "note.txt");
      assertEquals(doc.accessPolicy, "protected");
      assertEquals(doc.size, blob.size);

      const gridFsFile = await db.collection("MediaHosting.blobStore.files").findOne({
        _id: doc.blobId,
      });
      assertExists(gridFsFile);

      const mediaData = await mediaHosting._getMediaData({ mediaId });
      assertExists(mediaData[0].media);
      const decoded = new TextDecoder().decode(mediaData[0].media!.data);
      assertEquals(decoded, content);
      assertEquals(mediaData[0].media!.statusCode, 200);
      assertEquals(mediaData[0].media!.acceptRanges, "bytes");
      assertEquals(mediaData[0].media!.contentDisposition, 'inline; filename="note.txt"');

    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "upload rejects unsupported mime and oversized payloads",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const mediaHosting = new MediaHostingConcept(db);

    try {
      const emptyBlob = createBlob("", "text/plain");
      const res1 = await mediaHosting.upload({
        uploader: userA,
        fileData: emptyBlob,
        mimeType: "text/plain",
      });
      assertEquals("error" in res1, true);
      assertEquals((res1 as { error: string }).error, "File data cannot be empty");

      const validBlob = createBlob("data", "application/x-executable");
      const res2 = await mediaHosting.upload({
        uploader: userA,
        fileData: validBlob,
        mimeType: "application/x-executable",
      });
      assertEquals("error" in res2, true);
      assertEquals((res2 as { error: string }).error.includes("Unsupported MIME type"), true);

      // Keep the test lightweight by shrinking max size during this test.
      (mediaHosting as unknown as { MAX_UPLOAD_BYTES: number }).MAX_UPLOAD_BYTES = 4;
      const tinyLimitBlob = createBlob("12345", "text/plain");
      const res3 = await mediaHosting.upload({
        uploader: userA,
        fileData: tinyLimitBlob,
        mimeType: "text/plain",
      });
      assertEquals("error" in res3, true);
      assertEquals((res3 as { error: string }).error, "File exceeds max upload size (200MB)");

    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "upload accepts markdown, audio, and Office document MIME types",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const mediaHosting = new MediaHostingConcept(db);

    const cases: Array<{ mimeType: string; fileName: string }> = [
      { mimeType: "text/markdown", fileName: "readme.md" },
      { mimeType: "audio/mpeg", fileName: "song.mp3" },
      { mimeType: "audio/wav", fileName: "clip.wav" },
      { mimeType: "audio/ogg", fileName: "track.ogg" },
      { mimeType: "application/msword", fileName: "legacy.doc" },
      {
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        fileName: "report.docx",
      },
      { mimeType: "application/vnd.ms-excel", fileName: "data.xls" },
      {
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        fileName: "data.xlsx",
      },
      { mimeType: "application/vnd.ms-powerpoint", fileName: "deck.ppt" },
      {
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        fileName: "deck.pptx",
      },
    ];

    try {
      for (const { mimeType, fileName } of cases) {
        const res = await mediaHosting.upload({
          uploader: userA,
          fileData: createBlob("content", mimeType),
          mimeType,
          fileName,
        });
        assertEquals(
          "url" in res,
          true,
          `Expected upload to succeed for ${mimeType} (${fileName}), got error: ${"error" in res ? (res as { error: string }).error : ""}`,
        );
        assertEquals((res as { mimeType: string }).mimeType, mimeType);
        assertEquals((res as { fileName: string }).fileName, fileName);
      }
    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "base64 upload is still accepted",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const mediaHosting = new MediaHostingConcept(db);

    try {
      const content = "Hello from base64!";
      const base64Data = toBase64(content);
      const mimeType = "text/plain";

      const uploadRes = await mediaHosting.upload({
        uploader: userA,
        fileData: base64Data,
        mimeType,
        fileName: "base64.txt",
      });

      assertEquals("url" in uploadRes, true);
      const url = (uploadRes as { url: string }).url;
      const mediaId = url.split("/").pop()!;

      const mediaDataRes = await mediaHosting._getMediaData({ mediaId });
      assertExists(mediaDataRes[0].media);
      const servedText = new TextDecoder().decode(mediaDataRes[0].media!.data);
      assertEquals(servedText, content);
      assertEquals(mediaDataRes[0].media!.mimeType, mimeType);

    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "range request returns 206 + content-range",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const mediaHosting = new MediaHostingConcept(db);

    try {
      const upload = await mediaHosting.upload({
        uploader: userA,
        fileData: createBlob("abcdef", "text/plain"),
        mimeType: "text/plain",
        fileName: "letters.txt",
      });
      assertEquals("url" in upload, true);
      const mediaId = (upload as { url: string }).url.split("/").pop()!;

      const ranged = await mediaHosting._getMediaData({
        mediaId,
        range: "bytes=1-3",
      });
      assertExists(ranged[0].media);
      assertEquals(ranged[0].media!.statusCode, 206);
      assertEquals(ranged[0].media!.contentRange, "bytes 1-3/6");
      assertEquals(new TextDecoder().decode(ranged[0].media!.data), "bcd");

    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "invalid range returns 416 payload",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const mediaHosting = new MediaHostingConcept(db);

    try {
      const uploadRes = await mediaHosting.upload({
        uploader: userA,
        fileData: createBlob("test", "text/plain"),
        mimeType: "text/plain",
      });
      const mediaId = (uploadRes as { url: string }).url.split("/").pop()!;
      const invalid = await mediaHosting._getMediaData({
        mediaId,
        range: "bytes=999-1000",
      });
      assertExists(invalid[0].media);
      assertEquals(invalid[0].media!.statusCode, 416);
      assertEquals(invalid[0].media!.contentRange, "bytes */4");

    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "delete enforces ownership and removes both metadata + blob",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const mediaHosting = new MediaHostingConcept(db);

    try {
      const upload = await mediaHosting.upload({
        uploader: userA,
        fileData: createBlob("A1", "text/plain"),
        mimeType: "text/plain",
      });
      const mediaId = (upload as { url: string }).url.split("/").pop()!;
      const doc = await mediaHosting.mediaFiles.findOne({ _id: mediaId as ID });
      assertExists(doc);

      const unauthorized = await mediaHosting.delete({ mediaId, user: userB });
      assertEquals("error" in unauthorized, true);
      assertEquals(
        (unauthorized as { error: string }).error,
        "User is not the uploader of this file",
      );

      const deleted = await mediaHosting.delete({ mediaId, user: userA });
      assertEquals("error" in deleted, false);

      const metadataGone = await mediaHosting.mediaFiles.findOne({ _id: mediaId as ID });
      assertEquals(metadataGone, null);
      const blobGone = await db.collection("MediaHosting.blobStore.files").findOne({
        _id: doc.blobId,
      });
      assertEquals(blobGone, null);

    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "query _getMediaByUser returns newest first with file metadata",
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
        fileName: "a1.txt",
        accessPolicy: "public",
      });
      await new Promise((r) => setTimeout(r, 5));
      await mediaHosting.upload({
        uploader: userA,
        fileData: createBlob("A2", "text/plain"),
        mimeType: "text/plain",
        fileName: "a2.txt",
        accessPolicy: "protected",
      });

      const byUser = await mediaHosting._getMediaByUser({ user: userA });
      assertEquals(byUser.length, 2);
      assertEquals(byUser[0].mediaFile.fileName, "a2.txt");
      assertEquals(byUser[0].mediaFile.accessPolicy, "protected");
      assertEquals(byUser[1].mediaFile.fileName, "a1.txt");
      assertEquals(
        byUser[0].mediaFile.createdAt.getTime() >= byUser[1].mediaFile.createdAt.getTime(),
        true,
      );
    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "deleteByUploader removes metadata + blob files",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const mediaHosting = new MediaHostingConcept(db);

    try {
      await mediaHosting.upload({
        uploader: userA,
        fileData: createBlob("A1", "video/mp4"),
        mimeType: "video/mp4",
        fileName: "clip.mp4",
      });
      await mediaHosting.upload({
        uploader: userA,
        fileData: toBase64("print('hello')"),
        mimeType: "application/octet-stream",
        fileName: "script.py",
      });

      const beforeMeta = await mediaHosting.mediaFiles.countDocuments({ uploader: userA });
      const beforeBlobs = await db.collection("MediaHosting.blobStore.files").countDocuments({});
      assertEquals(beforeMeta, 2);
      assertEquals(beforeBlobs >= 2, true);

      const result = await mediaHosting.deleteByUploader({ uploader: userA });
      assertEquals(result.ok, true);

      const afterMeta = await mediaHosting.mediaFiles.countDocuments({ uploader: userA });
      const afterBlobs = await db.collection("MediaHosting.blobStore.files").countDocuments({});
      assertEquals(afterMeta, 0);
      assertEquals(afterBlobs, 0);
    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "_getMediaText extracts text content from a stored file",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const mediaHosting = new MediaHostingConcept(db);

    try {
      const content = "# Hello Markdown\n\nSome body text.";
      const uploadRes = await mediaHosting.upload({
        uploader: userA,
        fileData: createBlob(content, "text/markdown"),
        mimeType: "text/markdown",
        fileName: "readme.md",
      });
      assertEquals("url" in uploadRes, true);
      const mediaId = (uploadRes as { url: string }).url.split("/").pop()!;

      const textRes = await mediaHosting._getMediaText({ mediaId });
      assertExists(textRes[0].media);
      assertEquals(textRes[0].media!.text, content);
      assertEquals(textRes[0].media!.mimeType, "text/markdown");
      assertEquals(textRes[0].media!.fileName, "readme.md");
    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "_getMediaText returns null for missing mediaId",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const mediaHosting = new MediaHostingConcept(db);
    try {
      const res = await mediaHosting._getMediaText({ mediaId: "missing-id" });
      assertEquals(res[0].media, null);
    } finally {
      await client.close();
    }
  },
});

Deno.test({
  name: "_getMediaData returns null for missing mediaId",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const mediaHosting = new MediaHostingConcept(db);
    try {
      const res = await mediaHosting._getMediaData({ mediaId: "missing-id" });
      assertEquals(res[0].media, null);
    } finally {
      await client.close();
    }
  },
});
