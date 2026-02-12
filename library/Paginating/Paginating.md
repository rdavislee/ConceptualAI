### Concept: Paginating [Bound, Item]

**purpose** Provide reusable page retrieval for dynamic item sets while allowing
per-list sorting modes.

**principle** Syncs maintain list membership/ranking state by writing directly
to a list identified by `(bound, itemType)`. Lists are created implicitly on
first write, and consumers ask for page N to receive item IDs in deterministic
order.

**state (SSF)**

```
a set of Lists with
  a bound Bound                 -- ID the list is bound to (e.g. post ID, user ID), or "common"
  an itemType String            -- what this list contains, e.g. "posts", "comments", "messages", "myPosts"
  a mode String ("createdAt" | "score")
  a pageSize Number
  a createdAt DateTime
  an updatedAt DateTime

a set of Entries with
  a bound Bound
  an itemType String
  an item ID
  a createdAt DateTime
  a score Number
  an updatedAt DateTime
```

**normalization/defaults**

- `bound` defaults to `"common"` when omitted or blank.
- Default list `mode` is `createdAt`.
- Default list `pageSize` is `20`.
- Lists are identified by `(bound, itemType)` and have no separate list ID.

**sorting rules**

- If mode is `createdAt`, entries sort by `createdAt` descending.
- If mode is `score`, entries sort by `score` descending.
- Tie-breaker for equal scores is `createdAt` descending.
- Final deterministic tie-breaker is item ID ascending.

**actions**

- **setMode (bound?: Bound, itemType: String, mode: String) : (ok: Flag)**
  requires: `itemType` is non-empty; `mode` is either `createdAt` or `score`
  effects: sets list sorting mode; creates list with default page size if
  missing

- **setPageSize (bound?: Bound, itemType: String, pageSize: Number) : (ok:
  Flag)** requires: `itemType` is non-empty; `pageSize` is a positive integer
  effects: sets list page size; creates list with default mode if missing

- **upsertEntry (bound?: Bound, itemType: String, item: itemID, createdAt:
  DateTime, score?: Number, pageSize?: Number, mode?: String) : (ok: Flag)**
  requires: `itemType` is non-empty; `createdAt` is valid; `score` is finite
  when provided; provided `pageSize`/`mode` values are valid effects: creates
  list for `(bound,itemType)` if missing (using defaults or provided
  `pageSize`/`mode`), then creates or updates entry for `(bound,itemType,item)`

- **setEntryScore (bound?: Bound, itemType: String, item: itemID, score: Number)
  : (ok: Flag)** requires: entry exists; `itemType` is non-empty; score is
  finite effects: updates ranking score for an entry

- **removeEntry (bound?: Bound, itemType: String, item: itemID) : (ok: Flag)**
  requires: entry exists; `itemType` is non-empty effects: removes one entry
  from a list

- **deleteList (bound?: Bound, itemType: String) : (ok: Flag)** requires: list
  exists; `itemType` is non-empty effects: deletes one list and all entries in
  that list

- **deleteByBound (bound?: Bound) : (ok: Flag)** requires: true effects: deletes
  all lists and entries for the normalized `bound`

- **deleteByItem (item: itemID) : (ok: Flag)** requires: true effects: removes
  item from every list

**queries**

`_getPage(bound?: Bound, itemType: String, page: Number) : (items: List<itemID>, mode: String, pageSize: Number, totalItems: Number, totalPages: Number, bound: Bound, itemType: String)`

`_getList(bound?: Bound, itemType: String) : (list: List | null)`

`_getListsByBound(bound?: Bound, itemType?: String) : (lists: List<{bound: Bound, itemType: String}>)`

`_hasEntry(bound?: Bound, itemType: String, item: itemID) : (hasEntry: Flag)`

**query behavior for unmade lists**

- `_getPage` must return an empty page (not an error) when `(bound,itemType)`
  has not been created yet:
  - `items: []`
  - `totalItems: 0`
  - `totalPages: 0`
  - default `mode` and `pageSize`
