# API Specification: Concept Server Infrastructure

**Purpose:** Provides high-level endpoints for discovery, meta-documentation, and bulk access to software concepts stored in the registry. These endpoints are designed for both human developers and automated agents to efficiently interact with the concept library.

---

## API Endpoints

### GET /api/catalog

**Description:** Lists all available concepts currently registered in the hub.

**Request Body:**
None.

**Success Response Body:**
```json
{
"concepts": [
{
"name": "string",
"id": "string",
"author": "string"
}
]
}
```

**Status Codes:**
- `200 OK`: Success. Returns a list of concept metadata.
- `500 Internal Server Error`: Database connection failure.

---

### GET /api/specs

**Description:** Returns a concatenated stream of all concept specifications (markdown files) for providing bulk context to LLMs.

**Request Body:**
None.

**Success Response Body:**
(Content-Type: `text/plain`)
```text
--- CONCEPT: ConceptName ---
# Concept: ConceptName ...

--- CONCEPT: AnotherConcept ---
# Concept: AnotherConcept ...
```

**Status Codes:**
- `200 OK`: Success. Returns the concatenated markdown specs.
- `500 Internal Server Error`: Database connection failure.

---

### GET /api/concepts/{name}/spec

**Description:** Retrieves the markdown specification for a specific concept by its unique name.

**Path Parameters:**
- `name`: The unique name of the concept (e.g., `Liking`).

**Request Body:**
None.

**Success Response Body:**
(Content-Type: `text/plain`)
```markdown
# Concept: {name}
...
```

**Status Codes:**
- `200 OK`: Success. Returns the markdown spec.
- `400 Bad Request`: Concept name missing in path.
- `404 Not Found`: Concept not found, or no versions/spec file available.
- `500 Internal Server Error`: Database connection failure.

---

### GET | POST /api/pull/{name}

**Description:** Downloads all core files for a concept, including its implementation class, tests, and specification.

**Path Parameters:**
- `name`: The unique name of the concept.

**Request Body:**
None (empty object `{}` for POST).

**Success Response Body:**
```json
{
"code": "string",
"tests": "string",
"spec": "string"
}
```

**Status Codes:**
- `200 OK`: Success. Returns an object mapping file types to their content strings.
- `400 Bad Request`: Concept name missing in path.
- `404 Not Found`: Concept not registered, version not found, or files failed to download.
- `500 Internal Server Error`: Database connection failure.

---

## Dynamic Routing (Actions & Queries)

In addition to these infrastructure endpoints, the Concept Server dynamically exposes actions and queries for each loaded concept.

**Endpoint Format:** `POST /api/{ConceptName}/{ActionOrQueryName}`

See [API_SPECIFICATION.md](brainstorming/API_SPECIFICATION.md) for detailed documentation of these concept-specific endpoints.
