FROM node:22-bookworm-slim
WORKDIR /opt/dependencies
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund \
    && tr -d '\r' < package-lock.json | sha256sum | cut -d ' ' -f 1 > /opt/node-lock.sha256 \
    && chmod -R a+rX /opt/dependencies
