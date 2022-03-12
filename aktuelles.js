const contentDisposition = require('content-disposition');
const https = require('https');
const fs = require('fs');
const nodemailer = require('nodemailer');
const puppeteer = require('puppeteer');

const CONFIG = JSON.parse(fs.readFileSync('config.json', 'utf-8'));

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
  const lettersList = await page.$$eval(
    '.link_nachrichten',
    (nodes) => nodes.map(
      (n) => {
        const letter = {};
        if (n.tagName === 'SPAN') {
          letter.subject = n.firstChild.textContent;
        } else {
          letter.subject = n.textContent;
          letter.url = n.href;
        }
        letter.body = n.parentElement.outerText.substring(n.outerText.length).trim();
        letter.id =
            n.parentElement.parentElement.previousElementSibling.firstChild.textContent.trim();
        return letter;
      }));
  console.log('Letters: ' + lettersList.length);
  const letters = {};
  lettersList.forEach((l) => {
    letters[l.id] = l;
    delete l.id;
  });
  return letters;
}

async function readAttachments(page, letters, skipIDs) {
  console.log('Reading attachments');
  const cookies = await page.cookies();
  console.log('Cookies: ' + JSON.stringify(cookies, null, 2));
  var options = {headers: {'Cookie': await getPhpSessionIdAsCookie(page)}};
  for (const [id, letter] of Object.entries(letters)) {
    if (id in skipIDs || !('url' in letter)) {
      continue;
    }
    console.log('Reading attachment for: ' + letter.subject);
    // TODO: Do we need to throttle here? Maybe simply wait a few seconds?
    const transport = nodemailer.createTransport({
      host: CONFIG.email.server,
      port: 465,
      secure: true,
      auth: {
        user: CONFIG.email.username,
        pass: CONFIG.email.password
      }
    });
    // Collect buffers and use Buffer.concat() to avoid chunk sizes arithmetics.
    let buffers = [];
    https.get(letter.url, options, (response) => {
      console.log('statusCode:', response.statusCode); // TODO: Handle.
      console.log('headers:', response.headers);
      // TODO: Decode UTF8 at some point. Buffer.from()? https://nodejs.org/api/buffer.html
      letter.filename =
          contentDisposition.parse(response.headers['content-disposition']).parameters.filename;
      response.on('data', (d) => {
        buffers.push(d);
      }).on('end', () => {
        letter.content = Buffer.concat(buffers);
        console.log('attachment: ' + letter.content.length);
        const email = {
          from: CONFIG.email.from,
          to: CONFIG.email.to,
          subject: letter.subject,
          text: letter.body,
          attachments: [
            {
              filename: letter.filename,
              content: letter.content
            }
          ]
        };
        transport.sendMail(email, function(error, info) {
          if (error) {
            console.log('Failed to send email: ' + error);
          } else {
            console.log('Email sent: ' + info.response);
          }
        });


      });
    }).on('error', (e) => {
      console.error('Aw dang: ' + e); // TODO: Handle.
    });

    break; // TODO
  };
}

async function getPhpSessionIdAsCookie(page) {
  const cookies = await page.cookies();
  const id = cookies.filter(c => c.name === "PHPSESSID");
  return id.length === 1 ? id[0].name + '=' + id[0].value : ''; // TODO: Handle this?
}

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();

  await login(page);
  const letters = await readLetters(page);
  console.log(JSON.stringify(letters, null, 2));
  await readAttachments(page, letters, {}); // TODO: Skip IDs.
  await browser.close();
})();
