const puppeteer = require('puppeteer');
const fs = require('fs');
const nodemailer = require('nodemailer');

const THREADS_FILE = 'kommunikation_fachlehrer.json';
const CREDENTIALS = JSON.parse(fs.readFileSync('credentials.json', 'utf-8'));

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();

  console.log('Logging in...');
  await page.goto('https://theogymuc.eltern-portal.org/');
  await page.type('#inputEmail', CREDENTIALS.elternportal.email);
  await page.type('#inputPassword', CREDENTIALS.elternportal.password);
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
          'id': id,
          'url': a.href,
          'name': a.parentElement.parentElement.firstChild.textContent
        };
      }));
  // Map of teacher ID to details (name and URL).
  const teachers = {};
  teachersList.forEach((t) => {
    teachers[t['id']] = t;
    delete t['id'];
  });

  // Retrieve metadata for all threads.
  // Map of thread ID to details (list of messages in thread).
  const threads = {};
  for (const [ignored, teacher] of Object.entries(teachers)) {
    console.log('Reading threads with: ' + teacher['name']);
    await page.goto(teacher['url']);
    const threadsList = await page.$$eval(
      'a[href*="meldungen/kommunikation_fachlehrer/"',
      (anchors) => anchors.map((a) => {
        const m = a.href.match(/.*\/([0-9]+)$/);
        const id = m[1];
        return {
          'id': id,
          'url': a.href,
          'subject': a.textContent
        };
      }));
    threadsList.forEach((t) => {
      threads[t['id']] = t;
      delete t['id'];
    });
  }

  // Retrieve thread contents.
  console.log('Reading thread contents...');
  for (const [ignored, thread] of Object.entries(threads)) {
    await page.goto(thread['url'] + '?load_all=1');
    thread['messages'] = await page.$$eval(
      'div.arch_kom',
      (divs) => divs.map((d) => {
        return {
          'author': d.parentElement.parentElement.firstChild.textContent,
          'body': d.textContent
        };
      }));
  }

  console.log('Emailing new messages...');
  for (const [threadId, thread] of Object.entries(threads)) {
    if (threadId in previousThreads
        && previousThreads[threadId]['messages'].length === thread['messages'].length) {
      continue;
    };
    const messages = thread['messages'];
    for (let i = previousThreads[threadId]['messages'].length; i < messages.length; ++i) {
      console.log(messages[i]['body']);
    }
  };

  // TODO: Conditional on successful email!!
  console.log('Updating persistent state in ' + THREADS_FILE + '...');
  fs.writeFileSync(THREADS_FILE, JSON.stringify(threads, null, 2));

  // TODO: Email new messages.
  // Store these threads if email was successful.

  await browser.close();
})();
