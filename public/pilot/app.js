import { proposalTerms } from "./form.js";

const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? "").replaceAll(
    /[&<>"']/gu,
    (c) =>
      ({
        '"': "&quot;",
        "&": "&amp;",
        "'": "&#39;",
        "<": "&lt;",
        ">": "&gt;",
      })[c],
  );
let editing;
let orgId;
let state;
let tab = "affiliations";
const labels = {
  contractor: "Contractor",
  electedRepresentative: "Elected representative",
  employee: "Employee",
  member: "Member",
  volunteer: "Volunteer",
};
const statuses = {
  active: "Confirmed",
  declined: "Declined",
  expired: "Expired",
  pending: "Awaiting approval",
  publishing: "Publishing pending",
  revoked: "Withdrawn",
};
const names = {
  activated: "Affiliation activated",
  approved: "Version approved",
  changed: "Changes proposed",
  declined: "Proposal declined",
  "event-published": "Event published",
  "grant-created": "Publishing access granted",
  "grant-revoked": "Publishing access removed",
  proposed: "Proposal created",
  "publish-denied": "Publishing denied",
  "request-denied": "Request denied",
  revoked: "Affiliation withdrawn",
  superseded: "Previous version ended",
};
const date = (s) =>
  new Date(s).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
const dt = (s) =>
  new Date(s).toLocaleString("en-GB", {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
  });
const localInput = (d) =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
const organisation = () => state.organisations.find((o) => o.did === orgId);
const person = (did) =>
  state.people.find((p) => p.did === did)?.name ??
  state.publicCredentials.find((p) => p.terms.subject === did)?.terms.subject ??
  did;
const button = (action, label, id, extra = "") =>
  `<button data-action="${action}" data-id="${esc(id)}" ${extra}>${label}</button>`;
async function api(path, body) {
  const r = await fetch(
    path,
    body
      ? {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
          method: "POST",
        }
      : {},
  );
  const data = await r.json();
  if (!r.ok) {
    throw new Error(data.error ?? "Could not complete the request.");
  }
  return data;
}
function onAsync(target, name, handler) {
  target.addEventListener(name, (event) => {
    handler(event).catch((error) => {
      notice(error.message ?? "The request failed.", true);
    });
  });
}
function notice(message, error = false) {
  $("#notice").innerHTML =
    `<div class="notice ${error ? "error" : ""}">${esc(message)}</div>`;
}
async function refresh() {
  $("#content").setAttribute("aria-busy", "true");
  try {
    state = await api("/api/state");
    orgId = state.organisations.some((o) => o.did === orgId)
      ? orgId
      : state.organisations[0]?.did;
    render();
  } finally {
    $("#content").setAttribute("aria-busy", "false");
  }
}
function empty(title, detail) {
  return `<div class="empty"><strong>${title}</strong>${detail}</div>`;
}
const scopeLabel = (scope) => (scope === "*" ? "Whole organisation" : scope);
function currentProposals() {
  return state.proposals.filter(
    (proposal) => proposal.terms.organisationDid === orgId,
  );
}
function publicProposals() {
  return state.publicCredentials.filter(
    (proposal) => proposal.terms.organisationDid === orgId,
  );
}
function proposalStatus(proposal) {
  if (["revoked", "declined"].includes(proposal.state)) {
    return proposal.state;
  }
  if (Date.parse(proposal.terms.expiresAt) <= Date.now()) {
    return "expired";
  }
  if (proposal.verification.valid) {
    return "active";
  }
  return ["pending", "publishing"].includes(proposal.state)
    ? proposal.state
    : "unavailable";
}
function needsApproval(proposal) {
  if (proposalStatus(proposal) !== "pending") {
    return false;
  }
  return proposal.terms.subject === state.person?.did
    ? !proposal.subjectApproved
    : organisation().canReview && !proposal.organisationApprovedBy;
}
function activeGrant(grant, proposal) {
  return (
    proposal?.verification.valid &&
    !grant.revoked &&
    grant.action === "events.publish" &&
    grant.proposalId === proposal.id &&
    grant.proposalRevision === proposal.revision &&
    grant.subject === proposal.terms.subject &&
    grant.organisationDid === proposal.terms.organisationDid &&
    grant.scope === proposal.terms.scope &&
    Date.parse(grant.expiresAt) > Date.now()
  );
}
function grantFor(proposal) {
  return state.grants.find((grant) => activeGrant(grant, proposal));
}
function statusLabel(proposal, status) {
  if (status === "pending") {
    if (needsApproval(proposal)) {
      return "Waiting for you";
    }
    return proposal.subjectApproved
      ? "Waiting for organisation"
      : "Waiting for person";
  }
  return statuses[status] ?? "Cannot verify";
}
function nextStep(proposal, status) {
  if (status === "pending") {
    if (needsApproval(proposal)) {
      return "Review the role and terms. Your approval will confirm this affiliation.";
    }
    return proposal.subjectApproved
      ? `${organisation().name} needs to approve. No action is needed from you.`
      : `${person(proposal.terms.subject)} needs to approve. The affiliation is not active yet.`;
  }
  if (status === "publishing") {
    return "Both parties have approved. Publication is pending. Refresh the status or try again.";
  }
  if (status === "unavailable") {
    return Date.parse(proposal.terms.validFrom) > Date.now()
      ? `Starts on ${dt(proposal.terms.validFrom)}. No access before then.`
      : "Verification failed. Publishing access is paused. Refresh the status to try again.";
  }
  return "";
}
function primaryActions(proposal, status, publicOnly) {
  if (publicOnly) {
    return proposal.verification.valid
      ? button("verify", "View proof", proposal.id)
      : "";
  }
  if (needsApproval(proposal)) {
    return (
      button("approve", "Approve affiliation", proposal.id, 'class="primary"') +
      button("decline", "Decline", proposal.id)
    );
  }
  if (status === "publishing") {
    return button("retry", "Try again", proposal.id);
  }
  if (
    proposal.verification.valid &&
    organisation().canReview &&
    !grantFor(proposal)
  ) {
    return button("grant", "Grant publishing access", proposal.id);
  }
  return "";
}
function moreActions(proposal, status, publicOnly) {
  if (publicOnly || ["declined", "revoked", "expired"].includes(status)) {
    return "";
  }
  const actions = [button("change", "Propose changes", proposal.id)];
  if (proposal.verification.valid) {
    actions.push(button("verify", "View proof", proposal.id));
  }
  const grant = grantFor(proposal);
  if (grant && organisation().canReview) {
    actions.push(button("revoke-grant", "Remove publishing access", grant.id));
  }
  if (status === "pending" && !needsApproval(proposal)) {
    actions.push(button("decline", "Cancel request", proposal.id));
  }
  if (["active", "publishing"].includes(proposal.state)) {
    actions.push(
      button(
        "revoke",
        "End affiliation and access",
        proposal.id,
        'class="danger"',
      ),
    );
  }
  return `<details class="more-actions"><summary>More actions</summary><div class="actions">${actions.join("")}</div></details>`;
}
function accessLine(proposal) {
  const grant = grantFor(proposal);
  return `<p class="access ${grant ? "yes" : ""}">${grant ? `✓ Can publish events until ${date(grant.expiresAt)}` : "No publishing access"}</p>`;
}
function approvalProgress(proposal) {
  if (!["pending", "publishing"].includes(proposalStatus(proposal))) {
    return "";
  }
  const steps = [
    ["Person", proposal.subjectApproved],
    ["Organisation", !!proposal.organisationApprovedBy],
  ];
  return `<ul class="approval-progress" aria-label="Approvals">${steps.map(([label, approved]) => `<li class="${approved ? "yes" : ""}"><span aria-hidden="true">${approved ? "✓" : "○"}</span> ${label}: ${approved ? "approved" : "pending"}</li>`).join("")}</ul>`;
}
function credential(proposal, publicOnly = false) {
  const { terms } = proposal;
  const status = proposalStatus(proposal);
  const closed = ["revoked", "declined", "expired"].includes(status);
  const name =
    publicOnly && !state.person ? "Demo account" : person(terms.subject);
  const message = publicOnly ? "" : nextStep(proposal, status);
  const access = !publicOnly && status === "active" ? accessLine(proposal) : "";
  const primary = primaryActions(proposal, status, publicOnly);
  const details = moreActions(proposal, status, publicOnly);
  const from =
    Date.parse(terms.validFrom) > Date.now()
      ? `From ${dt(terms.validFrom)} · `
      : "";
  return `<article class="card ${closed ? "closed" : ""} ${needsApproval(proposal) ? "attention" : ""}" data-proposal="${esc(proposal.id)}">
    <div class="card-top"><div><h3>${esc(terms.roleLabel)}</h3><p class="person-line">${esc(name)} · ${esc(labels[terms.relationship])}</p></div><span class="pill ${status === "active" ? "" : closed ? "inactive" : "pending"}">${esc(statusLabel(proposal, status))}</span></div>
    <p class="metadata">${esc(scopeLabel(terms.scope))} · ${from}Until ${date(terms.expiresAt)} · ${terms.visibility === "public" ? "Public" : "Private"}</p>
    ${publicOnly ? "" : approvalProgress(proposal)}${message ? `<p class="next-step">${esc(message)}</p>` : ""}${proposal.error ? `<p class="form-error">${esc(proposal.error)}</p>` : ""}${access}
    ${primary || details ? `<div class="card-actions">${primary ? `<div class="actions">${primary}</div>` : ""}${details}</div>` : ""}</article>`;
}
function affiliationsView() {
  const proposals = currentProposals();
  const current = proposals.filter(
    (p) => !["revoked", "declined", "expired"].includes(proposalStatus(p)),
  );
  const archived = proposals.filter((p) =>
    ["revoked", "declined", "expired"].includes(proposalStatus(p)),
  );
  current.sort((a, b) => Number(needsApproval(b)) - Number(needsApproval(a)));
  const waiting = current.filter(needsApproval).length;
  const heading = organisation().canReview
    ? "Organisation affiliations"
    : "My affiliations";
  return `<div class="section-heading"><h1>${heading}</h1><span class="muted">${waiting ? `${waiting} awaiting your approval` : `${current.length} current`}</span></div>
    <div class="cards">${current.map((p) => credential(p)).join("") || empty("No current affiliations", "Choose “New affiliation” to send a proposal for approval.")}</div>
    ${archived.length ? `<details class="archive"><summary>Ended affiliations (${archived.length})</summary><div class="cards">${archived.map((p) => credential(p)).join("")}</div></details>` : ""}`;
}
function publicView() {
  const proposals = publicProposals();
  return `<div class="section-heading"><h1>Public affiliations</h1><span class="muted">${proposals.filter((p) => p.verification.valid).length} confirmed</span></div>
    <div class="cards">${proposals.map((p) => credential(p, true)).join("") || empty("No public affiliations", "An affiliation appears here once both parties approve and choose public visibility.")}</div>`;
}
function eventScopes() {
  return organisation().scopes.filter((scope) =>
    state.grants.some(
      (grant) =>
        grant.subject === state.person?.did &&
        grant.organisationDid === orgId &&
        grant.scope === scope &&
        currentProposals().some((proposal) => activeGrant(grant, proposal)),
    ),
  );
}
function eventForm(scopes) {
  return `<details class="event-create"><summary>Publish event</summary><form id="event-form" class="card">
    <p class="muted">Publishing for ${esc(organisation().name)}.</p><label>Title<input name="title" maxlength="180" placeholder="E.g. open workshop" required></label>
    <div class="form-grid"><label>When?<input name="startsAt" type="datetime-local" value="${localInput(new Date(Date.now() + 86_400_000))}" required></label>
    <label ${scopes.length === 1 ? "hidden" : ""}>Scope<select name="scope">${scopes.map((scope) => `<option value="${esc(scope)}">${esc(scopeLabel(scope))}</option>`).join("")}</select></label></div>
    <p class="fineprint">${scopes.length === 1 ? `${esc(scopeLabel(scopes[0]))}. ` : ""} Publishing access is checked when you submit.</p>
    <p id="event-error" class="form-error" role="alert"></p><button class="primary" type="submit">Publish event</button></form></details>`;
}
function eventsView() {
  const events = state.events.filter(
    (event) => event.organisationDid === orgId,
  );
  const scopes = eventScopes();
  const access = !state.person
    ? ""
    : scopes.length
      ? eventForm(scopes)
      : '<p class="access-note">You do not have publishing access here. The organisation must grant access through a confirmed affiliation.</p>';
  return `<div class="section-heading"><h1>Events</h1><span class="muted">${events.length} published</span></div>${access}<div class="cards">${events.map((event) => `<article class="event-row"><time>${dt(event.startsAt)}</time><div><h3>${esc(event.title)}</h3><p class="metadata">${esc(scopeLabel(event.scope))}</p></div></article>`).join("") || empty("No events yet", "People with publishing access can post events for the organisation.")}</div>`;
}
function historyView() {
  const history = state.history.filter((row) => row.org === orgId || !row.org);
  return `<div class="section-heading"><h1>History</h1></div><div class="history-list">${history.map((row) => `<div class="audit-row"><time>${dt(row.at)}</time><span>${esc(names[row.action] ?? row.action)}</span><span>${esc(row.actor === "workflow" ? "Service" : person(row.actor))}</span></div>`).join("") || empty("No activity yet", "Approvals and changes appear here.")}</div>`;
}
function render() {
  const org = organisation();
  $("#organisation").innerHTML = state.organisations
    .map((row) => `<option value="${esc(row.did)}">${esc(row.name)}</option>`)
    .join("");
  $("#organisation").value = orgId;
  $("#account").innerHTML = state.person
    ? `<span class="identity-label">${esc(state.person.name)}</span><button data-action="logout">Sign out</button>`
    : '<button data-action="login" class="primary">Sign in</button>';
  $("#new-proposal").hidden = !state.person;
  $("#workspace-hint").textContent = state.person
    ? org.canReview
      ? "You approve for the organisation. The person must also approve."
      : "Propose your role. The organisation confirms the affiliation."
    : "View public affiliations, or sign in to propose and approve an affiliation.";
  const waiting = currentProposals().filter(needsApproval).length;
  const tabs = [
    ...(state.person
      ? [["affiliations", `Affiliations${waiting ? ` (${waiting})` : ""}`]]
      : []),
    ["public", "Public"],
    ["events", "Events"],
    ...(state.person ? [["history", "History"]] : []),
  ];
  if (!tabs.some(([id]) => id === tab)) {
    tab = state.person ? "affiliations" : "public";
  }
  $("#tabs").innerHTML = tabs
    .map(
      ([id, title]) =>
        `<button data-tab="${id}" class="${tab === id ? "active" : ""}" aria-current="${tab === id ? "page" : "false"}">${title}</button>`,
    )
    .join("");
  const views = {
    affiliations: affiliationsView,
    events: eventsView,
    history: historyView,
    public: publicView,
  };
  $("#content").innerHTML = views[tab]();
}
function roleCatalog() {
  return [...currentProposals(), ...publicProposals()]
    .filter((proposal) => proposal.verification.valid)
    .map((proposal) => proposal.terms);
}
function updateProposalSummary() {
  const form = $("#proposal-form");
  const { elements } = form;
  const duration = elements.duration.value;
  const expiry =
    duration === "keep"
      ? editing.terms.expiresAt
      : new Date(Date.now() + Number(duration) * 86_400_000).toISOString();
  $("#proposal-defaults").textContent =
    `${labels[elements.relationship.value]} · ${scopeLabel(elements.scope.value)} · ${duration === "keep" ? `until ${date(expiry)}` : `${duration} days`}`;
  $("#visibility-help").textContent = elements.public.checked
    ? "The account and role become public. Others may copy the proof."
    : "Only the person and the organisation’s approvers can see this affiliation.";
  const subject = editing?.terms.subject ?? elements.subject.value;
  const recipient =
    subject === state.person.did
      ? organisation().name
      : subject
        ? person(subject)
        : "The selected person";
  const start =
    editing && Date.parse(editing.terms.validFrom) > Date.now()
      ? dt(editing.terms.validFrom)
      : "now";
  $("#proposal-next").textContent =
    `You approve when you send → ${recipient} approves next. Valid from ${start} until ${date(expiry)}.${editing ? " This change removes any publishing access and needs fresh approval." : ""}`;
}
function openProposal(proposal) {
  editing = proposal;
  const form = $("#proposal-form");
  form.reset();
  const org = organisation();
  $("#proposal-title").textContent = proposal
    ? "Propose changes"
    : "New affiliation";
  $("#proposal-error").textContent = "";
  $("#proposal-context").textContent = proposal
    ? `${person(proposal.terms.subject)} · ${org.name}`
    : `At ${org.name}`;
  $("#subject-field").hidden = !!proposal || !org.canReview;
  const people = org.canReview
    ? state.people
    : state.people.filter((row) => row.did === state.person.did);
  $("#proposal-subject").innerHTML =
    `${org.canReview && !proposal ? '<option value="">Choose person</option>' : ""}${people.map((row) => `<option value="${esc(row.did)}">${esc(row.name)}</option>`).join("")}`;
  $("#proposal-subject").disabled = !!proposal;
  $("#proposal-scope").innerHTML = org.scopes
    .map(
      (scope) =>
        `<option value="${esc(scope)}">${esc(scopeLabel(scope))}</option>`,
    )
    .join("");
  $("#proposal-duration").innerHTML =
    `${proposal ? `<option value="keep">Keep end date: ${date(proposal.terms.expiresAt)}</option>` : ""}<option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option>`;
  $("#role-options").innerHTML = [
    ...new Set(roleCatalog().map((terms) => terms.roleLabel)),
  ]
    .map((label) => `<option value="${esc(label)}"></option>`)
    .join("");
  const values = proposal?.terms ?? {
    relationship: "employee",
    roleLabel: "",
    scope: org.scopes.includes("*") ? "*" : org.scopes[0],
  };
  for (const key of ["relationship", "roleLabel", "scope"]) {
    form.elements.namedItem(key).value = values[key];
  }
  if (proposal) {
    form.elements.subject.value = proposal.terms.subject;
  }
  form.elements.duration.value = proposal ? "keep" : "30";
  form.elements.public.checked =
    !proposal || proposal.terms.visibility === "public";
  $("#proposal-options").open = false;
  $("#proposal-submit").textContent = proposal
    ? "Send changes for approval"
    : "Send for approval";
  updateProposalSummary();
  $("#proposal-dialog").showModal();
}
function showVerification(proposal) {
  const { valid } = proposal.verification;
  $("#verify-content").innerHTML =
    `<p class="verification-result ${valid ? "yes" : "form-error"}">${valid ? "✓ Confirmed by both parties" : "Cannot verify right now"}</p><p>${esc(proposal.terms.roleLabel)} · ${esc(organisation().name)}</p><p class="metadata">${esc(scopeLabel(proposal.terms.scope))} · Until ${date(proposal.terms.expiresAt)}</p><p class="muted">${proposal.terms.visibility === "public" ? "The organisation’s signature and the person’s approval have been verified." : "Private approval is recorded by the service. Signature and status have been verified."}</p><details><summary>Technical details</summary>${proposal.verification.checks.map((check) => `<div class="check"><span class="${check.ok ? "yes" : "form-error"}">${check.ok ? "✓" : "×"}</span><div><strong>${esc(check.name)}</strong><small>${esc(check.detail ?? "Passed")}</small></div></div>`).join("")}<p class="technical">${esc(proposal.ref?.uri ?? "Private, not published")}<br>${esc(proposal.acceptanceRef?.uri ?? "")}</p>${proposal.terms.visibility === "public" ? `<a href="/api/credential?id=${encodeURIComponent(proposal.id)}" target="_blank" rel="noopener">Open proof bundle ↗</a>` : ""}</details>`;
  $("#verify-dialog").showModal();
}
function approvalNotice(id) {
  const proposal = state.proposals.find((row) => row.id === id);
  if (!proposal) {
    return "Approval recorded.";
  }
  const status = proposalStatus(proposal);
  return status === "active"
    ? `The affiliation is confirmed.${proposal.terms.visibility === "public" ? " It is now public." : " It is private."} Publishing access is granted separately.`
    : nextStep(proposal, status);
}
async function openLogin() {
  const demo = await api("/api/demo");
  $("#login-handle").innerHTML = demo.accounts
    .map(
      (account) =>
        `<option value="${esc(account.handle)}">${esc(account.name)}</option>`,
    )
    .join("");
  $("#login-error").textContent = "";
  $("#login-dialog").showModal();
}
async function performAction(action, id, proposal) {
  if (action === "refresh") {
    await refresh();
    notice("Status refreshed.");
    return;
  }
  if (action === "logout") {
    await api("/api/logout", {});
    tab = "public";
  } else if (action === "revoke-grant") {
    await api("/api/grants/revoke", { id });
  } else if (action === "grant") {
    await api("/api/grants", {
      action: "events.publish",
      expiresAt: proposal.terms.expiresAt,
      id,
      revision: proposal.revision,
      scope: proposal.terms.scope,
    });
  } else {
    await api(`/api/proposals/${action}`, { id, revision: proposal.revision });
  }
  await refresh();
  const messages = {
    decline: "Request closed. No access was granted.",
    grant: `${proposal ? person(proposal.terms.subject) : "Person"} can now publish events for the organisation.`,
    logout: "You are signed out.",
    revoke: "Affiliation ended. Publishing access removed.",
    "revoke-grant":
      "Publishing access removed. The affiliation is still confirmed.",
  };
  notice(
    ["approve", "retry"].includes(action)
      ? approvalNotice(id)
      : messages[action],
  );
}
onAsync(document, "click", async (event) => {
  const target = event.target.closest("button");
  if (!target) {
    return;
  }
  if ("close" in target.dataset) {
    return target.closest("dialog").close();
  }
  if (target.dataset.tab) {
    ({ tab } = target.dataset);
    $("#notice").replaceChildren();
    return render();
  }
  if (target.id === "new-proposal") {
    return openProposal();
  }
  const { action, id } = target.dataset;
  if (!action) {
    return;
  }
  if (action === "login") {
    target.disabled = true;
    try {
      await openLogin();
    } finally {
      target.disabled = false;
    }
    return;
  }
  const proposal =
    state?.proposals.find((row) => row.id === id) ??
    state?.publicCredentials.find((row) => row.id === id);
  if (action === "change") {
    return openProposal(proposal);
  }
  if (action === "verify") {
    return showVerification(proposal);
  }
  target.disabled = true;
  try {
    await performAction(action, id, proposal);
  } finally {
    target.disabled = false;
  }
});
$("#organisation").addEventListener("change", (event) => {
  orgId = event.target.value;
  $("#notice").replaceChildren();
  render();
});
$("#proposal-form").addEventListener("input", updateProposalSummary);
$("#proposal-form").addEventListener("change", updateProposalSummary);
onAsync($("#login-form"), "submit", async (event) => {
  event.preventDefault();
  const { target } = event;
  const submit = target.querySelector("[type=submit]");
  submit.disabled = true;
  $("#login-error").textContent = "";
  try {
    await api("/api/login", Object.fromEntries(new FormData(target)));
    target.elements.password.value = "";
    $("#login-dialog").close();
    tab = "affiliations";
    $("#notice").replaceChildren();
    await refresh();
  } catch (error) {
    $("#login-error").textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});
onAsync($("#proposal-form"), "submit", async (event) => {
  event.preventDefault();
  const { target } = event;
  const submit = target.querySelector("[type=submit]");
  submit.disabled = true;
  $("#proposal-error").textContent = "";
  try {
    const fields = Object.fromEntries(new FormData(target));
    fields.visibility = target.elements.public.checked ? "public" : "private";
    const terms = await proposalTerms(fields, {
      organisationDid: orgId,
      previous: editing?.terms,
      roles: roleCatalog(),
    });
    const result = await api(
      editing ? "/api/proposals/change" : "/api/proposals",
      {
        ...(editing ? { id: editing.id, revision: editing.revision } : {}),
        terms,
      },
    );
    $("#proposal-dialog").close();
    tab = "affiliations";
    await refresh();
    notice(`Sent for approval. ${approvalNotice(result.id)}`);
  } catch (error) {
    $("#proposal-error").textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});
onAsync(document, "submit", async (event) => {
  if (event.target.id !== "event-form") {
    return;
  }
  event.preventDefault();
  const { target } = event;
  const submit = target.querySelector("[type=submit]");
  submit.disabled = true;
  try {
    const input = Object.fromEntries(new FormData(target));
    input.organisationDid = orgId;
    input.startsAt = new Date(input.startsAt).toISOString();
    await api("/api/events", input);
    await refresh();
    notice(`Event published for ${organisation().name}.`);
  } catch (error) {
    $("#event-error").textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});
try {
  await refresh();
} catch (error) {
  $("#content").innerHTML = empty(
    "Could not load affiliations",
    "Choose “Refresh” to try again.",
  );
  notice(error.message, true);
}
