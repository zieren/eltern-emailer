// ---------- Shared state ----------

// global.CONFIG (see main.js)

/**
 * Build a message ID using the same domain as the configured From: address and an ID unique within
 * Eltern-Emailer.
 */
function buildMessageId(localId) {
  return localId + '.eltern-emailer@' + CONFIG.options.emailFrom.replace(/.*@/, '');
}

function createTestEmails(numEmails) {
  const emailToRecipient = buildEmail('TEST', 'TEST to Recipient', {
    text: 'The test run was successful. ' + numEmails + ' email(s) would have been sent.'
  });
  const emailToSender = buildEmail('TEST', 'TEST to Sender', {
    text: 'The test run was successful. ' + numEmails + ' email(s) would have been sent.'
  });
  [emailToSender.from, emailToSender.to] = [emailToSender.to, emailToSender.from];
  return [
    {email: emailToRecipient, ok: () => {}},
    {email: emailToSender, ok: () => {}}
  ];
}

/** Centralizes setting of common email options. */
function buildEmail(fromName, subject, options) {
  return {...{
    from: '"EE ' + fromName.replace(/["\n]/g, '') + '" <' + CONFIG.options.emailFrom + '>',
    to: CONFIG.options.emailTo,
    subject: subject
  }, ...options};
}

module.exports = { buildMessageId, createTestEmails, buildEmail }
