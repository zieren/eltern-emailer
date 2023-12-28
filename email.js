// ---------- Shared state ----------

// global.CONFIG (see main.js)

/**
 * Build a message ID using the domain of the configured admin address and the specified ID within
 * Eltern-Emailer.
 */
function buildMessageId(localId) {
  return `${localId}.eltern-emailer@${CONFIG.options.adminAddress.replace(/.*@/, '')}`;
}

function createTestEmail(numEmails, success) {
  const email = buildEmail(
      'Eltern-Emailer',
      CONFIG.options.adminAddress,
      'Test message',
      {
        text: `The test run ${success ? 'succeeded' : 'failed (see log for details)'}.\n`
            + `${numEmails} email(s) would have been sent.`
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
      `${CONFIG.elternportal.tag} ${teacherName}`,
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

// Centralizes setting of common email options.
function buildEmail(fromName, recipients, subject, options) {
  const email = {...{
    from: `"${fromName}" <${CONFIG.options.adminAddress}>`,
    subject: subject,
    headers: { 'User-Agent': USER_AGENT }
  }, ...options};
  if (recipients.length > 1 && CONFIG.options.useBcc) {
    // The To: field is not required for the message to be valid, see
    // https://www.rfc-editor.org/rfc/rfc2822#section-3.6.3 and http://faqs.org/qa/rfcc-873.html.
    email.bcc = recipients;
  } else {
    email.to = recipients;
  }
  return email;
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
