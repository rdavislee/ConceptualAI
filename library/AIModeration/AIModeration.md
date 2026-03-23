**concept** AIModeration [Owner, Item]

**purpose**
screen content or items against moderation policies and persist moderation decisions for review and enforcement

**principle**
if an app defines a moderation policy and submits an item's content, then the concept returns a moderation verdict and stores the result so the app can later review flagged items or enforce workflow rules

**state**
  a set of ModerationPolicies with
    a moderationPolicyId ID
    an owner Owner
    a name String
    a policyText String

  a set of ModerationResults with
    a moderationResultId ID
    a policy ModerationPolicy
    an item Item
    a verdict? Boolean
    a rationale? String
    a status String

**actions**

createPolicy (owner: Owner, name: String, policyText: String) : (moderationPolicyId: ID)
  **requires**
    name is not empty
    policyText is not empty
  **effects**
    creates a moderation policy

moderate (policy: ModerationPolicy, item: Item, content: Object) : (moderationResultId?: ID, verdict?: Boolean, error?: String)
  **requires**
    policy exists
    content is not empty
  **effects**
    if moderation succeeds, creates a moderation result for item with verdict, optional rationale, and status := "done"
    if moderation fails, returns error and does not create a moderation result

deleteModerationResult (moderationResultId: ID) : (ok: Flag)
  **requires**
    there exists a moderation result whose moderationResultId is moderationResultId
  **effects**
    deletes that moderation result

deleteAllModerationResultsForPolicy (policy: ModerationPolicy) : (ok: Flag)
  **requires**
    policy exists
  **effects**
    deletes all moderation results associated with that policy

deletePolicy (moderationPolicyId: ID) : (ok: Flag)
  **requires**
    there exists a moderation policy whose moderationPolicyId is moderationPolicyId
  **effects**
    deletes that moderation policy and all moderation results associated with it

deleteAllPoliciesForOwner (owner: Owner) : (ok: Flag)
  **requires** true
  **effects**
    deletes all moderation policies whose owner is owner and all moderation results associated with them

**queries**

_getLatestModeration (policy: ModerationPolicy, item: Item) : (moderationResult: ModerationResult)
  **requires** true
  **effects**
    returns the most recent moderation result for item under policy, if one exists

_getFlaggedItems (policy: ModerationPolicy) : (moderationResults: set of ModerationResult)
  **requires** true
  **effects**
    returns all moderation results under policy whose verdict indicates non-passing or flagged content

_listPoliciesForOwner (owner: Owner) : (moderationPolicyIds: set of ID)
  **requires** true
  **effects**
    returns the set of moderationPolicyIds for all moderation policies owned by owner
