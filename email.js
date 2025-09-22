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
  buildEmail,
  buildMessageId, 
  createTestEmail, 
  buildEmailAdmin
}
