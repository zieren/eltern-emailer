// TODO: What happens if any of our page interactions fails, e.g. because the element ID changed?

const TITLE = 'Eltern-Emailer 0.0.5 (c) 2022 Jörg Zieren, GNU GPL v3.'
    + ' See https://github.com/zieren/eltern-emailer for component license info';

const contentDisposition = require('content-disposition');
const https = require('https');
const fs = require('fs');
const { ImapFlow } = require('imapflow');
const md5 = require('md5');
const nodemailer = require('nodemailer');
const puppeteer = require('puppeteer');
const { simpleParser } = require('mailparser');
const winston = require('winston');

// ---------- Constants ----------

const CLI_OPTIONS = {
  args: [],
  flags: [
    {
      name: 'config',
      type: 'string',
      default: 'config.json'
    },
    {
      name: 'ep_password',
      type: 'string'
    },
    {
      name: 'smtp_password',
      type: 'string'
    },
    {
      name: 'imap_password',
      type: 'string'
    },
    {
      name: 'mute',
      type: 'boolean'
    },
    {
      name: 'once',
      type: 'boolean'
    },
    {
      name: 'test',
      type: 'boolean'
    }
  ]
};

const EMPTY_STATE = {threads: {}, announcements: {}, inquiries: {}, hashes: {subs: ''}};
const INQUIRY_AUTHOR = ['Eltern', 'Klassenleitung', 'UNKNOWN'];

/**
 * List of already processed (i.e. emailed) items. Contains the following keys:
 * - 'announcements': Announcements in "Aktuelles".
 * - 'threads': Threads in "Kommunikation Eltern/Fachlehrer".
 * - 'inquiries': Inquiries in "Kommunikation Eltern/Klassenleitung".
 * - 'hashes': Other content, e.g. "Vertretungsplan"
 */
const STATE_FILE = 'state.json';

// ---------- Shared state ----------

/** Initialized in main() after parsing CLI flags. */
let CONFIG = {}, LOG = null;

let imapClient = null;
/** Synchronization between IMAP event listener and main loop. */
let awake = () => {}; // Event handler may fire before the main loop builds the wait Promise.
/** 
 * Outbound messages received asynchronously. Each has a "prep" handler that must complete 
 * successfully before actually sending. This handler will mark the original email that triggered
 * this message as answered in IMAP to avoid duplicate messages to teachers in case of errors (e.g.
 * when the message to the teacher is sent, but the email in the IMAP inbox cannot be marked
 * processed). Using an IMAP flag instead of the status file has the downside that it cannot express
 * partial success, but that is a rare case anyway. On the upside the IMAP flag will persist across
 * reinstalls or deletion of the status file.
 */
let outbox = [];
/** Wrap logger for IMAP, stripping all fields except msg. */
const imapLogger = {
  debug: (o) => {}, // This is too noisy.
  info: (o) => LOG.info('IMAP: ' + o.msg),
  warn: (o) => LOG.warn('IMAP: ' + o.msg),
  error: (o) => LOG.error('IMAP: ' + o.msg)
};

// ---------- Initialization functions ----------

function readState() {
  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) : {};
  for (const [key, value] of Object.entries(EMPTY_STATE)) {
    state[key] = state[key] || value; // Netbeans syntax check chokes on ||= :-|
  }
  return state;
}

function processFlags(flags) {
  // Flags override values in config file.
  CONFIG.elternportal.pass = flags.ep_password || CONFIG.elternportal.pass;
  CONFIG.smtp.auth.pass = flags.smtp_password || CONFIG.smtp.auth.pass;
  CONFIG.imap.auth.pass = flags.imap_password || CONFIG.imap.auth.pass;
  CONFIG.options.mute = flags.mute !== undefined ? flags.mute : CONFIG.options.mute;
  CONFIG.options.once = flags.once !== undefined ? flags.once : CONFIG.options.once;
  CONFIG.options.test = flags.test !== undefined ? flags.test : CONFIG.options.test;
}

function createIncomingEmailRegExp() {
  if (CONFIG.options.incomingEmailAddressForForwarding) {
    CONFIG.options.incomingEmailRegEx =
        '(?:^|<)' 
        + CONFIG.options.incomingEmailAddressForForwarding
            .replace(/\./g, '\\.')
            .replace('@', '(?:\\+(\\d+))?@') 
        + '(?:$|>)';
  }
}

function createLogger() {
  return winston.createLogger({
    level: CONFIG.options.logLevel,
    format: winston.format.combine(
      winston.format.splat(),
      winston.format.timestamp(),
      winston.format.printf(({level, message, timestamp}) => {
        return `${timestamp} ${level}: ${message}`;
      })
    ),
    transports: [
      new winston.transports.File({
        filename: 'eltern-emailer.log',
        maxsize: 10 << 20,
        maxFiles: 2
      }),
      new winston.transports.Console()
    ]
  });
}

// ---------- Utilities ----------

function sleepSeconds(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

// ---------- Login ----------

/** This function does the thing. The login thing. You know? */
async function login(page) {
  await page.goto(CONFIG.elternportal.url);
  await page.type('#inputEmail', CONFIG.elternportal.user);
  await page.type('#inputPassword', CONFIG.elternportal.pass);
  await Promise.all([
    page.waitForNavigation(),
    page.click('#inputPassword ~ button')
  ]);
  const success = (await page.$$eval('a[href*="einstellungen"]', (x) => x)).length > 0;
  if (!success) {
    throw 'Login failed';
  }
  LOG.info('Login OK');
}

async function getPhpSessionIdAsCookie(page) {
  const cookies = await page.cookies();
  const id = cookies.filter(c => c.name === 'PHPSESSID');
  if (id.length !== 1) {
    throw 'Failed to extract PHPSESSID';
  }
  return id[0].name + '=' + id[0].value;
}

// ---------- Announcements ----------

/** Reads all announcements, but not possible attachments. */
async function readAnnouncements(page) {
  await page.goto(CONFIG.elternportal.url + '/aktuelles/elternbriefe');
  const announcements = await page.$$eval(
    'span.link_nachrichten, a.link_nachrichten',
    (nodes) => nodes.map(
      (n) => {
        // Transform the date to a format that Date can parse.
        const d = n.firstChild.nextSibling.textContent
            .match(/(\d\d)\.(\d\d)\.(\d\d\d\d) +(\d\d:\d\d:\d\d)/);
        return {
          // Use the ID also used for reading confirmation, because it should be stable.
          id: n.attributes.onclick.textContent.match(/\(([0-9]+)\)/)[1],
          body: n.parentElement.outerText.substring(n.outerText.length).trim(),
          subject: n.firstChild.textContent,
          url: n.tagName === 'A' ? n.href : null,
          dateString: d[3] + '-' + d[2] + '-' + d[1] + ' ' + d[4]
        };
      }));
  LOG.info('Found %d announcements', announcements.length);
  return announcements;
}

/**
 * Reads attachments for all announcements not included in processedAnnouncements. Attachments are
 * stored in memory.
 */
async function readAttachments(page, announcements, processedAnnouncements) {
  const options = {headers: {'Cookie': await getPhpSessionIdAsCookie(page)}};
  for (const a of announcements) {
    if (a.id in processedAnnouncements || !a.url) {
      continue;
    }
    // Collect buffers and use Buffer.concat() to avoid messing with chunk size arithmetics.
    let buffers = [];
    // It seems attachment downloads don't need to be throttled.
    await new Promise((resolve, reject) => {
      https.get(a.url, options, (response) => {
        a.filename =
            contentDisposition.parse(response.headers['content-disposition']).parameters.filename;
        response.on('data', (buffer) => {
          buffers.push(buffer);
        }).on('end', () => {
          a.content = Buffer.concat(buffers);
          LOG.info('Read attachment (%d kb) for: %s', a.content.length >> 10, a.subject);
          resolve();
        });
      }).on('error', (error) => {
        reject(error);
      });
    });
  }
}

function buildEmailsForAnnouncements(page, announcements, processedAnnouncements, emails) {
  announcements
      .filter(a => !(a.id in processedAnnouncements))
      // Send oldest announcements first, i.e. maintain chronological order. This is not reliable
      // because emails race, but GMail ignores the carefully forged message creation date (it shows
      // the reception date instead), so it's the best we can do.
      .reverse()
      .map(a => {
        const email = buildEmail('Aktuelles', a.subject, {
          text: a.body,
          date: new Date(a.dateString)});
        if (a.content) {
          email.attachments = [
            {
              filename: a.filename,
              content: a.content
            }
          ];
        }
        return {
          email: email,
          ok: async () => {
            // Navigate to /elternbriefe to load the confirmation JS (function eb_bestaetigung()).
            if (!page.url().endsWith('/aktuelles/elternbriefe')) {
              await page.goto(CONFIG.elternportal.url + '/aktuelles/elternbriefe');
            }
            await page.evaluate((id) => { eb_bestaetigung(id); }, a.id);
            processedAnnouncements[a.id] = 1;
          }
        };
      }).forEach(e => emails.push(e));
}

// ---------- Threads ----------

/** Returns a list of teachers with at least one thread. */
async function readActiveTeachers(page) {
  await page.goto(CONFIG.elternportal.url + '/meldungen/kommunikation_fachlehrer');
  const teachers = await page.$$eval(
    // New messages cause a "Neu" indicator with the same href as the teacher. The :first-child
    // selector avoids duplicates.
    'td:nth-child(3) a[href*="meldungen/kommunikation_fachlehrer/"]:first-child',
    (anchors) => anchors.map(
      (a) => {
        return {
          id: a.href.match(/.*\/([0-9]+)\//)[1],
          url: a.href,
          name: a.parentElement.parentElement.firstChild.textContent
        };
      }));
  LOG.info('Found %d teachers with threads', teachers.length);
  return teachers;
}

/**
 * Reads metadata for all threads, based on active teachers returned by readActiveTeachers().
 * Threads are stored with key 'threads' for each teacher.
 */
async function readThreadsMeta(page, teachers) {
  for (const teacher of teachers) {
    LOG.debug('Reading threads with %s', teacher.name);
    await page.goto(teacher.url);
    teacher.threads = await page.$$eval(
        'a[href*="meldungen/kommunikation_fachlehrer/"',
        (anchors) => anchors.map((a) => {
          return {
            id: a.href.match(/.*\/([0-9]+)$/)[1],
            url: a.href,
            subject: a.textContent
          };
        }));
  }
}

/**
 * Populates threads with contents, i.e. individual messages. This is the only way to detect new
 * messages.
 */
async function readThreadsContents(page, teachers) {
  for (const teacher of teachers) {
    // TODO: Reverse this so we send in chronological order. We can simply sort numerically by
    // thread ID.
    for (const thread of teacher.threads) {
      await page.goto(thread.url + '?load_all=1'); // Prevent pagination (I hope).
      thread.messages = await page.$eval('div#last_messages',
          (div) => Array.from(div.children).map(row => {
            return {
              author: row.firstChild.firstChild.textContent,
              body: row.children[1].firstChild.textContent
            };
          }));
      LOG.debug(
          'Read %d messages with %s in "%s"', thread.messages.length, teacher.name, thread.subject);
    }
  }
}

function buildEmailsForThreads(teachers, processedThreads, emails) {
  for (const teacher of teachers) {
    for (const thread of teacher.threads) {
      if (!(thread.id in processedThreads)) {
        processedThreads[thread.id] = {};
      }
      // Messages are in forward chronological order, which is the order in which we want to send.
      for (let i = 0; i < thread.messages.length; ++i) {
        if (!(i in processedThreads[thread.id])) {
          // The thread ID seems to be globally unique. Including the teacher ID simplifies posting
          // replies, because the mail client will put this ID in the In-Reply-To header.
          const messageIdBase = 'thread-' + teacher.id + '-' + thread.id + '-';
          const email = buildEmail(thread.messages[i].author, thread.subject, {
            messageId: buildMessageId(messageIdBase + i),
            text: thread.messages[i].body
          });
          if (i > 0) {
            email.references = [buildMessageId(messageIdBase + (i - 1))];
          }
          if (CONFIG.options.incomingEmailAddressForForwarding) {
            email.replyTo = CONFIG.options.incomingEmailAddressForForwarding
                .replace('@', '+' + teacher.id + '@');
          }
          emails.push({
            // We don't forge the date here because time of day is not available.
            email: email,
            ok: () => { processedThreads[thread.id][i] = 1; }
          });
        }
      }
    }
  }
  return emails;
}
// ---------- Inquiries ----------

/** Reads messages to/from "Klassenleitung". */
async function readInquiries(page) {
  await page.goto(CONFIG.elternportal.url + '/meldungen/kommunikation');
  const inquiries = await page.$$eval(
    'h3.panel-title', (headings) => headings.map((h) => {
      return {
        subject: h.textContent.trim().replace(/\(Beantwortet\) (?=\d\d\.\d\d\.\d\d\d\d)/, '')
      };
    }));
  for (let i = 0; i < inquiries.length; ++i) {
    inquiries[i].messages = await page.$eval('div#bear_' + i,
        (div) => Array.from(div.firstElementChild.childNodes)
            .filter(c => c.nodeName === '#text')
            .map(c => c.textContent));
  }
  LOG.info('Found %d inquiries', inquiries.length);
  // Order is reverse chronological, make it forward.
  return inquiries.reverse();
}

function buildEmailsForInquiries(inquiries, processedInquiries, emails) {
  for (const [i, inquiry] of Object.entries(inquiries)) {
    if (!(i in processedInquiries)) {
      // This indicates the next index to process.
      processedInquiries[i] = 0;
    }
    for (let j = processedInquiries[i]; j < inquiry.messages.length; ++j) {
      // AFAICT each thread has at most two messages.
      const email = buildEmail(INQUIRY_AUTHOR[Math.min(j, 2)], inquiry.subject, {
        // TODO: Consider enriching this, see TODO for other messageId (#4).
        messageId: buildMessageId('inquiry-' + i + '-' + j),
        // TODO: ^^ What if these are cleared after the school year, and indexes start at 0 again?
        // Maybe include a hash of the subject, or the date, to avoid collisions.
        text: inquiry.messages[j]
      });
      if (j > 0) {
        email.references = [buildMessageId('inquiry-' + i + '-' + (j - 1))];
      }
      emails.push({
        // We don't forge the date here because time of day is not available.
        email: email,
        ok: () => { processedInquiries[i] = j + 1; }
        // TODO: This relies on execution order. Fix it to match handling of threads.
      });
    }
  }
}

// ---------- Substitutions ----------

async function readSubstitutions(page, previousHashes, emails) {
  await page.goto(CONFIG.elternportal.url + '/service/vertretungsplan');
  const originalHTML = await page.$eval('div#asam_content', (div) => div.innerHTML);
  const hash = md5(originalHTML);
  if (hash === previousHashes.subs) {
    return;
  }

  const modifiedHTML = '<!DOCTYPE html><html><head><title>Vertretungsplan</title>'
      + '<style>table, td { border: 1px solid; } img { display: none; }</style></head>'
      + '<body>' + originalHTML + '</body></html>';
  emails.push({
    email: buildEmail('Vertretungsplan', 'Vertretungsplan', {html: modifiedHTML}),
    ok: () => { previousHashes.subs = hash; }
  });
  LOG.info('Found substitution plan update');
}

// ---------- General email functions ----------

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

/**
 * Centralizes setting of common email options. This is to prevent bugs where the recipient/sender
 * addresses are incorrect.
 */
function buildEmail(fromName, subject, options) {
  return {...options, ...{
    from: '"' + fromName.replace(/["\n]/g, '') + ' (EE)" <' + CONFIG.options.emailFrom + '>',
    to: CONFIG.options.emailTo,
    subject: subject
  }};
}

// ---------- Email sending ----------

async function sendEmails(emails) {
  LOG.info('Sending %d emails', emails.length);
  if (!emails.length) {
    return;
  }
  const transport = nodemailer.createTransport(CONFIG.smtp);
  let first = true;
  for (const e of emails) {
    if (CONFIG.options.mute) {
      LOG.info('Not sending email "%s"', e.email.subject);
      await e.ok();
      continue;
    }
    // Throttle outgoing emails.
    if (!first) {
      await sleepSeconds(CONFIG.options.smtpWaitSeconds);
    }
    first = false;
    LOG.info('Sending email "%s"', e.email.subject);
    // Wait for the callback to run.
    const ok = await new Promise((resolve) => {
      transport.sendMail(e.email, (error, info) => {
        if (error) {
          LOG.error('Failed to send email: %s', error);
          resolve(false);
        } else {
          LOG.debug('Email sent (%s)', info.response);
          resolve(true);
        }
      });
    });
    if (ok) {
      await e.ok();
    }
  }
}

// ---------- Incoming email ----------

/** This uses the "answered" flag, which is part of the IMAP standard, to mark messages done. */
async function processNewEmail() {
  // Collect messages not intended for forwarding to teachers. These are marked processed to hide
  // them in the next query. They only trigger a check. Key is IMAP sequence number, value is 1.
  const ignoredMessages = {};
  let numNewMessages = 0;
  
  for await (let message of imapClient.fetch({answered: false}, { source: true })) {
    ++numNewMessages;
    // This is removed if we found something to process, i.e. registered a success handler that
    // will mark the message processed.
    ignoredMessages[message.seq] = 1; 
    // If no incoming email address is set up, there is nothing to do except mark new messages.
    if (!CONFIG.options.incomingEmailRegEx) {
      continue;
    }

    const parsedMessage = await simpleParser(message.source);
    
    const recipients = [].concat(
        parsedMessage.to ? parsedMessage.to.value : [],
        // The portal doesn't support the concept of multiple recipients, but we do. We treat To:
        // and Cc: the same.
        parsedMessage.cc ? parsedMessage.cc.value : [])
        // The user may have set up forwarding from some easy-to-guess address (e.g. the one
        // initially registered with the portal), exposing the address to spam or pranks. To be safe
        // we check for the secret, hard-to-guess address.
        .filter(value => value.address && value.address.match(CONFIG.options.incomingEmailRegEx));

    if (!recipients.length) {
      continue; // The message isn't intended for us.
    }

    // The 99% case. This allows marking the message not-done on failure because we can just retry
    // from scratch. (In the >1 case it is also possible that all recipients fail, but this seems
    // too rare to special case.)
    const singleRecipient = recipients.length === 1;

    // For replies we get the teacher ID and thread ID from the In-Reply-To header, and we don't
    // need a subject. Other teachers may be among the recipients though, for these a new thread is
    // created.
    [_, replyTeacherId, replyThreadId] =
        parsedMessage.inReplyTo && parsedMessage.inReplyTo.startsWith('<thread-')
        ? parsedMessage.inReplyTo.split('-')
        : [0, -1, -1];

    for (const recipient of recipients) {
      const teacherId = recipient.address.match(CONFIG.options.incomingEmailRegEx)[1];
      if (!teacherId) { // This still allows testing with "0" because it's a string.
        LOG.warn('Failed to parse recipient "' + recipient.address + '"');
        continue; // Should never happen because we filtered recipients to match the RegEx above.
      }

      // We now know that the message has payload. The prep handler below will mark it done.
      delete ignoredMessages[message.seq];

      const isReply = teacherId == replyTeacherId;
      LOG.info(
        'Received ' + (isReply ? 'reply to ' : 'email for ') + recipient.name + ' (teacher ' 
        + teacherId + '): "' + parsedMessage.subject + '" (' + parsedMessage.text.length 
        + ' characters)');
      outbox.push({
        teacherId: teacherId,
        replyThreadId: isReply ? replyThreadId : undefined,
        subject: isReply ? undefined : parsedMessage.subject,
        text: parsedMessage.text,
        markDone: async () => markEmail(seq, true),
        markNotDone: singleRecipient ? async () => markEmail(seq, false) : () => {}
      });
    }
  }
  LOG.debug('New emails: ' + numNewMessages);

  if (Object.keys(ignoredMessages).length) {
    const seqs = Object.keys(ignoredMessages).join();
    await imapClient.messageFlagsAdd({seq: seqs}, ['\\Answered']);
    LOG.debug('Marked other emails: ' + seqs);
  }

  // For simplicity we awake unconditionally. We don't distinguish between new content notifications
  // and ignored messages, e.g. sick leave confirmation. An occasional false positive is OK.
  if (numNewMessages) {
    awake();
  }
}

async function markEmail(seq, done) {
  if (done) {
    await imapClient.messageFlagsAdd({ seq: seq }, ['\\Answered']);
    LOG.debug('Marked processed email: ' + seq);
  } else {
    await imapClient.messageFlagsRemove({ seq: seq }, ['\\Answered']);
    LOG.debug('Marked unprocessed email: ' + seq);
  }
}

// ---------- Outgoing messages ----------

async function sendMessagesToTeachers(page) {
  LOG.info('Sending ' + outbox.length + ' messages to teachers');
  for (const msg of outbox) {
    // Curiously this navigation will always succeed, even for nonexistent IDs. What's more, we can
    // actually send messages that we can then retrieve by navigating to the URL directly. This
    // greatly simplifies testing :-)

    if (msg.replyThreadId) {
      await page.goto(
          CONFIG.elternportal.url + '/meldungen/kommunikation_fachlehrer/'
          + msg.teacherId + '/_/' + msg.replyThreadId);
      // We probably don't need load_all=1 here, assuming the reply box is always shown.
    } else {
      await page.goto(
          CONFIG.elternportal.url + '/meldungen/kommunikation_fachlehrer/' + msg.teacherId);
      await page.type('#new_betreff', msg.subject);
    }
    // TODO: Split up if >512 chars. (Is that configurable?)
    await page.type('#nachricht_kom_fach', msg.text);
    // We mark the original email early to avoid duplicate messages in case of errors.
    await msg.markDone();
    const [response] = await Promise.all([
      page.waitForNavigation(),
      page.click('button#send')
    ]);

    if (response.ok()) {
      LOG.info('Sent message to teacher ' + msg.teacherId);
    } else {
      LOG.error('Failed to send message to teacher ' + msg.teacherId + ': ' + response.statusText);
      await msg.markNotDone();
      // TODO: Report this back, i.e. email the error to the user.
    }
  }
  outbox = [];
}

// ---------- Main ----------

async function main() {
  const parser = await import('args-and-flags').then(aaf => {
    return new aaf.default(CLI_OPTIONS);
  });
  const {_, flags} = parser.parse(process.argv.slice(2));

  CONFIG = JSON.parse(fs.readFileSync(flags.config, 'utf-8'));
  CONFIG.options.checkIntervalMinutes = Math.max(CONFIG.options.checkIntervalMinutes, 10);
  processFlags(flags);
  createIncomingEmailRegExp();
  LOG = createLogger();
  LOG.info(TITLE);

  // Ensure config file has been edited.
  if (CONFIG.elternportal.url.startsWith('https://SCHOOL.')) {
    throw 'Please edit the config file to specify your login credentials, SMTP server etc.';
  }

  // Start IMAP listener, if enabled.
  if (CONFIG.options.incomingEmailEnabled) {
    CONFIG.imap.logger = imapLogger;
    imapClient = new ImapFlow(CONFIG.imap);
    imapClient.on('exists', async (data) => {
      LOG.debug('Received new message(s): ' + JSON.stringify(data));
      await processNewEmail();
    });
    await imapClient.connect();
    await imapClient.mailboxOpen('INBOX');
    LOG.info('Listening on IMAP mailbox')
    await processNewEmail();
  }

  while (true) {
    try {
      // Read state within the loop to allow editing the state file manually without restarting.
      const state = readState();
      LOG.debug('Read state: %d announcements, %d threads, %d inquiries, hashes=%s',
          Object.keys(state.announcements).length,
          Object.keys(state.threads).length,
          Object.keys(state.inquiries).length,
          JSON.stringify(state.hashes));
      const browser = await puppeteer.launch();
      const page = await browser.newPage();

      await login(page);
      const emails = [];

      // Send messages to teachers. We later retrieve those messages when crawling threads below.
      await sendMessagesToTeachers(page);

      // Section "Aktuelles".
      const announcements = await readAnnouncements(page); // Always reads all.
      await readAttachments(page, announcements, state.announcements);
      buildEmailsForAnnouncements(page, announcements, state.announcements, emails);

      // Section "Kommunikation Eltern/Klassenleitung".
      const inquiries = await readInquiries(page);
      buildEmailsForInquiries(inquiries, state.inquiries, emails);

      // Section "Kommunikation Eltern/Fachlehrer".
      const teachers = await readActiveTeachers(page);
      await readThreadsMeta(page, teachers);
      await readThreadsContents(page, teachers);
      buildEmailsForThreads(teachers, state.threads, emails);

      // Section "Vertretungsplan"
      await readSubstitutions(page, state.hashes, emails);

      // Send emails to user.
      if (CONFIG.options.test) {
        await sendEmails(createTestEmails(emails.length));
        // Don't update state.
      } else {
        await sendEmails(emails);
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
      }

      // Only close after OK handlers have run.
      await browser.close();

      if (CONFIG.options.once) {
        LOG.info('Terminating due to --once flag/option');
        if (imapClient) {
          await imapClient.logout();
        }
        break;
      }
    } catch (e) {
      LOG.error(e);
      if (page) {
        LOG.error('URL of this error: ' + page.url());
        await page.screenshot({ path: 'last_error.png', fullPage: true });
        LOG.error('Screenshot stored in last_error.png');
      }
      // TODO: Detect permanent errors and quit.
    }

    // Wait until timeout or email received.
    LOG.debug('Waiting %d minutes until next check', CONFIG.options.checkIntervalMinutes);
    const p = new Promise((resolve) => {
      awake = resolve;
      // Only now will the IMAP receive event handler awake us. It could already have populated the
      // outbox and notified the previous Promise while the main loop was busy, so check for that.
      if (outbox.length) {
        resolve();
      } else {
        setTimeout(resolve, CONFIG.options.checkIntervalMinutes * 60 * 1000);
      }
    });
    await p;
  }
};

main().catch(e => {
  LOG.error('Main loop exited with the following error:');
  LOG.error(e);
  LOG.error(e.stack);
  if (imapClient) {
    imapClient.close(); // logout() doesn't work when an operation is in progress
  }
});
