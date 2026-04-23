---
title: Vessel Browser
emoji: 🚢
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
---

# Vessel Browser — AI-Native Web Browser for Linux

Interactive demo of [Vessel Browser](https://github.com/unmodeled-tyler/quanta-vessel-browser), an AI-native web browser for Linux with persistent browser runtime for autonomous agents and human supervision.

## What you're seeing

This Space runs Vessel Browser in a Docker container with a virtual display, streamed to your browser via noVNC. You have full interactive access — click, type, scroll, and navigate just like a local browser.

## Features

- Full Chromium-based browsing via Electron
- Built-in MCP (Model Context Protocol) server for AI agent control
- Session and tab management
- Bookmark and history tracking
- Ad blocking
- Content extraction tools

## Usage

1. Click **full screen** in the bottom-right of the viewer for the best experience
2. Interact with the browser as you would locally
3. The container resets when the Space sleeps — no data persists between sessions

## Deploying your own Space

To create your own Vessel Browser Space:

1. **Fork** the [vessel-browser repo](https://github.com/unmodeled-tyler/quanta-vessel-browser)
2. **Create a new [Docker Space](https://huggingface.co/new-space)** on Hugging Face
3. **Clone your Space repo** and add the vessel-browser fork as a remote
4. **Copy deployment files** from `hf-space/` to the repo root:
   ```bash
   cp hf-space/Dockerfile .
   cp hf-space/entrypoint.sh .
   cp hf-space/.dockerignore .
   # Replace the Space README with the HF metadata version
   cp hf-space/README.md .
   ```
5. **Commit and push** — Hugging Face will build and deploy automatically

> **Why `Dockerfile` pulls a pre-built image instead of building from source:**
> The full build (`npm ci` + `npm run build` inside the container) exceeds the memory limit on Hugging Face Spaces free tier (`cpu-basic`). The default `Dockerfile` uses a pre-built image from GitHub Container Registry. If you need to build from source locally or on a paid tier, use `Dockerfile.full-build` instead.

## Tech Stack

- [Electron](https://www.electronjs.org/) — Chromium browser runtime
- [SolidJS](https://www.solidjs.com/) — UI renderer
- [noVNC](https://novnc.com/) — Browser-based VNC client
- [Xvfb](http://xvfb.info/) — Virtual framebuffer
