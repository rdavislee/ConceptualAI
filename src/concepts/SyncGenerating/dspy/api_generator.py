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


class GenerateFrontendGuide(dspy.Signature):
    """Generate a comprehensive API usage guide for the frontend application.
    
    This guide should explicitly map out EVERY user flow and the EXACT sequence of API calls needed.
    The frontend developer should NEVER have to guess about response formats or API behavior.
    
    CRITICAL - DOCUMENT ACTUAL RESPONSE FORMATS:
    - Show the EXACT JSON structure returned (with wrapper objects)
    - Use actual field names (_id, author, not id, authorId)
    - Include example responses for each endpoint
    
    For each user flow, document:
    1. Flow name and purpose
    2. Step-by-step API call sequence with exact endpoints
    3. What data to send in each request (with example JSON)
    4. What data to expect in each response (with example JSON showing actual structure)
    5. How to handle errors at each step
    6. UI state changes that should occur
    7. When to refresh data or navigate
    
    CRITICAL - MULTI-STEP FLOWS:
    Concepts are SEPARATE and have their own endpoints. The frontend must call them in sequence.
    Document the EXACT sequence of API calls for each flow:
    
    Example - User Registration Flow:
    1. POST /auth/register → creates user account, returns { user, accessToken, refreshToken }
    2. POST /me/profile → creates user profile with username/bio (body: { username, name, bio })
    3. POST /users/{userId}/follow OR POST /me/follow → follow yourself to see your own posts in feed
    
    IMPORTANT WARNINGS TO INCLUDE:
    - Feed visibility: Users only see posts from people they follow
    - Self-follow: Frontend MUST call follow endpoint with user's own ID after registration
    - Profile creation: Frontend MUST call profile creation endpoint after registration
    - Response wrappers: All responses are wrapped (e.g., { posts: [...] } not just [...])
    
    Include flows for:
    - Initial app load / authentication check (GET /me/profile, handle 401)
    - User registration (SEQUENCE: register → create profile → follow self)
    - User login
    - User logout
    - All CRUD operations for main entities
    - All relationship operations (follow, like, comment, etc.)
    - Error recovery flows
    - Data refresh patterns
    
    INCLUDE EXAMPLE RESPONSES showing actual JSON structure:
    ```json
    // GET /me/profile response
    {
      "profile": {
        "_id": "user123",
        "username": "johndoe",
        "name": "John Doe",
        "bio": "Hello world"
      }
    }
    ```
    """
    
    plan: str = dspy.InputField(desc="The application plan.")
    openapi_yaml: str = dspy.InputField(desc="The generated OpenAPI specification.")
    endpoints_json: str = dspy.InputField(desc="The list of endpoints.")
    
    frontend_guide: str = dspy.OutputField(desc="Comprehensive markdown guide with EXACT response formats, example JSON, and warnings about non-obvious behaviors.")


class ApiGenerator(dspy.Module):
    def __init__(self):
        super().__init__()
        self.flow_analyzer = dspy.ChainOfThought(AnalyzeUserFlows)
        self.endpoint_designer = dspy.ChainOfThought(DesignEndpoints)
        self.guide_generator = dspy.ChainOfThought(GenerateFrontendGuide)
        
    def generate(self, plan: Dict[str, Any], concept_specs: str) -> Dict[str, Any]:
        """
        Generates OpenAPI YAML, endpoint list, and frontend API guide through deep reasoning.
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
            "   - Feed behavior: 'NOTE: Feed only shows posts from users the current user follows.'\n"
            "   - Self-follow: 'FRONTEND: After registration, call follow endpoint for user to follow themselves.'\n"
            "   - Profile creation: 'FRONTEND: After registration, call POST /me/profile to create profile.'\n"
            "   - These are NOT backend auto-operations - the frontend must make the calls!\n\n"
            
            "5. ENDPOINT COMPLETENESS:\n"
            "   Ensure the API is complete for all frontend needs:\n"
            "   - If posts return author (user ID), provide GET /users/{userId} OR include author profile in post response\n"
            "   - If showing follower counts, provide endpoints to get counts OR include in profile response\n"
            "   - Provide both 'by ID' and 'by username' lookups if needed\n\n"
            
            "=== STANDARD GUIDELINES ===\n\n"
            
            "6. FLOW-DRIVEN DESIGN: Endpoints should serve user flows, not just expose CRUD operations.\n"
            "   Consider what the user is trying to accomplish, not just what data to manipulate.\n\n"
            
            "7. DETAILED DESCRIPTIONS: Every endpoint description MUST include:\n"
            "   - PURPOSE: What this accomplishes\n"
            "   - CONCEPTS: Which concepts are involved\n"
            "   - ACTIONS: What concept.action calls occur in order\n"
            "   - SIDE EFFECTS: What automatic operations occur\n"
            "   - PREREQUISITES: What must be true (auth, existing resources)\n"
            "   - RESPONSE: Exact response structure with actual field names\n"
            "   - ERRORS: Possible error conditions and status codes\n\n"
            
            "8. ENDPOINT PATH SEPARATION vs CONCEPT ORCHESTRATION:\n"
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
            "   - 'After registration, call POST /me/profile to create profile'\n"
            "   - 'To follow yourself, call POST /users/{userId}/follow'\n\n"
            
            "9. CONCEPT CONSTRAINTS: Only include features if a supporting concept exists.\n"
            "   Check concept_specs before adding any field or operation.\n\n"
            
            "10. SERVER CONFIGURATION:\n"
            "    - Base URL: 'http://localhost:8000/api'\n"
            "    - Paths should NOT include '/api' prefix\n"
            "    - Use bearer token authentication where required\n"
            "    - Auth header: 'Authorization: Bearer {accessToken}'\n\n"
            
            "11. ERROR RESPONSES:\n"
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
        
        # Step 3: Generate frontend API guide
        print("Step 3/3: Generating frontend API usage guide...", file=sys.stderr)
        
        guide_result = self.guide_generator(
            plan=json.dumps(plan, indent=2),
            openapi_yaml=openapi_yaml,
            endpoints_json=json.dumps(endpoints, indent=2)
        )
        
        frontend_guide = guide_result.frontend_guide or ""
        print(f"Frontend guide generated ({len(frontend_guide)} chars)", file=sys.stderr)
        
        return {
            "openapi_yaml": openapi_yaml,
            "endpoints": endpoints,
            "flow_analysis": flow_analysis,
            "frontend_guide": frontend_guide
        }
