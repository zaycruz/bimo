ARG BIMO_IMAGE
FROM ${BIMO_IMAGE}

USER root
RUN apt-get update \
    && apt-get install --yes --no-install-recommends python3 bash \
    && rm -rf /var/lib/apt/lists/*

COPY --chown=root:root --chmod=0444 package.json package-lock.json identity.json /opt/bimo-pi/
RUN cd /opt/bimo-pi \
    && npm ci --include=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force \
    && ln --symbolic /opt/bimo-pi/node_modules /node_modules

ENV PATH=/opt/bimo-pi/node_modules/.bin:${PATH}

USER node
