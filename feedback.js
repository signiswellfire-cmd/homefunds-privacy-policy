"use strict";

(() => {
  const config = window.HOMEFUNDS_FEEDBACK_CONFIG || {};
  const apiBase = String(config.apiBase || "").replace(/\/$/, "");
  const siteKey = String(config.turnstileSiteKey || "");
  const board = document.getElementById("suggestions");
  const form = document.getElementById("suggest-form");
  const formStatus = document.getElementById("form-message");
  const systemStatus = document.getElementById("system-message");
  const submitButton = document.getElementById("submit-button");
  const sort = document.getElementById("sort");
  let widgetId = null;
  let busy = false;
  const blockKey = "hf_feedback_blocked_authors";
  let blocked;
  try { blocked = new Set(JSON.parse(localStorage.getItem(blockKey) || "[]")); }
  catch { blocked = new Set(); }
  let lastItems = [];

  function element(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = String(text);
    return item;
  }

  function status(target, message, kind) {
    target.className = "status" + (kind ? " " + kind : "");
    target.textContent = message;
  }

  function getChallengeToken() {
    return widgetId !== null && window.turnstile
      ? window.turnstile.getResponse(widgetId) : "";
  }

  function resetChallenge() {
    if (widgetId !== null && window.turnstile) window.turnstile.reset(widgetId);
  }

  async function api(path, init = {}) {
    const response = await fetch(apiBase + path, {
      credentials: "include",
      cache: "no-store",
      ...init
    });
    let data;
    try { data = await response.json(); } catch { throw new Error("The feedback service sent an unreadable response."); }
    if (!response.ok) throw new Error(data.error || "The feedback service is unavailable.");
    return data;
  }


  function showVerificationPrompt(target, action) {
    status(target, "Complete the verification at the top of this page before " + action + ".", "error");
    document.getElementById("turnstile").scrollIntoView({behavior:"smooth",block:"center"});
  }

  async function reportDiscussionComment(feedbackId, commentId, reason) {
    if (busy) return;
    const token=getChallengeToken();
    if (!token) return showVerificationPrompt(systemStatus,"reporting a comment");
    busy=true;
    try {
      await api("/v1/feedback/" + encodeURIComponent(feedbackId) +
        "/comments/" + encodeURIComponent(commentId) + "/report", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({reason,turnstileToken:token})
      });
      status(systemStatus,"Comment report received for moderator review.","success");
    } catch (err) {status(systemStatus,err.message,"error");}
    finally {busy=false;resetChallenge();}
  }

  function discussionComposer(feedbackId, renderAgain) {
    let replyTo=null;
    const wrap=element("form","comment-form");
    const title=element("h4",null,"Join the discussion");
    const hint=element("p","muted","Approved comments are public; comments are reviewed first.");
    const inputLabel=element("label",null,"Your comment (10–1200 characters)");
    const body=element("textarea");
    body.required=true;
    body.minLength=10;
    body.maxLength=1200;
    body.placeholder="Share an idea or ask a question about this suggestion";
    const nameLabel=element("label",null,"Display name (optional, shown publicly)");
    const name=element("input");
    name.type="text";
    name.maxLength=60;
    name.placeholder="Leave blank for anonymous";
    const termsLabel=element("label","checkboxrow");
    const terms=document.createElement("input");
    terms.type="checkbox";
    terms.required=true;
    termsLabel.append(terms,element("span",null,"I accept the Community Rules and understand approved comments are public."));
    const controls=element("div","actions");
    const submit=element("button","primary","Post comment for review");
    submit.type="submit";
    const cancel=element("button","ghost","Cancel reply");
    cancel.type="button";
    cancel.classList.add("hidden");
    cancel.addEventListener("click",()=>{
      replyTo=null;
      title.textContent="Join the discussion";
      cancel.classList.add("hidden");
    });
    controls.append(submit,cancel);
    const feedback=element("div","status");
    feedback.setAttribute("role","status");
    wrap.append(title,hint,inputLabel,body,nameLabel,name,termsLabel,controls,feedback);
    wrap.addEventListener("submit",async event=>{
      event.preventDefault();
      if (busy || !wrap.reportValidity()) return;
      const token=getChallengeToken();
      if (!token) return showVerificationPrompt(feedback,"posting a comment");
      busy=true;
      submit.disabled=true;
      try {
        const result=await api("/v1/feedback/"+encodeURIComponent(feedbackId)+"/comments",{
          method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({
            body:body.value.trim(),displayName:name.value.trim(),
            acceptedTerms:terms.checked,parentId:replyTo,turnstileToken:token
          })
        });
        status(feedback,result.duplicate
          ? "Your comment was already submitted for review."
          : "Comment received and awaiting moderator approval.","success");
        body.value="";
        terms.checked=false;
        replyTo=null;
        title.textContent="Join the discussion";
        cancel.classList.add("hidden");
        await renderAgain();
      } catch(err) {status(feedback,err.message,"error");}
      finally {busy=false;submit.disabled=false;resetChallenge();}
    });
    return {node:wrap,replyTo:(comment)=>{
      replyTo=comment.id;
      const by=comment.isAdmin ? "HomeFunds Team" :
        (comment.displayName || "Anonymous "+String(comment.authorTag||"").slice(0,6));
      title.textContent="Reply to "+by;
      cancel.classList.remove("hidden");
      body.focus();
      wrap.scrollIntoView({behavior:"smooth",block:"center"});
    }};
  }

  async function discussionFor(item, panel) {
    panel.replaceChildren();
    panel.append(element("p","muted","Loading discussion…"));
    try {
      const payload=await api("/v1/feedback/"+encodeURIComponent(item.id)+"/comments");
      const comments=Array.isArray(payload.items) ? payload.items : [];
      panel.replaceChildren();
      panel.append(element("h4",null,"Discussion ("+comments.length+")"));
      const list=element("div","comments");
      const roots=new Map();
      const composer=discussionComposer(item.id,()=>discussionFor(item,panel));
      const visible=comments.filter(c=>c.isAdmin || !blocked.has(c.authorTag));
      for(const comment of visible) {
        const outer=element("article","comment"+(comment.isAdmin?" official":""));
        const header=element("div","comment-head");
        header.append(element("strong",null,comment.isAdmin
          ? "HomeFunds Team" : comment.displayName || ("Anonymous "+String(comment.authorTag||"").slice(0,6))));
        if (comment.isAdmin) header.append(element("span","pill","Official response"));
        if(Number.isFinite(Number(comment.createdAt))) {
          header.append(element("span",null,new Date(Number(comment.createdAt)*1000).toLocaleString()));
        }
        outer.append(header,element("p",null,comment.body));
        const actions=element("div","actions");
        if (!comment.parentId) {
          const reply=element("button","ghost","Reply");
          reply.type="button";
          reply.addEventListener("click",()=>composer.replyTo(comment));
          actions.append(reply);
        }
        const report=element("button","ghost","Report comment");
        report.type="button";
        const reportPanel=element("div","report-form hidden");
        const reason=element("select");
        for(const [key,label] of [
          ["privacy","Private information"],["abuse","Harassment"],
          ["spam","Spam"],["other","Other inappropriate content"]
        ]) {
          const option=element("option",null,label);
          option.value=key;
          reason.append(option);
        }
        reason.setAttribute("aria-label","Reason for reporting comment");
        const send=element("button","ghost","Send report");
        send.type="button";
        send.addEventListener("click",()=>void reportDiscussionComment(item.id,comment.id,reason.value));
        reportPanel.append(reason,send);
        report.addEventListener("click",()=>reportPanel.classList.toggle("hidden"));
        actions.append(report);
        if(!comment.isAdmin && comment.authorTag) {
          const block=element("button","ghost","Block author");
          block.type="button";
          block.addEventListener("click",()=>{
            blocked.add(comment.authorTag);
            localStorage.setItem(blockKey,JSON.stringify([...blocked]));
            void discussionFor(item,panel);
          });
          actions.append(block);
        }
        outer.append(actions,reportPanel);
        const replies=element("div","comment-replies");
        outer.append(replies);
        roots.set(comment.id,replies);
        const parent=comment.parentId && roots.get(comment.parentId);
        (parent||list).append(outer);
      }
      if (!visible.length) list.append(element("p","muted",
        comments.length ? "Comments from blocked authors are hidden." : "No published comments yet."));
      panel.append(list,composer.node);
    } catch(err) {
      panel.replaceChildren(element("p","muted","Unable to load discussion: "+err.message));
    }
  }

  function renderList(items) {
    lastItems = items;
    const visible = items.filter(item => !blocked.has(item.authorTag));
    const unblockButton = document.getElementById("unblock-button");
    unblockButton.classList.toggle("hidden", blocked.size === 0);
    board.replaceChildren();
    if (!visible.length) {
      const panel = element("div", "panel");
      panel.append(element("h3", null, "No published suggestions yet."));
      panel.append(element("p", "muted", items.length
        ? "Suggestions from blocked authors are hidden. Choose Unblock authors to see them again."
        : "Be the first to send an idea. It will appear after review."));
      board.append(panel);
      return;
    }
    for (const item of visible) {
      const card = element("article", "item");
      const vote = element("button", "vote" + (item.voted ? " active" : ""));
      vote.type = "button";
      vote.setAttribute("aria-label", (item.voted ? "Remove vote from " : "Vote for ") + item.title);
      vote.setAttribute("aria-pressed", String(Boolean(item.voted)));
      vote.append(element("strong", null, String(item.voteCount)));
      vote.append(element("span", null, item.voted ? "Voted" : "Vote"));
      vote.addEventListener("click", () => voteFor(item.id, Boolean(item.voted)));

      const details = element("div", "item-copy");
      const meta = element("div", "meta");
      meta.append(element("span", "pill", item.categoryLabel || item.category));
      meta.append(element("span", "pill", item.statusLabel || item.status));
      if (item.authorTag) {
        meta.append(element("span", null, "Anonymous author " + item.authorTag.slice(0, 6)));
      }
      const date = Number(item.createdAt);
      if (Number.isFinite(date)) {
        meta.append(element("span", null, new Date(date * 1000).toLocaleDateString()));
      }
      details.append(meta);
      details.append(element("h3", null, item.title));
      details.append(element("p", "description", item.details));
      const actions = element("div", "actions");
      const report = element("button", "ghost", "Report content");
      report.type = "button";
      const reportForm = element("div", "report-form hidden");
      const reason = element("select");
      reason.setAttribute("aria-label", "Report reason");
      for (const [key, label] of [
        ["privacy", "Personal or private information"],
        ["abuse", "Harassment or abusive content"],
        ["spam", "Spam or advertising"],
        ["other", "Other inappropriate content"]
      ]) {
        const option = element("option", null, label);
        option.value = key;
        reason.append(option);
      }
      const sendReport = element("button", "ghost", "Send report");
      sendReport.type = "button";
      sendReport.addEventListener("click", () => reportItem(item.id, reason.value));
      reportForm.append(reason, sendReport);
      report.addEventListener("click", () => reportForm.classList.toggle("hidden"));
      actions.append(report);
      if (item.authorTag) {
        const block = element("button", "ghost", "Block author");
        block.type = "button";
        block.addEventListener("click", () => {
          blocked.add(item.authorTag);
          localStorage.setItem(blockKey, JSON.stringify([...blocked]));
          renderList(lastItems);
          status(systemStatus, "Posts by this anonymous author are now hidden on this device.", "success");
        });
        actions.append(block);
      }
      const discussion=element("button","ghost","Discussion ("+Number(item.commentCount||0)+")");
      discussion.type="button";
      const thread=element("section","thread hidden");
      discussion.addEventListener("click",()=>{
        const isHidden=thread.classList.toggle("hidden");
        if (!isHidden) void discussionFor(item,thread);
      });
      actions.prepend(discussion);
      details.append(actions,reportForm,thread);
      card.append(vote, details);
      board.append(card);
    }
  }

  async function load() {
    if (!apiBase || !siteKey) {
      status(systemStatus, "Community feedback is being configured. Submissions are not open yet.", "error");
      submitButton.disabled = true;
      board.replaceChildren();
      return;
    }
    try {
      status(systemStatus, "", "");
      const payload = await api("/v1/feedback?sort=" + encodeURIComponent(sort.value));
      renderList(Array.isArray(payload.items) ? payload.items : []);
    } catch (error) {
      status(systemStatus, error.message, "error");
      board.replaceChildren();
    }
  }

  async function reportItem(id, reason) {
    if (busy) return;
    const token = getChallengeToken();
    if (!token) {
      status(systemStatus, "Complete the spam check below before reporting.", "error");
      document.getElementById("turnstile").scrollIntoView({behavior:"smooth",block:"center"});
      return;
    }
    busy = true;
    try {
      await api("/v1/feedback/" + encodeURIComponent(id) + "/report", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({reason,turnstileToken:token})
      });
      status(systemStatus, "Your report has been queued for review.", "success");
    } catch (error) {
      status(systemStatus, error.message, "error");
    } finally {
      busy = false;
      resetChallenge();
    }
  }

  async function voteFor(id, alreadyVoted) {
    if (busy) return;
    const token = getChallengeToken();
    if (!token) {
      status(systemStatus, "Complete the spam check below before voting.", "error");
      document.getElementById("turnstile").scrollIntoView({behavior:"smooth",block:"center"});
      return;
    }
    busy = true;
    try {
      await api("/v1/feedback/" + encodeURIComponent(id) + "/vote", {
        method: alreadyVoted ? "DELETE" : "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({turnstileToken:token})
      });
      status(systemStatus, alreadyVoted ? "Vote removed." : "Vote recorded.", "success");
      await load();
    } catch (error) {
      status(systemStatus, error.message, "error");
    } finally {
      busy = false;
      resetChallenge();
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || !form.reportValidity()) return;
    const token = getChallengeToken();
    if (!token) {
      status(formStatus, "Complete the verification before submitting.", "error");
      return;
    }
    busy = true;
    submitButton.disabled = true;
    try {
      await api("/v1/feedback", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          title:document.getElementById("title").value.trim(),
          details:document.getElementById("details").value.trim(),
          category:document.getElementById("category").value,
          submitterName:document.getElementById("submitter-name").value.trim(),
          acceptedTerms:document.getElementById("accept-terms").checked,
          turnstileToken:token
        })
      });
      form.reset();
      status(formStatus, "Thank you. Your feedback was received and is awaiting public review.", "success");
    } catch (error) {
      status(formStatus, error.message, "error");
    } finally {
      busy = false;
      submitButton.disabled = false;
      resetChallenge();
    }
  });

  sort.addEventListener("change", load);
  document.getElementById("unblock-button").addEventListener("click", () => {
    blocked.clear();
    localStorage.removeItem(blockKey);
    renderList(lastItems);
    status(systemStatus, "Blocked authors have been restored.", "success");
  });
  document.getElementById("add-button").addEventListener("click", () => {
    document.getElementById("submit-panel").scrollIntoView({behavior:"smooth",block:"start"});
    document.getElementById("title").focus({preventScroll:true});
  });

  document.addEventListener("DOMContentLoaded", () => {
    if (siteKey && window.turnstile) {
      widgetId = window.turnstile.render("#turnstile", {
        sitekey:siteKey,
        theme:"light",
        action:"feedback"
      });
    } else if (siteKey) {
      status(formStatus, "Spam verification could not load. Check your connection.", "error");
      submitButton.disabled = true;
    }
    void load();
  });
})();
