const puppeteer = require('puppeteer');
const fs = require('fs');
const nodemailer = require('nodemailer');

const THREADS_FILE = 'kommunikation_fachlehrer.json';
const CONFIG = JSON.parse(fs.readFileSync('config.json', 'utf-8'));

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();

  console.log('Logging in...');
  await page.goto('https://theogymuc.eltern-portal.org/');
  await page.type('#inputEmail', CONFIG.elternportal.email);
  await page.type('#inputPassword', CONFIG.elternportal.password);
  await Promise.all([
    page.click('#inputPassword ~ button'),
    page.waitForNavigation()
  ]);

  const previousThreads = JSON.parse(fs.readFileSync(THREADS_FILE, 'utf-8'));

  // Build the list of teachers that have communicated.
  console.log('Reading teachers...');
  await page.goto('https://theogymuc.eltern-portal.org/meldungen/kommunikation_fachlehrer');
  const teachersList = await page.$$eval(
    'td:nth-child(3) a[href*="meldungen/kommunikation_fachlehrer/"',
    (anchors) => anchors.map(
      (a) => {
        const m = a.href.match(/.*\/([0-9]+)\//);
        const id = m[1];
        return {
          id: id,
          url: a.href,
          name: a.parentElement.parentElement.firstChild.textContent
        };
      }));
  // Map of teacher ID to details (name and URL).
  const teachers = {};
  teachersList.forEach((t) => {
    teachers[t.id] = t;
    delete t.id;
  });

  // Retrieve metadata for all threads.
  // Map of thread ID to details (list of messages in thread).
  const threads = {};
  for (const [ignored, teacher] of Object.entries(teachers)) {
    console.log('Reading threads with: ' + teacher.name);
    await page.goto(teacher.url);
    const threadsList = await page.$$eval(
      'a[href*="meldungen/kommunikation_fachlehrer/"',
      (anchors) => anchors.map((a) => {
        const m = a.href.match(/.*\/([0-9]+)$/);
        const id = m[1];
        return {
          id: id,
          url: a.href,
          subject: a.textContent
        };
      }));
    threadsList.forEach((t) => {
      threads[t.id] = t;
      delete t.id;
    });
  }

  // Retrieve thread contents.
  console.log('Reading thread contents...');
  for (const [ignored, thread] of Object.entries(threads)) {
    await page.goto(thread['url'] + '?load_all=1');
    thread.messages = await page.$$eval(
      'div.arch_kom',
      (divs) => divs.map((d) => {
        return {
          author: d.parentElement.parentElement.firstChild.textContent,
          body: d.textContent
        };
      }));
  }

  // Send emails.
  const emails = [];
  let emailsFailed = 0;
  let emailsOK = 0;
  for (const [threadId, thread] of Object.entries(threads)) {
    const nPrevious =
        threadId in previousThreads ? previousThreads[threadId]['messages'].length : 0;
    const messages = thread.messages;
    const nCurrent = messages.length;
    if (nCurrent <= nPrevious) {
      // If messages are ever deleted, we'd need to hash because n could remain constant or
      // decrease even when new messages are present.
      continue;
    };
    for (let i = nPrevious; i < nCurrent; ++i) {
      emails.push({
        from: CONFIG.email.from,
        to: CONFIG.email.to,
        subject: thread.subject + ' -- ' + messages[i].author,
        text: messages[i].body
      });
    }
  };
  // TODO: This runs the risk of flooding. Emails should be throttled. Possibly helpful:
  // https://www.npmjs.com/package/quota
  if (emails.length) {
    console.log('Emailing new messages...');
    const transport = nodemailer.createTransport({
      host: CONFIG.email.server,
      port: 465,
      secure: true,
      auth: {
        user: CONFIG.email.username,
        pass: CONFIG.email.password
      }
    });
    for (let i = 0; i < emails.length; ++i) {
      console.log(JSON.stringify(emails[i], null, 2));
      transport.sendMail(emails[i], function(error, info) {
        if (error) {
          console.log('Failed to send email: ' + error);
          emailsFailed++;
        } else {
          console.log('Email sent: ' + info.response);
          emailsOK++;
        }
      });
    };
  } else {
    console.log('No news is good news!');
  }
  // TODO: This will get stuck on a query of death and resend everything. Save state with the
  // failure removed? Remember the failure (hash?), notify about it and skip it next time?
  if (!emailsFailed) {
    console.log('Updating persistent state in ' + THREADS_FILE + '...');
    fs.writeFileSync(THREADS_FILE, JSON.stringify(threads, null, 2));
  }

  await browser.close();
})();
