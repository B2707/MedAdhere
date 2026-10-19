'use strict';
// Follows the patient-record, trends, review, and patient-management components.
// Fixtures below are synthetic. No API calls or patient-management writes are made.
const STEPS = [
  [0, 'roster', 'Start with the patient roster and cohort overview'],
  [4, 'find', 'Search the roster and select Alice Chen'],
  [7, 'record', "Open Alice's daily record"],
  [11, 'evidence', 'Open the source behind the recorded severity'],
  [15, 'calendar', 'Use the calendar to read an earlier day'],
  [19, 'doses', 'Inspect dose history and the reason for a skipped dose'],
  [24, 'severity', 'Compare symptom severity across days'],
  [29, 'adherence', 'Explore daily adherence outcomes'],
  [33, 'history', 'Read medications, allergies, conditions, and notes'],
  [38, 'revisions', 'Trace saved revisions and earlier versions'],
  [42, 'reviews', 'Inspect classification and safety review queues'],
  [47, 'manage', 'Open reminder settings and patient details'],
  [52, 'enroll', 'Preview enrollment and local check-in times'],
  [56, 'finish', "Return to Alice's current record"],
].map(([at, id, title]) => ({at, id, title}));
const END = 60;
const $ = s => document.querySelector(s);
const clamp = p => Math.max(0, Math.min(1, p));
const ease = p => 1 - Math.pow(1 - clamp(p), 3);
const pill = (text, tone = '') => `<span class="pill ${tone}">${text}</span>`;
const button = (text, id, kind = '') => `<span class="button ${kind}" data-id="${id}">${text}</span>`;
const ranges = n => `<div class="range">${[7,30,90].map(d => `<span class="${n === d ? 'on' : ''}" data-id="range-${d}">${d} days</span>`).join('')}</div>`;
const heading = (title, description, actions = '') => `<div class="heading"><div><h1>${title}</h1><p class="muted">${description}</p></div><div class="actions">${actions}</div></div>`;
const patientHeading = () => heading('Alice Chen', 'Metformin 500 mg · +1 514 555 0101 · America/Toronto', ranges(30) + button('Manage patient', 'manage'));
const people = [['Alice Chen','Metformin 500 mg','93.1%','Just now'],['Sam Rivera','Atorvastatin','96.7%','12 min ago'],['Nora Patel','Metformin','90.0%','27 min ago'],['Omar Hassan','Amlodipine','93.3%','41 min ago']];
const dots = i => `<div class="dose-dots">${Array.from({length:7},(_,j)=>`<i class="${j === 4 && i === 0 ? 'skip' : ''}">${j === 4 && i === 0 ? '×' : '✓'}</i>`).join('')}</div>`;

function roster(query) {
  const filtered = query.length > 1;
  return heading('Cohort overview', '4 patients receiving check-ins in the monitored research cohort.', ranges(30) + button('Study analytics','analytics') + button('Enroll patient','enroll','primary')) +
    `<div class="metrics">${[['Cohort adherence','93.3%','Resolved dose outcomes'],['Active patients','4','Receiving check-ins'],['Reply rate · 30d','96.7%','Patient replies received'],['Open alerts','0','In the selected window']].map(([k,v,d])=>`<div class="card metric"><p>${k}</p><b>${v}</b><small>${d}</small></div>`).join('')}</div>
    <div class="card table-card"><div class="table-head"><h2>Patients ${pill(filtered ? '1 result' : '4 patients')}</h2><div class="search ${query ? 'filled' : ''}" data-id="search">${query || 'Search patients by name or phone'}</div></div>
    <table><thead><tr><th>Patient</th><th>Medication</th><th>Recent doses</th><th>Adherence</th><th>Last reply</th><th>Status</th></tr></thead><tbody>
    ${people.filter((_,i)=>!filtered || i === 0).map(([name,med,rate,time],i)=>`<tr class="${query ? 'selected' : ''}"><td class="name"><span style="display:inline-block" data-id="${i === 0 ? 'alice' : 'other'}">${name}</span></td><td>${med}</td><td>${dots(i)}</td><td>${rate}</td><td>${time}</td><td>${pill('Receiving check-ins','green')} ${pill('test')}</td></tr>`).join('')}</tbody></table></div>
    <div class="card cohort-chart"><div><h3>Cohort adherence over time</h3><p class="muted">Study analytics · selected 30-day window</p></div><svg viewBox="0 0 660 65"><path d="M0 54H660 M0 30H660 M0 7H660" stroke="#e2e8f0"/><path d="M0 43L50 38L100 40L150 25L200 30L250 20L300 26L350 15L400 22L450 13L500 16L550 10L600 14L660 8" fill="none" stroke="#0d9488" stroke-width="3"/></svg></div>`;
}

const conversation = [
  ['Hi, how are you feeling today? Have you taken your Metformin today?', 'Pretty good, a bit of a headache.', 'Headache'],
  ['Sorry to hear about the headache. On a scale of 1 to 10, what number would you give it?', '8', 'Headache · SEV 8 / 10'],
  ['Thanks. When did the headache start?', 'Around lunch', 'Headache · Onset: Around lunch'],
  ['What does the headache feel like?', 'Like pressure behind my eyes', 'Headache · Character: Pressure behind the eyes'],
];
function pairs(previous, evidence) {
  const rows = previous ? [['Have you taken your Metformin today?', 'Yes, at 9:10.', 'Metformin · Taken'],['How strong is the headache today?', '4 out of 10.', 'Headache · SEV 4 / 10']] : conversation;
  return rows.map(([question, reply, event],i)=>`<div class="pair" data-pair="${i}"><div class="question"><div class="kicker">${i === 0 ? 'CHECK-IN' : 'CLARIFICATION'}</div>${question}</div><div class="reply"><div class="kicker">FROM PATIENT</div>${reply}</div><div class="event"><b>${event}</b><span class="source" data-id="${i === 1 ? 'source' : 'other-source'}">1 source ▾</span>${evidence && i === 1 ? '<div class="evidence"><div class="kicker">SOURCE MESSAGE · PATIENT REPLY</div><blockquote>8</blockquote>In reply to the question asking for headache severity on a scale of 1 to 10.<br><span class="muted">Recorded from this message, with the source preserved.</span></div>' : ''}</div></div>`).join('');
}
function calendar() {
  return `<div class="calendar"><h3>October 2026</h3><div class="calendar-grid">${['M','T','W','T','F','S','S'].map(d=>`<b>${d}</b>`).join('')}${Array.from({length:3},()=>'<span></span>').join('')}${Array.from({length:31},(_,i)=>`<span class="${i === 18 ? 'chosen' : i === 17 ? 'prior' : ''}" data-id="day-${i+1}">${i+1}</span>`).join('')}</div></div>`;
}
function record({previous = false, evidence = false, calendarOpen = false} = {}) {
  const day = previous ? '18' : '19';
  const summary = previous ? 'Alice reported taking her Metformin at 9:10 and rated her headache 4 out of 10.' : 'Alice reported a headache, rated it 8 out of 10, and described pressure behind her eyes beginning around lunch. Metformin intake was not reported in this exchange.';
  return patientHeading() + `<div class="card daybar"><div class="date"><span>‹</span><span>${previous ? 'Sun' : 'Mon'}, Oct ${day}, 2026</span><span>›</span><span class="calendar-button" data-id="calendar">Calendar ▾</span></div><span class="muted">0 emergency · 0 important · ${previous ? '4 messages · 2' : '8 messages · 4'} events</span>${calendarOpen ? calendar() : ''}</div>
    <div class="grid"><div class="card thread-card"><h2>Day thread · Oct ${day}, 2026</h2><div class="thread-viewport" style="height:365px"><div class="thread-track">${pairs(previous,evidence)}</div></div></div>
    <div class="stack"><div class="card summary"><h2>What happened today</h2><div class="kicker" style="margin-top:8px">AGENT-GENERATED · V1</div><p>${summary}</p></div><div class="card"><h3>Recorded symptom details</h3><div class="details-list">${[['Symptom','Headache'],['Severity',previous ? '4 / 10' : '8 / 10'],['Onset',previous ? 'Not reported' : 'Around lunch'],['Character',previous ? 'Not reported' : 'Pressure behind the eyes']].map(([k,v])=>`<p><span>${k}</span>${v}</p>`).join('')}</div></div></div></div>`;
}

const COLORS = {taken:'#047857',delayed:'#b45309',skipped:'#b91c1c',unknown:'#64748b'};
const lastWeek = ['taken','taken','delayed','taken','skipped','taken','taken'];
function chartGrid(max, height = 180) {
  return Array.from({length:max+1},(_,i)=>`<path d="M40 ${20+i*height/max}H1280" stroke="#e2e8f0" stroke-dasharray="4 4"/><text x="29" y="${25+i*height/max}" font-size="12" fill="#475569" text-anchor="end">${max-i}</text>`).join('');
}
function barChart(n, hover, outcomes = false) {
  const statuses = n === 7 ? lastWeek : Array.from({length:30},(_,i)=>i === 27 || i === 13 ? 'skipped' : i === 21 ? 'unknown' : i === 25 ? 'delayed' : 'taken');
  const per = 1235 / statuses.length;
  return `<svg width="100%" height="230" viewBox="0 0 1300 230">${chartGrid(1)}${statuses.map((s,i)=>`<rect x="${44+i*per}" y="24" width="${per*.65}" height="176" rx="4" fill="${COLORS[s]}" data-id="bar-${i}"/><text x="${44+i*per+per*.325}" y="222" text-anchor="middle" fill="#475569" font-size="12">${n === 7 ? 'Oct '+(12+i) : i % 5 === 0 ? (i < 12 ? 'Sep '+(19+i) : 'Oct '+(i-11)) : ''}</text>`).join('')}</svg>
    ${hover ? '<div class="tooltip" style="left:790px;top:75px"><b>Oct 16 · 09:00</b><br>Outcome: skipped<br>Reason: forgot</div>' : ''}
    <div class="legend">${Object.entries(COLORS).map(([k,c])=>`<span><i style="background:${c}"></i>${outcomes ? k : k === 'taken' ? 'confirmed taken / late' : k === 'unknown' ? 'ambiguous response' : k}</span>`).join('')}</div>`;
}
function dosePage(n, hover, outcomes = false) {
  return heading('Trends & record', 'Alice Chen · outcomes use her local dose date and time.',ranges(n)+button('Manage patient','manage')) +
    `<div class="card chart-card"><h2>${outcomes ? 'Daily adherence outcomes' : 'Dose timeline · last '+n+' days'}</h2><p class="muted" style="margin-top:6px">${outcomes ? 'Counts of recorded outcomes by patient-local day.' : 'Inspect each dose, its recorded outcome, and any reason the patient supplied.'}</p>${barChart(n,hover,outcomes)}<div class="chart-caption"><span>${n === 7 ? '7 completed doses · 6 taken or late · 1 skipped' : '30-day dose history'}</span><span>Oct 19 dose: not yet confirmed</span></div></div>
    <div class="card table-card chart-rows"><table><thead><tr><th>Scheduled dose</th><th>Medication</th><th>Outcome</th><th>Reason</th></tr></thead><tbody>${[['Oct 16, 09:00','skipped','forgot'],['Oct 17, 09:00','taken','Not reported'],['Oct 18, 09:00','taken','Not reported']].map(([d,o,r])=>`<tr><td>${d}</td><td>Metformin 500 mg</td><td>${pill(o,o === 'taken' ? 'green' : '')}</td><td>${r}</td></tr>`).join('')}</tbody></table></div>`;
}
function severityPage(n, hover, hidden) {
  const values = n === 7 ? [4,5,4,3,5,4,8] : [3,4,5,4,3,5,4,8];
  const points = values.map((v,i)=>[70+i*(1170/(values.length-1)),25+(10-v)*23]);
  return heading('Worst symptom severity by day', 'Alice Chen · highest patient-reported severity for each local day.',ranges(n))+
    `<div class="card chart-card"><div class="legend" style="margin-top:0"><span class="${hidden ? 'off' : ''}" data-id="legend"><i></i>headache</span><span>Click the legend to show or hide a symptom.</span></div><svg width="100%" height="310" viewBox="0 0 1300 290">${[1,2,4,6,8,10].map(v=>`<path d="M40 ${25+(10-v)*23}H1280" stroke="#e2e8f0" stroke-dasharray="4 4"/><text x="28" y="${30+(10-v)*23}" text-anchor="end" font-size="12" fill="#475569">${v}</text>`).join('')}<g opacity="${hidden ? 0 : 1}"><polyline points="${points.map(p=>p.join(',')).join(' ')}" fill="none" stroke="#0d9488" stroke-width="3"/>${points.map(([x,y],i)=>`<circle cx="${x}" cy="${y}" r="5" fill="#0d9488" stroke="white" stroke-width="2" data-id="point-${i}"/>`).join('')}</g>${points.map(([x],i)=>`<text x="${x}" y="266" text-anchor="middle" font-size="12" fill="#475569">Oct ${n === 7 ? 13+i : 12+i}</text>`).join('')}</svg>${hover ? '<div class="tooltip" style="right:64px;top:75px"><b>Oct 19, 2026</b><br>headache: 8 / 10<br>Patient-reported</div>' : ''}<div class="chart-caption"><span>Missing observations remain gaps.</span><b>Today: headache 8 / 10</b></div></div><div class="card" style="margin-top:18px"><h3>Follow the value back to the day thread</h3><p class="muted" style="margin-top:8px">The point for Oct 19 comes from Alice's reply "8" to the severity question. The original reply remains in her record.</p></div>`;
}
function historyPage() {
  return heading('Medications and history', 'Alice Chen · current and superseded entries remain visible.')+`<div class="history-grid"><div class="card"><h2>Medications</h2><div class="history-item"><div class="top"><b>Metformin 500 mg</b>${pill('Active','green')}</div><small>500 mg · tablet · oral</small><small>Jul 1, 2026 → ongoing</small><small>Entered by the clinician</small></div><div class="history-item old"><div class="top"><b>Metformin</b>${pill('Superseded by a correction')}</div><small>Earlier medication-name entry</small><small>Retained alongside the corrected entry</small></div><p class="muted" style="margin-top:20px">Only the owning doctor can add or change this history. The conversational agent reads it.</p></div><div class="card"><h2>Clinical history</h2><div class="history-item"><b>Allergies</b><small>No allergy entry recorded.</small></div><div class="history-item"><b>Conditions</b><p>Type 2 diabetes ${pill('Current')}</p></div><div class="history-item"><b>Notes</b><p>Prefers morning check-ins. ${pill('Current')}</p></div></div></div>`;
}
function revisionsPage(expanded) {
  const rows = [['Recorded event','1','Oct 19 · 09:03','Headache character recorded','evt-character'],['Recorded event','1','Oct 19 · 09:02','Headache onset recorded','evt-onset'],['Recorded event','1','Oct 19 · 09:01','Patient-reported severity 8 / 10','evt-severity'],['Medication','2','Jul 2 · 10:15','Medication name clarified','med-v2'],['Medication','1','Jul 1 · 11:20','Original medication entry','med-v1']];
  return heading('Revision history', "Alice Chen · a correction adds a version and retains the earlier record.")+`<div class="card"><h2>Every version, newest first</h2>${rows.map(([k,v,t,text,id],i)=>`<div class="revision" data-id="revision-${i}"><span class="dot"></span><div><p>${pill(k)} <strong>Version ${v}</strong> ${i === 3 ? pill('Replaces an earlier version') : ''}</p><p>${text}</p><small>${t} · America/Toronto · ${id}</small>${expanded && i === 3 ? '<div class="evidence">Replaces record <b>med-v1</b><br>The original "Metformin" entry is preserved below.</div>' : ''}</div></div>`).join('')}</div>`;
}
function reviewsPage(safety) {
  return heading('Reviews', 'Inspect the patient reply, classification, and available evidence.')+`<div class="review-tabs"><span class="${safety ? '' : 'active'}" data-id="classification-tab">Classifications and label matches</span><span class="${safety ? 'active' : ''}" data-id="safety-tab">Safety events</span></div>`+
    (safety ? `<div class="card empty"><h2>No items awaiting review</h2><p>New safety events appear with auto-reply and follow-up status.</p><p style="margin-top:17px">No safety event is added for Alice's example headache conversation.</p></div>` : `<div class="card"><div style="display:flex;justify-content:space-between"><div><div class="muted">Patient</div><h2 style="margin-top:5px">Alice Chen</h2><p class="muted">Older reply · Oct 10, 2026 · 09:12</p></div>${pill('Ambiguous classification','amber')}</div><div class="history-item old"><div class="kicker">PATIENT REPLY</div><p>I can't remember if I already took it.</p></div><div class="history-grid" style="margin-top:17px"><div class="history-item"><h3>Classification</h3><p>unknown</p><small>Reason: not reported</small></div><div class="history-item"><h3>Source and attribution</h3><p>Metformin · morning dose</p><small>Original reply and dose reference preserved</small></div></div><p class="muted" style="margin-top:18px">Awaiting review · ambiguous outcomes, unattributed replies, and label-match evidence.</p></div>`);
}
function manageSheet(details) {
  return `<div class="sheet-scrim"></div><aside class="sheet"><h2>Manage patient <span data-id="close-sheet">×</span></h2><section><label class="field-label">Reminders per check-in</label><div class="input" data-id="reminders">2</div>${button('Save reminders','save-reminders')}</section><section>${button('Edit details','edit-details')}${details ? '<div class="history-item"><label class="field-label">Display name</label><div class="input">Alice Chen</div><label class="field-label">Phone number</label><div class="input">+15145550101</div><div class="actions">'+button('Cancel','cancel-details')+button('Save details','save-details','primary')+'</div></div>' : ''}</section><div class="bottom">${button('Deactivate patient','deactivate','danger')}</div></aside>`;
}
function enrollPage() {
  return heading('Enroll patient', 'Create a patient and schedule check-ins in their local timezone.')+`<div class="enroll-layout"><div class="card"><h2>Patient details</h2><div class="form-grid"><div><label class="field-label">Display name (optional)</label><div class="input">New participant</div></div><div><label class="field-label">Phone number</label><div class="input">+15145550123</div></div><div class="wide"><label class="field-label">Medication</label><div class="input">Metformin</div></div></div><h2 style="margin-top:12px">Check-in schedule</h2><div class="form-grid"><div><label class="field-label">Timezone (IANA)</label><div class="input" data-id="timezone">America/Toronto</div></div><div><label class="field-label">Days to schedule</label><div class="input">3</div></div><div><label class="field-label">First dose time</label><div class="input" data-id="dose-time">09:00</div></div><div><label class="field-label">Second dose time (optional)</label><div class="input">18:00</div></div></div>${button('Enroll patient','submit-enroll','primary')}</div><div class="card" style="height:max-content"><h2>Local check-in times</h2><p class="muted" style="margin-top:12px">Times are interpreted in the participant's timezone.</p><div class="history-item"><b>09:00 · 18:00</b><small>America/Toronto</small><small>3 scheduled days</small></div><p class="muted" style="margin-top:16px">This tour previews the form without submitting it.</p></div></div>`;
}

const calendarPhase = local => local > .7 && local <= 2.1;
let lastView = '';
window.render = t => {
  t = Math.max(0, Math.min(END - .001, t));
  const step = [...STEPS].reverse().find(s=>t >= s.at), local = t - step.at;
  let markup, phase = '', target = '', section = 'patients';
  if (step.id === 'roster' || step.id === 'find') {
    const query = step.id === 'find' ? 'Alice'.slice(0,Math.max(0,Math.ceil((local-.6)*5))) : '';
    phase = query; markup = roster(query); target = step.id === 'find' ? local < 2 ? 'search' : 'alice' : 'analytics';
  } else if (['record','evidence','calendar','manage','finish'].includes(step.id)) {
    const evidence = step.id === 'evidence' && local > .9;
    const previous = step.id === 'calendar' && local > 2.1;
    const calendarOpen = step.id === 'calendar' && local > .7 && !previous;
    const sheetOpen = step.id === 'manage' && local > .9;
    const details = step.id === 'manage' && local > 2.0;
    phase = [evidence,previous,calendarOpen,sheetOpen,details].join(':');
    markup = record({previous,evidence,calendarOpen}) + (sheetOpen ? manageSheet(details) : '');
    target = step.id === 'evidence' ? 'source' : step.id === 'calendar' ? previous ? 'calendar' : calendarOpen ? 'day-18' : 'calendar' : step.id === 'manage' ? !sheetOpen ? 'manage' : details ? 'save-details' : 'edit-details' : 'manage';
  } else if (step.id === 'doses' || step.id === 'adherence') {
    const n = step.id === 'adherence' || local > 1 ? 7 : 30, hover = step.id === 'doses' && local > 2.2;
    phase = n+':'+hover; markup = dosePage(n,hover,step.id === 'adherence'); target = hover ? 'bar-4' : 'range-7';
  } else if (step.id === 'severity') {
    const n = local > .8 ? 7 : 30, hidden = local > 1.8 && local < 2.5, hover = local > 3.8;
    phase = [n,hidden,hover].join(':'); markup = severityPage(n,hover,hidden); target = local < 1.3 ? 'range-7' : local < 3.2 ? 'legend' : 'point-6';
  } else if (step.id === 'history') {
    markup = historyPage(); target = 'nav-patients';
  } else if (step.id === 'revisions') {
    const expanded = true; phase = String(expanded); markup = revisionsPage(expanded); target = 'revision-3';
  } else if (step.id === 'reviews') {
    const safety = local > 2.7; phase = String(safety); markup = reviewsPage(safety); target = 'safety-tab'; section = 'reviews';
  } else {
    markup = enrollPage(); target = local < 2 ? 'timezone' : 'dose-time'; section = 'enroll';
  }
  const key = step.id+':'+phase;
  if (key !== lastView) { $('#page').innerHTML = markup; lastView = key; }
  ['patients','reviews','enroll'].forEach(s=>$('#nav-'+s).classList.toggle('active',s === section));
  $('#url').textContent = section === 'reviews' ? 'medadhere / reviews' : section === 'enroll' ? 'medadhere / patients / new' : ['roster','find'].includes(step.id) ? 'medadhere / patients' : 'medadhere / patients / Alice Chen';
  $('#crumb').textContent = ['roster','find'].includes(step.id) ? 'Cohort overview' : section === 'reviews' ? 'Reviews' : section === 'enroll' ? 'Enroll patient' : 'Alice Chen';
  $('#step-label').textContent = step.title;
  let scroll = 0;
  const track = $('.thread-track');
  if (track) {
    track.style.transform = 'none';
    const available = Math.max(0,track.offsetHeight-track.parentNode.clientHeight);
    if (step.id === 'record') scroll = available * ease((local-1.0)/1.8);
    else if (step.id === 'evidence') {
      const row = $('[data-pair="1"]');
      scroll = Math.min(available, Math.max(0,row.getBoundingClientRect().top-track.getBoundingClientRect().top-8));
    } else if (step.id === 'finish') scroll = available;
    track.style.transform = `translateY(${-Math.round(scroll)}px)`;
  }
  // Scroll the page to reveal longer records, as the clinician would in the app.
  const page = $('#page'), overflow = Math.max(0,page.scrollHeight-page.clientHeight);
  let pageProgress = 0;
  if (['roster','record','doses','adherence','revisions','severity','history','enroll','finish'].includes(step.id)) pageProgress = ease((local-1.3)/1.7);
  if (step.id === 'evidence' || step.id === 'manage') pageProgress = 1;
  if (step.id === 'calendar' && local > 2.1) pageProgress = ease((local-2.3)/.8);
  page.scrollTop = Math.round(overflow*pageProgress);
  const targetEl = $('[data-id="'+target+'"]') || $('#'+target);
  const rect = targetEl?.getBoundingClientRect();
  const tx = rect ? Math.max(18,Math.min(1550,rect.left+rect.width*.55)) : 1050;
  const ty = rect ? Math.max(90,Math.min(705,rect.top+rect.height*.55)) : 360;
  let moveAt = .15, clickAt = .85;
  if (step.id === 'find' && local >= 2) {moveAt = 2; clickAt = 2.65;}
  if (step.id === 'calendar' && calendarPhase(local)) {moveAt = .85; clickAt = 2.0;}
  if (step.id === 'doses' && local > 1.2) {moveAt = 1.2; clickAt = 2.05;}
  if (step.id === 'severity') {
    if (local > 3.2) {moveAt = 3.2; clickAt = -10;}
    else if (local > 1.3) {moveAt = 1.1; clickAt = local < 2.2 ? 1.65 : 2.35;}
  }
  if (step.id === 'manage' && local > .9) {moveAt = .95; clickAt = 1.8;}
  if (step.id === 'manage' && local > 2) {moveAt = 2; clickAt = -10;}
  if (['history','revisions','finish'].includes(step.id)) clickAt = -10;
  if (step.id === 'enroll' && local > 2) {moveAt = 2; clickAt = 2.7;}
  const moving = ease((local-moveAt)/.6);
  const x = Math.round(tx+(1-moving)*85), y = Math.round(ty+(1-moving)*65);
  const press = Math.max(0,1-Math.abs(local-clickAt)/.15);
  $('#cursor').style.left = x+'px'; $('#cursor').style.top = y+'px'; $('#cursor').style.transform = `scale(${(1-press*.15).toFixed(3)})`;
  const pulse = clamp((local-clickAt)/.5);
  $('#click-ring').style.left = (tx-16)+'px'; $('#click-ring').style.top = (ty-16)+'px';
  $('#click-ring').style.opacity = local < clickAt ? 0 : 1-pulse;
  $('#click-ring').style.transform = `scale(${(1+pulse*1.5).toFixed(3)})`;
  window.currentStep = step;
  return {key:[key,Math.round(scroll),page.scrollTop,x,y,press.toFixed(3),pulse.toFixed(3)].join(':'),title:step.title,id:step.id};
};
window.END = END;
window.TOUR_STEPS = STEPS;
window.render(0);
if (location.search.includes('play')) {
  const start = performance.now();
  const tick = () => {window.render(((performance.now()-start)/1000)%END); requestAnimationFrame(tick);};
  tick();
}
