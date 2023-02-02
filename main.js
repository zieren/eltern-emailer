const TITLE = 'Eltern-Emailer 0.4.0 (c) 2022-2023 Jörg Zieren, GNU GPL v3.'
    + ' See https://zieren.de/software/eltern-emailer for component license info';

const contentDisposition = require('content-disposition');
const { exit } = require('process');
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

const EMPTY_STATE = {
  // Last successful run (epoch millis). Older data in the portal can be skipped for performance.
  lastSuccessfulRun: 0,
  threads: {}, 
  announcements: {},
  inquiries: {}, 
  hashes: {
    subs: '',
    notices: {},
    events: {} // key: hash; value: timestamp
  }};

const INQUIRY_AUTHOR = ['Eltern', 'Klassenleitung', 'UNKNOWN'];

/**
 * List of already processed (i.e. emailed) items. Contains the following keys:
 * - 'announcements': Announcements in "Aktuelles".
 * - 'threads': Threads in "Kommunikation Eltern/Fachlehrer".
 * - 'inquiries': Inquiries in "Kommunikation Eltern/Klassenleitung".
 * - 'hashes': Other content, e.g. "Vertretungsplan"
 */
const STATE_FILE = 'state.json';

/** 
 * These errors, (at least some of) which may be emitted by the ImapFlow object, trigger a 
 * reconnect. This list is copied from imap-flow.js, which calls these errors "noise" :-).
 */
const IMAP_TRANSIENT_ERRORS = ['Z_BUF_ERROR', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH'];

// ---------- Retry throttling ----------

/** Seconds to wait after a failure, assuming no recent previous failure. */
const DEFAULT_RETRY_WAIT_SECONDS = 60; // 1m
/** If the last failure was less than this ago, back off exponentially. */
const BACKOFF_TRIGGER_SECONDS = 60 * 60; // 1h
/** Maximum time to wait in exponential backoff. */
const MAX_RETRY_WAIT_SECONDS = 60 * 60; // 1h
/** Retry wait time for the last error. */
let retryWaitSeconds = DEFAULT_RETRY_WAIT_SECONDS;
/** Timestamp of the last error. */
let lastFailureEpochMillis = 0;

// ---------- Shared state ----------

/** The ~current time (epoch millis). Set at the start of each main loop iteration. */
let NOW = null;
/** Initialized in main() after parsing CLI flags. */
let CONFIG = {}, LOG = null;
/** The IMAP client. */
let imapFlow = null;
/** This is set from the ImapFlow 'error' event handler. It triggers a retry. */
let imapReconnect = false;
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
  info: (o) => LOG.info('IMAP: %s', JSON.stringify(o)),
  warn: (o) => {
    LOG.warn('IMAP: %s', JSON.stringify(o));
    // The IMAP client can get stuck with nothing but a warning level log. So we do essentially the
    // same here as in the ImapFlow error handler, i.e. request a reconnect.
    imapReconnect = true;
    awake();
  },
  error: (o) => LOG.error('IMAP: %s', JSON.stringify(o)) 
  // The ImapFlow error handler initiates reconnect, so no need to do it here.
};

// ---------- Initialization functions ----------

function readState() {
  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) : {};
  setEmptyState(state, EMPTY_STATE);
  return state;
}

function setEmptyState(state, emptyState) {
  for (const [key, value] of Object.entries(emptyState)) {
    state[key] ||= value;
    setEmptyState(state[key], value); // Recurse for objects.
  }
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
            .replace('@', '(?:\\+(\\d+))@') // tag is mandatory
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

/** Downloads from file.url, setting file.filename and file.content. */
async function downloadFile(file, options) {
  // Collect buffers and use Buffer.concat() to avoid chunk size arithmetics.
  let buffers = [];
  // It seems attachment downloads don't need to be throttled.
  await new Promise((resolve, reject) => {
    https.get(file.url, options, (response) => {
      file.filename =
          contentDisposition.parse(response.headers['content-disposition']).parameters.filename;
      response.on('data', (buffer) => {
        buffers.push(buffer);
      }).on('end', () => {
        file.content = Buffer.concat(buffers);
        resolve();
      });
    }).on('error', (error) => {
      reject(error);
    });
  });
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
async function readAnnouncementsAttachments(page, announcements, processedAnnouncements) {
  let options = null;
  for (const a of announcements.filter(a => a.url && !(a.id in processedAnnouncements))) {
    options ||= {headers: {'Cookie': await getPhpSessionIdAsCookie(page)}};
    await downloadFile(a, options);
    LOG.info('Read attachment (%d kb) for: %s', a.content.length >> 10, a.subject);
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
async function readThreadsMeta(page, teachers, lastSuccessfulRun) {
  for (const teacher of teachers) {
    LOG.debug('Reading threads with %s', teacher.name);
    await page.goto(teacher.url);
    teacher.threads = (await page.$$eval(
        'a[href*="meldungen/kommunikation_fachlehrer/"]',
        (anchors) => anchors.map((a) => {
          // We don't use the time of day because it's in 12h format and missing any am/pm
          // indication (sic). That is ridiculous, but it's still easily good enough for caching.
          const d = a.parentElement.previousSibling.textContent.match(/(\d\d)\.(\d\d)\.(\d\d\d\d)/);
          return {
            id: a.href.match(/.*\/([0-9]+)$/)[1],
            url: a.href,
            subject: a.textContent,
            // We add two days to the date to account for a) lacking time of day, and b) timezones.
            // There is no need to cut it close, the performance gain would not outweigh complexity.
            latest: new Date(d[3], d[2] - 1, parseInt(d[1]) + 2).getTime()
          };
        })))
        .filter(t => t.latest >= lastSuccessfulRun);
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
            const a = row.querySelector('a.link_nachrichten');
            return {
              author: row.querySelector('label.control-label span').textContent,
              body: row.querySelector('div div.form-control').textContent,
              url: a ? a.href : null
            };
          }));
      LOG.debug(
          'Read %d recent messages with %s in "%s"',
          thread.messages.length, teacher.name, thread.subject);
    }
  }
}

async function readThreadsAttachments(page, teachers, processedThreads) {
  let options = null;
  for (const teacher of teachers) {
    for (const thread of teacher.threads) {
      for (let i = 0; i < thread.messages.length; ++i) {
        if (!(thread.id in processedThreads) || !(i in processedThreads[thread.id])) {
          if (thread.messages[i].url) {
            const msg = thread.messages[i];
            options ||= {headers: {'Cookie': await getPhpSessionIdAsCookie(page)}};
            await downloadFile(msg, options);
            LOG.info('Read attachment (%d kb) from "%s" in "%s"',
                msg.content.length >> 10, msg.author, thread.subject);
          }
        }
      }
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
          const msg = thread.messages[i];
          // The thread ID seems to be globally unique. Including the teacher ID simplifies posting
          // replies, because the mail client will put this ID in the In-Reply-To header.
          const messageIdBase = 'thread-' + teacher.id + '-' + thread.id + '-';
          const email = buildEmail(msg.author, thread.subject, {
            messageId: buildMessageId(messageIdBase + i),
            text: msg.body
          });
          if (msg.content) {
            email.attachments = [
              {
                filename: msg.filename,
                content: msg.content
              }
            ];
          }
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
    'div.panel', (panels) => panels.map(p => {
      return {
        subject: p.querySelector('h3.panel-title')
            .textContent.trim().replace(/\(Beantwortet\) (?=\d\d\.\d\d\.\d\d\d\d)/, ''),
        messages: Array.from(p.querySelector('div.panel-body').childNodes)
            .filter(n => n.nodeName === '#text').map(n => n.textContent)
      };
    }));
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
  const doParent = hash !== previousHashes.subs;
  const doStudent = doParent && !!CONFIG.options.emailToStudent;
  if (!doParent && !doStudent) {
    return;
  }

  const modifiedHTML = '<!DOCTYPE html><html><head><title>Vertretungsplan</title>'
      + '<style>table, td { border: 1px solid; } img { display: none; }</style></head>'
      + '<body>' + originalHTML + '</body></html>';
  let emailsLeft = (doParent && doStudent) ? 2 : 1;
  if (doParent) {
    emails.push({
      email: buildEmail('Vertretungsplan', 'Vertretungsplan', {html: modifiedHTML}),
      ok: () => { if (!--emailsLeft) previousHashes.subs = hash; }
    });
  }
  if (doStudent) {
    emails.push({
      email: buildEmail('Vertretungsplan', 'Vertretungsplan', 
                 {html: modifiedHTML, to: CONFIG.options.emailToStudent}),
      ok: () => { if (!--emailsLeft) previousHashes.subs = hash; }
    });
  }
  LOG.info('Found substitution plan update');
}

// ---------- Notice board ----------

async function readNoticeBoard(page, previousHashes, emails) {
  await page.goto(CONFIG.elternportal.url + '/aktuelles/schwarzes_brett');
  const gridItemsHTML =
      await page.$$eval('div.grid-item', (divs) => divs.map(div => div.innerHTML));
  let newHashes = {};
  for (const gridItemHTML of gridItemsHTML) {
    const hash = md5(gridItemHTML);
    if (previousHashes.notices[hash]) {
      newHashes[hash] = true;
      continue;
    }
    LOG.info('Found notice board message');
    newHashes[hash] = false;
    emails.push({
      email: buildEmail('Schwarzes Brett', 'Schwarzes Brett', {html: gridItemHTML}),
      ok: () => { newHashes[hash] = true; }
    });
  }
  // In the new object, existing hashes map to true while newly encountered ones map to false. They
  // are set to true in the OK handler.
  previousHashes.notices = newHashes;
}

// ---------- Events ----------

async function readEventsInternal(page) {
  let events = await page.$$eval('table.table2 td:nth-last-child(3)', (tds) => tds.map(td => {
      // Sometimes date ranges are specified. They may be invalid ("24.12.-23.12.""). We only care
      // about the start (first) date and ignore the end date.
      // Also, some events include a time of day while others don't. We always assume 0:00:00 and
      // include the event until the next day, so it doesn't vanish on the day itself.
      const d = td.textContent.match(/(\d\d)\.(\d\d)\.(\d\d\d\d)/);
      // The date should always parse. The error (null) case is handled below.
      const ts = d ? new Date(d[3], d[2] - 1, d[1]).getTime() : null;
      // Remove year because it's obvious, and use non-breaking hyphen to keep date and time on a
      // single line for better readability.
      const compactDateTime = (s) => s.replace(/( |20\d\d)/g, '').replace(/-/g, '&#8209;');
      const descriptionHTML = 
          '<td>' + compactDateTime(td.textContent)
          + '</td><td>&nbsp;' + compactDateTime(td.nextSibling.textContent)
          + '</td><td>' + td.nextSibling.nextSibling.textContent + '</td>';
      return {
        ts: ts, 
        descriptionHTML: descriptionHTML,
      };
      }));
  // Handle parsing failures here because we don't have the logger in the page context above.
  events.filter(e => !e.ts).forEach(e => {
    e.ts = NOW; // Assume the event is imminent, just to be safe.
    // We only have the HTML here, but this case should be very rare.
    LOG.error('Failed to parse date: "%s"', e.descriptionHTML);
  });
  return events.map(e => { return {...e, hash: md5(e.descriptionHTML)};});
}

async function readEvents(page, previousHashes, emails) {
  // An event is considered expired on the next day. We store events with a time of day of 0:00:00,
  // so we compute the timestamp for 0:00:00 today and prune events before then.
  const todayZeroDate = new Date(NOW);
  todayZeroDate.setHours(0, 0, 0, 0);
  const todayZeroTs = todayZeroDate.getTime();
  Object.entries(previousHashes)
      .filter(([_, ts]) => ts < todayZeroTs)
      .forEach(([hash, _]) => delete previousHashes[hash])

  // Read all exams and events.
  await page.goto(CONFIG.elternportal.url + '/service/termine/liste/schulaufgaben');
  let events = await readEventsInternal(page);
  await page.goto(CONFIG.elternportal.url + '/service/termine/liste/allgemein');
  events = events.concat(await readEventsInternal(page));

  // Filter those within the lookahead range and not yet processed.
  let lookaheadDate = new Date(todayZeroDate);
  lookaheadDate.setDate(lookaheadDate.getDate() + CONFIG.options.eventLookaheadDays);
  const lookaheadTs = lookaheadDate.getTime();
  const upcomingEvents = 
      events.filter(e => e.ts >= todayZeroTs && e.ts <= lookaheadTs).sort((a, b) => a.ts - b.ts);
  const numNewEvents = upcomingEvents.filter(e => !(e.hash in previousHashes)).length;

  // Create emails.
  if (!numNewEvents) {
    LOG.debug('No new upcoming events');
    return;
  }
  let emailHTML = '<!DOCTYPE html><html><head><title>Bevorstehende Termine</title>'
      + '<style>'
      + 'table { border-collapse: collapse; } '
      + 'tr { border-bottom: 1pt solid; } '
      + 'tr.new { font-weight: bold; } '
      + '</style>'
      + '</head><body><h2>Termine in den n&auml;chsten ' + CONFIG.options.eventLookaheadDays
      + ' Tagen</h2><table>';
  upcomingEvents.forEach(e => emailHTML +=  
      (e.hash in previousHashes ? '<tr><td>' : '<tr class="new"><td>*') + '</td>' 
      + e.descriptionHTML + '</tr>');
  emailHTML += '</table></body></html>';
  const doStudent = !!CONFIG.options.emailToStudent;
  let emailsLeft = doStudent ? 2 : 1;
  emails.push({
    email: buildEmail('Bevorstehende Termine', 'Bevorstehende Termine', {html: emailHTML}),
    ok: () => { if (--emailsLeft) upcomingEvents.forEach(e => previousHashes[e.hash] = e.ts); }
  });
  if (doStudent) {
    emails.push({
      email: buildEmail('Bevorstehende Termine', 'Bevorstehende Termine', 
                 {html: emailHTML, to: CONFIG.options.emailToStudent}),
      ok: () => { if (--emailsLeft) upcomingEvents.forEach(e => previousHashes[e.hash] = e.ts); }
    });
  }
  LOG.info('%d upcoming event(s), of which %d new', upcomingEvents.length, numNewEvents);
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
  return {...{
    from: '"' + fromName.replace(/["\n]/g, '') + ' (EE)" <' + CONFIG.options.emailFrom + '>',
    to: CONFIG.options.emailTo,
    subject: subject
  }, ...options};
}

// ---------- Email sending ----------

async function sendEmails(emails) {
  LOG.info('Sending %d email(s)', emails.length);
  if (!emails.length) {
    return;
  }
  const transport = nodemailer.createTransport(CONFIG.smtp);
  let first = true;
  for (const e of emails) {
    if (CONFIG.options.mute) {
      LOG.info('Not sending email "%s" to %s', e.email.subject, e.email.to);
      await e.ok();
      continue;
    }
    // Throttle outgoing emails.
    if (!first) {
      LOG.info('Waiting %d seconds between messages', CONFIG.options.smtpWaitSeconds);
      await sleepSeconds(CONFIG.options.smtpWaitSeconds);
    }
    first = false;
    LOG.info('Sending email "%s" to %s', e.email.subject, e.email.to);
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

/** Create the ImapFlow client, configure its event handlers and open the mailbox. */
async function createImapFlow() {
  imapFlow = new ImapFlow(CONFIG.imap);
  // Check for new messages on open, and whenever the # of existing messages changes.
  imapFlow
      .on('mailboxOpen', async () => {
        // This will run before the 'exists' handler below.
        LOG.debug('Mailbox opened, checking for new messages...');
        await processNewEmail();
      })
      .on('exists', async (data) => {
        LOG.info('Received new message(s): %s', JSON.stringify(data));
        await processNewEmail();
      })
      // Without an error handler, errors crash the entire NodeJS env!
      // Background: https://nodejs.dev/en/api/v19/events/
      .on('error', (e) => {
        // Error details were already logged by our custom logger.
        // If we lost the connection to the IMAP server, which can happen e.g. after a Windows
        // suspend->resume cycle, or simply in case of random network issues, the ImapFlow object
        // emits an ECONNRESET event. Presumably other transient errors may happen as well. We
        // request a reconnect and terminate the waiting in the main loop. The main loop will then
        // throw an exception, triggering the regular retry with exponential backoff.
        // Further errors may follow, but we never clear the flag because once a transient error has
        // been observed, a reconnect will probably help regardless of subsequent problems.
        imapReconnect ||= IMAP_TRANSIENT_ERRORS.includes(e.code);
        awake();
      });
  await imapFlow.connect();
  await imapFlow.mailboxOpen('INBOX');
  LOG.info('Listening on IMAP mailbox')
  return imapFlow;
}

/** This uses the "answered" flag, which is part of the IMAP standard, to mark messages done. */
async function processNewEmail() {
  // Collect messages not intended for forwarding to teachers. These are marked processed to hide
  // them in the next query. They only trigger a check. Key is IMAP sequence number, value is 1.
  const ignoredMessages = {};
  let numNewMessages = 0;
  
  for await (let message of imapFlow.fetch({answered: false}, { source: true })) {
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
        LOG.warn('Failed to parse recipient "%s"', recipient.address);
        continue; // Should never happen because we filtered recipients to match the RegEx above.
      }

      // We now know that the message has payload. The prep handler below will mark it done.
      delete ignoredMessages[message.seq];

      const isReply = teacherId == replyTeacherId;
      LOG.info(
        'Received %s teacher %d (%s): "%s" (%d characters)',
        isReply ? 'reply to ' : 'email for ', teacherId, recipient.name, 
        parsedMessage.subject, parsedMessage.text.length);
      outbox.push({
        teacherId: teacherId,
        replyThreadId: isReply ? replyThreadId : undefined,
        subject: isReply ? undefined : parsedMessage.subject,
        text: parsedMessage.text,
        markDone: async () => markEmail(message.seq, true),
        markNotDone: singleRecipient ? async () => markEmail(message.seq, false) : () => {}
      });
    }
  }
  LOG.debug('New emails: %d', numNewMessages);

  if (Object.keys(ignoredMessages).length) {
    const seqs = Object.keys(ignoredMessages).join();
    await imapFlow.messageFlagsAdd({seq: seqs}, ['\\Answered']);
    LOG.debug('Marked ignored emails: %s', seqs);
  }

  // For simplicity we awake unconditionally. We don't distinguish between new content notifications
  // and ignored messages, e.g. sick leave confirmation. An occasional false positive is OK.
  if (numNewMessages) {
    awake();
  }
}

async function markEmail(seq, done) {
  if (done) {
    await imapFlow.messageFlagsAdd({ seq: seq }, ['\\Answered']);
    LOG.debug('Marked processed email: %d', seq);
  } else {
    await imapFlow.messageFlagsRemove({ seq: seq }, ['\\Answered']);
    LOG.debug('Marked unprocessed email: %d', seq);
  }
}

// ---------- Outgoing messages ----------

async function sendMessagesToTeachers(page) {
  LOG.info('Sending %d messages to teachers', outbox.length);
  for (const msg of outbox) {
    // Curiously navigation will always succeed, even for nonexistent teacher IDs. What's more, we
    // can actually send messages that we can then retrieve by navigating to the URL directly. This
    // greatly simplifies testing :-)

    // In case of multiple messages we prefix them with "[n/N] ". Assuming that n and N have at most
    // 2 characters, we simply substract 8 characters for every such prefix.
    // TODO: Extract magic 512? Is that maybe even configurable?
    const capacity = msg.text.length <= 512 ? 512 : (512 - 8);
    const numMessages = Math.ceil(msg.text.length / capacity);
    let onReplyPage = false;
    for (let i = 0; i < numMessages; i++) {
      if (msg.replyThreadId) {
        if (!onReplyPage) {
          await page.goto(
              CONFIG.elternportal.url + '/meldungen/kommunikation_fachlehrer/'
              + msg.teacherId + '/_/' + msg.replyThreadId);
          // We probably don't need load_all=1 here, assuming the reply box is always shown.
          onReplyPage = true; // The form remains available after posting the reply.
        } // else: We're already on the reply page.
      } else { // create a new thread
        await page.goto(
            CONFIG.elternportal.url + '/meldungen/kommunikation_fachlehrer/' + msg.teacherId);
        await page.type('#new_betreff', msg.subject);
      }

      const prefix = numMessages == 1 ? '' : '[' + (i + 1) + '/' + numMessages + '] ';
      const logInfix = numMessages == 1 ? '' : ' part ' + (i + 1) + '/' + numMessages;
      await page.type(
          '#nachricht_kom_fach', prefix + msg.text.substring(i * capacity, (i + 1) * capacity));

      // We mark the original email done before actually submitting the form to avoid duplicate 
      // messages in case of errors.
      if (i == 0) {
        await msg.markDone();
      }

      // Click the button to do the thing.
      const [response] = await Promise.all([
        page.waitForNavigation(),
        page.click('button#send')
      ]);

      if (response.ok()) {
        LOG.info('Sent message%s to teacher %d', logInfix, msg.teacherId);
        // The new thread is the first shown on the response page. Extract its ID and treat the
        // remaining parts as replies. The form shown on the response page is NOT associated with
        // this thread, but would open a new thread.
        if (numMessages > 1 && !msg.replyThreadId) {
          msg.replyThreadId = await page.$eval(
            'a[href*="meldungen/kommunikation_fachlehrer/"',
            (a) => a.href.match(/.*\/([0-9]+)$/)[1]);
        }
      } else {
        // TODO: Report this back, i.e. email the error to the user.
        LOG.error(
            'Failed to send message %sto teacher %d: %s',
            prefix, msg.teacherId, response.statusText);
        // If we haven't posted any messages yet, we can retry this email.
        if (i == 0) {
          await msg.markNotDone();
        }
      }
    }
  }
  outbox = [];
}

// ---------- Main ----------

/** 
 * If this function returns normally, its return value will be the program's exit code. If it 
 * throws, we perform a retry (i.e. call it again) with exponential backoff.
 */
async function main() {
  const parser = await import('args-and-flags').then(aaf => {
    return new aaf.default(CLI_OPTIONS);
  });
  const {_, flags} = parser.parse(process.argv.slice(2));

  CONFIG = JSON.parse(fs.readFileSync(flags.config, 'utf-8'));
  CONFIG.imap.logger = imapLogger; // standing orders
  LOG = createLogger();
  LOG.info(TITLE);

  // Ensure config file has been edited.
  if (CONFIG.elternportal.url.startsWith('https://SCHOOL.')) {
    LOG.error('Please edit the config file to specify your login credentials, SMTP server etc.');
    return 2;
  }

  CONFIG.options.checkIntervalMinutes = Math.max(CONFIG.options.checkIntervalMinutes, 10);
  processFlags(flags);
  createIncomingEmailRegExp();

  // Start IMAP listener, if enabled.
  if (CONFIG.options.incomingEmailEnabled) {
    try {
      imapFlow = await createImapFlow();
    } catch (e) {
      // Error details were already logged by our custom logger.
      // Check for some permanent errors upon which we should quit. This list may need to be
      // extended.
      if (e.authenticationFailed) {
        LOG.error('IMAP server rejected credentials');
        return 3;
      }
      if (e.code == 'ENOTFOUND') {
        LOG.error('IMAP server not found');
        return 4;
      }
      // Occasionally we get "some other error" (hooray for implicit typing...). We assume here
      // that all errors not handled above are transient, which may be wrong but shouldn't cause
      // too much trouble due to our exponential backoff.
      throw e; // retry
    }
  }

  while (true) {
    NOW = Date.now();

    // Read state within the loop to allow editing the state file manually without restarting.
    const state = readState();
    LOG.debug('Read state: %d announcements, %d threads, %d inquiries',
        Object.keys(state.announcements).length,
        Object.keys(state.threads).length,
        Object.keys(state.inquiries).length);
    const browser = await puppeteer.launch();
    const page = await browser.newPage();

    await login(page);
    const emails = [];

    // Send messages to teachers. We later retrieve those messages when crawling threads below. That
    // is intentional because presumably the second parent wants a copy of the message.
    await sendMessagesToTeachers(page);

    // Section "Aktuelles".
    const announcements = await readAnnouncements(page); // Always reads all.
    await readAnnouncementsAttachments(page, announcements, state.announcements);
    buildEmailsForAnnouncements(page, announcements, state.announcements, emails);

    // Section "Kommunikation Eltern/Klassenleitung".
    const inquiries = await readInquiries(page);
    buildEmailsForInquiries(inquiries, state.inquiries, emails);

    // Section "Kommunikation Eltern/Fachlehrer".
    const teachers = await readActiveTeachers(page);
    await readThreadsMeta(page, teachers, state.lastSuccessfulRun);
    await readThreadsContents(page, teachers);
    await readThreadsAttachments(page, teachers, state.threads);
    buildEmailsForThreads(teachers, state.threads, emails);

    // Section "Vertretungsplan"
    await readSubstitutions(page, state.hashes, emails);

    // Section "Schwarzes Brett"
    await readNoticeBoard(page, state.hashes, emails);

    // Section "Schulaufgaben / Weitere Termine"
    await readEvents(page, state.hashes.events, emails);

    // Send emails to user and possibly update state.
    if (CONFIG.options.test) {
      await sendEmails(createTestEmails(emails.length));
      // Don't update state.
    } else {
      await sendEmails(emails);
      state.lastSuccessfulRun = NOW;
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    }

    // Only close after OK handlers have run.
    await browser.close();

    if (CONFIG.options.once) {
      LOG.info('Terminating due to --once flag/option');
      if (imapFlow) {
        await imapFlow.logout();
      }
      return 0;
    }

    // Wait until timeout, email received or IMAP reconnect request.
    const p = new Promise((resolve) => {
      awake = resolve;
      // Only now can the IMAP receive event handler awake us. It could already have populated the
      // outbox and notified the previous Promise while the main loop was busy, so check for that.
      // It could also have requested a reconnect.
      if (outbox.length || imapReconnect) {
        resolve();
      } else {
        LOG.debug('Waiting %d minutes until next check', CONFIG.options.checkIntervalMinutes);
        setTimeout(resolve, CONFIG.options.checkIntervalMinutes * 60 * 1000);
      }
    });
    await p;
    if (imapReconnect) {
      imapReconnect = false;
      throw 'Triggering IMAP reconnect'; // Trigger retry with exponential backoff.
    }
  }
};

(async () => {
  while (true) {
    const err = await main().catch(e => {
      // Winston's file transport silently swallows calls in quick succession, so concatenate.
      LOG.error('Error in main loop:\n%s', e.stack || e);
      if (imapFlow) {
        imapFlow.close(); // logout() doesn't work when an operation is in progress
      }
    });
    if (typeof err !== 'undefined') {
      LOG.info('Exiting with code %d', err);
      exit(err);
    }

    const nowEpochMillis = Date.now();
    const secondsSinceLastFailure = (nowEpochMillis - lastFailureEpochMillis) / 1000;
    LOG.debug('Last failure was %d seconds ago', secondsSinceLastFailure);
    if (secondsSinceLastFailure > BACKOFF_TRIGGER_SECONDS) { // reset wait time
      retryWaitSeconds = DEFAULT_RETRY_WAIT_SECONDS;
    } else { // exponential backoff
      retryWaitSeconds =  Math.min(retryWaitSeconds * 2, MAX_RETRY_WAIT_SECONDS); 
    }
    lastFailureEpochMillis = nowEpochMillis;
    LOG.info('Waiting %d seconds before retry', retryWaitSeconds);
    await sleepSeconds(retryWaitSeconds);
    LOG.debug('Waiting completed');
  }
})();
