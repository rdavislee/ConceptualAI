### Concept: Paginating [Bound, Item]

**purpose** Provide reusable page retrieval for dynamic item sets while allowing
per-list sorting modes without mutable list-mode state.

**principle** Syncs maintain list membership/ranking state by writing directly
to a list identified by `(bound, itemType, mode)`. Lists are created implicitly
on first write, and consumers ask for page N (with mode) to receive item IDs in
deterministic order.

**state (SSF)**

```
a set of Lists with
  a bound Bound                 -- ID the list is bound to (e.g. post ID, user ID), or "common"
  an itemType String            -- what this list contains, e.g. "posts", "comments", "messages", "myPosts"
  a mode String ("createdAt" | "score")
  a createdAt DateTime
  an updatedAt DateTime

a set of Entries with
  a bound Bound
  an itemType String
  a mode String ("createdAt" | "score")
  an item ID
  a createdAt DateTime
  a score Number
  an updatedAt DateTime
```

**normalization/defaults**

- `bound` defaults to `"common"` when omitted or blank.
- Default request `pageSize` for `_getPage` is `20`.
- Lists are identified by `(bound, itemType, mode)` and have no separate list
  ID.

**sorting rules**

- If mode is `createdAt`, entries sort by `createdAt` descending.
- If mode is `score`, entries sort by `score` descending.
- Tie-breaker for equal scores is `createdAt` descending.
- Final deterministic tie-breaker is item ID ascending.

**actions**

- **upsertEntry (bound?: Bound, itemType: String, item: itemID, createdAt:
  DateTime, score?: Number, mode: String) : (ok: Flag)**
  requires: `itemType` is non-empty; `createdAt` is valid; `score` is finite
  when provided; `mode` is either `createdAt` or `score`
  effects: creates list for `(bound,itemType,mode)` if missing, then creates
  or updates entry for `(bound,itemType,mode,item)`

- **setEntryScore (bound?: Bound, itemType: String, mode: String, item: itemID,
  score: Number) : (ok: Flag)** requires: entry exists for the specified mode;
  `itemType` is non-empty; `mode` is valid; score is finite effects: updates
  ranking score for one mode-specific entry

- **removeEntry (bound?: Bound, itemType: String, mode: String, item: itemID) :
  (ok: Flag)** requires: entry exists for the specified mode; `itemType` is
  non-empty; `mode` is valid effects: removes one entry from one mode-specific
  list

- **deleteList (bound?: Bound, itemType: String, mode: String) : (ok: Flag)**
  requires: list exists; `itemType` is non-empty; `mode` is valid effects:
  deletes one mode-specific list and all entries in that list

- **deleteByBound (bound?: Bound) : (ok: Flag)** requires: true effects: deletes
  all lists and entries for the normalized `bound` across all modes

- **deleteByItem (item: itemID) : (ok: Flag)** requires: true effects: removes
  item from every list in every mode

**queries**

`_getPage(bound?: Bound, itemType: String, mode: String, page: Number, pageSize?: Number) : (items: List<itemID>, mode: String, pageSize: Number, totalItems: Number, totalPages: Number, bound: Bound, itemType: String)`

`_getList(bound?: Bound, itemType: String, mode: String) : (list: List | null)`

`_getListsByBound(bound?: Bound, itemType?: String, mode?: String) : (lists: List<{bound: Bound, itemType: String, mode: String}>)`

`_hasEntry(bound?: Bound, itemType: String, mode: String, item: itemID) : (hasEntry: Flag)`

**query behavior for unmade lists**

- `_getPage` must return an empty page (not an error) when
  `(bound,itemType,mode)` has not been created yet:
  - `items: []`
  - `totalItems: 0`
  - `totalPages: 0`
  - requested `mode` and requested/default `pageSize`
