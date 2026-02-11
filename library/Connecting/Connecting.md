**concept** Connecting [Requester, Responder]

**purpose**
Manage the lifecycle of bidirectional relationships that require manual approval (e.g., friending, connection requests).

**principle**
A requester asks to connect with a responder; the responder can accept (forming an active connection) or reject the request. Connections can be removed by either party.

**state**
  a set of Connections with
    a requester (Requester)
    a responder (Responder)
    a status String (e.g., "pending", "connected")
    a createdAt DateTime
    a updatedAt DateTime

**actions**

requestConnection (requester: Requester, responder: Responder) : (ok: Flag)
  **requires**
    requester != responder, no existing connection or pending request
  **effects**
    creates a connection record with status "pending"

acceptConnection (responder: Responder, requester: Requester) : (ok: Flag)
  **requires**
    pending connection request from requester to responder exists
  **effects**
    updates status to "connected"

rejectConnection (responder: Responder, requester: Requester) : (ok: Flag)
  **requires**
    pending connection request from requester to responder exists
  **effects**
    removes the connection record

removeConnection (partyA: Requester, partyB: Responder) : (ok: Flag)
  **requires**
    connection exists between partyA and partyB (in any direction)
  **effects**
    removes the connection record

**lifecycle cleanups**

deleteByRequester (requester: Requester) : (ok: Flag)
  **effects** removes all connections where the requester is the given user

deleteByResponder (responder: Responder) : (ok: Flag)
  **effects** removes all connections where the responder is the given user

**queries**

_isConnected (partyA: Requester, partyB: Responder) : (connected: Flag)
  **requires** true
  **effects** returns true if there is an active "connected" status between the parties

_getPendingRequests (responder: Responder) : (requesters: Set<Requester>)
  **requires** true
  **effects** returns all requesters who have sent a pending request to the responder

_getConnections (user: Requester) : (users: Set<Responder>)
  **requires** true
  **effects** returns all users connected to the given user
