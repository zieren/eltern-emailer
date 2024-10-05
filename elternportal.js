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
  threads: {}, // key: thread ID; value: { key: msg index; value: 1 }
  announcements: {}, // key: announcement ID; value: 1
  inquiries: {}, // key: hash from message subject, date and content; value: 1
  events: [], // list of event objects (cf. readEventsInternal())
  hashes: {
    substitutions: {}, // key: hash for one day's plan, value: 1
    notices: {} // key: notice hash; value: 1 (or 0 if email failed)
  }
};

// ---------- Internal constants ----------

// Docs: https://github.com/InteractionDesignFoundation/add-event-to-calendar-docs/blob/main/services/google.md
const GCAL_URL = 'https://calendar.google.com/calendar/r/eventedit?';

const INQUIRY_AUTHOR = ['Eltern', 'Klassenleitung', 'UNKNOWN'];

// Status of events and their (partial) HTML representation.
const TR_AND_STATUS = {
  '-1': '<tr class="removed"><td>--</td>', // removed (a rare but relevant case)
  '0': '<tr><td></td>',  // previously notified
  '1': '<tr class="new"><td>*</td>', // added
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

// This function does the thing. The login thing. You know?
async function loginElternPortal(page) {
  await page.goto(CONFIG.elternportal.url);
  await page.type('#inputEmail', CONFIG.elternportal.user);
  await page.type('#password', CONFIG.elternportal.pass);
  await Promise.all([
    page.waitForNavigation(),
    page.click('#password ~ button')
  ]);
  // When settings are present, we are logged in.
  const success = await page.$$eval('a[href*="einstellungen"]', (a) => a.length) > 0;
  if (!success) {
    throw 'Login Eltern-Portal failed';
  }
  LOG.info('Login Eltern-Portal OK');
}

// Called lazily to authenticate file requests (attachments).
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
    // Handle threads in chronological order by sorting by thread ID, which we assume is strictly
    // increasing.
    teacher.threads.sort((t1, t2) => t1.id - t2.id);
    for (const thread of teacher.threads) {
      await page.goto(thread.url + '?load_all=1'); // Prevent pagination (I hope).
      thread.messages = await page.$eval('div#last_messages',
        (div) => Array.from(div.children).map(row => {
          // I believe we can have multiple attachments, but I found no occurrence to verify.
          const attachments = Array.from(row.querySelectorAll('a.link_nachrichten'))
            .map(a => { return { url: a.href };});
          return {
            author: !!row.querySelector('label span.link_buchungen'), // resolved below
            body: row.querySelector('div div.form-control').textContent,
            attachments: attachments
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
          for (const file of thread.messages[i].attachments) {
            options ||= { headers: { 'Cookie': await getPhpSessionIdAsCookie(page) } };
            await downloadFile(file, options);
            LOG.info('Read attachment (%d kb) from "%s" in "%s"', // only teachers can attach files
              file.content.length >> 10, teacher.nameForLogging, thread.subject);
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
          const messageIdBase = `thread-${teacher.id}-${thread.id}-`;
          const email = em.buildEmailEpThreads(msg.author, thread.subject, {
            messageId: em.buildMessageId(messageIdBase + i),
            text: msg.body
          });
          email.attachments = msg.attachments.map(a => {
            return { filename: a.filename, content: a.content };
          })
          if (i > 0) {
            email.references = [em.buildMessageId(messageIdBase + (i - 1))];
            email.subject = 'Re: ' + email.subject; // subject is from website and never has 'Re:'
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

// Reads messages to/from "Klassenleitung". Returns an array of the below metadata.
async function readInquiries(page) {
  // AFAICT inquiries always have either one or two messages; we rely on that below.
  await page.goto(CONFIG.elternportal.url + '/meldungen/kommunikation');
  const inquiries = Array.from(await page.$$eval(
    'div.panel', (panels) => panels.map(p => {
      // Message texts may be absent, making parsing a bit more complex.
      const titleRaw = p.querySelector('h3.panel-title').innerText.trim();
      const t = titleRaw.match(/(.*?)(?:\(Beantwortet\))?\s+(\d\d)\.(\d\d)\.(\d\d\d\d)/);
      const request = { text: '', date: new Date(t[4], t[3] - 1, t[2]).getTime() };
      const response = { text: '', date: null };
      const nodes = p.querySelector('div.panel-body').childNodes;
      for (const n of nodes) {
        if (n.nodeName === '#text') {
          if (!response.date) { // The response date span comes first.
            request.text = n.textContent.trim();
          } else {
            response.text = n.textContent.trim();
          }
        } else if (n.nodeName === 'SPAN' && n.classList.contains('pull-right')) {
          d = n.innerText.match(/(\d\d)\.(\d\d)\.(\d\d\d\d)/);
          response.date = new Date(d[3], d[2] - 1, d[1]).getTime();
        }
      }
      let messages = [ request ];
      if (response.date) {
        messages.push(response);
      }
      return {
        subject: t[1].trim(),
        messages: messages
      };
    })));
  LOG.info('Found %d inquiries', inquiries.length);
  // Order is reverse chronological, make it forward.
  return inquiries.reverse();
}

function buildEmailsForInquiries(inquiries, state) {
  let prunedHashes = {};
  for (const inquiry of inquiries) {
    let previousHash = null;
    for (const [j, message] of Object.entries(inquiry.messages)) {
      const hash = md5(`${inquiry.subject}\n${message.date}\n${message.text}`);
      prunedHashes[hash] = 1;
      if (!state.inquiries[hash]) {
        const email = em.buildEmailEpThreads(
          INQUIRY_AUTHOR[Math.min(j, 2)],
          inquiry.subject,
          {
            messageId: em.buildMessageId(`inquiry-${hash}`),
            text: message.text,
            date: new Date(message.date)
          });
        if (previousHash) {
          email.references = [em.buildMessageId(`inquiry-${previousHash}`)];
        }
        INBOUND.push({
          email: email,
          ok: () => { state.inquiries[hash] = 1; }
        });
      }
      previousHash = hash;
    }
  }
  state.inquiries = prunedHashes;
}

// ---------- Substitutions ----------

async function readSubstitutions(page, previousHashes) {
  await page.goto(CONFIG.elternportal.url + '/service/vertretungsplan');
  // For our school most lines are duplicated, with explicitly altering CSS for the TR. Remove these
  // duplicates.
  await page.$$eval('div#asam_content div.main_center table.table tr', (trs) => trs.forEach(tr => {
    if (tr.previousElementSibling && tr.previousElementSibling.innerHTML === tr.innerHTML) {
      tr.parentElement.removeChild(tr);
    }
  }));
  // We use a day granularity to handle the case where a day disappears because it's past.
  const substitutions = await page.$$eval(
    'div#asam_content div.main_center div.list.bold', // find headings
    divs => divs.map(div => {
      const m = div.innerText.match(/\b(\d\d?)\.(\d\d?)\.(\d\d(\d\d)?)\b/);
      const table = div.nextElementSibling; // actual substitution table
      if (!m || table.nodeName !== 'TABLE' || !table.classList.contains("table")) {
        throw new Error('Unexpected substitution plan format');
      }
      // Expiration is beginning of next (+1) day (this works across months). We can't use
      // global.NOW in page context.
      const expired = Date.now() >= new Date(m[3], m[2] - 1, m[1] + 1).getTime();
      // There is no value in sending an empty plan. ISTM our school has a lookahead of two days,
      // so at midnight a new day appears. AFAICT that day is always empty, maybe because the
      // secretary needs to approve the plan manually.
      const empty = table.rows.length <= 1;
      return expired || empty
        ? null // filtered below
        : { html: `${div.outerHTML}\n${table.outerHTML}\n` };
    }).filter(s => s !== null));
  let newHashes = {};
  let haveUpdates = false;
  substitutions.forEach(sub => {
    const hash = md5(sub.html);
    newHashes[hash] = 1;
    sub.updated = !(hash in previousHashes.substitutions);
    haveUpdates ||= sub.updated;
  });
  if (!haveUpdates) {
    previousHashes.substitutions = newHashes;
    return;
  }
  let contentHTML = // Start with the heading (school class etc.).
    await page.$eval('div#asam_content table.table_header', table => table.outerHTML);
  substitutions.forEach(sub => { // Add all days (empty days were omitted above), marking updates.
    const html = sub.updated ? `<span class="updated">*&nbsp;${sub.html}</span>` : sub.html;
    contentHTML += html;
  });
  contentHTML += // Append last updated time. Only needed when there actually are updates.
    await page.$eval('div#asam_content div.main_center > div:last-of-type', div => div.outerHTML);
  const fullHTML = `<!DOCTYPE html><html><head><title>Vertretungsplan</title>
      <style>
        table, td { border: 1px solid; } 
        img { display: none; }
        span.updated div.list { font-weight: bold; display: inline; }
      </style></head>
      <body>${contentHTML}</body></html>`;
  INBOUND.push({
    email: em.buildEmailEpSubstitutions({html: fullHTML}),
    ok: () => { previousHashes.substitutions = newHashes; }
  });
  LOG.info('Found substitution plan update');
}

// ---------- Notice board ----------

async function readNoticeBoard(page, previousHashes) {
  await page.goto(CONFIG.elternportal.url + '/aktuelles/schwarzes_brett');
  // We extract both current and archived items, because an item may have been published and 
  // archived since the last run (e.g. vacation or other local downtime). To make sure hashes are
  // stable we need to do some contortions.
  const subjects = await page.$$eval('div.well h4', hh => hh.map(h => h.innerHTML));
  const currentContents = await page.$$eval('div.well h4 ~ p', pp => pp.map(p => p.outerHTML));
  const archivedContents =
    await page.$$eval('div.well div.row ~ div.row p:first-child', pp => pp.map(p => p.outerHTML));
  const contents = currentContents.concat(archivedContents);
  if (subjects.length != contents.length) {
    LOG.error(`Found ${subjects.length} subjects, but ${contents.length} contents`);
  }

  let newHashes = {};
  for (let i = 0; i < subjects.length; ++i) {
    const subject = subjects[i];
    const content = contents[i];
    const hash = md5(`${md5(subject)} ${md5(content)}`);
    if (previousHashes.notices[hash]) {
      newHashes[hash] = 1; // indicate "done"
      continue;
    }
    LOG.info('Found notice board message');
    newHashes[hash] = 0; // indicate "not yet done"
    INBOUND.push({
      email: em.buildEmailEpNotices(subject, {
        html: `<!DOCTYPE html><html><head></head><body>${content}</body></html>`
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
    // Shortcuts.
    const dateTD = td;
    const timeTD = td.nextSibling;
    const descriptionTD = td.nextSibling.nextSibling;
    // Remove year because it's obvious, and use non-breaking hyphen to keep date and time on a
    // single line for better readability.
    const compactDateTime = (s) => s.replace(/( |20\d\d)/g, '').replace(/-/g, '&#8209;');

    // Our school sometimes specifies invalid date ranges ("24.12.-23.12."). Logically, i.e. for
    // sorting and identifying upcoming/past events, we only use the start (first) date and ignore
    // the end date. Also, some events include a time of day while others don't. For those we assume
    // 0:00:00 and include the event until the next day, so it doesn't vanish on the entire day. The
    // Google Calendar link will include the dates (and times) verbatim, so that an invalid end date
    // will have to be edited before the event is accepted by Google Calendar. If this happens
    // frequently we should set the end date to the start date.

    let d = td.textContent.match(/(\d\d)\.(\d\d)\.(\d\d\d\d)(.+(\d\d)\.(\d\d)\.(\d\d\d\d))?/);
    // The date should always parse, otherwise we can't really handle the event.
    if (!d) {
      // Errors are handled in handleEventsWithErrors() because we're only in page context here.
      return {date: dateTD.textContent, description: descriptionTD.textContent, error: true};
    }
    // Time of day may be absent.
    const t = td.nextSibling.textContent.match(/(\d\d):(\d\d).+(\d\d):(\d\d)/);

    return {
      ts: new Date(d[3], d[2] - 1, d[1]).getTime(),
      description: descriptionTD.innerText.replace(/\s+/g, ' ').trim(), // remove \n
      date: `${compactDateTime(dateTD.textContent)}`,
      time: `&nbsp;${compactDateTime(timeTD.textContent)}`,
      descriptionHtml: `${descriptionTD.innerHTML}`,
      // Used as request parameter "dates" for Google Calendar link and for comparison.
      dates:    `${d[3]}${d[2]}${d[1]}${  t ? `T${t[1]}${t[2]}00` : ''}/${
         d[4] ? `${d[7]}${d[6]}${d[5]}` 
              : `${d[3]}${d[2]}${d[1]}`}${t ? `T${t[3]}${t[4]}00` : ''}`
    };
  }));
  return events;
}

function eventTR(e) {
  const description = encodeURIComponent(
      `${CONFIG.elternportal.tag}: ${e.status === -1 ? 'ABGESAGT: ' : ''}${e.description}`);
  return `${TR_AND_STATUS[e.status]}<td>${e.date}</td><td>${e.time}</td><td><a href="${
    GCAL_URL}text=${description}&dates=${encodeURIComponent(e.dates)}">${
    e.descriptionHtml}</a></td></tr>`;
}

function eventsMatch(a, b) {
  return a.descriptionHtml === b.descriptionHtml 
      && a.description === b.description 
      && a.dates === b.dates;
}

function containsEvent(events, event) {
  return events.find(e => eventsMatch(e, event));
}

function reportAndRemoveEventsWithErrors(events) {
  let errors = '';
  events.filter(e => e.error).forEach(error => {
    LOG.error(`Failed to parse date "${error.date}" for event "${error.description}"`);
    if (!errors) {
      errors = 'Folgende Termine konnten nicht verarbeitet werden:\n\n';
    }
    errors += `- Termin "${error.description}" mit Datum "${error.date}"\n`;
  });
  if (errors) {
    INBOUND.push({ 
      email: em.buildEmailAdmin('Termine konnte nicht verarbeitet werden', {text: errors}),
      ok: () => {}
    });
  }
  return events.filter(e => !e.error);
}

async function readEvents(page, stateEP) {
  // An event is considered expired on the next day. We store events with a time of day of 0:00:00,
  // so we compute the timestamp for 0:00:00 today and prune events before then. Note that the event
  // HTML also contains the date, so using it as a key is sufficient and we can ignore the
  // timestamp.
  const todayZeroDate = new Date(NOW);
  todayZeroDate.setHours(0, 0, 0, 0);
  const todayZeroTs = todayZeroDate.getTime();
  stateEP.events = stateEP.events.filter(e => e.ts >= todayZeroTs);

  // Read all exams and events.
  await page.goto(`${CONFIG.elternportal.url}/service/termine/liste/schulaufgaben`);
  let events = await readEventsInternal(page);
  await page.goto(`${CONFIG.elternportal.url}/service/termine/liste/allgemein`);
  events = events.concat(await readEventsInternal(page));
  events = reportAndRemoveEventsWithErrors(events);

  // Filter those within the lookahead range and not yet processed.
  let lookaheadDate = new Date(todayZeroDate);
  lookaheadDate.setDate(lookaheadDate.getDate() + CONFIG.elternportal.eventLookaheadDays);
  const lookaheadTs = lookaheadDate.getTime();
  let upcomingEvents = events
    .filter(e => e.ts >= todayZeroTs && e.ts <= lookaheadTs)
    // See TR_AND_STATUS for status codes.
    .map(e => { return { ...e, status: containsEvent(stateEP.events, e) ? 0 : 1 }; });
  const numNewEvents = upcomingEvents.filter(e => e.status == 1).length;

  // Find removed events. stateEP.events has been pruned above, so anything it contains that is no
  // longer upcoming was removed.
  const removedEvents = stateEP.events
      .filter(e => !containsEvent(upcomingEvents, e))
      .map(e => { return { ...e, status: -1 }; });
  const numRemovedEvents = removedEvents.length;

  // Join the two and sort them by timestamp.
  upcomingEvents = upcomingEvents.concat(removedEvents).sort((a, b) => a.ts - b.ts);

  // Build a list of all upcoming events.
  events = events
      .filter(e => e.ts > lookaheadTs)
      .map(e => { return { ...e, status: 0 }; })
      .sort((a, b) => a.ts - b.ts);

  LOG.info(`Found ${events.length} future events, of which ${upcomingEvents.length} in lookahead, `
    + `of which ${numNewEvents} new and ${numRemovedEvents} removed`);

  // Create emails.
  if (!(numNewEvents + numRemovedEvents)) {
    return;
  }
  let emailHTML = `<!DOCTYPE html><html><head><title>Bevorstehende Termine</title>
      <style>
      table { border-collapse: collapse; }
      tr { border-bottom: 1pt solid; }
      tr.new { font-weight: bold; }
      tr.removed { text-decoration: line-through; }
      </style>
      </head>
      <body>
      <h2>Termine in den n&auml;chsten ${CONFIG.elternportal.eventLookaheadDays} Tagen</h2>
      <table>\n`;
  upcomingEvents.forEach(e => emailHTML += eventTR(e));
  emailHTML += `
      </table>
      <hr>
      <details>
        <summary>Alle weiteren zuk&uuml;nftigen Termine</summary>
        <span>
          <table>`;
  events.forEach(e => emailHTML += eventTR(e));
  emailHTML += `
          </table>
        </span>
      </details>
      </body></html>`;

  const okHandler = function() {
    // Update state of previous (announced) events when all emails are sent.
    upcomingEvents.forEach(e => {
      if (e.status == 1) {
        delete e.status;
        // New event -> no longer new next time.
        stateEP.events.push(e);
      } else if (e.status == -1) {
        // Removed event -> no longer included next time.
        stateEP.events = stateEP.events.filter(ee => !eventsMatch(ee, e));
      } // else: status 0 means the event exists both online and in stateEP.events -> no-op
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
    const capacity = msg.text.length <= CONFIG.elternportal.messageSizeLimit
      ? CONFIG.elternportal.messageSizeLimit
      : (CONFIG.elternportal.messageSizeLimit - 8);
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
            CONFIG.elternportal.url + '/meldungen/kommunikation_fachlehrer/' 
            + msg.teacherId + '/_'); // A valid (!) name is required, and '_' is valid.
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
              + `Fehler:\n${e}\n\nWeitere Details im Logfile.`
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
  // them in the next query. They only trigger a scraping iteration. Key is IMAP sequence number, 
  // value is 1.
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

  // Send messages to teachers. We will later retrieve those messages when scraping threads with
  // teachers. That is intentional because presumably the second parent wants a copy of the message.
  await sendMessagesToTeachers(page);

  // Section "Aktuelles".
  const announcements = await readAnnouncements(page); // Always reads all.
  await readAnnouncementsAttachments(page, announcements, state.ep.announcements);
  buildEmailsForAnnouncements(page, announcements, state.ep.announcements);

  // Section "Kommunikation Eltern/Klassenleitung".
  const inquiries = await readInquiries(page);
  buildEmailsForInquiries(inquiries, state.ep);

  // Section "Kommunikation Eltern/Fachlehrer".
  const teachers = await readActiveTeachers(page, state.lastSuccessfulRun);
  await readThreadsMeta(page, teachers, state.lastSuccessfulRun);
  await readThreadsContents(page, teachers);
  await readThreadsAttachments(page, teachers, state.ep.threads);
  buildEmailsForThreads(teachers, state.ep.threads);

  // Section "Vertretungsplan"
  await readSubstitutions(page, state.ep.hashes);

  // Section "Schwarzes Brett"
  await readNoticeBoard(page, state.ep.hashes);

  // Section "Schulaufgaben / Weitere Termine"
  await readEvents(page, state.ep);
}

module.exports = { EMPTY_STATE, processElternPortal, processNewEmail, haveOutbound }
