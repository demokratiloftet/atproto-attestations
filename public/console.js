// The operator console. It is an ordinary client of the issuer's HTTP API: it
// holds a client token, and it can do nothing the API would not allow anyone.
const $ = selector => document.querySelector(selector);
const store = { token: sessionStorage.getItem('issuer-token') || '', roster: {}, types: [], subject: '' };
let toastTimer;

const toast = message => {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('#toast').hidden = true), 5000);
};

async function api(path, { method = 'GET', json } = {}) {
  const response = await fetch(path, {
    method,
    headers: { ...(store.token && { authorization: `Bearer ${store.token}` }), ...(json && { 'content-type': 'application/json' }) },
    ...(json && { body: JSON.stringify(json) }),
  });
  const result = await response.json().catch(() => ({}));
  if (response.status === 401) { askForKey(); throw new Error('Klientnøkkelen mangler eller er feil.'); }
  if (!response.ok) throw new Error(result.error || `Utstederen svarte ${response.status}.`);
  return result;
}

function askForKey() {
  const dialog = $('#key-dialog');
  if (!dialog.open) dialog.showModal();
}
$('#key-form').addEventListener('submit', () => {
  store.token = new FormData($('#key-form')).get('token');
  sessionStorage.setItem('issuer-token', store.token);
  load();
});

const name = did => did.replace(/^did:plc:demo-/, '').replace(/^did:plc:/, '');
const options = (select, entries, placeholder) => {
  const chosen = select.value;
  select.innerHTML = (placeholder ? `<option value="">${placeholder}</option>` : '') +
    entries.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  if (entries.some(([value]) => value === chosen)) select.value = chosen;
};

function renderIdentity(document_, health) {
  $('#issuer-name').textContent = document_.name;
  $('#issuer-url').textContent = document_.issuer;
  const key = document_.keys[0];
  $('#issuer-key').textContent = `${key.kid} · ${key.x.slice(0, 12)}…${key.x.slice(-6)}`;
  $('#issuer-publish').textContent = document_.atprotoRepo
    ? `Offentlige attestasjoner publiseres i ${document_.atprotoRepo}`
    : 'Ingen publisering konfigurert. Attestasjonene ligger hos utstederen.';
  document.title = `${document_.name} — utstederpult`;
  if (health) $('#issuer-name').title = `Miljø: ${health.environment}`;
}

function renderTypes(types) {
  store.types = types;
  $('#claim-types').innerHTML = types.map(type => `
    <li class="${type.visibility === 'restricted' ? 'restricted' : ''}">
      <strong>${escape(type.label.nb)}</strong>
      <span>${type.visibility === 'restricted' ? 'Besvares på spørsmål' : 'Publiseres som post'}</span>
    </li>`).join('');
  options($('#issue-type'), types.filter(t => t.visibility === 'public').map(t => [t.id, t.label.nb]));
}

function renderPeople(people) {
  store.roster = people;
  const entries = Object.entries(people);
  $('#people').innerHTML = entries.length
    ? entries.map(([did, facts]) => `<li><strong>${escape(name(did))}</strong><span>${escape(describe(facts))}</span></li>`).join('')
    : '<li class="empty">Ingen kontoer ennå.</li>';
  const choices = entries.map(([did]) => [did, name(did)]);
  for (const id of ['#issue-subject', '#held-subject', '#query-subject', '#query-requester', '#attest-subject']) options($(id), choices);
  options($('#issue-requester'), choices, 'Kontoen selv');
  if (!store.subject && choices.length) store.subject = choices[0][0];
  if (store.subject) $('#held-subject').value = store.subject;
}

const describe = facts => [
  ...(facts.clubs || []).map(club => `${club.role} i ${club.orgName}`),
  ...(facts.licences || []).map(licence => `lisens: ${licence.discipline}`),
  ...(facts.attests?.length ? ['politiattest levert'] : []),
].join(' · ') || 'ingen registrerte fakta';

async function renderHeld() {
  const subject = $('#held-subject').value;
  store.subject = subject;
  if (!subject) return void ($('#held').innerHTML = '<li class="empty">Velg en konto.</li>');
  const { attestations } = await api(`/held?subject=${encodeURIComponent(subject)}`);
  $('#held').innerHTML = attestations.length ? attestations.map(row => {
    const label = store.types.find(type => type.id === row.claimType)?.label.nb || row.claimType;
    const gone = row.revokedAt || Date.parse(row.expiresAt) <= Date.now();
    return `<li>
      <span class="what">${escape(label)}</span>
      <span class="detail">${escape(Object.values(row.claim).join(' · '))}</span>
      <span class="state ${gone ? 'gone' : ''}">${row.revokedAt ? 'Trukket tilbake' : gone ? 'Utløpt' : `Gyldig til ${row.expiresAt.slice(0, 10)}`}</span>
      ${gone ? '' : `<button data-revoke="${row.id}" data-subject="${escape(subject)}">Trekk tilbake</button>`}
    </li>`;
  }).join('') : '<li class="empty">Ingen attestasjoner for denne kontoen.</li>';
}

async function renderAudit() {
  const { entries } = await api('/audit?limit=25');
  $('#audit').innerHTML = entries.length ? entries.map(row => `<li>
    <time>${row.at.slice(11, 19)}</time>
    <span class="outcome ${row.outcome === 'allowed' ? 'allowed' : 'denied'}">${escape(action(row))}</span>
    <span class="what">${escape(row.claim_type || '')} ${row.subject ? `om ${name(row.subject)}` : ''} ${row.actor ? `· spurt av ${name(row.actor)}` : ''}</span>
  </li>`).join('') : '<li class="empty">Ingenting er gjort ennå.</li>';
}

const action = row => ({ issue: 'utstedt', revoke: 'trukket', query: 'spurt', publish: 'publisert' }[row.action] || row.action)
  + (row.outcome === 'allowed' ? '' : ` · ${row.outcome === 'denied' ? 'avvist' : row.outcome}`);

function escape(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

const pairs = text => Object.fromEntries(String(text || '').split(/[,\s]+/).filter(Boolean).map(part => {
  const [field, ...rest] = part.split('=');
  return [field, rest.join('=')];
}));

async function act(button, work) {
  button.disabled = true;
  try { await work(); }
  catch (error) { toast(error.message); }
  finally { button.disabled = false; }
}

$('#seed').addEventListener('click', event => act(event.target, async () => {
  const cast = {
    'did:plc:demo-leder': { identity: { assuranceLevel: 'substantial', provider: 'demo-idp' }, clubs: [{ orgId: 'fjord', orgName: 'Fjord idrettslag', role: 'leder' }] },
    'did:plc:demo-trener': { identity: { assuranceLevel: 'substantial', provider: 'demo-idp' }, clubs: [{ orgId: 'fjord', orgName: 'Fjord idrettslag', role: 'trener' }], licences: [{ discipline: 'svomming', level: 'instruktor-2', orgId: 'fjord' }], attests: [{ orgId: 'fjord' }] },
    'did:plc:demo-medlem': { identity: { assuranceLevel: 'substantial', provider: 'demo-idp' }, clubs: [{ orgId: 'fjord', orgName: 'Fjord idrettslag', role: 'medlem' }] },
  };
  for (const [subject, facts] of Object.entries(cast)) await api('/demo/enrol', { method: 'POST', json: { subject, facts } });
  await load();
  toast('Tre demokontoer er lagt inn: leder, trener og medlem.');
}));

$('#issue-form').addEventListener('submit', event => {
  event.preventDefault();
  act(event.submitter, async () => {
    const form = new FormData(event.target);
    const note = $('#issue-note');
    try {
      const result = await api('/issue', { method: 'POST', json: {
        claimType: form.get('claimType'), subject: form.get('subject'),
        request: pairs(form.get('request')), requesterDid: form.get('requesterDid') || form.get('subject'),
      } });
      note.className = 'note ok';
      note.textContent = `Utstedt ${result.attestation.claimType}, gyldig til ${result.attestation.expiresAt.slice(0, 10)}.`;
      note.hidden = false;
      await Promise.all([renderHeld(), renderAudit()]);
    } catch (error) {
      note.className = 'note';
      note.textContent = error.message;
      note.hidden = false;
      await renderAudit();
    }
  });
});

$('#held').addEventListener('click', event => {
  const button = event.target.closest('[data-revoke]');
  if (!button) return;
  act(button, async () => {
    await api('/revoke', { method: 'POST', json: { id: button.dataset.revoke, requesterDid: button.dataset.subject } });
    await Promise.all([renderHeld(), renderAudit()]);
    toast('Attestasjonen er trukket tilbake. Statussvaret endrer seg med én gang.');
  });
});

$('#query-form').addEventListener('submit', event => {
  event.preventDefault();
  act(event.submitter, async () => {
    const form = new FormData(event.target);
    const output = $('#answer');
    const requester = form.get('requesterDid');
    let attestations = [];
    try {
      const held = await api(`/held?subject=${encodeURIComponent(requester)}`);
      attestations = held.attestations.filter(row => row.claimType === 'no.nif.clubRole' && !row.revokedAt).map(row => row.record).filter(Boolean);
    } catch { /* the requester may hold nothing at all; that is an answer too */ }
    try {
      const result = await api('/query', { method: 'POST', json: {
        claimType: 'no.politiet.attest', subject: form.get('subject'),
        request: { orgId: form.get('orgId') }, requesterDid: requester, attestations,
      } });
      const said = { valid: 'Gyldig attest', none: 'Ingen attest registrert', expired: 'Utløpt attest' }[result.answer] || result.answer;
      output.className = 'answer';
      output.innerHTML = `<strong>${escape(said)}</strong><span>Om ${escape(name(result.subject))}, kontrollert ${escape(result.checkedAt.slice(11, 19))}. Ingen dokumentasjon utleveres.</span>`;
    } catch (error) {
      output.className = 'answer refused';
      output.innerHTML = `<strong>Ikke besvart</strong><span>${escape(error.message)}</span>`;
    }
    output.hidden = false;
    await renderAudit();
  });
});

// Issuing the restricted claim needs the police backend's own credential, so
// this form carries its own key rather than reusing the console's.
$('#attest-form').addEventListener('submit', event => {
  event.preventDefault();
  act(event.submitter, async () => {
    const form = new FormData(event.target);
    const response = await fetch('/issue', {
      method: 'POST',
      headers: { authorization: `Bearer ${form.get('token')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ claimType: 'no.politiet.attest', subject: form.get('subject'), request: { orgId: form.get('orgId') } }),
    });
    const result = await response.json().catch(() => ({}));
    await renderAudit();
    if (!response.ok) throw new Error(result.error || `Utstederen svarte ${response.status}.`);
    toast('Attesten er registrert hos utstederen. Den publiseres ingen steder.');
  });
});

$('#held-subject').addEventListener('change', () => renderHeld().catch(error => toast(error.message)));

async function load() {
  try {
    const [document_, health, types] = await Promise.all([
      fetch('/.well-known/attestation-issuer.json').then(response => response.json()),
      fetch('/health').then(response => response.json()).catch(() => undefined),
      api('/claim-types'),
    ]);
    renderIdentity(document_, health);
    renderTypes(types);
    const { people } = await api('/demo/roster');
    renderPeople(people);
    await Promise.all([renderHeld(), renderAudit()]);
    $('#key-dialog').close();
  } catch (error) {
    if (!store.token) askForKey();
    else toast(error.message);
  }
}

if (!store.token) askForKey();
await load();
