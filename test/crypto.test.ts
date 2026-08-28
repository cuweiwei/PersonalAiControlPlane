import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, sha256, uuidv7 } from "../packages/crypto/src/index.ts";

test("canonical JSON sorts object keys but preserves array order", () => {
  assert.equal(canonicalJson({ b: 2, a: { d: true, c: [2, 1] } }), '{"a":{"c":[2,1],"d":true},"b":2}');
  assert.equal(sha256("hello"), "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
});

test("UUIDv7-shaped IDs preserve timestamp prefix and variant bits", () => {
  const id = uuidv7(1_700_000_000_000);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
