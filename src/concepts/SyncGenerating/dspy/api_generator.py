import dspy
import json
import sys
import time
from contextlib import nullcontext
from typing import List, Dict, Any, Optional
from pydantic import BaseModel, Field


def _retry_on_truncation(callable_fn, is_valid_fn, max_attempts: int = 3, label: str = "LM call"):
    """Retry when output is invalid/truncated (e.g. JSON parse fails, empty). No token/setting changes."""
    result = None
    for attempt in range(max_attempts):
        result = callable_fn()
        if is_valid_fn(result):
            return result
        if attempt < max_attempts - 1:
            print(f"[ApiGen] {label} produced invalid/truncated output (attempt {attempt + 1}/{max_attempts}), retrying...", file=sys.stderr)
            time.sleep(2)
    return result  # last attempt - return whatever we got


class EndpointInfo(BaseModel):
    method: str
    path: str
    summary: str
    description: str


class EndpointsList(BaseModel):
    endpoints: List[EndpointInfo]


class AnalyzeUserFlows(dspy.Signature):
    """Deeply analyze the application plan to identify ALL user flows and their API requirements.
    
    Think step-by-step about every user interaction from start to finish.
    Consider what state changes occur, what data needs to be fetched, and what side effects must happen.
    
    For EACH user flow, reason about:
    1. What is the user trying to accomplish?
    2. What data do they need to provide?
    3. What data do they need to receive back? (Consider what the concept queries actually return)
    4. What concepts are involved in this flow?
    5. What actions must occur on those concepts?
    6. What side effects or related operations should happen automatically?
       (e.g., when a user registers, should a profile be created? When a post is deleted, should its comments be deleted?)
    7. What error conditions could occur and how should they be handled?
    8. What authentication/authorization is required?
    9. What user-entered fields require strict validation constraints? (ratings, scores, quantities, percentages, lengths, enums)
    10. What are the exact allowed ranges/sets/formats for those fields?
    
    CRITICAL - UNDERSTAND ENDPOINT vs CONCEPT RELATIONSHIP:
    
    SINGLE ENDPOINT can orchestrate MULTIPLE CONCEPTS:
    - Example: A delete endpoint might clean up related data across multiple concepts.
    - Example: A registration endpoint might create the user AND start a session.
    
    MULTI-STEP FLOWS require SEPARATE API CALLS (frontend orchestration):
    - If the plan requires setup after registration (e.g., creating a profile, setting preferences), those are SEPARATE endpoints the frontend must call in sequence.
    - Document these sequences explicitly so the graph generator knows.
    
    IDENTIFY NON-OBVIOUS BEHAVIORS TO DOCUMENT:
    - Data visibility rules: Who can see what? Are there filtering rules based on relationships?
    - Setup steps: Are there resources that must be created as part of onboarding?
    - Data completeness: If a resource references another entity (e.g., author of a post), how does the frontend resolve it?
      - SOLUTION: Either embed the referenced data in the response OR provide a lookup endpoint.
    
    IDENTIFY DATA DEPENDENCIES:
    - What data does each entity reference? (e.g., items reference creators, replies reference parent items)
    - How can the frontend resolve these references? (embedded data or lookup endpoints)
    - What aggregations are needed? (counts, totals, computed fields)

    IDENTIFY INPUT CONSTRAINTS AS FIRST-CLASS CONTRACTS:
    - Explicitly call out fields that must be bounded (e.g., rating scales like 0-5).
    - Distinguish unbounded fields from bounded ones; never leave ambiguous rating/score semantics.
    - These constraints must later appear in OpenAPI schemas and app graph edge contracts.
    
    MANDATE - FULL DATA LIFECYCLE ANALYSIS:
    For EVERY entity (Profile, Post, Comment, Message, etc.) enumerate ALL lifecycle flows:
    - CREATION: What creates it? What page/form?
    - VIEWING: List view? Detail view?
    - EDITING: Can the owner modify it? What fields? What page? Even if the plan doesn't mention editing.
    - DELETION: Can it be removed? What happens after? (redirect, cascade delete?)
    - REVERSALS: For every action, its inverse (Follow→Unfollow, Like→Unlike, Join→Leave).
    Do NOT skip flows just because the plan omits them. If something is created, it can be edited and deleted.
    """
    
    plan: str = dspy.InputField(desc="The application plan describing user stories, features, and requirements.")
    concept_specs: str = dspy.InputField(desc="Specifications of all available concepts with their actions and queries.")
    
    flow_analysis: str = dspy.OutputField(desc="Detailed analysis of EVERY user flow including: purpose, concepts, actions, side effects, multi-step onboarding sequences, data dependencies (how to resolve entity references), prerequisites, potential errors, and explicit input constraints (ranges/enums/formats) for user-entered fields.")


class DesignEndpoints(dspy.Signature):
    """Design API endpoints based on the analyzed user flows.
    
    CRITICAL: The OpenAPI spec must describe what the backend ACTUALLY returns, not an idealized version.
    
    For EACH endpoint, provide an EXTREMELY detailed description that includes:
    
    1. PURPOSE: What this endpoint accomplishes in plain language
    2. CONCEPTS: Which concepts this endpoint interacts with
    3. ACTIONS: What concept actions are triggered (e.g., "Calls ConceptA.action1, then ConceptB.action2")
    4. SIDE EFFECTS: What additional operations occur (e.g., "On successful creation, automatically initializes related resources")
    5. PREREQUISITES: What must be true before calling (e.g., "User must be authenticated", "Item must exist")
    6. RESPONSE: What data is returned on success - use ACTUAL field names from MongoDB/concepts
    7. ERRORS: What error conditions can occur and their responses
    
    BACKEND REALITY - Response schemas MUST reflect actual backend output:
    - MongoDB uses '_id' not 'id' for document identifiers
    - Responses are wrapped in objects: { profile: {...} }, { posts: [...] }, { comments: [...] }
    - Author fields may be 'author' not 'authorId', and may include nested profile data
    - Include wrapper objects in schemas, not just raw arrays/objects
    
    The descriptions MUST be detailed enough that:
    1. A sync generator can implement the endpoint correctly
    2. A frontend developer knows EXACTLY what response structure to expect

    CONSTRAINT CONTRACT (CRITICAL — do NOT skip):
    - For EVERY user-provided request field (body/query/path/header), define explicit schema constraints whenever bounded:
      `minimum/maximum`, `exclusiveMinimum/exclusiveMaximum`, `enum`, `minLength/maxLength`, `pattern`, `format`, `required`, `nullable`.
    - Never leave rating/score/stars fields unconstrained.
    - For star-style ratings, if the plan does not specify the scale, default to integer 0-5 and state this clearly in endpoint description.
    - If a field is truly unbounded by design, explicitly say so in endpoint description (do not leave implied).
    - Ensure request constraints and response semantics are consistent (e.g., accepted range in request matches stored/returned field behavior).
    
    REVISION MODE (CRITICAL — read carefully):
    If previous_endpoints is provided, use PATCH MODE for endpoints_json to make surgical changes.
    - The openapi_yaml must still be output in full (downstream consumers need the complete spec).
    - But for endpoints_json, output a PATCH object instead of regenerating the full list.
    - If the reviewer feedback only concerns the app graph (not endpoints), output: {"mode": "patch", "upsert": [], "delete": []}
    - NEVER drop endpoints that weren't flagged.
    
    ENDPOINTS_JSON FORMAT:
    - First attempt (no previous_endpoints): {"mode": "full", "endpoints": [array of all endpoints]}
    - Revisions: {"mode": "patch", "upsert": [endpoints to add or replace, matched by method+path], "delete": [{"method": "X", "path": "/y"} to remove]}
    """
    
    plan: str = dspy.InputField(desc="The application plan.")
    concept_specs: str = dspy.InputField(desc="Specifications of all available concepts.")
    flow_analysis: str = dspy.InputField(desc="The detailed user flow analysis.")
    guidelines: str = dspy.InputField(desc="API design guidelines and constraints. May include reviewer feedback on subsequent iterations.")
    previous_endpoints: str = dspy.InputField(desc="Endpoints JSON from the previous iteration, or empty string on first attempt.")
    previous_reasoning: str = dspy.InputField(desc="Your chain-of-thought reasoning from the previous iteration, or empty string on first attempt.")
    
    openapi_yaml: str = dspy.OutputField(desc="Complete OpenAPI 3.0 YAML with accurate response schemas matching actual backend output. Use _id for IDs, wrap responses in objects, and include explicit request constraints (minimum/maximum/enums/etc.) for bounded user inputs.")
    endpoints_json: str = dspy.OutputField(desc='JSON object. First attempt: {"mode": "full", "endpoints": [...]}. Revisions: {"mode": "patch", "upsert": [endpoints to add/replace by method+path], "delete": [{"method": "X", "path": "/y"}]}.')


class GenerateAppGraph(dspy.Signature):
    """Generate a structural Graph representation of the frontend application.
    
    This replaces a text-based guide with a rigid JSON blueprint that defines exactly what pages exist, what data they need, and how users navigate between them.
    
    The graph consists of:
    1. NODES (Pages): Screens or views in the app.
    2. EDGES (Interactions): Buttons, forms, or links that trigger actions or navigation.
    
    CRITICAL RULES:
    - Every Page MUST define its data requirements (which GET endpoints to call on load).
    - **CONDITIONAL EDGES**: If an interaction depends on state (e.g. "Join" vs "Leave", "Upvote" vs "Downvote"), you MUST define a `condition`.
    - **ROOT ENTRY STRATEGY**: You MUST include a node for the root path (`/`). It should have EDGES defining where to redirect based on auth status (e.g., `condition: "!isAuthenticated"` -> `target: "login"`).
    - **DATA COMPLETENESS**: If an edge has a `condition` (e.g. `!isMember`), the Page's `data_requirements` MUST fetch an endpoint that returns this field.
    - **UNUSED ENDPOINTS OK**: Since we generate surplus endpoints for completeness (like DELETE /users/{id}), it is OK if the frontend does not use every single one. Focus on the user flows defined in the plan.
    - **AUTH vs RESOURCE EXISTENCE**: `isAuthenticated` = has valid token, NOT that all /me/* resources exist. Onboarding pages MUST be accessible to authenticated users even if GET /me/profile returns 404. Note this in onboarding page descriptions.
    - **FULL CONNECTIVITY (CRITICAL)**: In multi-page apps, the graph must be strongly connected: every page must be reachable from every other page through navigation edges. "No sinks" is not sufficient. Design return paths, back-links, and cross-links so users can always traverse the app.
    - **SELF-DELETE REDIRECTS**: If an edge deletes the resource shown on the current page (e.g., delete post on post detail, delete profile on profile page), the on_success MUST navigate to an appropriate parent/list page (never loop back to the deleted page).
    - **ACCOUNT DELETION**: Use `DELETE /me` (or `/users/me`) for full account deletion + cascade cleanup. Use PATCH for profile edits.
    
    REVISION MODE (CRITICAL — read carefully):
    If previous_graph is provided, use PATCH MODE to make surgical changes instead of regenerating the full graph.
    - Output a patch object that adds, updates, or removes specific nodes and edges.
    - If the reviewer flagged 3 issues, you should have ~3 upserts/deletes. Do NOT regenerate the whole graph.
    - Also update edge actions if endpoint paths changed (compare previous_endpoints vs endpoints_json).
    - NEVER drop nodes/edges that weren't flagged. Losing unflagged edges is the #1 failure mode.
    
    EDGE IDENTITY: Edges are identified by the tuple (from, trigger, condition). To update an edge, upsert one with the same (from, trigger, condition). To delete, specify those three fields.
    
    APP_GRAPH FORMAT:
    - First attempt (no previous_graph): {"mode": "full", "nodes": [...], "edges": [...]}
    - Revisions: {"mode": "patch", "upsert_nodes": [...], "delete_nodes": ["id1"], "upsert_edges": [...full edge objects...], "delete_edges": [{"from": "x", "trigger": "y", "condition": "z"}]}
      For delete_edges, use condition: null if the edge has no condition field.
    
    GRAPH SCHEMA EXAMPLES:
    
    Example 1: Strict Auth App (Login Wall)
    ```json
    {
      "nodes": [
        {
          "id": "login",
          "path": "/login",
          "type": "page",
          "description": "User login form",
          "data_requirements": []
        },
        {
          "id": "root",
          "path": "/",
          "type": "page",
          "description": "Root entry point",
          "data_requirements": []
        },
        {
          "id": "feed",
          "path": "/feed",
          "type": "page",
          "description": "Main feed",
          "data_requirements": []
        },
        {
          "id": "item_detail",
          "path": "/items/{id}",
          "type": "page",
          "description": "Item details",
          "data_requirements": ["GET /items/{id}"]
        }
      ],
      "edges": [
        {
          "from": "root",
          "trigger": "Load",
          "condition": "!isAuthenticated",
          "action": "navigate",
          "on_success": { "type": "navigate", "target": "login" }
        },
        {
          "from": "root",
          "trigger": "Load",
          "condition": "isAuthenticated",
          "action": "navigate",
          "on_success": { "type": "navigate", "target": "feed" }
        },
        {
          "from": "login",
          "trigger": "Submit Form",
          "action": "POST /auth/login",
          "on_success": { "type": "navigate", "target": "feed" },
          "on_error": { "type": "toast", "message": "Login failed" }
        }
      ]
    }
    ```

    Example 2: Open Access App (Public Feed with Optional Auth)
    ```json
    {
      "nodes": [
        {
          "id": "root",
          "path": "/",
          "type": "page",
          "description": "Public feed visible to everyone",
          "data_requirements": ["GET /feed"]
        },
        {
          "id": "login",
          "path": "/login",
          "type": "page",
          "description": "Login page",
          "data_requirements": []
        }
      ],
      "edges": [
        {
          "from": "root",
          "trigger": "Log In",
          "condition": "!isAuthenticated", // Only show Login button if NOT logged in
          "action": "navigate",
          "on_success": { "type": "navigate", "target": "login" }
        },
        {
          "from": "root",
          "trigger": "Create Post",
          "condition": "isAuthenticated", // Only show Create button if logged in
          "action": "navigate",
          "on_success": { "type": "navigate", "target": "create_post" }
        }
      ]
    }
    ```
    
    Example 3: Profile, Toggle Actions, Edit & Delete (Demonstrates conditional pairs, edit flow, destructive action)
    ```json
    {
      "nodes": [
        {
          "id": "user_profile",
          "path": "/profiles/{id}",
          "type": "page",
          "description": "Public user profile",
          // CRITICAL: data_requirements MUST return fields used in edge conditions (isFollowing, isOwner).
          // If the main endpoint doesn't include a condition field, add another endpoint that does.
          "data_requirements": ["GET /profiles/{id}", "GET /me/following"]
        },
        {
          "id": "edit_profile",
          "path": "/settings/profile",
          "type": "page",
          "description": "Edit own profile form",
          "data_requirements": ["GET /me/profile"]
        },
        {
          "id": "settings",
          "path": "/settings",
          "type": "page",
          "description": "Account settings and danger zone",
          "data_requirements": []
        },
        {
          "id": "login",
          "path": "/login",
          "type": "page",
          "description": "Login page",
          "data_requirements": []
        }
      ],
      "edges": [
        // ── TOGGLE ACTIONS: ALWAYS generate PAIRED edges with OPPOSITE conditions ──
        {
          "from": "user_profile",
          "trigger": "Follow",
          "condition": "!profile.isFollowing",  // ← field MUST come from data_requirements. May need a separate call (e.g., GET /me/following) if the profile endpoint doesn't return it.
          "action": "POST /users/{userId}/follow",
          "on_success": { "type": "refresh_data", "target": "user_profile" }  // ← refresh so condition re-evaluates
        },
        {
          "from": "user_profile",
          "trigger": "Unfollow",
          "condition": "profile.isFollowing",  // ← OPPOSITE condition of the Follow edge above
          "action": "DELETE /users/{userId}/follow",
          "on_success": { "type": "refresh_data", "target": "user_profile" }
        },
        // ── EDIT FLOW: owner-only button → edit page → PATCH → navigate back ──
        {
          "from": "user_profile",
          "trigger": "Edit Profile",
          "condition": "profile.isOwner",  // ← only show edit button on own profile
          "action": "navigate",
          "on_success": { "type": "navigate", "target": "edit_profile" }
        },
        {
          "from": "edit_profile",
          "trigger": "Save Changes",
          "action": "PATCH /me/profile",
          "on_success": { "type": "navigate", "target": "user_profile" }
        },
        // ── DESTRUCTIVE ACTION: delete account → clear session → redirect to login ──
        {
          "from": "settings",
          "trigger": "Delete Account",
          "action": "DELETE /me",
          "on_success": { "type": "navigate", "target": "login", "clear_session": true }
        }
      ]
    }
    ```
    """
    
    plan: str = dspy.InputField(desc="The application plan.")
    flow_analysis: str = dspy.InputField(desc="The detailed user flow analysis identifying multi-step flows, data lifecycles, and onboarding sequences. Use this to ensure the graph covers ALL identified flows.")
    openapi_yaml: str = dspy.InputField(desc="The generated OpenAPI specification.")
    endpoints_json: str = dspy.InputField(desc="The CURRENT (possibly revised) list of endpoints.")
    previous_endpoints: str = dspy.InputField(desc="The PREVIOUS iteration's endpoints, or empty string on first attempt. Compare with endpoints_json to see what changed.")
    previous_graph: str = dspy.InputField(desc="The App Graph from the previous iteration, or empty string on first attempt. Use as your starting point when revising.")
    previous_reasoning: str = dspy.InputField(desc="Your chain-of-thought reasoning from the previous iteration, or empty string on first attempt. Use to maintain design continuity while addressing reviewer feedback.")
    graph_feedback: str = dspy.InputField(desc="Reviewer feedback on the previous graph. Empty string on first attempt.")
    
    app_graph: str = dspy.OutputField(desc='JSON object. First attempt: {"mode": "full", "nodes": [...], "edges": [...]}. Revisions: {"mode": "patch", "upsert_nodes": [...], "delete_nodes": [...], "upsert_edges": [...], "delete_edges": [{"from", "trigger", "condition"}]}.')


class ReviewGeneration(dspy.Signature):
    """Review the generated API endpoints and App Graph for completeness and correctness.
    
    You are a strict, EXHAUSTIVE reviewer. You MUST enumerate ALL problems in a SINGLE pass.
    Do NOT hold back issues for later rounds — list every problem you find, no matter how many.
    Each iteration is expensive. Finding 2 issues now and 3 more next round wastes iterations.
    Run through EVERY check below against EVERY endpoint and EVERY graph node/edge, then report everything at once.
    Never stop after the first issue. Even if a sink report exists, continue scanning and report all other issues in the same pass.
    
    Check for these problems:
    
    1. MISSING CRUD: Every entity in the plan must have POST, GET, PATCH (if it has mutable fields), DELETE.
       MECHANICAL CHECK: For every PATCH endpoint, verify a corresponding POST endpoint exists for the same resource. Auth endpoints (register/login) do NOT count as entity creation.
       LIFECYCLE CHECK: For every resource that has edit (PATCH) or delete (DELETE) edges in the graph, verify the user can also CREATE it — either via a POST edge in the graph, a creation side effect documented in another endpoint, or a conditional UI that shows "create" when the resource doesn't exist and "edit" when it does. An edit/delete button without a creation path means PATCH/DELETE will 404.
    2. MISSING SYMMETRY: Every reversible action must have its inverse (e.g. if Follow exists, Unfollow must too).
    3. INCOMPLETE ONBOARDING: If the plan requires setup steps after registration (e.g. creating a profile, choosing preferences, joining a default group), the graph must include those intermediate pages/edges BEFORE navigating to the main app. Registration should NOT skip required setup steps.
    4. DATA GAPS: For every edge with a "condition" field, check that the source page's data_requirements include an endpoint whose response schema contains that field. If the field (e.g. isFollowing, isLiked, isOwner) is NOT guaranteed by the listed endpoints, EITHER add a fallback endpoint to data_requirements OR flag the endpoint design as needing to embed that field.
    5. MISSING DESTRUCTIVE FLOWS: For every entity the user owns, there should be a way to delete it. If deleting the user's account/primary resource, the graph must clear the session and redirect to an unauthenticated page.
    6. PHANTOM ENDPOINTS: Every endpoint referenced in a graph edge action must exist in the endpoints list.
    7. FULL GRAPH CONNECTIVITY (HIGH SEVERITY): The graph must be strongly connected for multi-page apps: every page reachable from every other page via navigation edges. No one-way islands, no orphan subgraphs, no dead-end branches that cannot route back.
    8. REFRESH TARGETS: Every edge with on_success type "refresh_data" should specify a target page to refresh.
    9. MISSING /me ENDPOINT COVERAGE (HIGH SEVERITY): Explicitly cross-check the PLAN and flow_analysis for user-specific resources/actions and verify required `/me` endpoints exist and are documented consistently. This is NOT optional convenience. If user-specific writes/reads exist but practical `/me` paths are missing or ambiguous, fail review.
    10. DELETE SAFETY: Any delete action must either (a) refresh data on success or (b) navigate to a safe node that does not depend on the deleted resource. Never leave the user on a page that still expects the deleted data.
    11. DELETE CASCADE CONSISTENCY: If OpenAPI defines deletion of a core resource (e.g. DELETE /me), verify all dependent concept data is cleaned up (sessions/auth, memberships, references in other concepts). If not, require endpoints/behavior to remove those references.
    12. SELF-DELETE REDIRECTS: If an edge deletes the resource shown on the current page, on_success must navigate to an appropriate parent/list page, not back to the deleted page.
    13. UNSUPPORTED ENDPOINTS (HIGH SEVERITY): Cross-reference each endpoint's described actions against `concept_specs`. Every method referenced in an endpoint description (e.g. "Calls ConceptName.methodName") MUST exist as a real action or query in the concept specs. If not found, the endpoint must be redesigned to use existing methods or removed. Phantom methods cause runtime crashes.
    14. CONNECTIVITY REPORT: If an ALGORITHMIC CONNECTIVITY REPORT is appended below, treat it as deterministic graph analysis. Require concrete edge fixes to make the graph strongly connected (unless it is a true single-page app). Continue all other checks regardless.
    15. MISSING INPUT CONSTRAINTS (HIGH SEVERITY): For any bounded user input domain implied by plan/flow/UI semantics (especially rating/score/stars/quantity/percentage), OpenAPI MUST encode explicit constraints (minimum/maximum or enum/pattern/minLength/maxLength as appropriate). Do not allow ambiguous unconstrained rating-like fields.
    16. PHANTOM FLEXIBILITY: If OpenAPI leaves a bounded domain ambiguous, require explicit constraints instead of letting frontend/backend infer different scales.
    17. STATE ADDRESS INCONSISTENCY (HIGH SEVERITY): For any shared logical state accessed by multiple endpoints (pagination lists, feeds, inboxes, membership sets, counters, etc.), verify the OpenAPI descriptions explicitly define and consistently reuse the same state-address keys (e.g., `bound`, `itemType`, `parentId`, `scope`). Flag any mismatch where write endpoints target one address but read endpoints fetch from another, or where keys are omitted/ambiguous in some endpoints.
    18. FILE HOSTING CONTRACTS (HIGH SEVERITY): If plan/flows include file uploads or media rendering, require:
       - upload endpoints use `multipart/form-data` with binary fields,
       - upload response includes `{ url, mimeType, size, fileName }`,
       - `GET /media/{id}` exists with proper binary response docs and range semantics (`206`, `Content-Range`, `Accept-Ranges`).
    
    CRITIQUE QUALITY REQUIREMENT (CRITICAL):
    - For EVERY failed check, endpoint_critique and/or graph_critique MUST include explicit, copyable corrections.
    - Do not provide vague advice. Provide concrete rewrite instructions the designer can apply directly, including exact method+path additions/changes/removals when endpoints are involved.
    - When relevant, include exact contracts to apply (e.g., `/me` coverage, state-address key mappings such as bound/itemType/parentId/scope, required response fields, required graph edges/conditions).
    
    IMPORTANT: Base your review on what the PLAN describes. Do not demand features the plan doesn't call for.
    
    REVIEW CONTINUITY: If previous_review is provided, use it as a checklist:
    - For each issue you flagged before, verify it was ACTUALLY fixed. If still broken, re-flag it explicitly.
    - Do NOT re-report issues that were successfully fixed.
    - Do NOT contradict your previous review (e.g., demanding X then demanding the opposite).
    - Focus new findings on issues not covered in the previous review.
    
    If ALL checks pass, set verdict to "accept".
    Otherwise, set verdict to "revise" and provide specific critique.
    """
    
    plan: str = dspy.InputField(desc="The application plan.")
    concept_specs: str = dspy.InputField(desc="Specifications of all available concepts with their actions and queries. Use this to verify endpoint feasibility.")
    flow_analysis: str = dspy.InputField(desc="The detailed user flow analysis. Cross-reference this against endpoints and graph to catch missing flows.")
    endpoints_json: str = dspy.InputField(desc="The generated endpoint list JSON (method/path/description). Use this to verify graph edge actions map to concrete endpoints.")
    openapi_yaml: str = dspy.InputField(desc="The full OpenAPI 3.0 spec with response schemas. Use this to verify what fields each endpoint actually returns.")
    app_graph: str = dspy.InputField(desc="The generated App Graph JSON.")
    previous_review: str = dspy.InputField(desc="Your previous review output (issues + critiques), or empty string on first review. Use as a checklist to verify fixes and avoid contradictions.")
    
    issues: str = dspy.OutputField(desc="EXHAUSTIVE list of ALL problems found across all checks, or 'None' if all checks pass. Do not omit issues to be brief.")
    verdict: str = dspy.OutputField(desc="Either 'accept' or 'revise'.")
    endpoint_critique: str = dspy.OutputField(desc="ALL fixes needed for endpoints. Be thorough — list every issue. Empty string if endpoints are fine.")
    graph_critique: str = dspy.OutputField(desc="ALL fixes needed for the app graph. Be thorough — list every issue. Empty string if graph is fine.")


class CheckConditionalSinks(dspy.Signature):
    """Given a graph node whose ONLY navigate-away edges are conditional, decide whether the conditions exhaustively cover the state space (meaning the user is NEVER trapped).

    Examples of exhaustive conditions: `isAuthenticated` + `!isAuthenticated`; `role === 'admin'` + `role === 'member'` + `role === 'guest'` (if those are all roles).
    Examples of NON-exhaustive: only `post.author === me` (non-authors are trapped); only `!isFollowing` (followers have no escape).
    
    Be brief. One or two sentences for the concern if not exhaustive."""
    
    node_id: str = dspy.InputField(desc="The graph node id.")
    node_path: str = dspy.InputField(desc="The route path for context.")
    conditional_edges: str = dspy.InputField(desc="JSON array of the conditional navigate-away edges (condition, trigger, target).")
    
    exhaustive: bool = dspy.OutputField(desc="True if the conditions cover the entire state space, False otherwise.")
    concern: str = dspy.OutputField(desc="If not exhaustive, a brief explanation of which users/states are trapped. Empty string if exhaustive.")


class ApiGenerator(dspy.Module):
    def __init__(self, pro_lm=None, flash_lm=None):
        super().__init__()
        self.pro_lm = pro_lm
        self.flash_lm = flash_lm
        self.flow_analyzer = dspy.ChainOfThought(AnalyzeUserFlows)
        self.endpoint_designer = dspy.ChainOfThought(DesignEndpoints)
        self.graph_generator = dspy.ChainOfThought(GenerateAppGraph)
        self.reviewer = dspy.ChainOfThought(ReviewGeneration)
        self.sink_checker = dspy.Predict(CheckConditionalSinks)
        
    @staticmethod
    def _strip_fences(raw: str) -> str:
        """Strip markdown code fences from a raw string."""
        s = raw.strip()
        if s.startswith("```json"):
            s = s[7:]
        if s.startswith("```"):
            s = s[3:]
        if s.endswith("```"):
            s = s[:-3]
        return s.strip()
    
    def _parse_endpoints(self, endpoints_json_raw: str, previous_endpoints: list) -> list:
        """Parse endpoints JSON, handling both full and patch modes.
        
        Returns the complete endpoints list after applying any patches.
        """
        try:
            parsed = json.loads(self._strip_fences(endpoints_json_raw))
            
            # New format: {"mode": "full"|"patch", ...}
            if isinstance(parsed, dict) and "mode" in parsed:
                mode = parsed["mode"]
                if mode == "full":
                    endpoints = parsed.get("endpoints", [])
                    print(f"Parsed {len(endpoints)} endpoints (full mode)", file=sys.stderr)
                    return endpoints
                elif mode == "patch":
                    return self._apply_endpoint_patch(previous_endpoints, parsed)
            
            # Legacy format: plain array of endpoints
            if isinstance(parsed, list):
                print(f"Parsed {len(parsed)} endpoints (legacy array)", file=sys.stderr)
                return parsed
            
            print(f"Unexpected endpoints format: {type(parsed)}", file=sys.stderr)
            return previous_endpoints if previous_endpoints else []
        except Exception as e:
            print(f"Error parsing endpoints JSON: {e}", file=sys.stderr)
            return previous_endpoints if previous_endpoints else []
    
    def _apply_endpoint_patch(self, current: list, patch: dict) -> list:
        """Apply a patch to the endpoints list. Endpoints keyed by (method, path)."""
        # Index current endpoints
        by_key = {}
        for ep in current:
            key = (ep.get("method", "").upper(), ep.get("path", ""))
            by_key[key] = ep
        
        # Upsert
        upserted = 0
        for ep in patch.get("upsert", []):
            key = (ep.get("method", "").upper(), ep.get("path", ""))
            action = "Updated" if key in by_key else "Added"
            by_key[key] = ep
            upserted += 1
            print(f"[Endpoint Patch] {action} {key[0]} {key[1]}", file=sys.stderr)
        
        # Delete
        deleted = 0
        for ep in patch.get("delete", []):
            key = (ep.get("method", "").upper(), ep.get("path", ""))
            if key in by_key:
                del by_key[key]
                deleted += 1
                print(f"[Endpoint Patch] Deleted {key[0]} {key[1]}", file=sys.stderr)
        
        result = list(by_key.values())
        print(f"[Endpoint Patch] {upserted} upserted, {deleted} deleted -> {len(result)} total", file=sys.stderr)
        return result
    
    def _apply_graph_patch(self, current_graph: dict, patch: dict) -> dict:
        """Apply a patch to the app graph. Nodes keyed by id, edges by (from, trigger, condition)."""
        nodes = {n["id"]: n for n in current_graph.get("nodes", [])}
        edges = list(current_graph.get("edges", []))
        
        def edge_key(e):
            return (e.get("from", ""), e.get("trigger", ""), e.get("condition") or None)
        
        # Upsert nodes
        for node in patch.get("upsert_nodes", []):
            action = "Updated" if node["id"] in nodes else "Added"
            nodes[node["id"]] = node
            print(f"[Graph Patch] {action} node \"{node['id']}\"", file=sys.stderr)
        
        # Delete nodes (and their edges)
        for nid in patch.get("delete_nodes", []):
            if nid in nodes:
                del nodes[nid]
                edges = [e for e in edges if e.get("from") != nid]
                print(f"[Graph Patch] Deleted node \"{nid}\" and its edges", file=sys.stderr)
        
        # Delete edges
        delete_keys = set()
        for de in patch.get("delete_edges", []):
            dk = (de.get("from", ""), de.get("trigger", ""), de.get("condition") or None)
            delete_keys.add(dk)
        if delete_keys:
            before = len(edges)
            edges = [e for e in edges if edge_key(e) not in delete_keys]
            print(f"[Graph Patch] Deleted {before - len(edges)} edge(s)", file=sys.stderr)
        
        # Upsert edges (replace if same key exists, otherwise append)
        upserted = 0
        for ue in patch.get("upsert_edges", []):
            uk = edge_key(ue)
            replaced = False
            for i, existing in enumerate(edges):
                if edge_key(existing) == uk:
                    edges[i] = ue
                    replaced = True
                    break
            if not replaced:
                edges.append(ue)
            upserted += 1
            print(f"[Graph Patch] {'Replaced' if replaced else 'Added'} edge ({uk[0]}, \"{uk[1]}\", {uk[2]})", file=sys.stderr)
        
        print(f"[Graph Patch] {len(nodes)} nodes, {len(edges)} edges after patch", file=sys.stderr)
        return {"nodes": list(nodes.values()), "edges": edges}
    
    def _detect_connectivity_issues(self, app_graph_json: str) -> str:
        """Deterministic graph connectivity analysis.

        For multi-page graphs, enforces strong connectivity:
        every node must be reachable from every other node via navigate edges.

        Returns a critique string describing all issues found, or empty string if clean.
        """
        try:
            graph = json.loads(app_graph_json)
        except (json.JSONDecodeError, TypeError):
            return ""
        
        nodes = graph.get("nodes", [])
        edges = graph.get("edges", [])
        if not nodes:
            return ""
        
        node_ids = {n["id"] for n in nodes}
        ordered_node_ids = [n["id"] for n in nodes if "id" in n]
        issues: List[str] = []

        # Build adjacency over explicit navigate edges.
        adjacency: Dict[str, set[str]] = {nid: set() for nid in ordered_node_ids}
        reverse_adjacency: Dict[str, set[str]] = {nid: set() for nid in ordered_node_ids}
        for e in edges:
            src = e.get("from")
            if src not in node_ids:
                continue
            on_success = e.get("on_success", {})
            if on_success.get("type") != "navigate":
                continue
            dst = on_success.get("target")
            if dst not in node_ids:
                continue
            if src == dst:
                continue
            adjacency[src].add(dst)
            reverse_adjacency[dst].add(src)

        # Direct sink check: no navigate-away edges to another node.
        for node in nodes:
            nid = node["id"]
            if len(adjacency.get(nid, set())) == 0:
                issues.append(
                    f'SINK NODE "{nid}" (path: {node.get("path", "?")}): '
                    "No navigation edge leads to a different page. Add at least one escape route."
                )

        # Multi-page apps must be strongly connected.
        if len(ordered_node_ids) > 1:
            def _dfs(start: str, graph_map: Dict[str, set[str]]) -> set[str]:
                seen: set[str] = set()
                stack = [start]
                while stack:
                    cur = stack.pop()
                    if cur in seen:
                        continue
                    seen.add(cur)
                    for nxt in graph_map.get(cur, set()):
                        if nxt not in seen:
                            stack.append(nxt)
                return seen

            start = ordered_node_ids[0]
            reachable_forward = _dfs(start, adjacency)
            reachable_backward = _dfs(start, reverse_adjacency)

            if len(reachable_forward) != len(ordered_node_ids) or len(reachable_backward) != len(ordered_node_ids):
                # Build SCCs via Kosaraju for actionable diagnostics.
                visited: set[str] = set()
                finish_order: List[str] = []

                def _fill_order(v: str) -> None:
                    visited.add(v)
                    for nxt in adjacency.get(v, set()):
                        if nxt not in visited:
                            _fill_order(nxt)
                    finish_order.append(v)

                for nid in ordered_node_ids:
                    if nid not in visited:
                        _fill_order(nid)

                visited.clear()
                sccs: List[List[str]] = []

                def _collect_component(v: str, component: List[str]) -> None:
                    visited.add(v)
                    component.append(v)
                    for nxt in reverse_adjacency.get(v, set()):
                        if nxt not in visited:
                            _collect_component(nxt, component)

                for nid in reversed(finish_order):
                    if nid not in visited:
                        comp: List[str] = []
                        _collect_component(nid, comp)
                        sccs.append(comp)

                component_preview = "; ".join(
                    f"component {idx + 1}: {sorted(comp)}"
                    for idx, comp in enumerate(sccs)
                )
                issues.append(
                    "GRAPH NOT FULLY CONNECTED: Multi-page graph is not strongly connected. "
                    f"Detected {len(sccs)} strongly connected component(s): {component_preview}. "
                    "Add navigation edges so every page is reachable from every other page."
                )
        
        if not issues:
            return ""
        
        header = (
            "ALGORITHMIC CONNECTIVITY REPORT found graph traversal issues.\n"
            "Requirement: for multi-page apps, graph must be strongly connected "
            "(every page reachable from every other page).\n\n"
        )
        return header + "\n".join(f"  {i+1}. {issue}" for i, issue in enumerate(issues))
    
    def _format_graph(self, app_graph_raw: str, previous_graph_dict: Optional[dict] = None) -> str:
        """Parse graph output (full or patch mode), apply patches, return pretty-printed JSON."""
        cleaned = self._strip_fences(app_graph_raw)
        
        try:
            parsed = json.loads(cleaned)
        except Exception:
            print(f"App Graph ({len(app_graph_raw)} chars) - Warning: may not be valid JSON", file=sys.stderr)
            return cleaned
        
        # Handle patch mode
        mode = parsed.get("mode", "legacy") if isinstance(parsed, dict) else "legacy"
        
        if mode == "patch" and previous_graph_dict:
            graph = self._apply_graph_patch(previous_graph_dict, parsed)
        elif mode == "patch" and not previous_graph_dict:
            # LLM emitted patch on first iteration — no base to patch against.
            # Treat upserts as the full set.
            print("[Graph Patch] WARNING: patch mode with no base graph — treating upserts as full.", file=sys.stderr)
            graph = {
                "nodes": parsed.get("upsert_nodes", []),
                "edges": parsed.get("upsert_edges", [])
            }
        elif mode == "full":
            graph = {"nodes": parsed.get("nodes", []), "edges": parsed.get("edges", [])}
        else:
            # Legacy format: {"nodes": [...], "edges": [...]} without mode field
            graph = parsed
        
        formatted = json.dumps(graph, indent=2)
        node_count = len(graph.get('nodes', []))
        edge_count = len(graph.get('edges', []))
        print(f"App Graph: {node_count} nodes, {edge_count} edges (mode: {mode})", file=sys.stderr)
        return formatted
    
    def generate(self, plan: Dict[str, Any], concept_specs: str) -> Dict[str, Any]:
        """
        Generates OpenAPI YAML, endpoint list, and frontend Application Graph.
        
        Uses Pro model for all steps. After generating endpoints + graph,
        a reviewer checks for completeness issues and loops up to MAX_ITERATIONS.
        """
        MAX_ITERATIONS = 25
        plan_json = json.dumps(plan, indent=2)
        
        guidelines = (
            "API DESIGN GUIDELINES:\n\n"
            
            "1. REALITY CHECK: BACKEND OUTPUTS\n"
            "   - MongoDB IDs are '_id', NOT 'id'.\n"
            "   - Responses are ALWAYS wrapped objects: { profile: {...} }, { posts: [...] }. NEVER raw arrays.\n"
            "   - Timestamps: Include 'createdAt'/'updatedAt'.\n\n"
            
            "2. HYDRATION IS MANDATORY\n"
            "   - Never return raw user IDs for authors/members. Always hydrate with display data.\n"
            "   - BAD: { author: '123' }\n"
            "   - GOOD: { author: { _id: '123', username: 'alice', avatarUrl: '...' } }\n\n"

            "3. ENDPOINT SURPLUS & LIFECYCLE (Better too many than too few)\n"
            "   - For every Entity (like 'Post', 'Comment', 'Profile'), you MUST generate ALL 4 standard operations:\n"
            "     1. POST (Create)\n"
            "     2. GET (Read/List)\n"
            "     3. PATCH (Update) - REQUIRED if the entity has ANY mutable fields (title, status, bio), even if the plan forgets to mention editing.\n"
            "     4. DELETE (Remove) - REQUIRED even if the plan forgets to mention deletion.\n"
            "   - Immutable interactions (like 'Likes', 'Votes') do NOT need PATCH. You cannot 'update' a Like; you can only delete it and create a new one.\n"
            "   - Ensure SYMMETRY: If you can 'Follow', you must be able to 'Unfollow'. If you can 'Like', you must be able to 'Unlike'.\n"
            "   - PRIVACY & OWNERSHIP LOGIC (The '/me' Rule):\n"
            "     - Ask yourself: Is this data private to the user? Or public but only editable by the owner?\n"
            "     - PRIVATE/OWNER-ONLY (Settings, Drafts, Profile Edit):\n"
            "       * Use '/me/...' for Create/Update of profile data (e.g., 'POST /me/profile', 'PATCH /me/profile').\n"
            "       * For full account deletion + cascade cleanup, prefer 'DELETE /me' (or '/users/me').\n"
            "       * Treat 'DELETE /me' as the DELETE in the user's lifecycle for authentication and all user-owned data. Deleting auth implies deleting everything that user created or is referenced in (profiles, memberships, posts, comments, likes, etc.).\n"
            "       * The full lifecycle STILL applies: POST to create, GET to read, PATCH to update (if mutable), DELETE to remove.\n"
            "       * DO NOT generate public write endpoints (e.g., 'PATCH /profiles/{id}', 'DELETE /profiles/{id}') if only the owner can modify their own data.\n"
            "     - PUBLIC READ-ONLY:\n"
            "       * Use standard paths ONLY for read access (e.g., 'GET /profiles/{id}').\n"
            "       * Do NOT generate POST/PATCH/DELETE on public paths for owner-only resources.\n"
            "     - MIXED EXAMPLE (Profiles):\n"
            "       * POST /me/profile (create own profile)\n"
            "       * GET /me/profile (read own profile)\n"
            "       * PATCH /me/profile (edit own profile)\n"
            "       * DELETE /me (delete account + cascade cleanup)\n"
            "       * GET /profiles/{id} (anyone can view a profile)\n"
            "       * NO: PATCH /profiles/{id}, DELETE /profiles/{id}, POST /profiles/{id}\n"
            "   - MANDATORY FOR AUTHENTICATION: /auth/register, /auth/login, /auth/logout, /auth/refresh\n\n"

            "4. NO UPSERTS - EXPLICIT CREATION\n"
            "   - Resources MUST use POST to be created. PATCH is strictly for updates to EXISTING resources.\n"
            "   - Never use PATCH for creation. If you have a PATCH endpoint, you MUST also have a corresponding POST endpoint to create it.\n"
            "   - Example: You cannot have 'PATCH /me/profile' without 'POST /me/profile' (to create it first).\n\n"

            "5. UI STATE SUPPORT\n"
            "   - Return computed boolean fields for current user state: 'isLiked', 'isJoined', 'isOwner'.\n"
            "   - Prefer embedding state in the resource. But for every write action (POST/DELETE), the frontend MUST be able to query its state. If not embedded, provide a list endpoint (e.g., if POST /users/{id}/follow exists, GET /me/following must also exist).\n\n"

            
            "6. PATHS & CONVENTIONS\n"
            "   - Base paths only (e.g. '/users'), do NOT include '/api' prefix.\n"
            "   - You MAY use '/me' endpoints (e.g., 'GET /me/profile') for current user resources. This is standard and supported.\n"
            "   - Use standard HTTP codes: 200 (OK), 201 (Created), 400 (Bad Req), 401 (Unauth), 403 (Forbidden), 404 (Not Found).\n\n"

            "7. ERROR RESPONSE SEMANTICS\n"
            "   - 401 = token invalid/expired -> frontend will LOG OUT. 404 = resource not found -> frontend shows empty state. NEVER conflate these.\n"
            "   - For GET /me/* endpoints where the resource is created during onboarding (not registration), the OpenAPI spec MUST include a 404 response:\n"
            "     '404: Not yet created. Expected for new users before onboarding completes.'\n"
            "   - This prevents the frontend from treating a missing profile as an auth failure and logging the user out.\n\n"

            "8. REQUEST INPUT CONSTRAINTS ARE MANDATORY\n"
            "   - Any field users can type/select (rating, score, stars, quantity, amount, percentage, etc.) MUST have explicit schema constraints when bounded.\n"
            "   - Encode constraints directly in OpenAPI using: minimum/maximum, exclusive bounds, enum, minLength/maxLength, pattern, format, required, nullable.\n"
            "   - Never leave rating/score fields unconstrained.\n"
            "   - For star-style ratings with no explicit plan scale, default to integer 0-5 and state this in endpoint description.\n"
            "   - Keep constraints consistent across requestBody, parameters, and behavior described in endpoint text.\n\n"

            "9. FILE UPLOADS & MEDIA\n"
            "   - If a concept has an upload/media action (e.g. MediaHosting.upload), the endpoint that triggers it MUST use multipart/form-data.\n"
            "   - In the OpenAPI spec, declare the request body with `content: multipart/form-data` and mark file fields with `type: string, format: binary`.\n"
            "   - The upload endpoint returns `{ url, mimeType, size, fileName }` where `url` is canonical `/media/{id}`.\n"
            "   - You MUST also generate a `GET /media/{id}` endpoint that serves stored binary with proper headers (`Content-Type`, `Content-Disposition`, `Accept-Ranges`).\n"
            "   - Include byte-range support in OpenAPI for `GET /media/{id}` (`Range` request header, `206` partial response, `Content-Range` response header).\n"
            "   - The frontend will display media URLs in `<img>` or `<video>` tags — the src points directly at `GET /media/{id}`.\n"

        )
        
        # Step 1: Flow analysis (runs once - depends only on plan)
        print("Step 1: Analyzing user flows in depth...", file=sys.stderr)
        
        with (dspy.context(lm=self.pro_lm) if self.pro_lm else nullcontext()):
            flow_result = self.flow_analyzer(
                plan=plan_json,
                concept_specs=concept_specs
            )
        
        flow_analysis = flow_result.flow_analysis
        print(f"Flow analysis complete ({len(flow_analysis)} chars)", file=sys.stderr)
        
        # Review loop: Steps 2-4 iterate until reviewer accepts or max iterations
        endpoint_critique = ""
        graph_critique = ""
        openapi_yaml = ""
        endpoints = []
        endpoints_json_str = "[]"
        app_graph = "{}"
        
        # Track previous iteration outputs and reasoning for revision context
        prev_endpoints_json_str = ""
        prev_app_graph = ""
        prev_graph_dict: Optional[dict] = None  # Parsed graph dict for patch mode
        prev_endpoint_reasoning = ""
        prev_graph_reasoning = ""
        prev_review_text = ""
        
        for iteration in range(MAX_ITERATIONS):
            iter_label = f"[Iteration {iteration + 1}/{MAX_ITERATIONS}]"
            
            # Step 2: Design endpoints (Flash) — retry on truncation
            guidelines_with_critique = guidelines + endpoint_critique
            print(f"{iter_label} Designing API endpoints...", file=sys.stderr)

            def _design_endpoints():
                with (dspy.context(lm=self.pro_lm) if self.pro_lm else nullcontext()):
                    return self.endpoint_designer(
                        plan=plan_json,
                        concept_specs=concept_specs,
                        flow_analysis=flow_analysis,
                        guidelines=guidelines_with_critique,
                        previous_endpoints=prev_endpoints_json_str,
                        previous_reasoning=prev_endpoint_reasoning
                    )

            def _valid_endpoints(r):
                raw = ApiGenerator._strip_fences(r.endpoints_json or "[]")
                if not raw:
                    return False
                try:
                    json.loads(raw)
                    return True
                except Exception:
                    return False

            endpoint_result = _retry_on_truncation(
                _design_endpoints,
                _valid_endpoints,
                max_attempts=3,
                label="Designing API endpoints"
            )
            
            openapi_yaml = endpoint_result.openapi_yaml or ""
            endpoints = self._parse_endpoints(endpoint_result.endpoints_json or "[]", endpoints)
            endpoints_json_str = json.dumps(endpoints, indent=2)
            prev_endpoint_reasoning = getattr(endpoint_result, 'rationale', '') or ''
            
            endpoints_summary = [f"{e.get('method')} {e.get('path')}" for e in endpoints]
            print(f"{iter_label} Generated {len(endpoints)} endpoints: {endpoints_summary}", file=sys.stderr)
            
            # Step 3: Generate App Graph (Flash) — retry on truncation
            print(f"{iter_label} Generating App Graph...", file=sys.stderr)

            def _design_graph():
                with (dspy.context(lm=self.pro_lm) if self.pro_lm else nullcontext()):
                    return self.graph_generator(
                        plan=plan_json,
                        flow_analysis=flow_analysis,
                        openapi_yaml=openapi_yaml,
                        endpoints_json=endpoints_json_str,
                        previous_endpoints=prev_endpoints_json_str,
                        previous_graph=prev_app_graph,
                        previous_reasoning=prev_graph_reasoning,
                        graph_feedback=graph_critique
                    )

            def _valid_graph(r):
                raw = ApiGenerator._strip_fences(r.app_graph or "{}")
                if not raw:
                    return False
                try:
                    json.loads(raw)
                    return True
                except Exception:
                    return False

            graph_result = _retry_on_truncation(
                _design_graph,
                _valid_graph,
                max_attempts=3,
                label="Generating App Graph"
            )
            
            app_graph = self._format_graph(graph_result.app_graph or "{}", prev_graph_dict)
            prev_graph_reasoning = getattr(graph_result, 'rationale', '') or ''
            # Keep parsed dict for next iteration's patch mode
            try:
                prev_graph_dict = json.loads(app_graph)
            except Exception:
                prev_graph_dict = None
            
            # Step 3b: Algorithmic connectivity detection (runs before LLM review)
            connectivity_report = self._detect_connectivity_issues(app_graph)
            if connectivity_report:
                print(f"{iter_label} Connectivity detection found issues:\n{connectivity_report}", file=sys.stderr)
            else:
                print(f"{iter_label} Connectivity detection: clean (graph is strongly connected).", file=sys.stderr)
            
            # Step 4: Review both endpoints and graph (Pro)
            # Feed algorithmic connectivity report to reviewer as additional context
            review_context = prev_review_text
            review_context = (review_context + "\n\n" if review_context else "") + \
                "IMPORTANT: Perform a full, exhaustive review. Do NOT stop after the first issue; list all issues across ALL checks in this iteration."
            if connectivity_report:
                review_context = (review_context + "\n\n" if review_context else "") + \
                    f"ALGORITHMIC CONNECTIVITY REPORT (ground-truth, deterministic):\n{connectivity_report}"
            
            print(f"{iter_label} Reviewing endpoints and graph...", file=sys.stderr)

            def _run_review():
                with (dspy.context(lm=self.pro_lm) if self.pro_lm else nullcontext()):
                    return self.reviewer(
                        plan=plan_json,
                        concept_specs=concept_specs,
                        flow_analysis=flow_analysis,
                        endpoints_json=endpoints_json_str,
                        openapi_yaml=openapi_yaml,
                        app_graph=app_graph,
                        previous_review=review_context
                    )

            def _valid_review(r):
                return bool((r.verdict or "").strip())

            review = _retry_on_truncation(
                _run_review,
                _valid_review,
                max_attempts=3,
                label="Reviewing endpoints and graph"
            )
            
            verdict = review.verdict.strip().lower()
            
            if "accept" in verdict:
                print(f"{iter_label} Review PASSED.", file=sys.stderr)
                break
            else:
                print(f"{iter_label} Review found issues: {review.issues}", file=sys.stderr)
                
                # Save current outputs as "previous" for next iteration
                prev_endpoints_json_str = endpoints_json_str
                prev_app_graph = app_graph
                
                # Capture reviewer output so next review can verify fixes
                prev_review_text = f"ISSUES: {review.issues}\nENDPOINT CRITIQUE: {review.endpoint_critique}\nGRAPH CRITIQUE: {review.graph_critique}"
                
                ep_crit = review.endpoint_critique.strip()
                gr_crit = review.graph_critique.strip()
                
                if ep_crit:
                    endpoint_critique = (
                        f"\n\nREVIEWER FEEDBACK (you MUST fix these endpoint issues from the previous attempt):\n"
                        f"{ep_crit}\n"
                    )
                else:
                    endpoint_critique = "\n\nREVIEWER NOTE: No endpoint issues found. Reproduce your previous endpoints unchanged.\n"
                
                if gr_crit or connectivity_report:
                    parts = []
                    if gr_crit:
                        parts.append(f"REVIEWER FEEDBACK (you MUST fix these graph issues from the previous attempt):\n{gr_crit}")
                    if connectivity_report:
                        parts.append(connectivity_report)
                    graph_critique = "\n\n".join(parts) + "\n"
                else:
                    graph_critique = "REVIEWER NOTE: No graph issues found. Reproduce your previous graph unchanged, unless endpoint paths changed.\n"
                if iteration == MAX_ITERATIONS - 1:
                    print(f"Max iterations reached. Proceeding with current output.", file=sys.stderr)
        
        # Print final accepted outputs
        endpoints_summary = [f"{e.get('method')} {e.get('path')}" for e in endpoints]
        print(f"\n=== FINAL ENDPOINTS ({len(endpoints)}) ===\n{endpoints_summary}\n", file=sys.stderr)
        print(f"\n=== FINAL APP GRAPH ===\n{app_graph}\n===========================\n", file=sys.stderr)
        
        return {
            "openapi_yaml": openapi_yaml,
            "endpoints": endpoints,
            "flow_analysis": flow_analysis,
            "app_graph": app_graph
        }
