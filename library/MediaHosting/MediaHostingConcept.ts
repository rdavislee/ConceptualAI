import { Binary, Collection, Db } from "npm:mongodb";
import { ID, Empty } from "@utils/types.ts";
import { freshID } from "@utils/database.ts";

// Generic external parameter types
export type User = ID;

const PREFIX = "MediaHosting" + ".";

/**
 * Internal state representation for MongoDB.
 * Includes the binary data which is not necessarily returned in list queries.
 */
interface MediaFileDoc {
  _id: ID;
  uploader: User;
  url: string;
  mimeType: string;
  size: number;
  createdAt: Date;
  data: Binary;
}

/**
 * Public view of the MediaFile state (excluding binary data for lightweight transport).
 */
export interface MediaFile {
  id: string;
  uploader: User;
  url: string;
  mimeType: string;
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
  private indexesCreated = false;

  // Define supported MIME types for validation
  private readonly supportedMimeTypes = new Set([
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "video/mp4",
    "video/webm",
    "application/pdf",
    "text/plain",
  ]);

  constructor(private readonly db: Db) {
    this.mediaFiles = this.db.collection<MediaFileDoc>(PREFIX + "mediaFiles");
  }

  private async ensureIndexes(): Promise<void> {
    if (this.indexesCreated) return;
    await this.mediaFiles.createIndex({ uploader: 1, createdAt: -1 });
    this.indexesCreated = true;
  }

  /**
   * Helper: decode a base64 string to Uint8Array.
   */
  private _decodeBase64(base64: string): Uint8Array {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * upload (uploader: User, fileData: String | Blob, mimeType: String): ({url: String} | {error: String})
   *
   * **requires** fileData is not empty and mimeType is supported.
   * **effects** creates a new `MediaFile` record, stores the binary data, generates a public `url`, and returns the `url`.
   *
   * fileData accepts either:
   *   - a Blob (direct usage / tests)
   *   - a base64-encoded string (from Requesting's multipart handler)
   */
  async upload(
    { uploader, fileData, mimeType }: {
      uploader: User;
      fileData: Blob | string;
      mimeType: string;
    },
  ): Promise<{ url: string } | { error: string }> {
    // --- Resolve fileData to Uint8Array ---
    let buffer: Uint8Array;

    if (typeof fileData === "string") {
      // base64-encoded string from Requesting multipart handler
      if (fileData.length === 0) {
        return { error: "File data cannot be empty" };
      }
      try {
        buffer = this._decodeBase64(fileData);
      } catch {
        return { error: "Invalid base64 file data" };
      }
      if (buffer.length === 0) {
        return { error: "File data cannot be empty" };
      }
    } else if (fileData instanceof Blob) {
      // Direct Blob (tests / programmatic usage)
      if (!fileData || fileData.size === 0) {
        return { error: "File data cannot be empty" };
      }
      const arrayBuffer = await fileData.arrayBuffer();
      buffer = new Uint8Array(arrayBuffer);
    } else {
      return { error: "fileData must be a base64 string or Blob" };
    }

    if (!this.supportedMimeTypes.has(mimeType)) {
      return { error: `Unsupported MIME type: ${mimeType}` };
    }

    const id = freshID();
    const url = `/media/${id}`;
    const now = new Date();
    const binaryData = new Binary(buffer);

    const doc: MediaFileDoc = {
      _id: id,
      uploader,
      url,
      mimeType,
      size: buffer.length,
      createdAt: now,
      data: binaryData,
    };

    await this.mediaFiles.insertOne(doc);

    return { url };
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
    // Check existence and ownership
    const doc = await this.mediaFiles.findOne({ _id: mediaId as ID });

    if (!doc) {
      return { error: "Media file not found" };
    }

    if (doc.uploader !== user) {
      return { error: "User is not the uploader of this file" };
    }

    const result = await this.mediaFiles.deleteOne({ _id: mediaId as ID });

    if (result.deletedCount === 0) {
      // Should not happen given the findOne check, but good for safety
      return { error: "Failed to delete media file" };
    }

    return {};
  }

  /**
   * Delete lifecycle: remove all media files uploaded by a user (for account deletion).
   */
  async deleteByUploader({ uploader }: { uploader: User }): Promise<{ ok: boolean }> {
    await this.ensureIndexes();
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
        size: doc.size,
        createdAt: doc.createdAt,
      },
    }));
  }

  /**
   * _getMediaData (mediaId: String): ({ data: Uint8Array, mimeType: String } | null)
   *
   * **effects** returns the raw binary data and mimeType for a media file, or null if not found.
   * Used by the serving route to stream the file back to the client.
   */
  async _getMediaData(
    { mediaId }: { mediaId: string },
  ): Promise<Array<{ media: { data: Uint8Array; mimeType: string } | null }>> {
    const doc = await this.mediaFiles.findOne({ _id: mediaId as ID });

    if (!doc) {
      return [{ media: null }];
    }

    return [{ media: { data: doc.data.buffer, mimeType: doc.mimeType } }];
  }
}