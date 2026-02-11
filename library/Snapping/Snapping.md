**concept** Snapping [User, Media]

**purpose**
Enables users to exchange ephemeral media messages that are deleted after viewing.

**principle**
A user sends a 'snap' to another user; the recipient receives it in a 'delivered' state. Once the recipient opens the snap, its status changes to 'opened', and it is subsequently deleted by the system.

**state**
  a set of Snaps with
    a snap ID
    a sender User
    a recipient User
    a media Media
    a status String (one of 'sent', 'delivered', 'opened')
    a sentAt DateTime
    a deliveredAt? DateTime
    an openedAt? DateTime

**actions**

send (sender: User, recipient: User, media: Media) : (snap: Snap)
  **requires**
    sender != recipient
  **effects**
    creates a new Snap with status 'sent', sentAt := now

markDelivered (snap: Snap) : (ok: Flag)
  **requires**
    snap exists, status is 'sent'
  **effects**
    status := 'delivered', deliveredAt := now

open (snap: Snap, recipient: User) : (ok: Flag)
  **requires**
    snap exists, snap.recipient is recipient, status is 'delivered' or 'sent'
  **effects**
    status := 'opened', openedAt := now

delete (snap: Snap) : (ok: Flag)
  **requires**
    snap exists
  **effects**
    removes the snap from state

**queries**

_getSnapsForUser (user: User) : (snaps: Set<Snap>)
  **requires** true
  **effects** returns snaps where recipient is user and status is not 'opened'

_getSentSnaps (user: User) : (snaps: Set<Snap>)
  **requires** true
  **effects** returns snaps where sender is user

_getSnapsBetweenUsers (userA: User, userB: User) : (snaps: Set<Snap>)
  **requires** true
  **effects** returns snaps exchanged between the two users
