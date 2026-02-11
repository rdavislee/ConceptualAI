**concept** Storying [Author]

**purpose**
Broadcast ephemeral content to a group of viewers and track engagement.

**principle**
An author posts a story which remains visible for a set duration. Viewers can see the story, and the system records these views. When the duration expires, the story is removed.

**state**

```
a set of Stories with
  a story ID
  an author Author
  a content Object    -- must be a JSON object (not a string/array/null)
  a postedAt DateTime
  an expiresAt DateTime

a set of Views with
  a story Story
  a viewer Author
  a viewedAt DateTime
```

**content format**
The `content` field must be a JSON object with at least one property. Raw strings are not accepted.

Examples:
- Image story: `{ imageUrl: "https://...", caption: "Sunset" }`
- Text story: `{ text: "Hello world!" }`
- Video story: `{ videoUrl: "https://...", thumbnail: "https://..." }`

**actions**

post (author: Author, content: Object, durationSeconds: Number) : (story: Story)
  **requires**
    content is a non-empty object with at least one defined value; durationSeconds > 0
  **effects**
    creates a Story with postedAt := now, expiresAt := now + durationSeconds

recordView (story: Story, viewer: Author) : (ok: Flag)
  **requires**
    story exists, viewer != story.author, viewer has not already viewed story
  **effects**
    creates a View record with viewedAt := now

expire (story: Story) : (ok: Flag)
  **requires**
    story exists
  **effects**
    deletes the story and all associated views

**queries**

_getActiveStories (authors: Set<Author>) : (stories: Set<Story>)
  **requires** true
  **effects** returns stories where author is in authors and expiresAt > now

_getViews (story: Story) : (views: Set<View>)
  **requires** true
  **effects** returns all view records for the given story
