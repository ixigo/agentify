import test from "node:test";
import assert from "node:assert/strict";

import { pathHash, sha1, sha256 } from "../src/core/utils/crypto.js";

test("sha helpers return stable hex digests", () => {
  assert.equal(sha1("agentify"), "97a2cd2ba0fc1ce607e2136b84d5db14ecbe0dcd");
  assert.equal(sha256("agentify"), "742d7dfedc39e0ee839833a679e977d82ed00179b99e6e845ff7afc96a962a6a");
});

test("pathHash hashes colon-joined path parts with sha1", () => {
  assert.equal(pathHash("project", "src/index.js"), sha1("project:src/index.js"));
});
