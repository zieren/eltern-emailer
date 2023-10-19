const TITLE = 'Eltern-Emailer 0.7.1 (c) 2022-2023 Jörg Zieren, GNU GPL v3.'
    + ' See https://zieren.de/software/eltern-emailer for component license info';

const contentDisposition = require('content-disposition');
const { exit } = require('process');
const https = require('https');
const fs = require('fs-extra');
const { ImapFlow } = require('imapflow');
const md5 = require('md5');
const nodemailer = require('nodemailer');
const puppeteer = require('puppeteer');
const { simpleParser } = require('mailparser');

// ---------- Shared state ----------

const lg = require('./logging.js'); // provides global LOG (initialized below)

// Browser instance is shared across eltern-portal.org and schulmanager-online.de.
global.BROWSER = null;
// Initialized in main() after parsing CLI flags.
global.CONFIG = {};
// Inbound messages are intended for the user(s). They are generated from crawling the portal(s) and
// emailed to the user(s) via SMTP.
global.INBOUND = [];

// ---------- Something like encapsulation ----------

// Maybe I should have used classes, but it seems that it doesn't really matter that much.
const em = require('./email.js')
const sm = require('./schulmanager.js');

// ---------- Constants ----------

const CLI_OPTIONS = {
  args: [],
  flags: [
    { name: 'config', type: 'string', default: 'config.json' },
    { name: 'ep_password', type: 'string' },
    { name: 'sm_password', type: 'string' },
    { name: 'smtp_password', type: 'string' },
    { name: 'imap_password', type: 'string' },
    { name: 'mute', type: 'boolean' },
    { name: 'once', type: 'boolean' },
    { name: 'test', type: 'boolean' }
  ]
};

const EMPTY_STATE = {
  ep: {
    lastSuccessfulRun: 0, // Last successful run (epoch millis). Older data can be skipped.
    threads: {},
    announcements: {},
    inquiries: {},
    events: {}, // key: event description (needed when event is *removed*); value: timestamp
    hashes: {
      subs: '',
      notices: {}
    }
  },
  sm: {
    letters: {} // key: "$id $subject", value: 1
  }
};

const INQUIRY_AUTHOR = ['Eltern', 'Klassenleitung', 'UNKNOWN'];

// Status of events and their (partial) HTML representation.
const STATUS_TO_HTML = {
  '-1': '<tr class="removed"><td>--', // removed (a rare but relevant case)
  '0': '<tr><td>',  // previously notified
  '1': '<tr class="new"><td>*', // added
};

/**
 * List of already processed (i.e. emailed) items. Contains the following keys:
 * - 'announcements': Announcements in "Aktuelles".
 * - 'threads': Threads in "Kommunikation Eltern/Fachlehrer".
 * - 'inquiries': Inquiries in "Kommunikation Eltern/Klassenleitung".
 * - 'hashes': Other content, e.g. "Vertretungsplan"
 */
const STATE_FILE = 'state.json';

// ---------- Retry throttling ----------

/** Seconds to wait after a failure, assuming no recent previous failure. */
const DEFAULT_RETRY_WAIT_SECONDS = 15;
/** If the last failure was less than this ago, back off exponentially. */
const BACKOFF_TRIGGER_SECONDS = 60 * 60; // 1h
/** Maximum time to wait in exponential backoff. */
const MAX_RETRY_WAIT_SECONDS = 60 * 60; // 1h
/** Retry wait time for the last error. */
let RETRY_WAIT_SECONDS = DEFAULT_RETRY_WAIT_SECONDS;
/** Timestamp of the last error. */
let LAST_FAILURE_EPOCH_MILLIS = 0;

/** The ~current time (epoch millis). Set at the start of each main loop iteration. */
let NOW = null;
/** The IMAP client. */
let IMAP_CLIENT = null;
/** Synchronization between IMAP event listener and main loop. */
let awake = () => {}; // Event handler may fire before the main loop builds the wait Promise.
/** 
 * Outbound messages are intended for teachers. They are received asynchronously via IMAP and posted
 * on the portal. Each has a "prep" handler that must complete successfully before actually sending.
 * This handler will mark the original email that triggered this message as answered in IMAP to
 * avoid duplicate messages to teachers in case of errors (e.g. when the message to the teacher is
 * sent, but the email in the IMAP inbox cannot be marked processed). Using an IMAP flag instead of
 * the status file has the downside that it cannot express partial success, but that is a rare case
 * anyway. On the upside the IMAP flag will persist across reinstalls or deletion of the status
 * file.
 */
let OUTBOUND = [];
/** Forward IMAP logging to our own logger. */
const IMAP_LOGGER = {
  debug: (o) => {}, // This is too noisy.
  info: (o) => LOG.info('IMAP: %s', JSON.stringify(o)),
  // Some errors don't trigger the error handler, but only show up as an error or even just warning
  // level log. We do the same here as we do in the error handler; see there for comments.
  warn: (o) => {
    LOG.warn('IMAP: %s', JSON.stringify(o));
    awake();
  },
  error: (o) => {
    LOG.error('IMAP: %s', JSON.stringify(o));
    awake();
  } 
};

// ---------- Initialization functions ----------

function readState() {
  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) : {};
  setEmptyState(state, EMPTY_STATE);
  LOG.debug('Read state');
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
  CONFIG.schulmanager.pass = flags.sm_password || CONFIG.schulmanager.pass;
  CONFIG.smtp.auth.pass = flags.smtp_password || CONFIG.smtp.auth.pass;
  CONFIG.imap.auth.pass = flags.imap_password || CONFIG.imap.auth.pass;
  CONFIG.options.mute = flags.mute !== undefined ? flags.mute : CONFIG.options.mute;
  CONFIG.options.once = flags.once !== undefined ? flags.once : CONFIG.options.once;
  CONFIG.options.test = flags.test !== undefined ? flags.test : CONFIG.options.test;
}

function createIncomingEmailRegExp() {
  if (CONFIG.options.incomingEmail.forwardingAddress) {
    CONFIG.options.incomingEmail.regEx =
        '(?:^|<)' 
        + CONFIG.options.incomingEmail.forwardingAddress
            .replace(/\./g, '\\.')
            .replace('@', '(?:\\+(\\d+))@') // tag is mandatory
        + '(?:$|>)';
  }
}

// ---------- Utilities ----------

function elternPortalConfigured() {
  return CONFIG.elternportal && !CONFIG.elternportal.url.startsWith('https://SCHOOL.');
}

function schulmanagerConfigured() {
  return CONFIG.schulmanager && CONFIG.schulmanager.user !== 'EMAIL ADDRESS FOR LOGIN';
}

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
async function loginElternPortal(page) {
  await page.goto(CONFIG.elternportal.url);
  await page.type('#inputEmail', CONFIG.elternportal.user);
  await page.type('#inputPassword', CONFIG.elternportal.pass);
    await Promise.all([
    page.waitForNavigation(),
    page.click('#inputPassword ~ button')
  ]);
  // When settings are present, we are logged in.
  const success = await page.$$eval('a[href*="einstellungen"]', (a) => a.length) > 0;
  if (!success) {
    throw 'Login Eltern-Portal failed';
  }
  LOG.info('Login Eltern-Portal OK');
}

// TODO: Store this globally to avoid calling it multiple times?
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
        const d = n.firstChild.nextSibling.textContent // it's a text node
            .match(/(\d\d)\.(\d\d)\.(\d\d\d\d) +(\d\d:\d\d:\d\d)/);
        return {
          // Use the ID also used for reading confirmation, because it should be stable.
          id: n.attributes.onclick.textContent.match(/\(([0-9]+)\)/)[1],
          // Strip subject and date, which are in "n".
          body: n.parentElement.innerText.substring(n.innerText.length).trim(),
          subject: n.firstChild.textContent,
          url: n.tagName === 'A' ? n.href : null,
          // Date isn't serializable, so we need to use a string.
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

function buildEmailsForAnnouncements(page, announcements, processedAnnouncements) {
  announcements
      .filter(a => !(a.id in processedAnnouncements))
      // Send oldest announcements first, i.e. maintain chronological order. This is not reliable
      // because emails race, but GMail ignores the carefully forged message creation date (it shows
      // the reception date instead), so it's the best we can do.
      .reverse()
      .map(a => {
        const email = em.buildEmailEpAnnouncements(a.subject, {
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
      }).forEach(e => INBOUND.push(e));
}

// ---------- Threads ----------

/** Returns a list of teachers with at least one thread. */
async function readActiveTeachers(page) {
  await page.goto(CONFIG.elternportal.url + '/meldungen/kommunikation_fachlehrer');
  const teachers = await page.$$eval(
    // New messages cause a "Neu" indicator with the same href as the teacher. The :first-child
    // selector prevents duplicates from that.
    'td:nth-child(3) a[href*="meldungen/kommunikation_fachlehrer/"]:first-child',
    (anchors) => anchors.map(
      (a) => {
        // Some roles (e.g. director) are added after the name, separated by "<br>", which is 
        // %-encoded. We strip that to get the name (in "last name first" order, in our school).
        const m = a.href.match(/.*\/([0-9]+)\/(.*)/);
        return {
          id: m[1],
          url: a.href,
          name: decodeURI(m[2]).replace(/<.*/, '').replace(/_/g, ' ')
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
          // Extract teacher name and thread ID. In our school the teacher name used here is clean
          // and in "first name first" order. First and last name are separated by '_'.
          const m = a.href.match(/.*\/([^\/]*)\/([0-9]+)$/);
          return {
            id: m[2],
            url: a.href,
            teacherName: decodeURI(m[1]).replace(/_/g, ' '),
            subject: a.textContent,
            // We add two days to the date to account for a) lacking time of day, b) timezones, and
            // c) clock skew. There is no need to cut it close, the performance gain would not
            // outweigh complexity.
            latest: new Date(d[3], d[2] - 1, parseInt(d[1]) + 2).getTime()
          };
        })))
        .filter(t => t.latest >= lastSuccessfulRun);
  }
}

/** Populates threads with contents, i.e. individual messages. */
async function readThreadsContents(page, teachers) {
  for (const teacher of teachers) {
    // TODO: Reverse this so we send in chronological order. We can simply sort numerically by
    // thread ID.
    for (const thread of teacher.threads) {
      await page.goto(thread.url + '?load_all=1'); // Prevent pagination (I hope).
      thread.messages = await page.$eval('div#last_messages',
          (div) => Array.from(div.children).map(row => {
            // TODO: Document that this is for attachments. Rename "url" below, and handle mutliple.
            const a = row.querySelector('a.link_nachrichten');
            return {
              author: !!row.querySelector('label span.link_buchungen'), // resolved below
              body: row.querySelector('div div.form-control').textContent,
              url: a ? a.href : null
            };
          }));
      // We can't access "teacher" from Puppeteer, so set "author" here.
      thread.messages.forEach(m => {
        m.author = m.author ? thread.teacherName : 'Eltern';
      });
      LOG.debug(
          'Read %d recent messages with %s in "%s"',
          thread.messages.length, thread.teacherName, thread.subject);
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

function buildEmailsForThreads(teachers, processedThreads) {
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
          const email = em.buildEmailEpThreads(msg.author, thread.subject, {
            messageId: em.buildMessageId(messageIdBase + i),
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
            email.references = [em.buildMessageId(messageIdBase + (i - 1))];
          }
          if (CONFIG.options.incomingEmail.forwardingAddress) {
            // We always put the teacher ID here, so the user can also reply to their own messages.
            email.replyTo = 
                '"' + thread.teacherName.replace(/"/g, '') + '" <'
                + CONFIG.options.incomingEmail.forwardingAddress
                    .replace('@', '+' + teacher.id + '@');
                + '>';
          }
          INBOUND.push({
            // We don't forge the date here because time of day is not available. It would be
            // confusing to have all messages written on the same day show up at "00:00".
            email: email,
            ok: () => { processedThreads[thread.id][i] = 1; }
          });
        }
      }
    }
  }
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

function buildEmailsForInquiries(inquiries, processedInquiries) {
  for (const [i, inquiry] of Object.entries(inquiries)) {
    if (!(i in processedInquiries)) {
      // This indicates the next index to process.
      processedInquiries[i] = 0;
    }
    for (let j = processedInquiries[i]; j < inquiry.messages.length; ++j) {
      // AFAICT each thread has at most two messages.
      const email = em.buildEmailEpThreads(
          INQUIRY_AUTHOR[Math.min(j, 2)],
          inquiry.subject,
          { // TODO: Consider enriching this, see TODO for other messageId (#4).
            messageId: em.buildMessageId('inquiry-' + i + '-' + j),
            // TODO: ^^ What if these are cleared after the school year, and indexes start at 0 again?
            // Maybe include a hash of the subject, or the date, to avoid collisions.
            text: inquiry.messages[j]
          });
      if (j > 0) {
        email.references = [em.buildMessageId('inquiry-' + i + '-' + (j - 1))];
      }
      INBOUND.push({
        // We don't forge the date here because time of day is not available. It would be confusing
        // to have all messages written on the same day show up at "00:00".
        email: email,
        ok: () => { processedInquiries[i] = j + 1; }
        // TODO: This relies on execution order. Fix it to match handling of threads.
      });
    }
  }
}

// ---------- Substitutions ----------

async function readSubstitutions(page, previousHashes) {
  await page.goto(CONFIG.elternportal.url + '/service/vertretungsplan');
  const originalHTML = await page.$eval('div#asam_content', (div) => div.innerHTML);
  const hash = md5(originalHTML);
  if (hash === previousHashes.subs) {
    return;
  }

  const modifiedHTML = '<!DOCTYPE html><html><head><title>Vertretungsplan</title>'
      + '<style>table, td { border: 1px solid; } img { display: none; }</style></head>'
      + '<body>' + originalHTML + '</body></html>';
  INBOUND.push({
    email: em.buildEmailEpSubstitutions({html: modifiedHTML}),
    ok: () => { previousHashes.subs = hash; }
  });
  LOG.info('Found substitution plan update');
}

// ---------- Notice board ----------

async function readNoticeBoard(page, previousHashes) {
  await page.goto(CONFIG.elternportal.url + '/aktuelles/schwarzes_brett');
  const currentItems = await page.$$('div.grid-item');
  const archivedItems = await page.$$('div.well');
  const allItems = currentItems.concat(archivedItems);
  let newHashes = {};
  for (const item of allItems) {
    const innerHTML = await page.evaluate(item => item.innerHTML, item);
    const subject = await item.$eval('h4', h => h.innerText);
    const hash = md5(innerHTML);
    if (previousHashes.notices[hash]) {
      newHashes[hash] = true;
      continue;
    }
    LOG.info('Found notice board message');
    newHashes[hash] = false;
    INBOUND.push({
      email: em.buildEmailEpNotices(subject, {
        html: `<!DOCTYPE html><html><head></head><body>${innerHTML}</body></html>`
      }),
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
      const html = 
          '<td>' + compactDateTime(td.textContent)
          + '</td><td>&nbsp;' + compactDateTime(td.nextSibling.textContent)
          + '</td><td>' + td.nextSibling.nextSibling.textContent + '</td>';
      return {
        ts: ts, 
        html: html
      };
  }));
  // Handle parsing failures here because we don't have the logger in the page context above.
  events.filter(e => !e.ts).forEach(e => {
    e.ts = NOW; // Assume the event is imminent, just to be safe.
    // We only have the HTML here, but this case should be very rare.
    LOG.error('Failed to parse date: "%s"', e.html);
  });
  return events;
}

async function readEvents(page, previousEvents) {
  // An event is considered expired on the next day. We store events with a time of day of 0:00:00,
  // so we compute the timestamp for 0:00:00 today and prune events before then. Note that the event
  // HTML also contains the date, so using it as a key is sufficient and we can ignore the
  // timestamp.
  const todayZeroDate = new Date(NOW);
  todayZeroDate.setHours(0, 0, 0, 0);
  const todayZeroTs = todayZeroDate.getTime();
  Object.entries(previousEvents) // yields array of [html, ts] tuples
      .filter(([_, ts]) => ts < todayZeroTs)
      .forEach(([html, _]) => delete previousEvents[html])

  // Read all exams and events.
  await page.goto(CONFIG.elternportal.url + '/service/termine/liste/schulaufgaben');
  let events = await readEventsInternal(page);
  await page.goto(CONFIG.elternportal.url + '/service/termine/liste/allgemein');
  events = events.concat(await readEventsInternal(page));

  // Filter those within the lookahead range and not yet processed.
  let lookaheadDate = new Date(todayZeroDate);
  lookaheadDate.setDate(lookaheadDate.getDate() + CONFIG.options.eventLookaheadDays);
  const lookaheadTs = lookaheadDate.getTime();
  let upcomingEvents = events
      .filter(e => e.ts >= todayZeroTs && e.ts <= lookaheadTs)
      // See STATUS_TO_HTML for status codes.
      .map(e => { return {...e, status: e.html in previousEvents ? 0 : 1 }; });
  const numNewEvents = upcomingEvents.filter(e => e.status == 1).length;
  
  // Find removed events. previousEvents has been pruned above, so anything it contains that is no
  // longer upcoming was removed.
  const upcomingEventsHtml = upcomingEvents.map(e => e.html);
  const removedEvents = Object.entries(previousEvents) // yields array of [html, ts] tuples
      .filter(([html, _]) => !upcomingEventsHtml.includes(html))
      .map(([html, ts]) => { return { html: html, ts: ts, status: -1 /* means: removed */}; });
  const numRemovedEvents = Object.keys(removedEvents).length;

  // Join the two and sort them by timestamp.
  upcomingEvents = upcomingEvents.concat(removedEvents).sort((a, b) => a.ts - b.ts);

  LOG.info(`${upcomingEvents.length} upcoming event(s), `
      + `of which ${numNewEvents} new and ${numRemovedEvents} removed`);

      // Create emails.
  if (!(numNewEvents + numRemovedEvents)) {
    return;
  }
  let emailHTML = '<!DOCTYPE html><html><head><title>Bevorstehende Termine</title>'
      + '<style>'
      + 'table { border-collapse: collapse; } '
      + 'tr { border-bottom: 1pt solid; } '
      + 'tr.new { font-weight: bold; } '
      + 'tr.removed { text-decoration: line-through; } '
      + '</style>'
      + '</head><body><h2>Termine in den n&auml;chsten ' + CONFIG.options.eventLookaheadDays
      + ' Tagen</h2><table>';
  upcomingEvents.forEach(e => emailHTML += STATUS_TO_HTML[e.status] + '</td>' + e.html + '</tr>');
  emailHTML += '</table></body></html>';

  const okHandler = function() {
    // Update state of previous (announced) events when all emails are sent.
    upcomingEvents.forEach(e => {
      if (e.status == 1) {
        previousEvents[e.html] = e.ts; // new event -> no longer new next time
      } else if (e.status == -1) {
        delete previousEvents[e.html]; // removed event -> no longer included next time
      } // else: status 0 means the event exists both in the portal and in previousEvents -> no-op
    })};

  INBOUND.push({
    email: em.buildEmailEpEvents({html: emailHTML}),
    ok: () => okHandler()
  });
}

// ---------- Email sending ----------

async function sendEmails() {
  LOG.info('Sending %d email(s)', INBOUND.length);
  if (!INBOUND.length) {
    return;
  }
  const transport = nodemailer.createTransport(CONFIG.smtp);
  let errors = [];
  for (let i = 0; i < INBOUND.length; ++i) {
    const e = INBOUND[i];
    if (CONFIG.options.mute) {
      LOG.info('Not sending email "%s" to %s', e.email.subject, e.email.to);
      await e.ok();
      continue;
    }
    // Throttle outgoing emails.
    if (i > 0) {
      LOG.info('Waiting %d seconds between messages', CONFIG.options.smtpWaitSeconds);
      await sleepSeconds(CONFIG.options.smtpWaitSeconds);
    }
    LOG.info('Sending email "%s" to %s', e.email.subject, e.email.to);
    // Wait for the callback to run.
    const ok = await new Promise((resolve) => {
      transport.sendMail(e.email, (error, info) => {
        if (error) {
          LOG.error('Failed to send email: %s', error);
          if (!e.ignoreFailure) { // prevent infinite loop
            errors.push(JSON.stringify(error, null, 1));
          }
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
    // Do we need an extra item for an error message?
    if (i + 1 === INBOUND.length && errors.length) {
      LOG.error('%d out of %d email(s) could not be sent, will retry in next iteration',
          errors.length, INBOUND.length);
      // We send an email to report an error sending email. The hope is that the error is transient.
      INBOUND.push({
        email: em.buildEmailAdmin(
            'Emailversand fehlgeschlagen',
            {
              text: `${errors.length} von ${INBOUND.length} Email(s) konnte(n) nicht gesendet `
                + `werden.\n\nFehler:\n${errors.join(',\n')}\n\nWeitere Details im Logfile.`
            }),
        ok: () => {},
        ignoreFailure: true
      });
      errors = [];
    }
  }

  // Any message whose ok() handler didn't run was not added to our state and will simply be
  // recreated in the next iteration.
  INBOUND = [];
}

// ---------- Incoming email ----------

/** Create the ImapFlow client, configure its event handlers and open the mailbox. */
async function createImapClient() {
  IMAP_CLIENT = new ImapFlow(CONFIG.imap);
  // Check for new messages on open, and whenever the # of existing messages changes.
  IMAP_CLIENT
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
        // AFAICT the IMAP client has two common types of errors:
        // 1. The IDLE connection fails, commonly e.g. after an OS suspend/resume cycle (tested on
        //    Windows, presumably applies also to others).
        // 2. The main connection fails (not sure what common triggers are).
        // We address the first case by ImapFlow's maxIdleTime option (set on creation). The second
        // case can be detected by running an IMAP NOOP command. This is routinely done at the end
        // of each crawl iteration. We prepone that iteration here, in case the main loop is
        // currently waiting.
        awake();
      });
  await IMAP_CLIENT.connect();
  await IMAP_CLIENT.mailboxOpen('INBOX');
  LOG.info('Listening on IMAP mailbox')
  return IMAP_CLIENT;
}

/** 
 * Check the main IMAP connection by running a NOOP command, and log the result. Rethrows the
 * original error on failure.
 */
async function checkImapConnection() {
  if (IMAP_CLIENT) {
    try {
      await IMAP_CLIENT.noop(); // runs on the server
      LOG.debug('IMAP connection OK');
    } catch (e) {
      LOG.error('IMAP connection down'); // The outer (retry) loop will log the error details.
      throw e;
    }
  }
}

/** 
 * Try to logout() gracefully. In some conditions (e.g. when an operation is in progress) this won't
 * work and we can only close(). 
 */
async function disposeImapClient() {
  if (IMAP_CLIENT) {
    try {
      await IMAP_CLIENT.logout();
      LOG.debug('Logged out of IMAP server');
    } catch (e) {
      // ignored
      LOG.debug('Failed to log out of IMAP server');
    }
    try {
      IMAP_CLIENT.close();
      LOG.debug('Closed IMAP connection');
    } catch (e) {
      // ignored
      LOG.debug('Failed to close IMAP connection');
    }
    IMAP_CLIENT = null;
  }
}

/** This uses the "answered" flag, which is part of the IMAP standard, to mark messages done. */
async function processNewEmail() {
  // Collect messages not intended for forwarding to teachers. These are marked processed to hide
  // them in the next query. They only trigger a crawl. Key is IMAP sequence number, value is 1.
  const ignoredMessages = {};
  let numNewMessages = 0;
  
  for await (let message of IMAP_CLIENT.fetch({answered: false}, { source: true })) {
    ++numNewMessages;
    // This is removed if we found something to process, i.e. registered a success handler that
    // will mark the message processed.
    ignoredMessages[message.seq] = 1; 
    // If no incoming email address is set up, there is nothing to do except mark new messages.
    if (!CONFIG.options.incomingEmail.regEx) {
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
        .filter(value => value.address && value.address.match(CONFIG.options.incomingEmail.regEx));

    if (!recipients.length) {
      continue; // The message isn't intended for a teacher.
    }

    // Prevent (likely accidental) impersonation by allowing only known senders in the From:.
    let rejectedFrom = null;
    if (!parsedMessage.from || !parsedMessage.from.value.length) { // never allowed
      rejectedFrom = '';
    } else if (!CONFIG.options.incomingEmail.allowForwardingFrom.includes( // maybe not allowed
        // Assume just one element in the From: header, for simplicity.
        parsedMessage.from.value[0].address.toLowerCase())) { 
      rejectedFrom = parsedMessage.from.text;
    }
    if (rejectedFrom !== null) {
      LOG.warn(`Rejecting incoming email from "${rejectedFrom}"`);
      INBOUND.push({
        email: em.buildEmailAdmin(
            'Nachricht von fremdem Absender ignoriert',
            {
              text: `Nachricht von "${rejectedFrom}" an ` +
                  `${CONFIG.options.incomingEmail.forwardingAddress} wurde ignoriert.\n\n` +
                  'ACHTUNG: Diese Adresse sollte nicht veröffentlicht werden!'
            }),
        ok: () => {}
      });
      continue;
    }

    // For replies we get the teacher ID and thread ID from the In-Reply-To header, and we don't
    // need a subject. Other teachers may be among the recipients though, for these a new thread is
    // created.
    [_, replyTeacherId, replyThreadId] =
        parsedMessage.inReplyTo && parsedMessage.inReplyTo.startsWith('<thread-')
        ? parsedMessage.inReplyTo.split('-')
        : [0, -1, -1];

    for (const recipient of recipients) {
      const teacherId = recipient.address.match(CONFIG.options.incomingEmail.regEx)[1];
      if (!teacherId) { // This still allows testing with "0" because it's a string.
        LOG.warn('Failed to parse recipient "%s"', recipient.address);
        continue; // Should never happen because we filtered recipients to match the RegEx above.
      }

      // We now know that the message has payload. The prep handler below will mark it done.
      delete ignoredMessages[message.seq];

      const isReply = teacherId == replyTeacherId;
      // Empty subject or body are not accepted by the portal. Messages without subject don't even
      // have a "subject" field. Defensively, assume the same for the body even though I haven't
      // verified that.
      const subject = (parsedMessage.subject || '').trim() || '(kein Betreff)';
      const text = (parsedMessage.text || '').trim() || '(kein Text)';
      LOG.info(
        'Received %s teacher %d%s: "%s" (%d characters; ID %d)',
        isReply ? 'reply to' : 'email for', teacherId, 
        recipient.name ? ' (' + recipient.name + ')' : '',
        subject, text.length, message.seq);
      OUTBOUND.push({
        teacherId: teacherId,
        replyThreadId: isReply ? replyThreadId : undefined,
        subject: isReply ? undefined : subject,
        text: text,
        markDone: async () => markEmailDone(message.seq)
      });
    }
  }
  LOG.info('New incoming emails: %d', numNewMessages);

  if (Object.keys(ignoredMessages).length) {
    const seqs = Object.keys(ignoredMessages).join();
    await IMAP_CLIENT.messageFlagsAdd({seq: seqs}, ['\\Answered']);
    LOG.debug('Marked ignored emails: %s', seqs);
  }

  // For simplicity we awake unconditionally. We don't distinguish between new content notifications
  // and ignored messages, e.g. sick leave confirmation. An occasional false positive is OK.
  if (numNewMessages) {
    awake();
  }
}

async function markEmailDone(seq) {
  await IMAP_CLIENT.messageFlagsAdd({ seq: seq }, ['\\Answered']);
  LOG.debug('Marked processed email: %d', seq);
}

// ---------- Outgoing messages ----------

async function sendMessagesToTeachers(page) {
  LOG.info('Sending %d message(s) to teachers', OUTBOUND.length);
  // Sidenote: Curiously navigation will always succeed, even for nonexistent teacher IDs. What's
  // more, we can actually send messages that we can then retrieve by navigating to the URL
  // directly. This greatly simplifies testing :-)

  // For each message (part), sending may fail either in the "read" operation (navigating to the
  // form) or in the "write" operation (clicking the "send" button). For simplicity we don't
  // distinguish between the two. Also, we never retry the "write" operation to avoid the risk of
  // flooding a teacher with messages. This means that each message must be removed from the global
  // "outbound" variable after processing is complete. To guarantee this we make a local copy and
  // clear the global variable right away.
  const outboundTmp = OUTBOUND;
  OUTBOUND = [];

  for (const msg of outboundTmp) {
    // In case of multiple messages we prefix them with "[n/N] ". Assuming that n and N have at
    // most 2 characters, we simply substract 8 characters for every such prefix.
    // TODO: Extract magic 512? Is that maybe even configurable?
    const capacity = msg.text.length <= 512 ? 512 : (512 - 8);
    const numParts = Math.ceil(msg.text.length / capacity);
    let onReplyPage = false;
    
    try {
      for (let i = 0; i < numParts; i++) {
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
            
        const prefix = numParts == 1 ? '' : '[' + (i + 1) + '/' + numParts + '] ';
        const logInfix = numParts == 1 ? '' : ' part ' + (i + 1) + '/' + numParts;
        await page.type(
            '#nachricht_kom_fach', prefix + msg.text.substring(i * capacity, (i + 1) * capacity));

        // We mark the original email done before actually submitting the form to avoid duplicate 
        // messages in case of errors. Unfortunately one incoming email may map to multiple parts,
        // so we have to do it for the first part to be safe.
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
          if (numParts > 1 && !msg.replyThreadId) {
            msg.replyThreadId = await page.$eval(
              'a[href*="meldungen/kommunikation_fachlehrer/"',
              (a) => a.href.match(/.*\/([0-9]+)$/)[1]);
          }
        } else {
          throw '' + response.status() + ' ' + response.statusText();
        }
      }
    } catch (e) {
      LOG.error('Failed to send message to teacher %d: %s', msg.teacherId, e);
      INBOUND.push({
        email: em.buildEmailAdmin(
            'Nachrichtenversand fehlgeschlagen',
            {
              text: `Nachricht an Lehrer ${msg.teacherId} konnte nicht gesendet werden.\n\n`
                  + `Fehler:\n${JSON.stringify(e)}\n\nWeitere Details im Logfile.`
            }),
        ok: () => {}
      });
    }
  }
}

// ---------- Main ----------

async function processSchulmanager(page, state) {
  await sm.login(page);
  const letters = await sm.readLetters(page, state.sm.letters);
  sm.buildEmailsForLetters(letters, state.sm.letters);
}

async function processElternPortal(page, state) {
  await loginElternPortal(page);

  // Send messages to teachers. We later retrieve those messages when crawling threads below. That
  // is intentional because presumably the second parent wants a copy of the message.
  await sendMessagesToTeachers(page);

  // Section "Aktuelles".
  const announcements = await readAnnouncements(page); // Always reads all.
  await readAnnouncementsAttachments(page, announcements, state.ep.announcements);
  buildEmailsForAnnouncements(page, announcements, state.ep.announcements);

  // Section "Kommunikation Eltern/Klassenleitung".
  const inquiries = await readInquiries(page);
  buildEmailsForInquiries(inquiries, state.ep.inquiries);

  // Section "Kommunikation Eltern/Fachlehrer".
  const teachers = await readActiveTeachers(page);
  await readThreadsMeta(page, teachers, state.ep.lastSuccessfulRun);
  await readThreadsContents(page, teachers);
  await readThreadsAttachments(page, teachers, state.ep.threads);
  buildEmailsForThreads(teachers, state.ep.threads);

  // Section "Vertretungsplan"
  await readSubstitutions(page, state.ep.hashes);

  // Section "Schwarzes Brett"
  await readNoticeBoard(page, state.ep.hashes);

  // Section "Schulaufgaben / Weitere Termine"
  await readEvents(page, state.ep.events);
}

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
  CONFIG.imap.logger = IMAP_LOGGER; // standing orders
  CONFIG.imap.maxIdleTime ||= 60 * 1000; // 60s default
  lg.initialize();
  LOG.info(TITLE);

  // Ensure config file has been edited.
  if (!elternPortalConfigured() && !schulmanagerConfigured()) {
    LOG.error('Please edit the config file to specify your login credentials, SMTP server etc.');
    return 2;
  }

  CONFIG.options.checkIntervalMinutes = Math.max(CONFIG.options.checkIntervalMinutes, 10);
  processFlags(flags);
  createIncomingEmailRegExp();

  // Start IMAP listener, if enabled.
  if (CONFIG.options.incomingEmail.enabled) {
    try {
      IMAP_CLIENT = await createImapClient();
    } catch (e) {
      // Error details were already logged by our custom logger.
      // Check for some permanent errors upon which we should quit. This list may need to be
      // extended.
      if (e.authenticationFailed) {
        LOG.error('IMAP server rejected credentials');
        return 3;
      }
      if (e.code == 'ENOTFOUND') {
        LOG.error('IMAP server not found (will retry)');
        // This can be permanent (e.g. typo) or transient (e.g. just resumed from OS suspended state 
        // and network not yet up, or some other temporary network issue). We don't bother telling
        // these cases apart because the permanent case is rare and easily identified and fixed.
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
    BROWSER = await puppeteer.launch({headless: 'new'}); // prevent deprecation warning
    const page = await BROWSER.newPage();

    // If both EP and SM are active, we process them sequentially. We catch a potential exception
    // in SM and rethrow it after processing EP. A second exception in EP would take precedence.

    // ---------- Schulmanager ----------

    let schulmanagerException = null;
    let schulmanagerOk = () => {};
    if (schulmanagerConfigured()) {
      try {
        await processSchulmanager(page, state);
        // There is currently nothing to do in the OK handler; we still keep it as a placeholder.
      } catch (e) {
        schulmanagerException = e;
        LOG.error('Error for Schulmanager:\n%s', e.stack || e);
      }
    }

    // ---------- Eltern-Portal ----------

    let elternPortalOk = () => {};
    if (elternPortalConfigured()) {
      await processElternPortal(page, state);
      elternPortalOk = () => state.ep.lastSuccessfulRun = NOW;
    }

    // Send emails to user and update state, unless in test mode.
    if (CONFIG.options.test) {
      // Replace actual emails and don't update state.
      INBOUND = em.createTestEmail(INBOUND.length);
      await sendEmails();
    } else { // normal mode
      await sendEmails();
      schulmanagerOk();
      elternPortalOk();
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    }

    // Only close after OK handlers (both above and in the emails) have run.
    await BROWSER.close();

    if (schulmanagerException) {
      throw schulmanagerException;
    }

    if (CONFIG.options.once) {
      LOG.info('Terminating due to --once flag/option');
      if (IMAP_CLIENT) {
        await IMAP_CLIENT.logout();
      }
      return 0;
    }

    await checkImapConnection();
    // There is now a short time window for a race, where an error after the successful check above
    // would awake() the previous Promise before "awake" is updated to the new Promise below. This
    // seems very unlikely though, and would just delay the IMAP restart until we check again in the
    // next iteration.

    // Wait until timeout or email received. The email may or may not be a "new message" 
    // notification. We don't care and do the next crawl unconditionally.
    await new Promise((resolve) => {
      awake = function() {
        LOG.info('Awakening main loop');
        resolve();
      };
      // Only now can the IMAP receive event handler awake us. It could already have populated
      // "outbound" and notified the previous Promise while the main loop was busy, so check for 
      // that.
      if (OUTBOUND.length) {
        resolve();
      } else {
        LOG.debug('Waiting %d minutes until next check', CONFIG.options.checkIntervalMinutes);
        setTimeout(resolve, CONFIG.options.checkIntervalMinutes * 60 * 1000);
      }
    });
  }
};

(async () => {
  while (true) {
    try {
      const retval = await main();
      // Normal completion means we exit.

      // Flushing Winston's file stream on exit is nontrivial
      // (https://stackoverflow.com/questions/58933772). We go with the simple, readable, thoroughly
      // ridiculous hack of just waiting a few seconds. Terminating the program is a rare event, so
      // this seems acceptable.
      LOG.info('Exiting with code %d', retval);
      LOG.debug('Waiting 10s for log to flush (sic)...');
      await sleepSeconds(10);
      exit(retval);
    } catch (e) {
      LOG.error('Error in main loop:\n%s', e.stack || e);
    }

    // The main loop threw an exception. Rerun with exponential backoff. This addresses transient
    // errors, e.g. IMAP connection issues or crawl timeouts. Permanent errors, e.g. page layout
    // changes that break the crawling code, lead to retries every MAX_RETRY_WAIT_SECONDS, which
    // should be high enough for this to not be a problem. Note that we prevent duplicate messages
    // to teachers via persistent IMAP message flags, but do not take special precautions against
    // duplicate emails to parents. The latter case seems rather unlikely and much less serious.

    await disposeImapClient();

    const nowEpochMillis = Date.now();
    const secondsSinceLastFailure = (nowEpochMillis - LAST_FAILURE_EPOCH_MILLIS) / 1000;
    LOG.debug('Last failure was %d seconds ago', secondsSinceLastFailure);
    if (secondsSinceLastFailure > BACKOFF_TRIGGER_SECONDS) { // reset wait time
      RETRY_WAIT_SECONDS = DEFAULT_RETRY_WAIT_SECONDS;
    } else { // exponential backoff
      RETRY_WAIT_SECONDS =  Math.min(RETRY_WAIT_SECONDS * 2, MAX_RETRY_WAIT_SECONDS); 
    }
    LAST_FAILURE_EPOCH_MILLIS = nowEpochMillis;
    LOG.info('Waiting %d seconds before retry', RETRY_WAIT_SECONDS);
    await sleepSeconds(RETRY_WAIT_SECONDS);
    LOG.debug('Waiting completed');
  }
})();
