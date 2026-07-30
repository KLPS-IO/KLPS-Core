import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  approvalMustReset,
  beginSocialOAuth,
  completeSocialOAuth,
  validatePublishReadiness
} from "../growth/social/social.service";
import {
  createPkceChallenge,
  decryptSocialSecret,
  encryptSocialSecret,
  generateOAuthState,
  hashOAuthState
} from "../growth/social/social.crypto";
import { getSocialAdapter, listSocialAdapters, validateSocialEnvironment } from "../growth/social/social.registry";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";

test("social migration creates isolated encrypted connection and approval tables", () => {
  const sql = readFileSync("server/sql/20260730_growth_social_foundation.sql","utf8");
  for (const table of [
    "social_connections","social_oauth_authorisations","social_content_variants",
    "social_publish_jobs","social_metric_snapshots","social_audit_events"
  ]) assert.match(sql,new RegExp(`growth_os\\.${table}`));
  assert.match(sql,/encrypted_access_token/);
  assert.match(sql,/UNIQUE \(workspace_id, provider\)/);
  assert.match(sql,/FOREIGN KEY \(workspace_id,connection_id\)/);
  assert.match(sql,/FOREIGN KEY \(workspace_id,content_variant_id\)/);
  assert.match(sql,/length\(encrypted_access_token\) >= 32/);
  assert.match(sql,/state_hash ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(sql,/growth_social_oauth_pending_lookup/);
  assert.match(sql,/growth_social_jobs_workspace_schedule/);
  assert.match(sql,/WHERE publish_job_id IS NULL/);
  assert.doesNotMatch(sql,/CREATE TABLE IF NOT EXISTS growth_os\.social_/);
  assert.doesNotMatch(sql,/public\.waitlist_signups/);
  assert.doesNotMatch(sql,/\bDELETE\s+FROM\b|\bTRUNCATE\b|\bDROP\s+TABLE\b/i);
  assert.doesNotMatch(sql,/INSERT INTO growth_os\.social_connections[\s\S]*VALUES\s*\([^$]/);
});

test("token encryption is authenticated and tokens do not remain plaintext", () => {
  const previous = process.env.GROWTH_SOCIAL_ENCRYPTION_KEY;
  process.env.GROWTH_SOCIAL_ENCRYPTION_KEY = Buffer.alloc(32,7).toString("base64");
  try {
    const encrypted = encryptSocialSecret("private-token");
    assert.doesNotMatch(encrypted,/private-token/);
    assert.equal(decryptSocialSecret(encrypted),"private-token");
    assert.throws(() => decryptSocialSecret(`${encrypted.slice(0,-2)}aa`));
  } finally {
    if (previous === undefined) delete process.env.GROWTH_SOCIAL_ENCRYPTION_KEY;
    else process.env.GROWTH_SOCIAL_ENCRYPTION_KEY = previous;
  }
});

test("OAuth state and PKCE values are high entropy and one-way comparable", () => {
  const first = generateOAuthState();
  const second = generateOAuthState();
  assert.notEqual(first,second);
  assert.equal(hashOAuthState(first).length,64);
  assert.notEqual(hashOAuthState(first),first);
  assert.ok(createPkceChallenge(first).length >= 43);
});

test("provider registry is complete and platform capability driven", () => {
  assert.deepEqual(listSocialAdapters().map(adapter => adapter.definition.id),[
    "linkedin","facebook","instagram","x","tiktok","snapchat"
  ]);
  assert.ok(getSocialAdapter("instagram").definition.capabilities.includes("reels"));
  assert.ok(getSocialAdapter("x").definition.supportsPkce);
  assert.throws(() => getSocialAdapter("unofficial"));
});

test("missing provider environment marks only that provider unavailable", () => {
  const previous = process.env.LINKEDIN_CLIENT_ID;
  delete process.env.LINKEDIN_CLIENT_ID;
  try {
    const result = validateSocialEnvironment("linkedin");
    assert.equal(result.available,false);
    assert.ok(result.missing_environment.includes("LINKEDIN_CLIENT_ID"));
  } finally {
    if (previous !== undefined) process.env.LINKEDIN_CLIENT_ID = previous;
  }
});

test("publishing requires every approval, connection and capability condition", () => {
  const blocked = validatePublishReadiness({
    copyApproved:true,mediaApproved:false,destinationValid:true,connected:true,healthy:true,
    requiredCapabilities:["video"],availableCapabilities:["text"]
  });
  assert.equal(blocked.ready,false);
  assert.deepEqual(blocked.missing,["media approval","capability:video"]);
  assert.equal(validatePublishReadiness({
    copyApproved:true,mediaApproved:true,destinationValid:true,connected:true,healthy:true,
    requiredCapabilities:["video"],availableCapabilities:["video"]
  }).ready,true);
});

test("editing approved content resets approval by fingerprint", () => {
  const value = { copy:"Approved",media:[] };
  const crypto = require("crypto") as typeof import("crypto");
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
  assert.equal(approvalMustReset(fingerprint,value),false);
  assert.equal(approvalMustReset(fingerprint,{ ...value,copy:"Changed" }),true);
});

test("OAuth start stores only hashed state and encrypted verifier", async () => {
  const previous = { ...process.env };
  Object.assign(process.env,{
    X_CLIENT_ID:"client",X_REDIRECT_URI:"https://api.example.com/api/growth/social/oauth/x/callback",
    GROWTH_SOCIAL_ENCRYPTION_KEY:Buffer.alloc(32,8).toString("base64")
  });
  const queries: Array<{ sql:string; values:unknown[] }> = [];
  const db = { query: async (sql:string,values:unknown[]=[]) => {
    queries.push({ sql,values });
    return { rows:[] };
  }};
  try {
    const result = await beginSocialOAuth(workspaceId,userId,"x",db as never);
    assert.match(result.authorization_url,/code_challenge=/);
    const oauthInsert = queries.find(item => item.sql.includes("social_oauth_authorisations"))!;
    assert.equal(String(oauthInsert.values[2]).length,64);
    assert.match(String(oauthInsert.values[3]),/^v1\./);
    assert.doesNotMatch(JSON.stringify(queries),/code_challenge_method.*private/i);
  } finally { process.env = previous; }
});

test("OAuth callback atomically consumes state and rejects replay", async () => {
  const queries:string[] = [];
  const db = { query: async (sql:string) => {
    queries.push(sql);
    if (sql.includes("UPDATE growth_os.social_oauth_authorisations")) return { rows:[] };
    return { rows:[] };
  }};
  await assert.rejects(
    completeSocialOAuth(workspaceId,userId,"x","already-used","code",db as never),
    /invalid, expired or already used/
  );
  assert.match(queries[0],/consumed_at IS NULL AND expires_at>now\(\)/);
});
