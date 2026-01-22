**concept** Notifying [User]

**purpose**
To alert users of relevant events or interactions asynchronously.

**principle**
When an event occurs (e.g., a like or a message), a notification is created for the recipient. The recipient can view their list of notifications and mark them as read or dismiss them.

**state**
```
a set of Notifications with
  an id
  a recipient User
  a title String
  a body String
  a deepLink String
  a isRead Boolean
  a createdAt DateTime
```

**actions**

`notify (recipient: User, title: String, body: String, deepLink?: String): ({notificationId: String})`
*   **requires** recipient exists.
*   **effects** creates a new `Notification` with `isRead` set to false and `createdAt` set to now.

`markAsRead (notificationId: String, user: User): ({} | {error: String})`
*   **requires** notification exists and belongs to `user`.
*   **effects** sets `isRead` to true.

`delete (notificationId: String, user: User): ({} | {error: String})`
*   **requires** notification exists and belongs to `user`.
*   **effects** deletes the notification.

**queries**

`_getUnread (user: User): (Notification)`
*   **effects** returns all notifications for the user where `isRead` is false, sorted by `createdAt` descending.

`_getAll (user: User): (Notification)`
*   **effects** returns all notifications for the user, sorted by `createdAt` descending.