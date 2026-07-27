# Deliberately NOT mcr.microsoft.com/playwright — that image ships chromium,
# firefox and webkit and lands around 2 GB. This project only ever launches
# chromium, and the cluster is three Orange Pi SBCs, so `playwright install
# chromium` on a slim base is roughly a quarter of the size for the same thing.
FROM node:22-bookworm-slim

# Browsers outside $HOME so the non-root user can read them. With the default
# path they install under root's cache and are unreadable at runtime.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_ENV=production \
    # Chromium writes profile and crash data under $HOME. The root filesystem is
    # read-only in the pod, so point it at the one writable directory.
    HOME=/tmp \
    PORT=5000

WORKDIR /app

# Dependencies in their own layer, so editing index.js/scraper.js does not
# re-download chromium.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    # --with-deps pulls the system libraries chromium links against; without it
    # the browser fails to start with a bare "error while loading shared
    # libraries" that says nothing useful.
    && npx playwright install --with-deps chromium \
    && chmod -R a+rX /ms-playwright \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/* /root/.npm

COPY index.js scraper.js ./

# uid 1000, present in the node base image.
USER node

EXPOSE 5000

# For plain `docker run`. Kubernetes ignores this and uses the probes in
# kustomize/base/deployment.yaml instead.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Straight to node, not `npm start`: npm would sit between the container's PID 1
# and the process that handles SIGTERM, and the browser would never be closed
# cleanly on a pod replacement.
CMD ["node", "index.js"]
