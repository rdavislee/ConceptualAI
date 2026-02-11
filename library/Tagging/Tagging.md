### Concept: Tagging [Item, Owner]

**purpose**
Allows items to be categorized or labeled with keywords (tags) for easier discovery and organization. Tags can be global (shared) or user-specific (owned).

**principle**
An item can have multiple tags; the same tag can be applied to many items. Tags can optionally have an owner, making them private to that user.

**state (SSF)**

```
a set of Tags with
  a tag ID
  a name (String)
  an owner? Owner
  a set of Items with
    an item ID

a set of Items with
  an item ID
  a set of Tags with
    a tag ID
```

**actions**

* **addTag (item: itemID, tag: String, owner?: Owner) : (ok: Flag)**
  requires: tag is not empty, item doesn't already have this tag
  effects: creates tag if it doesn't exist (with optional owner), adds tag to item's set and item to tag's set

* **removeTag (item: itemID, tag: String, owner?: Owner) : (ok: Flag)**
  requires: item has this tag, if owner provided then tag must belong to owner
  effects: removes tag from item's set and item from tag's set

* **removeAllTags (item: itemID) : (ok: Flag)**
  requires: true
  effects: removes all tag assignments for the item

**queries**

`_getTags(item: itemID) : (tags: Set<{name: String, owner?: Owner}>)`
`_getItemsWithTag(tag: String, owner?: Owner) : (items: Set<itemID>)`
`_getTagsByOwner(owner: Owner) : (tags: Set<{name: String, id: ID}>)`

---
