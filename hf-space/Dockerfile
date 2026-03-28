FROM node:22-bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ARG VESSEL_REPO=https://github.com/unmodeled-tyler/vessel-browser.git
ARG VESSEL_BRANCH=main
RUN git clone --depth 1 --branch "$VESSEL_BRANCH" "$VESSEL_REPO" .

RUN npm ci
RUN npm run build && rm -rf .git node_modules/.cache

# ── Runtime ──
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb x11vnc fluxbox novnc websockify procps \
    libgtk-3-0 libgbm1 libnss3 libnspr4 \
    libatk-bridge2.0-0 libatk1.0-0 libasound2 \
    libxss1 libxtst6 libxrandr2 libxcomposite1 \
    libxdamage1 libxfixes3 libdrm2 libcups2 \
    libatspi2.0-0 libdbus-1-3 libpango-1.0-0 libcairo2 \
    libx11-xcb1 libxcb-dri3-0 libxshmfence1 \
    fonts-noto-color-emoji fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app/out ./out
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/resources ./resources

COPY hf-space/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV DISPLAY=:0
ENV ELECTRON_DISABLE_SANDBOX=1
ENV DISPLAY_RESOLUTION=1280x800x24

EXPOSE 7860
CMD ["/entrypoint.sh"]
