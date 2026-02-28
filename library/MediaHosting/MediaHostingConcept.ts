import { Collection, Db, GridFSBucket, ObjectId } from "npm:mongodb";
import { once } from "node:events";
import { ID, Empty } from "@utils/types.ts";
import { freshID } from "@utils/database.ts";

// Generic external parameter types
export type User = ID;

const PREFIX = "MediaHosting" + ".";

interface MediaFileDoc {
  _id: ID;
  blobId: ObjectId;
  uploader: User;
  url: string;
  mimeType: string;
  fileName: string;
  accessPolicy: "public" | "protected";
  size: number;
  createdAt: Date;
}

export interface MediaFile {
  id: string;
  uploader: User;
  url: string;
  mimeType: string;
  fileName: string;
  accessPolicy: "public" | "protected";
  size: number;
  createdAt: Date;
}

/**
 * @concept MediaHosting [User]
 * @purpose To store binary media files and provide accessible URLs for them.
 * @principle If a user uploads a file (like a photo or video), the system stores it and assigns it a unique, permanent URL that can be used to display the media elsewhere.
 * @state
 *   a set of MediaFiles with
 *     an id
 *     an uploader User
 *     a url String
 *     a mimeType String
 *     a size Number
 *     a createdAt DateTime
 */
export default class MediaHostingConcept {
  mediaFiles: Collection<MediaFileDoc>;
  private mediaBucket: GridFSBucket;
  private indexesCreated = false;
  private readonly MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // 200MB

  private readonly explicitlySupportedMimeTypes = new Set([
    "application/json",
    "application/octet-stream",
    "application/pdf",
    "application/xml",
    "application/zip",
    "application/gzip",
    "text/csv",
  ]);

  constructor(private readonly db: Db) {
    this.mediaFiles = this.db.collection<MediaFileDoc>(PREFIX + "mediaFiles");
    this.mediaBucket = new GridFSBucket(this.db, {
      bucketName: PREFIX + "blobStore",
    });
  }

  private async ensureIndexes(): Promise<void> {
    if (this.indexesCreated) return;
    await this.mediaFiles.createIndex({ url: 1 }, { unique: true });
    await this.mediaFiles.createIndex({ uploader: 1, createdAt: -1 });
    this.indexesCreated = true;
  }

  private _decodeBase64(base64: string): Uint8Array {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  }

  private _sanitizeFileName(fileName: string): string {
    const trimmed = fileName.trim();
    if (!trimmed) return "file";
    return trimmed.replace(/[\\/:*?"<>|]/g, "_").slice(0, 200);
  }

  private _isMimeTypeAllowed(mimeType: string): boolean {
    if (!mimeType) return false;
    if (
      mimeType.startsWith("image/") ||
      mimeType.startsWith("video/") ||
      mimeType.startsWith("text/")
    ) {
      return true;
    }
    if (this.explicitlySupportedMimeTypes.has(mimeType)) {
      return true;
    }
    return false;
  }

  private async _toBytes(
    fileData: Blob | string | Uint8Array | ArrayBuffer,
  ): Promise<Uint8Array | { error: string }> {
    if (typeof fileData === "string") {
      if (fileData.length === 0) {
        return { error: "File data cannot be empty" };
      }
      try {
        const decoded = this._decodeBase64(fileData);
        if (decoded.length === 0) {
          return { error: "File data cannot be empty" };
        }
        return decoded;
      } catch {
        return { error: "Invalid base64 file data" };
      }
    }

    if (fileData instanceof Blob) {
      if (fileData.size === 0) {
        return { error: "File data cannot be empty" };
      }
      return new Uint8Array(await fileData.arrayBuffer());
    }

    if (fileData instanceof Uint8Array) {
      if (fileData.byteLength === 0) {
        return { error: "File data cannot be empty" };
      }
      return fileData;
    }

    if (fileData instanceof ArrayBuffer) {
      if (fileData.byteLength === 0) {
        return { error: "File data cannot be empty" };
      }
      return new Uint8Array(fileData);
    }

    return { error: "fileData must be base64, Blob, Uint8Array, or ArrayBuffer" };
  }

  async upload(
    { uploader, fileData, mimeType, fileName, accessPolicy }: {
      uploader: User;
      fileData: Blob | string | Uint8Array | ArrayBuffer;
      mimeType: string;
      fileName?: string;
      accessPolicy?: "public" | "protected";
    },
  ): Promise<
    { url: string; mimeType: string; size: number; fileName: string } | {
      error: string;
    }
  > {
    await this.ensureIndexes();

    const bytes = await this._toBytes(fileData);
    if ("error" in bytes) {
      return { error: bytes.error };
    }

    if (bytes.byteLength > this.MAX_UPLOAD_BYTES) {
      return { error: "File exceeds max upload size (200MB)" };
    }

    if (!this._isMimeTypeAllowed(mimeType)) {
      return { error: `Unsupported MIME type: ${mimeType}` };
    }

    const id = freshID();
    const blobId = new ObjectId();
    const url = `/media/${id}`;
    const now = new Date();
    const normalizedFileName = this._sanitizeFileName(
      fileName ?? `${id}.${mimeType.split("/")[1] ?? "bin"}`,
    );
    const normalizedAccessPolicy = accessPolicy ?? "public";

    const doc: MediaFileDoc = {
      _id: id,
      blobId,
      uploader,
      url,
      mimeType,
      fileName: normalizedFileName,
      accessPolicy: normalizedAccessPolicy,
      size: bytes.length,
      createdAt: now,
    };

    const uploadStream = this.mediaBucket.openUploadStreamWithId(
      blobId,
      normalizedFileName,
      {
        contentType: mimeType,
        metadata: {
          uploader,
          url,
          mediaId: id,
        },
      },
    );

    try {
      uploadStream.end(bytes);
      await once(uploadStream, "finish");
    } catch {
      try {
        await this.mediaBucket.delete(blobId);
      } catch {
        // Best-effort cleanup after stream failure.
      }
      return { error: "Failed to store file bytes" };
    }

    try {
      await this.mediaFiles.insertOne(doc);
    } catch {
      try {
        await this.mediaBucket.delete(blobId);
      } catch {
        // Best-effort cleanup if metadata write fails.
      }
      return { error: "Failed to persist media metadata" };
    }

    return {
      url,
      mimeType,
      size: bytes.byteLength,
      fileName: normalizedFileName,
    };
  }

  /**
   * delete (mediaId: String, user: User): ({} | {error: String})
   *
   * **requires** `MediaFile` exists and `uploader` matches `user`.
   * **effects** removes the `MediaFile` record and the associated binary data.
   */
  async delete(
    { mediaId, user }: { mediaId: string; user: User },
  ): Promise<Empty | { error: string }> {
    const doc = await this.mediaFiles.findOne({ _id: mediaId as ID });

    if (!doc) {
      return { error: "Media file not found" };
    }

    if (doc.uploader !== user) {
      return { error: "User is not the uploader of this file" };
    }

    try {
      await this.mediaBucket.delete(doc.blobId);
    } catch {
      return { error: "Failed to delete media bytes" };
    }

    const result = await this.mediaFiles.deleteOne({ _id: mediaId as ID });
    if (result.deletedCount === 0) {
      await this.mediaFiles.insertOne(doc);
      return { error: "Failed to delete media file" };
    }

    return {};
  }

  /**
   * Delete lifecycle: remove all media files uploaded by a user (for account deletion).
   */
  async deleteByUploader({ uploader }: { uploader: User }): Promise<{ ok: boolean }> {
    await this.ensureIndexes();
    const docs = await this.mediaFiles.find({ uploader }).toArray();
    for (const doc of docs) {
      try {
        await this.mediaBucket.delete(doc.blobId);
      } catch {
        // Continue deleting metadata so account teardown can proceed.
      }
    }
    await this.mediaFiles.deleteMany({ uploader });
    return { ok: true };
  }

  /**
   * _getMediaByUser (user: User): (MediaFile)
   *
   * **effects** returns all media files uploaded by the user.
   */
  async _getMediaByUser(
    { user }: { user: User },
  ): Promise<Array<{ mediaFile: MediaFile }>> {
    await this.ensureIndexes();
    const docs = await this.mediaFiles.find({ uploader: user }).sort({
      createdAt: -1,
    }).toArray();

    return docs.map((doc) => ({
      mediaFile: {
        id: doc._id,
        uploader: doc.uploader,
        url: doc.url,
        mimeType: doc.mimeType,
        fileName: doc.fileName,
        accessPolicy: doc.accessPolicy,
        size: doc.size,
        createdAt: doc.createdAt,
      },
    }));
  }

  private _formatContentDisposition(
    mimeType: string,
    fileName: string,
  ): string {
    const safeFileName = this._sanitizeFileName(fileName);
    const isInline = mimeType.startsWith("image/") ||
      mimeType.startsWith("video/") ||
      mimeType.startsWith("text/") ||
      mimeType === "application/json" ||
      mimeType === "application/xml";
    const mode = isInline ? "inline" : "attachment";
    return `${mode}; filename="${safeFileName}"`;
  }

  private _parseRange(
    rangeHeader: string | undefined,
    totalSize: number,
  ): {
    start: number;
    end: number;
    statusCode: 200 | 206;
    contentRange?: string;
  } | { error: "invalid_range" } {
    if (!rangeHeader || !rangeHeader.trim()) {
      return { start: 0, end: totalSize - 1, statusCode: 200 };
    }

    const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
    if (!match) return { error: "invalid_range" };

    const startStr = match[1];
    const endStr = match[2];

    let start = 0;
    let end = totalSize - 1;

    if (startStr && endStr) {
      start = Number(startStr);
      end = Number(endStr);
    } else if (startStr && !endStr) {
      start = Number(startStr);
    } else if (!startStr && endStr) {
      const suffixLength = Number(endStr);
      if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
        return { error: "invalid_range" };
      }
      start = Math.max(totalSize - suffixLength, 0);
    }

    if (
      !Number.isFinite(start) || !Number.isFinite(end) ||
      start < 0 || end < start || start >= totalSize
    ) {
      return { error: "invalid_range" };
    }

    end = Math.min(end, totalSize - 1);
    return {
      start,
      end,
      statusCode: 206,
      contentRange: `bytes ${start}-${end}/${totalSize}`,
    };
  }

  private async _readDownloadStream(
    mediaId: ObjectId,
    start: number,
    end: number,
  ): Promise<Uint8Array> {
    const downloadStream = this.mediaBucket.openDownloadStream(
      mediaId,
      {
        start,
        end: end + 1, // GridFS uses end-exclusive ranges.
      },
    );

    const chunks: Uint8Array[] = [];
    for await (const chunk of downloadStream) {
      if (chunk instanceof Uint8Array) {
        chunks.push(chunk);
      } else {
        chunks.push(new Uint8Array(chunk));
      }
    }

    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return merged;
  }

  async _getMediaData(
    { mediaId, range }: { mediaId: string; range?: string },
  ): Promise<
    Array<{
      media: {
        data: Uint8Array;
        mimeType: string;
        fileName: string;
        size: number;
        statusCode: number;
        acceptRanges: "bytes";
        contentDisposition: string;
        contentRange?: string;
      } | null;
    }>
  > {
    const doc = await this.mediaFiles.findOne({ _id: mediaId as ID });

    if (!doc) {
      return [{ media: null }];
    }

    const parsedRange = this._parseRange(range, doc.size);
    if ("error" in parsedRange) {
      return [{
        media: {
          data: new Uint8Array(),
          mimeType: doc.mimeType,
          fileName: doc.fileName,
          size: doc.size,
          statusCode: 416,
          acceptRanges: "bytes",
          contentDisposition: this._formatContentDisposition(
            doc.mimeType,
            doc.fileName,
          ),
          contentRange: `bytes */${doc.size}`,
        },
      }];
    }

    const bytes = await this._readDownloadStream(
      doc.blobId,
      parsedRange.start,
      parsedRange.end,
    );

    return [{
      media: {
        data: bytes,
        mimeType: doc.mimeType,
        fileName: doc.fileName,
        size: doc.size,
        statusCode: parsedRange.statusCode,
        acceptRanges: "bytes",
        contentDisposition: this._formatContentDisposition(
          doc.mimeType,
          doc.fileName,
        ),
        contentRange: parsedRange.contentRange,
      },
    }];
  }
}