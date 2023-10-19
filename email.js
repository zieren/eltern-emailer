// ---------- Shared state ----------

// global.CONFIG (see main.js)

/**
 * Build a message ID using the domain of the configured admin address and the specified ID within
 * Eltern-Emailer.
 */
function buildMessageId(localId) {
  return `${localId}.eltern-emailer@${CONFIG.options.adminAddress.replace(/.*@/, '')}`;
}

function createTestEmail(numEmails) {
  const email = buildEmail(
      'Eltern-Emailer',
      CONFIG.options.adminAddress,
      'Test message',
      {
        text: `The test run was successful. ${numEmails} email(s) would have been sent.`
      });
  return [{email: email, ok: () => {}}];
}

function buildEmailAdmin(subject, options) {
  return buildEmail(`Eltern-Emailer`, CONFIG.options.adminAddress, subject, options);
}

function buildEmailEpAnnouncements(subject, options) {
  return buildEmail(
      `${CONFIG.elternportal.tag} Elternbrief`,
      CONFIG.elternportal.recipients['*'].concat(CONFIG.elternportal.recipients.elternbriefe),
      subject,
      options);
}

function buildEmailEpEvents(options) {
  return buildEmail(
      `${CONFIG.elternportal.tag} Termine`,
      CONFIG.elternportal.recipients['*'].concat(CONFIG.elternportal.recipients.termine),
      'Bevorstehende Termine',
      options);
}

function buildEmailEpNotices(subject, options) {
  return buildEmail(
      `${CONFIG.elternportal.tag} Schwarzes Brett`,
      CONFIG.elternportal.recipients['*'].concat(CONFIG.elternportal.recipients.schwarzesbrett),
      subject,
      options);
}

function buildEmailEpSubstitutions(options) {
  return buildEmail(
      `${CONFIG.elternportal.tag} Vertretungsplan`,
      CONFIG.elternportal.recipients['*'].concat(CONFIG.elternportal.recipients.vertretungsplan),
      'Vertretungsplan',
      options);
}

function buildEmailEpThreads(teacherName, subject, options) {
  return buildEmail(
      `${CONFIG.elternportal.tag} ${teacherName.replace(/["\n]/g, '')}`,
      CONFIG.elternportal.recipients['*'].concat(
          CONFIG.elternportal.recipients.lehrerkommunikation),
      subject,
      options);
}

function buildEmailSmAnnouncements(subject, options) {
  return buildEmail(
      `${CONFIG.schulmanager.tag} Elternbrief`,
      CONFIG.schulmanager.recipients['*'].concat(CONFIG.schulmanager.recipients.elternbriefe),
      subject,
      options);
}

/** Centralizes setting of common email options. */
function buildEmail(fromName, to, subject, options) {
  return {...{
    from: `"${fromName}" <${CONFIG.options.adminAddress}>`,
    to: to,
    subject: subject
  }, ...options};
}

module.exports = { 
  buildMessageId, 
  createTestEmail, 
  buildEmailAdmin,
  buildEmailEpAnnouncements,
  buildEmailEpEvents,
  buildEmailEpNotices,
  buildEmailEpSubstitutions,
  buildEmailEpThreads,
  buildEmailSmAnnouncements
}
