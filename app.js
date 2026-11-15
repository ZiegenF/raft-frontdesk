// RAFT Front Desk — a static site on top of the existing raft schema in Supabase.
// The database enforces what each staff role can see and change; this page only
// asks for columns the signed-in role is allowed to read (never select('*')).

const SUPABASE_URL = 'https://fhevkexblkqaonvuskzc.supabase.co';
const SUPABASE_KEY = 'sb_publishable_R8R3mDZXM5Iao4oMu2_iyA_mtcFSsbc'; // publishable key: safe to be public
const db = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { db: { schema: 'raft' } });

const ROLE_LABEL = { raft_admin: 'Admin', raft_scheduler: 'Scheduler', raft_counselor: 'Counselor' };
let session = null;
let role = null;

// ---------- permissions (mirror of the database grants) ----------
const can = {
  seeWages:     () => role === 'raft_admin',
  seeClinical:  () => role === 'raft_admin' || role === 'raft_counselor',   // notes + assignments
  schedule:     () => role === 'raft_admin' || role === 'raft_scheduler',
  editClients:  () => role === 'raft_admin' || role === 'raft_scheduler',
  editClinical: () => role === 'raft_admin' || role === 'raft_counselor',
};

// ---------- helpers ----------
const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (t) => t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
const fmtDate = (d) => d ? new Date(d + 'T00:00:00').toLocaleDateString([], { dateStyle: 'medium' }) : '';
const keptText = (k) => k === true ? 'Kept' : k === false ? 'Missed' : '—';

function decodeRole(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.role;
  } catch { return null; }
}

async function q(promise) {
  const { data, error } = await promise;
  if (error) throw new Error(error.message);
  return data;
}

// Load the tables a screen needs, asking only for columns this role may see.
async function loadData(tables) {
  const cols = {
    person: 'personid, firstname, lastname, address, city, state, zipcode, phonenumber, email',
    client: 'personid, foundout, remindermethod, referredby',
    counselor: 'personid, suffix',
    employee: 'personid, datehired, supervisorid' + (can.seeWages() ? ', wage' : ''),
    room: 'roomnumber, roomname',
    appointment: 'appointmentid, appointmenttime, duration, counselorid, employeeid, roomnumber' + (can.seeClinical() ? ', notes' : ''),
    scheduledfor: 'appointmentid, clientid, kept' + (can.seeClinical() ? ', assignment' : ''),
    family: 'familyid, name, datefounded',
    member_in_family: 'familymemberid, familyid, datejoined',
    member_role: 'familymemberid, familyid, roleid',
    role: 'roleid, rolename',
  };
  const results = await Promise.all(tables.map((t) => q(db.from(t).select(cols[t]))));
  const out = {};
  tables.forEach((t, i) => { out[t] = results[i]; });
  if (out.person) out.personById = Object.fromEntries(out.person.map((p) => [p.personid, p]));
  return out;
}

const fullName = (d, id) => { const p = d.personById?.[id]; return p ? `${p.firstname} ${p.lastname}` : `#${id}`; };
const counselorName = (d, id) => {
  const c = d.counselor?.find((x) => x.personid === id);
  return fullName(d, id) + (c?.suffix ? `, ${c.suffix}` : '');
};
const roomName = (d, n) => { const r = d.room?.find((x) => x.roomnumber === n); return r ? `${r.roomnumber} – ${r.roomname}` : n; };

// ---------- auth ----------
async function setSession(s) {
  session = s;
  role = s ? decodeRole(s.access_token) : null;
  if (!s) {
    $('#app').classList.add('hidden');
    $('#signin').classList.remove('hidden');
    $('#view').innerHTML = '';
    return;
  }
  $('#signin').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#who-email').textContent = s.user.email;
  $('#who-role').textContent = ROLE_LABEL[role] || 'No staff role';
  route();
}

$('#signin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#signin-error').textContent = '';
  const { error } = await db.auth.signInWithPassword({ email: $('#email').value.trim(), password: $('#password').value });
  if (error) {
    $('#signin-error').textContent = /invalid/i.test(error.message)
      ? 'Wrong email or password. Please try again.' : error.message;
  } else {
    $('#password').value = '';
    if (!location.hash) location.hash = '#home';
  }
});

$('#signout').addEventListener('click', async () => {
  await db.auth.signOut();
  location.hash = '';
});

db.auth.onAuthStateChange((event, s) => {
  if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'INITIAL_SESSION') setSession(s);
  else if (s) { session = s; role = decodeRole(s.access_token); }
});

// ---------- routing ----------
const screens = { home: renderHome, lookup: renderLookup, dashboard: renderDashboard, edit: renderEdit };
window.addEventListener('hashchange', route);

async function route() {
  if (!session) return;
  const name = (location.hash.replace('#', '').split('/')[0]) || 'home';
  document.querySelectorAll('header nav a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#' + name));
  const view = $('#view');
  if (!ROLE_LABEL[role]) {
    view.innerHTML = `<div class="card"><h2>No staff role</h2><p>This account has no RAFT staff role, so it cannot see any data. Ask an administrator to assign one.</p></div>`;
    return;
  }
  view.innerHTML = '<p class="muted">Loading…</p>';
  try {
    await (screens[name] || renderHome)(view);
  } catch (err) {
    view.innerHTML = `<div class="card error">Could not load data: ${esc(err.message)}</div>`;
  }
}

// ---------- 1. Home ----------
async function renderHome(view) {
  const d = await loadData(['person', 'client', 'counselor', 'room', 'appointment', 'scheduledfor']);
  const now = new Date();
  const sorted = [...d.appointment].sort((a, b) => new Date(a.appointmenttime) - new Date(b.appointmenttime));
  let list = sorted.filter((a) => new Date(a.appointmenttime) >= now).slice(0, 6);
  let heading = 'Upcoming appointments';
  if (list.length === 0) { list = sorted.slice(-6).reverse(); heading = 'Most recent appointments'; }

  const clientsFor = (id) => d.scheduledfor.filter((s) => s.appointmentid === id).map((s) => fullName(d, s.clientid)).join(', ');
  view.innerHTML = `
    <div class="card">
      <h2>Welcome, ${esc(ROLE_LABEL[role])}</h2>
      <p class="muted">Signed in as ${esc(session.user.email)}. RAFT has ${d.client.length} clients,
        ${d.counselor.length} counselors and ${d.room.length} rooms.</p>
    </div>
    <div class="grid">
      <a class="card" href="#lookup"><h3>Client lookup →</h3><p class="muted">Find a client: contact info, appointments and families.</p></a>
      <a class="card" href="#dashboard"><h3>Dashboard →</h3><p class="muted">Key statistics from the RAFT database.</p></a>
      <a class="card" href="#edit"><h3>Add / edit →</h3><p class="muted">${can.schedule() ? 'Schedule a new appointment or update a client or appointment.' : 'Record appointment notes and client assignments.'}</p></a>
    </div>
    <div class="card">
      <h3>${heading}</h3>
      <table><tr><th>When</th><th>Clients</th><th>Counselor</th><th>Room</th><th>Minutes</th></tr>
      ${list.map((a) => `<tr><td>${fmtTime(a.appointmenttime)}</td><td>${esc(clientsFor(a.appointmentid))}</td>
        <td>${esc(counselorName(d, a.counselorid))}</td><td>${esc(roomName(d, a.roomnumber))}</td><td>${a.duration}</td></tr>`).join('')}
      </table>
    </div>`;
}

// ---------- 2. Client lookup ----------
async function renderLookup(view) {
  const d = await loadData(['person', 'client', 'counselor', 'room', 'appointment', 'scheduledfor', 'family', 'member_in_family', 'member_role', 'role']);
  const clients = d.client.map((c) => ({ ...c, p: d.personById[c.personid] }))
    .sort((a, b) => (a.p.lastname + a.p.firstname).localeCompare(b.p.lastname + b.p.firstname));
  const selected = Number(location.hash.split('/')[1]) || null;

  view.innerHTML = `
    <div class="row">
      <div class="card" style="flex:0 1 300px">
        <h2>Client lookup</h2>
        <input id="search" placeholder="Search name, phone or email">
        <div id="results" class="clientlist"></div>
      </div>
      <div id="detail" style="flex:1 1 500px"><div class="card muted">Choose a client to see their details.</div></div>
    </div>`;

  const showResults = () => {
    const term = $('#search').value.toLowerCase();
    const hits = clients.filter(({ p }) => `${p.firstname} ${p.lastname} ${p.phonenumber} ${p.email}`.toLowerCase().includes(term));
    $('#results').innerHTML = hits.map(({ p }) => `<button data-id="${p.personid}">${esc(p.lastname)}, ${esc(p.firstname)}</button>`).join('')
      || '<p class="muted">No matching clients.</p>';
  };
  $('#search').addEventListener('input', showResults);
  $('#results').addEventListener('click', (e) => { const id = e.target.dataset.id; if (id) location.hash = '#lookup/' + id; });
  showResults();
  if (selected) showClient(d, selected);
}

function showClient(d, id) {
  const c = d.client.find((x) => x.personid === id);
  const p = d.personById[id];
  if (!c || !p) { $('#detail').innerHTML = '<div class="card error">Client not found.</div>'; return; }

  const appts = d.scheduledfor.filter((s) => s.clientid === id)
    .map((s) => ({ s, a: d.appointment.find((a) => a.appointmentid === s.appointmentid) }))
    .filter((x) => x.a)
    .sort((x, y) => new Date(y.a.appointmenttime) - new Date(x.a.appointmenttime));

  const roleNames = (mid, fid) => d.member_role.filter((r) => r.familymemberid === mid && r.familyid === fid)
    .map((r) => d.role.find((x) => x.roleid === r.roleid)?.rolename).filter(Boolean).join(', ');
  const families = d.member_in_family.filter((m) => m.familymemberid === id).map((m) => {
    const f = d.family.find((x) => x.familyid === m.familyid);
    const others = d.member_in_family.filter((o) => o.familyid === m.familyid && o.familymemberid !== id);
    return `<tr><td><b>${esc(f?.name)}</b><br><span class="muted">founded ${fmtDate(f?.datefounded)}</span></td>
      <td>${esc(roleNames(id, m.familyid))}</td><td>${fmtDate(m.datejoined)}</td>
      <td>${others.map((o) => `${esc(fullName(d, o.familymemberid))} <span class="muted">(${esc(roleNames(o.familymemberid, m.familyid))})</span>`).join('<br>')}</td></tr>`;
  }).join('');

  const referrer = c.referredby ? fullName(d, c.referredby) : '—';
  const referred = d.client.filter((x) => x.referredby === id).map((x) => fullName(d, x.personid)).join(', ') || '—';

  $('#detail').innerHTML = `
    <div class="card">
      <h2>${esc(p.firstname)} ${esc(p.lastname)} <span class="muted">#${p.personid}</span></h2>
      <div class="row">
        <div><b>Address</b><br>${esc(p.address)}<br>${esc(p.city)}, ${esc(p.state)} ${esc(p.zipcode)}</div>
        <div><b>Phone</b><br>${esc(p.phonenumber)}<br><b>Email</b><br>${esc(p.email)}</div>
        <div><b>Reminder method</b><br>${esc(c.remindermethod || '—')}<br><b>Found out via</b><br>${esc(c.foundout || '—')}</div>
        <div><b>Referred by</b><br>${esc(referrer)}<br><b>Has referred</b><br>${esc(referred)}</div>
      </div>
      ${can.editClients() ? `<p><a href="#edit/client/${id}">Edit this client →</a></p>` : ''}
    </div>
    <div class="card">
      <h3>Appointments (${appts.length})</h3>
      ${appts.length ? `<table><tr><th>When</th><th>Counselor</th><th>Room</th><th>Min</th><th>Kept</th>${can.seeClinical() ? '<th>Assignment</th><th>Notes</th>' : ''}</tr>
      ${appts.map(({ s, a }) => `<tr><td>${fmtTime(a.appointmenttime)}</td><td>${esc(counselorName(d, a.counselorid))}</td>
        <td>${esc(roomName(d, a.roomnumber))}</td><td>${a.duration}</td><td>${keptText(s.kept)}</td>
        ${can.seeClinical() ? `<td>${esc(s.assignment || '')}</td><td>${esc(a.notes || '')}</td>` : ''}</tr>`).join('')}</table>`
        : '<p class="muted">No appointments.</p>'}
    </div>
    <div class="card">
      <h3>Families</h3>
      ${families ? `<table><tr><th>Family</th><th>Their roles</th><th>Joined</th><th>Other members</th></tr>${families}</table>`
        : '<p class="muted">Not a member of any family on record.</p>'}
    </div>`;
}

// ---------- 3. Dashboard ----------
function bars(rows) {
  const max = Math.max(1, ...rows.map((r) => r[1]));
  return `<table>${rows.map(([label, n, extra]) => `<tr><td style="width:40%">${esc(label)}</td>
    <td><div class="bar" style="width:${(n / max) * 100}%"></div></td><td style="width:20%">${n}${extra ? ' · ' + esc(extra) : ''}</td></tr>`).join('')}</table>`;
}

async function renderDashboard(view) {
  const d = await loadData(['person', 'client', 'counselor', 'employee', 'room', 'appointment', 'scheduledfor', 'family']);
  const perCounselor = d.counselor.map((c) => [counselorName(d, c.personid), d.appointment.filter((a) => a.counselorid === c.personid).length])
    .sort((a, b) => b[1] - a[1]);
  const perRoom = d.room.map((r) => {
    const appts = d.appointment.filter((a) => a.roomnumber === r.roomnumber);
    const hours = appts.reduce((s, a) => s + a.duration, 0) / 60;
    return [`${r.roomnumber} – ${r.roomname}`, appts.length, `${hours.toFixed(1)} h booked`];
  });
  const countBy = (arr, key) => Object.entries(arr.reduce((m, x) => { const k = x[key] || 'Not recorded'; m[k] = (m[k] || 0) + 1; return m; }, {}))
    .sort((a, b) => b[1] - a[1]);
  const kept = d.scheduledfor.filter((s) => s.kept === true).length;
  const recorded = d.scheduledfor.filter((s) => s.kept !== null).length;
  const minutes = d.appointment.reduce((s, a) => s + a.duration, 0);
  // Referrals come from client.referredby (a client pointing to the client who referred them).
  const referredCount = d.client.filter((c) => c.referredby).length;
  const topReferrers = countBy(d.client.filter((c) => c.referredby), 'referredby')
    .map(([id, n]) => [fullName(d, Number(id)), n]);

  view.innerHTML = `
    <h2>Dashboard</h2>
    <div class="grid">
      <div class="card"><div class="stat">${d.client.length}</div>clients</div>
      <div class="card"><div class="stat">${d.appointment.length}</div>appointments</div>
      <div class="card"><div class="stat">${d.counselor.length}</div>counselors</div>
      <div class="card"><div class="stat">${d.employee.length}</div>employees</div>
      <div class="card"><div class="stat">${d.family.length}</div>families</div>
      <div class="card"><div class="stat">${recorded ? Math.round((kept / recorded) * 100) : 0}%</div>client appointments kept (${kept} of ${recorded})</div>
      <div class="card"><div class="stat">${d.appointment.length ? Math.round(minutes / d.appointment.length) : 0}</div>average minutes per appointment</div>
    </div>
    <div class="grid">
      <div class="card"><h3>Appointments per counselor</h3>${bars(perCounselor)}</div>
      <div class="card"><h3>Room use</h3>${bars(perRoom)}</div>
      <div class="card"><h3>How clients found RAFT</h3>${bars(countBy(d.client, 'foundout'))}</div>
      <div class="card"><h3>Preferred reminder method</h3>${bars(countBy(d.client, 'remindermethod'))}</div>
      <div class="card"><h3>Client referrals</h3>
        <p><span class="stat">${referredCount}</span> of ${d.client.length} clients
          (${d.client.length ? Math.round((referredCount / d.client.length) * 100) : 0}%) were referred by another client.</p>
        <p class="muted">Top referrers</p>${bars(topReferrers)}</div>
    </div>
    ${can.seeWages() ? `<div class="card"><h3>Employee wages <span class="muted">(Admin only)</span></h3>
      <table><tr><th>Employee</th><th>Hired</th><th>Supervisor</th><th>Wage</th></tr>
      ${d.employee.map((e) => `<tr><td>${esc(fullName(d, e.personid))}</td><td>${fmtDate(e.datehired)}</td>
        <td>${esc(fullName(d, e.supervisorid))}</td><td>$${Number(e.wage).toFixed(2)}/h</td></tr>`).join('')}
      </table><p class="muted">Average wage: $${(d.employee.reduce((s, e) => s + Number(e.wage), 0) / (d.employee.length || 1)).toFixed(2)}/h</p></div>` : ''}`;
}

// ---------- 4. Add or edit a record ----------
async function renderEdit(view) {
  const d = await loadData(['person', 'client', 'counselor', 'employee', 'room', 'appointment', 'scheduledfor']);
  const parts = location.hash.split('/');
  const tabs = [];
  if (can.schedule()) tabs.push(['new', 'New appointment'], ['appt', 'Edit appointment']);
  if (can.editClients()) tabs.push(['client', 'Edit client']);
  if (can.editClinical()) tabs.push(['notes', 'Notes & assignments']);
  const tab = tabs.find((t) => t[0] === parts[1]) ? parts[1] : tabs[0][0];

  view.innerHTML = `
    <h2>Add or edit a record</h2>
    <div class="tabs">${tabs.map(([k, label]) => `<button class="secondary ${k === tab ? 'active' : ''}" data-tab="${k}">${label}</button>`).join('')}</div>
    <div id="form-area"></div>`;
  view.querySelector('.tabs').addEventListener('click', (e) => { if (e.target.dataset.tab) location.hash = '#edit/' + e.target.dataset.tab; });

  const area = $('#form-area');
  ({ new: formNewAppointment, appt: formEditAppointment, client: formEditClient, notes: formNotes })[tab](area, d, Number(parts[2]) || null);
}

const option = (value, label, sel) => `<option value="${esc(value)}" ${String(value) === String(sel) ? 'selected' : ''}>${esc(label)}</option>`;
const clientOptions = (d, sel) => d.client.map((c) => [c.personid, fullName(d, c.personid)]).sort((a, b) => a[1].localeCompare(b[1]))
  .map(([id, n]) => option(id, n, sel)).join('');
const apptLabel = (d, a) => `#${a.appointmentid} · ${fmtTime(a.appointmenttime)} · ${counselorName(d, a.counselorid)} · ` +
  d.scheduledfor.filter((s) => s.appointmentid === a.appointmentid).map((s) => fullName(d, s.clientid)).join(', ');
const apptOptions = (d, sel) => [...d.appointment].sort((a, b) => new Date(b.appointmenttime) - new Date(a.appointmenttime))
  .map((a) => option(a.appointmentid, apptLabel(d, a), sel)).join('');

function scheduleFields(d, a = {}) {
  return `
    <div class="row">
      <label>Date and time <input type="datetime-local" name="appointmenttime" required value="${esc((a.appointmenttime || '').slice(0, 16))}"></label>
      <label>Duration (minutes) <input type="number" name="duration" min="1" required value="${esc(a.duration ?? 60)}"></label>
    </div>
    <div class="row">
      <label>Counselor <select name="counselorid" required>${d.counselor.map((c) => option(c.personid, counselorName(d, c.personid), a.counselorid)).join('')}</select></label>
      <label>Scheduled by (employee) <select name="employeeid" required>${d.employee.map((e) => option(e.personid, fullName(d, e.personid), a.employeeid)).join('')}</select></label>
      <label>Room <select name="roomnumber" required>${d.room.map((r) => option(r.roomnumber, `${r.roomnumber} – ${r.roomname}`, a.roomnumber)).join('')}</select></label>
    </div>`;
}

function readSchedule(form) {
  const f = new FormData(form);
  return {
    appointmenttime: f.get('appointmenttime'),
    duration: Number(f.get('duration')),
    counselorid: Number(f.get('counselorid')),
    employeeid: Number(f.get('employeeid')),
    roomnumber: Number(f.get('roomnumber')),
  };
}

function wireSave(form, save) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = form.querySelector('.msg');
    msg.className = 'msg muted'; msg.textContent = 'Saving…';
    try {
      const text = await save();
      msg.className = 'msg ok'; msg.innerHTML = text;
    } catch (err) {
      msg.className = 'msg error'; msg.textContent = 'Not saved: ' + err.message;
    }
  });
}

function formNewAppointment(area, d) {
  area.innerHTML = `<form class="card"><h3>Schedule a new appointment</h3>
    ${scheduleFields(d)}
    <label>Clients (hold Ctrl / Cmd to choose more than one)
      <select name="clients" multiple size="8" required>${clientOptions(d)}</select></label>
    <button type="submit">Save appointment</button> <p class="msg"></p>
    <p class="muted">New clients cannot be added from this site: the raft schema requires a person and their client row to be
      created in one transaction, which the website's one-request-at-a-time connection cannot do without adding a database function.</p></form>`;
  const form = area.querySelector('form');
  wireSave(form, async () => {
    const clients = [...form.clients.selectedOptions].map((o) => Number(o.value));
    if (!clients.length) throw new Error('Choose at least one client.');
    const appt = await q(db.from('appointment').insert(readSchedule(form)).select('appointmentid').single());
    await q(db.from('scheduledfor').insert(clients.map((clientid) => ({ appointmentid: appt.appointmentid, clientid }))));
    return `Appointment #${appt.appointmentid} saved. <a href="#lookup/${clients[0]}">See it in client lookup →</a>`;
  });
}

function formEditAppointment(area, d, id) {
  const a = d.appointment.find((x) => x.appointmentid === id) || [...d.appointment].sort((x, y) => new Date(y.appointmenttime) - new Date(x.appointmenttime))[0];
  area.innerHTML = `<form class="card"><h3>Edit an appointment</h3>
    <label>Appointment <select id="pick">${apptOptions(d, a.appointmentid)}</select></label>
    ${scheduleFields(d, a)}
    <button type="submit">Save changes</button> <p class="msg"></p></form>`;
  $('#pick').addEventListener('change', (e) => { location.hash = '#edit/appt/' + e.target.value; });
  wireSave(area.querySelector('form'), async () => {
    await q(db.from('appointment').update(readSchedule(area.querySelector('form'))).eq('appointmentid', a.appointmentid));
    return `Appointment #${a.appointmentid} updated.`;
  });
}

function formEditClient(area, d, id) {
  const c = d.client.find((x) => x.personid === id) || d.client[0];
  const p = d.personById[c.personid];
  const field = (name, label, val, attrs = '') => `<label>${label} <input name="${name}" value="${esc(val)}" ${attrs}></label>`;
  area.innerHTML = `<form class="card"><h3>Edit a client</h3>
    <label>Client <select id="pick">${clientOptions(d, c.personid)}</select></label>
    <div class="row">${field('firstname', 'First name', p.firstname, 'required maxlength="50"')}${field('lastname', 'Last name', p.lastname, 'required maxlength="50"')}</div>
    <div class="row">${field('address', 'Address', p.address, 'maxlength="50"')}${field('city', 'City', p.city, 'maxlength="50"')}
      ${field('state', 'State', p.state, 'maxlength="2"')}${field('zipcode', 'ZIP', p.zipcode, 'maxlength="10"')}</div>
    <div class="row">${field('phonenumber', 'Phone', p.phonenumber, 'maxlength="14"')}${field('email', 'Email', p.email, 'type="email" maxlength="100"')}</div>
    <div class="row">${field('foundout', 'Found out via', c.foundout, 'maxlength="50"')}${field('remindermethod', 'Reminder method', c.remindermethod, 'maxlength="50"')}
      <label>Referred by <select name="referredby"><option value="">— none —</option>${clientOptions(d, c.referredby)}</select></label></div>
    <button type="submit">Save client</button> <p class="msg"></p></form>`;
  $('#pick').addEventListener('change', (e) => { location.hash = '#edit/client/' + e.target.value; });
  const form = area.querySelector('form');
  wireSave(form, async () => {
    const f = Object.fromEntries(new FormData(form));
    const blank = (v) => (v === '' ? null : v);
    await q(db.from('person').update({
      firstname: f.firstname, lastname: f.lastname, address: blank(f.address), city: blank(f.city), state: blank(f.state),
      zipcode: blank(f.zipcode), phonenumber: blank(f.phonenumber), email: blank(f.email),
    }).eq('personid', c.personid));
    await q(db.from('client').update({
      foundout: blank(f.foundout), remindermethod: blank(f.remindermethod), referredby: f.referredby ? Number(f.referredby) : null,
    }).eq('personid', c.personid));
    return `Client saved. <a href="#lookup/${c.personid}">See it in client lookup →</a>`;
  });
}

function formNotes(area, d, id) {
  const a = d.appointment.find((x) => x.appointmentid === id) || [...d.appointment].sort((x, y) => new Date(y.appointmenttime) - new Date(x.appointmenttime))[0];
  const sfs = d.scheduledfor.filter((s) => s.appointmentid === a.appointmentid);
  area.innerHTML = `<form class="card"><h3>Appointment notes and client assignments</h3>
    <label>Appointment <select id="pick">${apptOptions(d, a.appointmentid)}</select></label>
    <p class="muted">${fmtTime(a.appointmenttime)} · ${a.duration} min · ${esc(counselorName(d, a.counselorid))} · Room ${esc(roomName(d, a.roomnumber))}</p>
    <label>Appointment notes <textarea name="notes" maxlength="3000">${esc(a.notes || '')}</textarea></label>
    ${sfs.map((s) => `<fieldset class="card"><legend><b>${esc(fullName(d, s.clientid))}</b></legend>
      <label>Assignment <textarea name="assignment-${s.clientid}" maxlength="2000">${esc(s.assignment || '')}</textarea></label>
      <label>Kept? <select name="kept-${s.clientid}">${option('', '— not recorded —', s.kept ?? '')}${option('true', 'Kept', s.kept)}${option('false', 'Missed', s.kept)}</select></label>
    </fieldset>`).join('')}
    <button type="submit">Save notes</button> <p class="msg"></p></form>`;
  $('#pick').addEventListener('change', (e) => { location.hash = '#edit/notes/' + e.target.value; });
  const form = area.querySelector('form');
  wireSave(form, async () => {
    const f = new FormData(form);
    await q(db.from('appointment').update({ notes: f.get('notes') || null }).eq('appointmentid', a.appointmentid));
    for (const s of sfs) {
      const k = f.get('kept-' + s.clientid);
      await q(db.from('scheduledfor').update({
        assignment: f.get('assignment-' + s.clientid) || null,
        kept: k === '' ? null : k === 'true',
      }).eq('appointmentid', a.appointmentid).eq('clientid', s.clientid));
    }
    return `Notes for appointment #${a.appointmentid} saved. <a href="#lookup/${sfs[0]?.clientid ?? ''}">See it in client lookup →</a>`;
  });
}
