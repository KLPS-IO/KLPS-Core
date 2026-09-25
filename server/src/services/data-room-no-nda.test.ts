import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { AddressInfo } from "node:net";
import { pool } from "../storage/postgres.client";
import { hashSha256 } from "./data-room.service";
import dataRoomRouter from "../routes/data-room.routes";
import financeRouter from "../routes/finance.routes";

test("NDA-free access preserves authentication, document tiers and private finance", async () => {
  const originalQuery = pool.query;
  const queries: string[] = [];
  const documents = [
    { id: "shared", filename: "shared.pdf", access_level: "investor_nda", active: true },
    { id: "private", filename: "private.pdf", access_level: "founder_only", active: true },
  ];
  pool.query = (async (sql: string, values: unknown[] = []) => {
    queries.push(sql);
    if (sql.includes("FROM data_room.sessions")) {
      const role = ["authorised_user", "pending_user", "founder_admin"].find(r => hashSha256(r) === values[0]);
      return { rows: role ? [{ session_id: "session", id: "user", email: "fixture@example.test", role, access_tier: "investor_nda" }] : [] };
    }
    if (sql.includes("FROM data_room.documents")) return { rows: values.length ? documents.filter(d => d.id === values[0]) : documents };
    if (sql.includes("FROM data_room.document_categories")) return { rows: [{id:"shared", minimum_access_level:"investor_nda"}, {id:"private", minimum_access_level:"founder_only"}] };
    if (sql.includes("FROM data_room.nda_versions")) return { rows: [{version:"test-nda"}] };
    if (sql.includes("FROM data_room.nda_acceptances")) return { rows: [] };
    throw new Error("Unexpected query in access regression test");
  }) as typeof pool.query;
  const app = express();
  app.use(express.json());
  app.use("/api/data-room", dataRoomRouter);
  app.use("/api/finance", financeRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, role?: string, method = "GET") => fetch(base + path, {method, headers: role ? {Authorization:`Bearer ${role}`} : {}});
  try {
    assert.equal((await request("/api/data-room/documents")).status, 401);
    assert.equal((await request("/api/data-room/documents", "invalid-session")).status, 401);
    assert.equal((await request("/api/data-room/documents", "pending_user")).status, 403);
    const shared = await request("/api/data-room/documents", "authorised_user");
    assert.equal(shared.status, 200);
    assert.deepEqual((await shared.json()).documents.map((d: {id:string}) => d.id), ["shared"]);
    const categories = await request("/api/data-room/categories", "authorised_user");
    assert.equal(categories.status, 200);
    assert.deepEqual((await categories.json()).categories.map((d: {id:string}) => d.id), ["shared"]);
    assert.equal((await request("/api/data-room/documents/shared/url", "authorised_user", "POST")).status, 200);
    assert.equal((await request("/api/data-room/documents/private/url", "authorised_user", "POST")).status, 404);
    assert.equal((await request("/api/data-room/documents/private/url", "founder_admin", "POST")).status, 200);
    const finance = await request("/api/finance/readiness", "authorised_user");
    assert.equal(finance.status, 403);
    assert.equal((await finance.json()).code, "private_finance_required");
    assert.equal(queries.some(sql => sql.includes("data_room.nda_")), false, "Access must not depend on an NDA query");
    const status = await request("/api/data-room/nda/status", "authorised_user");
    assert.equal(status.status, 200);
    const body = await status.json();
    assert.equal(body.accepted, false);
    assert.equal(body.required, false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    pool.query = originalQuery;
  }
});
