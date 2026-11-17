const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export function renderTrackerPage(state) {
  const s=state,k=s.kind,doc=s.selected,receiving=k==='receiving';
  return `<link rel="stylesheet" href="/public/tracker.css"><section class="tracker-page">
    <h1>Job Material Tracker</h1><div class="tracker-tabs" aria-label="Tracker pages">
    ${s.canReceive?`<a class="btn ${receiving?'btn-primary':'btn-secondary'}" href="/tracker/receiving">Receiving</a>`:''}
    ${s.canIssue?`<a class="btn ${!receiving?'btn-primary':'btn-secondary'}" href="/tracker/issuing">Issuing</a><a class="btn btn-secondary" href="/tracker/contacts/list">Day / Night Contacts</a>`:''}</div>
    <div class="card tracker-toolbar"><strong>Job ${esc(s.job.job_number)} · ${receiving?'Receiving':'Issuing'}</strong>
      <label>View <select id="tracker-document"><option value="">All ${receiving?'receipts':'tickets'}</option>${s.documents.map(d=>`<option value="${d.id}" ${Number(doc?.id)===Number(d.id)?'selected':''}>${esc(d.number)}${d.cancelled?' — Cancelled':''}</option>`).join('')}</select></label>
      ${s.create?`<button type="button" id="tracker-new">New ${receiving?'GRR':'Pick Ticket'}</button>`:''}
      ${s.contactsEdit&&!s.setup&&s.job.job_number===s.referenceJob?'<button type="button" id="tracker-import">Import Reference Contacts &amp; Numbering</button>':''}
      <span id="tracker-status" role="status" aria-live="polite">Saved</span>
    </div>
    ${!s.setup&&s.job.job_number===s.referenceJob?'<p class="muted">Initial setup imports day/night contacts and continues GRR / GRPT numbering. It does not import stock or transaction history.</p>':''}
    ${doc?`<div class="card"><h2>${esc(doc.number)}${doc.cancelled?' — Cancelled':''}</h2><div id="tracker-header" class="grid"></div><div class="actions">
      ${s.edit&&!doc.cancelled?'<button type="button" id="tracker-add-row">Add Row</button><button type="button" class="btn btn-secondary" id="tracker-cancel">Cancel Document</button>':''}
      ${!receiving?`<a class="btn btn-secondary" target="_blank" rel="noopener" href="/tracker/issuing/documents/${doc.id}/pick-ticket.pdf">Print Pick Ticket</a>${s.issue&&!doc.cancelled?'<button type="button" id="tracker-allocate">Post Issue / Review Allocations</button>':''}`:''}
      </div></div>`:''}
    <div class="tracker-toolbar"><label>Filter rows <input id="tracker-filter" type="search" placeholder="Ident, description, location, number…"></label><span class="muted">${doc&&!doc.cancelled&&s.edit?'Cells save automatically. Tab moves between cells; paste rows from Excel.':'Select a document to edit its rows.'}</span></div>
    <div class="tracker-scroll" tabindex="0" aria-label="${receiving?'Receiving':'Issuing'} spreadsheet"><table id="tracker-grid"><thead></thead><tbody></tbody></table></div>
    <dialog id="tracker-issue-dialog"><h2>Post Issue</h2><p>Oldest available stock is suggested first. Change the quantities and locations below before posting.</p><label>Date issued <input type="date" id="tracker-issued-date"></label><div id="tracker-allocations"></div><div class="actions"><button type="button" id="tracker-post-issue">Post Issue</button><button type="button" id="tracker-close-dialog" class="btn btn-secondary">Close</button></div><p id="tracker-issue-error" role="alert"></p><div id="tracker-postings"></div></dialog>
    <script type="application/json" id="tracker-state">${JSON.stringify(s).replaceAll('<','\\u003c')}</script><script src="/public/tracker.js" defer></script></section>`;
}
export function renderTrackerContacts(contacts,token,edit) {
  return `<link rel="stylesheet" href="/public/tracker.css"><h1>Day / Night Contacts</h1><p>Contacts belong to the selected job. Day contacts retain their two linked night contacts for pick tickets.</p><a class="btn btn-secondary" href="/tracker/issuing">Back to Issuing</a><div class="card"><table id="tracker-contacts"><thead><tr><th>Day Contact</th><th>Night Contact 1</th><th>Night Contact 2</th><th>Active</th><th></th></tr></thead><tbody></tbody></table>${edit?'<button type="button" id="tracker-contact-add">Add Contact</button>':''}<p id="tracker-status" role="status"></p></div><script type="application/json" id="tracker-contact-state">${JSON.stringify({contacts,token,edit}).replaceAll('<','\\u003c')}</script><script src="/public/tracker.js" defer></script>`;
}
