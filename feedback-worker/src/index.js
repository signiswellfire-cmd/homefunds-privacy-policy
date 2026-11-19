// HomeFunds public feedback API — Cloudflare Worker + D1.
// Deploy only after reviewing privacy/legal copy and configuring all secrets.
// Never store household finance data, Google tokens, email, or raw IPs.

const VISIBLE = ["published", "planned", "in_progress", "completed"];
const ALL_STATUSES = ["pending", ...VISIBLE, "hidden"];
const TYPES = ["feature", "improvement", "bug"];
const typeLabels = {feature:"Feature request", improvement:"Improvement", bug:"Bug report"};
const statusLabels = {
  published:"Under review", planned:"Planned", in_progress:"In progress", completed:"Completed"
};
const textEncoder = new TextEncoder();

function safeOrigin(request, env) {
  return request.headers.get("Origin") === env.SITE_ORIGIN;
}
function responseJson(data, status, request, env, moreHeaders = {}) {
  const headers = new Headers({
    "Content-Type":"application/json; charset=utf-8",
    "Cache-Control":"no-store",
    "X-Content-Type-Options":"nosniff",
    "Referrer-Policy":"no-referrer",
    "Vary":"Origin",
    ...moreHeaders
  });
  if (safeOrigin(request, env)) {
    headers.set("Access-Control-Allow-Origin", env.SITE_ORIGIN);
    headers.set("Access-Control-Allow-Credentials", "true");
    headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, PUT, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }
  return new Response(JSON.stringify(data), {status, headers});
}
function error(message, code, request, env) {
  return responseJson({error:message}, code, request, env);
}
function hex(bytes) {
  return Array.from(bytes, x => x.toString(16).padStart(2, "0")).join("");
}
function fromHex(value) {
  if (!/^[a-f0-9]{64}$/.test(value)) return null;
  return Uint8Array.from(value.match(/.{2}/g), x => parseInt(x, 16));
}
async function keyFor(secret) {
  return crypto.subtle.importKey(
    "raw", textEncoder.encode(secret),
    {name:"HMAC", hash:"SHA-256"}, false, ["sign", "verify"]
  );
}
async function signHex(secret, message) {
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", await keyFor(secret), textEncoder.encode(message))));
}
async function validateSignedCookie(request, secret) {
  const header = request.headers.get("Cookie") || "";
  const match = header.match(/(?:^|;\s*)hf_feedback_voter=(v1\.([0-9a-f-]{36})\.([a-f0-9]{64}))(?:;|$)/);
  if (!match) return null;
  const tokenBytes = fromHex(match[3]);
  if (!tokenBytes) return null;
  const valid = await crypto.subtle.verify(
    "HMAC", await keyFor(secret), tokenBytes, textEncoder.encode("voter:" + match[2])
  );
  return valid ? match[2] : null;
}
async function voter(request, env, create = false) {
  let id = await validateSignedCookie(request, env.VOTER_COOKIE_SECRET);
  let cookie = null;
  if (!id && create) {
    id = crypto.randomUUID();
    const sig = await signHex(env.VOTER_COOKIE_SECRET, "voter:" + id);
    cookie = "hf_feedback_voter=v1." + id + "." + sig +
      "; Max-Age=31536000; Path=/; Secure; HttpOnly; SameSite=Lax";
  }
  return {
    hash:id ? await signHex(env.VOTER_COOKIE_SECRET, "vote:" + id) : "",
    cookie
  };
}
async function parseBody(request) {
  const length = Number(request.headers.get("Content-Length") || "0");
  if (length > 6000) throw new Error("Request too large.");
  const text = await request.text();
  if (text.length > 6000) throw new Error("Request too large.");
  try {
    const json = JSON.parse(text);
    if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error();
    return json;
  } catch {
    throw new Error("Invalid request body.");
  }
}
function preventPersonalData(title, details) {
  const value = title + " " + details;
  // Prevent the common accidental disclosure of contact details or Drive links.
  // This is not a replacement for human moderation.
  if (/(https?:\/\/|www\.)/i.test(value)) return "Do not include website or Google Drive links.";
  if (/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(value)) return "Do not include email addresses.";
  return null;
}
async function verifyChallenge(token, request, env) {
  if (typeof token !== "string" || token.length < 10 || token.length > 2048) return false;
  const data = new URLSearchParams({
    secret:env.TURNSTILE_SECRET,
    response:token
  });
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) data.set("remoteip", ip);
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method:"POST",
      headers:{"Content-Type":"application/x-www-form-urlencoded"},
      body:data.toString()
    });
    if (!res.ok) return false;
    const parsed = await res.json();
    return parsed.success === true &&
      parsed.hostname === env.TURNSTILE_HOSTNAME &&
      parsed.action === "feedback";
  } catch {
    return false;
  }
}
async function checkRateLimit(request, env, action, maxCount) {
  // Keys are HMAC digests; never persist or publish visitors' raw IP addresses.
  const day = new Date().toISOString().slice(0, 10);
  const ip = request.headers.get("CF-Connecting-IP") || "missing";
  const bucket = await signHex(env.RATE_LIMIT_SECRET, day + ":" + action + ":" + ip);
  const result = await env.DB.prepare(
    "INSERT INTO rate_limits(bucket, hits, day) VALUES(?, 1, ?) " +
    "ON CONFLICT(bucket) DO UPDATE SET hits=hits+1 WHERE hits < ?"
  ).bind(bucket, day, maxCount).run();
  return Number(result.meta?.changes || 0) > 0;
}
async function adminAuthorized(request, env) {
  const supplied = request.headers.get("Authorization") || "";
  const expected = "Bearer " + env.ADMIN_TOKEN;
  if (!env.ADMIN_TOKEN || supplied.length !== expected.length) return false;
  // Avoid ordinary variable-time string comparison of the admin secret.
  const providedHash = await crypto.subtle.digest("SHA-256", textEncoder.encode(supplied));
  const expectedHash = await crypto.subtle.digest("SHA-256", textEncoder.encode(expected));
  const a = new Uint8Array(providedHash), b = new Uint8Array(expectedHash);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}
async function listPublic(request, env, url) {
  const sort = url.searchParams.get("sort") === "new" ? "new" : "top";
  const identity = await voter(request, env);
  const order = sort === "new" ? "f.created_at DESC" : "voteCount DESC, f.created_at DESC";
  const rows = await env.DB.prepare(
    "SELECT f.id, f.title, f.details, f.author_tag AS authorTag, f.category, f.status, f.created_at AS createdAt, " +
    "COUNT(v.voter_hash) AS voteCount, MAX(CASE WHEN v.voter_hash = ? THEN 1 ELSE 0 END) AS voted " +
    "FROM feedback AS f LEFT JOIN votes AS v ON v.feedback_id=f.id " +
    "WHERE f.status IN ('published','planned','in_progress','completed') " +
    "GROUP BY f.id ORDER BY " + order + " LIMIT 100"
  ).bind(identity.hash).all();
  return responseJson({
    items:(rows.results || []).map(row => ({
      ...row,
      voted:row.voted === 1,
      categoryLabel:typeLabels[row.category] || "Feedback",
      statusLabel:statusLabels[row.status] || "Under review"
    }))
  }, 200, request, env);
}
async function submit(request, env) {
  if (!safeOrigin(request, env)) return error("Submission origin not allowed.", 403, request, env);
  const body = await parseBody(request);
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const details = typeof body.details === "string" ? body.details.trim() : "";
  if (title.length < 8 || title.length > 100 || details.length < 20 || details.length > 1500 || !TYPES.includes(body.category)) {
    return error("Enter a valid title (8–100 characters), explanation (20–1500), and type.", 400, request, env);
  }
  if (body.acceptedTerms !== true || body.adultConfirmed !== true) {
    return error("Adults must agree to the Community Rules before submitting.", 400, request, env);
  }
  const privacyError = preventPersonalData(title, details);
  if (privacyError) return error(privacyError, 400, request, env);
  if (!await verifyChallenge(body.turnstileToken, request, env)) {
    return error("Verification expired or failed. Please try again.", 403, request, env);
  }
  if (!await checkRateLimit(request, env, "submit", 3)) {
    return error("Daily submission limit reached. Try again tomorrow.", 429, request, env);
  }
  const id = crypto.randomUUID(), now = Math.floor(Date.now()/1000);
  const identity = await voter(request, env, true);
  const authorTag = identity.hash.slice(0,16);
  await env.DB.prepare(
    "INSERT INTO feedback(id,title,details,author_tag,category,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)"
  ).bind(id,title,details,authorTag,body.category,"pending",now,now).run();
  return responseJson(
    {id,status:"pending",message:"Submitted for moderation."},
    202, request, env, identity.cookie ? {"Set-Cookie":identity.cookie} : {}
  );
}
async function voteOn(request, env, id) {
  if (!safeOrigin(request, env)) return error("Voting origin not allowed.", 403, request, env);
  const body = await parseBody(request);
  if (!await verifyChallenge(body.turnstileToken, request, env)) {
    return error("Verification expired or failed. Please try again.", 403, request, env);
  }
  const item = await env.DB.prepare("SELECT status FROM feedback WHERE id=?").bind(id).first();
  if (!item || !VISIBLE.includes(item.status)) return error("Suggestion not found.", 404, request, env);
  if (!await checkRateLimit(request, env, "vote", 40)) {
    return error("Voting limit reached. Try again tomorrow.", 429, request, env);
  }
  const identity = await voter(request, env, request.method === "POST");
  if (!identity.hash) return responseJson({voted:false}, 200, request, env);
  if (request.method === "DELETE") {
    const r = await env.DB.prepare("DELETE FROM votes WHERE feedback_id=? AND voter_hash=?").bind(id,identity.hash).run();
    return responseJson({voted:false,removed:Number(r.meta?.changes || 0) > 0}, 200, request, env);
  }
  const r = await env.DB.prepare(
    "INSERT OR IGNORE INTO votes(feedback_id,voter_hash,created_at) VALUES(?,?,?)"
  ).bind(id,identity.hash,Math.floor(Date.now()/1000)).run();
  const newVote = Number(r.meta?.changes || 0) > 0;
  return responseJson({voted:true}, newVote ? 201 : 200, request, env,
    identity.cookie ? {"Set-Cookie":identity.cookie} : {});
}
async function reportSuggestion(request, env, id) {
  if (!safeOrigin(request, env)) return error("Report origin not allowed.",403,request,env);
  const body = await parseBody(request);
  const allowed = ["privacy", "abuse", "spam", "other"];
  if (!allowed.includes(body.reason)) return error("Choose a report reason.",400,request,env);
  if (!await verifyChallenge(body.turnstileToken, request, env)) {
    return error("Verification expired or failed. Please try again.",403,request,env);
  }
  if (!await checkRateLimit(request,env,"report",15)) {
    return error("Reporting limit reached. Try again tomorrow.",429,request,env);
  }
  const target = await env.DB.prepare("SELECT status FROM feedback WHERE id=?").bind(id).first();
  if (!target || !VISIBLE.includes(target.status)) return error("Suggestion not found.",404,request,env);
  const reporter = await voter(request, env, true);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO reports(feedback_id,reporter_hash,reason,created_at) VALUES(?,?,?,?)"
  ).bind(id,reporter.hash,body.reason,Math.floor(Date.now()/1000)).run();
  return responseJson(
    {received:true,message:"Report queued for owner review."},202,request,env,
    reporter.cookie ? {"Set-Cookie":reporter.cookie} : {}
  );
}

async function adminList(request, env, url) {
  if (!await adminAuthorized(request, env)) return error("Unauthorized.", 401, request, env);
  const status = ALL_STATUSES.includes(url.searchParams.get("status")) ? url.searchParams.get("status") : "pending";
  const rows = await env.DB.prepare(
    "SELECT f.*, (SELECT COUNT(*) FROM votes v WHERE v.feedback_id=f.id) AS vote_count, " +
    "(SELECT COUNT(*) FROM reports r WHERE r.feedback_id=f.id) AS report_count " +
    "FROM feedback f WHERE status=? ORDER BY created_at DESC LIMIT 100"
  ).bind(status).all();
  return responseJson({items:rows.results || []}, 200, request, env);
}
async function adminReports(request, env) {
  if (!await adminAuthorized(request, env)) return error("Unauthorized.",401,request,env);
  const rows = await env.DB.prepare(
    "SELECT f.id,f.title,f.status,f.author_tag AS authorTag, " +
    "COUNT(r.reporter_hash) AS reportCount, MAX(r.created_at) AS lastReportAt " +
    "FROM reports r INNER JOIN feedback f ON f.id=r.feedback_id " +
    "GROUP BY f.id ORDER BY reportCount DESC, lastReportAt DESC LIMIT 100"
  ).all();
  return responseJson({items:rows.results || []},200,request,env);
}

async function adminUpdate(request, env, id) {
  if (!await adminAuthorized(request, env)) return error("Unauthorized.", 401, request, env);
  const body = await parseBody(request);
  if (!ALL_STATUSES.includes(body.status)) return error("Invalid status.", 400, request, env);
  const result = await env.DB.prepare(
    "UPDATE feedback SET status=?, updated_at=? WHERE id=?"
  ).bind(body.status, Math.floor(Date.now()/1000), id).run();
  if (!result.meta?.changes) return error("Suggestion not found.",404,request,env);
  return responseJson({id,status:body.status},200,request,env);
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      if (request.method === "GET" && path === "/v1/health") {
        return responseJson({ready:Boolean(env.DB && env.TURNSTILE_SECRET && env.ADMIN_TOKEN)},200,request,env);
      }
      if (!env.DB || !env.SITE_ORIGIN || !env.TURNSTILE_HOSTNAME ||
          !env.TURNSTILE_SECRET || !env.VOTER_COOKIE_SECRET ||
          !env.RATE_LIMIT_SECRET || !env.ADMIN_TOKEN) {
        return error("Feedback service is not configured.",503,request,env);
      }
      if (request.method === "OPTIONS") {
        return safeOrigin(request,env)
          ? responseJson({},200,request,env)
          : error("Origin not allowed.",403,request,env);
      }
      if (request.method === "GET" && path === "/v1/feedback") return await listPublic(request,env,url);
      if (request.method === "POST" && path === "/v1/feedback") return await submit(request,env);
      const vote = path.match(/^\/v1\/feedback\/([0-9a-f-]{36})\/vote$/);
      if (vote && ["POST","DELETE"].includes(request.method)) return await voteOn(request,env,vote[1]);
      const report = path.match(/^\/v1\/feedback\/([0-9a-f-]{36})\/report$/);
      if (report && request.method === "POST") return await reportSuggestion(request,env,report[1]);
      if (request.method === "GET" && path === "/v1/admin/feedback") return await adminList(request,env,url);
      if (request.method === "GET" && path === "/v1/admin/reports") return await adminReports(request,env);
      const mod = path.match(/^\/v1\/admin\/feedback\/([0-9a-f-]{36})$/);
      if (mod && request.method === "PUT") return await adminUpdate(request,env,mod[1]);
      return error("Not found.",404,request,env);
    } catch (e) {
      if (e?.message === "Invalid request body." || e?.message === "Request too large.") {
        return error(e.message,400,request,env);
      }
      // No raw error text, SQL details or secrets in public responses.
      return error("Service temporarily unavailable.",500,request,env);
    }
  },
  async scheduled(event, env) {
    if (!env.DB) return;
    // Keep only the previous seven days of HMAC-derived rate-limit counters.
    const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    await env.DB.prepare("DELETE FROM rate_limits WHERE day < ?").bind(cutoff).run();
  }
};
