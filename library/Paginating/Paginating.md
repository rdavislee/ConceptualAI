### Concept: Paginating [Scope, Item]

**purpose**
Provide reusable page retrieval for dynamic item sets while allowing per-list sorting modes.

**principle**
Syncs maintain list membership/ranking state in this concept. Consumers ask for page N and receive item IDs in deterministic order.

**state (SSF)**

```
a set of Lists with
  a list ID
  a scopeType String            -- free-form label, e.g. "system", "user", "post", "group"
  a scopeID? ID                 -- required unless scopeType is "system"
  an itemType String            -- what this list contains, e.g. "posts", "comments", "messages"
  a mode String ("createdAt" | "score")
  a pageSize Number
  a createdAt DateTime
  an updatedAt DateTime

a set of Entries with
  a list ID
  an item ID
  a createdAt DateTime
  a score Number
  an updatedAt DateTime
```

**sorting rules**
- If mode is `createdAt`, entries sort by `createdAt` descending.
- If mode is `score`, entries sort by `score` descending.
- Tie-breaker for equal scores is `createdAt` descending.
- Final deterministic tie-breaker is item ID ascending.

**actions**

* **createList (scopeType: String, scopeID?: ID, itemType: String, pageSize: Number, mode?: String) : (list: listID)**
  requires: `scopeType` is a non-empty string; `scopeID` is omitted for `system` and required otherwise; `itemType` is non-empty; `pageSize` is a positive integer; `mode` is either `createdAt` or `score` (default `createdAt`)
  effects: creates a new list configuration

* **setMode (list: listID, mode: String) : (ok: Flag)**
  requires: list exists; mode is valid
  effects: updates sorting mode for future page retrieval

* **setPageSize (list: listID, pageSize: Number) : (ok: Flag)**
  requires: list exists; `pageSize` is a positive integer
  effects: updates page size

* **upsertEntry (list: listID, item: itemID, createdAt: DateTime, score?: Number) : (ok: Flag)**
  requires: list exists; `createdAt` is valid; `score` is finite when provided
  effects: creates or updates an entry for `(list,item)`

* **setEntryScore (list: listID, item: itemID, score: Number) : (ok: Flag)**
  requires: entry exists; score is finite
  effects: updates ranking score for an entry

* **removeEntry (list: listID, item: itemID) : (ok: Flag)**
  requires: entry exists
  effects: removes one entry from a list

* **deleteList (list: listID) : (ok: Flag)**
  requires: list exists
  effects: deletes list and all entries in that list

* **deleteByScope (scopeType: String, scopeID?: ID) : (ok: Flag)**
  requires: true
  effects: deletes all lists in that scope and all related entries

* **deleteByItem (item: itemID) : (ok: Flag)**
  requires: true
  effects: removes item from every list

**queries**

`_getPage(list: listID, page: Number) : (items: List<itemID>, mode: String, pageSize: Number, totalItems: Number, totalPages: Number, scopeType: String, scopeID?: ID, itemType: String)`

`_getList(list: listID) : (list: List | null)`

`_getListsByScope(scopeType: String, scopeID?: ID, itemType?: String) : (lists: Set<listID>)`

`_hasEntry(list: listID, item: itemID) : (hasEntry: Flag)`
