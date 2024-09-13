# see https://pptr.dev/guides/docker and https://github.com/puppeteer/puppeteer/pkgs/container/puppeteer
FROM ghcr.io/puppeteer/puppeteer:23
RUN npm install args-and-flags content-disposition fs-extra imapflow mailparser md5 nodemailer winston
COPY --chown=node:node *.js .
EXPOSE 1984
CMD [ "node", "main.js", "--no_sandbox", "--config", "/conf/config.json", "--state", "/data/state.json" ]
