/// <reference types="node" />

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

test("CORS permits every API mutation method including evidence-link reordering", () => {
  const source = readFileSync(
    join(process.cwd(), "server/src/index.ts"),
    "utf8"
  );

  const methods = source.match(/methods:\s*\[([\s\S]*?)\]/)?.[1] ?? "";

  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    assert.match(methods, new RegExp(`"${method}"`));
  }
});
