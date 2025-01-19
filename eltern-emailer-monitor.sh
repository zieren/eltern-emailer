#!/bin/bash

if [[ $# -lt 2 ]]; then
  echo "Syntax: $(basename $0) <status URL> <max minutes>"
  exit 1
fi

# Times in (epoch) seconds.
LAST_CHECK=$(( ($(curl -s $1) + 0) / 1000 )) # +0 to handle curl returning "" on failure
MAX_LATENCY=$(( $2 * 60 ))
NOW=$(date +%s)

echo Last check: $(date -d @$LAST_CHECK "+%Y-%m-%d %H:%M:%S")

if [[ $NOW -gt $(($LAST_CHECK + $MAX_LATENCY)) ]]; then
  echo FAILURE
  exit 1
fi

echo OK
