**concept** Events [Owner]

**purpose**
Manage a personal timeline of scheduled activities.

**principle**
If a user schedules an event for a specific time interval, that block of time is recorded and can be visualized on their timeline; if the plans change, the user can move (reschedule) or remove the event. Overlapping events are allowed.

**state**
  a set of Events with
    an id (ID)
    an owner (Owner)
    a title String
    a description String
    a startTime DateTime
    a endTime DateTime

**actions**

createEvent (owner: Owner, title: String, startTime: DateTime, endTime: DateTime, description: String) : (eventId: ID)
  **requires**
    endTime is after startTime
  **effects**
    creates a new event with the specified details

updateEvent (eventId: ID, owner?: Owner, title?: String, startTime?: DateTime, endTime?: DateTime, description?: String) : (ok: Flag)
  **requires**
    the event exists; if owner provided, actor must own the event. If both startTime and endTime are updated, the new end must be after the new start.
  **effects**
    updates the properties of the event

deleteEvent (eventId: ID, owner?: Owner) : (ok: Flag)
  **requires**
    the event exists; if owner provided, actor must own the event
  **effects**
    removes the event from the state

deleteByOwner (owner: Owner) : (ok: Flag)
  **requires** true
  **effects** removes all events for the owner (lifecycle cleanup when owner account is deleted)

**queries**

_getEvents (owner: Owner, from: DateTime, to: DateTime) : (events: Set<Event>)
  **requires** true
  **effects** returns all events for the owner that overlap with the specified date range [from, to]
