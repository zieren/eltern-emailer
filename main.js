global.USER_AGENT = 'Eltern-Emailer 0.9.0'
const LOG_STARTUP_MESSAGE = `${USER_AGENT} (c) 2022-2024 Jörg Zieren, GNU GPL v3.`
    + ' See https://zieren.de/software/eltern-emailer for component license info';

const fs = require('fs-extra');
const http = require('http');
const { ImapFlow } = require('imapflow');
const nodemailer = require('nodemailer');
const puppeteer = require('puppeteer');

// ---------- Shared state ----------

// Provide global LOG (initialized below).
const logging = require('./logging.js');

// Browser instance is shared across eltern-portal.org and schulmanager-online.de.
global.BROWSER = null;
// Initialized in main() after parsing CLI flags.
global.CONFIG = {};
// Inbound messages are intended for the user(s). They are generated from scraping the portal(s) and
// emailed to the user(s) via SMTP.
global.INBOUND = [];
// The ~current time (epoch millis). Updated at the start of each main loop iteration.
global.NOW = Date.now(); // init to actual now() because we need it for other initializations
// The IMAP client. Initialized in main().
global.IMAP_CLIENT = null;

// ---------- Something like encapsulation ----------

// Maybe I should have used classes, but it seems that it doesn't really matter much.
const em = require('./email.js')
const ep = require('./elternportal.js');
const sm = require('./schulmanager.js');

// ---------- Constants ----------

const CLI_OPTIONS = {
  args: [],
  flags: [
    { name: 'config', type: 'string', default: 'config.json' },
    // List of already processed (i.e. emailed) items. See EMPTY_STATE for content description.
    { name: 'state', type: 'string', default: 'state.json' },
    { name: 'no_sandbox', type: 'boolean' },
    { name: 'ep_password', type: 'string' },
    { name: 'sm_password', type: 'string' },
    { name: 'smtp_password', type: 'string' },
    { name: 'imap_password', type: 'string' },
    { name: 'mute', type: 'boolean' },
    { name: 'once', type: 'boolean' },
    { name: 'test', type: 'boolean' }
  ]
};

// State is global so that the status web server can access lastSuccessfulRun.
let STATE = {};

// This is OR-ed with what we read from state.json so keys etc. exist.
const EMPTY_STATE = {
  ep: ep.EMPTY_STATE,
  sm: sm.EMPTY_STATE,
  // Last successful run (epoch millis). This is conservative because it's actually the beginning of
  // the scraping iteration. With a safety margin (to account for clock skew, server time
  // inaccuracy, cache staleness etc.) it is used to improve performance by skipping old data. It is
  // also exported and consumed by the (optional) monitor.ahk tool to alert on persistent failure.
  lastSuccessfulRun: 0
};

// Forward IMAP logging to our own logger.
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

// ---------- Synchronization ----------

// May be called from event handlers (IMAP, SIGTERM) before the main loop builds the wait Promise.
let awake = () => {};

// Set when SIGTERM is received. Causes a graceful shutdown.
let SIGTERM_RECEIVED = false;

process.on('SIGTERM', () => {
  SIGTERM_RECEIVED = true;
  if (LOG) {
    LOG.warn('Received SIGTERM, shutting down...');
  }
  awake();
});

// ---------- Status server ----------

// Can be used to monitor the application.
let STATUS_SERVER = null;

// ---------- Initialization functions ----------

async function maybeStartStatusServer() {
  if (STATUS_SERVER) return;
  STATUS_SERVER = http.createServer((_, res) => {
    res.setHeader('Content-Type', 'text/plain');
    res.write(`${STATE.lastSuccessfulRun}`);
    res.end();
  });
  STATUS_SERVER.listen(CONFIG.options.statusServerPort, () => {
    LOG.info(`Status server listening on port ${CONFIG.options.statusServerPort}`);
  });
}

function readConfigFile(flags) {
  CONFIG = JSON.parse(fs.readFileSync(flags.config, 'utf-8'));
  processFlags(flags);
  CONFIG.imap.logger = IMAP_LOGGER; // standing orders
  CONFIG.imap.maxIdleTime ||= 60 * 1000; // 60s default
  CONFIG.options.checkIntervalMinutes = Math.max(CONFIG.options.checkIntervalMinutes, 10);
  createIncomingEmailRegExp();
}

function readState(flags) {
  STATE = fs.existsSync(flags.state) ? JSON.parse(fs.readFileSync(flags.state, 'utf-8')) : {};
  setEmptyState(STATE, EMPTY_STATE);
  LOG.debug('Read state');
}

function setEmptyState(state, emptyState) {
  for (const [key, value] of Object.entries(emptyState)) {
    state[key] ||= value;
    setEmptyState(state[key], value); // Recurse for objects.
  }
}

function processFlags(flags) {
  // Flags override values in config file.
  if (elternPortalConfigured()) { // section may be absent
    CONFIG.elternportal.pass = flags.ep_password || CONFIG.elternportal.pass;
  }
  if (schulmanagerConfigured()) { // section may be absent
    CONFIG.schulmanager.pass = flags.sm_password || CONFIG.schulmanager.pass;
  }
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

async function gracefulExit(retval) {
  await disposeImapClient();
  LOG.info('Exiting with code %d', retval);
  // Flushing Winston's file stream is nontrivial (https://stackoverflow.com/questions/58933772). We
  // go with the simple, readable, thoroughly ridiculous hack of just waiting a few seconds.
  // Terminating the program is a rare event, so this seems acceptable.
  LOG.debug('Waiting 5s for log to flush (sic)...');
  await sleepSeconds(5);
  process.exit(retval);
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
    const recipients = e.email.to ? e.email.to : e.email.bcc;
    if (CONFIG.options.mute || !recipients.length) {
      LOG.info('Skipping email "%s" to %s', e.email.subject, recipients);
      await e.ok();
      continue;
    }
    // Throttle outgoing emails.
    if (i > 0) {
      LOG.info('Waiting %d seconds between messages', CONFIG.options.smtpWaitSeconds);
      await sleepSeconds(CONFIG.options.smtpWaitSeconds);
    }
    LOG.info('Sending email "%s" to %s', e.email.subject, recipients);
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
        if (await ep.processNewEmail()) {
          awake();
        }
      })
      .on('exists', async (data) => {
        LOG.info('Received new message(s): %s', JSON.stringify(data));
        if (await ep.processNewEmail()) {
          awake();
        }
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
        // case can be detected by running an IMAP NOOP command. This is routinely done at the start
        // of each scraping iteration. We prepone that iteration here, in case the main loop is
        // currently waiting.
        awake();
      });
  await IMAP_CLIENT.connect();
  await IMAP_CLIENT.mailboxOpen('INBOX');
  LOG.info('Listening on IMAP mailbox')
  return IMAP_CLIENT;
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

// ---------- Main ----------

async function tryProcess(process, page) {
  try {
    await process(page, STATE);
    return true;
  } catch (e) {
    LOG.error(`Error in ${process.name}:\n${e.stack || e}`);
    return false;
  }
}

async function maybeStartOrCheckImap() {
  if (!CONFIG.options.incomingEmail.enabled) {
    return true;
  }
  if (!IMAP_CLIENT) {
    try {
      IMAP_CLIENT = await createImapClient();
    } catch (e) {
      // Error details were already logged by our custom logger. This would be the place to bail out
      // on a permanent error, but so far all errors can also be transient, so we never do bail out.
      if (e.authenticationFailed) {
        LOG.error('IMAP server rejected credentials. This may actually be transient; will retry');
        // My server sometimes returns an auth failure with the message "User is authenticated but
        // not connected.", despite correct credentials.
      } else if (e.code == 'ENOTFOUND') {
        LOG.error('IMAP server not found; will retry');
        // This can be permanent (e.g. typo) or transient (e.g. just resumed from OS suspended state 
        // and network not yet up, or some other temporary network issue). We don't bother telling
        // these cases apart because the permanent case is rare and easily identified and fixed.
      } else {
        // Occasionally we get "some other error" (hooray for implicit typing...). We assume here
        // that all errors at this point are transient and will retry with exponential backoff.
        LOG.error('Other IMAP error; will retry')
      }
      IMAP_CLIENT = null; // retry in next iteration
    }
  } else {
    try {
      await IMAP_CLIENT.noop(); // runs on the server
      LOG.debug('IMAP connection OK');
    } catch (e) {
      LOG.error(`IMAP connection down:\n${(e && e.stack) || e}`);
      IMAP_CLIENT = null; // retry in next iteration
    }
  }
  // At least my IMAP server is too flaky to report an error here.
  return IMAP_CLIENT != null;
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

  readConfigFile(flags);
  logging.initialize(); // as early as possible
  LOG.info(LOG_STARTUP_MESSAGE);

  await maybeStartStatusServer();

  // This is just a best effort check in case the user completely forgot to edit the file. We don't
  // repeat it when we reread the file in the main loop.
  if (!elternPortalConfigured() && !schulmanagerConfigured()) {
    LOG.error('Please edit the config file to specify your login credentials, SMTP server etc.');
    return 2;
  }

  while (true) {
    if (SIGTERM_RECEIVED) {
      return 0;
    }
    
    readState(flags);

    // Launch Puppeteer. On the Raspberry Pi the browser executable is typically named
    // "chromium-browser", which must be specified. Other Linux systems may use "chromium".
    const puppeteerOptions = {headless: 'new'}; // prevent deprecation warning
    if (CONFIG.options.customBrowserExecutable) {
      puppeteerOptions.executablePath = CONFIG.options.customBrowserExecutable;
    }
    if (flags.no_sandbox) {
      puppeteerOptions.args = ['--no-sandbox'];
    }
    BROWSER = await puppeteer.launch(puppeteerOptions);
    const page = await BROWSER.newPage();

    NOW = Date.now();

    // TODO: Warn user about "longer" issues (#65).

    // IMAP occasionally fails (for me), so we check the connection in each iteration.
    await maybeStartOrCheckImap();
    // Process both EP and SM. If one fails we still want to send emails generated by the other.
    const epOK = elternPortalConfigured() ? await tryProcess(ep.processElternPortal, page) : true;
    const smOK = schulmanagerConfigured() ? await tryProcess(sm.processSchulmanager, page) : true;

    // We can now have a race: Consider the time it takes until we update "awake" to point to the
    // new "resolve" in the below Promise that waits for the next iteration. This time is probably
    // mostly spent in sendEmails(). If during this time new content appears that we didn't cover
    // just now, *and* the notification email is also received during this time, then our IMAP
    // listener will call "awake" for the previous (already resolved) Promise. This case seems too
    // unlikely (and too benign) to spend any code complexity on.

    const success = epOK && smOK;
    if (CONFIG.options.test) {
      INBOUND = em.createTestEmail(INBOUND.length, success); // Replace with exactly one test email.
    }
    await sendEmails();
    if (!CONFIG.options.test) {
      if (success) {
        // If we have an error on one site, this may sacrifice performance on the other by not
        // advancing lastSuccessfulRun. The alternative of keeping track of this per site doesn't
        // seem worth it; we'd be optimizing for a rare error case (persistent failure) that needs
        // to be resolved anyway.
        STATE.lastSuccessfulRun = NOW;
      }
      fs.writeFileSync(flags.state, JSON.stringify(STATE, null, 2));
    }

    // Only close after OK handlers in the emails have run. Also wait for state to be persisted; if
    // there is a Puppeteer error at this stage it shouldn't prevent that.
    await BROWSER.close();

    if (CONFIG.options.once) {
      LOG.info('Terminating due to --once flag/option');
      if (IMAP_CLIENT) {
        await disposeImapClient();
      }
      return 0;
    }

    // Wait until timeout or email received. The email may or may not be a "new message" 
    // notification. We don't care and do the next iteration unconditionally.
    await new Promise((resolve) => {
      awake = function() {
        LOG.info('Awakening main loop');
        resolve();
      };
      // Only now can the IMAP receive event handler awake us. It could already have populated its
      // OUTBOUND and notified the previous Promise while the main loop was busy, so check for that.
      if (ep.haveOutbound()) {
        resolve();
      } else {
        LOG.debug(`Waiting ${CONFIG.options.checkIntervalMinutes} minutes until next check`);
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
      await gracefulExit(retval);
    } catch (e) {
      // It seems that Puppeteer also receives SIGTERM and terminates, causing exceptions in running
      // operations. So we may end up here instead of above.
      if (SIGTERM_RECEIVED) {
        await gracefulExit(0);
      }
      LOG.error('Error in main loop:\n%s', (e && e.stack) || e);
    }
    // At this point we have an error in the "surrounding" code, e.g. sending emails, writing the
    // state file, launching Puppeteer. Of all these, only sending emails is relevant for how long
    // we should wait before a retry; the rest is just local code. We simply use the configured wait
    // interval between sending messages, which should ensure that we're never throttled.
    LOG.info(`Waiting ${CONFIG.options.smtpWaitSeconds} seconds (SMTP wait time) before retry`);
    await sleepSeconds(CONFIG.options.smtpWaitSeconds);
  }
})();
