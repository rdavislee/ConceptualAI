# concept: QuickCheckIns

**concept** QuickCheckIns [User, ExternalMetricID]

**purpose** To record simple, time-stamped, user-owned numeric self-reports against defined metrics.

**principle** If a user defines a metric such as "Energy", and then records a value like `8` at a given time, the concept stores that fact (owner, time, metric, value) for later retrieval and analysis.

**state**
```
a set of CheckIns with
  an owner User
  an at DateTime
  a metric ExternalMetricID
  a value Number

a set of InternalMetrics with
  an owner User
  a name String
```

**actions**

`record (owner: User, at: DateTime, metric: ExternalMetricID, value: Number): ({checkIn: CheckIn} | {error: String})`

- **requires** the InternalMetric identified by `metric` exists for `owner`
- **effects** creates a CheckIn and returns its ID as `checkIn`

`defineMetric (owner: User, name: String): ({metric: ExternalMetricID} | {error: String})`

- **requires** no InternalMetric with `name` exists for `owner`
- **effects** creates a new InternalMetric and returns its ID as `metric`

`edit (checkIn: CheckIn, owner: User, metric?: ExternalMetricID, value?: Number): ({} | {error: String})`

- **requires** `checkIn` exists and is owned by `owner`; if `metric` is provided, it exists for `owner`
- **effects** updates provided fields on the CheckIn

`delete (checkIn: CheckIn, owner: User): ({} | {error: String})`

- **requires** `checkIn` exists and is owned by `owner`
- **effects** deletes the CheckIn

`deleteByOwner (owner: User): (checkIns: Number, metrics: Number)`

- **effects** deletes all check-ins and internal metrics for `owner`

`deleteCheckInsByMetric (metric: ExternalMetricID): (deleted: Number)`

- **effects** deletes all check-ins that reference `metric`

`deleteMetric (requester: User, metric: ExternalMetricID): ({deleted: true} | {error: String})`

- **requires** `metric` exists, is owned by `requester`, and is not referenced by any CheckIn
- **effects** deletes the InternalMetric

**queries**

`_getCheckIn (checkIn: CheckIn): (CheckIn | null)`

- **effects** returns the matching CheckIn document or `null`

`_getMetricsByName (owner: User, name: String): (InternalMetric | null)`

- **effects** returns the matching InternalMetric document for `owner` or `null`

`_listCheckInsByOwner (owner: User): (List<CheckIn>)`

- **effects** returns all CheckIn documents for `owner`, ordered by `at` descending

`_listMetricsForOwner (owner: User): (List<InternalMetric>)`

- **effects** returns all InternalMetric documents for `owner`, ordered by `name` ascending
