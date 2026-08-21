import test from "node:test";
import assert from "node:assert/strict";

import { digest, secureEqual } from "../src/crypto.js";

test("digest is deterministic and secureEqual compares complete strings", () => {
  assert.equal(digest("secret", "body"), digest("secret", "body"));
  assert.equal(secureEqual("abc", "abc"), true);
  assert.equal(secureEqual("abc", "abd"), false);
  assert.equal(secureEqual("abc", "abcd"), false);
});
