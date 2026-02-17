### Concept: Liking [Item, User]

**purpose**
Let users express a binary preference for items, preventing duplicates and enabling reversals.

**principle**
A user can like an item once; unlike removes the relation.

**state (SSF)**

```
a set of Items with
  an item ID
  a set of Likes with
   a user ID
   a DateTime

a set of Users with
  a user ID
  a set of Likes with
    an item ID
    a DateTime
```

**actions**

* **like (item: itemID, user: userID) : (ok: Flag)**
  requires: no like exists for (item,user)
  effects: create like with at := now and adds like to both sets
* **unlike (item: itemID, user: userID) : (ok: Flag)**
  requires: like exists for (item,user)
  effects: delete that like from both sets

* **deleteByUser (user: userID) : (ok: Flag)**
  requires: true
  effects: remove all likes by user from both items and users sets (for account deletion)

* **deleteByItem (item: itemID) : (ok: Flag)**
  requires: true
  effects: remove all likes for item from both items and users sets (for item deletion)

**queries**
`_isLiked(item: itemID, user: userID) : (liked: Flag)`
`_countForItem(item: itemID) : (n: Number)`
`_likedItems(user: userID) : (items: Set<itemID>)`

---
