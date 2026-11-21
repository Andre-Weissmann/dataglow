#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p fixtures
# Fully synthetic, no personal recordings. Tone in RIGHT channel catches the
# old first-channel-only bug. Tiny black video ensures visual content unused.
ffmpeg -hide_banner -loglevel error -y -f lavfi -i 'color=c=black:s=64x64:r=10:d=2' \
  -f lavfi -i 'aevalsrc=0|0.3*sin(2*PI*440*t):s=48000:d=2' \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest fixtures/right-channel.mp4
ffmpeg -hide_banner -loglevel error -y -i fixtures/right-channel.mp4 -c copy fixtures/right-channel.mov
ffmpeg -hide_banner -loglevel error -y -i fixtures/right-channel.mp4 -c:v libvpx-vp9 -c:a libopus fixtures/right-channel.webm
ffmpeg -hide_banner -loglevel error -y -i fixtures/right-channel.mp4 -an -c:v copy fixtures/no-audio.mp4
ffmpeg -hide_banner -loglevel error -y -i fixtures/right-channel.mp4 -map 0:v -map 0:a -map 0:a -c copy fixtures/two-tracks.mp4
ffmpeg -hide_banner -loglevel error -y -i fixtures/right-channel.mp4 -c:v copy -c:a adpcm_ima_qt fixtures/unsupported.mov
ffmpeg -hide_banner -loglevel error -y -f lavfi -i 'color=c=black:s=16x16:r=1:d=601' \
  -f lavfi -i 'anullsrc=r=8000:cl=mono' -t 601 -c:v libx264 -c:a aac fixtures/too-long.mp4
ffmpeg -hide_banner -loglevel error -y -f lavfi -i 'color=c=black:s=64x64:r=10:d=6' \
  -f lavfi -i "flite=text='This is a local test. Review the transcript before importing the data.':voice=slt" \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest fixtures/speech.mp4
