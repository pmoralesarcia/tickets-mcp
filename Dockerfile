# tickets-mcp: MCP de solo lectura sobre la BBDD de osTicket
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8767 \
    LOG_FILE=/var/log/tickets-mcp/mcp-tickets.log

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src

# Log de auditoría en un volumen; el resto del sistema de ficheros puede ir en solo lectura
RUN mkdir -p /var/log/tickets-mcp && chown node:node /var/log/tickets-mcp
USER node

EXPOSE 8767
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8767)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
