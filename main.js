const TITLE = 'Eltern-Emailer 0.7.1 (c) 2022-2023 Jörg Zieren, GNU GPL v3.'
    + ' See https://zieren.de/software/eltern-emailer for component license info';

const { exit } = require('process');
const fs = require('fs-extra');
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
// Inbound messages are intended for the user(s). They are generated from crawling the portal(s) and
// emailed to the user(s) via SMTP.
global.INBOUND = [];
// The ~current time (epoch millis). Set at the start of each main loop iteration.
global.NOW = null;

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
    { name: 'ep_password', type: 'string' },
    { name: 'sm_password', type: 'string' },
    { name: 'smtp_password', type: 'string' },
    { name: 'imap_password', type: 'string' },
    { name: 'mute', type: 'boolean' },
    { name: 'once', type: 'boolean' },
    { name: 'test', type: 'boolean' }
  ]
};

// List of already processed (i.e. emailed) items. See EMPTY_STATE for content description.
const STATE_FILE = 'state.json';

// This is OR-ed with what we read from state.json so keys etc. exist.
const EMPTY_STATE = {
  ep: ep.EMPTY_STATE,
  sm: sm.EMPTY_STATE
};

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

/** The IMAP client. */
let IMAP_CLIENT = null;
/** Synchronization between IMAP event listener and main loop. */
let awake = () => {}; // Event handler may fire before the main loop builds the wait Promise.
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
  CONFIG.imap.logger = IMAP_LOGGER; // standing orders
  CONFIG.imap.maxIdleTime ||= 60 * 1000; // 60s default
  logging.initialize();
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
        await sm.processSchulmanager(page, state);
        // There is currently nothing to do in the OK handler; we still keep it as a placeholder.
      } catch (e) {
        schulmanagerException = e;
        LOG.error('Error for Schulmanager:\n%s', e.stack || e);
      }
    }

    // ---------- Eltern-Portal ----------

    let elternPortalOk = () => {};
    if (elternPortalConfigured()) {
      await ep.processElternPortal(page, state);
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
      // Only now can the IMAP receive event handler awake us. It could already have populated its
      // OUTBOUND and notified the previous Promise while the main loop was busy, so check for that.
      if (ep.haveOutbound()) {
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
