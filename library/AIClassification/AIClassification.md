**concept** AIClassification [Owner, Item]

**purpose**
assign AI-generated labels or categories to items and persist the results for later filtering, review, and reuse

**principle**
if an app defines a classifier and submits an item's content to it, then the concept returns a classification result and stores the chosen label and status so the app can later retrieve or filter by that result

**state**
  a set of Classifiers with
    a classifierId ID
    an owner Owner
    a name String
    a labels Object
    an instructions? String

  a set of ClassificationResults with
    a classificationResultId ID
    a classifier Classifier
    an item Item
    a label String
    a status String

**actions**

createClassifier (owner: Owner, name: String, labels: Object, instructions?: String) : (classifierId: ID)
  **requires**
    name is not empty
    labels is not empty
  **effects**
    creates a new classifier

updateClassifier (classifier: Classifier, labels?: Object, instructions?: String) : (ok: Flag)
  **requires**
    classifier exists
  **effects**
    updates labels and/or instructions of classifier

classify (classifier: Classifier, item: Item, content: String) : (classificationResultId?: ID, label?: String, error?: String)
  **requires**
    classifier exists
    content is not empty
  **effects**
    if classification succeeds, creates a new classification result for item with label and status := "done"
    if classification fails, returns error and does not create a classification result

deleteClassificationResult (classificationResultId: ID) : (ok: Flag)
  **requires**
    there exists a classification result whose classificationResultId is classificationResultId
  **effects**
    deletes that classification result

deleteAllClassificationResultsForClassifier (classifier: Classifier) : (ok: Flag)
  **requires**
    classifier exists
  **effects**
    deletes all classification results associated with that classifier

deleteClassifier (classifierId: ID) : (ok: Flag)
  **requires**
    there exists a classifier whose classifierId is classifierId
  **effects**
    deletes that classifier and all classification results associated with it

deleteAllClassifiersForOwner (owner: Owner) : (ok: Flag)
  **requires** true
  **effects**
    deletes all classifiers whose owner is owner and all classification results associated with them

**queries**

_getLatestClassification (classifier: Classifier, item: Item) : (classificationResult: ClassificationResult)
  **requires** true
  **effects**
    returns the most recent classification result for item under classifier, if one exists

_getItemsByLabel (classifier: Classifier, label: String) : (classificationResults: set of ClassificationResult)
  **requires** true
  **effects**
    returns all classification results under classifier whose label is label

_listClassifiersForOwner (owner: Owner) : (classifierIds: set of ID)
  **requires** true
  **effects**
    returns the set of classifierIds for all classifiers owned by owner
