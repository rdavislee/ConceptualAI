**concept** Expiring [Item]

**purpose**
Manage the limited availability of items over time.

**principle**
If an item is set to expire at a certain time, then it remains accessible until that time; after the expiration time has passed, the item is considered expired and any queries or actions checking for availability will fail.

**state**
  a set of Expirations with
    a item (Item)
    a expiresAt DateTime

**actions**

setExpiry (item: Item, expiresAt: DateTime) : (ok: Flag)
  **requires**
    expiresAt is in the future
  **effects**
    associate the item with the given expiration time (replaces any existing expiry)

cancelExpiry (item: Item) : (ok: Flag)
  **requires**
    item has an active (future) expiry set
  **effects**
    remove the expiration association for the item

deleteByItem (item: Item) : (ok: Flag)
  **requires** true
  **effects** removes the expiration record for the item (lifecycle cleanup when item is deleted)

**queries**

_isExpired (item: Item) : (expired: Flag)
  **requires** true
  **effects** returns true if the current time is past the item's expiresAt time, or if no expiry was ever set (if that's the desired default, though typically we return false if no expiry is set). Let's say: returns true if current time > expiresAt, false otherwise.

_getExpiredItems () : (items: Set<Item>)
  **requires** true
  **effects** returns all items whose expiresAt time is in the past

_getRemainingTime (item: Item) : (remainingMs: Number)
  **requires** true
  **effects** returns the number of milliseconds remaining until the item expires, or 0 if it has already expired or no expiry is set.
