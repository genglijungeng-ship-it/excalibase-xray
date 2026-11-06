FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY index.js ./
COPY scripts ./scripts
RUN npm install --omit=dev || npm install
# postinstall downloads Xray-core v1.8.24 linux-64; if the build sandbox blocks it, index.js falls back to downloading at startup
EXPOSE 3000
CMD ["node", "index.js"]
