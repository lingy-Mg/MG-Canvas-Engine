import assert from "node:assert/strict";
import test from "node:test";
import { parseRemoteRefs } from "../scripts/publish.mjs";

test("remote release refs identify first releases and existing lightweight or annotated tags", () => {
  const branch = "refs/heads/main";
  const tag = "refs/tags/v0.2.0";
  const head = "a".repeat(40);
  const previous = "b".repeat(40);
  const annotation = "c".repeat(40);
  const main = `${head}\t${branch}\r\n`;
  const first = parseRemoteRefs(main);
  assert.equal(first.get(branch), head);
  assert.equal(first.get(tag), undefined);

  const lightweight = parseRemoteRefs(`${main}${head}\t${tag}\n`);
  assert.equal(lightweight.get(tag), head);

  const annotated = parseRemoteRefs(`${main}${annotation}\t${tag}\n${previous}\t${tag}^{}\n`);
  assert.equal(annotated.get(tag), annotation);
  assert.equal(annotated.get(`${tag}^{}`), previous);
});
