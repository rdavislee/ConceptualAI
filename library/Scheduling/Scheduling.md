**concept** Scheduling [Resource, Client]

**purpose**
Manage the availability of resources and allow clients to reserve exclusive time slots within that availability.

**principle**
A resource (e.g., a dentist) defines blocks of time when they are available. Clients can book appointments during these times. The system ensures that a new booking is only valid if it falls within an available block and does not overlap with any existing booking.

**state**
  a set of AvailabilityBlocks with
    an id
    a resource Resource
    a start DateTime
    an end DateTime

  a set of Appointments with
    an id
    a resource Resource
    a client Client
    a start DateTime
    an end DateTime
    a status String (e.g., "booked", "cancelled")
    a createdAt DateTime
    an updatedAt DateTime

**actions**

addAvailability (resource: Resource, start: DateTime, end: DateTime) : (blockId: ID)
  **requires**
    start is before end
  **effects**
    creates a new AvailabilityBlock for the resource

removeAvailability (blockId: ID) : (ok: Flag)
  **requires**
    blockId exists
  **effects**
    removes the AvailabilityBlock

updateAvailability (blockId: ID, start: DateTime, end: DateTime) : (ok: Flag)
  **requires**
    blockId exists, start is before end
  **effects**
    updates the start and end times of the AvailabilityBlock

book (resource: Resource, client: Client, start: DateTime, end: DateTime) : (appointmentId: ID)
  **requires**
    start is before end
    there exists an AvailabilityBlock b for this resource such that b.start <= start and b.end >= end
    there is NO existing Appointment a for this resource where a.status == "booked" AND a overlaps with [start, end]
  **effects**
    creates a new Appointment with status "booked"

cancel (appointmentId: ID) : (ok: Flag)
  **requires**
    appointmentId exists and status is "booked"
  **effects**
    sets status to "cancelled"

reschedule (appointmentId: ID, newStart: DateTime, newEnd: DateTime) : (ok: Flag)
  **requires**
    appointmentId exists and status is "booked"
    the appointment's resource is available during [newStart, newEnd]
    no other conflicting appointments exist in [newStart, newEnd] (excluding the appointment being rescheduled)
  **effects**
    updates the start and end of the appointment

**queries**

_getAvailability (resource: Resource, start: DateTime, end: DateTime) : (blocks: Set<AvailabilityBlock>)
  **requires** true
  **effects** returns availability blocks for the resource that overlap with the requested window

_getAppointments (resource: Resource, start: DateTime, end: DateTime) : (appointments: Set<Appointment>)
  **requires** true
  **effects** returns appointments for the resource that overlap with the requested window

_getClientAppointments (client: Client) : (appointments: Set<Appointment>)
  **requires** true
  **effects** returns all appointments for the client (booked and cancelled)

_getAppointment (appointmentId: ID) : (appointment: Appointment?)
  **requires** true
  **effects** returns the appointment details if it exists
