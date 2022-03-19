# Eltern-Emailer

Unofficial email interface for `*.eltern-portal.org` sites: Retrieves messages from the web and
emails them to you. This saves time, enables text search and integrates with email based workflows.

## Project Status

This project is in alpha state.

## How it Works

Eltern-Emailer logs into the Eltern-Portal website and checks for new content in certain
[categories](#current-features), e.g. news in `Aktuelles` or messages from teachers in
`Kommunikation Eltern/Fachlehrer`. It then sends this content to you via email.

The application does not interact with any third parties except your email provider. It runs on
your own desktop or server. Currently only timed polling is supported. Event-based polling
(triggered by the notification email) is [planned](#planned-features).

### Requirements

The application requires the free [Node.js](https://en.wikipedia.org/wiki/Node.js) JavaScript
runtime environment. It is tested on the following platforms:

* Windows
* Linux

### Current Features

The following contents (sections in the web UI) are supported at HEAD:

* `Aktuelles`
* `Kommunikation Eltern/Fachlehrer`
* `Kommunikation Eltern/Klassenleitung`
* `Klassen Vertretungsplan`

### Planned Features

The following contents are on my radar (roughly in order of priority):

* `Schulaufgaben / Weitere Termine`
* `Schwarzes Brett`

Schools use different feature subsets of the portal. If a feature is missing for your school, let me
know or, even better, contribute code.

Other planned features:

* Check for the portal's notification email instead of polling every N minutes.
* Forward email sent to Eltern-Emailer to a teacher via the form on the website.
* Run on a Raspberry Pi.

## Installation

1. Install [Node.js](https://nodejs.org/).
1. Download the latest [release](https://github.com/zieren/eltern-emailer/releases) and unpack it
   to an installation directory of your choice.
1. In that directory, run this command to install the required dependencies:
   ```
   npm install args-and-flags content-disposition md5 nodemailer puppeteer winston
   ```
   This downloads 400+MB. You can continue with the next step in the meanwhile.
1. Edit the file `config.json` to specify your login credentials, SMTP server etc. All uppercase parts need to be replaced. If you don't want to store credentials in a file you can pass them via commandline flags (see [Flags](#flags)). See section [Configuration](#configuration) below for a detailed description of all options.

   **WARNING**
   Keep in mind that the emails sent may contain sensitive personal information. Be sure to specify the **correct `emailTo` and `emailFrom` addresses** in the config file.
1. Run the application once in test mode to verify the credentials for the portal and the email server, and to be sure the `emailTo` and `emailFrom` addresses are correct:
   ```
   node main.js --test --once
   ```
   This will send two test emails, one to the regular recipient (`emailTo`) and one to the sender's return address (`emailFrom`). The latter is where an undeliverable email would bounce to. The test emails only say how many emails would have been sent in normal mode, but contain no personal information. Verify that both emails arrives at the correct addresses.

## Configuration

The following sections describe the homonymous parts in the `config.json` file.

### `elternportal`

These parameters are used to log into the Eltern-Portal.

`url`
: The URL of your school's Eltern-Portal, e.g. `https://theogymuc.eltern-portal`

`user`
: The email address you use when logging in

`pass`
: The password you use when logging in

### `smtp`

These parameters configure the SMTP transport in the Nodemailer module. The full set of options described in the [Nodemailer documentation](https://nodemailer.com/smtp/) is available. The default values for `port` (465) and `secure` (true) work well for many servers, but yours may require different settings.

### `options`

These control the behavior of Eltern-Emailer.

`emailTo`
: The recipient of all emails sent by the application. Specify only the address, not the real name. This will typically be a parent's email address, or an address that forwards to both parents.

`emailFrom`
: The sender used for all emails sent by the application. Specify only the address, not the name. This is where bounced emails are delivered to, e.g. when the recipient's mailbox is full. It can be the same as `emailTo`, or the address of the person maintaining the Eltern-Emailer installation. Keep in mind that bounced emails contain the full content, i.e. sensitive personal information.

`checkIntervalMinutes`
: How frequently the Eltern-Portal website is checked for new content. This is the maximum latency emails sent by Eltern-Emailer have relative to the content becoming visible online. Please keep this value at the default of 30 minutes (or higher) to limit traffic to the site.

`smtpWaitSeconds`
: Time to wait between sending emails. SMTP servers typically reject messages when they are enqueued too quickly.

`once`
: Run only once and terminate. By default the application keeps running, rechecking every `checkIntervalMinutes`.

`mute`
: Don't actually send emails. Useful to avoid email flood on first run.

`test`
: Only send test emails, as described in [Installation](#installation) above.

`logLevel`
: The level of detail in the log file and console. These are [npm logging levels](https://github.com/winstonjs/winston#logging-levels).

## Running the Application

Eltern-Emailer runs in the Node.js runtime environment. It does not use the portal's indication of new content (because that is reset when you access the content manually, and it's also not supported for all types of content). Instead it uses a file called `state.json` to remember which content has already been emailed and detect which is new.

Initially this file does not exist and all content will appear new. If you don't want to get
flooded with emails on the first run, run Eltern-Emailer once with these [flags](#flags):

```
node main.js --mute --once
```

This should print no errors. After it has succeeded there should be a `state.json` file that looks something like this (but likely longer):

```
{
  "threads": {
    "20455": {
      "0": 1
    },
    "21122": {
      "0": 1,
      "1": 1
    },
    "21505": {
      "0": 1
    },
  "letters": {
    "418": 1,
    "419": 1,
    "421": 1,
  }
}
```

Now use your platform's automation (`Startup` directory or Task Scheduler on Windows, cron on
Linux) to have it run Eltern-Emailer as desired. You can start it once and use its own polling
interval management:

```
node main.js
```

This will keep running and poll the website every 30 minutes (configurable in `config.json`).

Alternatively you can pass the `--once` [flag](#flags) and have the OS automation handle the polling interval:

```
node main.js --once
```

To try it out, manually remove one line in `state.json`, e.g. the first line after `"letters":`.
This should trigger an email to you on the next run.

## Flags

The following flags are supported:

`--once`
: See [Configuration: options](#options) above.

`--mute`
: See [Configuration: options](#options) above.

`--test`
: See [Configuration: options](#options) above.

`--config=file.json`
: Set the config filename.

`--ep_password=abc123`
: Specify the Eltern-Portal login password.

`--smtp_password=abc123`
: Specify the SMTP server password.

## Log File

Log messages are sent to the console and to the file `eltern-emailer.log`. The log level can be set in the config file. While the project is in alpha state it defaults to `debug`.

## Components Used

Eltern-Emailer uses the following components:

* [Puppeteer](https://github.com/puppeteer/puppeteer) for automated browsing (&copy; Google Inc., Apache-2.0 license)
* [Nodemailer](https://nodemailer.com/) for sending email (by [Andris Reinman](https://github.com/andris9), by [Seth Vincent](https://github.com/sethvincent), MIT license)
* [winston](https://github.com/winstonjs/winston) for logging (by [Charlie Robbins](https://github.com/indexzero), MIT license)
* [args-and-flags](https://github.com/sethvincent/args-and-flags) for commandline flags (ISC license)
* [content-disposition](https://github.com/jshttp/content-disposition) for attachment filenames (by  [Douglas Christopher Wilson](https://github.com/dougwilson), MIT license)
* [md5](https://github.com/pvorb/node-md5) for MD5 hash (by [Paul Vorbach](https://github.com/pvorb), BSD 3-Clause license)
