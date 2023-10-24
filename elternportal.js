const contentDisposition = require('content-disposition');
const https = require('https');
const md5 = require('md5');
const { simpleParser } = require('mailparser');

const em = require('./email.js');

// ---------- Shared state (initialized in main.js) ----------

// global.LOG (see logging.js)
// global.CONFIG (see main.js)
// global.INBOUND (see main.js)
// global.NOW (see main.js)

// ---------- External constants ----------

const EMPTY_STATE = {
  lastSuccessfulRun: 0, // Last successful run (epoch millis). Older data can be skipped.
  threads: {}, // key: thread ID; value: { key: msg index; value: 1 }
  announcements: {}, // key: announcement ID; value: 1
  inquiries: {}, // key: thread index; value: number of msgs processed (oldest first)
  events: {}, // key: event description (needed when event is *removed*); value: timestamp
  hashes: {
    subs: '', // latest substitution plan hash
    notices: {} // key: notice hash; value: 1 (or 0 if email failed)
  }
};

// ---------- Internal constants ----------

const INQUIRY_AUTHOR = ['Eltern', 'Klassenleitung', 'UNKNOWN'];

// Status of events and their (partial) HTML representation.
const STATUS_TO_HTML = {
  '-1': '<tr class="removed"><td>--', // removed (a rare but relevant case)
  '0': '<tr><td>',  // previously notified
  '1': '<tr class="new"><td>*', // added
};

// ---------- Internal state ----------

//  Outbound messages are intended for teachers. They are received asynchronously via IMAP and
//  posted on the portal. Each has a "prep" handler that must complete successfully before actually
//  sending. This handler will mark the original email that triggered this message as answered in
//  IMAP to avoid duplicate messages to teachers in case of errors (e.g. when the message to the
//  teacher is sent, but the email in the IMAP inbox cannot be marked processed). Using an IMAP flag
//  instead of the status file has the downside that it cannot express partial success, but that is
//  a rare case anyway. On the upside the IMAP flag will persist across reinstalls or deletion of
//  the status file.
let OUTBOUND = [];

// ---------- Utilities ----------

function haveOutbound() {
  return !!OUTBOUND.length;
}

// Downloads from file.url, setting file.filename and file.content.
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
          id: n.attributes.onclick.textContent.match(/\((\d+)\)/)[1],
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

// Returns a list of teachers with at least one recent thread.
async function readActiveTeachers(page, lastSuccessfulRun) {
  await page.goto(CONFIG.elternportal.url + '/meldungen/kommunikation_fachlehrer');
  const teachers = (await page.$$eval(
    // New messages cause a "Neu" indicator with the same href as the teacher. The :first-child
    // selector prevents duplicates from that.
    'td:nth-child(3) a[href*="meldungen/kommunikation_fachlehrer/"]:first-child',
    (anchors) => anchors.map(
      (a) => {
        // Time here is in 12h format but missing any am/pm indicator (sic). We just use the date to
        // find teachers with ~recent threads.
        const d = a.parentElement.innerText.match(/(\d\d)\.(\d\d).(\d\d\d\d)/);
        const m = a.href.match(/.*\/(\d+)\/(.*)/);
        return {
          id: m[1],
          url: a.href,
          // This may be specific to our school: EP displays a teacher's name in many different
          // variations. We can easily get one here, but it is dirtier than others: It is in "Last,
          // First" order, and some roles (e.g. director) are added after the name, separated by
          // "<br>", which is %-encoded. We strip that here, but keep the reverse order. Later on we
          // can get the name in forward order, so we use this only for logging.
          nameForLogging: decodeURIComponent(m[2]).replace(/<.*/, '').replace(/[+_]/g, ' '),
          // We add two days to the date to account for a) lacking time of day, b) timezones, and c)
          // clock skew. There is no need to cut it close, the performance gain would not outweigh
          // complexity.
          latest: new Date(d[3], d[2] - 1, parseInt(d[1]) + 2).getTime()
        };
      })))
      .filter(a => a.latest >= lastSuccessfulRun);
  LOG.info('Found %d teachers with recent threads', teachers.length);
  return teachers;
}

// Reads metadata for all threads, based on active teachers returned by readActiveTeachers().
// Threads are stored with key 'threads' for each teacher.
async function readThreadsMeta(page, teachers, lastSuccessfulRun) {
  for (const teacher of teachers) {
    LOG.debug('Reading threads with %s', teacher.nameForLogging);
    await page.goto(teacher.url);
    teacher.threads = (await page.$$eval(
        'a[href*="meldungen/kommunikation_fachlehrer/"]',
        (anchors) => anchors.map((a) => {
          // See matching comments in readActiveTeachers() above.
          const d = a.parentElement.previousSibling.textContent.match(/(\d\d)\.(\d\d)\.(\d\d\d\d)/);
          // Extract teacher name and thread ID. In our school the teacher name used here is clean
          // and in "first name first" order. First and last name are separated by '_'.
          const m = a.href.match(/.*\/([^\/]*)\/(\d+)$/);
          return {
            id: m[2],
            url: a.href,
            // Not sure I've seen quotes or newlines; just trying to ensure an RFC2822 valid name.
            teacherName: decodeURIComponent(m[1]).replace(/[+"\n_]/g, ' '),
            subject: a.textContent,
            // See matching comments in readActiveTeachers() above.
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
            const address = 
                CONFIG.options.incomingEmail.forwardingAddress.replace('@', `+${teacher.id}@`);
            email.replyTo = `"${thread.teacherName}" <${address}>`;
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
  // For our school most lines are duplicated, with explicitly altering CSS for the TR. Remove these
  // duplicates.
  await page.$$eval('div#asam_content table.table tr', (trs) => trs.forEach(tr => {
    if (tr.previousElementSibling && tr.previousElementSibling.innerHTML === tr.innerHTML) {
      tr.parentElement.removeChild(tr);
    }
  }));
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
      newHashes[hash] = 1; // indicate "done"
      continue;
    }
    LOG.info('Found notice board message');
    newHashes[hash] = 0; // indicate "not yet done"
    INBOUND.push({
      email: em.buildEmailEpNotices(subject, {
        html: `<!DOCTYPE html><html><head></head><body>${innerHTML}</body></html>`
      }),
      ok: () => { newHashes[hash] = 1; }
    });
  }
  // In the new object, existing hashes map to 1 while newly encountered ones map to 0. They are set
  // to 1 in the OK handler.
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

  LOG.info(`${upcomingEvents.length} upcoming events, `
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

// ---------- Outgoing messages ----------

async function sendMessagesToTeachers(page) {
  LOG.info('Sending %d messages to teachers', OUTBOUND.length);
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
              (a) => a.href.match(/.*\/(\d+)$/)[1]);
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

// ---------- Incoming email ----------

// Returns true if the main loop should should be awake()-ned. For simplicity we awake
// unconditionally. We don't distinguish between new content notifications and ignored messages,
// e.g. sick leave confirmation. An occasional false positive is OK.
// We use the "answered" flag, which is part of the IMAP standard, to mark messages done.
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

  return !!numNewMessages;
}

async function markEmailDone(seq) {
  await IMAP_CLIENT.messageFlagsAdd({ seq: seq }, ['\\Answered']);
  LOG.debug('Marked processed email: %d', seq);
}

// ---------- Orchestration ----------

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
  const teachers = await readActiveTeachers(page, state.ep.lastSuccessfulRun);
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

module.exports = { EMPTY_STATE, processElternPortal, processNewEmail, haveOutbound }
