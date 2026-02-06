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
    - Registration flow: POST /auth/register → POST /profiles/{id} → POST /users/{id}/follow
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
    - Every Page MUST define its data requirements (which GET endpoints to call on load).
    - **CONDITIONAL EDGES**: If an interaction depends on state (e.g. "Join" vs "Leave", "Upvote" vs "Downvote"), you MUST define a `condition`.
    - **ROOT ENTRY STRATEGY**: You MUST include a node for the root path (`/`). It should have EDGES defining where to redirect based on auth status (e.g., `condition: "!isAuthenticated"` -> `target: "login"`).
    - **DATA COMPLETENESS**: If an edge has a `condition` (e.g. `!isMember`), the Page's `data_requirements` MUST fetch an endpoint that returns this field.
    - **UNUSED ENDPOINTS OK**: Since we generate surplus endpoints for completeness (like DELETE /users/{id}), it is OK if the frontend does not use every single one. Focus on the user flows defined in the plan.
    
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
            "   - MANDATORY FOR AUTHENTICATION: /auth/register, /auth/login, /auth/logout, /auth/refresh\n\n"

            "4. NO UPSERTS - EXPLICIT CREATION\n"
            "   - Resources MUST use POST to be created. PATCH is strictly for updates to EXISTING resources.\n"
            "   - Never use PATCH for creation. If you have a PATCH endpoint, you MUST also have a corresponding POST endpoint to create it.\n"
            "   - Example: You cannot have 'PATCH /profiles/{id}' without 'POST /profiles/{id}' (to create it first).\n\n"

            "5. UI STATE SUPPORT\n"
            "   - Return computed boolean fields for current user state: 'isLiked', 'isJoined', 'isOwner'.\n"
            "   - Do NOT require separate calls to check status. Include it in the main resource.\n\n"
            
            "6. PATHS & CONVENTIONS\n"
            "   - Base paths only (e.g. '/users'), do NOT include '/api' prefix.\n"
            "   - Avoid '/me' shortcuts. Use explicit IDs (e.g., '/users/{id}') so the frontend explicitly manages user state.\n"
            "   - Use standard HTTP codes: 200 (OK), 201 (Created), 400 (Bad Req), 401 (Unauth), 403 (Forbidden), 404 (Not Found).\n"
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
