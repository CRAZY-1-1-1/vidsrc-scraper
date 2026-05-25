FROM mcr.microsoft.com/playwright:v1.52.0-jammy

WORKDIR /app

# Install deps first for better layer caching
COPY package*.json ./
RUN npm install --omit=dev --ignore-scripts \
    && npx playwright install --with-deps chromium

COPY . .

ENV NODE_ENV=production
ENV PORT=4000
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:${PORT}/health || exit 1

CMD ["node", "server.js"]
