#!/bin/sh
set -e
IMAGE=eltern-emailer
docker build -t $IMAGE .
docker stop $IMAGE 2>/dev/null || true
mkdir -p $PWD/data/
docker run -it -p 1984:1984 --name $IMAGE --rm --init \
 --mount type=bind,source=$PWD/config.json,target=/conf/config.json \
 --volume $PWD/data/:/data/ \
 $IMAGE
