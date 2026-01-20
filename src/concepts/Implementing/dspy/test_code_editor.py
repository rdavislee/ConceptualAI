import unittest
from implementer import CodeEditor

class TestCodeEditor(unittest.TestCase):
    def setUp(self):
        self.impl_code = """
export class MyConcept {
    state: any;
    constructor() {
        this.state = {};
    }
}
"""
        self.test_code = """
import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { MyConcept } from "./MyConceptConcept.ts";

Deno.test("initial state", () => {
    const concept = new MyConcept();
    assertEquals(concept.state, {});
});
"""
        self.editor = CodeEditor(self.impl_code, self.test_code)

    def test_get_code(self):
        self.assertEqual(self.editor.get_code("impl"), self.impl_code)
        self.assertEqual(self.editor.get_code("test"), self.test_code)
        with self.assertRaises(ValueError):
            self.editor.get_code("invalid")

    def test_replace_success(self):
        result = self.editor.replace("impl", "this.state = {};", "this.state = { count: 0 };")
        self.assertIn("Success", result)
        self.assertIn("this.state = { count: 0 };", self.editor.get_code("impl"))
        
    def test_replace_not_found(self):
        result = self.editor.replace("impl", "nonexistent", "new")
        self.assertIn("Error: old_code not found", result)

    def test_replace_ambiguous(self):
        # Create ambiguous content
        self.editor.set_code("impl", "foo\nfoo")
        result = self.editor.replace("impl", "foo", "bar")
        self.assertIn("Error: old_code found 2 times", result)

    def test_delete_success(self):
        result = self.editor.delete("impl", "state: any;")
        self.assertIn("Success", result)
        self.assertNotIn("state: any;", self.editor.get_code("impl"))

    def test_insert_after_success(self):
        result = self.editor.insert_after("impl", "state: any;", "    other: string;")
        self.assertIn("Success", result)
        self.assertIn("state: any;\n    other: string;", self.editor.get_code("impl"))

    def test_overwrite_success(self):
        new_content = "export class NewConcept {}"
        result = self.editor.overwrite("impl", new_content)
        self.assertIn("Success", result)
        self.assertEqual(self.editor.get_code("impl"), new_content)

    def test_full_workflow(self):
        # Simulate a sequence of edits
        self.editor.replace("impl", "this.state = {};", "this.state = { items: [] };")
        self.editor.insert_after("impl", "this.state = { items: [] };", "        console.log('init');")
        self.assertIn("items: []", self.editor.get_code("impl"))
        self.assertIn("console.log('init')", self.editor.get_code("impl"))

if __name__ == '__main__':
    unittest.main()
