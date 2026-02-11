**concept** Setting [Namespace]

**purpose**
Store and retrieve singleton configuration data for various namespaces (e.g., establishment info, app settings).

**principle**
A setting is a single data object associated with a unique namespace. When the data for a namespace is set, it overwrites any previous data for that namespace, ensuring a single source of truth.

**state**
  a set of Settings with
    a namespace (Namespace)
    a data Object
    an updatedAt DateTime

**actions**

setSetting (namespace: Namespace, data: Object) : (ok: Flag)
  **requires**
    data is a non-empty object
  **effects**
    creates or updates the setting for the namespace with the provided data, and sets updatedAt to now

**queries**

_getSetting (namespace: Namespace) : (data: Object | null)
  **requires** true
  **effects** returns the data object for the namespace, or null if none exists
