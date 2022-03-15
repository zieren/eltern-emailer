# Eltern-Emailer

Unofficial email interface for `*.eltern-portal.org` sites: Retrieves messages from the web and
emails them to you. This saves time, enables text search and integrates with email based workflows.

## How it Works

Eltern-Emailer logs into the Eltern-Portal website and checks for new content in certain
[categories](#current-features), e.g. `Aktuelles`. It then sends this content to you via email.

The application does not interact with any third parties except your email provider. It runs on 
your own desktop or server.

Currently only timed polling is supported. Event-based polling (triggered by the notification email)
is [planned](#planned-features).

## Project Status

This project is in alpha state.

### Requirements

The application requires the free [Node.js](https://en.wikipedia.org/wiki/Node.js) JavaScript 
runtime environment. It is tested on the following platforms:

* Windows
* Linux

### Current Features

The following information sources (sections in the web UI) are supported:

* `Aktuelles`
* `Kommunikation Eltern/Fachlehrer`

(I know, only two. That's why it's in alpha state.)

### Planned Features

The following information sources are on my radar (roughly in order of priority):

* `Kommunikation Eltern/Klassenleitung`
* `Klassen Vertretungsplan`
* `Schulaufgaben / Weitere Termine`
* `Schwarzes Brett`

Schools use different feature subsets of the portal. If a feature is missing for your school, let me
know or, even better, contribute code.

Other planned features:

* Check for the portal's notification email instead of polling every N minutes.
* Run on a Raspberry Pi.

## Installation

1. Install [Node.js](https://nodejs.org/).
1. Download the latest [release](https://github.com/zieren/eltern-emailer/releases) and unpack it
   to an installation directory of your choice.
1. In that directory, run this command to install the required dependencies:
   ```
   npm install args-and-flags content-disposition nodemailer puppeteer winston
   ```
   This downloads 400+MB. You can continue with the next steps in the meanwhile.
1. Edit the file `config.json` to specify your login credentials, SMTP server etc. All uppercase
   parts need to be replaced. If you don't want to store credentials in a file you can pass them
   via commandline flags (see [Flags](#flags)).

## Running the Application

The application runs in the Node.js runtime environment. It does not use the portal's indication of
new content (because that is reset when you log in manually, and it's also not supported for all 
types of content). Instead it uses a file called `state.json` to remember which content has already
been emailed and detect which is new.

Initially this file is empty and all content will appear new. If you don't want to get flooded with
emails for all existing content, run Eltern-Emailer once with these [flags](#flags):

```
node main.js --mute --once
```

This should print no errors. After it has succeeded there should be a `state.json` file that looks something like this:

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

Use your platform's automation (Task Scheduler on Windows, cron on Linux) to
run Eltern-Emailer as desired. You can have it started once and use its own polling interval
management:

```
node main.js
```

This will keep running and poll the website every 30 minutes (configurable in `config.json`).

Alternatively you can pass the `--once` [flag](#flags) and have the automation handle the polling interval:

```
node main.js --once
```

## Flags

The following flags are supported:

* `--mute`: Don't actually send emails. **Useful to avoid email flood on first run.**
* `--once`: Check only once and exit, instead of checking every N minutes.
* `--config=file.json`: Set the config filename.
* `--ep_password=abc123`: Specify the portal login password.
* `--smtp_password=abc123`: Specify the SMTP server password.

## Components Used

Eltern-Emailer uses the following components:

* [Puppeteer](https://github.com/puppeteer/puppeteer) for automated browsing (&copy; Google Inc., Apache-2.0 license)
* [args-and-flags](https://github.com/sethvincent/args-and-flags) for commandline flags (ISC license)
* [Nodemailer](https://nodemailer.com/) for sending email (by [Andris Reinman](https://github.com/andris9), by [Seth Vincent](https://github.com/sethvincent), MIT license)
* [winston](https://github.com/winstonjs/winston) for logging (by [Charlie Robbins](https://github.com/indexzero), MIT license)
* [content-disposition](https://github.com/jshttp/content-disposition) for attachment filenames (by  [Douglas Christopher Wilson](https://github.com/dougwilson), MIT license)
