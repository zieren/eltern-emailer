---
title: 'Eltern-Emailer'
---

## Resources

* Download the [latest version](https://github.com/zieren/eltern-emailer/releases/latest)
* [GitHub page](https://github.com/zieren/eltern-emailer) with [version history](https://github.com/zieren/eltern-emailer/releases) and [issue tracker](https://github.com/zieren/eltern-emailer/issues)

## Overview

Eltern-Emailer is an unofficial email interface for `*.eltern-portal.org` sites: 

* Retrieves messages from the website and emails them to you (teacher &rarr; parent).
* Receives emails from you and posts them on the website (parent &rarr; teacher).
* Notifies you of upcoming events, news and substitutions (school &rarr; parent).

This has several advantages:

* **Saves time**<br>
You no longer have to log into the portal to check for new information.
* **Supports multiple parents**<br>
Emails can be sent to multiple receivers via regular email forwarding. The portal, on the other hand, works only for a single parent, e.g. it will not highlight new messages for a second parent.
* **Supports the student**<br>
Substitution plan and upcoming events can be sent to the student.
* **Integrates with email based workflows**<br>
All information is in your email client. Fully email-based two-way communication with teachers.
* **Enables search in your email client**

## Project Status

This project is in beta state.

## How it Works

Eltern-Emailer logs into the Eltern-Portal website and checks for new messages and updated content in certain [categories](#_supported-sections-at-head), e.g.

* news in `Aktuelles` and `Schwarzes Brett`
* messages from teachers in `Kommunikation Eltern/Fachlehrer/Klassenleitung`
* the substitution plan in `Vertretungsplan`
* upcoming events (including exams) in `Schulaufgaben/Weitere Termine`

It then sends these messages and updates to you via email.

Optionally, it also checks a dedicated IMAP inbox for emails from you and forwards them to the intended teacher. This allows you to communicate with any teacher entirely via email.

The application does not interact with any third parties except your email provider. It runs on your own desktop or server.

### Requirements

Eltern-Emailer requires the free [Node.js](https://en.wikipedia.org/wiki/Node.js) JavaScript runtime environment. It is tested on the following platforms:

* Windows
* Linux
<a id="_supported-sections-at-head"></a>

### Supported Sections (at HEAD)

The following sections in the web UI are supported:

* `Aktuelles`
* `Kommunikation Eltern/Fachlehrer`
* `Kommunikation Eltern/Klassenleitung`
* `Klassen Vertretungsplan`
* `Schwarzes Brett`
* `Schulaufgaben / Weitere Termine`

### Planned Features

* Send messages to "Klassenleitung".
* Run on a Raspberry Pi.

Schools use different feature subsets of the portal. If a feature is missing for your school, let me know or, even better, contribute code.
<a id="_installation"></a>

## Installation

1. Install [Node.js](https://nodejs.org/).
1. Download the latest [release](https://github.com/zieren/eltern-emailer/releases) and unpack it to an installation directory of your choice.
1. In that directory, run this command to install the required dependencies:
   ```
   npm install args-and-flags content-disposition imapflow mailparser md5 nodemailer puppeteer winston
   ```
   This downloads 400+MB (because it includes a Chromium binary). You can continue with the next step in the meanwhile.
1. Edit the file `config.json` to specify your login credentials, SMTP/IMAP servers etc. All uppercase parts need to be replaced. If you don't want to store credentials in a file you can pass them via commandline flags (see [Flags](#_flags)). See section [Configuration](#_configuration) below for a detailed description of all options.

   **WARNING**
   Keep in mind that the emails sent may contain sensitive personal information. Be sure to specify the correct `emailTo` and `emailFrom` addresses in the config file.
1. Run the application once in test mode to verify the credentials for the website and the email server, and to be sure the `emailTo` and `emailFrom` addresses are correct:
   ```
   node main.js --test --once
   ```
   This will send two test emails, one to the regular recipient (`emailTo`) and one to the sender's return address (`emailFrom`). The latter is where an undeliverable email would bounce to. The test emails only say how many emails would have been sent in normal mode. They contain no personal information. Verify that both emails arrive at the correct addresses.
<a id="_configuration"></a>

## Configuration

The following sections describe the homonymous parts in the `config.json` file.

### `elternportal`

These parameters are used to log into the Eltern-Portal.

* `url` The URL of your school's Eltern-Portal, e.g. `https://theogymuc.eltern-portal.org`
* `user` The login email address
* `pass` The login password

### `smtp`

These parameters configure the SMTP transport in the Nodemailer module. The full set of options described in the [Nodemailer documentation](https://nodemailer.com/smtp/) is available. The default values for `port` (465) and `secure` (true) work well for many servers (e.g. Outlook web mail), but yours may require different settings.
<a id="_imap"></a>

### `imap`

These parameters configure Eltern-Emailer to check a dedicated IMAP mailbox for incoming email. The full set of options described in the [ImapFlow documentation](https://imapflow.com/module-imapflow-ImapFlow.html) is available.

IMAP support is optional and must be turned on via `incomingEmail.enabled` in the [`options`](#_options) section. It enables two features: [Sending messages to teachers](#_sending-messages-to-teachers) and [reducing latency](#_reducing-latency).
<a id="_options"></a>

### `options`

These control the behavior of Eltern-Emailer.

* `emailTo` The recipient of all emails sent by the application. Specify only the address, not the real name. This will typically be a parent's email address, or an address that forwards to both parents.
* `emailToStudent` The student's email address (optional; may be empty). If set, information intended for the student (currently substitution plan updates and upcoming events) will additionally be sent to this address.
* `emailFrom` The sender used for all emails sent by the application. Specify only the address, not the name. This is where bounced emails are delivered to, e.g. when the recipient's mailbox is full. It can be the same as `emailTo`, or the address of the person maintaining the Eltern-Emailer installation. Note that bounced emails contain the full content, i.e. sensitive personal information.
* `incomingEmail` This groups options related to incoming email.
   * `enabled` Check the IMAP inbox specified under [`imap`](#_imap). See [Sending Messages to Teachers](#_sending-messages-to-teachers) and [Reducing Latency](#_reducing-latency).
   * `forwardingAddress` The email address of the IMAP inbox to be forwarded to teachers. This enables replying to threads with teachers by email.
   * `allowForwardingFrom` List of email addresses allowed to send email to teachers. See [Protection Against Impersonation](#_protection-against-abuse).
* `eventLookaheadDays` For notification of upcoming events. This controls how long in advance you (and possibly the student, see `emailToStudent`) are notified. Each event triggers only one notification, so e.g. 14 means you are notified two weeks in advance and have to keep it in mind from then on.
* `checkIntervalMinutes` How frequently the Eltern-Portal website is checked for new content. This determines the maximum latency emails sent by Eltern-Emailer have relative to the content becoming visible online. Please keep this value at the default of 30 minutes (or higher) to limit traffic to the site.
* `smtpWaitSeconds` Time to wait between sending emails. SMTP servers typically reject messages when they are enqueued too quickly.
* `once` Run only once and terminate. By default the application keeps running, rechecking every `checkIntervalMinutes`.
* `mute` Don't actually send emails, but update state. The next run will consider all messages sent. Useful to avoid email flood on first run.
* `test` Only send test emails, as described in [Installation](#_installation) above.
* `logLevel` The level of detail in the log file and console. These are [npm logging levels](https://github.com/winstonjs/winston#logging-levels).
<a id="_sending-messages-to-teachers"></a>

### Sending Messages to Teachers

Eltern-Emailer can receive emails from you and forward them to teachers via the website. This requires a dedicated email account accessible via IMAP (see [`imap`](#_imap) above). The provider needs to support [subaddressing](https://en.wikipedia.org/wiki/Email_address#Subaddressing), i.e. `username+tag@example.com`. Outlook web mail is known to work.

The message size limit enforced by the website does not apply here. If your email is longer than 512 characters (I'm not sure if all schools use the same limit; currently this value is hard-coded), it is automatically split up.
<a id="_protection-against-abuse"></a>

#### Protection Against Impersonation

!! Emails received at the `incomingEmail.forwardingAddress` are forwarded to teachers using your identity the portal. This constitutes an impersonation risk. Securely preventing impersonation would require signing messages in the email client and verifying the signature in Eltern-Emailer. This is not supported.

To make impersonation unlikely you should choose an email address that is hard to guess, e.g. `qmqztwrp3g2em78qatms@example.com`, and never publish it. In the config file, specify this address under `incomingEmail.forwardingAddress`.

! Note that the address may be included in the headers of emails sent to you from Eltern-Emailer, so forwarding such messages with headers would reveal it to the recipient. Also, sending emails to this address with additional recipients in the To: or Cc: would reveal the address to those recipients.

To prevent accidental/unskilled impersonation in case the address does leak, Eltern-Emailer performs a simple header check for the sender specified in the From: line. Allowed senders (i.e. the parents) are specified in `incomingEmail.allowForwardingFrom`.

#### Replying to a Teacher

When you receive an email for a thread in `Kommunikation Eltern/Fachlehrer` you can simply reply to it. Eltern-Emailer encodes the teacher and thread ID in the message ID and will extract them from the reply. You can add other teachers to the To: or Cc: headers, which will open a new thread with them.

#### Initial Email to a Teacher

Sending an initial email to a teacher requires a per-teacher setup. Visit the teacher's contact link in the portal under `Kommunikation Eltern/Fachlehrer`, then copy the numerical teacher ID from the URL. E.g. for `https://*.eltern-portal.org/meldungen/kommunikation_fachlehrer/123/Doe_John` this would be 123. Create a contact in your email client with the name of the teacher and the above email address with the teacher ID as a tag, e.g. `qmqztwrp3g2em78qatms+123@example.com`. When you now type the teacher's name in your email client, it should autocomplete the email address including the tag.
<a id="_reducing-latency"></a>

### Reducing Latency

Eltern-Emailer can check for the notification email sent by the portal whenever a new message is available. This requires a dedicated email account as described [above](#_sending-messages-to-teachers). As soon as a notification (or any message, actually) is received, the portal is checked immediately.

You can simply configure the email account you are currently using for the portal to forward notification emails or simply all emails to this dedicated address. Emails that are not notifications (e.g. sick leave confirmations) will also trigger a check, but this is rare and should not cause problems. Also, since these forwarded notifications (or any other forwarded messages) will not have the `incomingEmail.forwardingAddress` in their recipients, they can be distinguished from messages intended for teachers and are not processed.

## Running the Application

Eltern-Emailer runs in the Node.js runtime environment. It does not use the portal's indication of new messages (because that is reset when you read them online, and it's also not supported for some types of content). Instead it uses a file called `state.json` to remember which content has already been emailed and detect which is new.

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

## Flags

The following flags are supported:

* `--once` See [Configuration: options](#_options) above.
* `--mute` See [Configuration: options](#_options) above.
* `--test` See [Configuration: options](#_options) above.
* `--config=file.json` Set the config filename.
* `--ep_password=abc123` Specify the Eltern-Portal login password.
* `--smtp_password=abc123` Specify the SMTP server password.
* `--imap_password=abc123` Specify the IMAP server password.

## Log File

Log messages are shown on the console and written to the file `eltern-emailer.log`. The log level can be set in the config file. While the project is in alpha state it defaults to `debug`.

## Components Used

Eltern-Emailer uses the following components:

* [Puppeteer](https://github.com/puppeteer/puppeteer) for automated browsing (&copy; Google Inc., Apache-2.0 license)
* [Nodemailer](https://github.com/nodemailer/nodemailer), [imapflow](https://github.com/postalsys/imapflow) and [mailparser](https://github.com/nodemailer/mailparser) for sending/receiving/parsing email (MIT and custom licenses)
* [winston](https://github.com/winstonjs/winston) for logging (MIT license)
* [args-and-flags](https://github.com/sethvincent/args-and-flags) for commandline flags (ISC license)
* [content-disposition](https://github.com/jshttp/content-disposition) for attachment filenames (MIT license)
* [md5](https://github.com/pvorb/node-md5) for MD5 hash (BSD 3-Clause license)
