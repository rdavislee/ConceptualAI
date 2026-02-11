### Concept: DownloadAnalyzing [Item, User]

**purpose**
Record that a user downloaded an item, enabling analytics and rate/abuse insights (analysis via queries/consumers).

**principle**
When a download occurs it is recorded with time and identities; later, aggregates are computed via queries; records are append-only.

**state (SSF)**

```
a set of items with
  a set of Downloads with
    a userID
    a DateTime
```

**actions**

* **record (item: Item, user: userID, at: DateTime) : (ok: Flag)**
  requires: item is provided
  effects: create download record

* **deleteByItem (item: Item) : (ok: Flag)**
  requires: true
  effects: removes all download records for the item (lifecycle cleanup when item is deleted)

* **deleteByUser (user: User) : (ok: Flag)**
  requires: true
  effects: removes all download records by the user from all items (lifecycle cleanup when user is deleted)

**queries**
`_countForItem(item: Item) : (count: Number)`
---
