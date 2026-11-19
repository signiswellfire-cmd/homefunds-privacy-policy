import assert from "node:assert/strict";
import {test} from "node:test";
import worker from "../src/index.js";

const ORIGIN = "https://homefunds.signiswellfire.com";
const URL_BASE = "https://feedback-api.signiswellfire.com";
function mockEnv() {
  const calls = [];
  const env = {
    SITE_ORIGIN:ORIGIN,
    TURNSTILE_HOSTNAME:"homefunds.signiswellfire.com",
    TURNSTILE_SECRET:"unused-test-turnstile-secret",
    VOTER_COOKIE_SECRET:"test-voter-hmac-key",
    RATE_LIMIT_SECRET:"test-rate-limiter-hmac-key",
    ADMIN_TOKEN:"admin-secret-abcdefghijklmnopqrstuvwxyz-1234567890-abcdef",
    DB: {
      prepare(sql) {
        const q = {sql,bindings:[]};
        calls.push(q);
        return {
          bind(...args) {
            q.bindings = args;
            return this;
          },
          async run() {return {meta:{changes:1}};},
          async all() {return {results:[]};},
          async first() {return null;}
        };
      }
    }
  };
  return {env,calls};
}
function req(path, {
  method = "GET", origin = ORIGIN, token, cookie, body
} = {}) {
  const headers = {};
  if (origin) headers.Origin = origin;
  if (token) headers.Authorization = "Bearer " + token;
  if (cookie) headers.Cookie = cookie;
  if (body) headers["Content-Type"]="application/json";
  return new Request(URL_BASE + path,{
    method,
    headers,
    ...(body ? {body:JSON.stringify(body)} : {})
  });
}
test("owner login issues an HttpOnly secure SameSite=Strict session cookie",async()=>{
  const {env}=mockEnv();
  const response=await worker.fetch(req("/v1/admin/session",{
    method:"POST",body:{token:env.ADMIN_TOKEN}
  }),env);
  assert.equal(response.status,200);
  assert.equal((await response.json()).authenticated,true);
  const cookie=response.headers.get("set-cookie");
  assert.match(cookie,/hf_feedback_admin=v1\./);
  assert.match(cookie,/HttpOnly/);
  assert.match(cookie,/Secure/);
  assert.match(cookie,/SameSite=Strict/);
  assert.match(cookie,/Max-Age=604800/);
  assert.equal(response.headers.get("Access-Control-Allow-Credentials"),"true");
  const session=cookie.split(";")[0];
  const check=await worker.fetch(req("/v1/admin/session",{cookie:session}),env);
  assert.equal(check.status,200);
  assert.deepEqual(await check.json(),{authenticated:true});
  const admin=await worker.fetch(req("/v1/admin/feedback?status=pending",{cookie:session}),env);
  assert.equal(admin.status,200);
  assert.deepEqual(await admin.json(),{items:[]});

  // Cross-origin requests cannot use the browser's valid session.
  const foreign=await worker.fetch(req("/v1/admin/feedback",{cookie:session,origin:"https://attacker.example"}),env);
  assert.equal(foreign.status,401);
  assert.equal(foreign.headers.get("Access-Control-Allow-Origin"),null);

  const tampered=session.slice(0,-1)+(session.endsWith("a")?"b":"a");
  const broken=await worker.fetch(req("/v1/admin/feedback",{cookie:tampered}),env);
  assert.equal(broken.status,401);
});
test("a wrong token is refused without granting a session",async()=>{
  const {env}=mockEnv();
  const res=await worker.fetch(req("/v1/admin/session",{
    method:"POST",body:{token:"incorrect-admin-token-long-enough"}
  }),env);
  assert.equal(res.status,401);
  assert.equal(res.headers.get("Set-Cookie"),null);
});
test("sign-out clears the browser's admin cookie",async()=>{
  const {env}=mockEnv();
  const result=await worker.fetch(req("/v1/admin/session",{method:"DELETE"}),env);
  assert.equal(result.status,200);
  assert.match(result.headers.get("Set-Cookie"),/Max-Age=0/);
  assert.equal((await result.json()).authenticated,false);
});
test("legacy CLI Bearer token remains supported without a browser origin",async()=>{
  const {env}=mockEnv();
  const result=await worker.fetch(req("/v1/admin/feedback?status=pending",{
    origin:null,token:env.ADMIN_TOKEN
  }),env);
  assert.equal(result.status,200);
});
test("unauthenticated moderation and deletion are blocked",async()=>{
  const {env,calls}=mockEnv();
  const id="178f05f5-8479-4274-a761-40fcc28eb813";
  const result=await worker.fetch(req("/v1/admin/feedback/"+id,{method:"DELETE"}),env);
  assert.equal(result.status,401);
  assert.equal(calls.some(x=>x.sql.includes("DELETE FROM feedback")),false);
});
test("private delete executes only with a valid owner session",async()=>{
  const {env,calls}=mockEnv();
  const login=await worker.fetch(req("/v1/admin/session",{method:"POST",body:{token:env.ADMIN_TOKEN}}),env);
  const session=login.headers.get("Set-Cookie").split(";")[0];
  const id="178f05f5-8479-4274-a761-40fcc28eb813";
  const deletion=await worker.fetch(req("/v1/admin/feedback/"+id,{method:"DELETE",cookie:session}),env);
  assert.equal(deletion.status,200);
  assert.deepEqual(await deletion.json(),{id,deleted:true});
  assert.ok(calls.some(q=>q.sql.includes("DELETE FROM feedback WHERE id=?") && q.bindings[0]===id));
});
