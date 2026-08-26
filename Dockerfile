FROM docker:27.5.1-cli@sha256:851f91d241214e7c6db86513b270d58776379aacc5eb9c4a87e5b47115e3065c AS docker-cli

FROM node:22-slim@sha256:e9bff3a454208b46a1f96da92878cc7f56a2a41ceac2216825be3177736896b5

ARG OPENCODE_VERSION=1.18.22

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --ignore-scripts --omit=optional "opencode-ai@${OPENCODE_VERSION}" \
    && npm install --global --ignore-scripts "opencode-linux-x64@${OPENCODE_VERSION}" \
    && ln --symbolic --force \
      /usr/local/lib/node_modules/opencode-linux-x64/bin/opencode \
      /usr/local/bin/opencode \
    && test "$(opencode --version)" = "${OPENCODE_VERSION}" \
    && npm cache clean --force

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker

ENV NODE_ENV=production \
    OPENCODE_CONFIG=/etc/opencode/opencode.json

WORKDIR /app

COPY --chown=root:root package.json ./
COPY --chown=root:root bin ./bin
COPY --chown=root:root src ./src
COPY --chown=root:root starters ./starters
COPY --chown=root:root templates ./templates
COPY --chown=root:root etc/organizer ./etc/organizer
COPY --chown=root:root --chmod=0444 etc/opencode/opencode.json /etc/opencode/opencode.json

COPY --chown=root:root starters/react/package.json starters/react/package-lock.json /opt/monolith-react/
RUN cd /opt/monolith-react \
    && npm ci --include=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

RUN chmod 0555 /app/bin/monolith /app/bin/monolith-git-askpass /etc/opencode \
    && chown -R root:root /app /etc/opencode

USER node
ENTRYPOINT ["/app/bin/monolith"]
