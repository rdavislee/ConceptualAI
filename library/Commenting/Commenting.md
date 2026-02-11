### Concept: Commenting [Item, Author]

**purpose**
Allows users to express thoughts, feedback, or discourse on specific items.

**principle**
A user can post multiple comments on an item; comments can be edited or deleted by the author.

**state (SSF)**

```
a set of Comments with
  a comment ID
  an item ID
  an author ID
  a content String
  a createdAt DateTime
  an updatedAt DateTime
```

**actions**

* **postComment (item: itemID, author: authorID, content: String) : (comment: commentID)**
  requires: content is not empty
  effects: create comment with createdAt := now, updatedAt := now
* **editComment (comment: commentID, author: authorID, newContent: String) : (ok: Flag)**
  requires: comment exists, author of comment is authorID, newContent is not empty
  effects: update content and updatedAt := now
* **deleteComment (comment: commentID, author: authorID) : (ok: Flag)**
  requires: comment exists, author of comment is authorID
  effects: delete the comment

**lifecycle cleanups**

deleteByAuthor (author: Author) : (ok: Flag)
  **effects** removes all comments by the author (e.g. when author account is deleted)

deleteByItem (item: Item) : (ok: Flag)
  **effects** removes all comments on the item (e.g. when item is deleted)

**queries**
`_getComments(item: itemID) : (comments: Set<Comment>)`
`_getCommentCount(item: itemID) : (n: Number)`
`_getComment(comment: commentID) : (comment: Comment)`

---
