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

`upload (uploader: User, fileData: Blob, mimeType: String): ({url: String} | {error: String})`
*   **requires** fileData is not empty and mimeType is supported.
*   **effects** creates a new `MediaFile` record, stores the binary data, generates a public `url`, and returns the `url`.

`delete (mediaId: String, user: User): ({} | {error: String})`
*   **requires** `MediaFile` exists and `uploader` matches `user`.
*   **effects** removes the `MediaFile` record and the associated binary data.

**queries**

`_getMediaByUser (user: User): (MediaFile)`
*   **effects** returns all media files uploaded by the user.