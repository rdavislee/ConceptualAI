**concept** MediaHosting [User]

**purpose**
To store files (images, videos, audio, documents, and generic binary data) and provide stable URLs for retrieval.

**principle**
If a user uploads a file, the system stores metadata separately from file bytes and assigns a unique URL that can be used for display or download.

**state**
```
a set of MediaFiles with
  an id
  a blobId
  an uploader User
  a url String
  a mimeType String
  a fileName String
  an accessPolicy ("public" | "protected")
  a size Number
  a createdAt DateTime
```

**actions**

`upload (uploader: User, fileData: String | Blob | Uint8Array | ArrayBuffer, mimeType: String, fileName?: String, accessPolicy?: "public" | "protected"): ({url: String, mimeType: String, size: Number, fileName: String} | {error: String})`
*   **requires** fileData is not empty, file size is <= 200MB, and mimeType is supported.
*   **effects** stores file bytes in GridFS-like chunked storage, writes metadata in `mediaFiles`, and returns a canonical URL (`/media/{id}`) plus file metadata.
*   **note** supports base64 strings for compatibility, but direct byte uploads avoid base64 inflation.
*   **supported types** any `image/*`, `video/*`, `audio/*`, or `text/*` MIME type, plus: `application/json`, `application/octet-stream`, `application/pdf`, `application/xml`, `application/zip`, `application/gzip`, `application/msword`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document` (docx), `application/vnd.ms-excel` (xls), `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` (xlsx), `application/vnd.ms-powerpoint` (ppt), `application/vnd.openxmlformats-officedocument.presentationml.presentation` (pptx).

`delete (mediaId: String, user: User): ({} | {error: String})`
*   **requires** `MediaFile` exists and `uploader` matches `user`.
*   **effects** removes associated blob bytes and metadata.

`deleteByUploader (uploader: User): (ok: Flag)`
*   **requires** true
*   **effects** removes all blobs and metadata uploaded by the user (for account deletion).

**queries**

`_getMediaByUser (user: User): (MediaFile)`
*   **effects** returns all media files uploaded by the user.

`_getMediaText (mediaId: String): ({ text: String, mimeType: String, fileName: String } | null)`
*   **effects** returns the extracted readable text content of a stored media file, routing through the appropriate parser for the file's MIME type (plain text, PDF, DOCX, etc.). Returns null when the mediaId does not exist.

`_getMediaData (mediaId: String, range?: String): ({ data: Uint8Array, mimeType: String, fileName: String, size: Number, statusCode: Number, acceptRanges: "bytes", contentDisposition: String, contentRange?: String } | null)`
*   **effects** returns file bytes + serving metadata for a media file, or null when missing.
*   **range behavior** accepts `Range` request values (e.g., `bytes=0-1048575`) and returns partial content metadata (`206`, `Content-Range`) for playback and resumable downloads.
*   **serving note** Generated APIs should expose `GET /media/{id}` and forward range headers to `_getMediaData`, then set response headers from query output:
    * `Content-Type: mimeType`
    * `Content-Disposition: contentDisposition`
    * `Accept-Ranges: bytes`
    * `Content-Range` when present