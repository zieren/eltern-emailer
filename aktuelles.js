/* global Buffer, Promise */

const contentDisposition = require('content-disposition');
const https = require('https');
const fs = require('fs');
const nodemailer = require('nodemailer');
const puppeteer = require('puppeteer');

const CONFIG = JSON.parse(fs.readFileSync('config.json', 'utf-8'));
const PROCESSED_ITEMS_FILE = 'processed.json';

async function login(page) {
  console.log('Logging in');
  await page.goto(CONFIG.elternportal.url);
  await page.type('#inputEmail', CONFIG.elternportal.email);
  await page.type('#inputPassword', CONFIG.elternportal.password);
  await Promise.all([
    page.click('#inputPassword ~ button'),
    page.waitForNavigation()
  ]);
}

async function readLetters(page) {
  console.log('Reading letters');
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
  console.log('Letters: ' + letters.length);
  return letters;
}

async function readAttachments(page, letters, processedLetters) {
  console.log('Reading attachments');
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
        // TODO: Decode UTF8 at some point. Buffer.from()? https://nodejs.org/api/buffer.html
        letter.filename =
            contentDisposition.parse(response.headers['content-disposition']).parameters.filename;
        response.on('data', (buffer) => {
          buffers.push(buffer);
        }).on('end', () => {
          letter.content = Buffer.concat(buffers);
          console.log(
              'Read attachment (' + letter.content.length + ' bytes) for: ' + letter.subject);
          resolve(null);
        });
      }).on('error', (e) => {
        console.error('Aw dang: ' + e);
        reject(e); // TODO: Handle.
      });
    });
  }
}

async function sendEmail(letters, processedLetters) {
  let transport = null;
  // Send oldest letters first, i.e. maintain chronological order. This is not reliable because
  // emails race, but GMail ignores the carefully forged message creation date (it shows the
  // reception date instead), so it's the best we can do.
  for (const letter of letters.reverse()) {
    if (letter.id in processedLetters) {
      continue;
    }
    const email = {
      from: CONFIG.email.from + ' (Elternportal - Aktuelles)',
      to: CONFIG.email.to,
      subject: letter.subject,
      text: letter.body,
      date: new Date(letter.dateString)
    };
    console.log(email.date);
    if (letter.content) {
      email.attachments = [
        {
          filename: letter.filename,
          content: letter.content
        }
      ];
    }
    if (!transport) {
      // TODO: Expose more mail server config.
      transport = nodemailer.createTransport({
        host: CONFIG.email.server,
        port: 465,
        secure: true,
        auth: {
          user: CONFIG.email.username,
          pass: CONFIG.email.password
        }
      });
    } else {
      // Throttle outgoing emails.
      await new Promise(f => setTimeout(f, CONFIG.email.waitSeconds * 1000));
    }
    console.log('Sending email "' + letter.subject + '"');
    await new Promise((resolve, reject) => {
      transport.sendMail(email, (error, info) => {
        if (error) {
          console.log('Failed to send email: ' + error); // TODO: Handle.
          reject(error);
        } else {
          console.log('Email sent: ' + info.response);
          processedLetters[letter.id] = 1;
          resolve(null);
        }
      });
    });
  }
}

async function getPhpSessionIdAsCookie(page) {
  const cookies = await page.cookies();
  const id = cookies.filter(c => c.name === "PHPSESSID");
  return id.length === 1 ? id[0].name + '=' + id[0].value : ''; // TODO: Handle this?
}

(async () => {
  const processedItems = JSON.parse(fs.readFileSync(PROCESSED_ITEMS_FILE, 'utf-8'));
  const browser = await puppeteer.launch();
  const page = await browser.newPage();

  await login(page);
  const letters = await readLetters(page); // Always reads all.
  await readAttachments(page, letters, processedItems.letters);
  await sendEmail(letters, processedItems.letters);
  await browser.close();
  fs.writeFileSync(PROCESSED_ITEMS_FILE, JSON.stringify(processedItems, null, 2));
})();
