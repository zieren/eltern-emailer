/* global Buffer, Promise, process */

// TODO: "letters" -> "announcements"? "news"?

const contentDisposition = require('content-disposition');
const https = require('https');
const fs = require('fs');
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
    }
  ]
};

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
  await page.goto(CONFIG.epLogin.url);
  await page.type('#inputEmail', CONFIG.epLogin.email);
  await page.type('#inputPassword', CONFIG.epLogin.password);
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

/** Reads all letters, but not possible attachments. */
async function readLetters(page) {
  await page.goto(CONFIG.epLogin.url + '/aktuelles/elternbriefe');
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
          LOG.info('Read attachment (%d bytes) for: %s', letter.content.length, letter.subject);
          resolve(null);
        });
      }).on('error', (e) => {
        reject(e);
      });
    });
  }
}

function buildEmailsForLetters(letters, processedLetters) {
  return letters
      .filter(letter => !(letter.id in processedLetters))
      // Send oldest letters first, i.e. maintain chronological order. This is not reliable because
      // emails race, but GMail ignores the carefully forged message creation date (it shows the
      // reception date instead), so it's the best we can do.
      .reverse()
      .map(letter => {
        const email = {
          from: buildFrom('Aktuelles'),
          to: CONFIG.smtp.to,
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
      });
}

/** Returns a list of teachers with at least one thread. */
async function readActiveTeachers(page) {
  await page.goto(CONFIG.epLogin.url + '/meldungen/kommunikation_fachlehrer');
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
            to: CONFIG.smtp.to,
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

function buildFrom(name) {
  return '"EP - ' + name.replace('"', '') + '" <' + CONFIG.smtp.from + '>';
}

function buildMessageId(threadId, i) {
  return threadId + '.' + i + '.eltern-emailer@' + CONFIG.smtp.from.replace(/.*@/, '');
}

async function sleepSeconds(seconds) {
  await new Promise(f => setTimeout(f, seconds * 1000));
}

async function sendEmails(emails) {
  LOG.info('Sending %d emails', emails.length);
  if (!emails.length) {
    return;
  }
  // TODO: Expose more mail server config.
  const transport = nodemailer.createTransport({
    host: CONFIG.smtp.server,
    port: 465,
    secure: true,
    auth: {
      user: CONFIG.smtp.username,
      pass: CONFIG.smtp.password
    }
  });
  let first = true;
  for (const e of emails) {
    if (CONFIG.options.dontSendEmail) {
      LOG.info('Not sending email "%s"', e.email.subject);
      e.ok();
      continue;
    }
    // Throttle outgoing emails.
    if (!first) {
      await sleepSeconds(CONFIG.smtp.waitSeconds);
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

// ----- Kommunikation Eltern/Fachlehrer -----

async function getPhpSessionIdAsCookie(page) {
  const cookies = await page.cookies();
  const id = cookies.filter(c => c.name === "PHPSESSID");
  if (id.length !== 1) {
    throw 'Failed to extract PHPSESSID';
  }
  return id[0].name + '=' + id[0].value;
}

async function main() {
  const parser = await import('args-and-flags').then(aaf => {
    return new aaf.default(CLI_OPTIONS);
  });
  const { args, flags } = parser.parse(process.argv.slice(2));

  // Read config.
  CONFIG = JSON.parse(fs.readFileSync(flags.config, 'utf-8'));
  if (CONFIG.epLogin.url.startsWith('https://SCHOOL.')) {
    throw 'Please edit the config file to specify your login credentials, SMTP server etc.';
  }

  // Set up logging.
  LOG = winston.createLogger({
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

  while (true) {
    try {
      const state = fs.existsSync(STATE_FILE)
          ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'))
          : {threads: {}, letters: {}};
      LOG.debug('Read state: %d threads, %d letters',
          Object.keys(state.threads).length, Object.keys(state.letters).length);
      const browser = await puppeteer.launch();
      const page = await browser.newPage();

      await login(page);

      // Section "Aktuelles".
      const letters = await readLetters(page); // Always reads all.
      await readAttachments(page, letters, state.letters);
      const emails = buildEmailsForLetters(letters, state.letters);

      // Section "Kommunikation Eltern/Fachlehrer".
      const teachers = await readActiveTeachers(page);
      await readThreadsMeta(page, teachers);
      await readThreadsContents(page, teachers);
      buildEmailsForThreads(teachers, state.threads, emails);

      await sendEmails(emails);

      await browser.close();
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (e) {
      LOG.error('Exiting: %s', e);
      throw e; // TODO: Figure out how to exit cleanly.
    }
    LOG.debug('Waiting %d minutes until next check', CONFIG.options.pollingIntervalMinutes);
    await sleepSeconds(CONFIG.options.pollingIntervalMinutes * 60);
  }
};

main();
