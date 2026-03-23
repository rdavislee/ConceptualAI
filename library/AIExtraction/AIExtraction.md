**concept** AIExtraction [Owner]

**purpose**
extract structured information from unstructured content using reusable schemas and persistent extractor state

**principle**
if an app defines an extraction schema and submits some text content, then the concept returns structured data matching that schema and stores the latest input, output, status, and error on the extractor

**state**
  a set of Extractors with
    an extractorId ID
    an owner Owner
    a name String
    a schema Object
    an instructions? String
    a status String
    an input String
    an outputJson? Object
    an error? String

**actions**

createExtractor (owner: Owner, name: String, schema: Object, instructions?: String) : (extractorId: ID)
  **requires**
    name is not empty
    schema is not empty
  **effects**
    creates a new extractor

extract (extractor: Extractor, content: String) : (outputJson?: Object, error?: String)
  **requires**
    extractor exists
    content is not empty
  **effects**
    sets status of extractor := "thinking"
    sets input of extractor := content
    if extraction succeeds, stores status := "done" and outputJson
    if extraction fails, stores status := "done" and error

deleteExtractor (extractorId: ID) : (ok: Flag)
  **requires**
    there exists an extractor whose extractorId is extractorId
  **effects**
    deletes that extractor

deleteAllExtractorsForOwner (owner: Owner) : (ok: Flag)
  **requires** true
  **effects**
    deletes all extractors whose owner is owner

**queries**

_getExtractor (extractorId: ID) : (extractor: Extractor)
  **requires**
    there exists an extractor whose extractorId is extractorId
  **effects**
    returns that extractor

_listExtractorsForOwner (owner: Owner) : (extractorIds: set of ID)
  **requires** true
  **effects**
    returns the set of extractorIds for all extractors owned by owner
