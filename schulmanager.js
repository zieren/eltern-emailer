const fs = require('fs-extra');

const em = require('./email.js');

// ---------- Shared state (initialized in main.js) ----------

// global.LOG (see logging.js)
// global.INBOUND (see main.js)

const INITIAL_STATE = {
  letters: {} // key: ID (time and subject); value: 1
};

function fillState(state, emptyState) {
  for (const [key, value] of Object.entries(emptyState)) {
    state[key] ||= value;
    fillState(state[key], value); // Recurse for objects.
  }
}

// GENERAL NOTE: It seems that handle.click() is, at least in certain situations, flaky, while using
// page.evaluate() to call click() on the element is (AFAICT) robust. Hence we mostly use the
// latter.

class Schulmanager {
  #config;
  #downloadPath;
  #state;
  #page;

  constructor(config, state, page, downloadPath) {
    this.#config = config;
    this.#state = state;
    this.#page = page;
    this.#downloadPath = downloadPath;
    fillState(this.#state, INITIAL_STATE);
  }
  
  async process() {
    if (this.#config.timeoutSeconds) {
      this.#page.setDefaultTimeout(this.#config.timeoutSeconds * 1000);
    }
    await this.login();
    const letters = await this.readLetters();
    this.buildEmailsForLetters(letters);
  }

  async login() {
    await this.#page.goto('https://login.schulmanager-online.de/');
    await this.#page.waitForSelector('#emailOrUsername');
    await this.#page.type('#emailOrUsername', this.#config.user);
    await this.#page.type('#password', this.#config.pass);
    await this.#page.click('button.btn-primary');

    let winner = await Promise.race([
      this.#page.waitForSelector('div.modal-dialog div.modal-content'), // school selection dialog
      this.#page.waitForSelector('a.dropdown-item.module-label"]'),     // successful login
      this.#page.waitForSelector('form.login-form div.alert-danger')    // invalid credentials
    ]);
    if (await winner.evaluate(e => e.classList.contains('alert-danger'))) {
      throw 'Schulmanager login failed (invalid credentials?)';
    }
    if (await winner.evaluate(e => e.classList.contains('modal-content'))) {
      const schools = await winner.$$('div.btn-primary');
      let school = null;
      let textContent = null;
      for (const s of schools) {
        textContent = await s.evaluate(e => e.textContent);
        if (textContent.includes(this.#config.school)) {
          school = s;
          break;
        }
      }
      if (!school) {
        throw `Found no school containing "${this.#config.school}"`;
      }
      LOG.info(`Selected school "${textContent.trim()}"`);
      await school.click();
      winner = await this.#page.waitForSelector('a.dropdown-item.module-label');
    }
  
    if (!winner) {
      throw 'Login Schulmanager failed';
    }
    LOG.info('Login Schulmanager OK');
  }

  // Expands the list of letters until the specified number of letters is shown. Specify zero to
  // expand completely. Unfortunately the list is collapsed again after viewing a letter, so this
  // function may have to be called repeatedly (if there are many new letters). Returns a string for
  // logging.
  //
  // We expand the whole list once per run. This is inefficient and could be improved by remembering
  // the newest message after which we have processed all older messages. Then again, expanding ~250
  // messages takes ~3s on my machine, so it's not a big deal - on a normal run it will only happen
  // once, assuming all new messages are in the first chunk, resulting in O(n) comlexity. Also, note
  // that on a catchup run there is no way around O(n^2) complexity because Schulmanager collapses
  // the list again after viewing a message.
  async expandLetters(numToShow) {
      // Expand entire list by clicking "load more" repeatedly.
    while (true) {
      const loadMore = await this.#page.$('a.back-link[href="#/dashboard"] ~ h1 ~ div button');
      const numShown = await this.#page.$$eval('tr td.title-column', (tds) => tds.length);
          if (!loadMore || (numToShow > 0 && numShown >= numToShow)) {
        return `Found ${numShown} letters${loadMore ? ' (more are available)' : ''}`;
      }
      this.#page.evaluate(btn => btn.click(), loadMore);
      // Simply wait for one more letter to show.
      await this.#page.waitForSelector(`tr:nth-child(${numShown+1}) td.title-column`);
    }
  }

  // We expect the page context to allow downloads, but events need to be enabled here.
  async createDownloadingClient() {
    const client = await this.#page.browser().target().createCDPSession();
    await client.send('Browser.setDownloadBehavior', {
      behavior: 'default',
      eventsEnabled: true
    });
    return client;
  }

  async readLetters() {
    await this.#page.goto('https://login.schulmanager-online.de/#/modules/letters/view');
    await this.#page.waitForSelector('a.back-link[href="#/dashboard"]');
    const logMsg = await this.expandLetters(0);
    LOG.info(logMsg);

    const allLetters = await this.#page.$$eval('tr td.title-column', (tds) => 
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
    allLetters.forEach(letter => keepIds[letter.id] = 1);
    for (const id in this.#state.letters) {
      if (!keepIds[id]) {
        delete this.#state.letters[id];
      }
    }

    const letters = allLetters.filter(letter => !this.#state.letters[letter.id]);

    // Retrieve letter content.
    for (const letter of letters) {
      await this.expandLetters(letter.index);
      const tdHandle = await this.#page.$(`tr:nth-child(${letter.index}) td.title-column`);
      
      // Verify the index is stable, and simply bail out otherwise (cause is probably a race with a
      // new message arriving while processing).
      const id = await tdHandle.evaluate(td => {
        const subject = td.innerText.trim();
        const dateString = td.previousElementSibling.innerText.trim();
        return `${dateString} ${subject}`;
      });
      if (letter.id !== id) {
        LOG.warn(`Letters changed while processing (new letter?), will retry on next iteration`);
        return;
      }

      await Promise.all([
          this.#page.waitForNavigation(),
          this.#page.evaluate(td => td.click(), tdHandle)
      ]);

      // The modal dialog might initially contain the previous message's attachments, and I can't
      // tell when it is finalized. I could wait for the previous message's filenames to disappear,
      // but that seems brittle and complicated. This solution is a hack, but at least it's simple.
      // In steady state we usually don't run into this problem because there's rarely more than one
      // new message, but it does happen on catchup runs.
      if (letter.index !== letters[0].index) {
        await this.#page.waitForNetworkIdle({ idleTime: this.#config.attachmentWaitMillis || 1500 });
      }

      // Wait for modal dialog to show.
      await this.#page.waitForSelector('span.close-button');

      const content = await this.#page.$eval('div.letter-title ~ div', (d) => {
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
      const attachments = await this.#page.$$('div.letter-title ~ div:last-child label ~ div a');
      LOG.info(`Found ${attachments.length} attachments`);

      let client = null;
      for (const a of attachments) {
        client ||= await this.createDownloadingClient();
        const downloadWillBegin = new Promise(resolve => {
          client.on('Browser.downloadWillBegin', e => resolve(e));
        });
        const downloadCompleted = new Promise((resolve, reject) => {
          client.on('Browser.downloadProgress', e => {
            if (e.state === 'completed') {
              resolve();
            } else if (e.state === 'canceled') {
              reject(new Error(`Download was canceled: ${e.guid}`)); // There is no other info.
            } // else: inProgress
          });
        });
        await a.click();
        const dl = await downloadWillBegin;
        await downloadCompleted;
        const filename = `${this.#downloadPath}${dl.suggestedFilename}`;
        const content = fs.readFileSync(filename);
        letter.attachments ||= [];
        letter.attachments.push({filename: dl.suggestedFilename, content: content});
        LOG.info(`Message "${letter.subject}", attachment "${dl.suggestedFilename}" downloaded`);
        fs.unlinkSync(filename);
      }

      await Promise.all([
        this.#page.waitForNavigation(),
        this.#page.click('span.close-button')
      ]);
    }
    
    return letters.reverse(); // send in chronological order
  }

  buildEmailsForLetters(letters) {
    for (const letter of letters) {
      const email = this.buildEmailElternbrief(letter.subject, {
        // Let the message ID be random; we never reference this message.
        text: letter.text,
        html: letter.html,
        date: new Date(letter.dateString),
        attachments: letter.attachments
      });
      INBOUND.push({
        email: email,
        ok: () => { this.#state.letters[letter.id] = 1; }
      });
    }
  }

  buildEmailElternbrief(subject, options) {
    return em.buildEmail(
        `${this.#config.tag} Elternbrief`,
        this.#config.recipients['*'].concat(this.#config.recipients.elternbriefe),
        subject,
        options);
  }
}

module.exports = { Schulmanager }
