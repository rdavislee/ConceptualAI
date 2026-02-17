### Concept: Posting [Author, Post]

**purpose**
Allows authors to create and manage standalone blocks of content (posts).

**principle**
A post is created by exactly one author; the author can edit or delete their own posts.

**state (SSF)**

```
a set of Posts with
  a post ID
  an author ID
  a content Object    -- must be a JSON object (not a string/array/null)
  a type? String
  a metadata? Object
  a createdAt DateTime
  an updatedAt DateTime
```

**content format**
The `content` field must be a JSON object with at least one property. Raw strings are not accepted.

Examples:
- Blog post: `{ title: "My Post", body: "Hello world..." }`
- Note: `{ text: "Remember to buy milk" }`
- Media post: `{ caption: "Sunset", mediaUrl: "https://..." }`

**actions**

* **createPost (author: authorID, content: Object, type?: String, metadata?: Object) : (post: postID)**
  requires: content is a non-empty object with at least one defined value
  effects: create post with createdAt := now, updatedAt := now
* **editPost (post: postID, author: authorID, content: Object, type?: String, metadata?: Object) : (ok: Flag)**
  requires: post exists, author of post is authorID, content is a non-empty object
  effects: update post and updatedAt := now
* **deletePost (post: postID, author: authorID) : (ok: Flag)**
  requires: post exists, author of post is authorID
  effects: delete the post

* **deleteByAuthor (author: authorID) : (ok: Flag)**
  requires: true
  effects: remove all posts by author (for account deletion)

**queries**
`_getPostsByAuthor(author: authorID, limit?: Number, skip?: Number) : (posts: Set<Post>)`
`_getPostsByType(type: String, limit?: Number, skip?: Number) : (posts: Set<Post>)`
`_getPost(post: postID) : (post: Post)`
`_allPosts(limit?: Number, skip?: Number) : (posts: Set<Post>)`

---
