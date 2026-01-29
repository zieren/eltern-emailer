---
title: 'Eltern-Emailer'
---

## Resources

* [Download the latest version](https://github.com/zieren/eltern-emailer/releases/latest)
* [GitHub page](https://github.com/zieren/eltern-emailer) with [version history](https://github.com/zieren/eltern-emailer/releases) and [issue tracker](https://github.com/zieren/eltern-emailer/issues)

## Overview

Eltern-Emailer is an unofficial email interface for communicating with German schools using `*.isy-schule.de`, `schulmanager-online.de` or `*.eltern-portal.org`. It allows you to simply use your email client instead of having to log into yet another website. This has several advantages:

* **Saves time**<br>
You see new information immediately, including attachments.
* **Supports multiple parents**<br>
Emails can be sent to multiple recipients. There is no issue with one parent resetting a message's `unread` status for the other parent.
* **Supports the student**<br>
General information such as substitution plan updates and upcoming events can be sent to the student or even to other parents.
* **Integrates with email based workflows**<br>
All information is in your email client, enabling a fully email-based two-way communication with teachers.
* **Enables search in your email client**
* **Integrates with Google Calendar**<br>
Events can be added from the notification email with a single click.

Primarily `*.eltern-portal.org` is supported:

* Retrieve messages from the website and email them to you (teacher &rarr; parent).
* Receive emails from you and post them on the website (parent &rarr; teacher).
* Notify you of upcoming events, news and substitutions (school &rarr; parent).

Additionally, there is limited support for `isy-schule.de` and `schulmanager-online.de`:

* Retrieve messages ("Elternbriefe") 

## How it Works

Eltern-Emailer logs into `yourschool.eltern-portal.org` and checks for new messages and updated content in certain [categories](#_supported-sections-at-head), e.g.

* news in `Aktuelles` and `Schwarzes Brett`
* messages from teachers in `Kommunikation Eltern/Fachlehrer/Klassenleitung`
* the substitution plan in `Vertretungsplan`
* upcoming events (including exams) in `Schulaufgaben/Weitere Termine`

It then sends these messages and updates to you via email.

Optionally, it also checks a dedicated IMAP inbox for emails from you and forwards them to the intended teacher. This allows you to communicate with any teacher entirely via email.

The application does not interact with any third parties except your email provider. It runs on your own desktop or server. A simple tool is included to monitor the server's status and alert in case of issues.

### Requirements

Eltern-Emailer requires the free [Node.js](https://en.wikipedia.org/wiki/Node.js) JavaScript runtime environment. It is tested on the following platforms:

* Windows
* Linux

Recent models of the Raspberry Pi are supported (tested on model 4, but model 3 should also work). See option `customBrowserExecutable` below.

The server monitor is an [AutoHotkey](https://www.autohotkey.com/) script, i.e. it runs on Windows.

<a id="_supported-sections-at-head"></a>
### Supported Sections (at HEAD)

Schools use different feature subsets. If a feature is missing for your school, let me know or, even better, contribute code.

#### Eltern-Portal

The following sections in the web UI are supported:

* `Aktuelles`
* `Kommunikation Eltern/Fachlehrer` (including attachments)
* `Kommunikation Eltern/Klassenleitung`
* `Klassen Vertretungsplan`
* `Schwarzes Brett` (no support for attachments yet)
* `Schulaufgaben / Weitere Termine`

#### Schulmanager

Only `Elternbriefe` (messages to parents) are currently supported.
<a id="_installation"></a>

## Installation

1. Install [Node.js](https://nodejs.org/).
1. Download the latest [release](https://github.com/zieren/eltern-emailer/releases) and unpack it to an installation directory of your choice.
1. In that directory, run this command to install the required dependencies:
   ```
   npm install args-and-flags content-disposition fs-extra imapflow mailparser md5 nodemailer puppeteer winston
   ```
1. Edit the file `config.json` to specify your login credentials, SMTP/IMAP servers etc. All uppercase parts in the sections you want to enable need to be replaced. If you don't want to store credentials in a file you can pass them via commandline flags (see [Flags](#_flags)). See section [Configuration](#_configuration) below for a detailed description of all options.

   **WARNING**
   Keep in mind that the emails sent may contain sensitive personal information. Be sure to specify the correct recipient addresses in the config file.
1. Run the application once in test mode to verify the credentials for the website and the email server:
   ```
   node main.js --test --once
   ```
   This will send a test email to the `adminAddress` specified under `options`. The message only says how many emails would have been sent in normal mode.
1. If you are running Eltern-Emailer on a remote server (Linux or Windows) and using Windows on your desktop, you may want to install [AutoHotkey](https://www.autohotkey.com/) and use the `monitor.ahk` script to monitor the server's status. Open `Configuration` from the tray icon menu to specify the monitoring parameters, allowing a staleness of more than `checkIntervalMinutes` (see [Configuration: options](#_options)).
<a id="_configuration"></a>

## Configuration

The following sections describe the homonymous parts in the `config.json` file. The file can be edited while the application is running. However, changes to logging or IMAP related options require a restart.

### `elternportal`

These parameters are used to process Eltern-Portal. To disable Eltern-Portal, leave the defaults unchanged or remove the whole `elternportal` section.

* `url` The URL of your school's Eltern-Portal, e.g. `https://theogymuc.eltern-portal.org`
* `user` The login email address
* `pass` The login password
* `tag` A short name used to identify the school in emails and calendar events
* `eventLookaheadDays` For notification of upcoming events. This controls how long in advance you (and possibly the student, see `emailToStudent`) are notified. Each event triggers only one notification, so e.g. 14 means you are notified two weeks in advance and have to keep it in mind from then on.
* `messageSizeLimit` Emails you send to teachers are automatically split up if they exceed this length (in characters). The default is 512, but the actual limit may vary. Check your school's site, ask them or try it out.
* `timeoutSeconds` This specifies the page timeout (e.g. for navigation). If absent or zero, the default is used (30s).
* `fileDownloadWaitSeconds` Time to wait between downloads of file attachments. Downloading multiple files, e.g. on the first run, may require this to avoid errors.
* `recipients` This controls who receives the different categories of messages. Each takes a comma-separated list of zero or more addresses, enclosed in `[]`.
  * `*` Receives everything
  * `lehrerkommunikation` Personal messages from teachers to parents ("Kommunikation Eltern/Fachlehrer" and ".../Klassenleitung")
  * The rest is self-explanatory. You may want to specify the student for some categories, e.g. `vertretungsplan` and `termine`.

### `schulmanager`

These parameters are used to process Schulmanager. To disable Schulmanager, leave the defaults unchanged or remove the whole `schulmanager` section.

* `user` The login email address
* `pass` The login password
* `school` If your Schulmanager account is linked to multiple schools (e.g. multiple children, or after switching schools when the old account is still enabled), you are prompted to select a school on login. In this case, specify the name of the school or a unique part (e.g. "Heresbach" for "Konrad-Heresbach-Gymnasium"). Matching is case sensitive. If there is no selection dialog, this is ignored.
* `tag` A short name used to identify the school in emails
* `timeoutSeconds` This specifies the page timeout (e.g. for navigation). If absent or zero, the default is used (30s).
* `recipients` This controls who receives the different categories of messages. Each takes a comma-separated list of zero or more addresses, enclosed in `[]`.
  * `*` Receives everything (though there is currently only one category, but more may be added in later versions)
  * `elternbriefe` Self-explanatory

### `smtp`

These parameters configure the SMTP transport in the Nodemailer module. The full set of options described in the [Nodemailer documentation](https://nodemailer.com/smtp/) is available. The default values for `port` (465) and `secure` (true) should work for most servers.
<a id="_imap"></a>

### `imap`

These parameters configure Eltern-Emailer to check a dedicated IMAP mailbox for incoming email. The full set of options described in the [ImapFlow documentation](https://imapflow.com/module-imapflow-ImapFlow.html) is available.

IMAP support is optional and must be turned on via `incomingEmail.enabled` in the [`options`](#_options) section. It enables two features: [Sending messages to teachers](#_sending-messages-to-teachers) and [reducing latency](#_reducing-latency).
<a id="_options"></a>

### `options`

These control the behavior of Eltern-Emailer.

* `customBrowserExecutable` A Chromium browser executable (full path) to use instead of the one bundled with Puppeteer. For Raspberry Pi OS (and possibly other Linuxes) this should be `/usr/bin/chromium-browser`.
* `adminAddress` The sender (From:) used for all emails sent by the application. This is where bounced emails are delivered to, e.g. when the recipient's mailbox is full. Note that bounced emails typically contain the full content, i.e. possibly sensitive personal information. Error messages are also sent to this address.
* `useBcc` Use `Bcc:` instead of `To:` when sending email to multiple recipients.
* `incomingEmail` This groups options related to incoming email.
   * `enabled` Check the IMAP inbox specified under [`imap`](#_imap). See [Sending Messages to Teachers](#_sending-messages-to-teachers) and [Reducing Latency](#_reducing-latency).
   * `forwardingAddress` The email address of the IMAP inbox to be forwarded to teachers. This enables replying to threads with teachers by email.
   * `allowForwardingFrom` List of email addresses allowed to send email to teachers. See [Protection Against Impersonation](#_protection-against-abuse).
* `checkIntervalMinutes` How frequently the Eltern-Portal website is checked for new content. This determines the maximum latency emails sent by Eltern-Emailer have relative to the content becoming visible online. Please keep this value at the default of 30 minutes (or higher) to limit traffic to the site.
* `smtpWaitSeconds` Time to wait between sending emails. SMTP servers typically reject messages when they are enqueued too quickly.
* `statusServerPort` Local port to use for the status monitoring server (zero to disable).
* `once` Run only once and terminate. By default the application keeps running, rechecking every `checkIntervalMinutes`.
* `mute` Don't actually send emails, but update state. The next run will consider all messages sent. Useful to avoid email flood on first run.
* `test` Only send test emails, as described in [Installation](#_installation) above.
* `logLevel` The level of detail in the log file and console. These are [npm logging levels](https://github.com/winstonjs/winston#logging-levels).
<a id="_sending-messages-to-teachers"></a>

### Sending Messages to Teachers (Eltern-Portal Only)

Eltern-Emailer can receive emails from you and forward them to teachers via the website. This requires a dedicated email account accessible via IMAP (see [`imap`](#_imap) above) using basic auth, i.e. username/password. OAuth, which most providers require these days, is not supported. The provider needs to support [subaddressing](https://en.wikipedia.org/wiki/Email_address#Subaddressing), i.e. `username+tag@example.com`. [Zoho Mail](http://zoho.com) is known to work.

The website may limit the size of individual messages you send to teachers. If your email exceeds the limit, Eltern-Emailer automatically splits it up. The size limit is configurable (see `elternportal.messageSizeLimit` in [Configuration](#_configuration)) because it may vary between schools/installations. The default is 512 characters.
<a id="_protection-against-abuse"></a>

#### Protection Against Impersonation

!! Emails received at the `incomingEmail.forwardingAddress` are forwarded to teachers using your login to the website. This constitutes an impersonation risk. Securely preventing impersonation would require signing messages in the email client and verifying the signature in Eltern-Emailer. This is not supported.

To make impersonation unlikely you should choose an email address that is hard to guess, e.g. `qmqztwrp3g2em78qatms@example.com`, and never publish it. In the config file, specify this address under `incomingEmail.forwardingAddress`.

! Note that the address may be included in the headers of emails sent to you from Eltern-Emailer, so forwarding such messages with headers would reveal it to the recipient. Also, sending emails to this address with additional recipients in the To: or Cc: would reveal the address to those recipients.

To prevent accidental/unskilled impersonation in case the address does leak, Eltern-Emailer performs a simple header check for the sender specified in the From: line. Allowed senders (i.e. the parents) are specified in `incomingEmail.allowForwardingFrom`.

#### Replying to a Teacher

When you receive an email for a thread in `Kommunikation Eltern/Fachlehrer` you can simply reply to it. Eltern-Emailer encodes the teacher and thread ID in the message ID and will extract them from the reply. You can add other teachers to the To: or Cc: headers, which will open a new thread with them.

#### Initial Email to a Teacher

Sending an initial email to a teacher requires a per-teacher setup. Visit the teacher's contact link on the website under `Kommunikation Eltern/Fachlehrer`, then copy the numerical teacher ID from the URL. E.g. for `https://*.eltern-portal.org/meldungen/kommunikation_fachlehrer/123/Doe_John` this would be 123. Create a contact in your email client with the name of the teacher and the above email address with the teacher ID as a tag, e.g. `qmqztwrp3g2em78qatms+123@example.com`. When you now type the teacher's name in your email client, it should autocomplete the email address including the tag.
<a id="_reducing-latency"></a>

### Reducing Latency

Eltern-Emailer can check for the notification email sent by the website whenever a new message is available. This requires a dedicated email account as described [above](#_sending-messages-to-teachers). As soon as a notification (or any message, actually) is received, the website is checked immediately.

You can simply configure the email account you are currently using for the website to forward notification emails or simply all emails to this dedicated address. Emails that are not notifications (e.g. sick leave confirmations) will also trigger a check, but this is rare and should not cause problems. Also, since these forwarded notifications (or any other forwarded messages) will not have the `incomingEmail.forwardingAddress` in their recipients, they can be distinguished from messages intended for teachers and are not processed.

## Running the Application

Eltern-Emailer runs in the Node.js runtime environment. It does not use the website's indication of new messages (because that is reset when you read them online, and it's also not available for some types of content). Instead it uses a file called `state.json` to remember which content has already been emailed and detect which is new. This file is reread before each check; for debugging it can be edited while the application is waiting for the next check.

Initially this file does not exist and all messages and content will appear new. If you don't want to get flooded with emails on the first run, run Eltern-Emailer once with these [flags](#_flags):

```
node main.js --mute --once
```

This should print no errors. After it has succeeded there should be a `state.json` file with some entries.

Now use your platform's automation (`Startup` directory or Task Scheduler on Windows, cron on
Linux) to have it run Eltern-Emailer as desired. You can start it once and use its own polling
interval management:

```
node main.js
```

This will keep running and poll the website regularly (see `checkIntervalMinutes` in [Configuration: options](#_options)).

Alternatively you can pass the `--once` [flag](#_flags) and have the OS automation handle the polling interval:

```
node main.js --once
```

To try it out, manually remove one line in `state.json`, e.g. the first line after `"letters":`. This should trigger an email to you on the next run.
<a id="_flags"></a>

### Terminating

The `SIGTERM` signal can be used to do a graceful shutdown (which may take a few seconds).

### Running as a docker container

If you want to run this application in a docker container, you first have to build it:

```
docker build -t eltern-emailer .
```

You need a storage directory for the `state.json`:

```
mkdir -p $PWD/data/
```

Then you can run it like this:

```
docker run -it -p 1984:1984 --name eltern-emailer --rm --init \
 --mount type=bind,source=$PWD/config.json,target=/conf/config.json \
 --volume $PWD/data/:/data/ eltern-emailer
```

## Flags

The following flags are supported:

* `--once` See [Configuration: options](#_options) above.
* `--mute` See [Configuration: options](#_options) above.
* `--test` See [Configuration: options](#_options) above.
* `--config=file.json` Set the config filename.
* `--state=state.json` Set the state filename.
* `--no_sandbox` Run Puppeteer in [no-sandbox mode](https://github.com/puppeteer/puppeteer/blob/main/docs/troubleshooting.md) so [not requiring capability SYS_ADMIN](https://lwn.net/Articles/486306/), needed when [running in an unprivileged docker container](https://pptr.dev/guides/docker)
* `--ep_password=abc123` Specify the Eltern-Portal login password.
* `--sm_password=abc123` Specify the Schulmanager login password.
* `--smtp_password=abc123` Specify the SMTP server password.
* `--imap_password=abc123` Specify the IMAP server password.

Passwords are accepted from different sources with the following priority:
1. Passwords specified on the command line override passwords from `config.json`
2. Passwords in `config.json` are the default
3. Passwords from environment variables are taken as fallback, if there is neither a password in
   `config.json` nor on the command line

## Environment variables

The following environment variables are supported:

* `EP_PASSWORD` Specify the Eltern-Portal login password.
* `SM_PASSWORD` Specify the Schulmanager login password.
* `SMTP_PASSWORD` Specify the SMTP server password.
* `IMAP_PASSWORD` Specify the IMAP server password.

## Log File

Log messages are shown on the console and written to the file `eltern-emailer.log` Log files are rotated at 10MB, keeping at most three files. The log level can be set in the config file. It defaults to `debug`.

## Components Used

Eltern-Emailer uses the following components:

* [Puppeteer](https://github.com/puppeteer/puppeteer) for automated browsing (&copy; Google Inc., Apache-2.0 license)
* [Nodemailer](https://github.com/nodemailer/nodemailer), [imapflow](https://github.com/postalsys/imapflow) and [mailparser](https://github.com/nodemailer/mailparser) for sending/receiving/parsing email (MIT and custom licenses)
* [AutoHotkey](https://www.autohotkey.com/) for the monitoring tool (GNU GPLv2)
* [winston](https://github.com/winstonjs/winston) for logging (MIT license)
* [fs-extra](https://github.com/jprichardson/node-fs-extra) for file system utilities (MIT license)
* [args-and-flags](https://github.com/sethvincent/args-and-flags) for commandline flags (ISC license)
* [content-disposition](https://github.com/jshttp/content-disposition) for attachment filenames (MIT license)
* [md5](https://github.com/pvorb/node-md5) for MD5 hash (BSD 3-Clause license)
