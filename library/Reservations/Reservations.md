**concept** Reservations [BookingID, CustomerID]

**purpose**
Manage the limited seating capacity of the restaurant to prevent overbooking.

**principle**
The restaurant defines a maximum capacity (e.g., seats or tables) for specific time slots. When a customer requests a booking for a specific party size at a specific time, the system checks if the total already-booked capacity plus the new party size exceeds the limit. If not, the booking is confirmed.

**state**
  a set of Capacities with
    a timeSlot DateTime
    a maxCapacity Number

  a set of Bookings with
    an id BookingID
    a customer CustomerID
    a timeSlot DateTime
    a partySize Number
    a details Object
    a status String ("confirmed", "cancelled")
    a createdAt DateTime

**actions**

setCapacity (timeSlot: DateTime, maxCapacity: Number) : (ok: Flag)
  **requires**
    maxCapacity > 0
  **effects**
    creates or updates the capacity limit for that slot

book (customer: CustomerID, timeSlot: DateTime, partySize: Number, details: Object) : (bookingId: BookingID)
  **requires**
    partySize > 0
    let currentLoad = sum(partySize of bookings where timeSlot == timeSlot and status == "confirmed")
    let limit = Capacities[timeSlot].maxCapacity (default to 0 if not set)
    currentLoad + partySize <= limit
  **effects**
    creates a new Booking with status "confirmed"

cancel (bookingId: BookingID) : (ok: Flag)
  **requires**
    booking exists
  **effects**
    sets booking status to "cancelled"

**queries**

_getAvailability (date: DateTime, partySize: Number) : (slots: Set<DateTime>)
  **requires** true
  **effects** returns a list of timeSlots on the given date where (currentLoad + partySize <= maxCapacity)

_getBookings (date: DateTime) : (bookings: Set<Booking>)
  **requires** true
  **effects** returns all bookings for the specified date

_getBooking (bookingId: BookingID) : (booking: Booking?)
  **requires** true
  **effects** returns the booking details if it exists

_getCustomerBookings (customer: CustomerID) : (bookings: Set<Booking>)
  **requires** true
  **effects** returns all bookings for the customer
