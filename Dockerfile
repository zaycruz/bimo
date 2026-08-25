FROM node:22-slim

ARG CLAUDE_CODE_VERSION=2.1.241
RUN npm install --global "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

WORKDIR /app
COPY package.json ./
COPY bin ./bin
COPY roles ./roles
COPY src ./src
COPY test/fixture-agent.mjs ./test/fixture-agent.mjs
COPY workflows ./workflows
RUN chmod +x /app/bin/monolith

USER node
ENTRYPOINT ["/app/bin/monolith"]
