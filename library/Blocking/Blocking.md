**concept** Blocking [User]

**purpose**
Prevent all interactions and visibility between two specific users.

**principle**
If a user blocks another user, then all mutual interactions are inhibited; if the block is later removed, the users can once again see and interact with each other's content.

**state**
  a set of Blocks with
    a blocker (User)
    a blocked (User)
    a createdAt DateTime

**actions**

block (blocker: User, blocked: User) : (ok: Flag)
  **requires**
    blocker is not blocked, blocker != blocked
  **effects**
    create a block from blocker to blocked

unblock (blocker: User, blocked: User) : (ok: Flag)
  **requires**
    a block exists from blocker to blocked
  **effects**
    remove the block

**lifecycle cleanups**

deleteByBlocker (blocker: User) : (ok: Flag)
  **effects** removes all blocks where the blocker is the given user

deleteByBlocked (blocked: User) : (ok: Flag)
  **effects** removes all blocks where the blocked is the given user

**queries**

_isBlocked (userA: User, userB: User) : (blocked: Flag)
  **requires** true
  **effects** returns true if userA has blocked userB OR userB has blocked userA

_getBlockedUsers (blocker: User) : (users: Set<User>)
  **requires** true
  **effects** returns all users that the given blocker has blocked
