**concept** MediaHosting [User]

**purpose** 
To store binary media files and provide accessible URLs for them.

**principle**
If a user uploads a file (like a photo or video), the system stores it and assigns it a unique, permanent URL that can be used to display the media elsewhere.

**state**
```
a set of MediaFiles with
  an id
  an uploader User
  a url String
  a mimeType String
  a size Number
  a createdAt DateTime
```

**actions**

`upload (uploader: User, fileData: String | Blob, mimeType: String): ({url: String} | {error: String})`
*   **requires** fileData is not empty and mimeType is supported.
*   **effects** creates a new `MediaFile` record, stores the binary data, generates a public `url`, and returns the `url`.
*   **note** fileData accepts a base64-encoded string (from HTTP multipart) or a Blob (programmatic usage).

`delete (mediaId: String, user: User): ({} | {error: String})`
*   **requires** `MediaFile` exists and `uploader` matches `user`.
*   **effects** removes the `MediaFile` record and the associated binary data.

`deleteByUploader (uploader: User): (ok: Flag)`
*   **requires** true
*   **effects** removes all media files uploaded by the user (for account deletion).

**queries**

`_getMediaByUser (user: User): (MediaFile)`
*   **effects** returns all media files uploaded by the user.

`_getMediaData (mediaId: String): ({ data: Uint8Array, mimeType: String } | null)`
*   **effects** returns the raw binary data and mimeType for a media file, or null if not found. Used for serving the file back to clients.
*   **serving note** The API should expose a `GET /media/{id}` endpoint. The sync for this endpoint calls `_getMediaData`, then responds with a `ReadableStream` and `Content-Type` header set to the mimeType. The Requesting concept's handler already supports stream responses. The `url` field returned by `upload` (e.g. `/media/{id}`) is designed to match this route, so uploaded media can be referenced directly in `<img>` tags or similar.