// Collector fast add: a search that finds nothing is read once more, only in two narrow ways.
import assert from "node:assert/strict";
import { test } from "node:test";

import { searchFallbacks } from "./fallback.ts";

test("a product code typed with a space is tried with the box's hyphen", () => {
  assert.deepEqual(searchFallbacks("slus 00999"), ["SLUS-00999"]);
  assert.deepEqual(searchFallbacks("SLES 01234"), ["SLES-01234"]);
  assert.deepEqual(searchFallbacks("slus 00999gh"), ["SLUS-00999GH"]);
  assert.deepEqual(searchFallbacks("SLUS-00999"), [], "a code already typed as printed is searched as it is");
  assert.deepEqual(searchFallbacks("SLUS00999"), [], "and so is one with nothing between its parts");
});

test("a title's split words are tried joined", () => {
  assert.deepEqual(searchFallbacks("star fall"), ["starfall"]);
  assert.deepEqual(searchFallbacks("  clay   boxr "), ["clayboxr"]);
  assert.deepEqual(searchFallbacks("mega man x"), ["megamanx"]);
});

test("nothing else is reinterpreted", () => {
  assert.deepEqual(searchFallbacks("starfall"), [], "one word");
  assert.deepEqual(searchFallbacks("the legend of the mystical ninja"), [], "a longer phrase is a real phrase");
  assert.deepEqual(searchFallbacks("supercalifragilistic expialidocious"), [], "very long words aren't a split title");
  assert.deepEqual(searchFallbacks(""), []);
  assert.deepEqual(searchFallbacks("street fighter 2"), ["streetfighter2"], "digits stay as typed");
});
