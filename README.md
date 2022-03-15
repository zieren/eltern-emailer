# Eltern-Emailer

Unofficial email interface for `*.eltern-portal.org` sites: Retrieves messages from the web and
emails them to you. This saves time, enables text search and integrates with email based workflows.

## Project Status

This project is in alpha state.

### Supported Platforms

* Windows
* Linux
* Probably others where Node.js is available

### Current Features

The following information sources (sections in the web UI) are supported:

* `Aktuelles`
* `Kommunikation Eltern/Fachlehrer`

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

## Installation

1. Install [Node.js](https://nodejs.org/).
1. Download the latest [release](https://github.com/zieren/eltern-emailer/releases) and unpack it
   to an installation directory of your choice.
1. In that directory, run this command to install the required dependencies:
   ```
   npm install content-disposition nodemailer puppeteer winston
   ```
   This downloads 400+MB. You can continue with the next steps in the meanwhile.
1. Edit the file `config.json` to specify your login credentials, SMTP server etc. All uppercase
   parts need to be replaced. If you don't want to store credentials in a file you can pass them
   via commandline flags (see below).
1. Start the application:
   ```
   node main.js
   ```
   The following flags are supported:
   `--config=file.json`: Set the config filename.
   `--ep_password=abc123`: Specify the portal login password.
   `--smtp_password=abc123`: Specify the SMTP server password.
