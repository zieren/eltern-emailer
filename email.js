// ---------- Shared state ----------

// global.CONFIG (see main.js)

/**
 * Build a message ID using the domain of the configured admin address and the specified ID within
 * Eltern-Emailer.
 */
function buildMessageId(localId) {
  return `${localId}.eltern-emailer@${recipientsAdmin().replace(/.*@/, '')}`;
}

function createTestEmail(numEmails) {
  const email = buildEmail(
      'TEST',
      'Test message',
      recipientsAdmin(),
      {
        text: `The test run was successful. ${numEmails} email(s) would have been sent.`
      });
  return [{email: email, ok: () => {}}];
}

function recipientsAdmin() {
  return CONFIG.options.adminAddress;
}

function recipientsEpThreads() {
  return CONFIG.elternportal.recipients['*'].concat(
      CONFIG.elternportal.recipients.lehrerkommunikation);
}

function recipientsEpAnnouncements() {
  return CONFIG.elternportal.recipients['*'].concat(CONFIG.elternportal.recipients.elternbriefe);
}

function recipientsEpNotices() {
  return CONFIG.elternportal.recipients['*'].concat(CONFIG.elternportal.recipients.schwarzesbrett);
}

function recipientsEpSubstitutions() {
  return CONFIG.elternportal.recipients['*'].concat(CONFIG.elternportal.recipients.vertretungsplan);
}

function recipientsEpEvents() {
  return CONFIG.elternportal.recipients['*'].concat(CONFIG.elternportal.recipients.termine);
}

function recipientsSmAnnouncements() {
  return CONFIG.schulmanager.recipients['*'].concat(CONFIG.schulmanager.recipients.elternbriefe);
}

/** Centralizes setting of common email options. */
function buildEmail(fromName, recipients, subject, options) {
  return {...{
    from: `"EE ${fromName.replace(/["\n]/g, '')}" <${recipientsAdmin()}>`,
    to: recipients,
    subject: subject
  }, ...options};
}

module.exports = { 
  buildMessageId, 
  createTestEmail, 
  buildEmail,
  recipientsAdmin,
  recipientsEpThreads,
  recipientsEpAnnouncements,
  recipientsEpNotices,
  recipientsEpSubstitutions,
  recipientsEpEvents,
  recipientsSmAnnouncements
}
