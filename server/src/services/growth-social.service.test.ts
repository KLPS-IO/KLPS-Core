import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  approvalMustReset,
  beginSocialOAuth,
  completeLinkedInOAuthFromState,
  completeMetaOAuthFromState,
  completeTikTokOAuthFromState,
  completeXOAuthFromState,
  completeSocialOAuth,
  disconnectSocialProvider,
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
  handleLinkedInOAuthCallback,
  handleMetaOAuthCallback,
  handleTikTokOAuthCallback,
  handleXOAuthCallback
} from "../growth/social/social.routes";
import { discoverMetaBusinessIdentities, exchangeMetaAuthorizationCode } from "../growth/social/meta.adapter";
import {
  classifyMetaProviderError,
  createMetaOAuthDiagnostics,
  getFacebookBusinessConfigurationStatus,
  getMetaConfigurationDiagnostics,
  safeMetaProviderError
} from "../growth/social/meta.diagnostics";

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

test("social asset migration is additive, isolated and seeds no provider data", () => {
  const sql = readFileSync("server/sql/20260801_social_connection_assets.sql","utf8");
  assert.match(sql,/^BEGIN;/m);
  assert.match(sql,/CREATE TABLE growth_os\.social_connection_assets/);
  assert.match(sql,/FOREIGN KEY \(workspace_id,social_connection_id\)/);
  assert.match(sql,/UNIQUE \(social_connection_id,provider,provider_asset_type,provider_asset_id\)/);
  assert.match(sql,/provider_asset_username/);
  assert.match(sql,/^COMMIT;/m);
  assert.doesNotMatch(sql,/\bINSERT\b|\bTRUNCATE\b|\bDROP\b/i);
});

test("asset replacement is transaction-bound so failed reconnects preserve prior assets", () => {
  const service = readFileSync("server/src/growth/social/social.service.ts","utf8");
  assert.match(service,/await client\.query\("BEGIN"\)/);
  assert.match(service,/await client\.query\("ROLLBACK"\)/);
  const removal = service.indexOf("DELETE FROM growth_os.social_connection_assets");
  const insertion = service.indexOf("INSERT INTO growth_os.social_connection_assets");
  assert.ok(removal > 0 && insertion > removal);
});

test("disconnect removes only assets belonging to the disconnected workspace connection", async () => {
  const queries:Array<{sql:string;values:unknown[]}> = [];
  const db = { query:async (sql:string,values:unknown[]=[]) => {
    queries.push({sql,values});
    if (sql.includes("UPDATE growth_os.social_connections")) return {rows:[{
      id:"33333333-3333-4333-8333-333333333333",provider:"facebook",status:"revoked"
    }]};
    return {rows:[]};
  }};
  const result = await disconnectSocialProvider(workspaceId,userId,"facebook",db as never);
  assert.equal(result.status,"revoked");
  const deletion = queries.find(item => item.sql.includes("DELETE FROM growth_os.social_connection_assets"))!;
  assert.deepEqual(deletion.values,[workspaceId,"33333333-3333-4333-8333-333333333333"]);
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

test("Meta diagnostics allowlist fields and redact credentials and raw provider details", () => {
  const lines:string[]=[];
  const diagnostics=createMetaOAuthDiagnostics("correlation-1",line=>lines.push(line));
  diagnostics.emit("meta_oauth_code_exchange_failed",{
    internal_error_code:"meta_token_exchange_failed",stage:"code_exchange",meta_http_status:400,
    code:"private-code",access_token:"private-token",raw_error:"provider detail"
  } as never);
  assert.equal(lines.length,1);
  assert.match(lines[0],/"correlation_id":"correlation-1"/);
  assert.doesNotMatch(lines[0],/private-code|private-token|provider detail|access_token|raw_error/);
});

test("Meta provider errors expose only allowlisted classification fields", () => {
  const lines:string[]=[];
  const diagnostics=createMetaOAuthDiagnostics("safe-provider-error",line=>lines.push(line));
  diagnostics.emit("meta_oauth_code_exchange_failed",safeMetaProviderError({error:{
    type:"OAuthException",code:190,error_subcode:36001,is_transient:false,
    message:"private provider message",error_user_msg:"private user message",
    error_user_title:"private title",fbtrace_id:"private trace"
  }}));
  const parsed=JSON.parse(lines[0]);
  assert.equal(parsed.provider_error_type,"OAuthException");
  assert.equal(parsed.provider_error_code,190);
  assert.equal(parsed.provider_error_subcode,36001);
  assert.equal(parsed.provider_error_transient,false);
  assert.equal(parsed.provider_diagnosis,"code_already_used");
  assert.doesNotMatch(lines[0],/private|message|trace|fbtrace/i);
});

test("Meta provider error categories cover credentials, expiry, redirect and unknown failures", () => {
  assert.equal(classifyMetaProviderError(101),"invalid_client_credentials");
  assert.equal(classifyMetaProviderError(190,36000),"invalid_or_expired_code");
  assert.equal(classifyMetaProviderError(191),"redirect_uri_mismatch");
  assert.equal(classifyMetaProviderError(999),"provider_token_failure_unclassified");
});

test("Meta configuration diagnostics detect whitespace and trailing-slash redirect mismatches", () => {
  const previous={...process.env};
  try {
    process.env.META_CLIENT_ID="client ";
    process.env.META_CLIENT_SECRET="secret";
    process.env.META_FACEBOOK_REDIRECT_URI=
      "https://klps-lema-production.up.railway.app/api/growth/social/oauth/facebook/callback/";
    assert.equal(getMetaConfigurationDiagnostics().meta_redirect_equals_expected,false);
    process.env.META_FACEBOOK_REDIRECT_URI=
      " https://klps-lema-production.up.railway.app/api/growth/social/oauth/facebook/callback";
    assert.equal(getMetaConfigurationDiagnostics().meta_redirect_equals_expected,false);
  } finally { process.env=previous; }
});

test("Meta authorization and exchange use the same client ID source and identical redirect URI", async () => {
  const previousEnvironment={...process.env};
  const previousFetch=global.fetch;
  const redirect="https://api.example.com/api/growth/social/oauth/facebook/callback";
  Object.assign(process.env,{
    META_CLIENT_ID:"one-client-source",META_CLIENT_SECRET:"private-secret",
    META_FACEBOOK_REDIRECT_URI:redirect
  });
  let exchangeUrl:URL|undefined;
  global.fetch=async input => {
    exchangeUrl=new URL(String(input));
    return new Response(JSON.stringify({error:{type:"OAuthException",code:101}}),{status:400});
  };
  try {
    const adapter=getSocialAdapter("facebook");
    const authorizationUrl=new URL(adapter.buildAuthorizationUrl({state:"private-state",redirectUri:redirect}));
    await assert.rejects(adapter.exchangeAuthorizationCode({code:"private-code",redirectUri:redirect}));
    assert.equal(authorizationUrl.searchParams.get("client_id"),exchangeUrl!.searchParams.get("client_id"));
    assert.equal(authorizationUrl.searchParams.get("redirect_uri"),exchangeUrl!.searchParams.get("redirect_uri"));
    assert.equal(exchangeUrl!.searchParams.get("redirect_uri"),redirect);
  } finally {
    global.fetch=previousFetch;
    process.env=previousEnvironment;
  }
});

test("provider registry is complete and platform capability driven", () => {
  assert.deepEqual(listSocialAdapters().map(adapter => adapter.definition.id),[
    "linkedin","facebook","instagram","x","tiktok","snapchat"
  ]);
  assert.deepEqual(getSocialAdapter("facebook").definition.capabilities,[]);
  assert.deepEqual(getSocialAdapter("instagram").definition.capabilities,[]);
  assert.equal(getSocialAdapter("instagram").definition.futureReady,true);
  assert.equal(getSocialAdapter("instagram").definition.applicationName,"Discovered through Meta");
  assert.equal(validateSocialEnvironment("instagram").reason,"Discovered through Meta");
  assert.ok(getSocialAdapter("x").definition.supportsPkce);
  assert.throws(() => getSocialAdapter("unofficial"));
});

test("standalone Instagram OAuth is unreachable while Meta asset discovery remains supported", () => {
  const routes=readFileSync("server/src/growth/social/social.routes.ts","utf8");
  const adapter=readFileSync("server/src/growth/social/meta.adapter.ts","utf8");
  assert.match(routes,/provider === "instagram"/);
  assert.match(routes,/social_provider_discovered_through_meta/);
  assert.match(adapter,/provider: "instagram"/);
  assert.match(adapter,/providerAssetType: "instagram_professional"/);
  assert.match(getSocialAdapter("facebook").definition.scopes.join(" "),/instagram_basic/);
});

test("TikTok Login Kit requests identity scope only and keeps posting approval-gated", () => {
  const previous = { ...process.env };
  Object.assign(process.env,{
    TIKTOK_CLIENT_KEY:"tiktok-client-key",
    TIKTOK_CLIENT_SECRET:"tiktok-client-secret",
    TIKTOK_REDIRECT_URI:"https://api.example.com/api/growth/social/oauth/tiktok/callback"
  });
  try {
    const definition=getSocialAdapter("tiktok").definition;
    const url=new URL(getSocialAdapter("tiktok").buildAuthorizationUrl({
      state:"opaque-state",
      redirectUri:process.env.TIKTOK_REDIRECT_URI!
    }));
    assert.equal(`${url.origin}${url.pathname}`,"https://www.tiktok.com/v2/auth/authorize/");
    assert.equal(url.searchParams.get("client_key"),"tiktok-client-key");
    assert.equal(url.searchParams.get("response_type"),"code");
    assert.equal(url.searchParams.get("scope"),"user.info.basic");
    assert.equal(url.searchParams.get("redirect_uri"),process.env.TIKTOK_REDIRECT_URI);
    assert.equal(url.searchParams.get("state"),"opaque-state");
    assert.equal(url.searchParams.getAll("scope").length,1);
    assert.doesNotMatch(url.search,/video(?:\.upload|\.publish)|scope=%22|scope=[^&]*%20/);
    assert.deepEqual(definition.futurePermissions,["video.upload","video.publish"]);
    assert.deepEqual(definition.capabilities,[]);
  } finally { process.env = previous; }
});

test("identity activations keep provider permissions isolated", () => {
  assert.deepEqual(getSocialAdapter("linkedin").definition.scopes,["openid","profile"]);
  assert.deepEqual(getSocialAdapter("facebook").definition.scopes,[
    "public_profile","pages_show_list","instagram_basic"
  ]);
  assert.deepEqual(getSocialAdapter("x").definition.scopes,[
    "users.read","offline.access"
  ]);
  assert.deepEqual(getSocialAdapter("tiktok").definition.scopes,["user.info.basic"]);
});

test("Meta authorization requests identity and discovery permissions only", async () => {
  const previous = { ...process.env };
  Object.assign(process.env,{
    META_CLIENT_ID:"meta-client",
    META_CLIENT_SECRET:"meta-secret",
    META_FACEBOOK_REDIRECT_URI:"https://api.example.com/api/growth/social/oauth/facebook/callback",
    GROWTH_SOCIAL_ENCRYPTION_KEY:Buffer.alloc(32,12).toString("base64")
  });
  const queries: Array<{ sql:string; values:unknown[] }> = [];
  const db = { query: async (sql:string,values:unknown[]=[]) => {
    queries.push({ sql,values });
    return { rows:[] };
  }};
  try {
    const result = await beginSocialOAuth(workspaceId,userId,"facebook",db as never);
    const url = new URL(result.authorization_url);
    assert.equal(url.origin,"https://www.facebook.com");
    assert.equal(url.pathname,"/v23.0/dialog/oauth");
    assert.equal(url.searchParams.get("scope"),"public_profile pages_show_list instagram_basic");
    assert.equal(url.searchParams.has("client_secret"),false);
    for (const forbidden of [
      "pages_manage_posts","pages_read_engagement","read_insights",
      "instagram_content_publish","instagram_manage_insights"
    ]) assert.doesNotMatch(url.searchParams.get("scope") ?? "",new RegExp(forbidden));
  } finally { process.env = previous; }
});

test("Meta business configuration uses config_id without a conflicting scope", async () => {
  const previous={...process.env};
  const configId="123456789012345";
  Object.assign(process.env,{
    META_CLIENT_ID:"meta-client",META_CLIENT_SECRET:"meta-secret",
    META_FACEBOOK_REDIRECT_URI:"https://api.example.com/api/growth/social/oauth/facebook/callback",
    META_FACEBOOK_CONFIG_ID:configId,
    GROWTH_SOCIAL_ENCRYPTION_KEY:Buffer.alloc(32,12).toString("base64")
  });
  const queries:Array<{sql:string;values:unknown[]}>=[];
  const db={query:async(sql:string,values:unknown[]=[])=>{
    queries.push({sql,values});
    return {rows:[]};
  }};
  try {
    const result=await beginSocialOAuth(workspaceId,userId,"facebook",db as never);
    const url=new URL(result.authorization_url);
    assert.equal(url.searchParams.get("config_id"),configId);
    assert.equal(url.searchParams.has("scope"),false);
    assert.ok(url.searchParams.has("state"));
    assert.equal(url.searchParams.get("response_type"),"code");
    const oauthInsert=queries.find(item=>item.sql.includes("social_oauth_authorisations"))!;
    assert.deepEqual(oauthInsert.values[5],[
      "public_profile","pages_show_list","instagram_basic",
      "__grant_mode:business_configuration"
    ]);
    assert.doesNotMatch(JSON.stringify(queries),new RegExp(configId));
  } finally { process.env=previous; }
});

test("Meta explicit-scope fallback records the same callback grant mode", async () => {
  const previous={...process.env};
  Object.assign(process.env,{
    META_CLIENT_ID:"meta-client",META_CLIENT_SECRET:"meta-secret",
    META_FACEBOOK_REDIRECT_URI:"https://api.example.com/api/growth/social/oauth/facebook/callback",
    GROWTH_SOCIAL_ENCRYPTION_KEY:Buffer.alloc(32,12).toString("base64")
  });
  delete process.env.META_FACEBOOK_CONFIG_ID;
  const queries:Array<{sql:string;values:unknown[]}>=[];
  const db={query:async(sql:string,values:unknown[]=[])=>{
    queries.push({sql,values});
    return {rows:[]};
  }};
  try {
    const result=await beginSocialOAuth(workspaceId,userId,"facebook",db as never);
    const url=new URL(result.authorization_url);
    assert.equal(url.searchParams.has("config_id"),false);
    assert.equal(url.searchParams.get("scope"),"public_profile pages_show_list instagram_basic");
    const oauthInsert=queries.find(item=>item.sql.includes("social_oauth_authorisations"))!;
    const requestedScopes=oauthInsert.values[5] as string[];
    assert.equal(requestedScopes[requestedScopes.length-1],"__grant_mode:explicit_scope");
  } finally { process.env=previous; }
});

test("malformed Meta business configuration fails before connection mutation", async () => {
  const previous={...process.env};
  Object.assign(process.env,{
    META_CLIENT_ID:"meta-client",META_CLIENT_SECRET:"meta-secret",
    META_FACEBOOK_REDIRECT_URI:"https://api.example.com/api/growth/social/oauth/facebook/callback",
    META_FACEBOOK_CONFIG_ID:" 123456789 ",
    GROWTH_SOCIAL_ENCRYPTION_KEY:Buffer.alloc(32,12).toString("base64")
  });
  const queries:string[]=[];
  const db={query:async(sql:string)=>{queries.push(sql);return {rows:[]};}};
  try {
    assert.deepEqual(getFacebookBusinessConfigurationStatus(),{
      configured:true,valid:false,active:false,fingerprint:null
    });
    await assert.rejects(
      beginSocialOAuth(workspaceId,userId,"facebook",db as never),
      (reason:unknown)=>(reason as {code?:string}).code === "social_provider_unavailable"
    );
    assert.ok(!queries.some(sql=>sql.includes("social_connections")));
    assert.ok(!queries.some(sql=>sql.includes("social_connection_assets")));
  } finally { process.env=previous; }
});

test("Meta readiness exposes only safe business configuration status", async () => {
  const previous={...process.env};
  const configId="123456789012345";
  Object.assign(process.env,{
    META_CLIENT_ID:"meta-client",META_CLIENT_SECRET:"meta-secret",
    META_FACEBOOK_REDIRECT_URI:"https://api.example.com/api/growth/social/oauth/facebook/callback",
    META_FACEBOOK_CONFIG_ID:configId,
    GROWTH_SOCIAL_ENCRYPTION_KEY:Buffer.alloc(32,12).toString("base64")
  });
  const db={query:async()=>({rows:[]})};
  try {
    const overview=await getSocialProviderOverview(workspaceId,db as never);
    const facebook=overview.find(item=>item.provider === "facebook")!;
    assert.deepEqual(facebook.facebook_business_configuration,{
      config_id_configured:true,mode:"active",config_id_valid:true,
      config_id_fingerprint:getFacebookBusinessConfigurationStatus().fingerprint
    });
    assert.doesNotMatch(JSON.stringify(overview),new RegExp(configId));
  } finally { process.env=previous; }
});

test("Meta diagnostics allowlist grant mode without exposing configuration ID", () => {
  const lines:string[]=[];
  const diagnostics=createMetaOAuthDiagnostics("grant-mode-test",line=>lines.push(line));
  diagnostics.emit("meta_oauth_state_validated",{
    stage:"state_validation",grant_mode:"business_configuration",
    config_id_configured:true
  });
  assert.match(lines[0],/"grant_mode":"business_configuration"/);
  assert.match(lines[0],/"config_id_configured":true/);
  assert.doesNotMatch(lines[0],/123456789012345/);
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

test("provider overview returns only workspace-scoped safe asset metadata", async () => {
  const db = { query: async (sql:string,values:unknown[]) => {
    assert.deepEqual(values,[workspaceId]);
    if (sql.includes("FROM growth_os.social_connections")) return { rows:[{
      id:"33333333-3333-4333-8333-333333333333",provider:"facebook",
      provider_account_name:"Emma Mendez",provider_account_type:"member",status:"connected",
      granted_scopes:["public_profile","pages_show_list","instagram_basic"],
      discovered_capabilities:[],last_successful_check_at:null,last_error_code:null,
      last_error_at:null,connected_at:null,token_expires_at:null
    }] };
    return { rows:[{
      social_connection_id:"33333333-3333-4333-8333-333333333333",
      provider:"facebook",provider_asset_type:"page",provider_asset_id:"page-1",
      provider_asset_name:"KLPS",provider_asset_username:null,status:"active",
      discovered_at:"2026-08-01T00:00:00.000Z",updated_at:"2026-08-01T00:00:00.000Z"
    }] };
  }};
  const overview = await getSocialProviderOverview(workspaceId,db as never);
  const facebook = overview.find(provider => provider.provider === "facebook")!;
  assert.equal(facebook.connection?.assets[0].provider_asset_name,"KLPS");
  assert.doesNotMatch(JSON.stringify(facebook.connection),/encrypted_|access_token|refresh_token|raw_provider/i);
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
    X_CLIENT_ID:"client",X_CLIENT_SECRET:"client-secret",
    X_REDIRECT_URI:"https://api.example.com/api/growth/social/oauth/x/callback",
    GROWTH_SOCIAL_ENCRYPTION_KEY:Buffer.alloc(32,8).toString("base64")
  });
  const queries: Array<{ sql:string; values:unknown[] }> = [];
  const db = { query: async (sql:string,values:unknown[]=[]) => {
    queries.push({ sql,values });
    return { rows:[] };
  }};
  try {
    const result = await beginSocialOAuth(workspaceId,userId,"x",db as never);
    const url=new URL(result.authorization_url);
    assert.equal(`${url.origin}${url.pathname}`,"https://x.com/i/oauth2/authorize");
    assert.equal(url.searchParams.get("client_id"),"client");
    assert.equal(url.searchParams.get("response_type"),"code");
    assert.equal(url.searchParams.get("redirect_uri"),process.env.X_REDIRECT_URI);
    assert.equal(url.searchParams.get("scope"),"users.read offline.access");
    assert.equal(url.searchParams.get("code_challenge_method"),"S256");
    for (const scope of ["tweet.write","media.write","dm.read","dm.write","follows.write","like.write"]) {
      assert.doesNotMatch(url.searchParams.get("scope") ?? "",new RegExp(scope.replace(".","\\.")));
    }
    const oauthInsert = queries.find(item => item.sql.includes("social_oauth_authorisations"))!;
    assert.equal(String(oauthInsert.values[2]).length,64);
    assert.match(String(oauthInsert.values[3]),/^v1\./);
    const verifier=decryptSocialSecret(String(oauthInsert.values[3]));
    assert.equal(url.searchParams.get("code_challenge"),createPkceChallenge(verifier));
    assert.notEqual(url.searchParams.get("code_challenge"),verifier);
    assert.deepEqual(oauthInsert.values[5],["users.read","offline.access"]);
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
    "https://klps.co.uk/innovation-lab/funnel/settings?social_provider=linkedin&social_status=connected"
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
    assert.match(stateUpdate.sql,/a\.provider=\$2/);
    assert.equal(stateUpdate.values[1],"linkedin");
    assert.match(stateUpdate.sql,/a\.consumed_at IS NULL/);
    assert.match(stateUpdate.sql,/a\.expires_at>now\(\)/);
    assert.match(stateUpdate.sql,/w\.owner_user_id=a\.initiated_by/);
    assert.match(stateUpdate.sql,/u\.role IN \('founder_admin','meta_reviewer'\)/);
    const connectionInsert = queries.find(item =>
      item.sql.includes("INSERT INTO growth_os.social_connections")
    )!;
    assert.match(String(connectionInsert.values[5]),/^v1\./);
    assert.equal(
      decryptSocialSecret(String(connectionInsert.values[5])),
      "state-bound-token"
    );
    assert.deepEqual(connectionInsert.values[9],[]);
    assert.ok(queries.some(item => item.sql.includes("DELETE FROM growth_os.social_connection_assets")));
    assert.ok(!queries.some(item => item.sql.includes("INSERT INTO growth_os.social_connection_assets")));
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

test("OAuth redirects use only the allowlisted Funnel settings route and safe result codes", () => {
  const previous=process.env.GROWTH_SOCIAL_FRONTEND_URL;
  process.env.GROWTH_SOCIAL_FRONTEND_URL="https://attacker.example/steal?token=private";
  try {
    const success=buildSocialOAuthRedirect({ status:"connected" });
    assert.equal(
      success,
      "https://klps.co.uk/innovation-lab/funnel/settings?social_provider=linkedin&social_status=connected"
    );
    const failure=buildSocialOAuthRedirect({
      status:"failed",
      code:"linkedin_identity_lookup_failed private-token raw-provider-error"
    });
    assert.equal(
      failure,
      "https://klps.co.uk/innovation-lab/funnel/settings?social_provider=linkedin&social_status=failed&social_error=connection_failed"
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
      "https://klps.co.uk/innovation-lab/funnel/settings?social_provider=linkedin&social_status=failed&social_error=access_denied"
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
    assert.ok(queries.some(item => item.sql.includes("DELETE FROM growth_os.social_connection_assets")));
    assert.ok(!queries.some(item => item.sql.includes("INSERT INTO growth_os.social_connection_assets")));
    assert.doesNotMatch(JSON.stringify(queries),/private@example\.com/);
    assert.doesNotMatch(JSON.stringify(result),/access-token|refresh-token|private@example\.com/);
  });
});

test("Meta callback is public, founder-state bound, and returns a safe frontend redirect", async () => {
  let received:unknown[] = [];
  let redirectStatus:number | undefined;
  let redirectUrl = "";
  const req = {
    query:{ state:"meta-state",code:"meta-code",redirect_url:"https://attacker.example" },
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
  await handleMetaOAuthCallback(req,res,complete);
  assert.deepEqual(received.slice(0,3),["meta-state","meta-code",undefined]);
  assert.equal(received[3],undefined);
  assert.equal(typeof (received[4] as { correlationId?:unknown }).correlationId,"string");
  assert.equal(redirectStatus,303);
  assert.equal(
    redirectUrl,
    "https://klps.co.uk/innovation-lab/funnel/settings?social_provider=facebook&social_status=connected"
  );
  assert.doesNotMatch(redirectUrl,/attacker|meta-state|meta-code/);
});

test("Meta callback error redirect and structured logs expose only controlled values", async () => {
  const originalInfo=console.info;
  const originalWarn=console.warn;
  const lines:string[]=[];
  console.info=(line?:unknown)=>lines.push(String(line));
  console.warn=(line?:unknown)=>lines.push(String(line));
  let redirectUrl="";
  try {
    await handleMetaOAuthCallback(
      {query:{
        state:"private-state",code:"private-code",error_description:"raw provider description"
      }} as never,
      {redirect:(_status:number,url:string)=>{redirectUrl=url;}} as never,
      (async()=>{throw Object.assign(new Error("raw provider error"),{code:"meta_token_exchange_failed"});}) as never
    );
  } finally {
    console.info=originalInfo;
    console.warn=originalWarn;
  }
  assert.equal(
    redirectUrl,
    "https://klps.co.uk/innovation-lab/funnel/settings?social_provider=facebook&social_status=failed&social_error=provider_exchange_failed"
  );
  const parsed=lines.map(line=>JSON.parse(line) as Record<string,unknown>);
  assert.deepEqual(parsed.map(item=>item.event),[
    "meta_oauth_callback_received","meta_oauth_callback_redirected_with_error"
  ]);
  assert.equal(parsed[0].correlation_id,parsed[1].correlation_id);
  assert.doesNotMatch(lines.join("\n"),/private-state|private-code|raw provider|error_description/);
});

test("Meta callback verifies identity, discovers Pages and Instagram, and persists no publishing capability", async () => {
  const previousEnvironment = { ...process.env };
  const previousFetch = global.fetch;
  Object.assign(process.env,{
    META_CLIENT_ID:"meta-client",
    META_CLIENT_SECRET:"meta-client-secret",
    META_FACEBOOK_REDIRECT_URI:"https://api.example.com/api/growth/social/oauth/facebook/callback",
    GROWTH_SOCIAL_ENCRYPTION_KEY:Buffer.alloc(32,13).toString("base64")
  });
  const requests:string[] = [];
  global.fetch = async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (requests.length === 1) return new Response(JSON.stringify({
      access_token:"meta-access-token",expires_in:3600
    }),{ status:200,headers:{ "Content-Type":"application/json" } });
    if (url.includes("fields=id,name") && !url.includes("/accounts")) {
      return new Response(JSON.stringify({ id:"meta-member-1",name:"Emma Mendez" }),{
        status:200,headers:{ "Content-Type":"application/json" }
      });
    }
    if (url.includes("/permissions")) return new Response(JSON.stringify({ data:[
      { permission:"public_profile",status:"granted" },
      { permission:"pages_show_list",status:"granted" },
      { permission:"instagram_basic",status:"granted" },
      { permission:"business_management",status:"granted" }
    ] }),{ status:200,headers:{ "Content-Type":"application/json" } });
    return new Response(JSON.stringify({ data:[{
      id:"page-1",name:"KLPS",
      instagram_business_account:{ id:"ig-1",username:"klps" }
    }] }),{ status:200,headers:{ "Content-Type":"application/json" } });
  };
  const connection = {
    id:"33333333-3333-4333-8333-333333333333",
    provider:"facebook",status:"connected",provider_account_name:"Emma Mendez",
    provider_account_type:"member",granted_scopes:[
      "public_profile","pages_show_list","instagram_basic","business_management"
    ],
    discovered_capabilities:[]
  };
  const queries: Array<{ sql:string; values:unknown[] }> = [];
  const diagnosticLines:string[]=[];
  const diagnostics=createMetaOAuthDiagnostics("meta-success-correlation",line=>diagnosticLines.push(line));
  const db = { query: async (sql:string,values:unknown[]=[]) => {
    queries.push({ sql,values });
    if (sql.includes("UPDATE growth_os.social_oauth_authorisations a")) return { rows:[{
      workspace_id:workspaceId,initiated_by:userId,
      redirect_uri:process.env.META_FACEBOOK_REDIRECT_URI,
      encrypted_code_verifier:null,
      requested_scopes:[
        "public_profile","pages_show_list","instagram_basic",
        "__grant_mode:business_configuration"
      ]
    }] };
    if (sql.includes("INSERT INTO growth_os.social_connections")) return { rows:[connection] };
    return { rows:[] };
  }};
  try {
    const result = await completeMetaOAuthFromState(
      "valid-meta-state","valid-meta-code",undefined,db as never,diagnostics
    );
    assert.equal(result.status,"connected");
    assert.equal(requests.length,4);
    const connectionInsert = queries.find(item =>
      item.sql.includes("INSERT INTO growth_os.social_connections")
    )!;
    assert.equal(connectionInsert.values[2],"meta-member-1");
    assert.equal(connectionInsert.values[4],"member");
    assert.deepEqual(connectionInsert.values[8],[
      "public_profile","pages_show_list","instagram_basic","business_management"
    ]);
    assert.deepEqual(connectionInsert.values[9],[]);
    const assetInsert = queries.find(item =>
      item.sql.includes("INSERT INTO growth_os.social_connection_assets")
    )!;
    assert.deepEqual(JSON.parse(String(assetInsert.values[2])),[
      {
        provider:"facebook",provider_asset_type:"page",provider_asset_id:"page-1",
        provider_asset_name:"KLPS",provider_asset_username:null
      },
      {
        provider:"instagram",provider_asset_type:"instagram_professional",provider_asset_id:"ig-1",
        provider_asset_name:"klps",provider_asset_username:"klps"
      }
    ]);
    assert.ok(queries.some(item => item.sql.includes("DELETE FROM growth_os.social_connection_assets")));
    assert.match(assetInsert.sql,/ON CONFLICT\(social_connection_id,provider,provider_asset_type,provider_asset_id\)/);
    assert.match(String(connectionInsert.values[5]),/^v1\./);
    assert.doesNotMatch(JSON.stringify(result),/meta-access-token|meta-client-secret/);
    assert.ok(diagnosticLines.some(line => line.includes("meta_oauth_connection_completed")));
    assert.ok(diagnosticLines.every(line => line.includes("meta-success-correlation")));
    assert.ok(diagnosticLines.every(line => line.includes('"grant_mode":"business_configuration"')));
    assert.ok(diagnosticLines.every(line => line.includes('"config_id_configured":true')));
    assert.ok(requests.every(url => !url.includes("/assigned_pages")));
    assert.doesNotMatch(diagnosticLines.join("\n"),/valid-meta-code|meta-access-token|meta-client-secret|meta-member-1|page-1|ig-1/);
  } finally {
    global.fetch=previousFetch;
    process.env=previousEnvironment;
  }
});

test("Meta business discovery returns Page and linked Instagram identities without content data", async () => {
  const previousFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ data:[{
    id:"page-1",name:"KLPS",
    instagram_business_account:{ id:"ig-1",username:"klps" }
  }] }),{ status:200,headers:{ "Content-Type":"application/json" } });
  try {
    assert.deepEqual(await discoverMetaBusinessIdentities("temporary-token"),[
      {
        provider:"facebook",providerAssetType:"page",providerAssetId:"page-1",
        providerAssetName:"KLPS",providerAssetUsername:null
      },
      {
        provider:"instagram",providerAssetType:"instagram_professional",providerAssetId:"ig-1",
        providerAssetName:"klps",providerAssetUsername:"klps"
      }
    ]);
  } finally { global.fetch=previousFetch; }
});

test("Meta business discovery truthfully supports a Page without linked Instagram", async () => {
  const previousFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ data:[{
    id:"page-1",name:"KLPS"
  }] }),{ status:200,headers:{ "Content-Type":"application/json" } });
  try {
    assert.deepEqual(await discoverMetaBusinessIdentities("temporary-token"),[{
      provider:"facebook",providerAssetType:"page",providerAssetId:"page-1",
      providerAssetName:"KLPS",providerAssetUsername:null
    }]);
  } finally { global.fetch=previousFetch; }
});

test("Meta business discovery truthfully supports no managed Page", async () => {
  const previousFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ data:[] }),{
    status:200,headers:{ "Content-Type":"application/json" }
  });
  try {
    assert.deepEqual(await discoverMetaBusinessIdentities("temporary-token"),[]);
  } finally { global.fetch=previousFetch; }
});

test("Meta Page discovery requests Page tokens, diagnoses filtering, and never logs tokens", async () => {
  const previousFetch=global.fetch;
  const previousDiagnosticFlag=process.env.META_ASSET_DISCOVERY_DIAGNOSTICS;
  process.env.META_ASSET_DISCOVERY_DIAGNOSTICS="true";
  let requestedUrl="";
  global.fetch=async input => {
    requestedUrl=String(input);
    return new Response(JSON.stringify({accounts:{data:[
      {id:"page-1",name:"KLPS",access_token:"private-page-token",
        instagram_business_account:{id:"ig-1",name:"KLPS",username:"klps"}},
      {id:"page-without-name",access_token:"another-private-token"}
    ]}}),{status:200,headers:{"Content-Type":"application/json"}});
  };
  const lines:string[]=[];
  try {
    const identities=await discoverMetaBusinessIdentities(
      "private-user-token",createMetaOAuthDiagnostics("asset-audit",line=>lines.push(line))
    );
    const url=new URL(requestedUrl);
    assert.equal(url.pathname,"/v23.0/me/accounts");
    assert.equal(
      url.searchParams.get("fields"),
      "id,name,access_token,instagram_business_account{id,name,username}"
    );
    assert.equal(identities.filter(item=>item.provider==="facebook").length,1);
    const completed=lines.find(line=>line.includes("meta_oauth_page_discovery_completed"))!;
    assert.match(completed,/"returned_pages_count":2/);
    assert.match(completed,/"managed_pages_count":1/);
    assert.match(completed,/"discarded_pages_count":1/);
    assert.ok(lines.some(line=>line.includes('"page_access_token_exists":true')));
    assert.doesNotMatch(lines.join("\n"),/private-user-token|private-page-token|another-private-token/);
  } finally {
    global.fetch=previousFetch;
    if (previousDiagnosticFlag === undefined) delete process.env.META_ASSET_DISCOVERY_DIAGNOSTICS;
    else process.env.META_ASSET_DISCOVERY_DIAGNOSTICS=previousDiagnosticFlag;
  }
});

test("Meta exchange failures emit stage-specific diagnostics without raw Meta errors", async () => {
  const definition=getSocialAdapter("facebook").definition;
  const environment={ clientId:"client",clientSecret:"secret",redirectUri:"https://api.example/callback" };
  const cases:Array<{
    name:string;
    responses:Array<{status:number;body:unknown}>;
    event:string;
    code:string;
  }>=[
    {
      name:"token",responses:[{status:400,body:{error:{message:"raw token error",code:190}}}],
      event:"meta_oauth_code_exchange_failed",code:"meta_token_exchange_failed"
    },
    {
      name:"identity",responses:[
        {status:200,body:{access_token:"private-token"}},
        {status:500,body:{error:{message:"raw identity error"}}}
      ],event:"meta_oauth_identity_lookup_failed",code:"meta_identity_lookup_failed"
    },
    {
      name:"permissions",responses:[
        {status:200,body:{access_token:"private-token"}},
        {status:200,body:{id:"private-member-id",name:"Reviewer"}},
        {status:200,body:{data:[{permission:"public_profile",status:"granted"}]}}
      ],event:"meta_oauth_permissions_missing",code:"meta_permissions_missing"
    },
    {
      name:"page",responses:[
        {status:200,body:{access_token:"private-token"}},
        {status:200,body:{id:"private-member-id",name:"Reviewer"}},
        {status:200,body:{data:[
          {permission:"public_profile",status:"granted"},
          {permission:"pages_show_list",status:"granted"},
          {permission:"instagram_basic",status:"granted"}
        ]}},
        {status:500,body:{error:{message:"raw page error"}}}
      ],event:"meta_oauth_page_discovery_failed",code:"meta_page_discovery_failed"
    }
  ];
  const previousFetch=global.fetch;
  try {
    for (const item of cases) {
      const responses=[...item.responses];
      global.fetch=async () => {
        const response=responses.shift()!;
        return new Response(JSON.stringify(response.body),{
          status:response.status,headers:{"Content-Type":"application/json"}
        });
      };
      const lines:string[]=[];
      const diagnostics=createMetaOAuthDiagnostics(`correlation-${item.name}`,line=>lines.push(line));
      await assert.rejects(
        exchangeMetaAuthorizationCode(definition,environment,{
          code:"private-code",redirectUri:environment.redirectUri,diagnostics
        })
      );
      const failure=lines.find(line=>line.includes(`"event":"${item.event}"`));
      assert.ok(failure,`${item.name} failure event`);
      assert.match(failure!,new RegExp(`"internal_error_code":"${item.code}"`));
      assert.match(failure!,new RegExp(`"correlation_id":"correlation-${item.name}"`));
      assert.doesNotMatch(lines.join("\n"),/private-code|private-token|private-member-id|raw .* error/i);
    }
  } finally { global.fetch=previousFetch; }
});

test("Meta callback state rejection and persistence failures emit controlled diagnostics", async () => {
  const stateLines:string[]=[];
  const stateDiagnostics=createMetaOAuthDiagnostics("correlation-state",line=>stateLines.push(line));
  const invalidDb={query:async()=>({rows:[]})};
  await assert.rejects(completeMetaOAuthFromState(
    "private-state","private-code",undefined,invalidDb as never,stateDiagnostics
  ));
  assert.ok(stateLines.some(line => line.includes("meta_oauth_state_rejected") && line.includes("meta_state_invalid")));
  assert.doesNotMatch(stateLines.join("\n"),/private-state|private-code/);

  const previousEnvironment={...process.env};
  const previousFetch=global.fetch;
  Object.assign(process.env,{
    META_CLIENT_ID:"client",META_CLIENT_SECRET:"secret",
    META_FACEBOOK_REDIRECT_URI:"https://api.example/callback",
    GROWTH_SOCIAL_ENCRYPTION_KEY:Buffer.alloc(32,19).toString("base64")
  });
  try {
    for (const failureStage of ["connection","asset"] as const) {
      let request=0;
      global.fetch=async () => {
        request+=1;
        if (request===1) return new Response(JSON.stringify({access_token:"private-token"}),{status:200});
        if (request===2) return new Response(JSON.stringify({id:"private-member-id",name:"Reviewer"}),{status:200});
        if (request===3) return new Response(JSON.stringify({data:[
          {permission:"public_profile",status:"granted"},
          {permission:"pages_show_list",status:"granted"},
          {permission:"instagram_basic",status:"granted"}
        ]}),{status:200});
        return new Response(JSON.stringify({data:[{id:"private-page-id",name:"KLPS"}]}),{status:200});
      };
      const db={query:async(sql:string)=>{
        if(sql.includes("UPDATE growth_os.social_oauth_authorisations a"))return{rows:[{
          workspace_id:workspaceId,initiated_by:userId,redirect_uri:"https://api.example/callback",
          encrypted_code_verifier:null
        }]};
        if(sql.includes("INSERT INTO growth_os.social_connections")){
          if(failureStage==="connection")throw Object.assign(new Error("private database detail"),{code:"23505"});
          return{rows:[{id:"33333333-3333-4333-8333-333333333333",status:"connected"}]};
        }
        if(failureStage==="asset"&&sql.includes("INSERT INTO growth_os.social_connection_assets")){
          throw Object.assign(new Error("private database detail"),{code:"08006"});
        }
        return{rows:[]};
      }};
      const lines:string[]=[];
      const diagnostics=createMetaOAuthDiagnostics(`correlation-${failureStage}`,line=>lines.push(line));
      await assert.rejects(completeMetaOAuthFromState(
        "private-state","private-code",undefined,db as never,diagnostics
      ));
      const expectedCode=failureStage==="connection"
        ? "meta_connection_persistence_failed":"meta_asset_persistence_failed";
      assert.ok(lines.some(line=>line.includes(expectedCode)));
      assert.ok(lines.every(line=>line.includes(`correlation-${failureStage}`)));
      assert.doesNotMatch(lines.join("\n"),/private-state|private-code|private-token|private-member-id|private-page-id|private database detail/);
    }
  } finally {
    global.fetch=previousFetch;
    process.env=previousEnvironment;
  }
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

const withTikTokEnvironment = async (run:() => Promise<void>) => {
  const previousEnvironment={...process.env};
  const previousFetch=global.fetch;
  Object.assign(process.env,{
    TIKTOK_CLIENT_KEY:"tiktok-client",
    TIKTOK_CLIENT_SECRET:"tiktok-client-secret",
    TIKTOK_REDIRECT_URI:"https://api.example.com/api/growth/social/oauth/tiktok/callback",
    GROWTH_SOCIAL_ENCRYPTION_KEY:Buffer.alloc(32,14).toString("base64")
  });
  try { await run(); }
  finally { global.fetch=previousFetch; process.env=previousEnvironment; }
};

const validTikTokStateBinding = () => ({
  workspace_id:workspaceId,
  initiated_by:userId,
  redirect_uri:process.env.TIKTOK_REDIRECT_URI,
  encrypted_code_verifier:null,
  requested_scopes:["user.info.basic"]
});

test("TikTok callback exchanges the code, verifies identity and persists encrypted identity tokens", async () => {
  await withTikTokEnvironment(async () => {
    const requests:Array<{url:string;init?:RequestInit}>=[];
    global.fetch=async (input:string | URL | Request,init?:RequestInit) => {
      requests.push({url:String(input),init});
      if (requests.length === 1) return new Response(JSON.stringify({
        access_token:"tiktok-access-token",refresh_token:"tiktok-refresh-token",
        expires_in:86400,open_id:"tiktok-open-id",
        scope:"user.info.basic,video.list",token_type:"Bearer"
      }),{status:200,headers:{"Content-Type":"application/json"}});
      return new Response(JSON.stringify({
        data:{user:{open_id:"tiktok-open-id",display_name:"TikTok Founder"}},
        error:{code:"ok",message:"",log_id:"safe-log-id"}
      }),{status:200,headers:{"Content-Type":"application/json"}});
    };
    const connection={
      id:"33333333-3333-4333-8333-333333333333",provider:"tiktok",status:"connected",
      provider_account_name:"TikTok Founder",provider_account_type:"member",
      granted_scopes:["user.info.basic"],discovered_capabilities:[]
    };
    const {db,queries}=stateCallbackDb([validTikTokStateBinding()]);
    const originalQuery=db.query;
    db.query=async (sql:string,values:unknown[]=[]) => sql.includes("INSERT INTO growth_os.social_connections")
      ? (queries.push({sql,values}),{rows:[connection]}) : originalQuery(sql,values);
    const result=await completeTikTokOAuthFromState(
      "valid-tiktok-state","decoded-code",undefined,db as never
    );
    assert.equal(result.provider_account_name,"TikTok Founder");
    assert.equal(requests[0].url,"https://open.tiktokapis.com/v2/oauth/token/");
    assert.equal(requests[0].init?.method,"POST");
    assert.equal((requests[0].init?.headers as Record<string,string>)["Content-Type"],
      "application/x-www-form-urlencoded");
    const body=new URLSearchParams(String(requests[0].init?.body));
    assert.deepEqual(Object.fromEntries(body),{
      client_key:"tiktok-client",client_secret:"tiktok-client-secret",
      code:"decoded-code",grant_type:"authorization_code",
      redirect_uri:process.env.TIKTOK_REDIRECT_URI!
    });
    assert.equal(
      requests[1].url,
      "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name"
    );
    assert.equal((requests[1].init?.headers as Record<string,string>).Authorization,
      "Bearer tiktok-access-token");
    const insert=queries.find(item => item.sql.includes("INSERT INTO growth_os.social_connections"))!;
    assert.equal(insert.values[2],"tiktok-open-id");
    assert.equal(insert.values[3],"TikTok Founder");
    assert.equal(decryptSocialSecret(String(insert.values[5])),"tiktok-access-token");
    assert.equal(decryptSocialSecret(String(insert.values[6])),"tiktok-refresh-token");
    assert.deepEqual(insert.values[8],["user.info.basic"]);
    assert.deepEqual(insert.values[9],[]);
    assert.doesNotMatch(JSON.stringify(queries),/tiktok-access-token|tiktok-refresh-token|decoded-code/);
  });
});

test("invalid and replayed TikTok state are rejected before TikTok access", async () => {
  await withTikTokEnvironment(async () => {
    let providerCalls=0;
    global.fetch=async () => { providerCalls += 1; return new Response(); };
    for (const diagnosticRows of [[],[{
      provider:"tiktok",expired:false,consumed:true,workspace_exists:true,
      initiator_exists:true,role:"founder_admin",initiator_owns_workspace:true
    }]]) {
      const {db}=stateCallbackDb([],diagnosticRows);
      await assert.rejects(
        completeTikTokOAuthFromState("invalid-or-replayed","code",undefined,db as never),
        (reason:unknown) => (reason as {code?:string}).code === "social_oauth_state_invalid"
      );
    }
    assert.equal(providerCalls,0);
  });
});

test("TikTok denial and missing code use controlled errors and preserve an existing connection", async () => {
  for (const input of [
    {code:"",providerError:"access_denied",expected:"social_oauth_provider_error"},
    {code:"",providerError:undefined,expected:"social_oauth_code_missing"}
  ]) {
    const {db,queries}=stateCallbackDb([validTikTokStateBinding()]);
    await assert.rejects(
      completeTikTokOAuthFromState("valid-state",input.code,input.providerError,db as never),
      (reason:unknown) => (reason as {code?:string}).code === input.expected
    );
    const update=queries.find(item => item.sql.includes("UPDATE growth_os.social_connections"))!;
    assert.match(update.sql,/CASE WHEN encrypted_access_token IS NULL THEN 'disconnected' ELSE status END/);
    assert.doesNotMatch(update.sql,/encrypted_(?:access|refresh)_token\s*=\s*NULL/);
  }
});

test("TikTok token and user-info failures persist no token and preserve existing credentials", async () => {
  await withTikTokEnvironment(async () => {
    for (const failAt of ["token","identity"] as const) {
      let calls=0;
      global.fetch=async () => {
        calls += 1;
        if (failAt === "token") return new Response(JSON.stringify({
          error:"invalid_grant",error_description:"private code and secret",log_id:"safe-token-log"
        }),{status:400,headers:{"Content-Type":"application/json"}});
        if (calls === 1) return new Response(JSON.stringify({
          access_token:"temporary-token",refresh_token:"temporary-refresh",
          open_id:"open-id",scope:"user.info.basic"
        }),{status:200,headers:{"Content-Type":"application/json"}});
        return new Response(JSON.stringify({
          data:{},error:{code:"access_token_invalid",message:"private raw response",log_id:"safe-user-log"}
        }),{status:401,headers:{"Content-Type":"application/json"}});
      };
      const {db,queries}=stateCallbackDb([validTikTokStateBinding()]);
      await assert.rejects(
        completeTikTokOAuthFromState("valid-state","private-code",undefined,db as never),
        (reason:unknown) => (reason as {code?:string}).code ===
          (failAt === "token" ? "tiktok_token_exchange_failed" : "tiktok_identity_lookup_failed")
      );
      assert.equal(queries.some(item => item.sql.includes("INSERT INTO growth_os.social_connections")),false);
      assert.doesNotMatch(JSON.stringify(queries),/private-code|temporary-token|temporary-refresh|private raw/);
      const update=queries.find(item => item.sql.includes("last_error_code=$3"))!;
      assert.match(update.sql,/CASE WHEN encrypted_access_token IS NULL THEN 'disconnected' ELSE status END/);
    }
  });
});

test("TikTok persistence failure rolls back replacement and reports a controlled failure", async () => {
  await withTikTokEnvironment(async () => {
    let calls=0;
    global.fetch=async () => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({
        access_token:"temporary-access",refresh_token:"temporary-refresh",
        expires_in:86400,open_id:"open-id",scope:"user.info.basic"
      }),{status:200,headers:{"Content-Type":"application/json"}});
      return new Response(JSON.stringify({
        data:{user:{open_id:"open-id",display_name:"TikTok Founder"}},
        error:{code:"ok",message:"",log_id:"safe-log"}
      }),{status:200,headers:{"Content-Type":"application/json"}});
    };
    const {db,queries}=stateCallbackDb([validTikTokStateBinding()]);
    const originalQuery=db.query;
    db.query=async (sql:string,values:unknown[]=[]) => {
      if (sql.includes("INSERT INTO growth_os.social_connections")) {
        queries.push({sql,values});
        throw Object.assign(new Error("private database detail"),{code:"23505"});
      }
      return originalQuery(sql,values);
    };
    await assert.rejects(
      completeTikTokOAuthFromState("valid-state","private-code",undefined,db as never),
      (reason:unknown) => (reason as {code?:string}).code === "tiktok_connection_persistence_failed"
    );
    const failureUpdate=queries.find(item => item.sql.includes("last_error_code=$3"))!;
    assert.match(failureUpdate.sql,/CASE WHEN encrypted_access_token IS NULL THEN 'disconnected' ELSE status END/);
    assert.doesNotMatch(JSON.stringify(queries),/temporary-access|temporary-refresh|private-code|private database/);
  });
});

test("TikTok public callback uses safe redirects and logs only allowlisted provider diagnostics", async () => {
  let redirectUrl="";
  const warnings:string[]=[];
  const previousWarn=console.warn;
  console.warn=value => warnings.push(String(value));
  try {
    await handleTikTokOAuthCallback({query:{
      state:"private-state",code:"private-code",error_description:"private raw description"
    }} as never,{redirect:(_status:number,url:string) => {redirectUrl=url;}} as never,
    (async () => { throw Object.assign(new Error("private token secret raw response"),{
      code:"tiktok_token_exchange_failed",
      providerErrorCategory:"invalid_grant",providerLogId:"safe-log-id"
    }); }) as never);
    assert.equal(redirectUrl,
      "https://klps.co.uk/innovation-lab/funnel/settings?social_provider=tiktok&social_status=failed&social_error=provider_exchange_failed");
    assert.deepEqual(warnings,[
      '{"event":"growth_social_oauth_callback_failed","provider":"tiktok","reason":"provider_exchange_failed","provider_error_category":"invalid_grant","provider_log_id":"safe-log-id"}'
    ]);
    assert.doesNotMatch(`${redirectUrl}${warnings.join("")}`,/private-state|private-code|private token|secret|raw response|raw description/);
  } finally { console.warn=previousWarn; }
});

const withXEnvironment=async (run:() => Promise<void>) => {
  const previousEnvironment={...process.env};
  const previousFetch=global.fetch;
  Object.assign(process.env,{
    X_CLIENT_ID:"x-client-id",X_CLIENT_SECRET:"x-client-secret",
    X_REDIRECT_URI:"https://api.example.com/api/growth/social/oauth/x/callback",
    GROWTH_SOCIAL_ENCRYPTION_KEY:Buffer.alloc(32,16).toString("base64")
  });
  try { await run(); }
  finally { global.fetch=previousFetch; process.env=previousEnvironment; }
};

const validXStateBinding=() => ({
  workspace_id:workspaceId,initiated_by:userId,redirect_uri:process.env.X_REDIRECT_URI,
  encrypted_code_verifier:encryptSocialSecret("private-pkce-verifier"),
  requested_scopes:["users.read","offline.access"]
});

test("X exchanges with confidential-client PKCE, retrieves the authenticated user and persists encrypted identity tokens", async () => {
  await withXEnvironment(async () => {
    const requests:Array<{url:string;init?:RequestInit}>=[];
    global.fetch=async (input:string | URL | Request,init?:RequestInit) => {
      requests.push({url:String(input),init});
      if (requests.length === 1) return new Response(JSON.stringify({
        token_type:"bearer",expires_in:7200,access_token:"x-access-token",
        refresh_token:"x-refresh-token",scope:"users.read offline.access tweet.write"
      }),{status:200,headers:{"Content-Type":"application/json"}});
      return new Response(JSON.stringify({
        data:{id:"x-user-id",name:"Founder Display Name",username:"founder_handle"}
      }),{status:200,headers:{"Content-Type":"application/json"}});
    };
    const connection={
      id:"33333333-3333-4333-8333-333333333333",provider:"x",status:"connected",
      provider_account_name:"@founder_handle",provider_account_type:"member",
      granted_scopes:["users.read","offline.access"],discovered_capabilities:[]
    };
    const {db,queries}=stateCallbackDb([validXStateBinding()]);
    const originalQuery=db.query;
    db.query=async (sql:string,values:unknown[]=[]) => sql.includes("INSERT INTO growth_os.social_connections")
      ? (queries.push({sql,values}),{rows:[connection]}) : originalQuery(sql,values);
    const result=await completeXOAuthFromState("valid-x-state","private-code",undefined,db as never);
    assert.equal(result.provider_account_name,"@founder_handle");
    assert.equal(requests[0].url,"https://api.x.com/2/oauth2/token");
    assert.equal(requests[0].init?.method,"POST");
    const headers=requests[0].init?.headers as Record<string,string>;
    assert.equal(headers["Content-Type"],"application/x-www-form-urlencoded");
    assert.equal(headers.Authorization,
      `Basic ${Buffer.from("x-client-id:x-client-secret").toString("base64")}`);
    const body=new URLSearchParams(String(requests[0].init?.body));
    assert.deepEqual(Object.fromEntries(body),{
      code:"private-code",grant_type:"authorization_code",
      redirect_uri:process.env.X_REDIRECT_URI!,code_verifier:"private-pkce-verifier"
    });
    assert.equal(body.has("client_secret"),false);
    assert.equal(requests[1].url,"https://api.x.com/2/users/me");
    assert.equal((requests[1].init?.headers as Record<string,string>).Authorization,
      "Bearer x-access-token");
    const insert=queries.find(item => item.sql.includes("INSERT INTO growth_os.social_connections"))!;
    assert.equal(insert.values[2],"x-user-id");
    assert.equal(insert.values[3],"@founder_handle");
    assert.equal(decryptSocialSecret(String(insert.values[5])),"x-access-token");
    assert.equal(decryptSocialSecret(String(insert.values[6])),"x-refresh-token");
    assert.deepEqual(insert.values[8],["users.read","offline.access"]);
    assert.deepEqual(insert.values[9],[]);
    assert.doesNotMatch(JSON.stringify(queries),/private-code|private-pkce-verifier|x-access-token|x-refresh-token|x-client-secret/);
  });
});

test("invalid and replayed X state are rejected before provider access", async () => {
  await withXEnvironment(async () => {
    let providerCalls=0;
    global.fetch=async () => {providerCalls += 1; return new Response();};
    for (const diagnosticRows of [[],[{
      provider:"x",expired:false,consumed:true,workspace_exists:true,
      initiator_exists:true,role:"founder_admin",initiator_owns_workspace:true
    }]]) {
      const {db}=stateCallbackDb([],diagnosticRows);
      await assert.rejects(
        completeXOAuthFromState("invalid-or-replayed","code",undefined,db as never),
        (reason:unknown) => (reason as {code?:string}).code === "social_oauth_state_invalid"
      );
    }
    assert.equal(providerCalls,0);
  });
});

test("X denial, missing code and provider failures preserve existing encrypted credentials", async () => {
  await withXEnvironment(async () => {
    for (const input of [
      {code:"",providerError:"access_denied",expected:"social_oauth_provider_error"},
      {code:"",providerError:undefined,expected:"social_oauth_code_missing"}
    ]) {
      const {db,queries}=stateCallbackDb([validXStateBinding()]);
      await assert.rejects(
        completeXOAuthFromState("valid-state",input.code,input.providerError,db as never),
        (reason:unknown) => (reason as {code?:string}).code === input.expected
      );
      const update=queries.find(item => item.sql.includes("UPDATE growth_os.social_connections"))!;
      assert.match(update.sql,/CASE WHEN encrypted_access_token IS NULL THEN 'disconnected' ELSE status END/);
      assert.doesNotMatch(update.sql,/encrypted_(?:access|refresh)_token\s*=\s*NULL/);
    }
    global.fetch=async () => new Response(JSON.stringify({
      error:"invalid_grant",error_description:"private raw response"
    }),{status:400,headers:{"Content-Type":"application/json"}});
    const {db,queries}=stateCallbackDb([validXStateBinding()]);
    await assert.rejects(
      completeXOAuthFromState("valid-state","private-code",undefined,db as never),
      (reason:unknown) => (reason as {code?:string}).code === "x_token_exchange_failed"
    );
    const update=queries.find(item => item.sql.includes("last_error_code=$3"))!;
    assert.match(update.sql,/CASE WHEN encrypted_access_token IS NULL THEN 'disconnected' ELSE status END/);
    assert.doesNotMatch(JSON.stringify(queries),/private-code|private-pkce-verifier|private raw/);
  });
});

test("X callback is public, cookie-independent and redirects with allowlisted results", async () => {
  let received:unknown[]=[];
  let redirectUrl="";
  await handleXOAuthCallback({query:{state:"state",code:"code"},headers:{}} as never,{
    redirect:(_status:number,url:string) => {redirectUrl=url;}
  } as never,(async (...values:unknown[]) => {received=values; return {status:"connected"};}) as never);
  assert.deepEqual(received,["state","code",undefined]);
  assert.equal(redirectUrl,
    "https://klps.co.uk/innovation-lab/funnel/settings?social_provider=x&social_status=connected");
  assert.doesNotMatch(redirectUrl,/state|code|cookie/);
  const routes=readFileSync("server/src/growth/social/social.routes.ts","utf8");
  assert.match(routes,/socialOAuthCallbackRoutes\.get\(\s*"\/oauth\/x\/callback"/);
  assert.deepEqual(getSocialAdapter("x").definition.capabilities,[]);
});
