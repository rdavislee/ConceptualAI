import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { ID } from "../../utils/types.ts";
import ImplementingConcept, { Implementation } from "./ImplementingConcept.ts";

// Mock MongoDB
class MockCollection {
  private data = new Map<string, any>();
  name: string;

  constructor(name: string) {
    this.name = name;
  }

  async findOne(query: any) {
    return this.data.get(query._id) || null;
  }

  async insertOne(doc: any) {
    this.data.set(doc._id, doc);
    return { insertedId: doc._id };
  }

  async updateOne(query: any, update: any) {
    const doc = this.data.get(query._id);
    if (doc) {
      if (update.$set) {
        Object.assign(doc, update.$set);
      }
      this.data.set(query._id, doc);
    }
    return { matchedCount: doc ? 1 : 0 };
  }
}

class MockDb {
  collection(name: string) {
    return new MockCollection(name);
  }
}

// Mock fetch
const originalFetch = globalThis.fetch;

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
    globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
        const url = input.toString();
        return handler(url, init);
    };
}

function restoreFetch() {
    globalThis.fetch = originalFetch;
}

Deno.test("ImplementingConcept - pullLibraryConcept renaming logic", async (t) => {
    const db = new MockDb() as any;
    const concept = new ImplementingConcept(db);

    await t.step("correctly renames class and PREFIX", async () => {
        // Setup mock environment
        Deno.env.set("HEADLESS_URL", "http://mock-library");
        
        const mockLibraryResponse = {
            code: `
import { Collection, Db } from "npm:mongodb";
const PREFIX = "Liking.";

export default class LikingConcept {
  constructor(private readonly db: Db) {
    this.xs = this.db.collection(PREFIX + "xs");
  }
}
            `,
            tests: "test code",
            spec: "spec content"
        };

        mockFetch(async (url) => {
            if (url.includes("/api/pull/Liking")) {
                return new Response(JSON.stringify(mockLibraryResponse), { status: 200 });
            }
            return new Response("Not Found", { status: 404 });
        });

        // Use private method via 'any' casting for testing or expose it as public/internal
        // Since it's private, we'll test it via implementAll which calls it
        
        const design = {
            libraryPulls: [
                { 
                    libraryName: "Liking", 
                    instanceName: "PostLiking", 
                    bindings: { Item: "Post", User: "User" } 
                }
            ],
            customConcepts: []
        };

        const result = await concept.implementAll({ project: "test-project" as ID, design });
        
        if ("error" in result) {
            throw new Error(result.error);
        }

        assertExists(result.implementations);
        const impl = result.implementations!["PostLiking"];
        assertExists(impl);
        
        // assertions
        assertEquals(impl.code.includes("class PostLikingConcept"), true, "Should rename class to PostLikingConcept");
        assertEquals(impl.code.includes('const PREFIX = "PostLiking."'), true, "Should rename PREFIX to PostLiking.");
        assertEquals(impl.code.includes("class LikingConcept"), false, "Should not contain old class name");
        
        restoreFetch();
    });
});
