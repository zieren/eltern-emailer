const contentDisposition = require('content-disposition');
const https = require('https');
const fs = require('fs');
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
  // https://stackoverflow.com/questions/4579757/how-do-i-create-a-http-client-request-with-a-cookie
  // https://stackoverflow.com/questions/51618804/how-to-download-a-file-into-a-buffer-in-node-js
  console.log('Reading attachments');
  const cookies = await page.cookies();
  console.log('Cookies: ' + JSON.stringify(cookies, null, 2));
  const phpsessid = await getPHPSESSID(page);
  var options = {
      headers: { 'Cookie': phpsessid }
  };
  for (const [id, letter] of Object.entries(letters)) {
    if (id in skipIDs || !('url' in letter)) {
      continue;
    }
    console.log('Reading attachment for: ' + letter.subject);
    // TODO: Do we need to throttle these? Maybe simply wait a few seconds?
    let out = null;
    const decoder = new TextDecoder();
    console.log(letter.url);
    const request = https.get(letter.url, options, (res) => {
      console.log('statusCode:', res.statusCode); // TODO: Handle.
      console.log('headers:', res.headers);
      // TODO: Decode UTF8 at some point.
      const filename =
          contentDisposition.parse(res.headers['content-disposition']).parameters.filename;
      out = fs.createWriteStream('letters/' + filename);
      res.on('data', (d) => {
        out.write(d); // TODO: Handle retval.
      });
    });
    request.on('error', (e) => {
      console.error('Aw dang: ' + e);
    });
    request.on('end', () => {
      out.end();
    });
  };
}

async function getPHPSESSID(page) { // TODO: ...AsCookie() or sth
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
