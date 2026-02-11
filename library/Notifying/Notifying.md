**concept** Notifying [User, Item]

**purpose**
Alert a user to events of interest and track whether they have been acknowledged.

**principle**
If an event occurs and a notification is created for a user, then the user identifies the event via the notification; once the user views or interacts with the notification, its status is updated to reflect that it has been seen or read.

**state**
  a set of Notifications with
    a notification ID
    a recipient (User)
    a trigger (Item) -- The ID of the external item that caused the notification
    a content Object -- Generic payload (e.g., { "body": "...", "icon": "..." })
    a status (String: "unseen" | "seen" | "read")
    a type? String -- e.g., "like", "mention", "system"
    a metadata? Object -- Any additional arbitrary data
    a createdAt DateTime
    a seenAt? DateTime
    a readAt? DateTime

**actions**

notify (recipient: User, trigger: Item, content: Object, type?: String, metadata?: Object) : (notificationId: Notification)
  **requires**
    content is not empty
  **effects**
    create notification with status := "unseen", createdAt := now

markAsSeen (notificationId: Notification, recipient: User) : (ok: Flag)
  **requires**
    notification exists, recipient is the intended recipient
  **effects**
    set status := "seen", seenAt := now (if not already seen)

markAsRead (notificationId: Notification, recipient: User) : (ok: Flag)
  **requires**
    notification exists, recipient is the intended recipient
  **effects**
    set status := "read", readAt := now (if not already read), also set seenAt if needed

deleteNotification (notificationId: Notification, recipient: User) : (ok: Flag)
  **requires**
    notification exists, recipient is the intended recipient
  **effects**
    delete the notification

deleteByRecipient (recipient: User) : (ok: Flag)
  **requires** true
  **effects** remove all notifications for recipient (for account deletion)

deleteByTrigger (trigger: Item) : (ok: Flag)
  **requires** true
  **effects** remove all notifications triggered by item (for item deletion)

**queries**

_getNotificationsForUser (user: User, status?: String) : (notifications: Set<Notification>)
  **requires** true
  **effects** returns all notifications for the user, optionally filtered by status, latest first

_getUnreadCount (user: User) : (count: Number)
  **requires** true
  **effects** returns the count of notifications with status "unseen" or "seen" (not yet read)

_allNotifications () : (notifications: Set<Notification>)
  **requires** true
  **effects** returns all notifications in the system, latest first
