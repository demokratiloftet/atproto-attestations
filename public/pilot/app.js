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
      })[c]
  );
let editing;
let orgId;
let state;
let tab = "overview";
const labels = {
  contractor: "Oppdragstaker",
  electedRepresentative: "Folkevalgt",
  employee: "Ansatt",
  member: "Medlem",
  volunteer: "Frivillig",
};
const statuses = {
  active: "Bekreftet",
  declined: "Avslått",
  expired: "Utløpt",
  pending: "Venter på godkjenning",
  publishing: "Publisering venter",
  revoked: "Trukket tilbake",
};
const names = {
  activated: "Tilknytning aktivert",
  approved: "Versjon godkjent",
  changed: "Nytt forslag til endring",
  declined: "Forslag avslått",
  "event-published": "Arrangement publisert",
  "grant-created": "Fullmakt gitt",
  "grant-revoked": "Fullmakt trukket tilbake",
  proposed: "Forslag opprettet",
  "publish-denied": "Publisering avvist",
  "request-denied": "Forespørsel avvist",
  revoked: "Tilknytning trukket tilbake",
  superseded: "Tidligere versjon avsluttet",
};
const date = (s) =>
  new Date(s).toLocaleDateString("nb-NO", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
const dt = (s) =>
  new Date(s).toLocaleString("nb-NO", {
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
      : {}
  );
  const data = await r.json();
  if (!r.ok) {
    throw new Error(data.error ?? "Kunne ikke fullføre.");
  }
  return data;
}
function onAsync(target, name, handler) {
  target.addEventListener(name, (event) => {
    handler(event).catch((error) => {
      notice(error.message ?? "Forespørselen feilet.", true);
    });
  });
}
function notice(message, error = false) {
  $("#notice").innerHTML =
    `<div class="notice ${error ? "error" : ""}">${esc(message)}</div>`;
}
async function refresh() {
  state = await api("/api/state");
  orgId = state.organisations.some((o) => o.did === orgId)
    ? orgId
    : state.organisations[0]?.did;
  render();
}
function empty(title, detail) {
  return `<div class="empty"><strong>${title}</strong>${detail}</div>`;
}
function approvalLine(approved, label) {
  return `<span class="${approved ? "yes" : ""}">${approved ? "✓" : "○"} ${label} ${approved ? "har godkjent" : "venter"}</span>`;
}
function canApprove(proposal, isMine, canReview) {
  return isMine
    ? !proposal.subjectApproved
    : canReview && !proposal.organisationApprovedBy;
}
function credentialActions(proposal, status, publicOnly) {
  const actions = [];
  const isMine = state.person?.did === proposal.terms.subject;
  const canReview = organisation()?.canReview;
  if (proposal.verification.valid) {
    actions.push(button("verify", "Se kontrollen", proposal.id));
  }
  if (publicOnly) {
    return actions.join("");
  }
  if (status === "pending" && canApprove(proposal, isMine, canReview)) {
    actions.push(
      button(
        "approve",
        `Godkjenn versjon ${proposal.revision}`,
        proposal.id,
        'class="primary"'
      )
    );
  }
  if (["pending", "active", "publishing"].includes(status)) {
    actions.push(button("change", "Foreslå endring", proposal.id));
  }
  if (status === "pending") {
    actions.push(button("decline", "Avslå", proposal.id));
  }
  if (status === "publishing") {
    actions.push(button("retry", "Prøv publisering igjen", proposal.id));
  }
  if (["active", "publishing"].includes(status)) {
    actions.push(
      button(
        "revoke",
        isMine ? "Trekk tilbake samtykke" : "Avslutt tilknytning",
        proposal.id,
        'class="danger"'
      )
    );
  }
  if (proposal.verification.valid && canReview) {
    actions.push(button("grant", "Gi publiseringsfullmakt", proposal.id));
  }
  return actions.join("");
}
function credential(proposal, publicOnly = false) {
  const { terms } = proposal;
  const { valid } = proposal.verification;
  const status =
    Date.parse(terms.expiresAt) <= Date.now()
      ? "expired"
      : (proposal.state ?? (valid ? "active" : "unavailable"));
  const pill = valid
    ? ""
    : ["pending", "publishing"].includes(status)
      ? "pending"
      : "inactive";
  const label = valid
    ? "Bekreftet"
    : (statuses[status] ?? "Kan ikke bekreftes");
  const name =
    publicOnly && !state.person ? "Demokonto" : person(terms.subject);
  const approvals = publicOnly
    ? ""
    : `<div class="approvals">${approvalLine(proposal.subjectApproved, "Personen")}${approvalLine(proposal.organisationApprovedBy, "Organisasjonen")}</div>`;
  const error = proposal.error
    ? `<p class="form-error">${esc(proposal.error)}</p>`
    : "";
  return `<article class="card"><div class="card-top"><div class="card-person"><span class="avatar">${esc((name || "P").slice(0, 1))}</span><div><h3>${esc(terms.roleLabel)}</h3><p>${esc(name)} · ${esc(labels[terms.relationship])}</p></div></div><span class="pill ${pill}">${esc(label)}</span></div><div class="metadata"><span>Område <b>${esc(terms.scope === "*" ? "Hele organisasjonen" : terms.scope)}</b></span><span>Til <b>${date(terms.expiresAt)}</b></span><span>${terms.visibility === "public" ? "Offentlig" : "Privat"} · versjon ${proposal.revision}</span></div>${approvals}${error}<div class="actions">${credentialActions(proposal, status, publicOnly)}</div></article>`;
}
function render() {
  const org = organisation();
  $("#organisation").innerHTML = state.organisations
    .map((o) => `<option value="${esc(o.did)}">${esc(o.name)}</option>`)
    .join("");
  $("#organisation").value = orgId;
  $("#account").innerHTML = state.person
    ? `<span class="identity-label">${esc(state.person.name)}</span><button data-action="logout">Logg ut</button>`
    : '<button data-action="login">Logg inn</button>';
  $("#new-proposal").hidden = !state.person;
  const tabs = [
    ["overview", "Oversikt"],
    ...(state.person
      ? [
          ["requests", "Forespørsler"],
          ["permissions", "Fullmakter"],
          ["publish", "Publiser"],
          ["history", "Historikk"],
        ]
      : []),
  ];
  if (!tabs.some(([id]) => id === tab)) {
    tab = "overview";
  }
  $("#tabs").innerHTML = tabs
    .map(
      ([id, title]) =>
        `<button data-tab="${id}" class="${tab === id ? "active" : ""}" aria-current="${tab === id ? "page" : "false"}">${title}</button>`
    )
    .join("");
  const proposals = state.proposals.filter(
    (p) => p.terms.organisationDid === orgId
  );
  const pub = state.publicCredentials.filter(
    (p) => p.terms.organisationDid === orgId
  );
  const grants = state.grants.filter((g) => g.organisationDid === orgId);
  const events = state.events.filter((e) => e.organisationDid === orgId);
  const intro = state.person
    ? `<div class="account-note">${org.canReview ? "Du er innlogget som organisasjonens oppnevnte godkjenner." : "Du er innlogget som person. En tilknytning gir ikke automatisk publiseringstilgang."}</div>`
    : "";
  if (tab === "overview") {
    $("#content").innerHTML =
      `<div class="stats"><div class="stat"><span>Offentlige bekreftelser</span><strong>${pub.filter((p) => p.verification.valid).length}</strong></div><div class="stat"><span>${state.person ? "Venter på en part" : "To parter bekrefter"}</span><strong>${state.person ? proposals.filter((p) => p.state === "pending").length : "↔"}</strong></div><div class="stat"><span>Publiserte arrangementer</span><strong>${events.length}</strong></div></div><div class="split"><div><div class="section-heading"><h2>Offentlige bekreftelser</h2><span class="pill">${esc(org.domain ?? org.did)}</span></div><div class="cards">${pub.length ? pub.map((p) => credential(p, true)).join("") : empty("Ingen bekreftelser ennå", "En offentlig bekreftelse vises når begge parter har godkjent samme versjon.")}</div></div><aside class="info-panel"><p class="eyebrow">SLIK FUNGERER DET</p><h2>Fra påstand til bekreftelse</h2><div class="steps"><div class="step"><div><b>Én part foreslår</b><p>Person eller organisasjon velger rolle, område og varighet.</p></div></div><div class="step"><div><b>Begge godkjenner</b><p>Endringer må godkjennes på nytt. Bare felles versjon blir aktiv.</p></div></div><div class="step"><div><b>Fullmakt gis separat</b><p>Organisasjonen velger hvem som kan publisere. Tilgang kontrolleres på nytt ved bruk.</p></div></div></div></aside></div><div class="section-heading"><h2>Arrangementer fra ${esc(org.name)}</h2></div><div class="cards">${events.map((e) => `<article class="card"><div class="event-date">${dt(e.startsAt)}</div><h3>${esc(e.title)}</h3><p class="muted">${esc(e.scope === "*" ? "Hele organisasjonen" : e.scope)} · Publisert med kontrollert fullmakt</p><p class="technical">${esc(e.ref?.uri)}</p></article>`).join("") || empty("Ingen arrangementer", "En person med publiseringsfullmakt kan opprette det første.")}</div>`;
  }
  if (tab === "requests") {
    $("#content").innerHTML = `${
      intro
    }<div class="section-heading"><h2>${org.canReview ? "Organisasjonens forespørsler" : "Mine tilknytninger"}</h2><span class="muted">${proposals.length} totalt</span></div><div class="cards">${proposals.map((p) => credential(p)).join("") || empty("Klart for første forslag", "Velg «Ny tilknytning» for å starte fra personen eller organisasjonen.")}</div>`;
  }
  if (tab === "permissions") {
    $("#content").innerHTML = `${
      intro
    }<div class="split"><div><h2>Publiseringsfullmakter</h2><p class="muted">En fullmakt gjelder én organisasjon, ett område og én bekreftet versjon.</p><div class="cards grant-list">${
      grants
        .map((g) => {
          const active =
            !g.revoked &&
            Date.parse(g.expiresAt) > Date.now() &&
            proposals.some(
              (p) =>
                p.id === g.proposalId &&
                p.revision === g.proposalRevision &&
                p.verification.valid
            );
          return `<article class="card"><div class="card-top"><div><h3>${esc(person(g.subject))}</h3><p class="muted">Publisere arrangementer</p></div><span class="pill ${active ? "" : "inactive"}">${active ? "Aktiv" : "Ikke aktiv"}</span></div><p class="muted">${esc(g.scope === "*" ? "Hele organisasjonen" : g.scope)} · til ${date(g.expiresAt)}</p>${org.canReview && !g.revoked ? `<div class="actions">${button("revoke-grant", "Trekk tilbake fullmakt", g.id, 'class="danger"')}</div>` : ""}</article>`;
        })
        .join("") ||
      empty(
        "Ingen fullmakter",
        "Godkjenn en tilknytning, og gi deretter en egen publiseringsfullmakt fra forespørselen."
      )
    }</div></div><aside class="info-panel"><h2>Rolle og tilgang er to ting</h2><p class="muted">En bekreftet utviklerrolle gjør ikke personen til administrator. Denne piloten støtter handlingen «publisere arrangementer».</p><p class="muted">Fullmakten slutter å virke når den trekkes tilbake, utløper eller tilknytningen endres. Personer uten fullmakt får avslag fra serveren.</p></aside></div>`;
  }
  if (tab === "publish") {
    $("#content").innerHTML = `${
      intro
    }<div class="split"><form id="event-form" class="card"><h2>Publiser et arrangement</h2><p class="muted">Publiseres på vegne av ${esc(org.name)} etter fersk kontroll av fullmakten din.</p><label>Tittel<input name="title" maxlength="180" placeholder="For eksempel: Åpen fagkveld" required></label><label>Start<input name="startsAt" type="datetime-local" value="${localInput(new Date(Date.now() + 86_400_000))}" required></label><label>Område<select name="scope">${org.scopes.map((s) => `<option value="${esc(s)}">${esc(s === "*" ? "Hele organisasjonen" : s)}</option>`).join("")}</select></label><p id="event-error" class="form-error" role="alert"></p><button class="primary full" type="submit">Kontroller fullmakt og publiser</button></form><aside class="info-panel"><p class="eyebrow">TILGANGSKONTROLL</p><h2>Hver publisering kontrolleres</h2><div class="steps"><div class="step"><div><b>Er dette din konto?</b><p>Serveren bruker innlogget DID, aldri en avsender oppgitt i skjemaet.</p></div></div><div class="step"><div><b>Er tilknytningen gyldig?</b><p>Begge godkjenninger, riktig versjon og gjeldende status må stemme.</p></div></div><div class="step"><div><b>Gjelder fullmakten her?</b><p>Organisasjon, område, handling og utløp kontrolleres før skriving.</p></div></div></div></aside></div>`;
  }
  if (tab === "history") {
    $("#content").innerHTML = `${
      intro
    }<h2>Aktivitet</h2><p class="muted">Privat historikk for dine handlinger og organisasjoner du kan administrere.</p><div class="card">${
      state.history
        .filter((h) => h.org === orgId || !h.org)
        .map(
          (h) =>
            `<div class="audit-row"><time>${dt(h.at)}</time><span>${esc(names[h.action] ?? h.action)}</span><span>${esc(h.actor === "workflow" ? "Tjenesten" : person(h.actor))}</span></div>`
        )
        .join("") || '<p class="muted">Ingen aktivitet ennå.</p>'
    }</div>`;
  }
}
function openProposal(p) {
  editing = p;
  const form = $("#proposal-form");
  const org = organisation();
  $("#proposal-title").textContent = p ? "Foreslå endring" : "Ny tilknytning";
  $("#proposal-error").textContent = "";
  const people = org.canReview
    ? state.people
    : state.people.filter((personRow) => personRow.did === state.person.did);
  $("#proposal-subject").innerHTML = people
    .map(
      (personRow) =>
        `<option value="${esc(personRow.did)}">${esc(personRow.name)}</option>`
    )
    .join("");
  $("#proposal-subject").disabled = !!p;
  $("#proposal-scope").innerHTML = org.scopes
    .map(
      (s) =>
        `<option value="${esc(s)}">${esc(s === "*" ? "Hele organisasjonen" : s)}</option>`
    )
    .join("");
  const values = p?.terms ?? {
    expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    relationship: "employee",
    roleId: "",
    roleLabel: "",
    scope: org.scopes[0],
    subject: org.canReview
      ? (people.find((personRow) => personRow.did !== state.person.did)?.did ??
        state.person.did)
      : state.person.did,
    validFrom: new Date().toISOString(),
    visibility: "public",
  };
  for (const [k, v] of Object.entries(values)) {
    const el = form.elements.namedItem(k);
    if (el) {
      el.value =
        k === "validFrom" || k === "expiresAt" ? localInput(new Date(v)) : v;
    }
  }
  $("#proposal-dialog").showModal();
}
onAsync(document, "click", async (e) => {
  const b = e.target.closest("button");
  if (!b) {
    return;
  }
  if ("close" in b.dataset) {
    return b.closest("dialog").close();
  }
  if (b.dataset.tab) {
    ({ tab } = b.dataset);
    return render();
  }
  if (b.id === "new-proposal") {
    return openProposal();
  }
  const { action } = b.dataset;
  const { id } = b.dataset;
  if (!action) {
    return;
  }
  if (action === "login") {
    return $("#login-dialog").showModal();
  }
  const p =
    state.proposals.find((row) => row.id === id) ??
    state.publicCredentials.find((row) => row.id === id);
  if (action === "change") {
    return openProposal(p);
  }
  if (action === "verify") {
    $("#verify-content").innerHTML =
      `<p class="muted">${p.terms.visibility === "public" ? "Kontrollerer utstederens signatur og personens aksept fra signerte AT-repositorier." : "Privat godkjenning registrert av tjenesten; attestasjonsignaturen og status kontrolleres."}</p>${p.verification.checks.map((c) => `<div class="check"><span class="${c.ok ? "yes" : "form-error"}">${c.ok ? "✓" : "×"}</span><div><strong>${esc(c.name)}</strong><small>${esc(c.detail ?? "Bestått")}</small></div></div>`).join("")}<p class="technical">${esc(p.ref?.uri ?? "Privat, ikke publisert")}<br>${esc(p.acceptanceRef?.uri ?? "")}</p>${p.terms.visibility === "public" ? `<a href="/api/credential?id=${encodeURIComponent(p.id)}" target="_blank" rel="noopener">Åpne offentlig bevispakke ↗</a>` : ""}`;
    return $("#verify-dialog").showModal();
  }
  b.disabled = true;
  try {
    if (action === "logout") {
      await api("/api/logout", {});
      tab = "overview";
      notice("Du er logget ut.");
    } else if (action === "revoke-grant") {
      await api("/api/grants/revoke", { id });
      notice("Fullmakten er trukket tilbake.");
    } else if (action === "grant") {
      await api("/api/grants", {
        action: "events.publish",
        expiresAt: p.terms.expiresAt,
        id,
        revision: p.revision,
        scope: p.terms.scope,
      });
      notice("Publiseringsfullmakten er gitt.");
      tab = "permissions";
    } else {
      await api(`/api/proposals/${action}`, { id, revision: p.revision });
      notice(
        {
          approve: "Versjonen er godkjent.",
          decline: "Forslaget er avslått.",
          retry: "Publiseringen er forsøkt på nytt.",
          revoke: "Tilknytningen og tilhørende fullmakter er avsluttet.",
        }[action]
      );
    }
    await refresh();
  } catch (error) {
    notice(error.message, true);
  } finally {
    b.disabled = false;
  }
});
$("#organisation").addEventListener("change", (e) => {
  orgId = e.target.value;
  render();
});
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const b = e.target.querySelector("[type=submit]");
  b.disabled = true;
  try {
    await api("/api/login", Object.fromEntries(new FormData(e.target)));
    e.target.elements.password.value = "";
    $("#login-dialog").close();
    tab = "requests";
    await refresh();
    notice(`Innlogget som ${state.person.name}.`);
  } catch (error) {
    $("#login-error").textContent = error.message;
  } finally {
    b.disabled = false;
  }
});
$("#proposal-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const b = e.target.querySelector("[type=submit]");
  b.disabled = true;
  try {
    const terms = Object.fromEntries(new FormData(e.target));
    terms.subject = editing?.terms.subject ?? terms.subject;
    terms.organisationDid = orgId;
    terms.validFrom = new Date(terms.validFrom).toISOString();
    terms.expiresAt = new Date(terms.expiresAt).toISOString();
    await api(editing ? "/api/proposals/change" : "/api/proposals", {
      ...(editing ? { id: editing.id, revision: editing.revision } : {}),
      terms,
    });
    $("#proposal-dialog").close();
    tab = "requests";
    await refresh();
    notice("Forslaget er sendt til den andre parten.");
  } catch (error) {
    $("#proposal-error").textContent = error.message;
  } finally {
    b.disabled = false;
  }
});
onAsync(document, "submit", async (e) => {
  if (e.target.id !== "event-form") {
    return;
  }
  e.preventDefault();
  const b = e.target.querySelector("[type=submit]");
  b.disabled = true;
  try {
    const input = Object.fromEntries(new FormData(e.target));
    input.organisationDid = orgId;
    input.startsAt = new Date(input.startsAt).toISOString();
    await api("/api/events", input);
    tab = "overview";
    await refresh();
    notice("Arrangementet er publisert på vegne av organisasjonen.");
  } catch (error) {
    $("#event-error").textContent = error.message;
  } finally {
    b.disabled = false;
  }
});
try {
  const demo = await api("/api/demo");
  $("#login-handle").innerHTML = demo.accounts
    .map(
      (p) =>
        `<option value="${esc(p.handle)}">${esc(p.name)} · ${esc(p.handle)}</option>`
    )
    .join("");
  await refresh();
} catch (error) {
  notice(error.message, true);
}
