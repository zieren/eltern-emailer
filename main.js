/* global Buffer, Promise, process */

// TODO: "letters" -> "announcements"? "news"?
// TODO: "prophecies" -> "bossThreads"?

const TITLE = 'Eltern-Emailer 0.0.2+ (c) 2022 Jörg Zieren, GNU GPL v3.'
    + ' See https://github.com/zieren/eltern-emailer for component license info';

const contentDisposition = require('content-disposition');
const https = require('https');
const fs = require('fs');
const md5 = require("md5");
const nodemailer = require('nodemailer');
const puppeteer = require('puppeteer');
const winston = require('winston');

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
    }
  ]
};

const EMPTY_STATE = {threads: {}, letters: {}, prophecies: {}, hashes: {subs: ''}};
const PROPHECY_AUTHOR = ['Eltern', 'Klassenleitung', 'UNKNOWN'];

// Initialized in main() after parsing CLI flags.
let CONFIG = {};
let LOG = null;

/**
 * List of already processed (i.e. emailed) items. Contains the following keys:
 * - 'letters': Letters in "Aktuelles".
 * - 'threads': Threads in "Kommunikation Eltern/Fachlehrer".
 */
const STATE_FILE = 'state.json';

/** This function does the thing. The login thing. You know? */
async function login(page) {
  await page.goto(CONFIG.elternportal.url);
  await page.type('#inputEmail', CONFIG.elternportal.user);
  await page.type('#inputPassword', CONFIG.elternportal.pass);
  await Promise.all([
    page.click('#inputPassword ~ button'),
    page.waitForNavigation()
  ]);
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

function buildFrom(name) {
  return '"EP - ' + name.replace('"', '') + '" <' + CONFIG.options.emailFrom + '>';
}

function buildMessageId(threadId, i) {
  return threadId + '.' + i + '.eltern-emailer@' + CONFIG.options.emailFrom.replace(/.*@/, '');
}

async function sleepSeconds(seconds) {
  await new Promise(f => setTimeout(f, seconds * 1000));
}

/** Reads all letters, but not possible attachments. */
async function readLetters(page) {
  await page.goto(CONFIG.elternportal.url + '/aktuelles/elternbriefe');
  const letters = await page.$$eval(
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
  LOG.info('Found %d letters', letters.length);
  return letters;
}

/**
 * Reads attachments for all letters not included in processedLetters. Attachments are stored in
 * memory.
 */
async function readAttachments(page, letters, processedLetters) {
  const options = {headers: {'Cookie': await getPhpSessionIdAsCookie(page)}};
  for (const letter of letters) {
    if (letter.id in processedLetters || !letter.url) {
      continue;
    }
    // Collect buffers and use Buffer.concat() to avoid messing with chunk size arithmetics.
    let buffers = [];
    // It seems attachment downloads don't need to be throttled.
    await new Promise((resolve, reject) => {
      https.get(letter.url, options, (response) => {
        letter.filename =
            contentDisposition.parse(response.headers['content-disposition']).parameters.filename;
        response.on('data', (buffer) => {
          buffers.push(buffer);
        }).on('end', () => {
          letter.content = Buffer.concat(buffers);
          LOG.info('Read attachment (%d kb) for: %s', letter.content.length >> 10, letter.subject);
          resolve(null);
        });
      }).on('error', (e) => {
        reject(e);
      });
    });
  }
}

function buildEmailsForLetters(letters, processedLetters, emails) {
  letters
      .filter(letter => !(letter.id in processedLetters))
      // Send oldest letters first, i.e. maintain chronological order. This is not reliable because
      // emails race, but GMail ignores the carefully forged message creation date (it shows the
      // reception date instead), so it's the best we can do.
      .reverse()
      .map(letter => {
        const email = {
          from: buildFrom('Aktuelles'),
          to: CONFIG.options.emailTo,
          subject: letter.subject,
          text: letter.body,
          date: new Date(letter.dateString)
        };
        if (letter.content) {
          email.attachments = [
            {
              filename: letter.filename,
              content: letter.content
            }
          ];
        }
        return {
          email: email,
          ok: () => { processedLetters[letter.id] = 1; }
        };
      }).forEach(e => emails.push(e));
}

/** Returns a list of teachers with at least one thread. */
async function readActiveTeachers(page) {
  await page.goto(CONFIG.elternportal.url + '/meldungen/kommunikation_fachlehrer');
  const teachers = await page.$$eval(
    'td:nth-child(3) a[href*="meldungen/kommunikation_fachlehrer/"]',
    (anchors) => anchors.map(
      (a) => {
        return {
          id: a.href.match(/.*\/([0-9]+)\//)[1],
          url: a.href,
          name: a.parentElement.parentElement.firstChild.textContent
        };
      }));
  LOG.info('Found %d threads', teachers.length);
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
          const email = {
            from: buildFrom(thread.messages[i].author),
            to: CONFIG.options.emailTo,
            // TODO: Consider enriching this, see TODO for other messageId. (#4)
            messageId: buildMessageId(thread.id, i),
            subject: thread.subject,
            text: thread.messages[i].body
          };
          if (i > 0) {
            email.references = [buildMessageId(thread.id, i - 1)];
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

/** Reads messages to/from "Klassenleitung". */
async function readProphecies(page) {
  await page.goto(CONFIG.elternportal.url + '/meldungen/kommunikation');
  const prophecies = await page.$$eval(
    'h3.panel-title', (headings) => headings.map((h) => {
      return {
        subject: h.textContent.trim().replace(/\(Beantwortet\) (?=\d\d\.\d\d\.\d\d\d\d)/, '')
      };
    }));
  for (let i = 0; i < prophecies.length; ++i) {
    prophecies[i].messages = await page.$eval('div#bear_' + i,
        (div) => Array.from(div.firstElementChild.childNodes)
            .filter(c => c.nodeName === '#text')
            .map(c => c.textContent));
  }
  LOG.info('Found %d prophecies', prophecies.length);
  // Order is reverse chronological, make it forward.
  return prophecies.reverse();
}

function buildEmailsForProphecies(prophecies, processedProphecies, emails) {
  for (const [i, prophecy] of Object.entries(prophecies)) {
    if (!(i in processedProphecies)) {
      // This indicates the next index to process.
      processedProphecies[i] = 0;
    }
    for (let j = processedProphecies[i]; j < prophecy.messages.length; ++j) {
      const email = {
        // AFAICT each thread has at most two messages.
        from: buildFrom(PROPHECY_AUTHOR[Math.min(j, 2)]),
        to: CONFIG.options.emailTo,
        // TODO: Consider enriching this, see TODO for other messageId (#4).
        messageId: buildMessageId('prophecy.' + i, j), // TODO: Unhack.
        // TODO: ^^ What if these are cleared after the school year, and indexes start at 0 again?
        // Maybe include a hash of the subject, or the date, to avoid collisions.
        subject: prophecy.subject,
        text: prophecy.messages[j]
      };
      if (j > 0) {
        email.references = [buildMessageId('prophecy.' + i, j - 1)];
      }
      emails.push({
        // We don't forge the date here because time of day is not available.
        email: email,
        ok: () => { processedProphecies[i] = j + 1; }
        // TODO: This relies on execution order. Fix it to match handling of threads.
      });
    }
  }
}

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
      e.ok();
      continue;
    }
    // Throttle outgoing emails.
    if (!first) {
      await sleepSeconds(CONFIG.options.smtpWaitSeconds);
    }
    first = false;
    LOG.info('Sending email "%s"', e.email.subject);
    await new Promise((resolve, reject) => {
      transport.sendMail(e.email, (error, info) => {
        if (error) {
          reject(error);
        } else {
          LOG.debug('Email sent (%s)', info.response);
          e.ok();
          resolve(null);
        }
      });
    });
  }
}

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
  const email = {
    from: buildFrom('Vertretungsplan'),
    to: CONFIG.options.emailTo,
    subject: 'Vertretungsplan',
    html: modifiedHTML
  };
  emails.push({
    email: email,
    ok: () => { previousHashes.subs = hash; }
  });
  LOG.info('Found substitution plan update');
}

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

function createTestEmail(numEmails) {
  return {
    email: {
      from: buildFrom('TEST'),
      to: CONFIG.options.emailTo,
      subject: 'TEST',
      text: 'The test run was successful. ' + numEmails + ' email(s) would have been sent.'
    },
    ok: () => {}
  };
}

async function main() {
  const parser = await import('args-and-flags').then(aaf => {
    return new aaf.default(CLI_OPTIONS);
  });
  const {_, flags} = parser.parse(process.argv.slice(2));

  CONFIG = JSON.parse(fs.readFileSync(flags.config, 'utf-8'));
  processFlags(flags);
  LOG = createLogger();
  LOG.info(TITLE);

  try {
    // Ensure config file has been edited.
    if (CONFIG.elternportal.url.startsWith('https://SCHOOL.')) {
      throw 'Please edit the config file to specify your login credentials, SMTP server etc.';
    }

    while (true) {
      const state = readState();
      LOG.debug('Read state: %d letters, %d threads, %d prophecies, hashes=%s',
          Object.keys(state.threads).length,
          Object.keys(state.letters).length,
          Object.keys(state.prophecies).length,
          JSON.stringify(state.hashes));
      const browser = await puppeteer.launch();
      const page = await browser.newPage();

      await login(page);
      const emails = [];

      // Section "Aktuelles".
      const letters = await readLetters(page); // Always reads all.
      await readAttachments(page, letters, state.letters);
      buildEmailsForLetters(letters, state.letters, emails);

      // Section "Kommunikation Eltern/Klassenleitung".
      const prophecies = await readProphecies(page);
      buildEmailsForProphecies(prophecies, state.prophecies, emails);

      // Section "Kommunikation Eltern/Fachlehrer".
      const teachers = await readActiveTeachers(page);
      await readThreadsMeta(page, teachers);
      await readThreadsContents(page, teachers);
      buildEmailsForThreads(teachers, state.threads, emails);

      // Section "Vertretungsplan"
      await readSubstitutions(page, state.hashes, emails);

      await browser.close();

      if (CONFIG.options.test) {
        await sendEmails([createTestEmail(emails.length)]);
        // Don't update state.
      } else {
        await sendEmails(emails);
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
      }

      if (CONFIG.options.once) {
        break;
      }
      LOG.debug('Waiting %d minutes until next check', CONFIG.options.pollingIntervalMinutes);
      await sleepSeconds(CONFIG.options.pollingIntervalMinutes * 60);
    }
  } catch (e) {
    LOG.error(e);
    LOG.error('Exiting due to previous error');
    throw e; // TODO: Figure out how to exit cleanly.
  }
};

main();
