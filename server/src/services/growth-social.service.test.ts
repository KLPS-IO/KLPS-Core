import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  approvalMustReset,
  beginSocialOAuth,
  completeLinkedInOAuthFromState,
  completeSocialOAuth,
  getSocialProviderOverview,
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
import {
  buildSocialOAuthRedirect,
  handleLinkedInOAuthCallback
} from "../growth/social/social.routes";

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

test("LinkedIn activation migration adds an explicit member or organization account kind", () => {
  const sql = readFileSync("server/sql/20260730_linkedin_oauth_activation.sql","utf8");
  assert.match(sql,/^BEGIN;/m);
  assert.match(sql,/provider_account_type text/);
  assert.match(sql,/provider_account_type IN \('member','organization'\)/);
  assert.match(sql,/COMMIT;/);
  assert.doesNotMatch(sql,/\bINSERT\b|\bDELETE\b|\bTRUNCATE\b/i);
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

test("LinkedIn authorization requests only OIDC identity scopes", async () => {
  const previous = { ...process.env };
  Object.assign(process.env,{
    LINKEDIN_CLIENT_ID:"linkedin-client",
    LINKEDIN_CLIENT_SECRET:"linkedin-secret",
    LINKEDIN_REDIRECT_URI:"https://api.example.com/api/growth/social/oauth/linkedin/callback",
    GROWTH_SOCIAL_ENCRYPTION_KEY:Buffer.alloc(32,9).toString("base64")
  });
  const queries: Array<{ sql:string; values:unknown[] }> = [];
  const db = { query: async (sql:string,values:unknown[]=[]) => {
    queries.push({ sql,values });
    return { rows:[] };
  }};
  try {
    const result = await beginSocialOAuth(workspaceId,userId,"linkedin",db as never);
    const url = new URL(result.authorization_url);
    assert.equal(url.origin,"https://www.linkedin.com");
    assert.equal(url.pathname,"/oauth/v2/authorization");
    assert.equal(url.searchParams.get("client_id"),"linkedin-client");
    assert.equal(url.searchParams.get("redirect_uri"),process.env.LINKEDIN_REDIRECT_URI);
    assert.equal(url.searchParams.get("scope"),"openid profile");
    assert.equal(url.searchParams.has("code_challenge"),false);
    assert.equal(url.searchParams.has("client_secret"),false);
    assert.equal(url.searchParams.has("w_member_social"),false);
    const oauthInsert = queries.find(item => item.sql.includes("social_oauth_authorisations"))!;
    assert.equal(oauthInsert.values[3],null);
  } finally { process.env = previous; }
});

test("configured LinkedIn activation reports its setup checklist as complete", async () => {
  const previous = { ...process.env };
  Object.assign(process.env,{
    LINKEDIN_CLIENT_ID:"linkedin-client",
    LINKEDIN_CLIENT_SECRET:"linkedin-secret",
    LINKEDIN_REDIRECT_URI:"https://api.example.com/api/growth/social/oauth/linkedin/callback",
    GROWTH_SOCIAL_ENCRYPTION_KEY:Buffer.alloc(32,9).toString("base64")
  });
  const db = { query: async () => ({ rows:[] }) };
  try {
    const overview = await getSocialProviderOverview(workspaceId,db as never);
    const linkedin = overview.find(provider => provider.provider === "linkedin")!;
    assert.equal(linkedin.approval_required,false);
    assert.ok(linkedin.setup_checklist.length > 0);
    assert.ok(linkedin.setup_checklist.every(item => item.status === "configured"));
    assert.deepEqual(linkedin.capabilities,[]);
  } finally { process.env = previous; }
});

test("OAuth restart preserves an existing encrypted connection until replacement succeeds", async () => {
  const previous = { ...process.env };
  Object.assign(process.env,{
    LINKEDIN_CLIENT_ID:"linkedin-client",
    LINKEDIN_CLIENT_SECRET:"linkedin-secret",
    LINKEDIN_REDIRECT_URI:"https://api.example.com/api/growth/social/oauth/linkedin/callback",
    GROWTH_SOCIAL_ENCRYPTION_KEY:Buffer.alloc(32,9).toString("base64")
  });
  const queries:string[] = [];
  const db = { query: async (sql:string) => {
    queries.push(sql);
    return { rows:[] };
  }};
  try {
    await beginSocialOAuth(workspaceId,userId,"linkedin",db as never);
    const connectionUpsert = queries.find(sql => sql.includes("INSERT INTO growth_os.social_connections"))!;
    assert.match(connectionUpsert,/encrypted_access_token IS NULL THEN 'connecting'/);
    assert.doesNotMatch(connectionUpsert,/encrypted_access_token=NULL/);
  } finally { process.env = previous; }
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

test("LinkedIn callback is mounted before founder authentication while OAuth start remains protected", () => {
  const growthRoutes = readFileSync("server/src/growth/growth.routes.ts","utf8");
  const callbackMount = growthRoutes.indexOf('router.use("/social",socialOAuthCallbackRoutes)');
  const founderAuth = growthRoutes.indexOf("router.use(requireDataRoomAuth, requireGrowthFounder)");
  const protectedSocialMount = growthRoutes.indexOf('router.use("/social",socialRoutes)');
  assert.ok(callbackMount >= 0 && callbackMount < founderAuth);
  assert.ok(founderAuth < protectedSocialMount);
  const socialRoutes = readFileSync("server/src/growth/social/social.routes.ts","utf8");
  assert.match(socialRoutes,/router\.post\("\/oauth\/:provider\/start"/);
  assert.doesNotMatch(
    socialRoutes.slice(
      socialRoutes.indexOf("socialOAuthCallbackRoutes.get"),
      socialRoutes.indexOf("router.get(\"/providers\"")
    ),
    /requireDataRoomAuth|requireGrowthFounder/
  );
});

const withLinkedInEnvironment = async (run: () => Promise<void>) => {
  const previousEnvironment = { ...process.env };
  const previousFetch = global.fetch;
  Object.assign(process.env,{
    LINKEDIN_CLIENT_ID:"linkedin-client",
    LINKEDIN_CLIENT_SECRET:"linkedin-client-secret",
    LINKEDIN_REDIRECT_URI:"https://api.example.com/api/growth/social/oauth/linkedin/callback",
    GROWTH_SOCIAL_ENCRYPTION_KEY:Buffer.alloc(32,10).toString("base64")
  });
  try {
    await run();
  } finally {
    global.fetch = previousFetch;
    process.env = previousEnvironment;
  }
};

const callbackDb = (connection = {
  id:"33333333-3333-4333-8333-333333333333",
  provider:"linkedin",
  status:"connected",
  provider_account_name:"Emma Mendez",
  provider_account_type:"member",
  granted_scopes:["openid","profile"],
  discovered_capabilities:[]
}) => {
  const queries: Array<{ sql:string; values:unknown[] }> = [];
  const db = { query: async (sql:string,values:unknown[]=[]) => {
    queries.push({ sql,values });
    if (sql.includes("UPDATE growth_os.social_oauth_authorisations")) {
      return { rows:[{
        redirect_uri:process.env.LINKEDIN_REDIRECT_URI,
        encrypted_code_verifier:null
      }] };
    }
    if (sql.includes("INSERT INTO growth_os.social_connections")) return { rows:[connection] };
    return { rows:[] };
  }};
  return { db,queries };
};

const stateCallbackDb = (
  stateRows: Record<string,unknown>[],
  diagnosticRows: Record<string,unknown>[] = []
) => {
  const connection = {
    id:"33333333-3333-4333-8333-333333333333",
    provider:"linkedin",
    status:"connected",
    provider_account_name:"Emma Mendez",
    provider_account_type:"member",
    granted_scopes:["openid","profile"],
    discovered_capabilities:[]
  };
  const queries: Array<{ sql:string; values:unknown[] }> = [];
  const db = { query: async (sql:string,values:unknown[]=[]) => {
    queries.push({ sql,values });
    if (
      sql.includes("UPDATE growth_os.social_oauth_authorisations a") &&
      sql.includes("FROM growth_os.workspaces w")
    ) return { rows:stateRows.splice(0,1) };
    if (sql.includes("SELECT") && sql.includes("initiator_owns_workspace")) {
      return { rows:diagnosticRows };
    }
    if (sql.includes("INSERT INTO growth_os.social_connections")) return { rows:[connection] };
    return { rows:[] };
  }};
  return { db,queries };
};

const validStateBinding = () => ({
  workspace_id:workspaceId,
  initiated_by:userId,
  redirect_uri:process.env.LINKEDIN_REDIRECT_URI,
  encrypted_code_verifier:null
});

test("LinkedIn callback completes without a session cookie or Authorization header", async () => {
  let received:unknown[] = [];
  let redirectStatus:number | undefined;
  let redirectUrl = "";
  const req = {
    query:{ state:"state-value",code:"code-value",redirect_url:"https://attacker.example" },
    headers:{}
  } as never;
  const res = {
    redirect:(status:number,url:string) => {
      redirectStatus=status;
      redirectUrl=url;
      return undefined;
    }
  } as never;
  const complete = (async (...values:unknown[]) => {
    received=values;
    return { status:"connected" };
  }) as never;
  await handleLinkedInOAuthCallback(req,res,complete);
  assert.deepEqual(received,["state-value","code-value",undefined]);
  assert.equal(redirectStatus,303);
  assert.equal(
    redirectUrl,
    "https://klps.co.uk/innovation-lab/growth/settings?social_provider=linkedin&social_status=connected"
  );
  assert.doesNotMatch(redirectUrl,/attacker|state-value|code-value/);
});

test("LinkedIn state callback atomically validates founder and workspace before provider access", async () => {
  await withLinkedInEnvironment(async () => {
    let calls=0;
    global.fetch = async () => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({
        access_token:"state-bound-token",expires_in:3600,scope:"openid profile"
      }),{ status:200,headers:{ "Content-Type":"application/json" } });
      return new Response(JSON.stringify({ sub:"member-123",name:"Emma Mendez" }),{
        status:200,headers:{ "Content-Type":"application/json" }
      });
    };
    const { db,queries } = stateCallbackDb([validStateBinding()]);
    const result = await completeLinkedInOAuthFromState(
      "valid-state","valid-code",undefined,db as never
    );
    assert.equal(result.status,"connected");
    const stateUpdate = queries[0];
    assert.equal(String(stateUpdate.values[0]).length,64);
    assert.doesNotMatch(JSON.stringify(queries),/valid-state/);
    assert.match(stateUpdate.sql,/a\.provider='linkedin'/);
    assert.match(stateUpdate.sql,/a\.consumed_at IS NULL/);
    assert.match(stateUpdate.sql,/a\.expires_at>now\(\)/);
    assert.match(stateUpdate.sql,/w\.owner_user_id=a\.initiated_by/);
    assert.match(stateUpdate.sql,/u\.role='founder_admin'/);
    const connectionInsert = queries.find(item =>
      item.sql.includes("INSERT INTO growth_os.social_connections")
    )!;
    assert.match(String(connectionInsert.values[5]),/^v1\./);
    assert.equal(
      decryptSocialSecret(String(connectionInsert.values[5])),
      "state-bound-token"
    );
    assert.deepEqual(connectionInsert.values[9],[]);
    assert.equal(calls,2);
  });
});

test("invalid LinkedIn state is rejected before provider access", async () => {
  await withLinkedInEnvironment(async () => {
    let fetchCalled=false;
    global.fetch=async () => {
      fetchCalled=true;
      return new Response();
    };
    const { db } = stateCallbackDb([],[]);
    await assert.rejects(
      completeLinkedInOAuthFromState("invalid","code",undefined,db as never),
      (reason:unknown) => (reason as { code?:string }).code === "social_oauth_state_invalid"
    );
    assert.equal(fetchCalled,false);
  });
});

test("expired LinkedIn state is rejected distinctly before provider access", async () => {
  const { db } = stateCallbackDb([],[{
    provider:"linkedin",expired:true,consumed:false,workspace_exists:true,
    initiator_exists:true,role:"founder_admin",initiator_owns_workspace:true
  }]);
  await assert.rejects(
    completeLinkedInOAuthFromState("expired","code",undefined,db as never),
    (reason:unknown) => (reason as { code?:string }).code === "social_oauth_state_expired"
  );
});

test("replayed and concurrent LinkedIn callbacks cannot reuse consumed state", async () => {
  const { db } = stateCallbackDb([],[{
    provider:"linkedin",expired:false,consumed:true,workspace_exists:true,
    initiator_exists:true,role:"founder_admin",initiator_owns_workspace:true
  }]);
  await assert.rejects(
    completeLinkedInOAuthFromState("consumed","code",undefined,db as never),
    (reason:unknown) => (reason as { code?:string }).code === "social_oauth_state_invalid"
  );
  await withLinkedInEnvironment(async () => {
    let providerCalls=0;
    global.fetch=async () => {
      providerCalls += 1;
      if (providerCalls === 1) return new Response(JSON.stringify({
        access_token:"one-use-token",expires_in:3600,scope:"openid profile"
      }),{ status:200,headers:{ "Content-Type":"application/json" } });
      return new Response(JSON.stringify({ sub:"one-member",name:"Emma Mendez" }),{
        status:200,headers:{ "Content-Type":"application/json" }
      });
    };
    const { db:concurrentDb,queries } = stateCallbackDb([validStateBinding()],[{
      provider:"linkedin",expired:false,consumed:true,workspace_exists:true,
      initiator_exists:true,role:"founder_admin",initiator_owns_workspace:true
    }]);
    const outcomes=await Promise.allSettled([
      completeLinkedInOAuthFromState("same-state","code",undefined,concurrentDb as never),
      completeLinkedInOAuthFromState("same-state","code",undefined,concurrentDb as never)
    ]);
    assert.equal(outcomes.filter(result => result.status === "fulfilled").length,1);
    assert.equal(outcomes.filter(result => result.status === "rejected").length,1);
    assert.equal(providerCalls,2);
    assert.equal(
      queries.filter(item => item.sql.includes("UPDATE growth_os.social_oauth_authorisations a")).length,
      2
    );
  });
});

test("invalid workspace or inactive initiator binding blocks LinkedIn exchange", async () => {
  for (const diagnostic of [
    {
      provider:"linkedin",expired:false,consumed:false,workspace_exists:false,
      initiator_exists:true,role:"founder_admin",initiator_owns_workspace:false
    },
    {
      provider:"linkedin",expired:false,consumed:false,workspace_exists:true,
      initiator_exists:true,role:"revoked_user",initiator_owns_workspace:true
    }
  ]) {
    const { db } = stateCallbackDb([],[diagnostic]);
    await assert.rejects(
      completeLinkedInOAuthFromState("bound-state","code",undefined,db as never),
      (reason:unknown) => (reason as { code?:string }).code === "social_oauth_binding_invalid"
    );
  }
});

test("OAuth redirects use only the allowlisted Growth settings route and safe result codes", () => {
  const previous=process.env.GROWTH_SOCIAL_FRONTEND_URL;
  process.env.GROWTH_SOCIAL_FRONTEND_URL="https://attacker.example/steal?token=private";
  try {
    const success=buildSocialOAuthRedirect({ status:"connected" });
    assert.equal(
      success,
      "https://klps.co.uk/innovation-lab/growth/settings?social_provider=linkedin&social_status=connected"
    );
    const failure=buildSocialOAuthRedirect({
      status:"failed",
      code:"linkedin_identity_lookup_failed private-token raw-provider-error"
    });
    assert.equal(
      failure,
      "https://klps.co.uk/innovation-lab/growth/settings?social_provider=linkedin&social_status=failed&social_error=connection_failed"
    );
    assert.doesNotMatch(failure,/private-token|raw-provider-error|attacker/);
  } finally {
    if (previous === undefined) delete process.env.GROWTH_SOCIAL_FRONTEND_URL;
    else process.env.GROWTH_SOCIAL_FRONTEND_URL=previous;
  }
});

test("callback failures expose only allowlisted codes and never raw LinkedIn errors", async () => {
  let redirectUrl="";
  const warnings:string[]=[];
  const previousWarn=console.warn;
  console.warn=(value?:unknown) => warnings.push(String(value));
  const req = {
    query:{
      state:"state-value",
      error:"access_denied",
      error_description:"private-token linkedin-client-secret"
    },
    headers:{}
  } as never;
  const res = {
    redirect:(_status:number,url:string) => {
      redirectUrl=url;
      return undefined;
    }
  } as never;
  const complete = (async () => {
    throw Object.assign(
      new Error("private-token linkedin-client-secret raw provider description"),
      { code:"social_oauth_provider_error" }
    );
  }) as never;
  try {
    await handleLinkedInOAuthCallback(req,res,complete);
    assert.equal(
      redirectUrl,
      "https://klps.co.uk/innovation-lab/growth/settings?social_provider=linkedin&social_status=failed&social_error=access_denied"
    );
    assert.doesNotMatch(redirectUrl,/private-token|client-secret|description|state-value/);
    assert.deepEqual(warnings,[
      '{"event":"growth_social_oauth_callback_failed","provider":"linkedin","reason":"access_denied"}'
    ]);
  } finally {
    console.warn=previousWarn;
  }
});

test("a denied LinkedIn reconnection preserves existing encrypted credentials", async () => {
  const { db,queries } = stateCallbackDb([validStateBinding()]);
  await assert.rejects(
    completeLinkedInOAuthFromState(
      "valid-state","", "user_cancelled_authorize",db as never
    ),
    (reason:unknown) => (reason as { code?:string }).code === "social_oauth_provider_error"
  );
  const connectionUpdate = queries.find(item =>
    item.sql.includes("last_error_code='provider_authorization_failed'")
  )!;
  assert.match(
    connectionUpdate.sql,
    /CASE WHEN encrypted_access_token IS NULL THEN 'disconnected' ELSE status END/
  );
  assert.doesNotMatch(connectionUpdate.sql,/encrypted_access_token\s*=\s*NULL/);
  assert.doesNotMatch(connectionUpdate.sql,/encrypted_refresh_token\s*=\s*NULL/);
});

test("valid LinkedIn callback verifies member identity and persists only encrypted tokens", async () => {
  await withLinkedInEnvironment(async () => {
    const requests: Array<{ url:string; init?:RequestInit }> = [];
    global.fetch = async (input: string | URL | Request,init?:RequestInit) => {
      requests.push({ url:String(input),init });
      if (requests.length === 1) return new Response(JSON.stringify({
        access_token:"linkedin-access-token",
        refresh_token:"linkedin-refresh-token",
        expires_in:3600,
        scope:"openid profile"
      }),{ status:200,headers:{ "Content-Type":"application/json" } });
      return new Response(JSON.stringify({
        sub:"linkedin-member-123",
        name:"Emma Mendez",
        email:"private@example.com"
      }),{ status:200,headers:{ "Content-Type":"application/json" } });
    };
    const { db,queries } = callbackDb();
    const result = await completeSocialOAuth(
      workspaceId,userId,"linkedin","valid-state","valid-code",db as never
    );
    assert.equal(result.status,"connected");
    assert.equal(result.provider_account_type,"member");
    assert.equal(requests[0].url,"https://www.linkedin.com/oauth/v2/accessToken");
    assert.equal(requests[1].url,"https://api.linkedin.com/v2/userinfo");
    const connectionInsert = queries.find(item => item.sql.includes("INSERT INTO growth_os.social_connections"))!;
    assert.equal(connectionInsert.values[2],"linkedin-member-123");
    assert.equal(connectionInsert.values[4],"member");
    assert.match(String(connectionInsert.values[5]),/^v1\./);
    assert.match(String(connectionInsert.values[6]),/^v1\./);
    assert.equal(decryptSocialSecret(String(connectionInsert.values[5])),"linkedin-access-token");
    assert.equal(decryptSocialSecret(String(connectionInsert.values[6])),"linkedin-refresh-token");
    assert.deepEqual(connectionInsert.values[8],["openid","profile"]);
    assert.deepEqual(connectionInsert.values[9],[]);
    assert.doesNotMatch(JSON.stringify(queries),/private@example\.com/);
    assert.doesNotMatch(JSON.stringify(result),/access-token|refresh-token|private@example\.com/);
  });
});

test("LinkedIn callback rejects invalid state before making a provider request", async () => {
  await withLinkedInEnvironment(async () => {
    let fetchCalled = false;
    global.fetch = async () => {
      fetchCalled = true;
      return new Response();
    };
    const db = { query: async (sql:string) =>
      sql.includes("UPDATE growth_os.social_oauth_authorisations") ? { rows:[] } : { rows:[] }
    };
    await assert.rejects(
      completeSocialOAuth(workspaceId,userId,"linkedin","invalid-state","code",db as never),
      (reason: unknown) => (reason as { code?:string }).code === "social_oauth_state_invalid"
    );
    assert.equal(fetchCalled,false);
  });
});

test("LinkedIn callback rejects a missing authorization code", async () => {
  await withLinkedInEnvironment(async () => {
    const { db } = callbackDb();
    await assert.rejects(
      completeSocialOAuth(workspaceId,userId,"linkedin","valid-state","",db as never),
      (reason: unknown) => (reason as { code?:string }).code === "social_oauth_code_missing"
    );
  });
});

test("LinkedIn authorization errors return a safe response and redact provider secrets", async () => {
  await withLinkedInEnvironment(async () => {
    const { db,queries } = callbackDb();
    const providerValue = "access_denied linkedin-client-secret authorization-code";
    await assert.rejects(
      completeSocialOAuth(workspaceId,userId,"linkedin","valid-state","",db as never,providerValue),
      (reason: unknown) => {
        const error = reason as { code?:string; message?:string };
        assert.equal(error.code,"social_oauth_provider_error");
        assert.doesNotMatch(error.message ?? "",/secret|authorization-code/);
        return true;
      }
    );
    assert.doesNotMatch(JSON.stringify(queries),/linkedin-client-secret|authorization-code/);
  });
});

test("LinkedIn token exchange failure is generic and does not attempt identity lookup", async () => {
  await withLinkedInEnvironment(async () => {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({
        error:"invalid_client",
        error_description:"linkedin-client-secret valid-code"
      }),{ status:401,headers:{ "Content-Type":"application/json" } });
    };
    const { db } = callbackDb();
    await assert.rejects(
      completeSocialOAuth(workspaceId,userId,"linkedin","valid-state","valid-code",db as never),
      (reason: unknown) => {
        const error = reason as { code?:string; message?:string };
        return error.code === "linkedin_token_exchange_failed" &&
          !/linkedin-client-secret|valid-code/.test(error.message ?? "");
      }
    );
    assert.equal(calls,1);
  });
});

test("LinkedIn identity lookup failure never persists the exchanged token", async () => {
  await withLinkedInEnvironment(async () => {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({
        access_token:"temporary-linkedin-token",
        expires_in:3600,
        scope:"openid profile email"
      }),{ status:200,headers:{ "Content-Type":"application/json" } });
      return new Response(JSON.stringify({ message:"denied" }),{
        status:403,headers:{ "Content-Type":"application/json" }
      });
    };
    const { db,queries } = callbackDb();
    await assert.rejects(
      completeSocialOAuth(workspaceId,userId,"linkedin","valid-state","valid-code",db as never),
      (reason: unknown) => (reason as { code?:string }).code === "linkedin_identity_lookup_failed"
    );
    assert.equal(queries.some(item => item.sql.includes("INSERT INTO growth_os.social_connections")),false);
    assert.doesNotMatch(JSON.stringify(queries),/temporary-linkedin-token/);
  });
});
