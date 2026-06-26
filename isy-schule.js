const fs = require('fs-extra');
const path = require('path');
const em = require('./email.js');

// ---------- Shared state (initialized in main.js) ----------

// global.LOG (see logging.js)
// global.INBOUND (see main.js)

const DOWNLOAD_TIMEOUT_DEFAULT_SECONDS = 30;

const INITIAL_STATE = {
  news: {} // news IDs, mapped to value 1
};

function fillState(state, emptyState) {
  for (const [key, value] of Object.entries(emptyState)) {
    state[key] ||= value;
    fillState(state[key], value); // Recurse for objects.
  }
}

function sleepSeconds(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

// GENERAL NOTE: It seems that handle.click() is, at least in certain situations, flaky, while using
// page.evaluate() to call click() on the element is (AFAICT) robust. Hence we mostly use the
// latter.

class IsySchule {
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
    await this.readNews();
  }

  async login() {
    await this.#page.goto(this.#config.url);
    await this.#page.waitForSelector('#Login_Password');
    await this.#page.type('#Login_Emailaddress', this.#config.user);
    await this.#page.type('#Login_Password', this.#config.pass);
    await this.#page.click('button.btn-auth');
    await this.#page.waitForNavigation();

    LOG.info('Login Isy-Schule OK');
  }

  async readNews() {
    const baseUrl = new URL('neuigkeiten', this.#config.url).href;
    await this.#page.goto(baseUrl);

    // TODO: Do we ever need to expand this list?

    const previews = await this.#page.$$('div.post.newspreview');
    LOG.info(`Found ${previews.length} news`);

    let news = {};
    for (const p of previews) {
      const a = await p.$('a.newspreview-link');
      const href = await a.evaluate(a => a.href);
      const id = href.split('/').pop();
      news[id] = href;
    }
    
    // Prune state.
    for (const id of Object.keys(this.#state.news)) {
      if (!(id in news)) {
        delete this.#state.news[id];
      }
    }

    let client = null;
    for (const [id, href] of Object.entries(news)) {
      if (this.#state.news[id]) {
        continue;
      }
      await this.#page.goto(href);
      const subjectHandle = await this.#page.$('h3.post-title');
      const subjectText = await subjectHandle.evaluate(e => e.textContent.trim());
      const metaText = await subjectHandle.evaluate(e => e.nextElementSibling.textContent);
      const [, day, month, year] = metaText.match(/(\d\d)\.(\d\d)\.(\d\d\d\d)/);
      // The message lacks time of day. To approximate correct sorting in the client we use the
      // current time, assuming that it's off by at most the polling interval. This only makes sense
      // if the message is from the current day (i.e. no catch-up run).
      const d = new Date();
      const date =
          d.getFullYear() == year && d.getMonth() == month - 1 && d.getDate() == day 
          ? new Date(new Date().setFullYear(year, month - 1, day))
          : new Date(year, month - 1, day);
      const [, from] = metaText.match(/\bVon\b(.*)/);
      const contentHandle = await this.#page.$('div.news-content');
      const contentText = await contentHandle.evaluate(e => e.innerText.trim());
      const contentHtml = await contentHandle.evaluate(e => e.innerHTML);

      let options = {
        text: contentText,
        html: contentHtml,
        date: date
      };

      const attachments = await this.#page.$$('a.news-attachment[href="javascript:void(0);"]');
      for (const a of attachments) {
        client ||= await this.createDownloadingClient();

        let timeoutId;
        const timeoutMs = (this.#config.timeoutSeconds ? this.#config.timeoutSeconds : DOWNLOAD_TIMEOUT_DEFAULT_SECONDS) * 1000;
        const timeoutPromise = new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error(`Download timed out after ${timeoutMs}ms`)), timeoutMs);
        });

        let currentGuid;
        let suggestedFilename;
        let onWillBegin;
        let onProgress;

        const downloadProcess = new Promise((resolve, reject) => {
          onWillBegin = (e) => {
            currentGuid = e.guid;
            suggestedFilename = e.suggestedFilename;
          };

          onProgress = (e) => {
            // Ignore possible concurrent downloads (shouldn't happen, but seems cleaner).
            if (currentGuid && e.guid !== currentGuid) return;

            if (e.state === 'completed') {
              resolve(suggestedFilename);
            } else if (e.state === 'canceled') {
              reject(new Error(`Download was canceled: ${e.guid}`));
            }
          };

          client.on('Browser.downloadWillBegin', onWillBegin);
          client.on('Browser.downloadProgress', onProgress);

          a.evaluate(el => el.click()).catch(reject);
        });

        let downloadedFilename;
        try {
          downloadedFilename = await Promise.race([downloadProcess, timeoutPromise]);
          // No catch, so a timeout exception bubbles up.
        } finally {
          clearTimeout(timeoutId);
          if (onWillBegin) client.off('Browser.downloadWillBegin', onWillBegin);
          if (onProgress) client.off('Browser.downloadProgress', onProgress);
        }

        const filename = path.join(this.#downloadPath, downloadedFilename);
        const content = fs.readFileSync(filename);
        options.attachments ||= [];
        options.attachments.push({filename: downloadedFilename, content: content});
        fs.unlinkSync(filename);
      }
      const email = this.buildEmailNeuigkeiten(subjectText, from, options);

      INBOUND.push({
        email: email,
        ok: () => this.#state.news[id] = 1
      })
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

  buildEmailNeuigkeiten(subject, from, options) {
    const name = from ? ` (${from.trim()})` : '';
    return em.buildEmail(
        `${this.#config.tag} Neuigkeiten${name}`,
        this.#config.recipients['*'].concat(this.#config.recipients.elternbriefe),
        subject,
        options);
  }
}

module.exports = { IsySchule };
