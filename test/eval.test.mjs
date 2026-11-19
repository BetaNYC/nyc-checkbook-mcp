// #55: the evaluation set in eval/questions.json runs with the suite, so a change that breaks
// a known answer fails here. Offline, as eval/run.mjs is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { QUESTIONS, ask } from "../eval/run.mjs";

test("the evaluation set has at least 10 questions", () => {
  assert.ok(QUESTIONS.length >= 10);
  assert.equal(new Set(QUESTIONS.map((q) => q.id)).size, QUESTIONS.length);
});

for (const q of QUESTIONS) {
  test(`eval ${q.id}: ${q.q}`, async () => {
    const r = await ask(q);
    assert.ok(r.pass, r.failures.join("; "));
  });
}
