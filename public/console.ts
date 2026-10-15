import type { createIssuer } from "../src/core/issuer.ts";
import type { Person } from "../src/types.ts";
import type { Descriptor, AttestationRecord } from "../verify/types.ts";

type Issuer = ReturnType<typeof createIssuer>;
type Held = ReturnType<Issuer["held"]>;
type Issued = Awaited<ReturnType<Issuer["issue"]>>;
type QueryResult = Awaited<ReturnType<Issuer["query"]>>;
type IssuerDocument = ReturnType<Issuer["document"]>;
interface AuditRow {
  at: string;
  action: string;
  outcome: string;
  claim_type?: string;
  subject?: string;
  actor?: string;
}
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Forespørselen feilet.";
function element<T extends HTMLElement>(
  selector: string,
  constructor: new () => T
): T {
  const node = document.querySelector(selector);
  if (!(node instanceof constructor)) {
    throw new Error(`Missing page element: ${selector}`);
  }
  return node;
}
const select = (selector: string) => element(selector, HTMLSelectElement);
const formElement = (selector: string) => element(selector, HTMLFormElement);
const dialogElement = (selector: string) =>
  element(selector, HTMLDialogElement);
function formTarget(target: EventTarget | null): HTMLFormElement {
  if (!(target instanceof HTMLFormElement)) {
    throw new Error("Missing form");
  }
  return target;
}
// The operator console. It is an ordinary client of the issuer's HTTP API: it
// holds a client token, and it can do nothing the API would not allow anyone.
const $ = (selector: string) => element(selector, HTMLElement);
const store: {
  token: string;
  roster: Record<string, Person>;
  types: Descriptor[];
  subject: string;
} = {
  roster: {},
  subject: "",
  token: sessionStorage.getItem("issuer-token") || "",
  types: [],
};
let toastTimer: ReturnType<typeof setTimeout> | undefined;

const toast = (message: string) => {
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("#toast").hidden = true), 5000);
};

async function api<T = unknown>(
  path: string,
  { method = "GET", json }: { method?: string; json?: unknown } = {}
): Promise<T> {
  const response = await fetch(path, {
    headers: {
      ...(store.token && { authorization: `Bearer ${store.token}` }),
      ...(json !== undefined && { "content-type": "application/json" }),
    },
    method,
    ...(json !== undefined && { body: JSON.stringify(json) }),
  });
  const result: unknown = await response.json().catch(() => ({}));
  if (response.status === 401) {
    askForKey();
    throw new Error("Klientnøkkelen mangler eller er feil.");
  }
  if (!response.ok) {
    throw new Error(
      (typeof result === "object" &&
      result !== null &&
      "error" in result &&
      typeof result.error === "string"
        ? result.error
        : "") || `Utstederen svarte ${response.status}.`
    );
  }
  // Same-origin typed API; dynamic values are rendered as text or escaped below.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Same-origin issuer API; values are displayed, never used to authorise an operation.
  return result as T;
}

function askForKey() {
  const dialog = dialogElement("#key-dialog");
  if (!dialog.open) {
    dialog.showModal();
  }
}
formElement("#key-form").addEventListener("submit", () => {
  store.token = formText(new FormData(formElement("#key-form")).get("token"));
  sessionStorage.setItem("issuer-token", store.token);
  run(load());
});

const name = (did: string) =>
  did.replace(/^did:plc:demo-/u, "").replace(/^did:plc:/u, "");
const options = (
  selection: HTMLSelectElement,
  entries: [string, string][],
  placeholder?: string
) => {
  const chosen = selection.value;
  selection.replaceChildren(
    ...(placeholder ? [new Option(placeholder, "")] : []),
    ...entries.map(([value, label]) => new Option(label, value))
  );
  if (entries.some(([value]) => value === chosen)) {
    selection.value = chosen;
  }
};

function renderIdentity(
  document_: IssuerDocument,
  health?: { environment: string }
) {
  $("#issuer-name").textContent = document_.name;
  $("#issuer-url").textContent = document_.issuer;
  const [key] = document_.keys;
  if (!key?.kid || !key.x) {
    throw new Error("Utstederen mangler offentlig nøkkel.");
  }
  $("#issuer-key").textContent =
    `${key.kid} · ${key.x.slice(0, 12)}…${key.x.slice(-6)}`;
  $("#issuer-publish").textContent = document_.atprotoRepo
    ? `Offentlige attestasjoner publiseres i ${document_.atprotoRepo}`
    : "Ingen publisering konfigurert. Attestasjonene ligger hos utstederen.";
  document.title = `${document_.name} — utstederpult`;
  if (health) {
    $("#issuer-name").title = `Miljø: ${health.environment}`;
  }
}

function renderTypes(types: Descriptor[]) {
  store.types = types;
  $("#claim-types").innerHTML = types
    .map(
      (type) => `
    <li class="${type.visibility === "restricted" ? "restricted" : ""}">
      <strong>${escape(type.label.nb)}</strong>
      <span>${type.visibility === "restricted" ? "Besvares på spørsmål" : "Publiseres som post"}</span>
    </li>`
    )
    .join("");
  options(
    select("#issue-type"),
    types
      .filter((t) => t.visibility === "public")
      .map((t) => [t.id, t.label.nb])
  );
}

function renderPeople(people: Record<string, Person>) {
  store.roster = people;
  const entries = Object.entries(people);
  $("#people").innerHTML = entries.length
    ? entries
        .map(
          ([did, facts]) =>
            `<li><strong>${escape(name(did))}</strong><span>${escape(describe(facts))}</span></li>`
        )
        .join("")
    : '<li class="empty">Ingen kontoer ennå.</li>';
  const choices: [string, string][] = entries.map(([did]) => [did, name(did)]);
  for (const id of [
    "#issue-subject",
    "#held-subject",
    "#query-subject",
    "#query-requester",
    "#attest-subject",
  ]) {
    options(select(id), choices);
  }
  options(select("#issue-requester"), choices, "Kontoen selv");
  if (!store.subject && choices.length) {
    [[store.subject]] = choices;
  }
  if (store.subject) {
    select("#held-subject").value = store.subject;
  }
}

const describe = (facts: Person) =>
  [
    ...(facts.clubs || []).map((club) => `${club.role} i ${club.orgName}`),
    ...(facts.licences || []).map((licence) => `lisens: ${licence.discipline}`),
    ...(facts.attests?.length ? ["politiattest levert"] : []),
  ].join(" · ") || "ingen registrerte fakta";

async function renderHeld() {
  const subject = select("#held-subject").value;
  store.subject = subject;
  if (!subject) {
    $("#held").innerHTML = '<li class="empty">Velg en konto.</li>';
    return;
  }
  const { attestations } = await api<{ attestations: Held }>(
    `/held?subject=${encodeURIComponent(subject)}`
  );
  $("#held").innerHTML = attestations.length
    ? attestations
        .map((row) => {
          const label =
            store.types.find((type) => type.id === row.claimType)?.label.nb ||
            row.claimType;
          const gone = row.revokedAt || Date.parse(row.expiresAt) <= Date.now();
          return `<li>
      <span class="what">${escape(label)}</span>
      <span class="detail">${escape(Object.values(row.claim).join(" · "))}</span>
      <span class="state ${gone ? "gone" : ""}">${row.revokedAt ? "Trukket tilbake" : gone ? "Utløpt" : `Gyldig til ${row.expiresAt.slice(0, 10)}`}</span>
      ${gone ? "" : `<button data-revoke="${row.id}" data-subject="${escape(subject)}">Trekk tilbake</button>`}
    </li>`;
        })
        .join("")
    : '<li class="empty">Ingen attestasjoner for denne kontoen.</li>';
}

async function renderAudit() {
  const { entries } = await api<{ entries: AuditRow[] }>("/audit?limit=25");
  $("#audit").innerHTML = entries.length
    ? entries
        .map(
          (row) => `<li>
    <time>${row.at.slice(11, 19)}</time>
    <span class="outcome ${row.outcome === "allowed" ? "allowed" : "denied"}">${escape(action(row))}</span>
    <span class="what">${escape(row.claim_type || "")} ${row.subject ? `om ${escape(name(row.subject))}` : ""} ${row.actor ? `· spurt av ${escape(name(row.actor))}` : ""}</span>
  </li>`
        )
        .join("")
    : '<li class="empty">Ingenting er gjort ennå.</li>';
}

const action = (row: AuditRow) =>
  (new Map([
    ["issue", "utstedt"],
    ["revoke", "trukket"],
    ["query", "spurt"],
    ["publish", "publisert"],
  ]).get(row.action) || row.action) +
  (row.outcome === "allowed"
    ? ""
    : ` · ${row.outcome === "denied" ? "avvist" : row.outcome}`);

function escape(value: unknown) {
  const display =
    typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  return display.replaceAll(
    /[&<>"']/gu,
    (character) =>
      ({ '"': "&quot;", "&": "&amp;", "'": "&#39;", "<": "&lt;", ">": "&gt;" })[
        character
      ] ?? character
  );
}

const pairs = (text: FormDataEntryValue | null) =>
  Object.fromEntries(
    formText(text)
      .split(/[,\s]+/u)
      .filter(Boolean)
      .map((part) => {
        const [field, ...rest] = part.split("=");
        return [field, rest.join("=")];
      })
  );

function run(work: Promise<unknown>) {
  work.catch((error: unknown) => {
    toast(errorMessage(error));
  });
}
function act(...args: Parameters<typeof actWork>) {
  run(actWork(...args));
}
function formText(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value : "";
}
async function actWork(button: EventTarget | null, work: () => Promise<void>) {
  if (
    !(button instanceof HTMLButtonElement) &&
    !(button instanceof HTMLInputElement)
  ) {
    return;
  }
  button.disabled = true;
  try {
    await work();
  } catch (error) {
    toast(errorMessage(error));
  } finally {
    button.disabled = false;
  }
}

$("#seed").addEventListener("click", (event) =>
  act(event.target, async () => {
    const cast = {
      "did:plc:demo-leder": {
        clubs: [{ orgId: "fjord", orgName: "Fjord idrettslag", role: "leder" }],
        identity: { assuranceLevel: "substantial", provider: "demo-idp" },
      },
      "did:plc:demo-medlem": {
        clubs: [
          { orgId: "fjord", orgName: "Fjord idrettslag", role: "medlem" },
        ],
        identity: { assuranceLevel: "substantial", provider: "demo-idp" },
      },
      "did:plc:demo-trener": {
        attests: [{ orgId: "fjord" }],
        clubs: [
          { orgId: "fjord", orgName: "Fjord idrettslag", role: "trener" },
        ],
        identity: { assuranceLevel: "substantial", provider: "demo-idp" },
        licences: [
          { discipline: "svomming", level: "instruktor-2", orgId: "fjord" },
        ],
      },
    };
    for (const [subject, facts] of Object.entries(cast)) {
      await api("/demo/enrol", { json: { facts, subject }, method: "POST" });
    }
    await load();
    toast("Tre demokontoer er lagt inn: leder, trener og medlem.");
  })
);

formElement("#issue-form").addEventListener("submit", (event) => {
  event.preventDefault();
  act(event.submitter, async () => {
    const form = new FormData(formTarget(event.target));
    const note = $("#issue-note");
    try {
      const result = await api<Issued>("/issue", {
        json: {
          claimType: form.get("claimType"),
          request: pairs(form.get("request")),
          requesterDid: form.get("requesterDid") || form.get("subject"),
          subject: form.get("subject"),
        },
        method: "POST",
      });
      note.className = "note ok";
      note.textContent = `Utstedt ${result.attestation.claimType}, gyldig til ${result.attestation.expiresAt.slice(0, 10)}.`;
      note.hidden = false;
      await Promise.all([renderHeld(), renderAudit()]);
    } catch (error) {
      note.className = "note";
      note.textContent = errorMessage(error);
      note.hidden = false;
      await renderAudit();
    }
  });
});

$("#held").addEventListener("click", (event) => {
  const button =
    event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-revoke]")
      : null;
  if (!button) {
    return;
  }
  act(button, async () => {
    await api("/revoke", {
      json: { id: button.dataset.revoke, requesterDid: button.dataset.subject },
      method: "POST",
    });
    await Promise.all([renderHeld(), renderAudit()]);
    toast(
      "Attestasjonen er trukket tilbake. Statussvaret endrer seg med én gang."
    );
  });
});

formElement("#query-form").addEventListener("submit", (event) => {
  event.preventDefault();
  act(event.submitter, async () => {
    const form = new FormData(formTarget(event.target));
    const output = $("#answer");
    const requester = formText(form.get("requesterDid"));
    let attestations: AttestationRecord[] = [];
    try {
      const held = await api<{ attestations: Held }>(
        `/held?subject=${encodeURIComponent(requester)}`
      );
      attestations = held.attestations
        .filter((row) => row.claimType === "no.nif.clubRole" && !row.revokedAt)
        .map((row) => row.record)
        .filter(Boolean);
    } catch {
      /* the requester may hold nothing at all; that is an answer too */
    }
    try {
      const result = await api<QueryResult>("/query", {
        json: {
          attestations,
          claimType: "no.politiet.attest",
          request: { orgId: form.get("orgId") },
          requesterDid: requester,
          subject: form.get("subject"),
        },
        method: "POST",
      });
      const said =
        {
          expired: "Utløpt attest",
          none: "Ingen attest registrert",
          valid: "Gyldig attest",
        }[result.answer] || result.answer;
      output.className = "answer";
      output.innerHTML = `<strong>${escape(said)}</strong><span>Om ${escape(name(result.subject))}, kontrollert ${escape(result.checkedAt.slice(11, 19))}. Ingen dokumentasjon utleveres.</span>`;
    } catch (error) {
      output.className = "answer refused";
      output.innerHTML = `<strong>Ikke besvart</strong><span>${escape(errorMessage(error))}</span>`;
    }
    output.hidden = false;
    await renderAudit();
  });
});

// Issuing the restricted claim needs the police backend's own credential, so
// this form carries its own key rather than reusing the console's.
formElement("#attest-form").addEventListener("submit", (event) => {
  event.preventDefault();
  act(event.submitter, async () => {
    const form = new FormData(formTarget(event.target));
    const response = await fetch("/issue", {
      body: JSON.stringify({
        claimType: "no.politiet.attest",
        request: { orgId: form.get("orgId") },
        subject: form.get("subject"),
      }),
      headers: {
        authorization: `Bearer ${formText(form.get("token"))}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    const result: unknown = await response.json().catch(() => ({}));
    await renderAudit();
    if (!response.ok) {
      throw new Error(
        (typeof result === "object" &&
        result !== null &&
        "error" in result &&
        typeof result.error === "string"
          ? result.error
          : "") || `Utstederen svarte ${response.status}.`
      );
    }
    toast(
      "Attesten er registrert hos utstederen. Den publiseres ingen steder."
    );
  });
});

select("#held-subject").addEventListener("change", () => {
  run(renderHeld());
});

async function load() {
  try {
    const [document_, health, types] = await Promise.all([
      api<IssuerDocument>("/.well-known/attestation-issuer.json"),
      api<{ environment: string }>("/health").catch((): undefined => undefined),
      api<Descriptor[]>("/claim-types"),
    ]);
    renderIdentity(document_, health);
    renderTypes(types);
    const { people } = await api<{ people: Record<string, Person> }>(
      "/demo/roster"
    );
    renderPeople(people);
    await Promise.all([renderHeld(), renderAudit()]);
    dialogElement("#key-dialog").close();
  } catch (error) {
    if (!store.token) {
      askForKey();
    } else {
      toast(errorMessage(error));
    }
  }
}

if (!store.token) {
  askForKey();
}
await load();
