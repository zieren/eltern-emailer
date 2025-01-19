#!/bin/bash

# This example checks the server "pi4" for a latency of at most 35 minutes,
# assuming eltern-emailer-monitor.sh is located in ~/bin. Change these
# values for your setup, then use your automation (e.g. cron, systemd) to
# run it with the desired frequency (e.g. every 5 minutes).

MSG=$(~/bin/eltern-emailer-monitor.sh http://pi4:1984 35)
if [[ $? != 0 ]]; then
  notify-send -i dialog-error -a "Eltern-Emailer" "Eltern-Emailer" "$MSG"
else
  echo -e "$MSG"
fi
