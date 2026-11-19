"use strict";

/* No administrator token is stored in localStorage, sessionStorage or a URL.
 * The Worker creates a Secure + HttpOnly + SameSite=Strict session cookie.
 * Always render user-submitted text with textContent, never innerHTML.
 */
(() => {
  const apiBase = String(window.HOMEFUNDS_FEEDBACK_CONFIG?.apiBase || "").replace(/\/$/, "");
  const loginPanel = document.getElementById("login-panel");
  const adminPanel = document.getElementById("admin-panel");
  const globalMessage = document.getElementById("global-message");
  const listMessage = document.getElementById("list-message");
  const queue = document.getElementById("feedback-queue");
  const filter = document.getElementById("filter");
  let busy = false;

  function el(tag, className, value) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (value !== undefined) item.textContent = String(value);
    return item;
  }
  function message(node, text, kind = "") {
    node.className = "message" + (kind ? " " + kind : "");
    node.textContent = text;
  }
  function showAdmin(authenticated) {
    loginPanel.classList.toggle("hidden", authenticated);
    adminPanel.classList.toggle("hidden", !authenticated);
    if (!authenticated) queue.replaceChildren();
  }
  async function api(path, {method = "GET", payload} = {}) {
    const response = await fetch(apiBase + path, {
      method,
      credentials: "include",
      cache: "no-store",
      headers:payload === undefined ? {} : {"Content-Type":"application/json"},
      ...(payload === undefined ? {} : {body:JSON.stringify(payload)})
    });
    let data;
    try { data = await response.json(); }
    catch { throw new Error("Invalid response from the feedback service."); }
    if (!response.ok) {
      const problem = new Error(data.error || "The service is temporarily unavailable.");
      problem.status = response.status;
      throw problem;
    }
    return data;
  }
  function formatTime(timestamp) {
    if (!Number.isFinite(Number(timestamp))) return "Unknown time";
    return new Date(Number(timestamp) * 1000).toLocaleString();
  }
  function addMeta(where, value) {
    where.append(el("span", null, value));
  }
  function btn(label, onClick, kind = "") {
    const button = el("button", kind, label);
    button.type = "button";
    button.addEventListener("click", onClick);
    return button;
  }
  async function act(path, method, payload) {
    if (busy) return;
    busy = true;
    try {
      await api(path, {method, payload});
      message(globalMessage, "Saved successfully.", "ok");
      await load();
    } catch (err) {
      if (err.status === 401) showAdmin(false);
      message(globalMessage, err.message, "error");
    } finally { busy = false; }
  }

  function officialReplyForm(feedbackId, parentId = null) {
    const form=el("form","reply-form");
    const heading=el("h4",null,parentId ? "Reply officially to this comment" : "Post an official HomeFunds response");
    const hint=el("p","muted","Official replies appear publicly as HomeFunds Team. Do not share private data.");
    const body=el("textarea");
    body.required=true;
    body.minLength=2;
    body.maxLength=1200;
    body.placeholder="Your official response...";
    body.setAttribute("aria-label","Official HomeFunds response");
    const post=el("button","primary","Publish official response");
    post.type="submit";
    form.append(heading,hint,body,post);
    form.addEventListener("submit",async event=>{
      event.preventDefault();
      if (!form.reportValidity() || busy) return;
      const text=body.value.trim();
      if (!text) return;
      const confirmation=window.confirm("Publish this official reply publicly as HomeFunds Team?");
      if (!confirmation) return;
      await act("/v1/admin/feedback/"+encodeURIComponent(feedbackId)+"/comments",
        "POST",{body:text,parentId});
    });
    return form;
  }
  function commentActions(item, {allowOfficialReply = false} = {}) {
    const row=el("div","row");
    row.style.marginTop="12px";
    const select=el("select");
    select.setAttribute("aria-label","Change comment status");
    for(const [value,label] of [
      ["pending","Awaiting approval"],["published","Published"],["hidden","Hidden"]
    ]) {
      const option=el("option",null,label);
      option.value=value;
      select.append(option);
    }
    select.value=item.status;
    row.append(select,btn("Save status",()=>
      void act("/v1/admin/comments/"+encodeURIComponent(item.id),"PUT",{status:select.value}),"primary"));
    if(item.status==="pending"){
      row.append(btn("Approve comment",()=>void act(
        "/v1/admin/comments/"+encodeURIComponent(item.id),"PUT",{status:"published"}
      ),"primary"));
    }
    if(item.status==="published"){
      row.append(btn("Hide comment",()=>void act(
        "/v1/admin/comments/"+encodeURIComponent(item.id),"PUT",{status:"hidden"}
      ),"danger"));
    }
    row.append(btn("Delete permanently",()=>{
      if(window.prompt("Delete this comment permanently? Type DELETE to confirm.")==="DELETE"){
        void act("/v1/admin/comments/"+encodeURIComponent(item.id),"DELETE");
      }
    },"danger"));
    return row;
  }
  function renderComments(rows) {
    queue.replaceChildren();
    if(!rows.length){
      queue.append(el("p","muted","No comments in this queue."));
      return;
    }
    for(const item of rows){
      const card=el("article","feedback comment-admin");
      card.append(el("h3",null,item.feedback_title||"Suggestion"));
      const meta=el("div","meta");
      addMeta(meta,"Comment date: "+formatTime(item.created_at));
      addMeta(meta,"Status: "+item.status);
      addMeta(meta,"Reports: "+(item.report_count||0));
      if(item.parent_id) addMeta(meta,"Reply to comment: "+item.parent_id.slice(0,8));
      if(item.is_admin) addMeta(meta,"Official HomeFunds Team response");
      card.append(meta,el("p","description",item.body));
      const name=item.is_admin?"HomeFunds Team":
        (item.author_display_name ? item.author_display_name+" (self-provided)" : "Anonymous");
      card.append(el("p","muted","By: "+name+" · Browser tag: "+(item.author_tag||"")));
      card.append(commentActions(item));
      if (item.status==="published" && !item.parent_id) {
        card.append(officialReplyForm(item.feedback_id,item.id));
      }
      queue.append(card);
    }
  }
  function renderCommentReports(rows) {
    queue.replaceChildren();
    if(!rows.length){queue.append(el("p","muted","No reported comments."));return;}
    for(const item of rows){
      const card=el("article","feedback comment-admin");
      card.append(el("h3",null,item.feedback_title||"Suggestion"));
      const meta=el("div","meta");
      addMeta(meta,"Reports: "+(item.report_count||0));
      addMeta(meta,"Last reported: "+formatTime(item.last_report_at));
      addMeta(meta,"Status: "+item.status);
      card.append(meta,el("p","description",item.body));
      card.append(commentActions(item));
      queue.append(card);
    }
  }

  function renderReports(rows) {
    queue.replaceChildren();
    if (!rows.length) {
      queue.append(el("p", "muted", "There are no reported suggestions."));
      return;
    }
    for (const row of rows) {
      const card = el("article", "feedback");
      card.append(el("h3", null, row.title));
      const meta = el("div", "meta");
      addMeta(meta, "Status: " + row.status);
      addMeta(meta, "Reports: " + row.reportCount);
      addMeta(meta, "Last report: " + formatTime(row.lastReportAt));
      addMeta(meta, "Author tag: " + (row.authorTag || "unavailable"));
      card.append(meta);
      const actions = el("div", "row");
      actions.style.marginTop = "10px";
      actions.append(btn("Hide content", () => {
        if (window.confirm("Hide this reported suggestion from public view?")) {
          void act("/v1/admin/feedback/" + encodeURIComponent(row.id), "PUT", {status:"hidden"});
        }
      }, "danger"));
      card.append(actions);
      queue.append(card);
    }
  }
  function renderFeedback(rows) {
    queue.replaceChildren();
    if (!rows.length) {
      queue.append(el("p", "muted", "No submissions in this queue."));
      return;
    }
    for (const item of rows) {
      const card = el("article", "feedback");
      const meta = el("div", "meta");
      meta.append(el("span", "tag", item.category));
      addMeta(meta, "Status: " + item.status);
      addMeta(meta, "Received: " + formatTime(item.created_at));
      addMeta(meta, "Votes: " + item.vote_count);
      if (item.report_count) addMeta(meta, "Reports: " + item.report_count);
      card.append(meta);
      card.append(el("h3", null, item.title));
      card.append(el("p", "description", item.details));

      const who = el("p", "muted");
      const suppliedName = item.submitter_name;
      who.textContent = "Submitted by: " +
        (suppliedName ? suppliedName + " (self-provided, not verified)" : "Anonymous") +
        "  •  Browser tag: " + (item.author_tag || "Unavailable");
      card.append(who);

      const row = el("div", "row");
      row.style.marginTop = "10px";
      const select = el("select");
      select.setAttribute("aria-label", "Change status for " + item.title);
      const statuses = [
        ["pending", "Awaiting approval"],
        ["published", "Published / Under review"],
        ["planned", "Planned"],
        ["in_progress", "In progress"],
        ["completed", "Completed"],
        ["hidden", "Hidden"]
      ];
      for (const [value,label] of statuses) {
        const option = el("option", null, label);
        option.value = value;
        select.append(option);
      }
      select.value = item.status;
      row.append(select);
      row.append(btn("Save status", () =>
        void act("/v1/admin/feedback/" + encodeURIComponent(item.id), "PUT", {status:select.value}), "primary"
      ));
      if (item.status === "pending") {
        row.append(btn("Approve & publish", () =>
          void act("/v1/admin/feedback/" + encodeURIComponent(item.id), "PUT", {status:"published"}), "primary"
        ));
      }
      row.append(btn("Delete permanently", () => {
        const confirmation = window.prompt(
          "Delete this suggestion and all its votes/reports permanently? Type DELETE to confirm."
        );
        if (confirmation === "DELETE") {
          void act("/v1/admin/feedback/" + encodeURIComponent(item.id), "DELETE");
        }
      }, "danger"));
      card.append(row);
      if (["published","planned","in_progress","completed"].includes(item.status)) {
        card.append(officialReplyForm(item.id));
      }
      queue.append(card);
    }
  }
  async function load() {
    message(listMessage, "Loading feedback…");
    queue.replaceChildren();
    try {
      const type = filter.value;
      let path;
      if (type === "reports") path="/v1/admin/reports";
      else if (type === "comment_reports") path="/v1/admin/comment-reports";
      else if (type.startsWith("comments_")) {
        path="/v1/admin/comments?status="+encodeURIComponent(type.slice(9));
      } else path="/v1/admin/feedback?status="+encodeURIComponent(type);
      const data = await api(path);
      const rows=Array.isArray(data.items)?data.items:[];
      if (type === "reports") renderReports(rows);
      else if (type === "comment_reports") renderCommentReports(rows);
      else if (type.startsWith("comments_")) renderComments(rows);
      else renderFeedback(rows);
      message(listMessage, "");
    } catch (err) {
      if (err.status === 401) {
        showAdmin(false);
        message(globalMessage, "Your session expired. Please sign in again.", "error");
      } else message(listMessage, err.message, "error");
    }
  }

  document.getElementById("login-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (busy || !apiBase) return;
    const input = document.getElementById("token");
    const token = input.value.trim();
    if (!token) return;
    busy = true;
    document.getElementById("login-button").disabled = true;
    try {
      await api("/v1/admin/session", {method:"POST", payload:{token}});
      input.value = "";
      showAdmin(true);
      message(globalMessage, "Signed in securely.", "ok");
    } catch (err) {
      message(globalMessage, err.message, "error");
    } finally {
      busy = false;
      document.getElementById("login-button").disabled = false;
    }
    if (!loginPanel.classList.contains("hidden")) return;
    await load();
  });
  document.getElementById("logout-button").addEventListener("click", async () => {
    try {
      await api("/v1/admin/session", {method:"DELETE"});
      showAdmin(false);
      message(globalMessage, "Signed out.", "ok");
    } catch (err) {
      message(globalMessage, "Could not sign out securely: " + err.message, "error");
    }
  });
  document.getElementById("refresh-button").addEventListener("click", () => void load());
  filter.addEventListener("change", () => void load());

  (async () => {
    if (!apiBase || location.protocol !== "https:") {
      message(globalMessage, "Admin sign-in requires the official HTTPS HomeFunds website.", "error");
      document.getElementById("login-button").disabled = true;
      return;
    }
    try {
      const data = await api("/v1/admin/session");
      if (data.authenticated) {
        showAdmin(true);
        await load();
      }
    } catch (err) {
      if (err.status !== 401) message(globalMessage, err.message, "error");
    }
  })();
})();
