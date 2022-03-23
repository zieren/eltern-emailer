/* global Buffer, Promise, process */

const TITLE = 'Eltern-Emailer 0.0.3 (c) 2022 Jörg Zieren, GNU GPL v3.'
    + ' See https://github.com/zieren/eltern-emailer for component license info';

const contentDisposition = require('content-disposition');
const https = require('https');
const fs = require('fs');
const md5 = require("md5");
const nodemailer = require('nodemailer');
const puppeteer = require('puppeteer');
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

// Initialized in main() after parsing CLI flags.
let CONFIG = {}, LOG = null;

/**
 * List of already processed (i.e. emailed) items. Contains the following keys:
 * - 'announcements': Announcements in "Aktuelles".
 * - 'threads': Threads in "Kommunikation Eltern/Fachlehrer".
 * - 'inquiries': Inquiries in "Kommunikation Eltern/Klassenleitung".
 * - 'hashes': Other content, e.g. "Vertretungsplan"
 */
const STATE_FILE = 'state.json';

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
  CONFIG.options.mute = flags.mute !== undefined ? flags.mute : CONFIG.options.mute;
  CONFIG.options.once = flags.once !== undefined ? flags.once : CONFIG.options.once;
  CONFIG.options.test = flags.test !== undefined ? flags.test : CONFIG.options.test;
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

async function sleepSeconds(seconds) {
  await new Promise(f => setTimeout(f, seconds * 1000));
}

// ---------- Login ----------

/** This function does the thing. The login thing. You know? */
async function login(page) {
  await page.goto(CONFIG.elternportal.url);
  await page.type('#inputEmail', CONFIG.elternportal.user);
  await page.type('#inputPassword', CONFIG.elternportal.pass);
  await page.click('#inputPassword ~ button');
  await page.waitForNavigation();
  const success = (await page.$$eval('a[href*="einstellungen"]', (x) => x)).length > 0;
  if (!success) {
    throw 'Login failed';
  }
  LOG.info('Login OK');
}

async function getPhpSessionIdAsCookie(page) {
  const cookies = await page.cookies();
  const id = cookies.filter(c => c.name === "PHPSESSID");
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
          resolve(null);
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
    // TODO: This caused duplicates for new messages. See if :first-child fixes this, and
    // update this comment.
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
          'Read %d messages in "%s" with %s', thread.messages.length, thread.subject, teacher.name);
    }
  }
}

function buildEmailsForThreads(teachers, processedThreads, emails) {
  for (const teacher of teachers) {
    for (const thread of teacher.threads) {
      // If messages can ever be deleted, we'd need to hash because n could remain constant or even
      // decrease when messages disappear.
      if (!(thread.id in processedThreads)) {
        processedThreads[thread.id] = {};
      }
      // Messages are in reverse chronological order, so process backwards to send in forward
      // chronological order.
      for (let i = thread.messages.length - 1; i >= 0 ; --i) {
        if (!(i in processedThreads[thread.id])) {
          const email = buildEmail(thread.messages[i].author, thread.subject, {
            // TODO: Consider enriching this, see TODO for other messageId. (#4)
            messageId: buildMessageId('thread-' + i),
            text: thread.messages[i].body
          });
          if (i > 0) {
            email.references = [buildMessageId('thread-' + (i - 1))];
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
    from: '"EP - ' + fromName.replace(/["\n]/g, '') + '" <' + CONFIG.options.emailFrom + '>',
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

// ---------- Main ----------

async function main() {
  const parser = await import('args-and-flags').then(aaf => {
    return new aaf.default(CLI_OPTIONS);
  });
  const {_, flags} = parser.parse(process.argv.slice(2));

  CONFIG = JSON.parse(fs.readFileSync(flags.config, 'utf-8'));
  CONFIG.options.checkIntervalMinutes = Math.max(CONFIG.options.checkIntervalMinutes, 10);
  processFlags(flags);
  LOG = createLogger();
  LOG.info(TITLE);

  try {
    // Ensure config file has been edited.
    if (CONFIG.elternportal.url.startsWith('https://SCHOOL.')) {
      throw 'Please edit the config file to specify your login credentials, SMTP server etc.';
    }

    while (true) {
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
        break;
      }
      LOG.debug('Waiting %d minutes until next check', CONFIG.options.checkIntervalMinutes);
      await sleepSeconds(CONFIG.options.checkIntervalMinutes * 60);
    }
  } catch (e) {
    LOG.error(e);
    LOG.error('Exiting due to previous error');
    throw e; // TODO: Figure out how to exit cleanly.
  }
};

main();
