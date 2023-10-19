const fs = require('fs-extra');
const path = require('path');

const em = require('./email.js');

// Directory for temporary files, currently only Schulmanager attachment downloads.
const TEMP_DIR = `${__dirname}${path.sep}temp${path.sep}`;

// ---------- Shared state (initialized in main.js) ----------

// global.LOG (see logging.js)
// global.CONFIG (see main.js)
// global.INBOUND (see main.js)

async function login(page) {
  if (!CONFIG.schulmanager) {
    return;
  }
  maybeCreateTempDir();
  await page.goto('https://login.schulmanager-online.de/');
  await page.waitForSelector('#emailOrUsername');
  await page.type('#emailOrUsername', CONFIG.schulmanager.user);
  await page.type('#password', CONFIG.schulmanager.pass);
  await Promise.all([
    page.waitForNavigation(),
    page.click('button.btn-primary')
  ]);
  await page.waitForSelector('a#accountDropdown');
  const success = await page.$$eval('a#accountDropdown', (a) => a.length) > 0;
  if (!success) {
    throw 'Login Schulmanager failed';
  }
  LOG.info('Login Schulmanager OK');
}

function maybeCreateTempDir() {
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR);
    LOG.info(`Created temp directory ${TEMP_DIR}`);
  }
  fs.emptyDirSync(TEMP_DIR);
}

/**
 * Expands the list of letters until the specified number of letters is shown. Specify zero to
 * expand completely. Unfortunately the list is collapsed again after viewing a letter, so this
 * function may have to be called repeatedly (if there are many new letters). Returns a string for
 * logging, if desired.
 */
async function expandLetters(page, numToShow) {
    // Expand entire list by clicking "load more" repeatedly.
  while (true) {
    const loadMore = await page.$('a.back-link[href="#/dashboard"] ~ h1 ~ div button');
    const numShown = await page.$$eval('tr td.title-column', (tds) => tds.length);
        if (!loadMore || (numToShow > 0 && numShown >= numToShow)) {
      return `Found ${numShown} letters${loadMore ? ' (more are available)' : ''}`;
    }
    await loadMore.click();
    // Simply wait for one more letter to show. 
    await page.waitForSelector(`tr:nth-child(${numShown+1}) td.title-column`);
  }
}

async function createCDPSession() {
  const client = await BROWSER.target().createCDPSession();
  await client.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: TEMP_DIR,
    eventsEnabled: true
  });
  return client;
}

async function readLetters(page, processedLetters) {
  await page.goto('https://login.schulmanager-online.de/#/modules/letters/view');
  await page.waitForSelector('a.back-link[href="#/dashboard"]');
  const logMsg = await expandLetters(page, 0);
  LOG.info(logMsg);

  const allLetters = await page.$$eval('tr td.title-column', (tds) => 
    tds.map((td) => {
      
      // Metadata is stored on the element in two arrays, __ngContext__ and
      // __zone_symbol__clickfalse. The former includes an object like {id: 123}, and IIRC the
      // latter includes one like {letterId: 123}. Both indicate the letter ID, as seen in the URL
      // when clicked. We could look for those in these arrays, but that seems brittle. Instead we
      // just use the concatenation of date/time and subject, which seems unique and stable enough.

      const subject = td.innerText.trim();
      const dateString = td.previousElementSibling.innerText.trim();
      const d = dateString.match(/(\d\d)\.(\d\d)\.(\d\d)[, ]+(\d\d):(\d\d)/);
            return {
        // We could use "id" below to find the message in the list, but the index is more
        // straightforward.
        index: 1 + Array.prototype.indexOf.call(
            td.parentElement.parentElement.children, td.parentElement),
        subject: subject,
        // Date isn't serializable, so we need to use a string.
        dateString: `${2000 + parseInt(d[3])}-${d[2]}-${d[1]} ${d[4]}:${d[5]}`,
        id: `${dateString} ${subject}`
      };
    })
  );

  // Prune the list of processed IDs.
  let keepIds = {};
  allLetters.forEach((letter) => keepIds[letter.id] = 1);
  for (const id in processedLetters) {
    if (!keepIds[id]) {
      delete processedLetters[id];
    }
  }

  const letters = allLetters.filter((letter) => !processedLetters[letter.id]);

  // Retrieve letter content.
  for (const letter of letters) {
    await expandLetters(page, letter.index);
    const tdHandle = await page.$(`tr:nth-child(${letter.index}) td.title-column`);
    
    // Verify the index is stable, and simply bail out otherwise (cause is probably a race with a
    // new message arriving while processing).
    const id = await tdHandle.evaluate((td) => {
      const subject = td.innerText.trim();
      const dateString = td.previousElementSibling.innerText.trim();
      return `${dateString} ${subject}`;
    });
    if (letter.id !== id) {
      LOG.warn(`Letters changed while processing (new letter?), will retry on next iteration`);
      return;
    }

    // I had strange problems using plain handle.click(): It would consistently fail for some
    // messages (#5 and #6 out of a list of 24). This would only happen after clicking the "load
    // more" button (but note that the affected messages are inside the first page). Using instead
    // page.evaluate() to click() the element seems to fix this.
    await page.evaluate(td => td.click(), tdHandle);
    await page.waitForSelector('span.close-button');
    const content = await page.$eval('div.letter-title ~ div', (d) => {
      return {
        text: d.innerText,
        html: `<!DOCTYPE html><html><head></head><body>${d.innerHTML}</body></html>`
      };
    });
    letter.text = content.text;
    letter.html = content.html;

    LOG.info(`Message "${letter.subject}" retrieved`);

    // Retrieve attachments, if any. This doesn't use the same method as Eltern-Portal, i.e. a
    // simple HTTP request, because I found no good way of getting at the letter ID (and that's only
    // one of multiple parameters). 
    const attachments = await page.$$('div.letter-title ~ div:last-child label ~ div a');

    let client = null;
    for (const a of attachments) {
      client ||= await createCDPSession();
      const downloadWillBegin = new Promise((resolve) => {
        client.on('Browser.downloadWillBegin', e => resolve(e));
      });
      const downloadCompleted = new Promise((resolve, reject) => {
        client.on('Browser.downloadProgress', e => {
          if (e.state === 'completed') {
            resolve();
          } else if (e.state === 'canceled') {
            reject();
          } // else: inProgress
        });
      });
      await a.click();
      const dl = await downloadWillBegin;
      await downloadCompleted;
      const tempFilename = `${TEMP_DIR}${dl.suggestedFilename}`;
      const content = fs.readFileSync(tempFilename);
      letter.attachments ||= [];
      letter.attachments.push({filename: dl.suggestedFilename, content: content});
      LOG.info(`Message "${letter.subject}", attachment "${dl.suggestedFilename}" downloaded`);
      fs.unlinkSync(tempFilename);
    }

    await Promise.all([
      page.waitForNavigation(),
      page.click('span.close-button')
    ]);
  }
  
  return letters.reverse(); // send in chronological order
}

function buildEmailsForLetters(letters, processedLetters) {
  for (const letter of letters) {
    const email = em.buildEmailSmAnnouncements(letter.subject, {
      // Let the message ID be random; we never reference this message.
      text: letter.text,
      html: letter.html,
      date: new Date(letter.dateString),
      attachments: letter.attachments
    });
    INBOUND.push({
      email: email,
      ok: () => { processedLetters[letter.id] = 1; }
    });
  }
}

module.exports = { login, readLetters, buildEmailsForLetters }
