ARG AGENT_RUNTIME=opencode

FROM docker:29.7.2-cli@sha256:000bb62ff495f986c9f5578eb67cc2cb98b91138eda81d7762d5371eb8a497fe AS docker-cli

FROM node:22-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS base

ARG NPM_VERSION=12.0.2

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global "npm@${NPM_VERSION}" \
    && npm cache clean --force

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker

ENV NODE_ENV=production

WORKDIR /app

COPY --chown=root:root package.json ./
COPY --chown=root:root bin ./bin
COPY --chown=root:root src ./src
COPY --chown=root:root starters ./starters
COPY --chown=root:root templates ./templates
COPY --chown=root:root etc/organizer ./etc/organizer

COPY --chown=root:root starters/react/package.json starters/react/package-lock.json /opt/bimo-react/
RUN cd /opt/bimo-react \
    && npm ci --include=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

RUN chmod 0555 /app/bin/bimo /app/bin/bimo-git-askpass \
    && chown -R root:root /app

FROM base AS runtime-opencode

ARG OPENCODE_VERSION=1.18.23
ARG TARGETARCH

RUN case "${TARGETARCH}" in \
      amd64) OPENCODE_ARCH=x64 ;; \
      arm64) OPENCODE_ARCH=arm64 ;; \
      *) echo "unsupported target architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && npm install --global --ignore-scripts --omit=optional "opencode-ai@${OPENCODE_VERSION}" \
    && npm install --global --ignore-scripts "opencode-linux-${OPENCODE_ARCH}@${OPENCODE_VERSION}" \
    && ln --symbolic --force \
      "/usr/local/lib/node_modules/opencode-linux-${OPENCODE_ARCH}/bin/opencode" \
      /usr/local/bin/opencode \
    && test "$(opencode --version)" = "${OPENCODE_VERSION}" \
    && npm cache clean --force

COPY --chown=root:root --chmod=0444 etc/opencode/opencode.json /etc/opencode/opencode.json

ENV OPENCODE_CONFIG=/etc/opencode/opencode.json \
    BIMO_AGENT_RUNTIME=opencode

RUN chmod 0555 /etc/opencode \
    && chown -R root:root /etc/opencode

FROM base AS runtime-pi

ARG PI_VERSION=0.84.3

# @earendil-works/pi-coding-agent@0.84.3 dist integrity:
# sha512-Yr2p9PubrbFZmYEPYI+C8KmZP9xlFuLDnAG64RtU0ZDgrdiXYWa+y7WGyJO5OlqPliOkVCMd9IzVszO3/t0D0w==
RUN npm install --global --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}" \
    && test "$(pi --version)" = "${PI_VERSION}" \
    && npm cache clean --force

COPY --chown=root:root --chmod=0444 etc/pi/ /etc/pi/agent/

ENV PI_CODING_AGENT_DIR=/etc/pi/agent \
    BIMO_AGENT_RUNTIME=pi

# pi writes a settings lock and an auth store next to its config, so the
# agent dispatcher seeds this read-only config into the writable HOME tmpfs
# at startup; the baked copy stays root-owned like the opencode config.
RUN chmod 0555 /etc/pi /etc/pi/agent \
    && chown -R root:root /etc/pi

FROM runtime-${AGENT_RUNTIME} AS final

USER node
ENTRYPOINT ["/app/bin/bimo"]
