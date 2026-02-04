import dspy
import json
import sys
from typing import List, Dict, Any
from pydantic import BaseModel, Field


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
    
    CRITICAL - UNDERSTAND ENDPOINT vs CONCEPT RELATIONSHIP:
    
    SINGLE ENDPOINT can orchestrate MULTIPLE CONCEPTS:
    - DELETE /posts/{id} → deletes post (Posting), likes (Liking), comments (Commenting)
    - POST /auth/register → creates user (Authenticating), creates session (Sessioning)
    
    DIFFERENT PATHS require SEPARATE API CALLS (frontend orchestration):
    - Registration flow: POST /auth/register → POST /me/profile → POST /users/{id}/follow
    - The frontend guide MUST document these endpoint sequences explicitly!
    
    IDENTIFY NON-OBVIOUS BEHAVIORS TO DOCUMENT:
    - Feed visibility: Users only see posts from people they follow
      - DOCUMENT IN GUIDE: Frontend must call follow endpoint for user to follow themselves
    - Profile creation: Profiling is separate from Authenticating
      - DOCUMENT IN GUIDE: Frontend must call profile creation after registration
    - Data completeness: If posts show author info, how does frontend get author details?
      - SOLUTION: Either include author profile in post response OR provide endpoint to look up user by ID
    
    IDENTIFY DATA DEPENDENCIES:
    - What data does each entity reference? (posts reference authors, comments reference posts)
    - How can the frontend resolve these references? (need endpoints or embedded data)
    - What aggregations are needed? (like counts, comment counts, follower counts)
    """
    
    plan: str = dspy.InputField(desc="The application plan describing user stories, features, and requirements.")
    concept_specs: str = dspy.InputField(desc="Specifications of all available concepts with their actions and queries.")
    
    flow_analysis: str = dspy.OutputField(desc="Detailed analysis of EVERY user flow including: purpose, concepts, actions, side effects (especially auto-follow, auto-profile-creation), data dependencies (how to resolve author IDs to usernames), prerequisites, and potential errors.")


class DesignEndpoints(dspy.Signature):
    """Design API endpoints based on the analyzed user flows.
    
    CRITICAL: The OpenAPI spec must describe what the backend ACTUALLY returns, not an idealized version.
    
    For EACH endpoint, provide an EXTREMELY detailed description that includes:
    
    1. PURPOSE: What this endpoint accomplishes in plain language
    2. CONCEPTS: Which concepts this endpoint interacts with
    3. ACTIONS: What concept actions are triggered (e.g., "Calls Authenticating.register, then Sessioning.create, then Profiling.createProfile")
    4. SIDE EFFECTS: What additional operations occur (e.g., "On successful registration, automatically creates an empty profile for the user")
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
    """
    
    plan: str = dspy.InputField(desc="The application plan.")
    concept_specs: str = dspy.InputField(desc="Specifications of all available concepts.")
    flow_analysis: str = dspy.InputField(desc="The detailed user flow analysis.")
    guidelines: str = dspy.InputField(desc="API design guidelines and constraints.")
    
    openapi_yaml: str = dspy.OutputField(desc="Complete OpenAPI 3.0 YAML with accurate response schemas matching actual backend output. Use _id for IDs, wrap responses in objects.")
    endpoints_json: str = dspy.OutputField(desc="JSON array of endpoints with method, path, summary, description.")


class GenerateAppGraph(dspy.Signature):
    """Generate a structural Graph representation of the frontend application.
    
    This replaces a text-based guide with a rigid JSON blueprint that defines exactly what pages exist, what data they need, and how users navigate between them.
    
    The graph consists of:
    1. NODES (Pages): Screens or views in the app.
    2. EDGES (Interactions): Buttons, forms, or links that trigger actions or navigation.
    
    CRITICAL RULES:
    - Every API endpoint defined in the OpenAPI spec MUST be used by at least one Edge.
    - Every Page MUST define its data requirements (which GET endpoints to call on load).
    - **CONDITIONAL EDGES**: If an interaction depends on state (e.g. "Join" vs "Leave", "Upvote" vs "Downvote"), you MUST define a `condition`.
    - **DATA COMPLETENESS**: If an edge has a `condition` (e.g. `!isMember`), the Page's `data_requirements` MUST fetch an endpoint that returns this field.
    
    GRAPH SCHEMA:
    ```json
    {
      "nodes": [
        {
          "id": "login",
          "path": "/login",
          "type": "page",
          "description": "User login form",
          "data_requirements": [] // No data needed to load
        },
        {
          "id": "item_detail",
          "path": "/items/{id}",
          "type": "page",
          "description": "Item details",
          "data_requirements": ["GET /items/{id}"] // Response must include 'isSaved' field if 'Save' button is conditional!
        }
      ],
      "edges": [
        {
          "from": "login",
          "trigger": "Submit Form",
          "action": "POST /auth/login",
          "on_success": { "type": "navigate", "target": "feed" },
          "on_error": { "type": "toast", "message": "Login failed" }
        },
        {
          "from": "item_detail",
          "trigger": "Save Item",
          "condition": "!isSaved", // Only show if NOT saved
          "action": "POST /items/{id}/save",
          "on_success": { "type": "refresh" },
          "on_error": { "type": "toast", "message": "Could not save" }
        },
        {
          "from": "item_detail",
          "trigger": "Unsave Item",
          "condition": "isSaved", // Only show if IS saved
          "action": "DELETE /items/{id}/save",
          "on_success": { "type": "refresh" },
          "on_error": { "type": "toast", "message": "Could not unsave" }
        }
      ]
    }
    ```
    """
    
    plan: str = dspy.InputField(desc="The application plan.")
    openapi_yaml: str = dspy.InputField(desc="The generated OpenAPI specification.")
    endpoints_json: str = dspy.InputField(desc="The list of endpoints.")
    
    app_graph: str = dspy.OutputField(desc="JSON object containing 'nodes' and 'edges' defining the complete frontend structure.")


class ApiGenerator(dspy.Module):
    def __init__(self):
        super().__init__()
        self.flow_analyzer = dspy.ChainOfThought(AnalyzeUserFlows)
        self.endpoint_designer = dspy.ChainOfThought(DesignEndpoints)
        self.graph_generator = dspy.ChainOfThought(GenerateAppGraph)
        
    def generate(self, plan: Dict[str, Any], concept_specs: str) -> Dict[str, Any]:
        """
        Generates OpenAPI YAML, endpoint list, and frontend Application Graph through deep reasoning.
        """
        
        # Step 1: Deep analysis of user flows
        print("Step 1/3: Analyzing user flows in depth...", file=sys.stderr)
        
        flow_result = self.flow_analyzer(
            plan=json.dumps(plan, indent=2),
            concept_specs=concept_specs
        )
        
        flow_analysis = flow_result.flow_analysis
        print(f"Flow analysis complete ({len(flow_analysis)} chars)", file=sys.stderr)
        
        # Step 2: Design endpoints with detailed descriptions
        print("Step 2/3: Designing API endpoints with detailed descriptions...", file=sys.stderr)
        
        guidelines = (
            "API DESIGN GUIDELINES:\n\n"
            
            "=== CRITICAL: BACKEND REALITY ===\n"
            "The OpenAPI spec MUST describe what the backend ACTUALLY returns, not an idealized API.\n"
            "Inaccurate specs cause frontend bugs and wasted development time.\n\n"
            
            "1. MONGODB FIELD NAMING CONVENTIONS:\n"
            "   - Document IDs are '_id' NOT 'id'\n"
            "   - User references are 'author' or 'user' NOT 'authorId' or 'userId'\n"
            "   - In schemas, use '_id' as the field name with description noting it's the document ID\n"
            "   Example schema:\n"
            "     Post:\n"
            "       properties:\n"
            "         _id:\n"
            "           type: string\n"
            "           description: MongoDB document ID\n"
            "         author:\n"
            "           type: string\n"
            "           description: User ID of the post author\n\n"
            
            "2. RESPONSE WRAPPER OBJECTS:\n"
            "   Backend responses are ALWAYS wrapped in objects, never raw arrays or primitives.\n"
            "   - GET /me/profile returns: { profile: {...} }\n"
            "   - GET /feed returns: { posts: [...] }\n"
            "   - GET /posts/{id}/comments returns: { comments: [...] }\n"
            "   - GET /me/following returns: { results: [...] } or { following: [...] }\n"
            "   - POST /auth/register returns: { user: '...', accessToken: '...', refreshToken: '...' }\n"
            "   Schema example:\n"
            "     responses:\n"
            "       '200':\n"
            "         content:\n"
            "           application/json:\n"
            "             schema:\n"
            "               type: object\n"
            "               properties:\n"
            "                 profile:\n"
            "                   $ref: '#/components/schemas/Profile'\n\n"
            
            "3. INCLUDE ALL NECESSARY FIELDS IN SCHEMAS:\n"
            "   - Every schema MUST include '_id' field\n"
            "   - Include timestamps: 'createdAt', 'updatedAt' where relevant\n"
            "   - If posts have authors, include 'author' field (user ID string)\n"
            "   - Include computed fields: 'likeCount', 'commentCount' etc. if the concept provides them\n\n"
            
            "4. IMPLEMENTATION NOTES FOR FRONTEND:\n"
            "   Add notes in endpoint descriptions to guide the frontend:\n"
            "   - Feed behavior: 'NOTE: Feed only shows items relevant to the current user.'\n"
            "   - Profile creation: 'FRONTEND: After registration, call POST /me/profile to create profile.'\n"
            "   - These are NOT backend auto-operations - the frontend must make the calls!\n\n"
            
            "5. ENDPOINT COMPLETENESS:\n"
            "   Ensure the API is complete for all frontend needs:\n"
            "   - If posts return author (user ID), provide GET /users/{userId} OR include author profile in post response\n"
            "   - Provide both 'by ID' and 'by username' lookups if needed\n\n"

            "=== CRITICAL: STATE-DRIVEN UI SUPPORT ===\n"
            "The frontend cannot decide which button to show (e.g., 'Join' vs 'Leave') without knowing the current state.\n"
            "6. HYDRATED BOOLEAN FIELDS:\n"
            "   - Resources MUST return boolean fields indicating the current user's relationship to them.\n"
            "   - Examples: 'isJoined', 'hasVoted', 'isSaved'.\n"
            "   - ADD these fields to the main resource schema (e.g. GET /items/{id}).\n"
            "   - This allows the UI to render `if (item.isSaved) return <UnsaveBtn /> else return <SaveBtn />`.\n\n"
            
            "7. AVOID 'CHECK' ENDPOINTS:\n"
            "   - Do NOT require a separate API call just to check status (e.g., GET /items/{id}/check-vote).\n"
            "   - Include the status in the main fetch for efficiency.\n\n"
            
            "=== STANDARD GUIDELINES ===\n\n"
            
            "8. FLOW-DRIVEN DESIGN: Endpoints should serve user flows, not just expose CRUD operations.\n"
            "   Consider what the user is trying to accomplish, not just what data to manipulate.\n\n"
            
            "9. DETAILED DESCRIPTIONS: Every endpoint description MUST include:\n"
            "   - PURPOSE: What this accomplishes\n"
            "   - CONCEPTS: Which concepts are involved\n"
            "   - ACTIONS: What concept.action calls occur in order\n"
            "   - SIDE EFFECTS: What automatic operations occur\n"
            "   - PREREQUISITES: What must be true (auth, existing resources)\n"
            "   - RESPONSE: Exact response structure with actual field names\n"
            "   - ERRORS: Possible error conditions and status codes\n\n"
            
            "10. ENDPOINT PATH SEPARATION vs CONCEPT ORCHESTRATION:\n"
            "   PATH SEPARATION - Different concerns have different endpoint paths:\n"
            "   - Auth endpoints: /auth/register, /auth/login, /auth/logout, /auth/refresh\n"
            "   - Profile endpoints: /me/profile, /users/{username}\n"
            "   - Content endpoints: /posts, /posts/{id}, /feed\n"
            "   - The frontend makes separate calls to these different paths.\n\n"
            "   CONCEPT ORCHESTRATION - A single endpoint CAN call multiple concepts:\n"
            "   - DELETE /posts/{id} should delete the post AND its likes AND its comments\n"
            "   - POST /auth/register creates user (Authenticating) AND session (Sessioning)\n"
            "   - This is correct! Syncs orchestrate multiple concept actions in their `then` clause.\n\n"
            "   FRONTEND GUIDE should document the sequence of ENDPOINT calls:\n"
            "   - 'After registration, call POST /me/profile to create profile'\n\n"
            
            "11. CONCEPT CONSTRAINTS: Only include features if a supporting concept exists.\n"
            "   Check concept_specs before adding any field or operation.\n\n"
            
            "12. SERVER CONFIGURATION:\n"
            "    - Base URL: 'http://localhost:8000/api'\n"
            "    - Paths should NOT include '/api' prefix\n"
            "    - Use bearer token authentication where required\n"
            "    - Auth header: 'Authorization: Bearer {accessToken}'\n\n"
            
            "13. ERROR RESPONSES:\n"
            "    All errors return: { error: 'message', statusCode: number }\n"
            "    Common status codes:\n"
            "    - 400: Bad request (validation error)\n"
            "    - 401: Unauthorized (missing/invalid token)\n"
            "    - 403: Forbidden (not owner/no permission)\n"
            "    - 404: Not found\n"
            "    - 409: Conflict (duplicate resource)\n"
        )
        
        endpoint_result = self.endpoint_designer(
            plan=json.dumps(plan, indent=2),
            concept_specs=concept_specs,
            flow_analysis=flow_analysis,
            guidelines=guidelines
        )
        
        openapi_yaml = endpoint_result.openapi_yaml or ""
        endpoints_json_raw = endpoint_result.endpoints_json or "[]"
        
        # Parse endpoints_json
        endpoints = []
        try:
            json_str = endpoints_json_raw.strip()
            if json_str.startswith("```json"):
                json_str = json_str[7:]
            if json_str.startswith("```"):
                json_str = json_str[3:]
            if json_str.endswith("```"):
                json_str = json_str[:-3]
            
            endpoints = json.loads(json_str.strip())
            print(f"Parsed {len(endpoints)} endpoints", file=sys.stderr)
        except Exception as e:
            print(f"Error parsing endpoints JSON: {e}", file=sys.stderr)
        
        # Step 3: Generate frontend App Graph (replacing guide)
        print("Step 3/3: Generating frontend Application Graph...", file=sys.stderr)
        
        graph_result = self.graph_generator(
            plan=json.dumps(plan, indent=2),
            openapi_yaml=openapi_yaml,
            endpoints_json=json.dumps(endpoints, indent=2)
        )
        
        app_graph = graph_result.app_graph or "{}"
        
        # Try to pretty print if it's valid JSON
        try:
            parsed = json.loads(app_graph)
            app_graph = json.dumps(parsed, indent=2)
            print(f"App Graph generated with {len(parsed.get('nodes', []))} nodes and {len(parsed.get('edges', []))} edges.", file=sys.stderr)
            print(f"\n=== GENERATED APP GRAPH ===\n{app_graph}\n===========================\n", file=sys.stderr)
        except:
            print(f"App Graph generated ({len(app_graph)} chars) - Warning: may not be valid JSON", file=sys.stderr)
            print(f"\n=== GENERATED APP GRAPH (Raw) ===\n{app_graph}\n===========================\n", file=sys.stderr)
        
        return {
            "openapi_yaml": openapi_yaml,
            "endpoints": endpoints,
            "flow_analysis": flow_analysis,
            "app_graph": app_graph
        }
